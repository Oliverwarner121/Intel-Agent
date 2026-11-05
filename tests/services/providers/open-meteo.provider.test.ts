import { afterEach, describe, expect, it, vi } from "vitest";
import { weatherLocations } from "@/config/weather-locations";
import { createOpenMeteoProvider } from "@/services/providers/weather/open-meteo.provider";
import { runBriefing, summariseRun } from "@/services/orchestration/briefing-orchestrator.service";
import { renderBriefingEmail } from "@/services/delivery/email-renderer";
import { createBriefingDependencies } from "@/services/orchestration/dependencies";
import type { WeatherProvider } from "@/types/briefing";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
afterEach(() => vi.useRealTimers());

function payload(date = "2026-11-05") {
  return {
    timezone: "Europe/London",
    daily_units: {
      time: "iso8601", weather_code: "wmo code", temperature_2m_min: "\u00b0C", temperature_2m_max: "\u00b0C",
      precipitation_probability_max: "%", wind_speed_10m_max: "km/h",
    },
    daily: {
      time: [date], weather_code: [3], temperature_2m_min: [4.5], temperature_2m_max: [12],
      precipitation_probability_max: [0] as (number | null)[],
      wind_speed_10m_max: [0] as (number | null)[],
    },
  };
}
function context(date = "2026-11-05"): Parameters<WeatherProvider>[0] {
  return {
    now: new Date(`${date}T05:00:00Z`), reportingDate: date, timezone: "Europe/London",
    signal: new AbortController().signal, locationIds: weatherLocations.map((location) => location.id),
  };
}

describe("Open-Meteo provider", () => {
  it("queries the three verified coordinates concurrently and preserves configured order", async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
      calls++;
      if (calls === 3) release();
      await barrier;
      return Response.json(payload());
    });
    const results = await createOpenMeteoProvider(fetchImpl)(context());
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(results.map((result) => result.locationId)).toEqual(context().locationIds);
    for (const [index, [input, init]] of fetchImpl.mock.calls.entries()) {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe("https://api.open-meteo.com/v1/forecast");
      expect(url.searchParams.get("latitude")).toBe(String(weatherLocations[index]?.latitude));
      expect(url.searchParams.get("longitude")).toBe(String(weatherLocations[index]?.longitude));
      expect(url.searchParams.get("start_date")).toBe("2026-11-05");
      expect(url.searchParams.get("end_date")).toBe("2026-11-05");
      expect(url.searchParams.get("timezone")).toBe("Europe/London");
      expect(url.searchParams.get("temperature_unit")).toBe("celsius");
      expect(url.searchParams.get("wind_speed_unit")).toBe("kmh");
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(results[0]).toMatchObject({
      locationName: "Wheatley (Oxford)", summary: "Overcast", date: "2026-11-05",
      temperatureMinC: 4.5, temperatureMaxC: 12, precipitationProbabilityPercent: 0, windSpeedMaxKph: 0,
      attribution: { name: "Open-Meteo", url: "https://open-meteo.com/" },
    });
  });

  it.each(["2026-07-01", "2026-03-29", "2026-10-25"])("requests the exact local date on %s", async (date) => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(payload(date)));
    const results = await createOpenMeteoProvider(fetchImpl)(context(date));
    expect(results.every((result) => result.date === date && !("unavailableReason" in result))).toBe(true);
    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.searchParams.get("start_date")).toBe(date);
    expect(url.searchParams.get("end_date")).toBe(date);
  });

  it.each([
    [0, "Clear sky"], [48, "Depositing rime fog"], [65, "Heavy rain"], [75, "Heavy snowfall"],
    [82, "Violent rain showers"], [99, "Thunderstorm with heavy hail"],
  ])("converts WMO %i to %s", async (code, description) => {
    const data = payload();
    data.daily.weather_code = [Number(code)];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(data));
    const results = await createOpenMeteoProvider(fetchImpl)(context());
    expect(results[0]).toMatchObject({ summary: description });
  });

  it("leaves null optional values unavailable instead of inventing zero", async () => {
    const data = payload();
    data.daily.precipitation_probability_max = [null];
    data.daily.wind_speed_10m_max = [null];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(data));
    const results = await createOpenMeteoProvider(fetchImpl)(context());
    expect(results[0]).not.toHaveProperty("precipitationProbabilityPercent");
    expect(results[0]).not.toHaveProperty("windSpeedMaxKph");
    expect(results[0]).not.toHaveProperty("unavailableReason");
  });

  it.each(["units", "range", "date", "empty", "length", "null-temperature", "unknown-code", "probability"])(
    "reports invalid %s without hiding the other locations",
    async (variant) => {
      const data = payload();
      if (variant === "units") data.daily_units.temperature_2m_min = "F";
      if (variant === "range") data.daily.temperature_2m_min = [50];
      if (variant === "date") data.daily.time = ["2026-11-06"];
      if (variant === "empty") data.daily.time = [];
      if (variant === "length") data.daily.temperature_2m_min = [1, 2];
      if (variant === "unknown-code") data.daily.weather_code = [123];
      if (variant === "probability") data.daily.precipitation_probability_max = [101];
      const body = variant === "null-temperature"
        ? { ...data, daily: { ...data.daily, temperature_2m_min: [null] } } : data;
      const fetchImpl = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(body))
        .mockImplementation(async () => Response.json(payload()));
      const results = await createOpenMeteoProvider(fetchImpl)(context());
      expect(results[0]).toHaveProperty("unavailableReason");
      expect(results.slice(1).every((result) => !("unavailableReason" in result))).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    },
  );

  it("reports permanent HTTP failures once and discards sensitive response text", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response("private-response", { status: 403 }));
    const results = await createOpenMeteoProvider(fetchImpl)(context());
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(results.every((result) => "unavailableReason" in result)).toBe(true);
    expect(JSON.stringify(results)).toContain("HTTP 403");
    expect(JSON.stringify(results)).not.toContain("private-response");
  });

  it.each([429, 503])("bounds transient HTTP %i retries", async (status) => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response("", { status }));
    const result = createOpenMeteoProvider(fetchImpl)(context());
    await vi.runAllTimersAsync();
    expect((await result).every((location) => "unavailableReason" in location)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it("bounds network retries and recovers transient errors", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("private details"))
      .mockImplementation(async () => Response.json(payload()));
    const result = createOpenMeteoProvider(fetchImpl)(context());
    await vi.runAllTimersAsync();
    expect((await result).every((location) => !("unavailableReason" in location))).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("propagates cancellation with no retries", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      init?.signal?.throwIfAborted();
      throw new Error("expected aborted signal");
    });
    const results = await createOpenMeteoProvider(fetchImpl)({ ...context(), signal: controller.signal });
    expect(JSON.stringify(results)).toContain("Request aborted");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("times out each attempt and retries at most once within the section budget", async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("private transport details")), { once: true });
    }));
    try {
      const started = Date.now();
      const pending = createOpenMeteoProvider(fetchImpl)(context());
      await vi.runAllTimersAsync();
      expect(JSON.stringify(await pending)).toContain("Request timed out");
      expect(Date.now() - started).toBe(12_250);
      expect(fetchImpl).toHaveBeenCalledTimes(6);
      expect(timeoutSpy).toHaveBeenCalledWith(6_000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("rejects oversized payloads without retrying", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
      ...payload(), padding: "x".repeat(33_000),
    }));
    const results = await createOpenMeteoProvider(fetchImpl)(context());
    expect(JSON.stringify(results)).toContain("Response exceeded the size limit");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("rejects unknown or duplicate locations and invalid dates before fetching", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    for (const invalid of [
      { locationIds: ["unknown"] }, { locationIds: ["wheatley", "wheatley"] }, { locationIds: [] },
      { reportingDate: "2026-02-30" }, { timezone: "UTC" },
    ]) {
      await expect(createOpenMeteoProvider(fetchImpl)({ ...context(), ...invalid })).rejects.toThrow();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("weather orchestration and rendering", () => {
  it("keeps successful locations, reports partial status and renders attribution and limitations", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 403 }))
      .mockImplementation(async () => Response.json(payload()));
    const run = await runBriefing("morning-briefing", "preview", {
      now: () => context().now,
      providers: {
        calendar: { "google-calendar": async () => [] },
        weather: { "open-meteo": createOpenMeteoProvider(fetchImpl) },
        news: { rss: async () => [] },
      },
    });
    expect(run.status).toBe("completed-with-gaps");
    const summary = summariseRun(run);
    expect(summary.sections[1]).toMatchObject({
      id: "weather", status: "partial", items: 2,
      locations: [
        { id: "wheatley", status: "unavailable" },
        { id: "wotton-under-edge", status: "ok" },
        { id: "lower-earley", status: "ok" },
      ],
    });
    expect(JSON.stringify(summary)).not.toContain("temperature");
    if (!run.briefing) throw new Error("Missing briefing");
    const rendered = renderBriefingEmail(run.briefing, "morning-briefing");
    for (const output of [rendered.html, rendered.text]) {
      expect(output).toContain("Wheatley (Oxford): Data unavailable:");
      expect(output).toContain("Wotton-under-Edge: Overcast");
      expect(output).toContain("Lower Earley: Overcast");
      expect(output).toContain("https://open-meteo.com/");
      expect(output).toContain("https://creativecommons.org/licenses/by/4.0/");
      expect(output).toContain("Official weather warnings are not supplied");
    }
  });

  it("reports all location failures as unavailable, not an empty successful forecast", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response("", { status: 403 }));
    const run = await runBriefing("morning-briefing", "preview", {
      now: () => context().now,
      providers: { calendar: {}, weather: { "open-meteo": createOpenMeteoProvider(fetchImpl) }, news: {} },
    });
    expect(run.briefing?.sections[1]?.outcome).toMatchObject({
      status: "unavailable", reason: expect.stringContaining("Wheatley (Oxford):"),
    });
    expect(run.status).toBe("completed-with-gaps");
  });

  it("registers weather without API credentials", () => {
    expect(createBriefingDependencies({ APP_ENV: "dev", CRON_SECRET: "x".repeat(32) }).providers.weather["open-meteo"]).toBeTypeOf("function");
  });
});
