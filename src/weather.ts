const FORECAST_BASE = "https://api.open-meteo.com/v1/forecast";
const REQUEST_TIMEOUT_MS = 10_000;

export interface DailyForecast {
  /** "YYYY-MM-DD" — Open-Meteo's own label for the day, with the day boundary
   * drawn in the timeZone passed to getDailyForecast. */
  date: string;
  /** Total precipitation for the day, in millimetres. */
  sumMm: number;
  /** Number of hours in the day with precipitation. */
  hours: number;
  /** Total snowfall for the day, in centimetres. */
  snowfallCm: number;
  /** WMO weather code — the day's dominant condition. See
   * https://open-meteo.com/en/docs#weathervariables (56/57 freezing drizzle,
   * 66/67 freezing rain, 71/73/75/77 snow, 85/86 snow showers). */
  weatherCode: number;
}

/** Today's forecast for a lat/lon, with the day boundary drawn in `timeZone` so
 * "today" here matches the Worker's own TIMEZONE-based day. Throws on a non-2xx
 * response, a timeout, or a body with no `daily` block — callers (the rain-skip
 * check, the snow-day reminder in index.ts) treat any throw as "don't act". No
 * shared client with todoist.ts on purpose: different API, no auth, its own error
 * handling — same reasoning telegram.ts is its own small module. */
export async function getDailyForecast(lat: number, lon: number, timeZone: string): Promise<DailyForecast> {
  const url =
    `${FORECAST_BASE}?latitude=${lat}&longitude=${lon}` +
    "&daily=precipitation_sum,precipitation_hours,snowfall_sum,weather_code" +
    `&timezone=${encodeURIComponent(timeZone)}` +
    "&forecast_days=1&precipitation_unit=mm";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Open-Meteo forecast timed out after ${REQUEST_TIMEOUT_MS}ms`, { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new Error(`Open-Meteo forecast failed: ${res.status}`);
  }

  const body = (await res.json()) as {
    daily?: {
      time?: string[];
      precipitation_sum?: number[];
      precipitation_hours?: number[];
      snowfall_sum?: number[];
      weather_code?: number[];
    };
  };
  const daily = body.daily;
  if (!daily?.time?.length) {
    throw new Error("Open-Meteo forecast: response had no daily data");
  }

  return {
    date: daily.time[0],
    sumMm: daily.precipitation_sum?.[0] ?? 0,
    hours: daily.precipitation_hours?.[0] ?? 0,
    snowfallCm: daily.snowfall_sum?.[0] ?? 0,
    weatherCode: daily.weather_code?.[0] ?? 0,
  };
}
