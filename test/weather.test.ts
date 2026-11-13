import { describe, it, expect, vi, afterEach } from "vitest";
import { getDailyForecast } from "../src/weather";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("getDailyForecast", () => {
  it("requests today's daily fields for the lat/lon with the day boundary drawn in the given zone", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, {
        daily: {
          time: ["2026-09-07"],
          precipitation_sum: [12.3],
          precipitation_hours: [8],
          snowfall_sum: [2.5],
          weather_code: [73],
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await getDailyForecast(40.7128, -74.006, "America/New_York");

    expect(result).toEqual({ date: "2026-09-07", sumMm: 12.3, hours: 8, snowfallCm: 2.5, weatherCode: 73 });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("https://api.open-meteo.com/v1/forecast");
    expect(url).toContain("latitude=40.7128");
    expect(url).toContain("longitude=-74.006");
    expect(url).toContain("daily=precipitation_sum,precipitation_hours,snowfall_sum,weather_code");
    expect(url).toContain("timezone=America%2FNew_York");
    expect(url).toContain("forecast_days=1");
    expect(url).toContain("precipitation_unit=mm");
  });

  it("defaults every missing number to 0 rather than NaN/undefined", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse(200, { daily: { time: ["2026-09-07"] } })));

    const result = await getDailyForecast(1, 2, "America/New_York");

    expect(result).toEqual({ date: "2026-09-07", sumMm: 0, hours: 0, snowfallCm: 0, weatherCode: 0 });
  });

  it("throws on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("nope", { status: 500 })));
    await expect(getDailyForecast(1, 2, "America/New_York")).rejects.toThrow();
  });

  it("throws when the response has no daily block", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse(200, {})));
    await expect(getDailyForecast(1, 2, "America/New_York")).rejects.toThrow();
  });

  it("throws a plain Error (not a hang) when Open-Meteo never responds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = getDailyForecast(1, 2, "America/New_York");
    const assertion = expect(resultPromise).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;

    vi.useRealTimers();
  });
});
