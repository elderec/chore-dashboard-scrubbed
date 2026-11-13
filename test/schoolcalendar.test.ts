import { describe, it, expect, vi, afterEach } from "vitest";
import { loadSchoolCalendar } from "../src/schoolcalendar";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Minimal stand-in for the ASSETS Fetcher binding — resolves a fixed body/status
 * regardless of the requested path (loadSchoolCalendar only ever asks for one file). */
function fakeAssets(body: string, status = 200): Fetcher {
  return {
    fetch: vi.fn(async () => new Response(body, { status })),
  } as unknown as Fetcher;
}

const FILE = JSON.stringify({
  skipDates: ["2026-11-11", "2026-11-26", "not-a-date", 20261225],
  labels: { "2026-11-11": "Veterans Day", "2026-11-26": "Fall Break", "2026-11-26": "Fall Break" },
});

describe("loadSchoolCalendar", () => {
  it("reads and parses the bundled asset, keeping only YYYY-MM-DD string dates", async () => {
    const cal = await loadSchoolCalendar({ ASSETS: fakeAssets(FILE) });

    expect(cal.has("2026-11-11")).toBe(true);
    expect(cal.has("2026-11-26")).toBe(true);
    expect(cal.has("not-a-date")).toBe(false); // wrong shape — dropped
    expect(cal.has("2026-12-25")).toBe(false); // was a number in the file — dropped
    expect(cal.labelFor("2026-11-11")).toBe("Veterans Day");
    expect(cal.labelFor("2026-12-25")).toBe(null);
  });

  it("prefers SCHOOL_SKIP_CALENDAR_URL over the asset when set", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ skipDates: ["2027-01-18"] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const assets = fakeAssets(FILE);

    const cal = await loadSchoolCalendar({
      ASSETS: assets,
      SCHOOL_SKIP_CALENDAR_URL: "https://example.com/cal.json",
    });

    expect(cal.has("2027-01-18")).toBe(true);
    expect(cal.has("2026-11-11")).toBe(false); // came from the URL, not the bundled file
    expect(assets.fetch).not.toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://example.com/cal.json");
  });

  it("fails open (empty calendar, logged) when the asset returns non-2xx", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cal = await loadSchoolCalendar({ ASSETS: fakeAssets("nope", 404) });
    expect(cal.has("2026-11-11")).toBe(false);
  });

  it("fails open on malformed JSON", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cal = await loadSchoolCalendar({ ASSETS: fakeAssets("{ not json") });
    expect(cal.has("2026-11-11")).toBe(false);
  });

  it("fails open on a URL fetch failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("", { status: 500 })));
    const cal = await loadSchoolCalendar({ SCHOOL_SKIP_CALENDAR_URL: "https://example.com/cal.json" });
    expect(cal.has("2027-01-18")).toBe(false);
  });

  it("is an empty calendar when neither ASSETS nor a URL is available", async () => {
    const cal = await loadSchoolCalendar({});
    expect(cal.has("2026-11-11")).toBe(false);
    expect(cal.labelFor("2026-11-11")).toBe(null);
  });

  it("tolerates a missing or non-array skipDates / non-object labels", async () => {
    const cal = await loadSchoolCalendar({ ASSETS: fakeAssets(JSON.stringify({ skipDates: "nope", labels: 5 })) });
    expect(cal.has("2026-11-11")).toBe(false);
    expect(cal.labelFor("2026-11-11")).toBe(null);
  });

  describe("term window", () => {
    const WINDOWED = JSON.stringify({
      termStart: "2026-08-25",
      termEnd: "2027-06-10",
      skipDates: ["2026-11-11"],
      labels: { "2026-11-11": "Veterans Day" },
    });

    it("treats any date outside [termStart, termEnd] as no-school, labelled 'Summer break'", async () => {
      const cal = await loadSchoolCalendar({ ASSETS: fakeAssets(WINDOWED) });

      expect(cal.has("2026-08-24")).toBe(true); // day before term starts
      expect(cal.has("2027-06-11")).toBe(true); // day after term ends (also a skipDate in reality)
      expect(cal.has("2027-07-15")).toBe(true); // deep summer
      expect(cal.labelFor("2027-07-15")).toBe("Summer break");
      expect(cal.labelFor("2026-08-24")).toBe("Summer break");
    });

    it("still respects skipDates and their labels inside the term window", async () => {
      const cal = await loadSchoolCalendar({ ASSETS: fakeAssets(WINDOWED) });

      expect(cal.has("2026-11-11")).toBe(true);
      expect(cal.labelFor("2026-11-11")).toBe("Veterans Day"); // not "Summer break"
      expect(cal.has("2026-12-01")).toBe(false); // in term, not a skipDate
      expect(cal.labelFor("2026-12-01")).toBe(null);
    });

    it("ignores the window entirely when termStart/termEnd are absent (today's behaviour)", async () => {
      const cal = await loadSchoolCalendar({ ASSETS: fakeAssets(JSON.stringify({ skipDates: ["2026-11-11"] })) });
      expect(cal.has("2027-07-15")).toBe(false);
    });

    it("ignores a malformed or inverted window", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const bad = await loadSchoolCalendar({
        ASSETS: fakeAssets(JSON.stringify({ termStart: "nope", termEnd: "2027-06-10", skipDates: [] })),
      });
      expect(bad.has("2020-01-01")).toBe(false); // termStart dropped → only termEnd active... but termEnd alone still applies
      expect(bad.has("2099-01-01")).toBe(true); // after termEnd

      const inverted = await loadSchoolCalendar({
        ASSETS: fakeAssets(JSON.stringify({ termStart: "2027-06-10", termEnd: "2026-08-25", skipDates: [] })),
      });
      expect(inverted.has("2026-01-01")).toBe(false); // both dropped → window disabled
      expect(inverted.has("2099-01-01")).toBe(false);
    });

    it("applies just one side of the window when only one bound is valid", async () => {
      const cal = await loadSchoolCalendar({
        ASSETS: fakeAssets(JSON.stringify({ termStart: "2026-08-25", skipDates: [] })),
      });
      expect(cal.has("2026-08-01")).toBe(true); // before termStart
      expect(cal.has("2027-07-01")).toBe(false); // no termEnd → summer not covered on that side
    });
  });
});
