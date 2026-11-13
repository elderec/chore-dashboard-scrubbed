import { test, expect, type Page } from "@playwright/test";

// Exercises public/app.js's optional Fully Kiosk integration (window.fully) —
// see wrangler.toml's USE_FULLY_KIOSK/FULLY_* vars and README's "Fully Kiosk
// integration" section. Unlike pendingIds/justCompletedIds (genuinely
// timing-flaky), this is fully deterministic to test: a fake window.fully is
// injected via addInitScript (recording every call into window.__fullyCalls),
// and Playwright's page.clock pins the page to a known instant so the
// day/night brightness and screen-schedule logic can be asserted directly,
// without depending on the real wall-clock time the test happens to run at.

function baseChoresResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    kids: [],
    groups: { unlabeled: [] },
    generatedAt: new Date().toISOString(),
    eveningStartsAtMinutes: 16 * 60,
    fullyKiosk: {
      enabled: false,
      brightnessEnabled: false,
      dayBrightness: 100,
      nightBrightness: 30,
      dayKeepawakeEnabled: false,
      nightScheduleEnabled: false,
      nightScreenOffAt: "23:00",
      nightScreenOnAt: "05:00",
      motionWakeGraceMinutes: 2,
    },
    weather: { lat: 40.7128, lon: -74.006 },
    ...overrides,
  };
}

async function mockChores(page: Page, body: unknown) {
  await page.route("**/api/chores?*", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

async function blockWeather(page: Page) {
  await page.route("**/api.open-meteo.com/**", (route) => route.abort());
}

/** Fixed sunrise/sunset (6am/8pm Eastern), for tests that need applyTheme()'s
 * isDay computation to resolve deterministically — real weather data isn't
 * relevant here, only that sunTimes gets set at all so brightness fires. */
async function mockWeatherWithFixedSun(page: Page) {
  const sunrise = Math.floor(Date.parse("2026-08-28T10:00:00Z") / 1000); // 6am Eastern
  const sunset = Math.floor(Date.parse("2026-08-29T00:00:00Z") / 1000); // 8pm Eastern
  await page.route("**/api.open-meteo.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        current: { temperature_2m: 70, weather_code: 0, is_day: 1 },
        daily: { temperature_2m_max: [75], temperature_2m_min: [55], sunrise: [sunrise], sunset: [sunset] },
      }),
    })
  );
}

async function installFakeFully(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __fullyCalls: unknown[] }).__fullyCalls = [];
    (window as unknown as { fully: unknown }).fully = {
      screenBrightness: (percent: number) =>
        (window as unknown as { __fullyCalls: unknown[] }).__fullyCalls.push(["screenBrightness", percent]),
      keepScreenOn: (on: boolean) =>
        (window as unknown as { __fullyCalls: unknown[] }).__fullyCalls.push(["keepScreenOn", on]),
      screenOn: () => (window as unknown as { __fullyCalls: unknown[] }).__fullyCalls.push(["screenOn"]),
      screenOff: () => (window as unknown as { __fullyCalls: unknown[] }).__fullyCalls.push(["screenOff"]),
    };
  });
}

function fullyCalls(page: Page): Promise<unknown[][]> {
  return page.evaluate(() => (window as unknown as { __fullyCalls: unknown[][] }).__fullyCalls);
}

function callNames(calls: unknown[][]): unknown[] {
  return calls.map((c) => c[0]);
}

const DAY_INSTANT = "2026-08-28T16:00:00Z"; // noon Eastern — between the mocked sunrise/sunset
const NIGHT_INSTANT = "2026-08-29T05:00:00Z"; // 1am Eastern — after sunset, inside the default 23:00-05:00 window

test("daytime: dims to the day brightness value and keeps the screen awake", async ({ page }) => {
  await installFakeFully(page);
  await page.clock.install({ time: new Date(DAY_INSTANT) });
  await mockWeatherWithFixedSun(page);
  await mockChores(
    page,
    baseChoresResponse({
      fullyKiosk: {
        enabled: true,
        brightnessEnabled: true,
        dayBrightness: 90,
        nightBrightness: 25,
        dayKeepawakeEnabled: true,
        nightScheduleEnabled: false,
        nightScreenOffAt: "23:00",
        nightScreenOnAt: "05:00",
        motionWakeGraceMinutes: 2,
      },
    })
  );

  await page.goto("/?key=test-key");

  await expect.poll(async () => callNames(await fullyCalls(page))).toContain("screenBrightness");
  const calls = await fullyCalls(page);
  expect(calls).toContainEqual(["screenBrightness", 90]);
  expect(calls).toContainEqual(["keepScreenOn", true]);
  expect(calls).not.toContainEqual(["screenOff"]);
});

test("nighttime with the night schedule enabled: dims to the night brightness value and turns the screen off", async ({
  page,
}) => {
  await installFakeFully(page);
  await page.clock.install({ time: new Date(NIGHT_INSTANT) });
  await mockWeatherWithFixedSun(page);
  await mockChores(
    page,
    baseChoresResponse({
      fullyKiosk: {
        enabled: true,
        brightnessEnabled: true,
        dayBrightness: 90,
        nightBrightness: 25,
        dayKeepawakeEnabled: false,
        nightScheduleEnabled: true,
        nightScreenOffAt: "23:00",
        nightScreenOnAt: "05:00",
        motionWakeGraceMinutes: 2,
      },
    })
  );

  await page.goto("/?key=test-key");

  await expect.poll(async () => callNames(await fullyCalls(page))).toContain("screenOff");
  const calls = await fullyCalls(page);
  expect(calls).toContainEqual(["screenBrightness", 25]);
  expect(calls).toContainEqual(["keepScreenOn", false]);
  expect(calls).toContainEqual(["screenOff"]);
});

test("night schedule: motion wakes the screen, which re-sleeps after the grace period", async ({ page }) => {
  await installFakeFully(page);
  await page.clock.install({ time: new Date(NIGHT_INSTANT) });
  await blockWeather(page); // brightness isn't under test here
  await mockChores(
    page,
    baseChoresResponse({
      fullyKiosk: {
        enabled: true,
        brightnessEnabled: false,
        dayBrightness: 100,
        nightBrightness: 30,
        dayKeepawakeEnabled: false,
        nightScheduleEnabled: true,
        nightScreenOffAt: "23:00",
        nightScreenOnAt: "05:00",
        motionWakeGraceMinutes: 1, // short, so the fast-forward below stays small
      },
    })
  );

  await page.goto("/?key=test-key");

  // Starts off (no motion has ever been recorded, so the grace period is already expired).
  await expect.poll(async () => callNames(await fullyCalls(page))).toContain("screenOff");

  // Fully Kiosk calls this global function directly when Motion Detection fires.
  await page.evaluate(() => (window as unknown as { motionDetected: () => void }).motionDetected());
  await expect.poll(async () => callNames(await fullyCalls(page)).filter((n) => n === "screenOn").length).toBe(1);

  // Past the 1-minute grace period — the next clock tick should turn it back off.
  await page.clock.fastForward(70_000);
  await expect
    .poll(async () => callNames(await fullyCalls(page)).filter((n) => n === "screenOff").length)
    .toBeGreaterThanOrEqual(2);
});

test("master switch off: no window.fully calls happen even with every feature flag on", async ({ page }) => {
  await installFakeFully(page);
  await page.clock.install({ time: new Date(NIGHT_INSTANT) });
  await mockWeatherWithFixedSun(page);
  await mockChores(
    page,
    baseChoresResponse({
      fullyKiosk: {
        enabled: false, // the master switch — everything below should be moot
        brightnessEnabled: true,
        dayBrightness: 90,
        nightBrightness: 25,
        dayKeepawakeEnabled: true,
        nightScheduleEnabled: true,
        nightScreenOffAt: "23:00",
        nightScreenOnAt: "05:00",
        motionWakeGraceMinutes: 2,
      },
    })
  );

  await page.goto("/?key=test-key");
  await expect(page.locator("h1")).toHaveText("Chore Chart"); // confirms the page actually loaded/rendered normally

  expect(await fullyCalls(page)).toEqual([]);
});

test("non-Fully browser: no window.fully object at all is a silent no-op, not a crash", async ({ page }) => {
  // Deliberately no installFakeFully() here — window.fully is simply undefined,
  // same as any kiosk app/browser other than Fully Kiosk (see the README caveat).
  await page.clock.install({ time: new Date(NIGHT_INSTANT) });
  await mockWeatherWithFixedSun(page);
  const pageErrors: Error[] = [];
  page.on("pageerror", (err) => pageErrors.push(err));
  await mockChores(
    page,
    baseChoresResponse({
      fullyKiosk: {
        enabled: true,
        brightnessEnabled: true,
        dayBrightness: 90,
        nightBrightness: 25,
        dayKeepawakeEnabled: true,
        nightScheduleEnabled: true,
        nightScreenOffAt: "23:00",
        nightScreenOnAt: "05:00",
        motionWakeGraceMinutes: 2,
      },
    })
  );

  await page.goto("/?key=test-key");
  await expect(page.locator("h1")).toHaveText("Chore Chart");
  await page.clock.fastForward(20_000); // let a clock tick pass, in case anything would have thrown

  expect(pageErrors).toEqual([]);
});

test("a throwing window.fully call is contained: chores/streaks still render, no uncaught page error", async ({
  page,
}) => {
  // Regression test for a real incident: an unwrapped window.fully call that
  // threw on the real tablet aborted the rest of poll()'s response handler,
  // taking chore/streak rendering down with it. callFully() in app.js exists
  // specifically to contain this — every window.fully.* call goes through it.
  await page.addInitScript(() => {
    (window as unknown as { fully: unknown }).fully = {
      keepScreenOn: () => {
        throw new Error("simulated Fully API mismatch");
      },
      screenBrightness: () => {},
      screenOn: () => {},
      screenOff: () => {},
    };
  });
  await page.clock.install({ time: new Date(DAY_INSTANT) });
  await blockWeather(page);
  const pageErrors: Error[] = [];
  page.on("pageerror", (err) => pageErrors.push(err));
  await mockChores(
    page,
    baseChoresResponse({
      kids: [{ key: "alex", name: "Alex", color: "#4d9bff" }],
      groups: {
        unlabeled: [],
        alex: [
          {
            id: "chore-1",
            title: "Make Bed",
            due: new Date().toISOString().slice(0, 10),
            recurrence: "every day",
            isOverdue: false,
            dueTimeMinutes: null,
          },
        ],
      },
      streaks: { alex: { streak: 3, history: [true, true, true] } },
      fullyKiosk: {
        enabled: true,
        brightnessEnabled: false,
        dayBrightness: 100,
        nightBrightness: 30,
        dayKeepawakeEnabled: true, // triggers the throwing keepScreenOn call from initFullyKiosk()
        nightScheduleEnabled: false,
        nightScreenOffAt: "23:00",
        nightScreenOnAt: "05:00",
        motionWakeGraceMinutes: 2,
      },
    })
  );

  await page.goto("/?key=test-key");

  await expect(page.locator('[data-list="alex"] .chore-title')).toHaveText(["Make Bed"]);
  await expect(page.locator('[data-streak="alex"] .streak-badge')).toContainText("3 days");
  expect(pageErrors).toEqual([]);
});

test("feature flags are independent: brightness on alone never touches keepScreenOn/screenOn/screenOff", async ({
  page,
}) => {
  await installFakeFully(page);
  await page.clock.install({ time: new Date(NIGHT_INSTANT) });
  await mockWeatherWithFixedSun(page);
  await mockChores(
    page,
    baseChoresResponse({
      fullyKiosk: {
        enabled: true,
        brightnessEnabled: true,
        dayBrightness: 90,
        nightBrightness: 25,
        dayKeepawakeEnabled: false,
        nightScheduleEnabled: false,
        nightScreenOffAt: "23:00",
        nightScreenOnAt: "05:00",
        motionWakeGraceMinutes: 2,
      },
    })
  );

  await page.goto("/?key=test-key");

  await expect.poll(async () => callNames(await fullyCalls(page))).toContain("screenBrightness");
  const calls = await fullyCalls(page);
  expect(calls).toContainEqual(["screenBrightness", 25]);
  expect(callNames(calls)).not.toContain("keepScreenOn");
  expect(callNames(calls)).not.toContain("screenOn");
  expect(callNames(calls)).not.toContain("screenOff");
});
