import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getProjectTasks,
  getTask,
  closeTask,
  reopenTask,
  rescheduleRecurringTask,
  TodoistApiError,
} from "../src/todoist";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("getProjectTasks", () => {
  it("pages through cursor-based results and concatenates them", async () => {
    const page1 = { results: [{ id: "1" }], next_cursor: "abc" };
    const page2 = { results: [{ id: "2" }], next_cursor: null };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, page1))
      .mockResolvedValueOnce(jsonResponse(200, page2));
    vi.stubGlobal("fetch", fetchMock);

    const tasks = await getProjectTasks("tok", "proj1");

    expect(tasks.map((t) => t.id)).toEqual(["1", "2"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain("project_id=proj1");
    expect(String(fetchMock.mock.calls[1][0])).toContain("cursor=abc");
  });

  it("stops after a single page when next_cursor is null", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { results: [], next_cursor: null }));
    vi.stubGlobal("fetch", fetchMock);

    await getProjectTasks("tok", "proj1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("getTask", () => {
  it("returns the raw task object", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse(200, { id: "1", project_id: "proj1" })));
    const task = await getTask("tok", "1");
    expect(task).toEqual({ id: "1", project_id: "proj1" });
  });

  it("throws a TodoistApiError on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("nope", { status: 404 })));
    await expect(getTask("tok", "1")).rejects.toBeInstanceOf(TodoistApiError);
  });

  it("throws a TodoistApiError instead of hanging when Todoist never responds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = getTask("tok", "1");
    const assertion = expect(resultPromise).rejects.toBeInstanceOf(TodoistApiError);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    await expect(resultPromise).rejects.toMatchObject({ status: 408 });

    vi.useRealTimers();
  });
});

describe("todoistFetch (via getTask)", () => {
  it("wraps a raw network-level failure (not a bad status or a timeout) as a TodoistApiError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("network connection lost")));
    const resultPromise = getTask("tok", "1");
    await expect(resultPromise).rejects.toBeInstanceOf(TodoistApiError);
    // status 0 — distinct from any real HTTP status — is what
    // withTodoistFailureTracking's `instanceof TodoistApiError` check relies on to
    // count this toward the consecutive-failure alert; before this wrapping, a raw
    // network error would bypass that check entirely.
    await expect(resultPromise).rejects.toMatchObject({ status: 0 });
  });
});

describe("closeTask / reopenTask", () => {
  it("POSTs to the close endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await closeTask("tok", "42");

    expect(String(fetchMock.mock.calls[0][0])).toContain("/tasks/42/close");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST" });
  });

  it("POSTs to the reopen endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await reopenTask("tok", "42");

    expect(String(fetchMock.mock.calls[0][0])).toContain("/tasks/42/reopen");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST" });
  });

  it("throws on failure so callers don't silently treat it as success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("nope", { status: 500 })));
    await expect(closeTask("tok", "42")).rejects.toBeInstanceOf(TodoistApiError);
  });
});

describe("rescheduleRecurringTask", () => {
  it("POSTs due_string as '<recurrence> starting <date>' — NOT due_date, which strips recurrence", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await rescheduleRecurringTask("tok", "42", "every other day", "2026-08-23");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/tasks/42");
    expect(String(url)).not.toContain("/reopen");
    expect(String(url)).not.toContain("/close");
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse(init.body)).toEqual({ due_string: "every other day starting 2026-08-23" });
    expect(JSON.parse(init.body)).not.toHaveProperty("due_date");
  });

  it("truncates a full datetime dueDate to just the date for the anchor (timed recurrence, e.g. 'every day at 4pm') — the real API rejects 'starting <full datetime>' outright", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await rescheduleRecurringTask("tok", "42", "every day at 4pm", "2026-08-24T16:00:00");

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ due_string: "every day at 4pm starting 2026-08-24" });
  });

  it("throws on failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("nope", { status: 500 })));
    await expect(rescheduleRecurringTask("tok", "42", "every day", "2026-08-23")).rejects.toBeInstanceOf(
      TodoistApiError
    );
  });
});
