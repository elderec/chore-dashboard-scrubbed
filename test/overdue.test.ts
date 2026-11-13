import { describe, it, expect, vi } from "vitest";
import {
  todayInTimeZone,
  hourInTimeZone,
  isDueTodayOrOverdue,
  isOverdue,
  daysOverdue,
  startOfDayInTimeZone,
  dueTimeMinutes,
} from "../src/overdue";
import type { TodoistDue } from "../src/todoist";

const LA = "America/Los_Angeles";

// 2026-08-22T12:00:00Z is 2026-08-22 05:00 in America/Los_Angeles (PDT, UTC-7).
const NOW = new Date("2026-08-22T12:00:00Z");

function due(overrides: Partial<TodoistDue>): TodoistDue {
  return { date: "2026-08-22", is_recurring: false, string: "", timezone: null, ...overrides };
}

describe("todayInTimeZone", () => {
  it("formats the current date in the given IANA zone", () => {
    expect(todayInTimeZone(NOW, LA)).toBe("2026-08-22");
  });
});

describe("hourInTimeZone", () => {
  it("returns the current hour (0-23) in the given zone", () => {
    // NOW = 2026-08-22T12:00:00Z → 05:00 in America/Los_Angeles (PDT, UTC-7)
    expect(hourInTimeZone(NOW, LA)).toBe(5);
    // → 08:00 in America/New_York (EDT, UTC-4)
    expect(hourInTimeZone(NOW, "America/New_York")).toBe(8);
  });

  it("reports 0, not 24, at local midnight", () => {
    // 2026-08-22T07:00:00Z is 2026-08-22 00:00 in America/Los_Angeles (PDT)
    expect(hourInTimeZone(new Date("2026-08-22T07:00:00Z"), LA)).toBe(0);
  });
});

describe("startOfDayInTimeZone", () => {
  it("returns the UTC instant that today began (00:00) in the given zone", () => {
    // 2026-08-22 00:00 PDT (UTC-7) is 2026-08-22 07:00 UTC.
    expect(startOfDayInTimeZone(NOW, LA).toISOString()).toBe("2026-08-22T07:00:00.000Z");
  });

  it("uses the correct offset for a different zone", () => {
    // 2026-08-22 00:00 EDT (UTC-4) is 2026-08-22 04:00 UTC.
    expect(startOfDayInTimeZone(NOW, "America/New_York").toISOString()).toBe("2026-08-22T04:00:00.000Z");
  });
});

describe("isDueTodayOrOverdue", () => {
  it("is false for no due date", () => {
    expect(isDueTodayOrOverdue(null, NOW, LA)).toBe(false);
  });

  it("is true when due today", () => {
    expect(isDueTodayOrOverdue(due({ date: "2026-08-22" }), NOW, LA)).toBe(true);
  });

  it("is true when due in the past", () => {
    expect(isDueTodayOrOverdue(due({ date: "2026-08-21" }), NOW, LA)).toBe(true);
  });

  it("is false when due in the future", () => {
    expect(isDueTodayOrOverdue(due({ date: "2026-08-23" }), NOW, LA)).toBe(false);
  });
});

describe("isOverdue", () => {
  it("is false for no due date", () => {
    expect(isOverdue(null, NOW, LA)).toBe(false);
  });

  describe("date-only due dates", () => {
    it("is overdue once the calendar date has passed", () => {
      expect(isOverdue(due({ date: "2026-08-21" }), NOW, LA)).toBe(true);
    });

    it("is not overdue when due today with no time set", () => {
      expect(isOverdue(due({ date: "2026-08-22" }), NOW, LA)).toBe(false);
    });

    it("is not overdue when due in the future", () => {
      expect(isOverdue(due({ date: "2026-08-23" }), NOW, LA)).toBe(false);
    });
  });

  describe("due dates with an explicit UTC offset", () => {
    it("is overdue once that instant has passed", () => {
      expect(isOverdue(due({ date: "2026-08-22T11:00:00Z" }), NOW, LA)).toBe(true);
    });

    it("is not overdue before that instant", () => {
      expect(isOverdue(due({ date: "2026-08-22T13:00:00Z" }), NOW, LA)).toBe(false);
    });
  });

  describe("floating due times (due.timezone is null)", () => {
    it("treats the naive time as wall-clock time in the fallback (account) timezone", () => {
      // 04:00 local LA time is 11:00 UTC -> before NOW (12:00 UTC) -> overdue
      expect(isOverdue(due({ date: "2026-08-22T04:00:00", timezone: null }), NOW, LA)).toBe(true);
      // 06:00 local LA time is 13:00 UTC -> after NOW -> not overdue
      expect(isOverdue(due({ date: "2026-08-22T06:00:00", timezone: null }), NOW, LA)).toBe(false);
    });
  });

  describe("due times anchored to a specific IANA zone", () => {
    it("converts using that zone rather than the fallback timezone", () => {
      // 07:00 in America/New_York (EDT, UTC-4) is 11:00 UTC -> before NOW -> overdue
      expect(isOverdue(due({ date: "2026-08-22T07:00:00", timezone: "America/New_York" }), NOW, LA)).toBe(true);
      // 09:00 in America/New_York is 13:00 UTC -> after NOW -> not overdue
      expect(isOverdue(due({ date: "2026-08-22T09:00:00", timezone: "America/New_York" }), NOW, LA)).toBe(false);
    });
  });

  describe("an invalid due.timezone (not a real IANA zone name)", () => {
    // Regression: due.timezone comes straight from Todoist, unvalidated —
    // Intl.DateTimeFormat throws a RangeError on a bad zone name, which used to
    // propagate straight out of isOverdue/dueTimeMinutes for whichever single
    // chore had it. It must degrade to the fallback timezone instead, the same
    // as a null/floating timezone already does, not throw and take down the
    // whole /api/chores response for every kid over one malformed chore.
    it("falls back to the fallback timezone instead of throwing", () => {
      expect(() => isOverdue(due({ date: "2026-08-22T04:00:00", timezone: "Not/A_Real_Zone" }), NOW, LA)).not.toThrow();
      // Same result as the floating-timezone (null) case above: 04:00 local LA
      // time is 11:00 UTC -> before NOW (12:00 UTC) -> overdue.
      expect(isOverdue(due({ date: "2026-08-22T04:00:00", timezone: "Not/A_Real_Zone" }), NOW, LA)).toBe(true);
    });
  });
});

describe("dueTimeMinutes", () => {
  it("is null for no due date", () => {
    expect(dueTimeMinutes(null, LA)).toBeNull();
  });

  it("is null for a date-only due date (no time component)", () => {
    expect(dueTimeMinutes(due({ date: "2026-08-22" }), LA)).toBeNull();
  });

  it("reports minutes since local midnight for a floating due time", () => {
    // 04:00 local LA time
    expect(dueTimeMinutes(due({ date: "2026-08-22T04:00:00", timezone: null }), LA)).toBe(4 * 60);
    // 13:30 local LA time
    expect(dueTimeMinutes(due({ date: "2026-08-22T13:30:00", timezone: null }), LA)).toBe(13 * 60 + 30);
  });

  it("reports minutes in the target zone even for an explicit UTC-offset due date", () => {
    // 11:00 UTC is 04:00 in America/Los_Angeles (PDT, UTC-7)
    expect(dueTimeMinutes(due({ date: "2026-08-22T11:00:00Z" }), LA)).toBe(4 * 60);
  });

  it("reports minutes in the target zone, not the due date's own IANA zone", () => {
    // 07:00 in America/New_York (EDT, UTC-4) is 04:00 in America/Los_Angeles
    expect(dueTimeMinutes(due({ date: "2026-08-22T07:00:00", timezone: "America/New_York" }), LA)).toBe(4 * 60);
  });
});

describe("daysOverdue", () => {
  it("is 0 for no due date, a future date, today, and a chore only hours late today", () => {
    expect(daysOverdue(null, NOW, LA)).toBe(0);
    expect(daysOverdue(due({ date: "2026-08-23" }), NOW, LA)).toBe(0);
    expect(daysOverdue(due({ date: "2026-08-22" }), NOW, LA)).toBe(0);
    expect(daysOverdue(due({ date: "2026-08-22T01:00:00" }), NOW, LA)).toBe(0);
  });

  it("counts whole calendar days in the given zone (not UTC)", () => {
    expect(daysOverdue(due({ date: "2026-08-21T21:00:00" }), NOW, LA)).toBe(1);
    expect(daysOverdue(due({ date: "2026-08-19" }), NOW, LA)).toBe(3);
    // 2026-08-23T03:00Z is still Aug 22 in LA, so a chore due Aug 21 is 1 day late, not 2.
    expect(daysOverdue(due({ date: "2026-08-21" }), new Date("2026-08-23T03:00:00Z"), LA)).toBe(1);
  });

  it("isn't skewed by a DST change in between", () => {
    // US DST ended 2026-11-01; 2 calendar days either side of it is still 2.
    expect(daysOverdue(due({ date: "2026-10-31" }), new Date("2026-11-02T20:00:00Z"), LA)).toBe(2);
  });
});

describe("Intl.DateTimeFormat reuse (CPU-limit regression)", () => {
  // /api/chores once exceeded the Worker CPU limit because every helper call
  // built fresh formatters. Repeated calls must not construct new ones.
  it("does not construct new formatters on repeated calls for the same zone", () => {
    const d = due({ date: "2026-08-20T09:00:00", timezone: LA });
    const run = () => {
      isDueTodayOrOverdue(d, NOW, LA);
      isOverdue(d, NOW, LA);
      daysOverdue(d, NOW, LA);
      dueTimeMinutes(d, LA);
    };
    run(); // warm the caches
    const spy = vi.spyOn(Intl, "DateTimeFormat");
    for (let i = 0; i < 100; i++) run();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
