import { describe, expect, it, vi } from "vitest";
import { getBriefingDefinition } from "@/briefings/registry";
import { deliveryKey } from "@/services/delivery/delivery-key";
import {
  UnknownBriefingError,
  runBriefing,
  summariseRun,
  type OrchestratorDependencies,
} from "@/services/orchestration/briefing-orchestrator.service";
import {
  SafeError,
  type BriefingDelivery,
  type CalendarProvider,
  type NewsProvider,
  type WeatherProvider,
} from "@/types/briefing";
import type { NewsStory } from "@/types/news";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const NOW = new Date("2026-07-01T05:15:00Z");

const calendar: CalendarProvider = async () => [
  { id: "1", title: "Private meeting", timing: { kind: "timed", start: "2026-07-01T09:00:00+01:00", end: "2026-07-01T10:00:00+01:00" } },
];
const weather: WeatherProvider = async ({ locationIds }) =>
  locationIds.map((locationId) => ({
    locationId,
    locationName: locationId,
    date: "2026-07-01",
    summary: "Sunny",
    temperatureMinC: 12,
    temperatureMaxC: 22,
  }));
const story = (category: NewsStory["category"], index: number): NewsStory => ({
  title: `Story ${index}`,
  url: `https://news.example/${category}/${index}`,
  publisher: "Example",
  publishedAt: "2026-07-01T04:00:00Z",
  category,
});
const news: NewsProvider = async ({ category }) => [1, 2, 3, 4, 5].map((index) => story(category, index));

function deps(overrides: Partial<OrchestratorDependencies> = {}): OrchestratorDependencies {
  return {
    providers: { calendar: { "google-calendar": calendar }, weather: { "open-meteo": weather }, news: { rss: news } },
    now: () => NOW,
    createRunId: () => "run-1",
    sectionTimeoutMs: 50,
    ...overrides,
  };
}

describe("runBriefing", () => {
  it("collects every section in definition order using the London reporting date", async () => {
    const calendarSpy = vi.fn(calendar);
    const run = await runBriefing(
      "morning-briefing",
      "preview",
      deps({ providers: { calendar: { "google-calendar": calendarSpy }, weather: { "open-meteo": weather }, news: { rss: news } } }),
    );
    expect(run.status).toBe("completed");
    expect(run.reportingDate).toBe("2026-07-01");
    expect(run.briefing?.sections.map((section) => section.id)).toEqual([
      "calendar",
      "weather",
      "tech-ai",
      "uk-politics-finance",
      "global-affairs",
    ]);
    const period = calendarSpy.mock.calls[0]?.[0].period;
    expect(period?.start.toISOString()).toBe("2026-06-30T23:00:00.000Z");
    expect(period?.end.toISOString()).toBe("2026-07-01T23:00:00.000Z");
  });

  it("passes each news section its category and a 24-hour window, capping stories at three", async () => {
    const newsSpy = vi.fn(news);
    const run = await runBriefing(
      "morning-briefing",
      "preview",
      deps({ providers: { calendar: { "google-calendar": calendar }, weather: { "open-meteo": weather }, news: { rss: newsSpy } } }),
    );
    expect(newsSpy.mock.calls.map(([request]) => request.category)).toEqual([
      "tech-ai",
      "uk-politics-finance",
      "global-affairs",
    ]);
    expect(newsSpy.mock.calls[0]?.[0].window.start.toISOString()).toBe("2026-06-30T05:15:00.000Z");
    for (const section of run.briefing?.sections ?? []) {
      if (section.kind === "news" && section.outcome.status === "ok") expect(section.outcome.data).toHaveLength(3);
    }
  });

  it("isolates failures, timeouts and missing providers while keeping other sections", async () => {
    const run = await runBriefing(
      "morning-briefing",
      "preview",
      deps({
        providers: {
          calendar: { "google-calendar": async () => Promise.reject(new Error("token=abc123 leaked")) },
          weather: { "open-meteo": () => new Promise(() => undefined) },
          news: {},
        },
      }),
    );
    expect(run.status).toBe("completed-with-gaps");
    const outcomes = Object.fromEntries((run.briefing?.sections ?? []).map((section) => [section.id, section.outcome]));
    expect(outcomes.calendar).toEqual({ status: "unavailable", reason: "Provider request failed" });
    expect(outcomes.weather).toEqual({ status: "unavailable", reason: "Timed out after 50 ms" });
    expect(outcomes["tech-ai"]).toEqual({ status: "unavailable", reason: 'Provider "rss" is not configured' });
    expect(JSON.stringify(run)).not.toContain("abc123");
  });

  it("distinguishes an empty calendar from an unavailable one", async () => {
    const run = await runBriefing(
      "morning-briefing",
      "preview",
      deps({ providers: { calendar: { "google-calendar": async () => [] }, weather: { "open-meteo": weather }, news: { rss: news } } }),
    );
    expect(run.briefing?.sections[0]?.outcome).toEqual({ status: "ok", data: [] });
    expect(run.status).toBe("completed");
  });

  it("never delivers in preview mode", async () => {
    const delivery = vi.fn<BriefingDelivery>();
    const run = await runBriefing("morning-briefing", "preview", deps({ delivery }));
    expect(delivery).not.toHaveBeenCalled();
    expect(run.delivery).toEqual({ status: "skipped", reason: "Preview mode" });
  });

  it("skips sending when delivery is not configured", async () => {
    const run = await runBriefing("morning-briefing", "send", deps());
    expect(run.delivery).toEqual({ status: "skipped", reason: "Delivery is not configured" });
  });

  it("delivers exactly once and reports failures without retrying", async () => {
    const delivery = vi.fn<BriefingDelivery>().mockResolvedValue({ messageId: "msg-1" });
    const sent = await runBriefing("morning-briefing", "send", deps({ delivery }));
    expect(delivery).toHaveBeenCalledTimes(1);
    expect(delivery.mock.calls[0]?.[0]).toMatchObject({ subject: "Your Intel-Agent morning briefing", template: "morning-briefing" });
    expect(sent.delivery).toEqual({ status: "sent", messageId: "msg-1" });

    const failing = vi.fn<BriefingDelivery>().mockRejectedValue(new Error("api key re_secret"));
    const failed = await runBriefing("morning-briefing", "send", deps({ delivery: failing }));
    expect(failing).toHaveBeenCalledTimes(1);
    expect(failed.status).toBe("delivery-failed");
    expect(failed.delivery).toEqual({ status: "failed", reason: "Delivery failed" });

    const safe = vi.fn<BriefingDelivery>().mockRejectedValue(new SafeError("Idempotency conflict"));
    expect((await runBriefing("morning-briefing", "send", deps({ delivery: safe }))).delivery).toEqual({
      status: "failed",
      reason: "Idempotency conflict",
    });
  });

  it("skips disabled briefings without calling providers", async () => {
    const definition = getBriefingDefinition("morning-briefing");
    if (!definition) throw new Error("missing definition");
    const calendarSpy = vi.fn(calendar);
    const run = await runBriefing(
      "morning-briefing",
      "send",
      deps({
        getDefinition: () => ({ ...definition, enabled: false }),
        providers: { calendar: { "google-calendar": calendarSpy }, weather: {}, news: {} },
      }),
    );
    expect(run.status).toBe("disabled");
    expect(calendarSpy).not.toHaveBeenCalled();
  });

  it("rejects unknown briefings", async () => {
    await expect(runBriefing("nope", "preview", deps())).rejects.toBeInstanceOf(UnknownBriefingError);
  });

  it("summarises runs with counts only, never section contents", async () => {
    const run = await runBriefing("morning-briefing", "preview", deps());
    const summary = summariseRun(run);
    expect(summary.sections[0]).toEqual({ id: "calendar", status: "ok", items: 1 });
    expect(JSON.stringify(summary)).not.toContain("Private meeting");
  });
});

describe("deliveryKey", () => {
  it("is stable per briefing, date and recipient and hides the address", () => {
    const key = deliveryKey("morning-briefing", "2026-07-01", " Me@Example.com ");
    expect(key).toBe(deliveryKey("morning-briefing", "2026-07-01", "me@example.com"));
    expect(key).toMatch(/^morning-briefing\/2026-07-01\/[0-9a-f]{16}$/);
    expect(key).not.toContain("example");
    expect(deliveryKey("morning-briefing", "2026-07-02", "me@example.com")).not.toBe(key);
  });
});
