import { describe, it, expect, vi, afterEach } from "vitest";
import worker, {
  runDailyDigest,
  checkHeartbeat,
  runRainSkipCheck,
  runSchoolSkipCheck,
  deliverSkipNotices,
  maybeSendSnowReminder,
  type Env,
} from "../src/index";
import type { TodoistTask } from "../src/todoist";
import { todayInTimeZone } from "../src/overdue";

interface ChoresApiResponse {
  kids: { key: string; name: string; color: string }[];
  groups: Record<
    string,
    {
      id: string;
      title: string;
      isOverdue: boolean;
      overdueDays: number;
      dueTimeMinutes: number | null;
      handoffNote: string | null;
    }[]
  >;
  streaks: Record<string, { streak: number; history: boolean[] }>;
  eveningStartsAtMinutes: number;
  fullyKiosk: {
    enabled: boolean;
    brightnessEnabled: boolean;
    dayBrightness: number;
    nightBrightness: number;
    dayKeepawakeEnabled: boolean;
    nightScheduleEnabled: boolean;
    nightScreenOffAt: string;
    nightScreenOnAt: string;
    motionWakeGraceMinutes: number;
  };
  weather: { lat: number; lon: number };
}

const env: Env = {
  TODOIST_TOKEN: "test-todoist-token",
  DASH_SECRET: "test-dash-secret",
  KIDS_PROJECT_ID: "kids-project",
  KIDS: "Alex:#4d9bff,Sam:#4dd68a,Taylor:#ffb14d",
  EVENING_STARTS_AT: "16:00",
};

// fetch()-only tests never call ctx.waitUntil, so a stub is sufficient here.
const ctx = {} as ExecutionContext;

const TODAY = todayInTimeZone(new Date(), "America/New_York");

function req(path: string, init?: RequestInit): Request {
  return new Request(`https://dashboard.example.com${path}`, init);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function task(overrides: Partial<TodoistTask>): TodoistTask {
  return {
    id: "1",
    content: "Chore",
    project_id: env.KIDS_PROJECT_ID,
    labels: [],
    due: null,
    priority: 1,
    ...overrides,
  };
}

/** In-memory stand-in for the FAILURE_STATE KV binding. */
function fakeKV() {
  const store = new Map<string, string>();
  const kv = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
  return { kv: kv as unknown as KVNamespace, store };
}

/** In-memory stand-in for the AVATARS R2 binding — only the subset of
 * R2Bucket's surface handleGetAvatar actually uses (get). */
function fakeR2() {
  const store = new Map<string, { body: Uint8Array; contentType?: string }>();
  const bucket = {
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      return {
        body: entry.body,
        httpMetadata: entry.contentType ? { contentType: entry.contentType } : undefined,
      };
    }),
    put: vi.fn(async (key: string, value: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) => {
      store.set(key, { body: value, contentType: opts?.httpMetadata?.contentType });
    }),
  };
  return { bucket: bucket as unknown as R2Bucket, store };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("auth gate", () => {
  it("403s when no key is supplied", async () => {
    const res = await worker.fetch(req("/api/chores"), env, ctx);
    expect(res.status).toBe(403);
  });

  it("403s when the key is wrong", async () => {
    const res = await worker.fetch(req("/api/chores?key=wrong"), env, ctx);
    expect(res.status).toBe(403);
  });

  it("403s for a same-length but wrong key (exercises the constant-time comparison's equal-length path)", async () => {
    const wrongKey = "x".repeat(env.DASH_SECRET.length);
    const res = await worker.fetch(req(`/api/chores?key=${wrongKey}`), env, ctx);
    expect(res.status).toBe(403);
  });

  it("404s for anything outside /api/*, without checking auth", async () => {
    const res = await worker.fetch(req("/"), env, ctx);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/chores", () => {
  it("groups tasks by kid label, flags overdue, and drops future-dated chores", async () => {
    const tasks = [
      task({
        id: "1",
        labels: ["Alex"],
        due: { date: "2020-01-01", is_recurring: false, string: "", timezone: null },
      }),
      task({
        id: "2",
        labels: ["Alex", "Sam"],
        due: { date: "2020-01-02", is_recurring: false, string: "", timezone: null },
      }),
      task({
        id: "3",
        labels: ["Taylor"],
        due: { date: "2999-01-01", is_recurring: false, string: "", timezone: null },
      }),
      task({ id: "4", labels: [], due: { date: "2020-01-01", is_recurring: false, string: "", timezone: null } }),
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse(200, { results: tasks, next_cursor: null })));

    const res = await worker.fetch(req("/api/chores?key=test-dash-secret"), env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChoresApiResponse;

    expect(body.groups.alex.map((c) => c.id)).toEqual(["1", "2"]);
    expect(body.groups.sam.map((c) => c.id)).toEqual(["2"]);
    expect(body.groups.taylor.map((c) => c.id)).toEqual([]); // task 3 is future-dated, filtered out
    expect(body.groups.unlabeled.map((c) => c.id)).toEqual(["4"]);
    expect(body.groups.alex[0].isOverdue).toBe(true);
    expect(body.groups.alex[0].overdueDays).toBeGreaterThan(1000); // due 2020-01-01
    expect(body.groups.alex[0].overdueDays).toBeGreaterThan(body.groups.alex[1].overdueDays); // due 2020-01-02
  });

  it("flags a non-overdue chore with a handoffNote when a same-titled chore is overdue for another kid (rotation handoff)", async () => {
    const tasks = [
      // Alex's side of a "Take out trash" rotation, never finished — stays overdue.
      task({
        id: "1",
        content: "Take out trash",
        labels: ["Alex"],
        due: { date: "2020-01-01", is_recurring: true, string: "every 2 weeks", timezone: null },
      }),
      // Taylor's independently-scheduled occurrence of the same rotation, due today.
      task({
        id: "2",
        content: "take out trash", // different case, still the same rotation
        labels: ["Taylor"],
        due: { date: TODAY, is_recurring: true, string: "every 2 weeks", timezone: null },
      }),
      // An unrelated chore that happens to also be overdue for Sam shouldn't leak in.
      task({
        id: "3",
        content: "Feed the dog",
        labels: ["Sam"],
        due: { date: "2020-01-01", is_recurring: false, string: "", timezone: null },
      }),
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse(200, { results: tasks, next_cursor: null })));

    const res = await worker.fetch(req("/api/chores?key=test-dash-secret"), env, ctx);
    const body = (await res.json()) as ChoresApiResponse;

    const alexs = body.groups.alex.find((c) => c.id === "1");
    const taylors = body.groups.taylor.find((c) => c.id === "2");
    const sams = body.groups.sam.find((c) => c.id === "3");
    expect(alexs?.isOverdue).toBe(true);
    expect(alexs?.handoffNote).toBeNull(); // the overdue one doesn't need a note about itself
    expect(taylors?.isOverdue).toBe(false);
    expect(taylors?.handoffNote).toBe("Alex hasn't finished this yet");
    expect(sams?.handoffNote).toBeNull(); // no sibling shares "Feed the dog"
  });

  it("does not add a handoffNote for a genuinely shared chore (one task, two kid labels)", async () => {
    const tasks = [
      task({
        id: "1",
        content: "Clean playroom",
        labels: ["Alex", "Sam"],
        due: { date: "2020-01-01", is_recurring: false, string: "", timezone: null },
      }),
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse(200, { results: tasks, next_cursor: null })));

    const res = await worker.fetch(req("/api/chores?key=test-dash-secret"), env, ctx);
    const body = (await res.json()) as ChoresApiResponse;

    // Both labels point at the SAME task, which is overdue for both — so
    // neither side is the non-overdue sibling a handoff note would attach to.
    expect(body.groups.alex.find((c) => c.id === "1")?.handoffNote).toBeNull();
    expect(body.groups.sam.find((c) => c.id === "1")?.handoffNote).toBeNull();
  });

  it("includes dueTimeMinutes per chore (null for date-only, minutes-since-midnight for a timed due date) and eveningStartsAtMinutes from config", async () => {
    const tasks = [
      task({
        id: "1",
        labels: ["Alex"],
        due: { date: TODAY, is_recurring: false, string: "", timezone: null }, // date-only
      }),
      task({
        id: "2",
        labels: ["Alex"],
        due: { date: `${TODAY}T07:30:00`, is_recurring: false, string: "", timezone: null }, // 7:30am local
      }),
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse(200, { results: tasks, next_cursor: null })));

    const res = await worker.fetch(
      req("/api/chores?key=test-dash-secret"),
      { ...env, EVENING_STARTS_AT: "16:00" },
      ctx
    );
    const body = (await res.json()) as ChoresApiResponse;

    expect(body.groups.alex.find((c) => c.id === "1")?.dueTimeMinutes).toBeNull();
    expect(body.groups.alex.find((c) => c.id === "2")?.dueTimeMinutes).toBe(7 * 60 + 30);
    expect(body.eveningStartsAtMinutes).toBe(16 * 60);
  });

  it("includes fullyKiosk config parsed from the FULLY_*/USE_FULLY_KIOSK vars", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse(200, { results: [], next_cursor: null })));

    const res = await worker.fetch(
      req("/api/chores?key=test-dash-secret"),
      {
        ...env,
        USE_FULLY_KIOSK: "true",
        FULLY_BRIGHTNESS_ENABLED: "true",
        FULLY_DAY_BRIGHTNESS: "80",
        FULLY_NIGHT_BRIGHTNESS: "20",
        FULLY_DAY_KEEPAWAKE_ENABLED: "true",
        FULLY_NIGHT_SCHEDULE_ENABLED: "true",
        FULLY_NIGHT_SCREEN_OFF_AT: "22:30",
        FULLY_NIGHT_SCREEN_ON_AT: "06:00",
        FULLY_MOTION_WAKE_GRACE_MINUTES: "5",
      },
      ctx
    );
    const body = (await res.json()) as ChoresApiResponse;

    expect(body.fullyKiosk).toEqual({
      enabled: true,
      brightnessEnabled: true,
      dayBrightness: 80,
      nightBrightness: 20,
      dayKeepawakeEnabled: true,
      nightScheduleEnabled: true,
      nightScreenOffAt: "22:30",
      nightScreenOnAt: "06:00",
      motionWakeGraceMinutes: 5,
    });
  });

  it("defaults fullyKiosk to all-off when the FULLY_*/USE_FULLY_KIOSK vars are unset", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse(200, { results: [], next_cursor: null })));

    const res = await worker.fetch(req("/api/chores?key=test-dash-secret"), env, ctx);
    const body = (await res.json()) as ChoresApiResponse;

    expect(body.fullyKiosk).toEqual({
      enabled: false,
      brightnessEnabled: false,
      dayBrightness: 100,
      nightBrightness: 30,
      dayKeepawakeEnabled: false,
      nightScheduleEnabled: false,
      nightScreenOffAt: "23:00",
      nightScreenOnAt: "05:00",
      motionWakeGraceMinutes: 2,
    });
  });

  it("includes weather location from WEATHER_LAT/WEATHER_LON, defaulting to New York, NY when unset", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(200, { results: [], next_cursor: null }))
        .mockResolvedValueOnce(jsonResponse(200, { results: [], next_cursor: null }))
    );

    const defaultRes = await worker.fetch(req("/api/chores?key=test-dash-secret"), env, ctx);
    const defaultBody = (await defaultRes.json()) as ChoresApiResponse;
    expect(defaultBody.weather).toEqual({ lat: 40.7128, lon: -74.006 });

    const customRes = await worker.fetch(
      req("/api/chores?key=test-dash-secret"),
      { ...env, WEATHER_LAT: "40.7128", WEATHER_LON: "-74.006" },
      ctx
    );
    const customBody = (await customRes.json()) as ChoresApiResponse;
    expect(customBody.weather).toEqual({ lat: 40.7128, lon: -74.006 });
  });

  it("is driven entirely by the KIDS var, not hardcoded names", async () => {
    const differentEnv: Env = { ...env, KIDS: "Ann:#111111,Bo:#222222" };
    const tasks = [
      task({ id: "1", labels: ["Ann"], due: { date: "2020-01-01", is_recurring: false, string: "", timezone: null } }),
      task({ id: "2", labels: ["Bo"], due: { date: "2020-01-01", is_recurring: false, string: "", timezone: null } }),
      // a label matching the *old* hardcoded roster should now be treated as unlabeled
      task({
        id: "3",
        labels: ["Alex"],
        due: { date: "2020-01-01", is_recurring: false, string: "", timezone: null },
      }),
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse(200, { results: tasks, next_cursor: null })));

    const res = await worker.fetch(req("/api/chores?key=test-dash-secret"), differentEnv, ctx);
    const body = (await res.json()) as ChoresApiResponse;

    expect(body.kids).toEqual([
      { key: "ann", name: "Ann", color: "#111111" },
      { key: "bo", name: "Bo", color: "#222222" },
    ]);
    expect(body.groups.ann.map((c) => c.id)).toEqual(["1"]);
    expect(body.groups.bo.map((c) => c.id)).toEqual(["2"]);
    expect(body.groups.alex).toBeUndefined(); // "alex" isn't a configured key at all anymore
    expect(body.groups.unlabeled.map((c) => c.id)).toEqual(["3"]);
  });

  it("returns 502 when the Todoist request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("boom", { status: 500 })));
    const res = await worker.fetch(req("/api/chores?key=test-dash-secret"), env, ctx);
    expect(res.status).toBe(502);
  });
});

describe("POST /api/chores/:id/complete", () => {
  it("403s if the task belongs to a different project", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(jsonResponse(200, task({ id: "9", project_id: "some-other-project" })))
    );

    const res = await worker.fetch(req("/api/chores/9/complete?key=test-dash-secret", { method: "POST" }), env, ctx);

    expect(res.status).toBe(403);
  });

  it("closes the task once ownership is confirmed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, task({ id: "9" }))) // ownership check (getTask)
      .mockResolvedValueOnce(new Response(null, { status: 204 })); // close
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(req("/api/chores/9/complete?key=test-dash-secret", { method: "POST" }), env, ctx);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain("/tasks/9/close");
  });

  const recurringDue = (date: string) => ({
    date,
    is_recurring: true,
    string: "every mon, wed at 9:00pm",
    timezone: null,
  });

  it("closes an overdue recurring task again until its next due date is after today", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, task({ id: "9", due: recurringDue("2000-01-03T21:00:00") }))) // ownership
      .mockResolvedValueOnce(new Response(null, { status: 204 })) // first close
      .mockResolvedValueOnce(jsonResponse(200, task({ id: "9", due: recurringDue(`${TODAY}T21:00:00`) }))) // still today
      .mockResolvedValueOnce(new Response(null, { status: 204 })) // catch-up close
      .mockResolvedValueOnce(jsonResponse(200, task({ id: "9", due: recurringDue("2999-01-01T21:00:00") }))); // future
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(req("/api/chores/9/complete?key=test-dash-secret", { method: "POST" }), env, ctx);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(String(fetchMock.mock.calls[3][0])).toContain("/tasks/9/close");
  });

  it("closes a recurring task due today only once", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, task({ id: "9", due: recurringDue(`${TODAY}T21:00:00`) })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(req("/api/chores/9/complete?key=test-dash-secret", { method: "POST" }), env, ctx);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still succeeds if the catch-up step fails after the first close worked", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, task({ id: "9", due: recurringDue("2000-01-03T21:00:00") })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(req("/api/chores/9/complete?key=test-dash-secret", { method: "POST" }), env, ctx);

    expect(res.status).toBe(200);
    errorSpy.mockRestore();
  });
});

describe("Todoist rejecting a complete/reopen for one task", () => {
  const invalidDate = () =>
    new Response(JSON.stringify({ error: 'Unable to parse "due_string" value', error_tag: "INVALID_DATE" }), {
      status: 400,
    });
  const envWithTelegram: Env = { ...env, TELEGRAM_BOT_TOKEN: "bot", TELEGRAM_CHAT_ID: "chat" };

  function telegramTexts(fetchMock: ReturnType<typeof vi.fn>): string[] {
    return fetchMock.mock.calls
      .filter((c) => String(c[0]).includes("api.telegram.org"))
      .map((c) => JSON.parse(String((c[1] as RequestInit).body)).text as string);
  }

  it("returns 422, logs details and alerts once per task per hour — without counting as an outage", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { kv, store } = fakeKV();
    const e: Env = { ...envWithTelegram, FAILURE_STATE: kv };
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("api.telegram.org")) return jsonResponse(200, { ok: true });
      if (u.endsWith("/close")) return invalidDate();
      return jsonResponse(200, task({ id: "9", content: "Lay out uniform", labels: ["Sam"] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const call = () => worker.fetch(req("/api/chores/9/complete?key=test-dash-secret", { method: "POST" }), e, ctx);
    const first = await call();
    const second = await call();

    expect(first.status).toBe(422);
    expect(second.status).toBe(422);
    expect((await first.json()) as { errorTag: string }).toMatchObject({ errorTag: "INVALID_DATE" });
    const texts = telegramTexts(fetchMock);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("Lay out uniform");
    expect(texts[0]).toContain("INVALID_DATE");
    expect(texts[0]).toContain("delete and recreate");
    expect(errorSpy).toHaveBeenCalledWith(
      "Todoist rejected complete",
      expect.stringContaining('"errorTag":"INVALID_DATE"')
    );
    expect(store.has("todoist:firstFailureAt")).toBe(false); // not an outage
    expect(store.has("reject:alerted:9")).toBe(true);
    errorSpy.mockRestore();
  });

  it("still treats a 5xx on close as an outage (502), not a task rejection", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, task({ id: "9" })))
      .mockResolvedValueOnce(new Response("down", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(req("/api/chores/9/complete?key=test-dash-secret", { method: "POST" }), env, ctx);

    expect(res.status).toBe(502);
    errorSpy.mockRestore();
  });

  it("also reports a rejected reopen", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/reopen") ? invalidDate() : jsonResponse(200, task({ id: "9" }))
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(req("/api/chores/9/reopen?key=test-dash-secret", { method: "POST" }), env, ctx);

    expect(res.status).toBe(422);
    errorSpy.mockRestore();
  });
});

describe("POST /api/chores/:id/reopen", () => {
  it("403s if the task belongs to a different project", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(jsonResponse(200, task({ id: "9", project_id: "some-other-project" })))
    );

    const res = await worker.fetch(req("/api/chores/9/reopen?key=test-dash-secret", { method: "POST" }), env, ctx);

    expect(res.status).toBe(403);
  });

  it("reopens the task once ownership is confirmed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, task({ id: "9" })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(req("/api/chores/9/reopen?key=test-dash-secret", { method: "POST" }), env, ctx);

    expect(res.status).toBe(200);
    expect(String(fetchMock.mock.calls[1][0])).toContain("/tasks/9/reopen");
  });

  function reopenReq(taskId: string, body?: unknown): Request {
    return req(`/api/chores/${taskId}/reopen?key=test-dash-secret`, {
      method: "POST",
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  it("restores a recurring task's due date after reopen (undoing the auto-advance from close)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          200,
          task({ id: "9", due: { date: "2026-08-25", is_recurring: true, string: "every other day", timezone: null } })
        )
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 })) // reopen
      .mockResolvedValueOnce(new Response(null, { status: 200 })); // reschedule
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(reopenReq("9", { dueDate: "2026-08-23" }), env, ctx);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2][0])).toContain("/tasks/9");
    expect(String(fetchMock.mock.calls[2][0])).not.toContain("/reopen");
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({
      due_string: "every other day starting 2026-08-23",
    });
  });

  it("still returns 200 if the reschedule call fails — the reopen itself already succeeded", async () => {
    const { kv, store } = fakeKV();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          200,
          task({ id: "9", due: { date: "2026-08-25", is_recurring: true, string: "every other day", timezone: null } })
        )
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 })) // reopen succeeds
      .mockResolvedValueOnce(new Response("boom", { status: 500 })); // reschedule fails
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await worker.fetch(reopenReq("9", { dueDate: "2026-08-23" }), { ...env, FAILURE_STATE: kv }, ctx);

    expect(res.status).toBe(200);
    // and it must not register as a Todoist-outage failure — the reschedule sub-step
    // failing isn't evidence of a real outage, only the primary reopen action is.
    expect(store.has("todoist:firstFailureAt")).toBe(false);
  });

  it("skips the reschedule call when the due date already matches (no needless write)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          200,
          task({ id: "9", due: { date: "2026-08-23", is_recurring: true, string: "every other day", timezone: null } })
        )
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 })); // reopen
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(reopenReq("9", { dueDate: "2026-08-23" }), env, ctx);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("skips the reschedule call for a non-recurring task (its due date never moved)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          200,
          task({ id: "9", due: { date: "2026-08-23", is_recurring: false, string: "", timezone: null } })
        )
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 })); // reopen
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(reopenReq("9", { dueDate: "2026-08-20" }), env, ctx);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("skips the reschedule call when no body is sent (e.g. an old cached client)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          200,
          task({ id: "9", due: { date: "2026-08-25", is_recurring: true, string: "every other day", timezone: null } })
        )
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 })); // reopen
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(reopenReq("9"), env, ctx);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("doesn't throw on a malformed request body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, task({ id: "9" })))
      .mockResolvedValueOnce(new Response(null, { status: 204 })); // reopen
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      req("/api/chores/9/reopen?key=test-dash-secret", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
      env,
      ctx
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("unknown /api/* routes", () => {
  it("404s", async () => {
    const res = await worker.fetch(req("/api/nonsense?key=test-dash-secret"), env, ctx);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/avatars/:kidKey", () => {
  it("403s without a valid key, same as every other route", async () => {
    const { bucket } = fakeR2();
    const res = await worker.fetch(req("/api/avatars/alex"), { ...env, AVATARS: bucket }, ctx);
    expect(res.status).toBe(403);
  });

  it("returns the object body and content-type when it exists", async () => {
    const { bucket, store } = fakeR2();
    store.set("alex.jpg", { body: new Uint8Array([1, 2, 3]), contentType: "image/jpeg" });

    const res = await worker.fetch(req("/api/avatars/alex?key=test-dash-secret"), { ...env, AVATARS: bucket }, ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("falls back to image/jpeg when the stored .jpg object has no content-type", async () => {
    const { bucket, store } = fakeR2();
    store.set("alex.jpg", { body: new Uint8Array([1]) });

    const res = await worker.fetch(req("/api/avatars/alex?key=test-dash-secret"), { ...env, AVATARS: bucket }, ctx);

    expect(res.headers.get("content-type")).toBe("image/jpeg");
  });

  it("falls back to a .png object when no .jpg exists for this kid", async () => {
    const { bucket, store } = fakeR2();
    store.set("sam.png", { body: new Uint8Array([4, 5, 6]), contentType: "image/png" });

    const res = await worker.fetch(req("/api/avatars/sam?key=test-dash-secret"), { ...env, AVATARS: bucket }, ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([4, 5, 6]));
  });

  it("falls back to image/png when the stored .png object has no content-type", async () => {
    const { bucket, store } = fakeR2();
    store.set("taylor.png", { body: new Uint8Array([1]) });

    const res = await worker.fetch(req("/api/avatars/taylor?key=test-dash-secret"), { ...env, AVATARS: bucket }, ctx);

    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("prefers .jpg over .png when both exist for the same kid", async () => {
    const { bucket, store } = fakeR2();
    store.set("alex.jpg", { body: new Uint8Array([1, 2, 3]), contentType: "image/jpeg" });
    store.set("alex.png", { body: new Uint8Array([4, 5, 6]), contentType: "image/png" });

    const res = await worker.fetch(req("/api/avatars/alex?key=test-dash-secret"), { ...env, AVATARS: bucket }, ctx);

    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("404s when AVATARS is bound but this kid has no photo yet", async () => {
    const { bucket } = fakeR2();
    const res = await worker.fetch(req("/api/avatars/sam?key=test-dash-secret"), { ...env, AVATARS: bucket }, ctx);
    expect(res.status).toBe(404);
  });

  it("404s when AVATARS is unbound entirely (e.g. local dev without R2 configured)", async () => {
    const res = await worker.fetch(req("/api/avatars/alex?key=test-dash-secret"), env, ctx);
    expect(res.status).toBe(404);
  });
});

describe("Telegram notifications", () => {
  const envWithTelegram: Env = {
    ...env,
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_CHAT_ID: "chat-id",
  };

  it("sends a 'finished' message naming the kid(s) after completing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, task({ id: "9", content: "Make bed", labels: ["Alex"] })))
      .mockResolvedValueOnce(new Response(null, { status: 204 })) // close
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 })); // telegram
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      req("/api/chores/9/complete?key=test-dash-secret", { method: "POST" }),
      envWithTelegram,
      ctx
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2][0])).toContain("api.telegram.org/botbot-token/sendMessage");
    const body = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(body).toEqual({ chat_id: "chat-id", text: "✅ Alex finished: Make bed" });
  });

  it("joins multiple kid labels with '&' in the message", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, task({ id: "9", content: "Clean playroom", labels: ["Alex", "Sam", "Taylor"] }))
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await worker.fetch(req("/api/chores/9/complete?key=test-dash-secret", { method: "POST" }), envWithTelegram, ctx);

    const body = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(body.text).toBe("✅ Alex, Sam & Taylor finished: Clean playroom");
  });

  it("sends an 'undid' message after reopening", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, task({ id: "9", content: "Make bed", labels: ["Taylor"] })))
      .mockResolvedValueOnce(new Response(null, { status: 204 })) // reopen
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 })); // telegram
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      req("/api/chores/9/reopen?key=test-dash-secret", { method: "POST" }),
      envWithTelegram,
      ctx
    );

    expect(res.status).toBe(200);
    const body = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(body.text).toBe("↩️ Taylor undid: Make bed");
  });

  it("does not call Telegram when the bot token/chat id aren't configured", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, task({ id: "9" })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await worker.fetch(req("/api/chores/9/complete?key=test-dash-secret", { method: "POST" }), env, ctx);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still returns 200 if the Telegram send fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, task({ id: "9" })))
      .mockResolvedValueOnce(new Response(null, { status: 204 })) // close succeeds
      .mockResolvedValueOnce(new Response("telegram down", { status: 500 })); // telegram fails
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await worker.fetch(
      req("/api/chores/9/complete?key=test-dash-secret", { method: "POST" }),
      envWithTelegram,
      ctx
    );

    expect(res.status).toBe(200);
  });
});

describe("runDailyDigest", () => {
  const envWithTelegram: Env = { ...env, TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_CHAT_ID: "chat-id" };

  it("does nothing (no Todoist or Telegram calls) when Telegram isn't configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await runDailyDigest(env);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports each kid's done-today and still-open counts, reading our own tracked completions (not Todoist's completed-tasks endpoint, which doesn't see recurring completions at all)", async () => {
    const { kv, store } = fakeKV();
    // Simulates what handleCompleteTask's recordDigestCompletion would already have
    // written earlier in the day for real completions.
    store.set(`digest:done:${TODAY}:alex`, JSON.stringify(["c1"]));
    store.set(`digest:done:${TODAY}:sam`, JSON.stringify(["c2", "c3"]));

    const activeTasks = [
      task({ id: "open-1", labels: ["Alex"], due: { date: TODAY, is_recurring: false, string: "", timezone: null } }),
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { results: activeTasks, next_cursor: null })) // getProjectTasks
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 })); // telegram send
    vi.stubGlobal("fetch", fetchMock);

    await runDailyDigest({ ...envWithTelegram, FAILURE_STATE: kv });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain("api.telegram.org");
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.text).toContain("Alex: ✅ 1 done · 🕗 1 still open");
    expect(body.text).toContain("Sam: ✅ 2 done · 🎉 all done!");
    expect(body.text).toContain("Taylor: ✅ 0 done · 🎉 all done!");
  });

  it("reports 0 done for everyone (but still sends, with accurate still-open counts) when FAILURE_STATE isn't bound", async () => {
    const activeTasks = [
      task({ id: "open-1", labels: ["Alex"], due: { date: TODAY, is_recurring: false, string: "", timezone: null } }),
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { results: activeTasks, next_cursor: null }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await runDailyDigest(envWithTelegram); // no FAILURE_STATE

    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.text).toContain("Alex: ✅ 0 done · 🕗 1 still open");
  });

  it("swallows errors instead of throwing (best-effort, runs from a cron trigger)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("boom", { status: 500 })));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(runDailyDigest(envWithTelegram)).resolves.toBeUndefined();
  });

  it("appends a rainy-day line naming the auto-skipped chores when the rain cron ran today", async () => {
    const { kv, store } = fakeKV();
    store.set(
      `rain:skip:${TODAY}`,
      JSON.stringify({
        closedTaskIds: ["wy-back", "wy-front"],
        closedTitles: ["💦 Water the back yard", "💦 Water the front yard"],
        kidKeys: ["sam"],
        sumMm: 12,
        hours: 8,
        notified: true,
      })
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { results: [], next_cursor: null }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await runDailyDigest({ ...envWithTelegram, FAILURE_STATE: kv });

    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.text).toContain(
      '🌧️ Rainy day — "💦 Water the back yard" & "💦 Water the front yard" auto-skipped for Sam.'
    );
  });

  it("falls back to a chore count on the rainy-day line for an older record with no titles", async () => {
    const { kv, store } = fakeKV();
    store.set(
      `rain:skip:${TODAY}`,
      JSON.stringify({ closedTaskIds: ["wy-sam"], kidKeys: ["sam"], sumMm: 12, hours: 8, notified: true })
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { results: [], next_cursor: null }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await runDailyDigest({ ...envWithTelegram, FAILURE_STATE: kv });

    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.text).toContain("🌧️ Rainy day — 1 chore auto-skipped for Sam.");
  });

  it("has no rainy-day line on a normal (non-skip) day", async () => {
    const { kv } = fakeKV();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { results: [], next_cursor: null }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await runDailyDigest({ ...envWithTelegram, FAILURE_STATE: kv });

    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.text).not.toContain("Rainy day");
  });

  it("appends a no-school-day line from a school:skip record, using the occasion label", async () => {
    const { kv, store } = fakeKV();
    store.set(
      `school:skip:${TODAY}`,
      JSON.stringify({
        closedTaskIds: ["lb-alex", "lb-sam"],
        closedTitles: ["🍱 Empty Lunch Box", "🍱 Empty Lunch Box"],
        kidKeys: ["alex", "sam"],
        detail: "Veterans Day",
        notified: true,
      })
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { results: [], next_cursor: null }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await runDailyDigest({ ...envWithTelegram, FAILURE_STATE: kv });

    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.text).toContain('🏫 Veterans Day — "🍱 Empty Lunch Box" auto-skipped for Alex & Sam.');
  });

  it("uses generic 'No-school day' wording when the school:skip record has no occasion label", async () => {
    const { kv, store } = fakeKV();
    store.set(
      `school:skip:${TODAY}`,
      JSON.stringify({
        closedTaskIds: ["lb-taylor"],
        closedTitles: ["🍱 Empty Lunch Box"],
        kidKeys: ["taylor"],
        detail: "",
        notified: true,
      })
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { results: [], next_cursor: null }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await runDailyDigest({ ...envWithTelegram, FAILURE_STATE: kv });

    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.text).toContain('🏫 No-school day — "🍱 Empty Lunch Box" auto-skipped for Taylor.');
  });
});

describe("digest completion tracking", () => {
  it("records a completion so the digest can count it, keyed per kid per day", async () => {
    const { kv, store } = fakeKV();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, task({ id: "9", labels: ["Alex"] }))) // ownership check
      .mockResolvedValueOnce(new Response(null, { status: 204 })); // close
    vi.stubGlobal("fetch", fetchMock);

    await worker.fetch(
      req("/api/chores/9/complete?key=test-dash-secret", { method: "POST" }),
      { ...env, FAILURE_STATE: kv },
      ctx
    );

    expect(JSON.parse(store.get(`digest:done:${TODAY}:alex`)!)).toEqual(["9"]);
  });

  it("gives every kid credit for a shared chore, not just one", async () => {
    const { kv, store } = fakeKV();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, task({ id: "9", labels: ["Alex", "Sam", "Taylor"] })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await worker.fetch(
      req("/api/chores/9/complete?key=test-dash-secret", { method: "POST" }),
      { ...env, FAILURE_STATE: kv },
      ctx
    );

    expect(JSON.parse(store.get(`digest:done:${TODAY}:alex`)!)).toEqual(["9"]);
    expect(JSON.parse(store.get(`digest:done:${TODAY}:sam`)!)).toEqual(["9"]);
    expect(JSON.parse(store.get(`digest:done:${TODAY}:taylor`)!)).toEqual(["9"]);
  });

  it("doesn't double-record the same task twice", async () => {
    const { kv, store } = fakeKV();
    store.set(`digest:done:${TODAY}:alex`, JSON.stringify(["9"]));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, task({ id: "9", labels: ["Alex"] })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await worker.fetch(
      req("/api/chores/9/complete?key=test-dash-secret", { method: "POST" }),
      { ...env, FAILURE_STATE: kv },
      ctx
    );

    expect(JSON.parse(store.get(`digest:done:${TODAY}:alex`)!)).toEqual(["9"]);
  });

  it("un-records on same-day reopen (a mis-tap-and-undo shouldn't count toward the digest)", async () => {
    const { kv, store } = fakeKV();
    store.set(`digest:done:${TODAY}:alex`, JSON.stringify(["9", "other-task"]));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, task({ id: "9", labels: ["Alex"] })))
      .mockResolvedValueOnce(new Response(null, { status: 204 })); // reopen
    vi.stubGlobal("fetch", fetchMock);

    await worker.fetch(
      req("/api/chores/9/reopen?key=test-dash-secret", { method: "POST" }),
      { ...env, FAILURE_STATE: kv },
      ctx
    );

    expect(JSON.parse(store.get(`digest:done:${TODAY}:alex`)!)).toEqual(["other-task"]);
  });

  it("reopening a task that was never recorded today is a harmless no-op", async () => {
    const { kv, store } = fakeKV();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, task({ id: "9", labels: ["Alex"] })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      req("/api/chores/9/reopen?key=test-dash-secret", { method: "POST" }),
      { ...env, FAILURE_STATE: kv },
      ctx
    );

    expect(res.status).toBe(200);
    expect(store.has(`digest:done:${TODAY}:alex`)).toBe(false);
  });

  it("is a no-op when FAILURE_STATE isn't bound (doesn't break complete/reopen)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, task({ id: "9", labels: ["Alex"] })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(req("/api/chores/9/complete?key=test-dash-secret", { method: "POST" }), env, ctx);

    expect(res.status).toBe(200);
  });
});

describe("streak tracking", () => {
  const envWithTelegram: Env = { ...env, TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_CHAT_ID: "chat-id" };

  it("records each kid's clean/not-clean day during the nightly digest — a kid with zero chores due counts as clean, same as one who finished everything", async () => {
    const { kv, store } = fakeKV();
    const activeTasks = [
      task({ id: "open-1", labels: ["Alex"], due: { date: TODAY, is_recurring: false, string: "", timezone: null } }),
    ];
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(200, { results: activeTasks, next_cursor: null }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    );

    await runDailyDigest({ ...envWithTelegram, FAILURE_STATE: kv });

    expect(JSON.parse(store.get("streak:alex")!)).toEqual([{ date: TODAY, clean: false }]); // still has an open chore
    expect(JSON.parse(store.get("streak:sam")!)).toEqual([{ date: TODAY, clean: true }]); // no chores due at all
    expect(JSON.parse(store.get("streak:taylor")!)).toEqual([{ date: TODAY, clean: true }]);
  });

  it("trims a kid's streak record to the last STREAK_HISTORY_DAYS entries rather than growing it forever", async () => {
    const { kv, store } = fakeKV();
    const priorDays = Array.from({ length: 7 }, (_, i) => ({ date: `2026-01-0${i + 1}`, clean: true }));
    store.set("streak:alex", JSON.stringify(priorDays));
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(200, { results: [], next_cursor: null }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    );

    await runDailyDigest({ ...envWithTelegram, FAILURE_STATE: kv });

    const alex = JSON.parse(store.get("streak:alex")!) as { date: string; clean: boolean }[];
    expect(alex).toHaveLength(7);
    expect(alex[alex.length - 1]).toEqual({ date: TODAY, clean: true });
    expect(alex.some((d) => d.date === "2026-01-01")).toBe(false); // oldest entry fell off to make room
  });

  it("GET /api/chores reports the streak count and excludes today from history, even once the digest already ran today", async () => {
    const { kv, store } = fakeKV();
    store.set(
      "streak:alex",
      JSON.stringify([
        { date: "2026-01-01", clean: false },
        { date: "2026-01-02", clean: true },
        { date: "2026-01-03", clean: true },
        { date: TODAY, clean: true }, // digest already ran today
      ])
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse(200, { results: [], next_cursor: null })));

    const res = await worker.fetch(req("/api/chores?key=test-dash-secret"), { ...env, FAILURE_STATE: kv }, ctx);
    const body = (await res.json()) as ChoresApiResponse;

    expect(body.streaks.alex.streak).toBe(3); // Jan 2, Jan 3, and today — all clean, counted from the most recent
    expect(body.streaks.alex.history).toEqual([false, true, true]); // today is never included in history
  });

  it("streak count stops at the first not-clean day scanning backward from the most recent", async () => {
    const { kv, store } = fakeKV();
    store.set(
      "streak:sam",
      JSON.stringify([
        { date: "2026-01-01", clean: true },
        { date: "2026-01-02", clean: false },
        { date: "2026-01-03", clean: true },
      ])
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse(200, { results: [], next_cursor: null })));

    const res = await worker.fetch(req("/api/chores?key=test-dash-secret"), { ...env, FAILURE_STATE: kv }, ctx);
    const body = (await res.json()) as ChoresApiResponse;

    expect(body.streaks.sam.streak).toBe(1); // only Jan 3 counts — Jan 2 breaks the chain
  });

  it("defaults to {streak: 0, history: []} for a kid with no recorded data, and when FAILURE_STATE isn't bound at all", async () => {
    const { kv } = fakeKV();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse(200, { results: [], next_cursor: null })));
    const res = await worker.fetch(req("/api/chores?key=test-dash-secret"), { ...env, FAILURE_STATE: kv }, ctx);
    const body = (await res.json()) as ChoresApiResponse;
    expect(body.streaks.taylor).toEqual({ streak: 0, history: [] });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse(200, { results: [], next_cursor: null })));
    const resNoKv = await worker.fetch(req("/api/chores?key=test-dash-secret"), env, ctx); // no FAILURE_STATE bound
    const bodyNoKv = (await resNoKv.json()) as ChoresApiResponse;
    expect(bodyNoKv.streaks.taylor).toEqual({ streak: 0, history: [] });
  });
});

describe("runRainSkipCheck", () => {
  const rainEnv: Env = {
    ...env,
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_CHAT_ID: "chat-id",
    RAIN_SKIP_ENABLED: "true",
    RAIN_SKIP_MATCH: "Water the Yard",
    RAIN_SKIP_MIN_HOURS: "6",
    RAIN_SKIP_MIN_MM: "5",
  };

  function waterChore(id: string, kid: string, dueDate: string): TodoistTask {
    return task({
      id,
      content: "💦 Water the Yard",
      labels: [kid],
      due: { date: `${dueDate}T20:25:00`, is_recurring: true, string: "every 3 days at 8:25pm", timezone: null },
    });
  }

  /** Routes the mocked fetch by URL: Open-Meteo forecast, Telegram, Todoist
   * task-list / single-task (ownership) / close. */
  function stubRainFetch(opts: {
    forecast: { time: string[]; precipitation_sum: number[]; precipitation_hours: number[] };
    tasks: TodoistTask[];
  }) {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("api.open-meteo.com")) return Promise.resolve(jsonResponse(200, { daily: opts.forecast }));
      if (u.includes("api.telegram.org")) return Promise.resolve(jsonResponse(200, { ok: true }));
      if (/\/tasks\/[^/?]+\/close/.test(u)) return Promise.resolve(new Response(null, { status: 204 }));
      const single = u.match(/\/tasks\/([^/?]+)(?:\?|$)/);
      if (single) {
        const found = opts.tasks.find((t) => t.id === decodeURIComponent(single[1]));
        return Promise.resolve(jsonResponse(200, found ?? task({ id: single[1] })));
      }
      return Promise.resolve(jsonResponse(200, { results: opts.tasks, next_cursor: null })); // /tasks?project_id=
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("on a properly wet day, closes every matching chore due today, counts them done, and stays silent (no Telegram)", async () => {
    const { kv, store } = fakeKV();
    const fetchMock = stubRainFetch({
      forecast: { time: [TODAY], precipitation_sum: [12.3], precipitation_hours: [8] },
      tasks: [
        waterChore("wy-alex", "Alex", TODAY),
        waterChore("wy-sam", "Sam", TODAY),
        waterChore("wy-taylor", "Taylor", TODAY),
        task({
          id: "other",
          content: "🛏️ Clean Bedroom",
          labels: ["Alex"],
          due: { date: `${TODAY}T20:35:00`, is_recurring: true, string: "", timezone: null },
        }),
      ],
    });

    await runRainSkipCheck({ ...rainEnv, FAILURE_STATE: kv });

    const closeCalls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/close"));
    expect(closeCalls.some((u) => u.includes("/tasks/wy-alex/close"))).toBe(true);
    expect(closeCalls.some((u) => u.includes("/tasks/wy-sam/close"))).toBe(true);
    expect(closeCalls.some((u) => u.includes("/tasks/wy-taylor/close"))).toBe(true);
    expect(closeCalls.some((u) => u.includes("/tasks/other/close"))).toBe(false); // non-matching chore untouched
    expect(fetchMock.mock.calls.every((c) => !String(c[0]).includes("api.telegram.org"))).toBe(true);

    const state = JSON.parse(store.get(`rain:skip:${TODAY}`)!);
    expect(state.closedTaskIds.sort()).toEqual(["wy-alex", "wy-sam", "wy-taylor"]);
    expect(state.closedTitles).toEqual(["💦 Water the Yard", "💦 Water the Yard", "💦 Water the Yard"]);
    expect(state.kidKeys.sort()).toEqual(["alex", "sam", "taylor"]);
    expect(state.detail).toBe("forecast: ~8h, 12mm today");
    expect(state.notified).toBe(false);
    expect(JSON.parse(store.get(`digest:done:${TODAY}:sam`)!)).toEqual(["wy-sam"]);
  });

  it("matches case-insensitively — a lowercased RAIN_SKIP_MATCH still catches an emoji-prefixed title", async () => {
    const { kv, store } = fakeKV();
    stubRainFetch({
      forecast: { time: [TODAY], precipitation_sum: [12], precipitation_hours: [8] },
      tasks: [waterChore("wy-sam", "Sam", TODAY)], // title is "💦 Water the Yard"
    });

    await runRainSkipCheck({ ...rainEnv, RAIN_SKIP_MATCH: "water the yard", FAILURE_STATE: kv });

    expect(JSON.parse(store.get(`rain:skip:${TODAY}`)!).closedTaskIds).toEqual(["wy-sam"]);
  });

  it("accepts a comma-separated RAIN_SKIP_MATCH and closes chores matching any entry", async () => {
    const { kv, store } = fakeKV();
    const back = task({
      id: "wy-back",
      content: "💦 Water the back yard",
      labels: ["Sam"],
      due: { date: `${TODAY}T20:25:00`, is_recurring: true, string: "", timezone: null },
    });
    const front = task({
      id: "wy-front",
      content: "💦 Water the front yard",
      labels: ["Taylor"],
      due: { date: `${TODAY}T20:25:00`, is_recurring: true, string: "", timezone: null },
    });
    const unrelated = task({
      id: "wy-side",
      content: "💦 Water the side garden",
      labels: ["Alex"],
      due: { date: `${TODAY}T20:25:00`, is_recurring: true, string: "", timezone: null },
    });
    stubRainFetch({
      forecast: { time: [TODAY], precipitation_sum: [12], precipitation_hours: [8] },
      tasks: [back, front, unrelated],
    });

    await runRainSkipCheck({
      ...rainEnv,
      RAIN_SKIP_MATCH: "Water the back yard, Water the front yard",
      FAILURE_STATE: kv,
    });

    const state = JSON.parse(store.get(`rain:skip:${TODAY}`)!);
    expect(state.closedTaskIds.sort()).toEqual(["wy-back", "wy-front"]); // side garden untouched
    expect(state.closedTitles.sort()).toEqual(["💦 Water the back yard", "💦 Water the front yard"]);
  });

  it("does nothing when precipitation hours don't clear the threshold (even if mm does)", async () => {
    const { kv, store } = fakeKV();
    const fetchMock = stubRainFetch({
      forecast: { time: [TODAY], precipitation_sum: [20], precipitation_hours: [6] }, // 6 is not > 6
      tasks: [waterChore("wy-sam", "Sam", TODAY)],
    });

    await runRainSkipCheck({ ...rainEnv, FAILURE_STATE: kv });

    expect(fetchMock).toHaveBeenCalledTimes(1); // just the forecast — no task list, no close
    expect(store.has(`rain:skip:${TODAY}`)).toBe(false);
  });

  it("does nothing when precipitation mm doesn't clear the threshold (even if hours do)", async () => {
    const { kv, store } = fakeKV();
    const fetchMock = stubRainFetch({
      forecast: { time: [TODAY], precipitation_sum: [2], precipitation_hours: [10] },
      tasks: [waterChore("wy-sam", "Sam", TODAY)],
    });

    await runRainSkipCheck({ ...rainEnv, FAILURE_STATE: kv });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.has(`rain:skip:${TODAY}`)).toBe(false);
  });

  it("leaves a matching chore alone if it isn't due today (already advanced past today)", async () => {
    const { kv, store } = fakeKV();
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const fetchMock = stubRainFetch({
      forecast: { time: [TODAY], precipitation_sum: [12], precipitation_hours: [8] },
      tasks: [waterChore("wy-sam", "Sam", tomorrow)],
    });

    await runRainSkipCheck({ ...rainEnv, FAILURE_STATE: kv });

    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/close"))).toBe(false);
    expect(store.has(`rain:skip:${TODAY}`)).toBe(false);
  });

  it("is a fast no-op if it already acted today (KV guard)", async () => {
    const { kv, store } = fakeKV();
    store.set(
      `rain:skip:${TODAY}`,
      JSON.stringify({ closedTaskIds: ["wy-sam"], kidKeys: ["sam"], sumMm: 12, hours: 8, notified: false })
    );
    const fetchMock = stubRainFetch({
      forecast: { time: [TODAY], precipitation_sum: [12], precipitation_hours: [8] },
      tasks: [waterChore("wy-sam", "Sam", TODAY)],
    });

    await runRainSkipCheck({ ...rainEnv, FAILURE_STATE: kv });

    expect(fetchMock).not.toHaveBeenCalled(); // returned before even fetching the forecast
  });

  it("is a no-op when RAIN_SKIP_ENABLED isn't 'true'", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await runRainSkipCheck(env); // no RAIN_SKIP_* vars at all

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("closes the chore but records nothing extra when RAIN_SKIP_COUNTS_AS_DONE is 'false'", async () => {
    const { kv, store } = fakeKV();
    stubRainFetch({
      forecast: { time: [TODAY], precipitation_sum: [12], precipitation_hours: [8] },
      tasks: [waterChore("wy-sam", "Sam", TODAY)],
    });

    await runRainSkipCheck({ ...rainEnv, RAIN_SKIP_COUNTS_AS_DONE: "false", FAILURE_STATE: kv });

    expect(JSON.parse(store.get(`rain:skip:${TODAY}`)!).closedTaskIds).toEqual(["wy-sam"]);
    expect(store.has(`digest:done:${TODAY}:sam`)).toBe(false);
  });

  it("still closes matching chores with no FAILURE_STATE bound (just can't write the notice/digest state)", async () => {
    const fetchMock = stubRainFetch({
      forecast: { time: [TODAY], precipitation_sum: [12], precipitation_hours: [8] },
      tasks: [waterChore("wy-sam", "Sam", TODAY)],
    });

    await expect(runRainSkipCheck(rainEnv)).resolves.toBeUndefined();

    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/tasks/wy-sam/close"))).toBe(true);
  });

  it("swallows a forecast fetch failure without closing anything", async () => {
    const { kv, store } = fakeKV();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string) =>
        String(url).includes("api.open-meteo.com")
          ? Promise.resolve(new Response("boom", { status: 500 }))
          : Promise.resolve(jsonResponse(200, { results: [], next_cursor: null }))
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(runRainSkipCheck({ ...rainEnv, FAILURE_STATE: kv })).resolves.toBeUndefined();

    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/close"))).toBe(false);
    expect(store.has(`rain:skip:${TODAY}`)).toBe(false);
  });

  it("bails if the forecast's day doesn't match the Worker's 'today' (guards a near-midnight mismatch)", async () => {
    const { kv, store } = fakeKV();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = stubRainFetch({
      forecast: { time: ["2020-01-01"], precipitation_sum: [50], precipitation_hours: [24] },
      tasks: [waterChore("wy-sam", "Sam", TODAY)],
    });

    await runRainSkipCheck({ ...rainEnv, FAILURE_STATE: kv });

    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/close"))).toBe(false);
    expect(store.has(`rain:skip:${TODAY}`)).toBe(false);
  });
});

describe("runSchoolSkipCheck", () => {
  const schoolEnv: Env = {
    ...env,
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_CHAT_ID: "chat-id",
    SCHOOL_SKIP_ENABLED: "true",
    SCHOOL_SKIP_LABEL: "school-day",
  };

  function assetsWith(file: unknown): Fetcher {
    return { fetch: vi.fn(async () => new Response(JSON.stringify(file), { status: 200 })) } as unknown as Fetcher;
  }

  function lunchBox(id: string, kid: string, dueDate: string, extraLabels: string[] = ["school-day"]): TodoistTask {
    return task({
      id,
      content: "🍱 Empty Lunch Box",
      labels: [kid, ...extraLabels],
      due: { date: `${dueDate}T20:15:00`, is_recurring: true, string: "every weekday at 8:15pm", timezone: null },
    });
  }

  /** Todoist-only fetch router — the calendar comes from env.ASSETS, not global fetch. */
  function stubTodoistFetch(tasks: TodoistTask[]) {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("api.telegram.org")) return Promise.resolve(jsonResponse(200, { ok: true }));
      if (/\/tasks\/[^/?]+\/close/.test(u)) return Promise.resolve(new Response(null, { status: 204 }));
      const single = u.match(/\/tasks\/([^/?]+)(?:\?|$)/);
      if (single) {
        const found = tasks.find((t) => t.id === decodeURIComponent(single[1]));
        return Promise.resolve(jsonResponse(200, found ?? task({ id: single[1] })));
      }
      return Promise.resolve(jsonResponse(200, { results: tasks, next_cursor: null }));
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("on a no-school day, closes every school-day-labelled chore due today, does NOT count them done, stays silent", async () => {
    const { kv, store } = fakeKV();
    const ASSETS = assetsWith({ skipDates: [TODAY], labels: { [TODAY]: "Veterans Day" } });
    const fetchMock = stubTodoistFetch([
      lunchBox("lb-alex", "Alex", TODAY),
      lunchBox("lb-sam", "Sam", TODAY),
      lunchBox("lb-taylor", "Taylor", TODAY),
      task({
        id: "reading",
        content: "📖 Read for 20 minutes",
        labels: ["Alex"],
        due: { date: `${TODAY}T19:30:00`, is_recurring: true, string: "", timezone: null },
      }),
    ]);

    await runSchoolSkipCheck({ ...schoolEnv, ASSETS, FAILURE_STATE: kv });

    const closeCalls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/close"));
    expect(closeCalls.some((u) => u.includes("/tasks/lb-alex/close"))).toBe(true);
    expect(closeCalls.some((u) => u.includes("/tasks/lb-sam/close"))).toBe(true);
    expect(closeCalls.some((u) => u.includes("/tasks/lb-taylor/close"))).toBe(true);
    expect(closeCalls.some((u) => u.includes("/tasks/reading/close"))).toBe(false); // not school-day-labelled
    expect(fetchMock.mock.calls.every((c) => !String(c[0]).includes("api.telegram.org"))).toBe(true);

    const state = JSON.parse(store.get(`school:skip:${TODAY}`)!);
    expect(state.closedTaskIds.sort()).toEqual(["lb-alex", "lb-sam", "lb-taylor"]);
    expect(state.closedTitles).toEqual(["🍱 Empty Lunch Box", "🍱 Empty Lunch Box", "🍱 Empty Lunch Box"]);
    expect(state.detail).toBe("Veterans Day");
    expect(state.notified).toBe(false);
    expect(store.has(`digest:done:${TODAY}:sam`)).toBe(false); // SCHOOL_SKIP_COUNTS_AS_DONE defaults false
  });

  it("counts chores done when SCHOOL_SKIP_COUNTS_AS_DONE is 'true'", async () => {
    const { kv, store } = fakeKV();
    const ASSETS = assetsWith({ skipDates: [TODAY], labels: {} });
    stubTodoistFetch([lunchBox("lb-sam", "Sam", TODAY)]);

    await runSchoolSkipCheck({ ...schoolEnv, SCHOOL_SKIP_COUNTS_AS_DONE: "true", ASSETS, FAILURE_STATE: kv });

    expect(JSON.parse(store.get(`digest:done:${TODAY}:sam`)!)).toEqual(["lb-sam"]);
  });

  it("does nothing (never even lists tasks) when today isn't a no-school day", async () => {
    const { kv, store } = fakeKV();
    const ASSETS = assetsWith({ skipDates: ["2020-01-01"], labels: {} });
    const fetchMock = stubTodoistFetch([lunchBox("lb-sam", "Sam", TODAY)]);

    await runSchoolSkipCheck({ ...schoolEnv, ASSETS, FAILURE_STATE: kv });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.has(`school:skip:${TODAY}`)).toBe(false);
  });

  it("honors the runtime manual flag — a date only in school:skip:manual still triggers", async () => {
    const { kv, store } = fakeKV();
    store.set("school:skip:manual", JSON.stringify({ [TODAY]: "Snow day" }));
    const ASSETS = assetsWith({ skipDates: [], labels: {} });
    stubTodoistFetch([lunchBox("lb-sam", "Sam", TODAY)]);

    await runSchoolSkipCheck({ ...schoolEnv, ASSETS, FAILURE_STATE: kv });

    const state = JSON.parse(store.get(`school:skip:${TODAY}`)!);
    expect(state.closedTaskIds).toEqual(["lb-sam"]);
    expect(state.detail).toBe("Snow day");
  });

  it("stores an empty detail ('' → generic wording) when the no-school date has no label", async () => {
    const { kv, store } = fakeKV();
    const ASSETS = assetsWith({ skipDates: [TODAY], labels: {} });
    stubTodoistFetch([lunchBox("lb-sam", "Sam", TODAY)]);

    await runSchoolSkipCheck({ ...schoolEnv, ASSETS, FAILURE_STATE: kv });

    expect(JSON.parse(store.get(`school:skip:${TODAY}`)!).detail).toBe("");
  });

  it("skips on an out-of-term date (summer) via the termStart/termEnd window, detail 'Summer break'", async () => {
    const { kv, store } = fakeKV();
    // A valid past window — TODAY is well after termEnd, so the window makes it no-school.
    const ASSETS = assetsWith({ termStart: "2000-01-01", termEnd: "2000-12-31", skipDates: [], labels: {} });
    stubTodoistFetch([lunchBox("lb-sam", "Sam", TODAY)]);

    await runSchoolSkipCheck({ ...schoolEnv, ASSETS, FAILURE_STATE: kv });

    const state = JSON.parse(store.get(`school:skip:${TODAY}`)!);
    expect(state.closedTaskIds).toEqual(["lb-sam"]);
    expect(state.detail).toBe("Summer break");
  });

  it("leaves a school-day chore that isn't due today alone", async () => {
    const { kv, store } = fakeKV();
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const ASSETS = assetsWith({ skipDates: [TODAY], labels: {} });
    const fetchMock = stubTodoistFetch([lunchBox("lb-sam", "Sam", tomorrow)]);

    await runSchoolSkipCheck({ ...schoolEnv, ASSETS, FAILURE_STATE: kv });

    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/close"))).toBe(false);
    expect(store.has(`school:skip:${TODAY}`)).toBe(false);
  });

  it("is a fast no-op if a school:skip record already exists for today", async () => {
    const { kv, store } = fakeKV();
    store.set(
      `school:skip:${TODAY}`,
      JSON.stringify({ closedTaskIds: ["lb-sam"], kidKeys: ["sam"], detail: "", notified: false })
    );
    const ASSETS = assetsWith({ skipDates: [TODAY], labels: {} });
    const fetchMock = stubTodoistFetch([lunchBox("lb-sam", "Sam", TODAY)]);

    await runSchoolSkipCheck({ ...schoolEnv, ASSETS, FAILURE_STATE: kv });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(ASSETS.fetch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("is a no-op when SCHOOL_SKIP_ENABLED isn't 'true'", async () => {
    const ASSETS = assetsWith({ skipDates: [TODAY], labels: {} });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await runSchoolSkipCheck({ ...env, ASSETS });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(ASSETS.fetch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("still closes chores with no FAILURE_STATE bound (just can't write the record)", async () => {
    const ASSETS = assetsWith({ skipDates: [TODAY], labels: {} });
    const fetchMock = stubTodoistFetch([lunchBox("lb-sam", "Sam", TODAY)]);

    await expect(runSchoolSkipCheck({ ...schoolEnv, ASSETS })).resolves.toBeUndefined();

    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/tasks/lb-sam/close"))).toBe(true);
  });

  it("fails open when the calendar asset can't be read", async () => {
    const { kv, store } = fakeKV();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ASSETS = { fetch: vi.fn(async () => new Response("nope", { status: 500 })) } as unknown as Fetcher;
    const fetchMock = stubTodoistFetch([lunchBox("lb-sam", "Sam", TODAY)]);

    await runSchoolSkipCheck({ ...schoolEnv, ASSETS, FAILURE_STATE: kv });

    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/close"))).toBe(false);
    expect(store.has(`school:skip:${TODAY}`)).toBe(false);
  });
});

describe("maybeSendSnowReminder", () => {
  const snowEnv: Env = {
    ...env,
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_CHAT_ID: "chat-id",
    SNOW_REMINDER_ENABLED: "true",
  };
  const WEEKDAY_8AM = new Date("2027-01-14T13:00:00Z"); // Thu 08:00 America/New_York (EST)
  const WEEKEND_8AM = new Date("2027-01-16T13:00:00Z"); // Sat 08:00
  const WEEKDAY_4AM = new Date("2027-01-14T09:00:00Z"); // Thu 04:00 — before SNOW_REMINDER_HOUR 6
  const DAY = "2027-01-14";

  function assetsWith(file: unknown): Fetcher {
    return { fetch: vi.fn(async () => new Response(JSON.stringify(file), { status: 200 })) } as unknown as Fetcher;
  }
  function stubForecast(daily: Record<string, unknown>) {
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string) =>
        String(url).includes("api.open-meteo.com")
          ? Promise.resolve(jsonResponse(200, { daily }))
          : Promise.resolve(jsonResponse(200, { ok: true }))
      );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }
  const telegramCalls = (m: ReturnType<typeof vi.fn>) =>
    m.mock.calls.filter((c) => String(c[0]).includes("api.telegram.org"));

  afterEach(() => {
    vi.useRealTimers();
  });

  it("nudges once on a wintry weekday that isn't already a no-school day, then dedupes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(WEEKDAY_8AM);
    const { kv, store } = fakeKV();
    const ASSETS = assetsWith({ skipDates: [], labels: {} });
    const fetchMock = stubForecast({ time: [DAY], snowfall_sum: [3], weather_code: [73] });

    await maybeSendSnowReminder({ ...snowEnv, ASSETS, FAILURE_STATE: kv });

    expect(telegramCalls(fetchMock)).toHaveLength(1);
    expect(JSON.parse(telegramCalls(fetchMock)[0][1].body).text).toContain("❄️");
    expect(store.has(`snow:reminded:${DAY}`)).toBe(true);

    await maybeSendSnowReminder({ ...snowEnv, ASSETS, FAILURE_STATE: kv });
    expect(telegramCalls(fetchMock)).toHaveLength(1); // still once
  });

  it("nudges on a wintry weather_code even with no measurable snowfall", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(WEEKDAY_8AM);
    const { kv } = fakeKV();
    const ASSETS = assetsWith({ skipDates: [], labels: {} });
    const fetchMock = stubForecast({ time: [DAY], snowfall_sum: [0], weather_code: [67] }); // freezing rain

    await maybeSendSnowReminder({ ...snowEnv, ASSETS, FAILURE_STATE: kv });

    expect(telegramCalls(fetchMock)).toHaveLength(1);
  });

  it("does nothing when the forecast isn't wintry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(WEEKDAY_8AM);
    const { kv } = fakeKV();
    const ASSETS = assetsWith({ skipDates: [], labels: {} });
    const fetchMock = stubForecast({ time: [DAY], snowfall_sum: [0], weather_code: [3] });

    await maybeSendSnowReminder({ ...snowEnv, ASSETS, FAILURE_STATE: kv });

    expect(telegramCalls(fetchMock)).toHaveLength(0);
  });

  it("does nothing on a weekend", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(WEEKEND_8AM);
    const { kv } = fakeKV();
    const ASSETS = assetsWith({ skipDates: [], labels: {} });
    const fetchMock = stubForecast({ time: ["2027-01-16"], snowfall_sum: [10], weather_code: [75] });

    await maybeSendSnowReminder({ ...snowEnv, ASSETS, FAILURE_STATE: kv });

    expect(telegramCalls(fetchMock)).toHaveLength(0);
  });

  it("does nothing when today is already a known no-school day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(WEEKDAY_8AM);
    const { kv } = fakeKV();
    const ASSETS = assetsWith({ skipDates: [DAY], labels: { [DAY]: "Snow make-up" } });
    const fetchMock = stubForecast({ time: [DAY], snowfall_sum: [10], weather_code: [75] });

    await maybeSendSnowReminder({ ...snowEnv, ASSETS, FAILURE_STATE: kv });

    expect(telegramCalls(fetchMock)).toHaveLength(0);
  });

  it("does nothing before SNOW_REMINDER_HOUR", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(WEEKDAY_4AM);
    const { kv } = fakeKV();
    const ASSETS = assetsWith({ skipDates: [], labels: {} });
    const fetchMock = stubForecast({ time: [DAY], snowfall_sum: [10], weather_code: [75] });

    await maybeSendSnowReminder({ ...snowEnv, ASSETS, FAILURE_STATE: kv });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is a no-op when SNOW_REMINDER_ENABLED isn't 'true'", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(WEEKDAY_8AM);
    const { kv } = fakeKV();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await maybeSendSnowReminder({ ...env, TELEGRAM_BOT_TOKEN: "b", TELEGRAM_CHAT_ID: "c", FAILURE_STATE: kv });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("/api/school-skip (manual no-school flag)", () => {
  function ssReq(path: string, method: string, qs = "") {
    return req(`${path}?key=test-dash-secret${qs}`, { method });
  }

  it("403s without a valid key", async () => {
    const { kv } = fakeKV();
    const res = await worker.fetch(req("/api/school-skip"), { ...env, FAILURE_STATE: kv }, ctx);
    expect(res.status).toBe(403);
  });

  it("503s when FAILURE_STATE isn't bound", async () => {
    const res = await worker.fetch(ssReq("/api/school-skip", "GET"), env, ctx);
    expect(res.status).toBe(503);
  });

  it("GET lists the current manual dates", async () => {
    const { kv, store } = fakeKV();
    store.set("school:skip:manual", JSON.stringify({ "2099-01-01": "Snow day" }));
    const res = await worker.fetch(ssReq("/api/school-skip", "GET"), { ...env, FAILURE_STATE: kv }, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ manual: { "2099-01-01": "Snow day" } });
  });

  it("POST /today adds today with the default reason and persists it", async () => {
    const { kv, store } = fakeKV();
    const res = await worker.fetch(ssReq("/api/school-skip/today", "POST"), { ...env, FAILURE_STATE: kv }, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; manual: Record<string, string> };
    expect(body.ok).toBe(true);
    expect(body.manual[TODAY]).toBe("Snow day");
    expect(JSON.parse(store.get("school:skip:manual")!)[TODAY]).toBe("Snow day");
  });

  it("POST /today?reason= overrides the label", async () => {
    const { kv } = fakeKV();
    const res = await worker.fetch(
      ssReq("/api/school-skip/today", "POST", "&reason=Ice%20day"),
      { ...env, FAILURE_STATE: kv },
      ctx
    );
    expect(((await res.json()) as { manual: Record<string, string> }).manual[TODAY]).toBe("Ice day");
  });

  it("DELETE /today removes today", async () => {
    const { kv, store } = fakeKV();
    store.set("school:skip:manual", JSON.stringify({ [TODAY]: "Snow day" }));
    const res = await worker.fetch(ssReq("/api/school-skip/today", "DELETE"), { ...env, FAILURE_STATE: kv }, ctx);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { manual: Record<string, string> }).manual).toEqual({});
  });

  it("prunes entries older than the retention window on write", async () => {
    const { kv, store } = fakeKV();
    store.set("school:skip:manual", JSON.stringify({ "2000-01-01": "old", [TODAY]: "keep" }));
    await worker.fetch(
      ssReq("/api/school-skip/today", "POST", "&date=2099-06-01&reason=future"),
      { ...env, FAILURE_STATE: kv },
      ctx
    );
    const map = JSON.parse(store.get("school:skip:manual")!) as Record<string, string>;
    expect(map["2000-01-01"]).toBeUndefined();
    expect(map[TODAY]).toBe("keep");
    expect(map["2099-06-01"]).toBe("future");
  });

  it("400s on a malformed ?date=", async () => {
    const { kv } = fakeKV();
    const res = await worker.fetch(
      ssReq("/api/school-skip/today", "POST", "&date=nope"),
      { ...env, FAILURE_STATE: kv },
      ctx
    );
    expect(res.status).toBe(400);
  });

  it("POST /today immediately clears today's school-day chores when SCHOOL_SKIP_ENABLED is on", async () => {
    const { kv, store } = fakeKV();
    const ASSETS = {
      fetch: vi.fn(async () => new Response(JSON.stringify({ skipDates: [], labels: {} }), { status: 200 })),
    } as unknown as Fetcher;
    const lb = task({
      id: "lb-sam",
      content: "🍱 Empty Lunch Box",
      labels: ["Sam", "school-day"],
      due: { date: `${TODAY}T20:15:00`, is_recurring: true, string: "every weekday", timezone: null },
    });
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (/\/tasks\/[^/?]+\/close/.test(u)) return Promise.resolve(new Response(null, { status: 204 }));
      const single = u.match(/\/tasks\/([^/?]+)(?:\?|$)/);
      if (single) return Promise.resolve(jsonResponse(200, lb));
      return Promise.resolve(jsonResponse(200, { results: [lb], next_cursor: null }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      ssReq("/api/school-skip/today", "POST"),
      { ...env, SCHOOL_SKIP_ENABLED: "true", SCHOOL_SKIP_LABEL: "school-day", ASSETS, FAILURE_STATE: kv },
      ctx
    );

    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/tasks/lb-sam/close"))).toBe(true);
    expect(store.has(`school:skip:${TODAY}`)).toBe(true);
  });
});

describe("deliverSkipNotices", () => {
  const noticeEnv: Env = { ...env, TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_CHAT_ID: "chat-id" };
  const NOON_EDT = new Date("2026-09-07T16:00:00Z"); // 12:00 America/New_York
  const EARLY_EDT = new Date("2026-09-07T11:00:00Z"); // 07:00 America/New_York — before the 9am notify hour
  const DAY = "2026-09-07";
  const rainKey = `rain:skip:${DAY}`;
  const schoolKey = `school:skip:${DAY}`;

  function rainState(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      closedTaskIds: ["wy-sam"],
      closedTitles: ["💦 Water the Yard"],
      kidKeys: ["sam"],
      detail: "forecast: ~8h, 12mm today",
      notified: false,
      ...overrides,
    });
  }
  function schoolState(overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      closedTaskIds: ["lb-alex", "lb-sam"],
      closedTitles: ["🍱 Empty Lunch Box", "🍱 Empty Lunch Box"],
      kidKeys: ["alex", "sam"],
      detail: "Veterans Day",
      notified: false,
      ...overrides,
    });
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends one rain notice for an un-notified skip once past the notify hour, then marks it notified and doesn't re-send", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOON_EDT);
    const { kv, store } = fakeKV();
    store.set(rainKey, rainState());
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await deliverSkipNotices({ ...noticeEnv, FAILURE_STATE: kv });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("api.telegram.org");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toContain("🌧️ Rain skip — auto-completed");
    expect(body.text).toContain('"💦 Water the Yard"');
    expect(body.text).toContain("(forecast: ~8h, 12mm today).");
    expect(JSON.parse(store.get(rainKey)!).notified).toBe(true);

    await deliverSkipNotices({ ...noticeEnv, FAILURE_STATE: kv });
    expect(fetchMock).toHaveBeenCalledTimes(1); // still just once
  });

  it("sends a school notice using the occasion label", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOON_EDT);
    const { kv, store } = fakeKV();
    store.set(schoolKey, schoolState());
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await deliverSkipNotices({ ...noticeEnv, FAILURE_STATE: kv });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toBe('🏫 Veterans Day — auto-cleared "🍱 Empty Lunch Box" for Alex & Sam (no school today).');
    expect(JSON.parse(store.get(schoolKey)!).notified).toBe(true);
  });

  it("sends both a rain and a school notice on a day that had both, and one failing send doesn't block the other", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOON_EDT);
    const { kv, store } = fakeKV();
    store.set(rainKey, rainState());
    store.set(schoolKey, schoolState());
    // First send (rain) fails; second (school) still goes.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("telegram down", { status: 500 }))
      .mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await deliverSkipNotices({ ...noticeEnv, FAILURE_STATE: kv });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(store.get(rainKey)!).notified).toBe(false); // failed → retried later
    expect(JSON.parse(store.get(schoolKey)!).notified).toBe(true);
  });

  it("names multiple auto-completed chores, de-duplicating repeated titles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOON_EDT);
    const { kv, store } = fakeKV();
    store.set(
      rainKey,
      rainState({
        closedTaskIds: ["wy-back-sam", "wy-back-taylor", "wy-front-sam"],
        closedTitles: ["💦 Water the back yard", "💦 Water the back yard", "💦 Water the front yard"],
        kidKeys: ["sam", "taylor"],
      })
    );
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await deliverSkipNotices({ ...noticeEnv, FAILURE_STATE: kv });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toContain(
      '🌧️ Rain skip — auto-completed "💦 Water the back yard" & "💦 Water the front yard" for Sam & Taylor'
    );
  });

  it("falls back to a chore count for an older record with no titles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOON_EDT);
    const { kv, store } = fakeKV();
    store.set(rainKey, rainState({ closedTitles: undefined }));
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await deliverSkipNotices({ ...noticeEnv, FAILURE_STATE: kv });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toContain("🌧️ Rain skip — auto-completed 1 chore for Sam");
  });

  it("does not send before the notify hour", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(EARLY_EDT);
    const { kv, store } = fakeKV();
    store.set(rainKey, rainState());
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await deliverSkipNotices({ ...noticeEnv, FAILURE_STATE: kv });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(store.get(rainKey)!).notified).toBe(false);
  });

  it("does nothing when there's no skip state for today", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOON_EDT);
    const { kv } = fakeKV();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await deliverSkipNotices({ ...noticeEnv, FAILURE_STATE: kv });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves notified false if the Telegram send fails, so a later tick retries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOON_EDT);
    const { kv, store } = fakeKV();
    store.set(rainKey, rainState());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("telegram down", { status: 500 })));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await deliverSkipNotices({ ...noticeEnv, FAILURE_STATE: kv });

    expect(JSON.parse(store.get(rainKey)!).notified).toBe(false);
  });

  it("is a no-op without FAILURE_STATE or without Telegram configured", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOON_EDT);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { kv, store } = fakeKV();
    store.set(rainKey, rainState());

    await deliverSkipNotices(noticeEnv); // no FAILURE_STATE
    await deliverSkipNotices({ ...env, FAILURE_STATE: kv }); // no Telegram

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Todoist failure alerting", () => {
  it("alerts once after failing continuously for the threshold duration, stays quiet on repeats, and resets on success", async () => {
    vi.useFakeTimers();
    const { kv, store } = fakeKV();
    const envWithTracking: Env = {
      ...env,
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHAT_ID: "chat-id",
      FAILURE_STATE: kv,
    };

    let todoistShouldSucceed = false;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("api.telegram.org")) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      }
      return Promise.resolve(
        todoistShouldSucceed
          ? jsonResponse(200, { results: [], next_cursor: null })
          : new Response("boom", { status: 500 })
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    // first failure starts the clock — too soon to alert
    let res = await worker.fetch(req("/api/chores?key=test-dash-secret"), envWithTracking, ctx);
    expect(res.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no telegram call yet

    // still within the 2-minute threshold window
    await vi.advanceTimersByTimeAsync(60 * 1000);
    res = await worker.fetch(req("/api/chores?key=test-dash-secret"), envWithTracking, ctx);
    expect(res.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(2); // still no telegram call

    // now past the threshold — this failure triggers the alert
    await vi.advanceTimersByTimeAsync(90 * 1000);
    res = await worker.fetch(req("/api/chores?key=test-dash-secret"), envWithTracking, ctx);
    expect(res.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(4); // the Todoist failure + exactly 1 Telegram alert
    expect(String(fetchMock.mock.calls[3][0])).toContain("api.telegram.org");
    const alertBody = JSON.parse(fetchMock.mock.calls[3][1].body);
    expect(alertBody.text).toContain("failing for");

    // a further failure doesn't re-alert
    res = await worker.fetch(req("/api/chores?key=test-dash-secret"), envWithTracking, ctx);
    expect(res.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(5); // just the Todoist failure, no second Telegram call

    todoistShouldSucceed = true;
    const okRes = await worker.fetch(req("/api/chores?key=test-dash-secret"), envWithTracking, ctx);
    expect(okRes.status).toBe(200);
    expect(store.has("todoist:firstFailureAt")).toBe(false);
    expect(store.has("todoist:alerted")).toBe(false);

    vi.useRealTimers();
  });

  it("counts a raw network-level failure (not just a bad HTTP status) toward the alert — regression: todoistFetch used to rethrow these unwrapped, bypassing the instanceof TodoistApiError check entirely", async () => {
    vi.useFakeTimers();
    const { kv } = fakeKV();
    const envWithTracking: Env = {
      ...env,
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHAT_ID: "chat-id",
      FAILURE_STATE: kv,
    };
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("api.telegram.org")) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      }
      return Promise.reject(new TypeError("network connection lost"));
    });
    vi.stubGlobal("fetch", fetchMock);

    await worker.fetch(req("/api/chores?key=test-dash-secret"), envWithTracking, ctx);
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    const res = await worker.fetch(req("/api/chores?key=test-dash-secret"), envWithTracking, ctx);

    expect(res.status).toBe(502);
    const telegramCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("api.telegram.org"));
    expect(telegramCall).toBeDefined();
    const alertBody = JSON.parse(telegramCall![1].body);
    expect(alertBody.text).toContain("network error"); // not "HTTP 0"

    vi.useRealTimers();
  });

  it("stops writing to KV once alerted, capping writes for the whole outage (regression: an unbounded counter could itself exhaust the daily write quota during a long outage)", async () => {
    vi.useFakeTimers();
    const { kv } = fakeKV();
    const envWithTracking: Env = {
      ...env,
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHAT_ID: "chat-id",
      FAILURE_STATE: kv,
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation((url: string) =>
          String(url).includes("api.telegram.org")
            ? Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
            : Promise.resolve(new Response("boom", { status: 500 }))
        )
    );

    // first failure starts the clock; jump well past the alert threshold so every
    // request from here on is already past it — the outage then "runs" for 10 more
    // failures with the clock never moving again
    await worker.fetch(req("/api/chores?key=test-dash-secret"), envWithTracking, ctx);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    for (let i = 0; i < 10; i++) {
      await worker.fetch(req("/api/chores?key=test-dash-secret"), envWithTracking, ctx);
    }

    // 1 put for the first-failure timestamp + 1 put for the alerted flag = 2, regardless
    // of how many more failures follow. Filtered to the failure-tracking keys
    // specifically since every request also writes a (separately throttled, separately
    // tested) heartbeat to the same KV.
    const failureTrackingPuts = kv.put.mock.calls.filter(
      ([key]) => key === "todoist:firstFailureAt" || key === "todoist:alerted"
    );
    expect(failureTrackingPuts).toHaveLength(2);

    vi.useRealTimers();
  });

  it("is a no-op when FAILURE_STATE isn't bound", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("boom", { status: 500 })));
    // env has no FAILURE_STATE — should just 502 without throwing on a missing binding.
    const res = await worker.fetch(req("/api/chores?key=test-dash-secret"), env, ctx);
    expect(res.status).toBe(502);
  });

  it("never calls KV delete on a clean run of successes (regression: this exhausted the daily delete quota in production)", async () => {
    const { kv } = fakeKV();
    const envWithTracking: Env = { ...env, FAILURE_STATE: kv };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => jsonResponse(200, { results: [], next_cursor: null }))
    );

    for (let i = 0; i < 5; i++) {
      const res = await worker.fetch(req("/api/chores?key=test-dash-secret"), envWithTracking, ctx);
      expect(res.status).toBe(200);
    }

    expect(kv.delete).not.toHaveBeenCalled();
  });

  it("a KV error while recording failure/success never turns the HTTP response into a 500", async () => {
    const kv = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => {
        throw new Error("KV put() limit exceeded for the day.");
      }),
      delete: vi.fn(async () => {
        throw new Error("KV delete() limit exceeded for the day.");
      }),
    } as unknown as KVNamespace;
    vi.spyOn(console, "error").mockImplementation(() => {});

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse(200, { results: [], next_cursor: null })));
    const okRes = await worker.fetch(req("/api/chores?key=test-dash-secret"), { ...env, FAILURE_STATE: kv }, ctx);
    expect(okRes.status).toBe(200); // recordHeartbeat's put() and recordTodoistSuccess's get()/put()/delete() all throw here — none of it should surface

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("boom", { status: 500 })));
    const failRes = await worker.fetch(req("/api/chores?key=test-dash-secret"), { ...env, FAILURE_STATE: kv }, ctx);
    expect(failRes.status).toBe(502); // still the real Todoist failure status, not masked by the KV put() failure
  });
});

describe("heartbeat (dead-tablet detection)", () => {
  const envWithTracking: Env = { ...env, TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_CHAT_ID: "chat-id" };

  it("records a heartbeat on every authenticated request", async () => {
    const { kv, store } = fakeKV();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse(200, { results: [], next_cursor: null })));

    await worker.fetch(req("/api/chores?key=test-dash-secret"), { ...env, FAILURE_STATE: kv }, ctx);

    expect(store.has("heartbeat:lastSeen")).toBe(true);
  });

  it("does not rewrite the heartbeat on every poll within the throttle window (regression: this exhausted the daily write quota in production)", async () => {
    const { kv, store } = fakeKV();
    store.set("heartbeat:lastSeen", String(Date.now() - 60 * 1000)); // 1 minute ago, well inside the 5-minute throttle window
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => jsonResponse(200, { results: [], next_cursor: null }))
    );

    for (let i = 0; i < 5; i++) {
      await worker.fetch(req("/api/chores?key=test-dash-secret"), { ...env, FAILURE_STATE: kv }, ctx);
    }

    expect(kv.put).not.toHaveBeenCalledWith("heartbeat:lastSeen", expect.anything());
  });

  it("does not record a heartbeat when auth fails", async () => {
    const { kv, store } = fakeKV();
    await worker.fetch(req("/api/chores?key=wrong"), { ...env, FAILURE_STATE: kv }, ctx);
    expect(store.has("heartbeat:lastSeen")).toBe(false);
  });

  it("does nothing if FAILURE_STATE or Telegram isn't configured", async () => {
    const { kv, store } = fakeKV();
    store.set("heartbeat:lastSeen", String(Date.now() - 60 * 60 * 1000)); // 1hr stale

    await checkHeartbeat({ ...env, FAILURE_STATE: kv }); // no Telegram configured
    expect(store.has("heartbeat:alerted")).toBe(false);
  });

  it("does nothing if there's no recorded traffic yet", async () => {
    const { kv } = fakeKV();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await checkHeartbeat({ ...envWithTracking, FAILURE_STATE: kv });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not alert while traffic is recent", async () => {
    const { kv, store } = fakeKV();
    store.set("heartbeat:lastSeen", String(Date.now() - 60 * 1000)); // 1 minute ago
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await checkHeartbeat({ ...envWithTracking, FAILURE_STATE: kv });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("doesn't call KV delete on a healthy tick when nothing was ever alerted (regression: an unconditional delete() here ran on every 15-minute cron tick)", async () => {
    const { kv, store } = fakeKV();
    store.set("heartbeat:lastSeen", String(Date.now() - 60 * 1000)); // 1 minute ago — healthy

    await checkHeartbeat({ ...envWithTracking, FAILURE_STATE: kv });

    expect(kv.delete).not.toHaveBeenCalled();
  });

  it("alerts once when traffic has gone stale, and doesn't repeat the alert", async () => {
    const { kv, store } = fakeKV();
    store.set("heartbeat:lastSeen", String(Date.now() - 45 * 60 * 1000)); // 45 minutes ago
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await checkHeartbeat({ ...envWithTracking, FAILURE_STATE: kv });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toContain("No request from the dashboard in 45 minutes");

    await checkHeartbeat({ ...envWithTracking, FAILURE_STATE: kv });
    expect(fetchMock).toHaveBeenCalledTimes(1); // still just once
  });

  it("clears the alerted flag once fresh traffic resumes", async () => {
    const { kv, store } = fakeKV();
    store.set("heartbeat:lastSeen", String(Date.now() - 45 * 60 * 1000));
    store.set("heartbeat:alerted", "1");
    vi.stubGlobal("fetch", vi.fn());

    store.set("heartbeat:lastSeen", String(Date.now())); // tablet is back
    await checkHeartbeat({ ...envWithTracking, FAILURE_STATE: kv });

    expect(store.has("heartbeat:alerted")).toBe(false);
  });
});

describe("scheduled", () => {
  function fakeCtx() {
    const promises: Promise<unknown>[] = [];
    return {
      ctx: {
        waitUntil: (p: Promise<unknown>) => {
          promises.push(p);
        },
      } as unknown as ExecutionContext,
      settle: () => Promise.all(promises),
    };
  }

  it("runs the daily digest on the digest cron", async () => {
    const envWithTelegram: Env = { ...env, TELEGRAM_BOT_TOKEN: "bot-token", TELEGRAM_CHAT_ID: "chat-id" };
    const fetchMock = vi.fn(); // digest is a no-op here since it has nothing to fetch mocked, but we can
    // still assert it took the digest path by checking it attempted a Todoist call, not a heartbeat check.
    vi.stubGlobal("fetch", fetchMock.mockResolvedValue(new Response("boom", { status: 500 })));

    const { ctx: schedCtx, settle } = fakeCtx();
    await worker.scheduled!({ cron: "0 0 * * *" } as ScheduledEvent, envWithTelegram, schedCtx);
    await settle();

    // runDailyDigest fetches active + completed tasks (2 calls) before it would ever call Telegram;
    // checkHeartbeat never calls fetch when there's no lastSeen recorded, so any call at all here
    // proves the digest path ran.
    expect(fetchMock).toHaveBeenCalled();
  });

  it("runs BOTH the rain-skip and school-skip checks on the midnight-skip cron", async () => {
    const skipEnv: Env = {
      ...env,
      RAIN_SKIP_ENABLED: "true",
      SCHOOL_SKIP_ENABLED: "true",
      ASSETS: {
        fetch: vi.fn(async () => new Response(JSON.stringify({ skipDates: [], labels: {} }), { status: 200 })),
      } as unknown as Fetcher,
    };
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        daily: { time: ["2020-01-01"], precipitation_sum: [0], precipitation_hours: [0] },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { ctx: schedCtx, settle } = fakeCtx();
    await worker.scheduled!({ cron: "15 5 * * *" } as ScheduledEvent, skipEnv, schedCtx);
    await settle();

    // rain-skip's first network call is the Open-Meteo forecast (checkHeartbeat never
    // hits it); school-skip's is the calendar asset via env.ASSETS.
    expect(String(fetchMock.mock.calls[0][0])).toContain("api.open-meteo.com");
    expect(skipEnv.ASSETS!.fetch as ReturnType<typeof vi.fn>).toHaveBeenCalled();
  });

  it("runs the heartbeat check on any other cron", async () => {
    const { kv, store } = fakeKV();
    store.set("heartbeat:lastSeen", String(Date.now() - 60 * 60 * 1000));
    const envWithTracking: Env = {
      ...env,
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHAT_ID: "chat-id",
      FAILURE_STATE: kv,
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })));

    const { ctx: schedCtx, settle } = fakeCtx();
    await worker.scheduled!({ cron: "*/15 * * * *" } as ScheduledEvent, envWithTracking, schedCtx);
    await settle();

    expect(store.has("heartbeat:alerted")).toBe(true);
  });
});
