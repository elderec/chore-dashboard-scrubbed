import {
  getProjectTasks,
  getTask,
  closeTask,
  reopenTask,
  rescheduleRecurringTask,
  TodoistApiError,
  type TodoistTask,
} from "./todoist";
import {
  daysOverdue,
  isDueTodayOrOverdue,
  isOverdue,
  todayInTimeZone,
  hourInTimeZone,
  dueTimeMinutes,
} from "./overdue";
import { sendTelegramMessage } from "./telegram";
import { getDailyForecast } from "./weather";
import { loadSchoolCalendar, type SchoolCalendar } from "./schoolcalendar";

export interface Env {
  TODOIST_TOKEN: string;
  DASH_SECRET: string;
  KIDS_PROJECT_ID: string;
  /** "Name:#hexcolor,Name:#hexcolor,..." — see parseKids(). */
  KIDS: string;
  /** "HH:MM" (24h, in TIMEZONE) — the single boundary between the Day and Evening
   * tabs: Day is [00:00, this), Evening is [this, 24:00). See parseEveningStartsAt()
   * — sent to the frontend as eveningStartsAtMinutes so public/app.js builds its
   * tab labels/filter from this instead of a hardcoded value. */
  EVENING_STARTS_AT: string;
  /** Optional: unset means Telegram notifications (completions, digest, alerts) are skipped. */
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  /** Optional: unset means consecutive-Todoist-failure alerting is skipped. */
  FAILURE_STATE?: KVNamespace;
  /** "true"/"false" strings — see parseFullyKioskConfig(). All optional; every
   * one of these defaults to "false"/a safe value if unset — see wrangler.toml's
   * own comments for what each controls. 100% frontend behavior: nothing
   * server-side branches on these, they're threaded through purely so
   * public/app.js has one config source (the API response) instead of
   * hardcoded constants, same reasoning as EVENING_STARTS_AT. */
  USE_FULLY_KIOSK?: string;
  FULLY_BRIGHTNESS_ENABLED?: string;
  FULLY_DAY_BRIGHTNESS?: string;
  FULLY_NIGHT_BRIGHTNESS?: string;
  FULLY_DAY_KEEPAWAKE_ENABLED?: string;
  FULLY_NIGHT_SCHEDULE_ENABLED?: string;
  FULLY_NIGHT_SCREEN_OFF_AT?: string;
  FULLY_NIGHT_SCREEN_ON_AT?: string;
  FULLY_MOTION_WAKE_GRACE_MINUTES?: string;
  /** Optional — defaults to New York, NY (40.7128, -74.006) if unset. Decimal
   * degrees; see parseWeatherLocation(). Was previously a hardcoded pair of
   * constants in public/app.js — moved into wrangler.toml so no config is split
   * across two files. */
  WEATHER_LAT?: string;
  WEATHER_LON?: string;
  /** Auto chore skipping (optional, all off by default) — a just-after-midnight
   * cron closes chores that don't need doing on a given day: rain-aware (a wet-
   * enough forecast) and calendar-aware (a school no-school day). All
   * "true"/"false"/number strings with safe defaults, same trust level as the
   * FULLY_* vars. Unlike those, these DO drive server-side behavior (closing
   * Todoist tasks), so they're not threaded through /api/chores. See
   * parseRainSkipConfig()/parseSchoolSkipConfig()/runAutoSkip() and the
   * SCHOOL_SKIP_* / SNOW_REMINDER_* entries in wrangler.toml. */
  RAIN_SKIP_ENABLED?: string;
  /** Comma-separated, case-insensitive title substrings — a chore matching any is eligible. */
  RAIN_SKIP_MATCH?: string;
  RAIN_SKIP_MIN_HOURS?: string;
  RAIN_SKIP_MIN_MM?: string;
  RAIN_SKIP_COUNTS_AS_DONE?: string;
  /** Calendar-aware skipping. SCHOOL_SKIP_LABEL is the Todoist label marking a
   * chore school-day-only; the no-school dates come from public/school-calendar.json
   * (or SCHOOL_SKIP_CALENDAR_URL if set) unioned with the runtime manual flag
   * (school:skip:manual in FAILURE_STATE, set via POST /api/school-skip/today). */
  SCHOOL_SKIP_ENABLED?: string;
  SCHOOL_SKIP_LABEL?: string;
  SCHOOL_SKIP_COUNTS_AS_DONE?: string;
  SCHOOL_SKIP_CALENDAR_URL?: string;
  /** Local hour (0–23) the deferred rain/school skip Telegram notice may first send at. */
  SKIP_NOTIFY_HOUR?: string;
  /** Weather-triggered snow-day nudge (optional). On a would-be school day whose
   * forecast turns wintry, one Telegram reminder to flag it manually — it never
   * skips anything on its own. */
  SNOW_REMINDER_ENABLED?: string;
  SNOW_REMINDER_HOUR?: string;
  SNOW_REMINDER_MIN_CM?: string;
  /** Static-asset binding (public/), used to read school-calendar.json server-side. */
  ASSETS?: Fetcher;
  /** Optional: unset means avatar photos are unavailable and every kid shows
   * the colored-initial fallback (see buildAvatar() in public/app.js). One photo
   * per kid, object key === `${kid.key}.jpg` or `${kid.key}.png` (handleGetAvatar()
   * tries .jpg first, then .png). Safe to use the real kid name as the object key
   * here — unlike a public/ static file, this is served through an authenticated
   * route (GET /api/avatars/:kidKey), gated by the same ?key=DASH_SECRET check as
   * everything else, so there's no reason to obscure the filename the way a bare
   * static file would need. */
  AVATARS?: R2Bucket;
}

const TIMEZONE = "America/New_York";

/** Must match the digest entry in wrangler.toml's [triggers].crons. */
const DIGEST_CRON = "0 0 * * *";

/** Must match the auto-skip entry in wrangler.toml's [triggers].crons. Fires just
 * after local midnight (00:15 EST / 01:15 EDT — always the same calendar day
 * year-round despite being a fixed UTC hour) so a skipped chore is already
 * cleared before anyone looks at the board. Runs both the rain-aware and the
 * calendar-aware (no-school) skip. Any cron string that's neither this nor
 * DIGEST_CRON falls through to the heartbeat check in `scheduled`. */
const MIDNIGHT_SKIP_CRON = "15 5 * * *";

interface Kid {
  /** Exact Todoist label this kid is tagged with. */
  name: string;
  /** Lowercased, used as the grouping/routing key everywhere (JSON keys, digest lines). */
  key: string;
  /** CSS color, e.g. "#4d9bff" — set directly as the frontend column's --kid-color. */
  color: string;
}

/** Parses the KIDS var ("Alex:#4d9bff,Sam:#4dd68a,Taylor:#ffb14d") into the kid list
 * that drives every kid-specific grouping/label/color in the app — the single
 * config point that makes this deployable for any set of kids, not just a fixed
 * set of three. No defensive validation beyond what .split/.trim give for free;
 * this is a deploy-time config value only the person running `wrangler deploy`
 * touches, same trust level as KIDS_PROJECT_ID. */
function parseKids(env: Env): Kid[] {
  return env.KIDS.split(",").map((entry) => {
    const [name, color] = entry.split(":").map((s) => s.trim());
    return { name, key: name.toLowerCase(), color };
  });
}

/** Parses EVENING_STARTS_AT ("HH:MM") into minutes since midnight — the single
 * config point for the Day/Evening tab split. Same trust level as parseKids: a
 * deploy-time value, no defensive validation beyond what a plain split/Number
 * gives for free. */
function parseEveningStartsAt(env: Env): number {
  const [hours, minutes] = env.EVENING_STARTS_AT.split(":").map(Number);
  return hours * 60 + minutes;
}

interface FullyKioskConfig {
  enabled: boolean;
  brightnessEnabled: boolean;
  dayBrightness: number;
  nightBrightness: number;
  dayKeepawakeEnabled: boolean;
  nightScheduleEnabled: boolean;
  /** "HH:MM" — left as a string; public/app.js parses it the same way
   * EVENING_STARTS_AT is parsed server-side today. */
  nightScreenOffAt: string;
  nightScreenOnAt: string;
  motionWakeGraceMinutes: number;
}

/** All-optional-vars parsing, same trust level as parseKids/parseEveningStartsAt
 * — every field defaults safely so an unset var (e.g. a fresh deploy before
 * these are configured at all) yields "everything off" rather than a throw. */
function parseFullyKioskConfig(env: Env): FullyKioskConfig {
  return {
    enabled: env.USE_FULLY_KIOSK === "true",
    brightnessEnabled: env.FULLY_BRIGHTNESS_ENABLED === "true",
    dayBrightness: Number(env.FULLY_DAY_BRIGHTNESS ?? "100"),
    nightBrightness: Number(env.FULLY_NIGHT_BRIGHTNESS ?? "30"),
    dayKeepawakeEnabled: env.FULLY_DAY_KEEPAWAKE_ENABLED === "true",
    nightScheduleEnabled: env.FULLY_NIGHT_SCHEDULE_ENABLED === "true",
    nightScreenOffAt: env.FULLY_NIGHT_SCREEN_OFF_AT ?? "23:00",
    nightScreenOnAt: env.FULLY_NIGHT_SCREEN_ON_AT ?? "05:00",
    motionWakeGraceMinutes: Number(env.FULLY_MOTION_WAKE_GRACE_MINUTES ?? "2"),
  };
}

/** Same all-optional-vars pattern — defaults reproduce the location that used
 * to be hardcoded in public/app.js, so an unset var is a true no-op. */
function parseWeatherLocation(env: Env): { lat: number; lon: number } {
  return {
    lat: Number(env.WEATHER_LAT ?? "40.7128"),
    lon: Number(env.WEATHER_LON ?? "-74.006"),
  };
}

/** Local hour (0–23) the deferred rain/school skip Telegram notice may first send at. */
function skipNotifyHour(env: Env): number {
  return Number(env.SKIP_NOTIFY_HOUR ?? "9");
}

interface RainSkipConfig {
  enabled: boolean;
  /** Lowercased substrings from RAIN_SKIP_MATCH (comma-separated). A chore is
   * eligible if its lowercased title contains ANY of these — see titleMatchesRainSkip(). */
  matches: string[];
  /** Forecast precipitation_hours must be strictly greater than this. */
  minHours: number;
  /** Forecast precipitation_sum (mm) must be at least this. */
  minMm: number;
  /** Whether an auto-closed chore also counts toward the nightly digest's "done" tally. */
  countsAsDone: boolean;
}

const DEFAULT_RAIN_SKIP_MATCH = "Water the Yard";

/** Same all-optional-vars pattern as parseFullyKioskConfig — every field defaults
 * safely, so an unset RAIN_SKIP_ENABLED yields enabled:false and the whole
 * feature (cron + deferred notice + digest line) is a no-op. RAIN_SKIP_MATCH is
 * a comma-separated list ("Water the back yard, Water the front yard"); each
 * entry is trimmed and lowercased for case-insensitive substring matching. */
function parseRainSkipConfig(env: Env): RainSkipConfig {
  return {
    enabled: env.RAIN_SKIP_ENABLED === "true",
    matches: (env.RAIN_SKIP_MATCH ?? DEFAULT_RAIN_SKIP_MATCH)
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    minHours: Number(env.RAIN_SKIP_MIN_HOURS ?? "6"),
    minMm: Number(env.RAIN_SKIP_MIN_MM ?? "5"),
    countsAsDone: (env.RAIN_SKIP_COUNTS_AS_DONE ?? "true") === "true",
  };
}

/** True if `title` (case-insensitively) contains any of the configured
 * substrings. An empty `matches` (RAIN_SKIP_MATCH set to only commas/whitespace)
 * matches nothing rather than everything. */
function titleMatchesRainSkip(title: string, matches: string[]): boolean {
  const lower = title.toLowerCase();
  return matches.some((m) => lower.includes(m));
}

interface SchoolSkipConfig {
  enabled: boolean;
  /** Todoist label marking a chore as school-day-only (default "school-day"). */
  label: string;
  countsAsDone: boolean;
}

function parseSchoolSkipConfig(env: Env): SchoolSkipConfig {
  return {
    enabled: env.SCHOOL_SKIP_ENABLED === "true",
    label: env.SCHOOL_SKIP_LABEL ?? "school-day",
    // A holiday isn't an accomplishment — opposite default from rain.
    countsAsDone: env.SCHOOL_SKIP_COUNTS_AS_DONE === "true",
  };
}

interface ChoreDTO {
  id: string;
  title: string;
  due: string | null;
  recurrence: string | null;
  isOverdue: boolean;
  /** Whole calendar days past due (0 if not overdue, or only late today) — shown on
   * the card's badge as "N DAYS OVERDUE". See daysOverdue() in overdue.ts. */
  overdueDays: number;
  /** Minutes since local midnight the chore is due at, or null if it's a
   * date-only due date with no time — see dueTimeMinutes() in overdue.ts. Used
   * client-side for the Day/Evening tab filter; a null value shows in both. */
  dueTimeMinutes: number | null;
  /** Set only on a non-overdue chore whose title matches another kid's currently
   * overdue chore — see computeHandoffNote()'s own comment for why this can
   * happen and why it's display-only. Null otherwise. */
  handoffNote: string | null;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Constant-time comparison so a leaked/guessed-at DASH_SECRET can't be brute-forced
 * faster by timing how quickly each guess is rejected — a plain === short-circuits on
 * the first mismatched byte, which leaks a correct prefix one character at a time.
 * The loop always runs exactly secretValue's length regardless of userValue's length
 * (a mismatch there is folded into `diff` up front, not returned early), so timing
 * depends only on the secret's own fixed length, never on attacker-supplied input.
 * Hand-rolled rather than Workers' non-standard crypto.subtle.timingSafeEqual
 * extension — that method doesn't exist in the plain Node environment this project's
 * tests run in, and pulling in the real Workers test runtime just for this would be a
 * disproportionate infrastructure change; this portable version needs neither. */
function timingSafeEqual(userValue: string, secretValue: string): boolean {
  const encoder = new TextEncoder();
  const userBytes = encoder.encode(userValue);
  const secretBytes = encoder.encode(secretValue);

  let diff = userBytes.length === secretBytes.length ? 0 : 1;
  for (let i = 0; i < secretBytes.length; i++) {
    diff |= (userBytes[i] ?? 0) ^ secretBytes[i];
  }
  return diff === 0;
}

function checkAuth(request: Request, env: Env): boolean {
  if (!env.DASH_SECRET) return false;
  const key = new URL(request.url).searchParams.get("key") ?? "";
  return timingSafeEqual(key, env.DASH_SECRET);
}

function kidNamesOnTask(task: TodoistTask, kids: Kid[]): string[] {
  const names = new Set(kids.map((k) => k.name));
  return task.labels.filter((l) => names.has(l));
}

/** Groups tasks due today or overdue by kid label. Shared between the live
 * /api/chores response and the nightly digest's "still open" counts. */
function activeChoresByKid(tasks: TodoistTask[], now: Date, kids: Kid[]): Record<string, TodoistTask[]> {
  const groups: Record<string, TodoistTask[]> = { unlabeled: [] };
  for (const kid of kids) groups[kid.key] = [];

  for (const task of tasks) {
    if (!isDueTodayOrOverdue(task.due, now, TIMEZONE)) continue;

    const kidLabels = kidNamesOnTask(task, kids);
    if (kidLabels.length === 0) {
      groups.unlabeled.push(task);
    } else {
      for (const label of kidLabels) {
        groups[label.toLowerCase()].push(task);
      }
    }
  }

  return groups;
}

/** Case/whitespace-insensitive key for matching chore titles across kids —
 * used only by the handoff-note detection below, kept separate from the
 * verbatim `title` every DTO still displays. */
function normalizeTitle(title: string): string {
  return title.trim().toLowerCase();
}

/** Detects the rotation-handoff gap documented in the README's "Rotating a
 * chore between kids" section: alternating a chore between kids is two
 * separate same-titled Todoist tasks with staggered due dates, not one
 * shared task — so each advances only on its own completion, independent of
 * its sibling. If a kid never finishes theirs, it just stays overdue forever
 * while the next kid's task comes due on its own schedule regardless, and
 * both columns end up showing the identical title with nothing linking them.
 *
 * This is display-only (confirmed choice: leave Todoist alone, just explain
 * the overlap) — it never touches Todoist, and it doesn't affect either
 * kid's streak (recordDailyCleanStatus already looks at each kid's own open
 * tasks, so accountability was never the gap here, just on-screen clarity).
 * A note is attached only to the NON-overdue sibling, naming who's behind —
 * the overdue one already reads as overdue on its own. Matching by title
 * rather than task id also means it naturally skips a genuinely shared chore
 * (one task, multiple kid labels): that's a single task, so it can never be
 * its own "other" overdue sibling. */
function computeHandoffNote(
  title: string,
  kidKey: string,
  isOverdue: boolean,
  overdueKidsByTitle: Map<string, string[]>,
  kids: Kid[]
): string | null {
  if (isOverdue) return null;
  const kidName = kids.find((k) => k.key === kidKey)?.name;
  const overdueNames = (overdueKidsByTitle.get(normalizeTitle(title)) ?? []).filter((n) => n !== kidName);
  if (overdueNames.length === 0) return null;
  const verb = overdueNames.length === 1 ? "hasn't" : "haven't";
  return `${joinNames(overdueNames)} ${verb} finished this yet`;
}

async function handleGetChores(env: Env): Promise<Response> {
  const kids = parseKids(env);
  const tasks = await getProjectTasks(env.TODOIST_TOKEN, env.KIDS_PROJECT_ID);
  const now = new Date();
  const byKid = activeChoresByKid(tasks, now, kids);

  // Pre-pass: which kids currently have an overdue chore under each title —
  // feeds computeHandoffNote() below. Keyed on kids only ("unlabeled" chores
  // aren't attributed to anyone, so they can't be a rotation handoff).
  const overdueKidsByTitle = new Map<string, string[]>();
  for (const kid of kids) {
    for (const task of byKid[kid.key]) {
      if (isOverdue(task.due, now, TIMEZONE)) {
        const title = normalizeTitle(task.content);
        const names = overdueKidsByTitle.get(title) ?? [];
        names.push(kid.name);
        overdueKidsByTitle.set(title, names);
      }
    }
  }

  const groups: Record<string, ChoreDTO[]> = {};
  for (const key of Object.keys(byKid)) {
    groups[key] = byKid[key].map((task) => {
      const overdue = isOverdue(task.due, now, TIMEZONE);
      return {
        id: task.id,
        title: task.content,
        due: task.due?.date ?? null,
        recurrence: task.due?.is_recurring ? task.due.string : null,
        isOverdue: overdue,
        overdueDays: overdue ? daysOverdue(task.due, now, TIMEZONE) : 0,
        dueTimeMinutes: dueTimeMinutes(task.due, TIMEZONE),
        handoffNote: computeHandoffNote(task.content, key, overdue, overdueKidsByTitle, kids),
      };
    });
  }

  // Independent per-kid KV reads — run them concurrently rather than one at a
  // time, since each kid's streak has no dependency on any other's.
  const streakEntries = await Promise.all(
    kids.map(async (kid) => [kid.key, await getKidStreak(env, kid.key)] as const)
  );
  const streaks: Record<string, KidStreak> = Object.fromEntries(streakEntries);

  return jsonResponse({
    kids,
    groups,
    streaks,
    generatedAt: now.toISOString(),
    eveningStartsAtMinutes: parseEveningStartsAt(env),
    fullyKiosk: parseFullyKioskConfig(env),
    weather: parseWeatherLocation(env),
  });
}

/** kidKey is the lowercased kid name (Kid.key), not to be confused with the
 * `?key=` DASH_SECRET query param checked by checkAuth() before this route is
 * ever reached. Degrades to 404 if AVATARS is unbound or this kid has no
 * photo yet — same optional-infra pattern as FAILURE_STATE elsewhere in this
 * file; public/app.js's buildAvatar() already treats a failed image load as
 * "show the colored-initial fallback", so a plain 404 is all this needs to
 * return, no special-cased response body. Tries `.jpg` then `.png` — a kid's
 * photo can be uploaded as either. The content-type fallback (used only if
 * the object was stored with no explicit one) is keyed off whichever
 * extension actually matched, not a single hardcoded guess — a PNG object
 * with no stored content-type must not be served as image/jpeg. */
async function handleGetAvatar(env: Env, kidKey: string): Promise<Response> {
  if (!env.AVATARS) return jsonResponse({ error: "Not found" }, 404);
  let object = await env.AVATARS.get(`${kidKey}.jpg`);
  let fallbackContentType = "image/jpeg";
  if (!object) {
    object = await env.AVATARS.get(`${kidKey}.png`);
    fallbackContentType = "image/png";
  }
  if (!object) return jsonResponse({ error: "Not found" }, 404);
  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? fallbackContentType,
      "cache-control": "private, max-age=3600",
    },
  });
}

async function getOwnedTask(env: Env, taskId: string): Promise<{ task: TodoistTask } | { forbidden: Response }> {
  const task = await getTask(env.TODOIST_TOKEN, taskId);
  if (task.project_id !== env.KIDS_PROJECT_ID) {
    return { forbidden: jsonResponse({ error: "Forbidden: task is outside the chore chart project" }, 403) };
  }
  return { task };
}

/** "a" / "a & b" / "a, b & c" — "" for an empty list. */
function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} & ${items[items.length - 1]}`;
}

function joinNames(names: string[]): string {
  return joinList(names) || "Someone";
}

/** joinList over the items double-quoted and de-duplicated, keeping first-seen
 * order — for naming a set of chore titles in a Telegram/digest line. */
function joinQuotedUnique(items: string[]): string {
  return joinList([...new Set(items)].map((s) => `"${s}"`));
}

/** Best-effort notification — a Telegram failure must never turn an already-successful
 * Todoist write into an error response, so callers just fire this and move on. */
async function notifyTelegram(env: Env, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, text);
  } catch (err) {
    console.error("Telegram notification failed", err);
  }
}

const DIGEST_COMPLETION_TTL_SECONDS = 3 * 24 * 60 * 60; // a few days is plenty for a nightly digest; keeps KV from accumulating date-keyed entries forever

function digestCompletionKey(kidKey: string): string {
  return `digest:done:${todayInTimeZone(new Date(), TIMEZONE)}:${kidKey}`;
}

/** Long enough to outlive the same day's nightly digest, which reads a skip
 * record for its "🌧️ rainy day" / "🏫 no-school day" line — the digest runs ≤
 * ~20h after the 00:15 cron writes it. Date-keyed with a TTL, the same
 * KV-growth-bounding shape as digest completions (not an unbounded pattern). */
const SKIP_STATE_TTL_SECONDS = 2 * 24 * 60 * 60;

type SkipKind = "rain" | "school";

interface SkipState {
  /** Task ids the skip cron closed today. */
  closedTaskIds: string[];
  /** Titles of those tasks (dupes possible — same chore for two kids), for the
   * notice + digest line. Optional: a record from an older build won't have it,
   * and the readers fall back to a count. */
  closedTitles?: string[];
  /** Lowercased kid keys those tasks were labelled with — for the notice + digest line. */
  kidKeys: string[];
  /** Kind-specific context for the wording: rain → "forecast ~8h, 12mm today";
   * school → the occasion ("Veterans Day"), or "" for a plain no-school day. */
  detail: string;
  /** Flipped true once the deferred (~SKIP_NOTIFY_HOUR) Telegram notice has sent. */
  notified: boolean;
}

/** `rain:skip:<date>` unchanged from before the school-skip split — no migration. */
function skipStateKey(kind: SkipKind, dateStr: string): string {
  return `${kind}:skip:${dateStr}`;
}

/** Names the chores a skip record closed — their (de-duplicated, quoted) titles
 * if the record carries them, otherwise a bare count (a record written by a
 * build predating closedTitles, still readable within its 2-day TTL). */
function describeSkipChores(state: SkipState): string {
  const titles = state.closedTitles ?? [];
  if (titles.length > 0) return joinQuotedUnique(titles);
  const n = state.closedTaskIds.length;
  return `${n} chore${n === 1 ? "" : "s"}`;
}

function skipNoticeLine(kind: SkipKind, state: SkipState, names: string[]): string {
  const chores = describeSkipChores(state);
  const who = joinNames(names);
  if (kind === "rain") {
    return `🌧️ Rain skip — auto-completed ${chores} for ${who} (${state.detail}).`;
  }
  return `🏫 ${state.detail || "No-school day"} — auto-cleared ${chores} for ${who} (no school today).`;
}

function skipDigestLine(kind: SkipKind, state: SkipState, names: string[]): string {
  const chores = describeSkipChores(state);
  const who = joinNames(names);
  if (kind === "rain") {
    return `🌧️ Rainy day — ${chores} auto-skipped for ${who}.`;
  }
  return `🏫 ${state.detail || "No-school day"} — ${chores} auto-skipped for ${who}.`;
}

/** How many days of clean/not-clean history each kid's streak record keeps — also
 * the effective cap on the reported streak count itself (a kid clean for 40 days
 * straight still reports 7, since day 8-back was trimmed off). One rolling key per
 * kid rather than one key per kid per day, deliberately: after the KV-quota outage
 * earlier in this project's life (see recordTodoistSuccess/recordHeartbeat), a
 * design that adds a new key every single day forever is exactly the shape of bug
 * to avoid — this one is a fixed 3 keys total, ever, regardless of how long the
 * dashboard runs. */
const STREAK_HISTORY_DAYS = 7;

interface StreakDay {
  date: string; // YYYY-MM-DD in TIMEZONE
  clean: boolean; // true if every chore due that day (or none at all) was done by digest time
}

interface KidStreak {
  /** Consecutive clean days trailing the most recent recorded day (today included,
   * if the digest has already run today) — capped at STREAK_HISTORY_DAYS. */
  streak: number;
  /** Up to STREAK_HISTORY_DAYS previous days, oldest first, *excluding* today —
   * today is deliberately never in here even if the digest already ran, so the
   * frontend can always render "today" as its own live/in-progress dot rather than
   * reconciling it against a resolved history entry. */
  history: boolean[];
}

function streakKey(kidKey: string): string {
  return `streak:${kidKey}`;
}

/** Appends today's clean/not-clean result to a kid's rolling streak record and
 * trims it back to STREAK_HISTORY_DAYS — called once a night from runDailyDigest,
 * right where "was anything left open" is already known. Same optional-infra,
 * never-throw pattern as recordDigestCompletion: a streak is a nice-to-have, not
 * something that should ever turn a digest run into an error. */
async function recordDailyCleanStatus(env: Env, kidKey: string, clean: boolean): Promise<void> {
  if (!env.FAILURE_STATE) return;
  try {
    const key = streakKey(kidKey);
    const days = JSON.parse((await env.FAILURE_STATE.get(key)) ?? "[]") as StreakDay[];
    const today = todayInTimeZone(new Date(), TIMEZONE);
    const withoutToday = days.filter((d) => d.date !== today); // guards against the cron ever firing twice in one day
    withoutToday.push({ date: today, clean });
    await env.FAILURE_STATE.put(key, JSON.stringify(withoutToday.slice(-STREAK_HISTORY_DAYS)));
  } catch (err) {
    console.error("Failed to record daily clean status", err);
  }
}

/** Reads a kid's rolling streak record back into the shape the frontend wants. See
 * KidStreak's doc comments for why "today" is always excluded from history and why
 * the streak count is capped at STREAK_HISTORY_DAYS. Degrades to {streak: 0,
 * history: []} on any error/missing data/unbound KV, same as any other optional
 * KV-backed feature in this file — a streak that can't be read is just not shown,
 * never a broken /api/chores response. */
async function getKidStreak(env: Env, kidKey: string): Promise<KidStreak> {
  if (!env.FAILURE_STATE) return { streak: 0, history: [] };
  try {
    const raw = await env.FAILURE_STATE.get(streakKey(kidKey));
    const days = JSON.parse(raw ?? "[]") as StreakDay[];

    let streak = 0;
    for (let i = days.length - 1; i >= 0 && days[i].clean; i--) streak++;

    const today = todayInTimeZone(new Date(), TIMEZONE);
    const history = days.filter((d) => d.date !== today).map((d) => d.clean);

    return { streak, history };
  } catch (err) {
    console.error("Failed to read streak", err);
    return { streak: 0, history: [] };
  }
}

/** The nightly digest's "done today" count can't come from Todoist's own
 * completed-tasks-by-date endpoint: completing a RECURRING task (nearly every
 * chore here) reschedules it instead of ever marking it "completed" in Todoist's
 * completed-tasks list — confirmed directly against the API, that list stays
 * permanently empty for this project regardless of real activity, which is
 * exactly why the digest was reporting 0 done for everyone every night. Instead,
 * this app tracks its own completions, since it already knows precisely when one
 * happens (right here, alongside the existing Telegram notification). Stored as
 * a per-kid, per-day list of task ids — not just a count — so undoDigestCompletion
 * can precisely remove one entry on a same-day undo without needing a separate
 * atomic-decrement mechanism. */
async function recordDigestCompletion(env: Env, taskId: string, kidKeys: string[]): Promise<void> {
  if (!env.FAILURE_STATE) return;
  try {
    for (const kidKey of kidKeys) {
      const key = digestCompletionKey(kidKey);
      const done = JSON.parse((await env.FAILURE_STATE.get(key)) ?? "[]") as string[];
      if (!done.includes(taskId)) {
        done.push(taskId);
        await env.FAILURE_STATE.put(key, JSON.stringify(done), { expirationTtl: DIGEST_COMPLETION_TTL_SECONDS });
      }
    }
  } catch (err) {
    console.error("Failed to record digest completion", err);
  }
}

/** Undoes recordDigestCompletion — a no-op if the task wasn't recorded as
 * completed earlier today (e.g. it was completed on an earlier day, whose
 * digest-tracking entry has either expired or never included this id), which is
 * exactly the right behavior: only a same-day mis-tap-and-undo should uncount it. */
async function undoDigestCompletion(env: Env, taskId: string, kidKeys: string[]): Promise<void> {
  if (!env.FAILURE_STATE) return;
  try {
    for (const kidKey of kidKeys) {
      const key = digestCompletionKey(kidKey);
      const done = JSON.parse((await env.FAILURE_STATE.get(key)) ?? "[]") as string[];
      const next = done.filter((id) => id !== taskId);
      if (next.length !== done.length) {
        await env.FAILURE_STATE.put(key, JSON.stringify(next), { expirationTtl: DIGEST_COMPLETION_TTL_SECONDS });
      }
    }
  } catch (err) {
    console.error("Failed to undo digest completion", err);
  }
}

/** Safety cap on extra catch-up closes in catchUpOverdueRecurringTask(). */
const MAX_CATCH_UP_CLOSES = 7;

/** Todoist advances a recurring task from its *current due date*, not from today, so
 * closing one that is days overdue (e.g. "every mon, wed" still due Mon, completed on
 * Wed) lands on the next slot, which can itself be today or earlier — the chore
 * flashes "done" on the tablet, then reappears on the next poll. When the task was
 * overdue by calendar date before the close, keep closing until its next due date is
 * strictly after today, so a single tap clears it from the board. A task that was
 * due today (or later) is closed exactly once, as before.
 *
 * Best-effort: the first close already succeeded (the endpoint's real contract), so
 * a failure here is logged, never thrown — same stance as the reopen fix-up. */
async function catchUpOverdueRecurringTask(env: Env, taskId: string, dueBefore: TodoistTask["due"]): Promise<void> {
  const today = todayInTimeZone(new Date(), TIMEZONE);
  if (!dueBefore?.is_recurring || dueBefore.date.slice(0, 10) >= today) return;

  try {
    for (let i = 0; i < MAX_CATCH_UP_CLOSES; i++) {
      const { due } = await getTask(env.TODOIST_TOKEN, taskId);
      if (!due?.is_recurring || due.date.slice(0, 10) > today) return;
      await closeTask(env.TODOIST_TOKEN, taskId);
    }
  } catch (err) {
    console.error("Failed to catch up overdue recurring task after complete", err);
  }
}

/** True for a 4xx Todoist rejected *this task* with — a bad request or a corrupted
 * recurrence (e.g. 400 INVALID_DATE on close), as opposed to an outage (5xx, timeout 408,
 * network failure 0) or throttling (429), which are transient and already handled by
 * withTodoistFailureTracking. Todoist clearly answered, so it must not count toward the
 * outage alert. */
function isTaskRejection(err: unknown): err is TodoistApiError {
  return (
    err instanceof TodoistApiError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429
  );
}

/** Pulls Todoist's `error_tag` (e.g. "INVALID_DATE") out of an error body, if it is JSON. */
function todoistErrorTag(err: TodoistApiError): string {
  try {
    const tag = (JSON.parse(err.body) as { error_tag?: unknown }).error_tag;
    return typeof tag === "string" ? tag : "unknown";
  } catch {
    return "unknown";
  }
}

const REJECTION_ALERT_TTL_SECONDS = 60 * 60;

/** Handles Todoist refusing a complete/reopen for one task. Logs structured details,
 * sends at most one Telegram alert per task per hour (a kid re-tapping a stuck chore
 * must not spam; `reject:alerted:<taskId>` is TTL'd so it can't grow unbounded — and
 * without FAILURE_STATE it alerts every time, which is rare enough), and returns 422
 * so the tablet can show a failure instead of silently reverting. Never throws. */
async function reportTaskRejection(
  env: Env,
  task: TodoistTask,
  action: "complete" | "reopen",
  err: TodoistApiError
): Promise<Response> {
  const tag = todoistErrorTag(err);
  const names = kidNamesOnTask(task, parseKids(env));
  console.error(
    `Todoist rejected ${action}`,
    JSON.stringify({
      taskId: task.id,
      title: task.content,
      kids: names,
      status: err.status,
      errorTag: tag,
      recurrence: task.due?.string ?? null,
    })
  );
  try {
    const key = `reject:alerted:${task.id}`;
    if (!(env.FAILURE_STATE && (await env.FAILURE_STATE.get(key)))) {
      if (env.FAILURE_STATE) await env.FAILURE_STATE.put(key, "1", { expirationTtl: REJECTION_ALERT_TTL_SECONDS });
      const fix =
        tag === "INVALID_DATE" ? " Its recurrence is corrupted in Todoist — delete and recreate the task." : "";
      await notifyTelegram(
        env,
        `⚠️ Todoist rejected "${action}" for "${task.content}" (${joinNames(names)}): HTTP ${err.status} ${tag}.${fix}`
      );
    }
  } catch (alertErr) {
    console.error("Failed to alert on Todoist task rejection", alertErr);
  }
  return jsonResponse({ error: "Todoist rejected this change", errorTag: tag }, 422);
}

async function handleCompleteTask(env: Env, taskId: string): Promise<Response> {
  const result = await getOwnedTask(env, taskId);
  if ("forbidden" in result) return result.forbidden;

  try {
    await closeTask(env.TODOIST_TOKEN, taskId);
  } catch (err) {
    if (isTaskRejection(err)) return reportTaskRejection(env, result.task, "complete", err);
    throw err;
  }
  await catchUpOverdueRecurringTask(env, taskId, result.task.due);
  const names = kidNamesOnTask(result.task, parseKids(env));
  await recordDigestCompletion(
    env,
    taskId,
    names.map((n) => n.toLowerCase())
  );
  await notifyTelegram(env, `✅ ${joinNames(names)} finished: ${result.task.content}`);

  return jsonResponse({ ok: true });
}

/** Best-effort read of {dueDate: "..."} from a reopen request body — an old cached
 * client, no body, or malformed JSON must never break the reopen itself, so this
 * degrades to null (skip the recurrence-date fix-up) rather than throwing. */
async function readOriginalDueDate(request: Request): Promise<string | null> {
  try {
    const body = (await request.json()) as { dueDate?: unknown };
    return typeof body.dueDate === "string" ? body.dueDate : null;
  } catch {
    return null;
  }
}

/** originalDueDate is the chore's due date as the client last saw it (before this
 * complete/reopen round-trip) — see readOriginalDueDate(). Closing a recurring task
 * auto-advances due.date to its next occurrence; Todoist's reopen endpoint only
 * un-marks completion, it doesn't revert that. Without restoring it here, "undo a
 * mis-tap" on a recurring chore (nearly all of them) looks fine for a moment, then
 * silently vanishes from today's board once the next poll picks up the still-advanced
 * date. Only recurring tasks are affected — a non-recurring task's due date never
 * changes on close, so reopening alone is already correct for those. */
async function handleReopenTask(env: Env, taskId: string, originalDueDate: string | null): Promise<Response> {
  const result = await getOwnedTask(env, taskId);
  if ("forbidden" in result) return result.forbidden;

  try {
    await reopenTask(env.TODOIST_TOKEN, taskId);
  } catch (err) {
    if (isTaskRejection(err)) return reportTaskRejection(env, result.task, "reopen", err);
    throw err;
  }

  const due = result.task.due;
  if (originalDueDate && due?.is_recurring && due.date !== originalDueDate) {
    try {
      await rescheduleRecurringTask(env.TODOIST_TOKEN, taskId, due.string, originalDueDate);
    } catch (err) {
      // The reopen above already succeeded — that's this endpoint's primary contract.
      // A failure here just means the recurring-date fix-up didn't take, so the chore
      // may re-vanish from today's board on the next poll (the original bug this
      // exists to fix) — unfortunate, but far better than turning an
      // already-successful reopen into a 502, and it must not get counted toward the
      // general Todoist-outage failure tracking (withTodoistFailureTracking only sees
      // whatever escapes this function) since it isn't evidence of a real outage.
      console.error("Failed to restore recurring due date after reopen", err);
    }
  }

  const names = kidNamesOnTask(result.task, parseKids(env));
  await undoDigestCompletion(
    env,
    taskId,
    names.map((n) => n.toLowerCase())
  );
  await notifyTelegram(env, `↩️ ${joinNames(names)} undid: ${result.task.content}`);

  return jsonResponse({ ok: true });
}

/** The runtime manual no-school flag: a { "YYYY-MM-DD": "reason" } map in
 * FAILURE_STATE, set via POST /api/school-skip/today and unioned with the
 * committed calendar file by getSchoolSkipCalendar(). One fixed key, pruned on
 * every write to the last MANUAL_SCHOOL_SKIP_RETAIN_DAYS days — same
 * bounded-growth shape as the streak record, not a key-per-day pattern. */
const MANUAL_SCHOOL_SKIP_KEY = "school:skip:manual";
const MANUAL_SCHOOL_SKIP_RETAIN_DAYS = 14;

async function readManualSchoolSkips(env: Env): Promise<Record<string, string>> {
  if (!env.FAILURE_STATE) return {};
  try {
    const raw = await env.FAILURE_STATE.get(MANUAL_SCHOOL_SKIP_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [d, label] of Object.entries(parsed as Record<string, unknown>)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && typeof label === "string") out[d] = label;
    }
    return out;
  } catch (err) {
    console.error("Failed to read manual school skips", err);
    return {};
  }
}

async function writeManualSchoolSkips(env: Env, map: Record<string, string>): Promise<void> {
  if (!env.FAILURE_STATE) return;
  const cutoff = todayInTimeZone(new Date(Date.now() - MANUAL_SCHOOL_SKIP_RETAIN_DAYS * 24 * 60 * 60 * 1000), TIMEZONE);
  const pruned = Object.fromEntries(Object.entries(map).filter(([d]) => d >= cutoff));
  await env.FAILURE_STATE.put(MANUAL_SCHOOL_SKIP_KEY, JSON.stringify(pruned));
}

/** The committed no-school calendar (public/school-calendar.json, or
 * SCHOOL_SKIP_CALENDAR_URL) unioned with the runtime manual flag. */
async function getSchoolSkipCalendar(env: Env): Promise<SchoolCalendar> {
  const [file, manual] = await Promise.all([loadSchoolCalendar(env), readManualSchoolSkips(env)]);
  return {
    has: (d) => file.has(d) || d in manual,
    labelFor: (d) => file.labelFor(d) ?? (manual[d] || null),
  };
}

/** GET/POST/DELETE /api/school-skip[/today] — the runtime manual no-school flag,
 * for a snow day (or any closure) the committed calendar doesn't know about.
 * Same ?key= gate as every route.
 *   GET  /api/school-skip           → { manual: {date: reason, …} }
 *   POST /api/school-skip/today     → add today (?date=/?reason= override), then
 *                                     immediately run the school-skip so today's
 *                                     chores clear now, not just next midnight
 *   DELETE /api/school-skip/today   → remove today (?date= override)
 * Needs FAILURE_STATE (503 without it). The immediate close only does anything
 * when SCHOOL_SKIP_ENABLED is on — otherwise the date is just recorded for the
 * next enabled run / the digest. */
async function handleSchoolSkipFlag(env: Env, request: Request, url: URL): Promise<Response> {
  if (!env.FAILURE_STATE) {
    return jsonResponse({ error: "Manual school-skip flag needs the FAILURE_STATE KV binding" }, 503);
  }

  if (request.method === "GET" && url.pathname === "/api/school-skip") {
    return jsonResponse({ manual: await readManualSchoolSkips(env) });
  }

  if (url.pathname === "/api/school-skip/today" && (request.method === "POST" || request.method === "DELETE")) {
    const today = todayInTimeZone(new Date(), TIMEZONE);
    const date = url.searchParams.get("date") ?? today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return jsonResponse({ error: "date must be YYYY-MM-DD" }, 400);
    }

    const manual = await readManualSchoolSkips(env);
    if (request.method === "POST") {
      manual[date] = url.searchParams.get("reason") || "Snow day";
      await writeManualSchoolSkips(env, manual);
      if (date === today) await runSchoolSkipCheck(env); // no-op unless SCHOOL_SKIP_ENABLED
    } else {
      delete manual[date];
      await writeManualSchoolSkips(env, manual);
    }
    return jsonResponse({ ok: true, date, manual: await readManualSchoolSkips(env) });
  }

  return jsonResponse({ error: "Not found" }, 404);
}

/** Footer lines for the nightly digest — one per skip kind that closed something
 * today ("🌧️ Rainy day — …", "🏫 Veterans Day — …"). Reads the same KV state the
 * 00:15 cron wrote. Never throws — a missing/unparseable record yields no line. */
async function skipDigestNotes(env: Env, today: string, kids: Kid[]): Promise<string[]> {
  if (!env.FAILURE_STATE) return [];
  const lines: string[] = [];
  for (const kind of ["rain", "school"] as const) {
    try {
      const raw = await env.FAILURE_STATE.get(skipStateKey(kind, today));
      if (!raw) continue;
      const state = JSON.parse(raw) as SkipState;
      if (state.closedTaskIds.length === 0) continue;
      const names = state.kidKeys
        .map((k) => kids.find((kid) => kid.key === k)?.name)
        .filter((n): n is string => Boolean(n));
      lines.push(skipDigestLine(kind, state, names));
    } catch (err) {
      console.error(`${kind}-skip digest note failed`, err);
    }
  }
  return lines;
}

/** Once a night, summarizes each kid's completed-today count and still-open count
 * to the Telegram group. Best-effort like the other notifications — errors are
 * logged, never thrown, since nothing is waiting on a response for a cron run. */
export async function runDailyDigest(env: Env): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;

  try {
    const kids = parseKids(env);
    const now = new Date();

    const activeTasks = await getProjectTasks(env.TODOIST_TOKEN, env.KIDS_PROJECT_ID);
    const openByKid = activeChoresByKid(activeTasks, now, kids);

    // See recordDigestCompletion's doc comment for why this reads our own tracked
    // completions rather than Todoist's completed-tasks-by-date endpoint. Without
    // FAILURE_STATE bound there's simply nothing to read — same as any other
    // optional-infra degrade in this codebase, the digest still sends with "still
    // open" counts accurate, just 0 done for everyone rather than not sending at all.
    const doneCounts: Record<string, number> = Object.fromEntries(
      await Promise.all(
        kids.map(async (kid) => {
          if (!env.FAILURE_STATE) return [kid.key, 0] as const;
          const raw = await env.FAILURE_STATE.get(digestCompletionKey(kid.key));
          return [kid.key, raw ? (JSON.parse(raw) as string[]).length : 0] as const;
        })
      )
    );

    const dateLabel = new Intl.DateTimeFormat("en-US", {
      timeZone: TIMEZONE,
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(now);

    // A kid with zero chores due that day is "clean" the same as one who finished
    // everything — both mean nothing was left undone by digest time. This is also
    // where the day's result gets recorded for the streak feature: digest time is
    // the one point in the day where "was everything done" is actually knowable,
    // so it piggybacks on the openByKid this function already computed rather than
    // re-deriving it elsewhere.
    // Promise.all preserves input order in its results, so the digest message's
    // kid ordering still follows KIDS var order even though the writes run
    // concurrently — each kid's KV write is independent of every other's.
    const lines = await Promise.all(
      kids.map(async (kid) => {
        const open = openByKid[kid.key].length;
        await recordDailyCleanStatus(env, kid.key, open === 0);
        const status = open === 0 ? "🎉 all done!" : `🕗 ${open} still open`;
        return `${kid.name}: ✅ ${doneCounts[kid.key]} done · ${status}`;
      })
    );

    const skipNotes = await skipDigestNotes(env, todayInTimeZone(now, TIMEZONE), kids);
    await notifyTelegram(env, [`📊 Chore summary — ${dateLabel}`, ...lines, ...skipNotes].join("\n"));
  } catch (err) {
    console.error("Daily digest failed", err);
  }
}

// ---------------------------------------------------------------------------
// Auto chore skip — shared engine for the rain-aware and calendar-aware (no-
// school) skips. Both do the same thing just after local midnight (see
// MIDNIGHT_SKIP_CRON): silently close today's eligible chores (closing a
// recurring task advances it to its next occurrence, so the streak/overdue
// logic needs no special case), record one date-keyed KV entry, and leave the
// Telegram heads-up to deliverSkipNotices() on the heartbeat tick so nobody's
// phone buzzes at 00:15. The digest reads the same entry for its footer line.
// All best-effort, never throw — run from a cron with nothing awaiting them.
// ---------------------------------------------------------------------------

interface SkipSpec {
  kind: SkipKind;
  /** Whether an auto-closed chore also counts toward the digest's "done" tally. */
  countsAsDone: boolean;
  /** null → today doesn't qualify (nothing happens). A string → today qualifies,
   * and it's stored as SkipState.detail for the notice/digest wording. */
  qualifies(now: Date, today: string): Promise<string | null>;
  /** Which of today's due chores this spec acts on. */
  isEligible(task: TodoistTask): boolean;
}

async function runAutoSkip(env: Env, spec: SkipSpec): Promise<void> {
  try {
    const now = new Date();
    const today = todayInTimeZone(now, TIMEZONE);

    // Idempotency guard #1 (fast path): already acted today. Guard #2 is the
    // "due today" filter below — even with no FAILURE_STATE bound, a re-fire
    // won't double-close, since the first close advances the task off today.
    if (env.FAILURE_STATE && (await env.FAILURE_STATE.get(skipStateKey(spec.kind, today)))) return;

    const detail = await spec.qualifies(now, today);
    if (detail === null) return;

    const kids = parseKids(env);
    const tasks = await getProjectTasks(env.TODOIST_TOKEN, env.KIDS_PROJECT_ID);
    const matchedTasks = tasks.filter((t) => spec.isEligible(t) && t.due?.date?.slice(0, 10) === today);
    if (matchedTasks.length === 0) return;

    const closedTaskIds: string[] = [];
    const closedTitles: string[] = [];
    const affectedKidKeys = new Set<string>();
    for (const matched of matchedTasks) {
      // Re-fetch + project-ownership check before every write — the hard
      // constraint in CLAUDE.md. getProjectTasks already scoped to
      // KIDS_PROJECT_ID, but this never gets to skip that check.
      const owned = await getOwnedTask(env, matched.id);
      if ("forbidden" in owned) continue;
      await closeTask(env.TODOIST_TOKEN, matched.id);
      closedTaskIds.push(matched.id);
      closedTitles.push(owned.task.content);
      const kidKeys = kidNamesOnTask(owned.task, kids).map((n) => n.toLowerCase());
      for (const key of kidKeys) affectedKidKeys.add(key);
      if (spec.countsAsDone) await recordDigestCompletion(env, matched.id, kidKeys);
    }

    if (env.FAILURE_STATE && closedTaskIds.length > 0) {
      const state: SkipState = {
        closedTaskIds,
        closedTitles,
        kidKeys: [...affectedKidKeys],
        detail,
        notified: false,
      };
      await env.FAILURE_STATE.put(skipStateKey(spec.kind, today), JSON.stringify(state), {
        expirationTtl: SKIP_STATE_TTL_SECONDS,
      });
    }
  } catch (err) {
    console.error(`${spec.kind}-skip check failed`, err);
  }
}

/** Rain-aware skip: a wet-enough forecast for today (both thresholds — a short
 * heavy burst shouldn't count as "rained all day"). Eligibility is a
 * case-insensitive title-substring match against any RAIN_SKIP_MATCH entry. */
export async function runRainSkipCheck(env: Env): Promise<void> {
  const cfg = parseRainSkipConfig(env);
  if (!cfg.enabled) return;
  await runAutoSkip(env, {
    kind: "rain",
    countsAsDone: cfg.countsAsDone,
    async qualifies(_now, today) {
      const { lat, lon } = parseWeatherLocation(env);
      const forecast = await getDailyForecast(lat, lon, TIMEZONE);
      if (forecast.date !== today) {
        // Open-Meteo's "today" (in TIMEZONE) should match ours given the cron
        // fires well after local midnight — bail rather than act on the wrong day.
        console.error(`Rain-skip: forecast date ${forecast.date} != today ${today}, skipping`);
        return null;
      }
      if (forecast.hours <= cfg.minHours || forecast.sumMm < cfg.minMm) return null;
      return `forecast: ~${Math.round(forecast.hours)}h, ${Math.round(forecast.sumMm)}mm today`;
    },
    isEligible: (t) => titleMatchesRainSkip(t.content, cfg.matches),
  });
}

/** Calendar-aware skip: today is a district no-school day (committed calendar
 * file unioned with the runtime manual flag). Eligibility is the
 * SCHOOL_SKIP_LABEL Todoist label. */
export async function runSchoolSkipCheck(env: Env): Promise<void> {
  const cfg = parseSchoolSkipConfig(env);
  if (!cfg.enabled) return;
  await runAutoSkip(env, {
    kind: "school",
    countsAsDone: cfg.countsAsDone,
    async qualifies(_now, today) {
      const calendar = await getSchoolSkipCalendar(env);
      if (!calendar.has(today)) return null;
      return calendar.labelFor(today) ?? ""; // "" → generic "No-school day" wording
    },
    isEligible: (t) => t.labels.includes(cfg.label),
  });
}

/** The deferred half of the auto-skip feature: runAutoSkip() closes chores
 * silently at ~00:15; this sends the single Telegram heads-up per skip kind, but
 * not until SKIP_NOTIFY_HOUR (default 9am local). Runs off the frequent heartbeat
 * cron tick rather than its own cron — that gets an exact 9am-local send
 * year-round (a fixed-UTC cron would drift an hour across DST) and reuses the
 * "runs often, acts once, dedupe flag in KV" shape checkHeartbeat already uses.
 * Never throws. */
export async function deliverSkipNotices(env: Env): Promise<void> {
  if (!env.FAILURE_STATE || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;

  try {
    const now = new Date();
    // Keeps this to at most two KV reads per tick from SKIP_NOTIFY_HOUR on, none before.
    if (hourInTimeZone(now, TIMEZONE) < skipNotifyHour(env)) return;

    const today = todayInTimeZone(now, TIMEZONE);
    const kids = parseKids(env);

    for (const kind of ["rain", "school"] as const) {
      try {
        const key = skipStateKey(kind, today);
        const raw = await env.FAILURE_STATE.get(key);
        if (!raw) continue;
        const state = JSON.parse(raw) as SkipState;
        if (state.notified || state.closedTaskIds.length === 0) continue;

        const names = state.kidKeys
          .map((k) => kids.find((kid) => kid.key === k)?.name)
          .filter((n): n is string => Boolean(n));

        // sendTelegramMessage directly (not notifyTelegram) so a failed send
        // throws here and `notified` stays false — the next 15-min tick retries,
        // bounded by the key's TTL. Per-kind try so one failing send doesn't
        // block the other.
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, skipNoticeLine(kind, state, names));
        await env.FAILURE_STATE.put(key, JSON.stringify({ ...state, notified: true }), {
          expirationTtl: SKIP_STATE_TTL_SECONDS,
        });
      } catch (err) {
        console.error(`${kind}-skip notice delivery failed`, err);
      }
    }
  } catch (err) {
    console.error("Skip notice delivery failed", err);
  }
}

/** WMO weather codes for wintry precipitation — freezing drizzle (56/57),
 * freezing rain (66/67), snow (71/73/75/77), snow showers (85/86). */
const SNOW_CODES = new Set([56, 57, 66, 67, 71, 73, 75, 77, 85, 86]);

/** Weather-triggered nudge — NOT a skip. On a would-be school day whose forecast
 * turns wintry, one Telegram reminder to flag the day manually if school
 * actually closes (POST /api/school-skip/today). It never skips anything itself
 * — a snow day is the district's call, not the forecast's. Once per day, past
 * SNOW_REMINDER_HOUR, only on a weekday that isn't already a known no-school day.
 * Rides the heartbeat tick like deliverSkipNotices. Never throws. */
export async function maybeSendSnowReminder(env: Env): Promise<void> {
  if (env.SNOW_REMINDER_ENABLED !== "true") return;
  if (!env.FAILURE_STATE || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;

  try {
    const now = new Date();
    if (hourInTimeZone(now, TIMEZONE) < Number(env.SNOW_REMINDER_HOUR ?? "6")) return;

    const today = todayInTimeZone(now, TIMEZONE);
    const dedupeKey = `snow:reminded:${today}`;
    if (await env.FAILURE_STATE.get(dedupeKey)) return;

    // Only bother on a weekday that isn't already a no-school day.
    const dow = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0=Sun … 6=Sat
    if (dow === 0 || dow === 6) return;
    const calendar = await getSchoolSkipCalendar(env);
    if (calendar.has(today)) return;

    const { lat, lon } = parseWeatherLocation(env);
    const forecast = await getDailyForecast(lat, lon, TIMEZONE);
    if (forecast.date !== today) return;
    if (forecast.snowfallCm < Number(env.SNOW_REMINDER_MIN_CM ?? "1") && !SNOW_CODES.has(forecast.weatherCode)) return;

    await env.FAILURE_STATE.put(dedupeKey, "1", { expirationTtl: SKIP_STATE_TTL_SECONDS });
    const snow = Math.round(forecast.snowfallCm * 10) / 10;
    await sendTelegramMessage(
      env.TELEGRAM_BOT_TOKEN,
      env.TELEGRAM_CHAT_ID,
      `❄️ Wintry weather in today's forecast (${snow}cm snow). If school is closed, flag it a no-school day on the dashboard so school-day chores clear automatically.`
    );
  } catch (err) {
    console.error("Snow reminder failed", err);
  }
}

// Time-based rather than count-based, deliberately: a read-then-increment-then-write
// counter isn't safe under concurrent requests (Workers KV has no compare-and-swap,
// so two failing requests can both read the same value and both write the same
// next value, silently losing an increment) — this app usually has exactly one
// client, but a second device (e.g. someone's phone) polling at the same time as
// the tablet during a real outage is entirely plausible. Recording *when* the streak
// started sidesteps this: the only remaining overlap is multiple concurrent requests
// writing the same first-failure timestamp, which is harmless since they agree.
const FAILURE_ALERT_AFTER_MS = 2 * 60 * 1000; // ~= 3 failures at the old ~45s-poll-based threshold
const KV_FIRST_FAILURE_AT_KEY = "todoist:firstFailureAt";
const KV_ALERTED_KEY = "todoist:alerted";

/** Alerts once (not on every poll) after Todoist has been failing continuously for a
 * while, so a real outage surfaces somewhere besides the kiosk's own "Reconnecting…"
 * banner. Checking alreadyAlerted first and returning immediately caps this at 2 puts
 * (the first-failure timestamp, then the alerted flag) for the entire outage, however
 * long it runs — an unconditional write on every ~45s poll could itself exhaust
 * Workers KV's daily write quota, the same class of bug that broke
 * recordTodoistSuccess's deletes in production. recordTodoistSuccess clears both keys
 * once the outage actually ends, so there's nothing further to track until then. */
async function recordTodoistFailure(env: Env, err: TodoistApiError): Promise<void> {
  if (!env.FAILURE_STATE) return;
  try {
    const alreadyAlerted = await env.FAILURE_STATE.get(KV_ALERTED_KEY);
    if (alreadyAlerted) return;

    let firstFailureAt = await env.FAILURE_STATE.get(KV_FIRST_FAILURE_AT_KEY);
    if (!firstFailureAt) {
      firstFailureAt = String(Date.now());
      await env.FAILURE_STATE.put(KV_FIRST_FAILURE_AT_KEY, firstFailureAt);
    }

    const failingForMs = Date.now() - Number(firstFailureAt);
    if (failingForMs < FAILURE_ALERT_AFTER_MS) return;

    await env.FAILURE_STATE.put(KV_ALERTED_KEY, "1");
    const minutes = Math.round(failingForMs / 60000);
    // status 0 is todoistFetch's sentinel for "no HTTP response was ever received"
    // (a network-level failure, not a bad status) — worth a clearer label than "HTTP 0".
    const lastFailure = err.status === 0 ? "network error" : `HTTP ${err.status}`;
    await notifyTelegram(
      env,
      `⚠️ Todoist has been failing for ${minutes} minute${minutes === 1 ? "" : "s"} (last: ${lastFailure}). The chore dashboard may be showing stale data.`
    );
  } catch (kvErr) {
    console.error("Failed to record Todoist failure state", kvErr);
  }
}

/** Only touches KV when there's actually a failure streak to clear — the kiosk polls
 * every ~45s, so an unconditional delete() here burns through Workers KV's daily
 * delete quota in a few hours and, once exhausted, throws on every future poll and
 * turns an already-successful Todoist response into a 500 (this actually happened in
 * production). Checked-then-cleared keeps the common case (no prior failures) to a
 * single free read. Also never throws, same reasoning as notifyTelegram/notifyWebhook
 * — this is optional bookkeeping and must never break an already-successful response. */
async function recordTodoistSuccess(env: Env): Promise<void> {
  if (!env.FAILURE_STATE) return;
  try {
    const hadFailures = await env.FAILURE_STATE.get(KV_FIRST_FAILURE_AT_KEY);
    if (!hadFailures) return;
    await env.FAILURE_STATE.delete(KV_FIRST_FAILURE_AT_KEY);
    await env.FAILURE_STATE.delete(KV_ALERTED_KEY);
  } catch (kvErr) {
    console.error("Failed to clear Todoist failure state", kvErr);
  }
}

async function withTodoistFailureTracking<T>(env: Env, fn: () => Promise<T>): Promise<T> {
  try {
    const result = await fn();
    await recordTodoistSuccess(env);
    return result;
  } catch (err) {
    if (err instanceof TodoistApiError) {
      await recordTodoistFailure(env, err);
    }
    throw err;
  }
}

const HEARTBEAT_STALE_MS = 30 * 60 * 1000; // comfortably longer than any transient blip — the kiosk retries every ~45s even while failing
// Throttles the KV write below — checkHeartbeat only needs minute-ish resolution against
// HEARTBEAT_STALE_MS, but the kiosk polls every ~45s, and writing on every single request
// would be ~1,920 writes/day against Workers KV's free-tier 1,000/day quota (this is the
// same class of bug that broke recordTodoistSuccess's deletes in production — see below).
const HEARTBEAT_WRITE_INTERVAL_MS = 5 * 60 * 1000;
const KV_LAST_SEEN_KEY = "heartbeat:lastSeen";
const KV_HEARTBEAT_ALERTED_KEY = "heartbeat:alerted";

/** Recorded on every authenticated request (not just successful ones — the point is
 * "is the tablet reaching us at all", which is independent of whether Todoist itself
 * is up). This is the only signal that catches a tablet that's powered off, crashed,
 * or has lost Wi-Fi entirely — the Todoist-failure tracking above can't see that,
 * since it only runs when a request actually arrives. Never throws — this runs
 * unguarded ahead of the routing try/catch in fetch(), so a KV hiccup here must not
 * take down an otherwise-successful request. */
async function recordHeartbeat(env: Env): Promise<void> {
  if (!env.FAILURE_STATE) return;
  try {
    const lastSeenRaw = await env.FAILURE_STATE.get(KV_LAST_SEEN_KEY);
    if (lastSeenRaw && Date.now() - Number(lastSeenRaw) < HEARTBEAT_WRITE_INTERVAL_MS) return;
    await env.FAILURE_STATE.put(KV_LAST_SEEN_KEY, String(Date.now()));
  } catch (err) {
    console.error("Failed to record heartbeat", err);
  }
}

/** Runs off a frequent cron tick (see wrangler.toml) rather than per-request, since
 * "no requests arrived" can only be noticed by someone other than the requester. */
export async function checkHeartbeat(env: Env): Promise<void> {
  if (!env.FAILURE_STATE || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;

  try {
    const lastSeenRaw = await env.FAILURE_STATE.get(KV_LAST_SEEN_KEY);
    if (!lastSeenRaw) return; // no traffic recorded yet — e.g. a fresh deploy, nothing to compare against

    const staleFor = Date.now() - Number(lastSeenRaw);

    if (staleFor < HEARTBEAT_STALE_MS) {
      // Only clear if there's actually something to clear — an unconditional delete()
      // on every healthy 15-minute tick is the same "write without checking first"
      // pattern that broke recordTodoistSuccess in production, just smaller-scale here.
      const wasAlerted = await env.FAILURE_STATE.get(KV_HEARTBEAT_ALERTED_KEY);
      if (wasAlerted) await env.FAILURE_STATE.delete(KV_HEARTBEAT_ALERTED_KEY);
      return;
    }

    const alreadyAlerted = await env.FAILURE_STATE.get(KV_HEARTBEAT_ALERTED_KEY);
    if (alreadyAlerted) return;

    await env.FAILURE_STATE.put(KV_HEARTBEAT_ALERTED_KEY, "1");
    const minutes = Math.round(staleFor / 60000);
    await notifyTelegram(
      env,
      `📵 No request from the dashboard in ${minutes} minutes — is the tablet powered on and connected?`
    );
  } catch (err) {
    console.error("Heartbeat check failed", err);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }

    if (!checkAuth(request, env)) {
      return jsonResponse({ error: "Forbidden" }, 403);
    }

    await recordHeartbeat(env);

    try {
      if (request.method === "GET" && url.pathname === "/api/chores") {
        return await withTodoistFailureTracking(env, () => handleGetChores(env));
      }

      const completeMatch = url.pathname.match(/^\/api\/chores\/([^/]+)\/complete$/);
      if (request.method === "POST" && completeMatch) {
        const taskId = decodeURIComponent(completeMatch[1]);
        return await withTodoistFailureTracking(env, () => handleCompleteTask(env, taskId));
      }

      const reopenMatch = url.pathname.match(/^\/api\/chores\/([^/]+)\/reopen$/);
      if (request.method === "POST" && reopenMatch) {
        const taskId = decodeURIComponent(reopenMatch[1]);
        const originalDueDate = await readOriginalDueDate(request);
        return await withTodoistFailureTracking(env, () => handleReopenTask(env, taskId, originalDueDate));
      }

      // Not wrapped in withTodoistFailureTracking — this route never touches
      // Todoist, so that wrapper's TodoistApiError handling doesn't apply.
      const avatarMatch = url.pathname.match(/^\/api\/avatars\/([^/]+)$/);
      if (request.method === "GET" && avatarMatch) {
        return await handleGetAvatar(env, decodeURIComponent(avatarMatch[1]));
      }

      if (url.pathname === "/api/school-skip" || url.pathname === "/api/school-skip/today") {
        // A POST here may call runSchoolSkipCheck, which touches Todoist but
        // swallows its own errors — so this isn't wrapped in the failure tracker.
        return await handleSchoolSkipFlag(env, request, url);
      }

      return jsonResponse({ error: "Not found" }, 404);
    } catch (err) {
      if (err instanceof TodoistApiError) {
        console.error(err);
        return jsonResponse({ error: "Todoist request failed" }, err.status === 404 ? 404 : 502);
      }
      console.error(err);
      return jsonResponse({ error: "Unexpected error" }, 500);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === DIGEST_CRON) {
      ctx.waitUntil(runDailyDigest(env));
    } else if (event.cron === MIDNIGHT_SKIP_CRON) {
      ctx.waitUntil(runRainSkipCheck(env));
      ctx.waitUntil(runSchoolSkipCheck(env));
    } else {
      ctx.waitUntil(checkHeartbeat(env));
      ctx.waitUntil(deliverSkipNotices(env));
      ctx.waitUntil(maybeSendSnowReminder(env));
    }
  },
};
