/** The committed no-school-days list, loaded at runtime by the calendar-aware
 * chore skip (SCHOOL_SKIP_* in index.ts). Source of truth is
 * public/school-calendar.json, regenerated from the district iCal feed by
 * scripts/refresh-school-calendar.mjs — the Worker never parses ICS itself.
 * Small standalone module like weather.ts / telegram.ts. */

export interface SchoolCalendar {
  /** Is `date` ("YYYY-MM-DD") a no-school day? True for an explicit `skipDates`
   * entry OR any date outside the [termStart, termEnd] window (summer + shoulder
   * gaps the district feed doesn't enumerate). */
  has(date: string): boolean;
  /** Human label for `date` (e.g. "Veterans Day", or "Summer break" for an
   * out-of-term date), or null if it isn't a no-school day. */
  labelFor(date: string): string | null;
}

interface SchoolCalendarFile {
  /** First and last day school could be in session ("YYYY-MM-DD"). Any date
   * outside [termStart, termEnd] counts as no-school too — this is how the
   * summer break (and the late-Aug / mid-June shoulder gaps) get covered, since
   * the district feed only marks in-year non-student days. Optional and
   * hand-maintained; either one missing/malformed just disables that side of
   * the window. */
  termStart?: unknown;
  termEnd?: unknown;
  skipDates?: unknown;
  labels?: unknown;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(v: unknown): string | null {
  return typeof v === "string" && DATE_RE.test(v) ? v : null;
}

/** Always resolves — a missing binding, a fetch failure, or malformed JSON yields
 * an empty calendar (nothing is a skip day) and a logged error, never a throw.
 * Same fail-open philosophy as the rain-skip forecast fetch: if we can't tell,
 * chores show as normal. `env` only needs the two fields it reads. */
export async function loadSchoolCalendar(env: {
  ASSETS?: Fetcher;
  SCHOOL_SKIP_CALENDAR_URL?: string;
}): Promise<SchoolCalendar> {
  try {
    let text: string;
    if (env.SCHOOL_SKIP_CALENDAR_URL) {
      const res = await fetch(env.SCHOOL_SKIP_CALENDAR_URL);
      if (!res.ok) throw new Error(`school calendar URL fetch failed: ${res.status}`);
      text = await res.text();
    } else if (env.ASSETS) {
      // A synthetic same-origin URL — env.ASSETS routes by path, host is ignored.
      const res = await env.ASSETS.fetch(new Request("https://assets.local/school-calendar.json"));
      if (!res.ok) throw new Error(`school-calendar.json asset returned ${res.status}`);
      text = await res.text();
    } else {
      return EMPTY_CALENDAR;
    }

    const parsed = JSON.parse(text) as SchoolCalendarFile;
    const dates = new Set(
      (Array.isArray(parsed.skipDates) ? parsed.skipDates : []).filter(
        (d): d is string => typeof d === "string" && DATE_RE.test(d)
      )
    );
    const rawLabels =
      parsed.labels && typeof parsed.labels === "object" ? (parsed.labels as Record<string, unknown>) : {};

    let termStart = validDate(parsed.termStart);
    let termEnd = validDate(parsed.termEnd);
    if (termStart && termEnd && termStart > termEnd) {
      console.error(`school calendar: termStart ${termStart} is after termEnd ${termEnd}, ignoring both`);
      termStart = termEnd = null;
    }
    // Lexicographic compare of "YYYY-MM-DD" is chronological.
    const outOfTerm = (d: string) => (termStart != null && d < termStart) || (termEnd != null && d > termEnd);

    return {
      has: (d) => dates.has(d) || outOfTerm(d),
      labelFor: (d) => {
        if (typeof rawLabels[d] === "string") return rawLabels[d] as string;
        if (!dates.has(d) && outOfTerm(d)) return "Summer break";
        return null;
      },
    };
  } catch (err) {
    console.error("Failed to load school calendar", err);
    return EMPTY_CALENDAR;
  }
}

const EMPTY_CALENDAR: SchoolCalendar = {
  has: () => false,
  labelFor: () => null,
};
