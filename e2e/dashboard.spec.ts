import { test, expect, type Page } from "@playwright/test";

// These tests exercise public/index.html entirely client-side: every network call
// the page makes (/api/chores, /api/chores/:id/complete|reopen, and the Open-Meteo
// weather call) is intercepted and given a fixed response, so nothing here depends
// on a real Worker, real Todoist data, or real credentials — see
// e2e/static-server.mjs for why the page is served from a plain static server
// rather than `wrangler dev`.

const TODAY = new Date().toISOString().slice(0, 10);

// A tiny (64x64, solid color) JPEG fixture, base64-encoded — used only to
// prove a real avatar photo actually renders. Not a real photo of anyone;
// just bytes that are validly decodable as a JPEG.
const AVATAR_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQAASABIAAD/4QCARXhpZgAATU0AKgAAAAgABAEaAAUAAAABAAAAPgEbAAUAAAABAAAARgEoAAMAAAABAAIAAIdpAAQAAAABAAAATgAAAAAAAABIAAAAAQAAAEgAAAABAAOgAQADAAAAAQABAACgAgAEAAAAAQAAAECgAwAEAAAAAQAAAEAAAAAA/+0AOFBob3Rvc2hvcCAzLjAAOEJJTQQEAAAAAAAAOEJJTQQlAAAAAAAQ1B2M2Y8AsgTpgAmY7PhCfv/AABEIAEAAQAMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgv/xAC1EAACAQMDAgQDBQUEBAAAAX0BAgMABBEFEiExQQYTUWEHInEUMoGRoQgjQrHBFVLR8CQzYnKCCQoWFxgZGiUmJygpKjQ1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4eLj5OXm5+jp6vHy8/T19vf4+fr/xAAfAQADAQEBAQEBAQEBAAAAAAAAAQIDBAUGBwgJCgv/xAC1EQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2wBDAAICAgICAgMCAgMFAwMDBQYFBQUFBggGBgYGBggKCAgICAgICgoKCgoKCgoMDAwMDAwODg4ODg8PDw8PDw8PDw//2wBDAQICAgQEBAcEBAcQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/3QAEAAT/2gAMAwEAAhEDEQA/AO8ooor+/D+QwooooAKKKKACiiigD//Q7yiiiv78P5DCiiigAooooAKKKKAP/9HvKKKK/vw/kMKKKKACiiigAooooA//0u8ooor+/D+QwooooAKKKKACiiigD//Z";

function baseChoresResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    kids: [
      { key: "alex", name: "Alex", color: "#4d9bff" },
      { key: "sam", name: "Sam", color: "#4dd68a" },
      { key: "taylor", name: "Taylor", color: "#ffb14d" },
    ],
    groups: {
      unlabeled: [],
      alex: [
        // dueTimeMinutes: null (no time set) shows in both Day and Evening tabs — used
        // here deliberately so tests that aren't about the tabs themselves don't also
        // depend on which tab happens to be auto-selected by the real current time.
        {
          id: "overdue-1",
          title: "Pickup Living Room",
          due: TODAY,
          recurrence: "every 3 days",
          isOverdue: true,
          overdueDays: 0,
          dueTimeMinutes: null,
        },
        {
          id: "open-1",
          title: "Do The Dishes",
          due: TODAY,
          recurrence: "every day",
          isOverdue: false,
          dueTimeMinutes: null,
        },
      ],
      sam: [],
      taylor: [],
    },
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

async function mockChores(page: Page, body: unknown, status = 200) {
  await page.route("**/api/chores?*", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
}

async function blockWeather(page: Page) {
  // Real weather data isn't relevant to these tests, and letting a real third-party
  // call go out in CI would be slow/flaky for no benefit — the app already handles
  // a failed weather fetch gracefully (see updateWeather's .catch in index.html).
  await page.route("**/api.open-meteo.com/**", (route) => route.abort());
}

test.beforeEach(async ({ page }) => {
  await blockWeather(page);
});

test("loads chores grouped by kid and flags the overdue one", async ({ page }) => {
  await mockChores(page, baseChoresResponse());
  await page.goto("/?key=test-key");

  await expect(page.locator("h1")).toHaveText("Chore Chart");
  await expect(page.locator('[data-list="alex"] .chore-title')).toHaveText(["Pickup Living Room", "Do The Dishes"]);
  await expect(page.locator('[data-list="alex"] .chore-card').first()).toHaveClass(/overdue/);
  await expect(page.locator('[data-list="alex"] .overdue-badge')).toHaveCount(1);
  await expect(page.locator('[data-list="sam"] .empty-state')).toHaveText("Nothing due right now 🎉");
});

test("shows a rotation-handoff note on a chore whose same-titled sibling is overdue for another kid", async ({
  page,
}) => {
  await mockChores(
    page,
    baseChoresResponse({
      groups: {
        unlabeled: [],
        alex: [
          {
            id: "overdue-1",
            title: "Pickup Living Room",
            due: TODAY,
            recurrence: "every 3 days",
            isOverdue: true,
            dueTimeMinutes: null,
            handoffNote: null,
          },
        ],
        sam: [],
        taylor: [
          {
            id: "handoff-1",
            title: "Take Out Trash",
            due: TODAY,
            recurrence: "every 2 weeks",
            isOverdue: false,
            dueTimeMinutes: null,
            handoffNote: "Alex hasn't finished this yet",
          },
        ],
      },
    })
  );
  await page.goto("/?key=test-key");

  await expect(page.locator('[data-list="taylor"] .chore-handoff-note')).toHaveText("🔁 Alex hasn't finished this yet");
  // Not overdue itself, so no red overdue badge — the note is purely explanatory.
  await expect(page.locator('[data-list="taylor"] .overdue-badge')).toHaveCount(0);
  await expect(page.locator('[data-list="alex"] .chore-handoff-note')).toHaveCount(0);
});

test("Day/Evening tabs filter chores by due time", async ({ page }) => {
  await mockChores(
    page,
    baseChoresResponse({
      groups: {
        unlabeled: [],
        alex: [
          {
            id: "day-1",
            title: "Pickup Living Room",
            due: TODAY,
            recurrence: null,
            isOverdue: false,
            dueTimeMinutes: 10 * 60,
          },
          {
            id: "evening-1",
            title: "Do The Dishes",
            due: TODAY,
            recurrence: null,
            isOverdue: false,
            dueTimeMinutes: 19 * 60,
          },
        ],
        sam: [],
        taylor: [],
      },
    })
  );
  await page.goto("/?key=test-key");

  // eveningStartsAtMinutes is 4pm; whichever tab matches the real current time is
  // auto-selected, so explicitly click both rather than asserting on the initial one.
  await page.locator('.slot-btn[data-slot="day"]').click();
  await expect(page.locator('[data-list="alex"] .chore-title')).toHaveText(["Pickup Living Room"]);

  await page.locator('.slot-btn[data-slot="evening"]').click();
  await expect(page.locator('[data-list="alex"] .chore-title')).toHaveText(["Do The Dishes"]);
});

test("an overdue chore shows in both tabs regardless of its own slot — a not-yet-overdue one stays in its own tab only", async ({
  page,
}) => {
  await mockChores(
    page,
    baseChoresResponse({
      groups: {
        unlabeled: [],
        alex: [
          {
            id: "evening-overdue",
            title: "Do The Dishes",
            due: TODAY,
            recurrence: null,
            isOverdue: true,
            dueTimeMinutes: 19 * 60,
          },
          {
            id: "evening-not-overdue",
            title: "Empty Lunch Box",
            due: TODAY,
            recurrence: null,
            isOverdue: false,
            dueTimeMinutes: 20 * 60,
          },
        ],
        sam: [],
        taylor: [],
      },
    })
  );
  await page.goto("/?key=test-key");

  await page.locator('.slot-btn[data-slot="day"]').click();
  await expect(page.locator('[data-list="alex"] .chore-title')).toHaveText(["Do The Dishes"]);
  await expect(page.locator('[data-list="alex"] .overdue-badge')).toHaveCount(1);

  await page.locator('.slot-btn[data-slot="evening"]').click();
  await expect(page.locator('[data-list="alex"] .chore-title')).toHaveText(["Do The Dishes", "Empty Lunch Box"]);
});

test("the empty state names the other tab and how many chores are there, rather than implying nothing's due at all", async ({
  page,
}) => {
  await mockChores(
    page,
    baseChoresResponse({
      groups: {
        unlabeled: [],
        alex: [],
        sam: [
          {
            id: "evening-only",
            title: "Do The Dishes",
            due: TODAY,
            recurrence: null,
            isOverdue: false,
            dueTimeMinutes: 19 * 60,
          },
        ],
        taylor: [
          {
            id: "evening-1",
            title: "Do The Dishes",
            due: TODAY,
            recurrence: null,
            isOverdue: false,
            dueTimeMinutes: 19 * 60,
          },
          {
            id: "evening-2",
            title: "Empty Lunch Box",
            due: TODAY,
            recurrence: null,
            isOverdue: false,
            dueTimeMinutes: 20 * 60,
          },
        ],
      },
    })
  );
  await page.goto("/?key=test-key");

  await page.locator('.slot-btn[data-slot="day"]').click();
  await expect(page.locator('[data-list="sam"] .empty-state')).toHaveText(
    "Nothing due right now — 1 chore this Evening 🎉"
  );
  await expect(page.locator('[data-list="taylor"] .empty-state')).toHaveText(
    "Nothing due right now — 2 chores this Evening 🎉"
  );
  // A kid with genuinely nothing due either tab still gets the original message.
  await expect(page.locator('[data-list="alex"] .empty-state')).toHaveText("Nothing due right now 🎉");

  await page.locator('.slot-btn[data-slot="evening"]').click();
  await expect(page.locator('[data-list="sam"] .chore-title')).toHaveText(["Do The Dishes"]);
});

test("the overdue badge shows whole days late when a day or more, plain OVERDUE otherwise", async ({ page }) => {
  const data = baseChoresResponse();
  data.groups.alex.push(
    {
      id: "late-1",
      title: "One day late",
      due: TODAY,
      recurrence: null,
      isOverdue: true,
      overdueDays: 1,
      dueTimeMinutes: null,
    },
    {
      id: "late-3",
      title: "Three days late",
      due: TODAY,
      recurrence: null,
      isOverdue: true,
      overdueDays: 3,
      dueTimeMinutes: null,
    }
  );
  await mockChores(page, data);

  await page.goto("/?key=test-key");

  await expect(page.locator('[data-id="late-1"] .overdue-badge')).toHaveText("1 DAY OVERDUE");
  await expect(page.locator('[data-id="late-3"] .overdue-badge')).toHaveText("3 DAYS OVERDUE");
  await expect(page.locator('[data-id="overdue-1"] .overdue-badge')).toHaveText("OVERDUE");
});

test("tapping an open chore completes it optimistically, then a reopen tap undoes it", async ({ page }) => {
  await mockChores(page, baseChoresResponse());
  const completeCalls: string[] = [];
  const reopenCalls: string[] = [];
  await page.route("**/api/chores/open-1/complete*", (route) => {
    completeCalls.push(route.request().url());
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route("**/api/chores/open-1/reopen*", (route) => {
    reopenCalls.push(route.request().url());
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await page.goto("/?key=test-key");
  const card = page.locator('[data-id="open-1"]');
  await expect(card).not.toHaveClass(/done/);

  await card.click();
  await expect(card).toHaveClass(/done/);
  await expect.poll(() => completeCalls.length).toBe(1);

  await card.click();
  await expect(card).not.toHaveClass(/done/);
  await expect.poll(() => reopenCalls.length).toBe(1);
});

test("a rejected complete reverts the card and shows an explanatory toast", async ({ page }) => {
  await mockChores(page, baseChoresResponse());
  await page.route("**/api/chores/open-1/complete*", (route) => {
    route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({ error: "Todoist rejected this change" }),
    });
  });

  await page.goto("/?key=test-key");
  const card = page.locator('[data-id="open-1"]');
  await card.click();

  await expect(page.locator("#action-toast")).toBeVisible();
  await expect(page.locator("#action-toast")).toContainText("Couldn't save that");
  await expect(card).not.toHaveClass(/done/);
});

test("a complete that never reaches the server says the tablet is offline", async ({ page }) => {
  await mockChores(page, baseChoresResponse());
  await page.route("**/api/chores/open-1/complete*", (route) => route.abort("internetdisconnected"));

  await page.goto("/?key=test-key");
  const card = page.locator('[data-id="open-1"]');
  await card.click();

  await expect(page.locator("#action-toast")).toBeVisible();
  await expect(page.locator("#action-toast")).toContainText("tablet is offline");
  await expect(card).not.toHaveClass(/done/);
});

test("chore cards are keyboard-operable and expose their done state via aria-pressed", async ({ page }) => {
  await mockChores(page, baseChoresResponse());
  await page.route("**/api/chores/open-1/complete*", (route) => {
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await page.goto("/?key=test-key");
  const card = page.locator('[data-id="open-1"]');
  await expect(card).toHaveAttribute("role", "button");
  await expect(card).toHaveAttribute("aria-pressed", "false");

  await card.focus();
  await page.keyboard.press("Enter");
  await expect(card).toHaveClass(/done/);
  await expect(card).toHaveAttribute("aria-pressed", "true");
});

test("the active Day/Evening tab is exposed via aria-pressed, not just a CSS class", async ({ page }) => {
  await mockChores(page, baseChoresResponse());
  await page.goto("/?key=test-key");

  await page.locator('.slot-btn[data-slot="day"]').click();
  await expect(page.locator('.slot-btn[data-slot="day"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('.slot-btn[data-slot="evening"]')).toHaveAttribute("aria-pressed", "false");

  await page.locator('.slot-btn[data-slot="evening"]').click();
  await expect(page.locator('.slot-btn[data-slot="evening"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('.slot-btn[data-slot="day"]')).toHaveAttribute("aria-pressed", "false");
});

test("shows a distinct error state for an invalid key, instead of hanging on 'Loading chores…'", async ({ page }) => {
  await mockChores(page, { error: "Forbidden" }, 403);
  await page.goto("/?key=wrong-key");

  await expect(page.locator("#board")).toContainText("This dashboard link isn't valid");
});

test("a chore with no due time shows in both Day and Evening tabs", async ({ page }) => {
  await mockChores(
    page,
    baseChoresResponse({
      groups: {
        unlabeled: [],
        alex: [
          {
            id: "anytime-1",
            title: "Clean Bedroom",
            due: TODAY,
            recurrence: null,
            isOverdue: false,
            dueTimeMinutes: null,
          },
        ],
        sam: [],
        taylor: [],
      },
    })
  );
  await page.goto("/?key=test-key");

  await page.locator('.slot-btn[data-slot="day"]').click();
  await expect(page.locator('[data-list="alex"] .chore-title')).toHaveText(["Clean Bedroom"]);

  await page.locator('.slot-btn[data-slot="evening"]').click();
  await expect(page.locator('[data-list="alex"] .chore-title')).toHaveText(["Clean Bedroom"]);
});

test("a malformed /api/chores response never shows a misleading 'Reconnecting…' banner, and the dashboard recovers once responses are well-formed again", async ({
  page,
}) => {
  // Characterizes overall poll() behavior when a response causes a downstream
  // throw (here: kids: null makes buildColumns() throw) rather than proving
  // any single piece of code is what causes it. Traced through in detail
  // while hardening this test's timing (see below): consecutiveFailures is
  // reset to 0 unconditionally at the top of every successful-fetch response
  // handler, before any risky code runs — so a processing bug can never
  // accumulate to the 2-consecutive-failures threshold that shows
  // "Reconnecting…" regardless of whether it's caught; and both `kids` and
  // `lastGroups` get assigned before the code that might throw, so a later
  // well-formed poll renders correctly regardless too. Both halves of this
  // test's claim hold given the current code shape, not specifically because
  // of poll()'s try/catch — that wrapper's own genuinely load-bearing
  // contribution (does *this same* poll's rendering still happen despite an
  // earlier throw in it) is what e2e/fully-kiosk.spec.ts's "a throwing
  // window.fully call is contained" test actually isolates and proves,
  // verified there by confirming it fails without the wrapper.
  let callCount = 0;
  await page.route("**/api/chores?*", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    callCount++;
    const body = callCount <= 4 ? { ...baseChoresResponse(), kids: null } : baseChoresResponse();
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  const pageErrors: Error[] = [];
  page.on("pageerror", (err) => pageErrors.push(err));
  await page.clock.install();

  await page.goto("/?key=test-key");
  // callCount lives in this Node process (the route handler's closure), not
  // the page — polling it is immune to page.clock's fake timers entirely, so
  // this is a real signal that poll's fetch actually landed, not a guess
  // about how long that took. Previously a fixed page.waitForTimeout(200)
  // stood in for this, which is exactly what made this test flaky under
  // parallel-worker CPU contention: fastForward() only fires *already
  // registered* fake timers, but each poll's *next* setTimeout is registered
  // inside a .finally() after a real (CDP-mediated) fetch resolves — genuine
  // async I/O outside the fake clock's control. If that resolution lagged
  // behind a fixed real-time wait, the next fastForward() could sweep past
  // before the next timer was even registered, and those gaps compounded
  // across iterations until the final assertion legitimately never saw a
  // 5th poll within its retry window. Waiting on callCount after every step
  // removes the guesswork.
  await expect.poll(() => callCount).toBeGreaterThanOrEqual(1);

  // Advance through 3 more broken polls — well past the 2-consecutive-failures
  // threshold that would normally trigger "Reconnecting…" — it must never appear.
  for (let i = 0; i < 3; i++) {
    await page.clock.fastForward(50_000); // > POLL_MS (45s) + max jitter (3s)
    await expect.poll(() => callCount).toBeGreaterThanOrEqual(i + 2);
  }
  await expect(page.locator("#status-banner")).not.toHaveClass(/visible/);
  expect(pageErrors).toEqual([]);

  // The next poll gets well-formed data — confirms the earlier bug never
  // permanently broke the poll loop.
  await page.clock.fastForward(50_000);
  await expect.poll(() => callCount).toBeGreaterThanOrEqual(5);
  await expect(page.locator('[data-list="alex"] .chore-title')).toHaveText(["Pickup Living Room", "Do The Dishes"]);
});

test("a kid's avatar photo renders when GET /api/avatars/:kidKey returns one", async ({ page }) => {
  await mockChores(page, baseChoresResponse());
  await page.route("**/api/avatars/*", (route) =>
    route.fulfill({ status: 200, contentType: "image/jpeg", body: Buffer.from(AVATAR_JPEG_BASE64, "base64") })
  );
  await page.goto("/?key=test-key");

  const wrap = page.locator('[data-avatar="alex"]');
  await expect(wrap.locator(".avatar-photo")).toBeVisible();
});

test("a kid with no avatar photo shows the colored-initial fallback, not a broken-image icon", async ({ page }) => {
  await mockChores(page, baseChoresResponse());
  await page.route("**/api/avatars/*", (route) => route.fulfill({ status: 404 }));
  await page.goto("/?key=test-key");

  const wrap = page.locator('[data-avatar="alex"]');
  // buildAvatar()'s error handler removes the <img> entirely once the load
  // fails, so the fallback (always in the DOM underneath) is what's left —
  // asserting the <img> is gone, not just invisible, is the actual
  // regression this test guards: a lingering broken <img> would otherwise
  // show a broken-image icon on top of the fallback.
  await expect(wrap.locator(".avatar-photo")).toHaveCount(0);
  await expect(wrap.locator(".avatar-fallback")).toHaveText("A");
});

test("a crowded Evening column scrolls instead of squeezing cards into each other", async ({ page }) => {
  // Regression: .chore-card used to be shrinkable inside the column-flex
  // .chore-list, so with more cards than fit, each card was compressed below its
  // content height and text/badges spilled over the neighbouring card.
  const crowded = Array.from({ length: 16 }, (_, i) => ({
    id: `c-${i}`,
    title: `Wipe Down The Main Bathroom Counter And Mirror number ${i}`,
    due: TODAY,
    recurrence: "every 3 weeks sunday at 12:00pm",
    isOverdue: true,
    overdueDays: i + 1,
    dueTimeMinutes: 20 * 60,
  }));
  await mockChores(
    page,
    baseChoresResponse({ groups: { unlabeled: [], alex: [], sam: crowded, taylor: crowded.slice(0, 4) } })
  );
  await page.setViewportSize({ width: 2000, height: 1250 });
  await page.goto("/?key=test-key");
  await page.locator('.slot-btn[data-slot="evening"]').click();

  const boxes = await page.locator('[data-list="sam"] .chore-card').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height, content: el.scrollHeight, clientH: el.clientHeight };
    })
  );
  expect(boxes).toHaveLength(16);
  for (let i = 0; i < boxes.length; i++) {
    // Content must fit inside the card (not squeezed)...
    expect(boxes[i].content).toBeLessThanOrEqual(boxes[i].clientH);
    // ...and no card may overlap the next one.
    if (i > 0) expect(boxes[i].top).toBeGreaterThanOrEqual(boxes[i - 1].bottom);
  }
});
