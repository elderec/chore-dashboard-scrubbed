export interface TodoistDue {
  /** "YYYY-MM-DD" for a date-only due date, or an RFC3339-ish local datetime
   * (no offset) like "2026-08-22T09:00:00" when a specific time is set. */
  date: string;
  is_recurring: boolean;
  string: string;
  /** IANA zone the time is anchored to, or null for a date-only due date or a
   * "floating" time that follows the account's own timezone. */
  timezone: string | null;
}

export interface TodoistTask {
  id: string;
  content: string;
  project_id: string;
  labels: string[];
  due: TodoistDue | null;
  priority: number;
}

interface TodoistTaskListResponse {
  results: TodoistTask[];
  next_cursor: string | null;
}

const API_BASE = "https://api.todoist.com/api/v1";
const REQUEST_TIMEOUT_MS = 10_000;

class TodoistApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Raw response body (e.g. Todoist's `{"error_tag":"INVALID_DATE",...}` JSON), or "" if none. */
    public body: string = ""
  ) {
    super(message);
  }
}

/** Thrown as a TodoistApiError (status 408 for a timeout, 0 for any other fetch-level
 * failure — DNS, connection reset, etc.), never left as a raw error, so every kind of
 * Todoist-unreachable failure flows through the same withTodoistFailureTracking/
 * recordTodoistFailure path in index.ts as a bad HTTP response does — it counts toward
 * the consecutive-failure alert and returns 502 rather than hanging the request,
 * surfacing as a generic "Unexpected error" 500, or (before this) silently bypassing
 * the alert entirely because withTodoistFailureTracking's `instanceof TodoistApiError`
 * check never saw it. Status 0 is a conventional "no HTTP response was ever received"
 * sentinel, distinct from any real status Todoist itself could return. */
async function todoistFetch(token: string, path: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...init?.headers,
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new TodoistApiError(408, `Todoist ${path} timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw new TodoistApiError(0, `Todoist ${path} failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new TodoistApiError(res.status, `Todoist ${path} failed: ${res.status} ${body}`, body);
  }
  return res;
}

export async function getProjectTasks(token: string, projectId: string): Promise<TodoistTask[]> {
  const tasks: TodoistTask[] = [];
  let cursor: string | null = null;

  do {
    const qs = new URLSearchParams({ project_id: projectId });
    if (cursor) qs.set("cursor", cursor);
    const res = await todoistFetch(token, `/tasks?${qs.toString()}`);
    const page: TodoistTaskListResponse = await res.json();
    tasks.push(...page.results);
    cursor = page.next_cursor;
  } while (cursor);

  return tasks;
}

export async function getTask(token: string, id: string): Promise<TodoistTask> {
  const res = await todoistFetch(token, `/tasks/${encodeURIComponent(id)}`);
  return res.json();
}

export async function closeTask(token: string, id: string): Promise<void> {
  await todoistFetch(token, `/tasks/${encodeURIComponent(id)}/close`, { method: "POST" });
}

export async function reopenTask(token: string, id: string): Promise<void> {
  await todoistFetch(token, `/tasks/${encodeURIComponent(id)}/reopen`, { method: "POST" });
}

/** Moves a recurring task's due date to dueDate while keeping its recurrence rule.
 * Counterintuitively, the API's own due_date field is NOT the way to do this — setting
 * it strips recurrence entirely (confirmed directly against the real API; is_recurring
 * comes back false and due.string becomes just the date). due_string isn't safe either
 * on its own: re-parsed as natural language, "today" would just as easily wipe the
 * rule. The one combination that reliably works is reconstructing the *original*
 * recurrence phrase anchored with "starting <date>" (e.g. "every other day starting
 * 2026-08-23") — Todoist correctly re-derives both the date and the plain recurrence
 * string from that. recurrenceString should be the task's own due.string from before
 * this call (e.g. from a prior getTask/getOwnedTask) — not a caller-invented phrase.
 *
 * The anchor must be date-only (YYYY-MM-DD), even when dueDate is a full naive
 * datetime like "2026-08-24T16:00:00" (a timed recurrence, e.g. "every day at 4pm") —
 * confirmed directly against the real API: "starting <full datetime>" is rejected
 * outright (400 "Invalid date format"). This isn't a loss of precision: the time of
 * day is already fully encoded in recurrenceString itself, so anchoring just the date
 * and letting Todoist combine it with that phrase reconstructs the exact original
 * datetime — e.g. "every day at 4pm starting 2026-08-24" correctly comes back as
 * due.date "2026-08-24T16:00:00". */
export async function rescheduleRecurringTask(
  token: string,
  id: string,
  recurrenceString: string,
  dueDate: string
): Promise<void> {
  const anchorDate = dueDate.slice(0, 10);
  await todoistFetch(token, `/tasks/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ due_string: `${recurrenceString} starting ${anchorDate}` }),
  });
}

export { TodoistApiError };
