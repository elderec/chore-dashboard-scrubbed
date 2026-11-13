import type { TodoistDue } from "./todoist";

const HAS_OFFSET = /[Zz]|[+-]\d{2}:\d{2}$/;

/** due.timezone comes straight from Todoist, unvalidated — an IANA zone name Intl
 * doesn't recognize makes `new Intl.DateTimeFormat(..., { timeZone })` throw a
 * RangeError. Without this check, that RangeError would propagate straight out of
 * dueInstant/isOverdue/dueTimeMinutes for whichever single chore had the bad value,
 * and since handleGetChores computes these per-chore inline (not each in its own
 * try/catch), one malformed chore would 500 the entire /api/chores response for
 * every kid, not just drop that one chore. The idiomatic way to validate an IANA
 * zone string in JS is exactly this — try constructing a formatter with it and see
 * if it throws — there's no cheaper built-in check. */
function isValidTimeZone(timeZone: string): boolean {
  const cached = validZones.get(timeZone);
  if (cached !== undefined) return cached;
  let valid: boolean;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone });
    valid = true;
  } catch {
    valid = false;
  }
  validZones.set(timeZone, valid);
  return valid;
}

/** Constructing an Intl.DateTimeFormat is by far the most expensive thing this
 * file does — /api/chores used to build several per task and exceeded the Worker's
 * CPU limit ("Worker exceeded CPU time limit"). Formatters are immutable and
 * stateless, so one per (kind, zone) is built lazily and reused for the life of
 * the isolate. The zone set is tiny (TIMEZONE plus whatever zones Todoist
 * attaches), so the caches stay small. */
const validZones = new Map<string, boolean>();
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function cachedFormatter(kind: string, timeZone: string, options: Intl.DateTimeFormatOptions, locale: string) {
  const cacheKey = `${kind}|${timeZone}`;
  let fmt = formatterCache.get(cacheKey);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, { timeZone, ...options });
    formatterCache.set(cacheKey, fmt);
  }
  return fmt;
}

export function todayInTimeZone(now: Date, timeZone: string): string {
  return cachedFormatter("day", timeZone, { year: "numeric", month: "2-digit", day: "2-digit" }, "en-CA").format(now);
}

/** The current hour (0–23) in the given IANA zone. Used by the rain-skip
 * deferred-notification gate in index.ts, which only needs hour resolution — a
 * fixed-UTC cron couldn't hit "9am local" without drifting across DST. */
export function hourInTimeZone(now: Date, timeZone: string): number {
  const parts = cachedFormatter("hour", timeZone, { hourCycle: "h23", hour: "2-digit" }, "en-US").formatToParts(now);
  return Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
}

function timeZoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = cachedFormatter(
    "full",
    timeZone,
    {
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    },
    "en-US"
  ).formatToParts(instant);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return (asUtc - instant.getTime()) / 60000;
}

/** Converts a naive local wall-clock string ("2026-08-22T09:00:00", no offset)
 * in the given IANA zone into the real UTC instant it represents. */
function zonedWallTimeToInstant(wallTime: string, timeZone: string): Date {
  const naiveUtc = new Date(`${wallTime}Z`);
  const offsetMinutes = timeZoneOffsetMinutes(naiveUtc, timeZone);
  return new Date(naiveUtc.getTime() - offsetMinutes * 60000);
}

/** Resolves a due.date string to an exact instant, or null if it's a date-only
 * due date with no time component. An invalid due.timezone (see isValidTimeZone)
 * is treated the same as a null/floating one — falls back to fallbackTimeZone
 * rather than throwing, same degrade-gracefully spirit as null already had. */
function dueInstant(due: TodoistDue, fallbackTimeZone: string): Date | null {
  if (due.date.length <= 10) return null; // "YYYY-MM-DD" only, no time
  if (HAS_OFFSET.test(due.date)) return new Date(due.date);
  const zone = due.timezone && isValidTimeZone(due.timezone) ? due.timezone : fallbackTimeZone;
  return zonedWallTimeToInstant(due.date, zone);
}

export function isDueTodayOrOverdue(due: TodoistDue | null, now: Date, timeZone: string): boolean {
  if (!due) return false;
  return due.date.slice(0, 10) <= todayInTimeZone(now, timeZone);
}

export function isOverdue(due: TodoistDue | null, now: Date, timeZone: string): boolean {
  if (!due) return false;
  const instant = dueInstant(due, timeZone);
  if (instant) return instant.getTime() < now.getTime();
  return due.date.slice(0, 10) < todayInTimeZone(now, timeZone);
}

/** Whole calendar days (in the given zone) between a chore's due date and today, or 0
 * if it isn't past due by at least a day — a chore only hours late today is 0, not
 * 1. Compares YYYY-MM-DD strings via UTC midnights so DST never skews the count. */
export function daysOverdue(due: TodoistDue | null, now: Date, timeZone: string): number {
  if (!due) return 0;
  const toDay = (ymd: string) => Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10));
  const days = Math.round((toDay(todayInTimeZone(now, timeZone)) - toDay(due.date.slice(0, 10))) / 86_400_000);
  return days > 0 ? days : 0;
}

/** The instant "today" began (00:00 wall-clock) in the given IANA zone. */
export function startOfDayInTimeZone(now: Date, timeZone: string): Date {
  return zonedWallTimeToInstant(`${todayInTimeZone(now, timeZone)}T00:00:00`, timeZone);
}

/** Minutes since local midnight (in timeZone) for a chore's due time, or null if
 * it's a date-only due date with no time component — used for the Day/Evening tab
 * split, a separate concept from isOverdue (which cares whether the moment has
 * passed, not what time of day it falls at). Reuses dueInstant/the same
 * Intl-based zone conversion as the rest of this file rather than reading
 * due.date's own HH:MM directly, since due.timezone can differ from timeZone —
 * this always reports the time in timeZone specifically, regardless of which zone
 * (if any) Todoist attached to the due date itself. */
export function dueTimeMinutes(due: TodoistDue | null, timeZone: string): number | null {
  if (!due) return null;
  const instant = dueInstant(due, timeZone);
  if (!instant) return null;

  const parts = cachedFormatter(
    "hm",
    timeZone,
    { hourCycle: "h23", hour: "2-digit", minute: "2-digit" },
    "en-US"
  ).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return get("hour") * 60 + get("minute");
}
