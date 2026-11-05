import { afterEach, describe, expect, it, vi } from "vitest";
import { parseWarningFeed, withMetOfficeWarnings } from "@/services/providers/weather/met-office-warnings.provider";
import { runBriefing, summariseRun } from "@/services/orchestration/briefing-orchestrator.service";
import { renderBriefingEmail } from "@/services/delivery/email-renderer";
import type { WeatherProvider } from "@/types/briefing";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
afterEach(() => vi.useRealTimers());
const warning = `<item><title>Yellow warning of rain - check affected areas</title>
<link>https://www.metoffice.gov.uk/weather/warnings-and-advice/uk-warnings#example</link>
<pubDate>Thu, 05 Nov 2026 06:00:00 GMT</pubDate></item>`;
function feed(region: string, items = "") {
  return `<?xml version="1.0"?><rss version="2.0"><channel>
<title>Met Office warnings for ${region.replace("&", "&amp;")}</title>
<link>https://www.metoffice.gov.uk/weather/warnings-and-advice/uk-warnings</link>${items}</channel></rss>`;
}
const context = {
  now: new Date("2026-11-05T07:00:00Z"), reportingDate: "2026-11-05", timezone: "Europe/London",
  signal: new AbortController().signal, locationIds: ["wheatley", "wotton-under-edge", "lower-earley"],
};
const forecasts: WeatherProvider = async ({ locationIds }) => locationIds.map((locationId) => ({
  locationId, locationName: locationId, date: "2026-11-05", summary: "Clear",
  temperatureMinC: 4, temperatureMaxC: 10,
}));
function fetchFeeds(items = "") {
  return vi.fn<typeof fetch>().mockImplementation(async (input) => new Response(feed(
    String(input).endsWith("/se") ? "London & South East England" : "South West England", items,
  )));
}

describe("Met Office warning feed", () => {
  it("accepts genuine empty RSS as no listed warnings", () => {
    expect(parseWarningFeed(feed("South West England"), "South West England")).toEqual([]);
  });
  it("keeps original titles and direct links, normalises timestamps and deduplicates entries", () => {
    expect(parseWarningFeed(feed("South West England", warning + warning), "South West England")).toEqual([{
      title: "Yellow warning of rain - check affected areas",
      url: "https://www.metoffice.gov.uk/weather/warnings-and-advice/uk-warnings#example",
      publishedAt: "2026-11-05T06:00:00.000Z",
    }]);
  });
  it.each([
    "<html>Not RSS</html>", "<rss><channel>",
    '<!DOCTYPE rss [<!ENTITY test "bad">]><rss/>',
    feed("South West England", warning.replace("Thu, 05 Nov 2026 06:00:00 GMT", "invalid")),
    feed("South West England", warning.replace("https://www.metoffice.gov.uk/weather/warnings-and-advice/uk-warnings#example", "javascript:alert(1)")),
    feed("South West England", warning.replace("www.metoffice.gov.uk", "unapproved.example")),
    feed("Wrong region"),
  ])("rejects malformed, unsafe or wrong-region feeds", (xml) => {
    expect(() => parseWarningFeed(xml, "South West England")).toThrow();
  });
});

describe("regional warning collection", () => {
  it("fetches each region once and maps both South East towns to the same regional result", async () => {
    const fetchImpl = fetchFeeds(warning);
    const result = await withMetOfficeWarnings(forecasts, fetchImpl)(context);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.map((location) => location.warnings?.region)).toEqual([
      "London & South East England", "South West England", "London & South East England",
    ]);
    expect(result[0]?.warnings).toEqual(result[2]?.warnings);
    expect(result[0]?.warnings).toMatchObject({ status: "ok", checkedAt: context.now.toISOString(), warnings: [{ title: expect.stringContaining("Yellow") }] });
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      "https://www.metoffice.gov.uk/public/data/PWSCache/WarningsRSS/Region/se",
      "https://www.metoffice.gov.uk/public/data/PWSCache/WarningsRSS/Region/sw",
    ]);
  });

  it("keeps forecasts and the other region after a warning failure", async () => {
    const fetchImpl = fetchFeeds();
    fetchImpl.mockResolvedValueOnce(new Response("private details", { status: 403 }));
    const result = await withMetOfficeWarnings(forecasts, fetchImpl)(context);
    expect(result[0]?.warnings).toMatchObject({ status: "unavailable", reason: expect.stringContaining("HTTP 403") });
    expect(result[1]?.warnings).toMatchObject({ status: "ok", warnings: [] });
    expect(result.every((location) => !("unavailableReason" in location))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private details");
  });

  it("never converts an invalid feed into no warnings", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response("<html>Oops</html>"));
    const result = await withMetOfficeWarnings(forecasts, fetchImpl)(context);
    expect(result.every((location) => location.warnings?.status === "unavailable")).toBe(true);
  });

  it("retries a transient failure only once per region", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response("", { status: 503 }));
    const pending = withMetOfficeWarnings(forecasts, fetchImpl)(context);
    await vi.runAllTimersAsync();
    expect((await pending).every((location) => location.warnings?.status === "unavailable")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("bounds XML response sizes and propagates cancellation", async () => {
    const large = vi.fn<typeof fetch>().mockImplementation(async () => new Response("x".repeat(131_073)));
    expect((await withMetOfficeWarnings(forecasts, large)(context))[0]?.warnings).toMatchObject({
      status: "unavailable", reason: expect.stringContaining("size limit"),
    });
    expect(large).toHaveBeenCalledTimes(2);
    const controller = new AbortController();
    controller.abort();
    const cancelled = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      init?.signal?.throwIfAborted();
      return new Response("");
    });
    expect((await withMetOfficeWarnings(forecasts, cancelled)({ ...context, signal: controller.signal }))[0]?.warnings).toMatchObject({
      status: "unavailable", reason: expect.stringContaining("aborted"),
    });
    expect(cancelled).toHaveBeenCalledTimes(2);
  });

  it("renders each region once with scope, attribution and direct warning links", async () => {
    const run = await runBriefing("morning-briefing", "preview", {
      now: () => context.now, providers: {
        calendar: { "google-calendar": async () => [] }, news: { rss: async () => [] },
        weather: { "open-meteo": withMetOfficeWarnings(forecasts, fetchFeeds(warning)) },
      },
    });
    expect(run.status).toBe("completed");
    expect(summariseRun(run).sections[1]).toMatchObject({ status: "ok", items: 3,
      locations: [{ warningsStatus: "ok" }, { warningsStatus: "ok" }, { warningsStatus: "ok" }] });
    if (!run.briefing) throw new Error("Missing briefing");
    const { html, text } = renderBriefingEmail(run.briefing, "morning-briefing");
    expect(text.match(/Met Office regional warnings/g)).toHaveLength(2);
    expect(text).toContain("Regional coverage may not affect your exact location");
    expect(text).toContain("Yellow warning of rain");
    expect(text).toContain("Open Government Licence v3.0");
    expect(html).toContain('href="https://www.metoffice.gov.uk/weather/warnings-and-advice/uk-warnings#example"');
    expect(html).not.toContain("Official weather warnings are not supplied");
  });

  it("combines empty regional listings without dropping either region", async () => {
    const run = await runBriefing("morning-briefing", "preview", {
      now: () => context.now, providers: {
        calendar: {}, news: {},
        weather: { "open-meteo": withMetOfficeWarnings(forecasts, fetchFeeds()) },
      },
    });
    if (!run.briefing) throw new Error("Missing briefing");
    const rendered = renderBriefingEmail(run.briefing, "morning-briefing");
    for (const output of [rendered.html, rendered.text]) {
      expect(output.match(/Met Office regional warnings/g)).toHaveLength(1);
      expect(output.match(/No warnings listed/g)).toHaveLength(1);
      expect(output).toContain("South West England");
      expect(output).toContain(output === rendered.html ? "London &amp; South East England" : "London & South East England");
      expect(output).toContain("when checked");
    }
  });

  it("marks warning failure partial and keeps forecasts visible", async () => {
    const fetchImpl = fetchFeeds();
    fetchImpl.mockResolvedValueOnce(new Response("", { status: 403 }));
    const run = await runBriefing("morning-briefing", "preview", {
      now: () => context.now, providers: {
        calendar: {}, news: {}, weather: { "open-meteo": withMetOfficeWarnings(forecasts, fetchImpl) },
      },
    });
    expect(run.status).toBe("completed-with-gaps");
    expect(summariseRun(run).sections[1]).toMatchObject({ status: "partial", items: 3 });
    if (!run.briefing) throw new Error("Missing briefing");
    const { text } = renderBriefingEmail(run.briefing, "morning-briefing");
    expect(text).toContain("Warnings unavailable:");
    expect(text).toContain("No warnings listed in this regional feed");
    expect(text).toContain("Clear");
  });

  it("preserves warnings even if every forecast fails", async () => {
    const unavailable: WeatherProvider = async ({ locationIds }) => locationIds.map((locationId) => ({
      locationId, locationName: locationId, date: context.reportingDate, unavailableReason: "Forecast unavailable",
    }));
    const run = await runBriefing("morning-briefing", "preview", {
      now: () => context.now, providers: {
        calendar: {}, news: {}, weather: { "open-meteo": withMetOfficeWarnings(unavailable, fetchFeeds(warning)) },
      },
    });
    expect(run.briefing?.sections[1]?.outcome.status).toBe("partial");
    if (!run.briefing) throw new Error("Missing briefing");
    expect(renderBriefingEmail(run.briefing, "morning-briefing").text).toContain("Yellow warning");
  });
});
