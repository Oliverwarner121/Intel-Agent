import { afterEach, describe, expect, it, vi } from "vitest";
import { localDayPeriod } from "@/lib/date";
import { createGoogleCalendarProvider, googleCalendarConfigFrom } from "@/services/providers/calendar/google-calendar.provider";
import { runBriefing, summariseRun } from "@/services/orchestration/briefing-orchestrator.service";
import { renderBriefingEmail } from "@/services/delivery/email-renderer";
import type { CalendarProvider } from "@/types/briefing";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
afterEach(() => vi.restoreAllMocks());

const config = {
  clientId: "id", clientSecret: "private-secret", refreshToken: "private-refresh",
  calendarId: "ignored", mode: "owned" as const,
};
const now = new Date("2026-11-05T05:00:00Z");
const context: Parameters<CalendarProvider>[0] = {
  now, period: localDayPeriod(now, "Europe/London"), reportingDate: "2026-11-05",
  timezone: "Europe/London", signal: new AbortController().signal,
};
const calendar = (id: string, extra = {}) => ({ id, summary: id, accessRole: "owner", ...extra });
const event = (id: string, hour = "09") => ({
  id, summary: "Private event",
  start: { dateTime: `2026-11-05T${hour}:00:00Z` },
  end: { dateTime: `2026-11-05T${hour}:30:00Z` },
});
function mockApi(
  lists: unknown[] = [{ items: [calendar("main", { primary: true }), calendar("gym")] }],
  events: (url: URL) => Response | Promise<Response> = () => Response.json({ items: [] }),
) {
  return vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "private-access" });
    if (url.pathname.endsWith("/calendarList")) return Response.json(lists.shift());
    return events(url);
  });
}
async function preview(fetchImpl: typeof fetch) {
  return runBriefing("morning-briefing", "preview", {
    now: () => now,
    providers: { calendar: { "google-calendar": createGoogleCalendarProvider(config, fetchImpl) }, weather: {}, news: {} },
  });
}

describe("owned calendars", () => {
  it("uses explicit owned mode without changing single-calendar defaults", () => {
    expect(googleCalendarConfigFrom({
      APP_ENV: "local", CRON_SECRET: "x".repeat(32), GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret", GOOGLE_REFRESH_TOKEN: "refresh", GOOGLE_CALENDAR_MODE: "owned",
    })).toMatchObject({ mode: "owned" });
  });

  it("discovers all pages, verifies ownership and excludes public/shared/deleted entries", async () => {
    const fetchImpl = mockApi([
      { items: [
        calendar("main", { primary: true }), calendar("gym", { summaryOverride: "Gym & exercise" }),
        calendar("holidays", { accessRole: "reader" }), calendar("shared", { accessRole: "writer" }),
        calendar("removed", { deleted: true }),
      ], nextPageToken: "page2" },
      { items: [calendar("hidden-owned", { hidden: true }), calendar("main", { primary: true })] },
    ], () => Response.json({ items: [event("same")] }));
    const result = await createGoogleCalendarProvider(config, fetchImpl)(context);
    if (Array.isArray(result)) throw new Error("Missing collection");
    expect(result.events).toHaveLength(3);
    expect(new Set(result.events.map((event) => event.id)).size).toBe(3);
    expect(result.events.map((event) => event.calendarName)).toEqual(["main", "Gym & exercise", "hidden-owned"]);
    expect(result.unavailableCalendars).toEqual([]);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes("oauth2.googleapis.com"))).toHaveLength(1);
    const urls = fetchImpl.mock.calls.map(([url]) => new URL(String(url)));
    const lists = urls.filter((url) => url.pathname.endsWith("/calendarList"));
    expect(lists[0]?.searchParams.get("minAccessRole")).toBe("owner");
    expect(lists[0]?.searchParams.get("showHidden")).toBe("true");
    expect(lists[1]?.searchParams.get("pageToken")).toBe("page2");
    expect(urls.filter((url) => url.pathname.endsWith("/events")).map((url) => url.pathname))
      .toEqual([
        "/calendar/v3/calendars/main/events", "/calendar/v3/calendars/gym/events",
        "/calendar/v3/calendars/hidden-owned/events",
      ]);
    expect(JSON.stringify(result)).not.toContain("private-access");
  });

  it("queries calendars concurrently, merges all-day first and deduplicates only within calendars", async () => {
    let started = 0;
    let release = () => {};
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = mockApi(undefined, async (url) => {
      started++;
      if (started === 2) release();
      await ready;
      return Response.json({ items: url.pathname.includes("/gym/")
        ? [event("same", "08"), event("same", "08"), {
          id: "all-day", summary: "Working location", eventType: "workingLocation",
          start: { date: "2026-11-05" }, end: { date: "2026-11-06" },
        }] : [event("same", "09")] });
    });
    const result = await createGoogleCalendarProvider(config, fetchImpl)(context);
    if (Array.isArray(result)) throw new Error("Missing collection");
    expect(result.events.map((event) => [event.calendarName, event.timing.kind]))
      .toEqual([["gym", "all-day"], ["gym", "timed"], ["main", "timed"]]);
  });

  it.each(["2026-03-29", "2026-10-25"])("shares correct London boundaries across calendars on %s", async (date) => {
    const fetchImpl = mockApi();
    const day = localDayPeriod(new Date(`${date}T05:00:00Z`), "Europe/London");
    await createGoogleCalendarProvider(config, fetchImpl)({ ...context, period: day, reportingDate: date });
    for (const [input] of fetchImpl.mock.calls.filter(([input]) => String(input).includes("/events?"))) {
      const url = new URL(String(input));
      expect(url.searchParams.get("timeMin")).toBe(day.start.toISOString());
      expect(url.searchParams.get("timeMax")).toBe(day.end.toISOString());
      expect(url.searchParams.get("singleEvents")).toBe("true");
    }
  });

  it("keeps successful events and privately reports a failed calendar without leaking names in summaries", async () => {
    const fetchImpl = mockApi(undefined, (url) => url.pathname.includes("/gym/")
      ? new Response("private raw payload", { status: 403 }) : Response.json({ items: [event("one")] }));
    const run = await preview(fetchImpl);
    expect(run.briefing?.sections[0]?.outcome).toMatchObject({
      status: "partial", data: [{ calendarName: "main" }],
      unavailableCalendars: [{ calendarName: "gym", reason: "Calendar retrieval failed (HTTP 403)" }],
    });
    if (!run.briefing) throw new Error("Missing model");
    const { html, text } = renderBriefingEmail(run.briefing, "morning-briefing");
    expect(text).toContain("[main]");
    expect(html).toContain("gym: Calendar unavailable or incomplete");
    const summary = JSON.stringify(summariseRun(run));
    expect(summary).not.toContain("gym");
    expect(summary).not.toContain("Private event");
    expect(summary).not.toContain("private raw payload");
    expect(summariseRun(run).sections[0]).toEqual({
      id: "calendar", status: "partial", items: 1, unavailableCalendars: 1,
    });
  });

  it("distinguishes successful empty calendars from failures and avoids claiming no events on a partial day", async () => {
    const complete = await preview(mockApi());
    expect(complete.briefing?.sections[0]?.outcome).toEqual({ status: "ok", data: [] });
    const partial = await preview(mockApi(undefined, (url) => url.pathname.includes("/gym/")
      ? new Response("", { status: 403 }) : Response.json({ items: [] })));
    if (!partial.briefing) throw new Error("Missing model");
    const text = renderBriefingEmail(partial.briefing, "morning-briefing").text;
    expect(text).toContain("No events retrieved from the available calendars.");
    expect(text).not.toContain("No events scheduled today.");
  });

  it("makes all-calendar failure unavailable, not an empty or successful day", async () => {
    const run = await preview(mockApi(undefined, () => new Response("", { status: 403 })));
    expect(run.briefing?.sections[0]?.outcome).toEqual({
      status: "unavailable", reason: "All 2 owned calendars were unavailable",
    });
  });

  it("preserves retrieved pages when later event pages fail or exhaust limits", async () => {
    const fetchImpl = mockApi(undefined, (url) => {
      const page = url.searchParams.get("pageToken");
      if (url.pathname.includes("/gym/")) return page ? new Response("", { status: 403 })
        : Response.json({ items: [event("gym-page1")], nextPageToken: "next" });
      return Response.json({ items: [event(page ?? "first")], nextPageToken: `${page ?? ""}x` });
    });
    const result = await createGoogleCalendarProvider(config, fetchImpl)(context);
    if (Array.isArray(result)) throw new Error("Missing collection");
    expect(result.events).toHaveLength(5);
    expect(result.unavailableCalendars).toHaveLength(2);
    expect(result.unavailableCalendars[0]?.reason).toContain("pagination limit");
    expect(result.unavailableCalendars[1]?.reason).toContain("403");
    expect(fetchImpl.mock.calls.filter(([input]) => String(input).includes("/main/events"))).toHaveLength(4);
  });

  it.each(["empty", "overflow", "pagination", "schema"])("fails discovery explicitly for %s", async (variant) => {
    const fetchImpl = mockApi(variant === "pagination"
      ? [{ items: [], nextPageToken: "again" }, { items: [], nextPageToken: "again" }]
      : [{ items: variant === "empty" ? [] : variant === "schema" ? [{ id: "malformed" }]
        : Array.from({ length: 21 }, (_, index) => calendar(`calendar-${index}`)) }]);
    await expect(createGoogleCalendarProvider(config, fetchImpl)(context)).rejects.toThrow();
    expect(fetchImpl.mock.calls.some(([input]) => String(input).includes("/events?"))).toBe(false);
  });

  it("does not retry discovery denial and never exposes raw responses", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) =>
      String(input).includes("oauth2.googleapis.com") ? Response.json({ access_token: "access" })
        : new Response("private-calendar-id", { status: 403 }));
    await expect(createGoogleCalendarProvider(config, fetchImpl)(context))
      .rejects.toThrow("Owned calendar discovery failed: Calendar retrieval failed (HTTP 403)");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("handles authentication failure before discovery without exposing tokens", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("private-refresh", { status: 401 }));
    await expect(createGoogleCalendarProvider(config, fetchImpl)(context)).rejects.toThrow("Google authorisation failed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("propagates parent cancellation into each active calendar request", async () => {
    const parent = new AbortController();
    const signals: AbortSignal[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "access" });
      if (url.pathname.endsWith("/calendarList")) return Response.json({ items: [calendar("main"), calendar("gym")] });
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error("Missing request signal");
        signals.push(signal);
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        if (signals.length === 2) parent.abort();
      });
    });
    await expect(createGoogleCalendarProvider(config, fetchImpl)({ ...context, signal: parent.signal }))
      .rejects.toThrow("All 2 owned calendars were unavailable");
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("retains a successful first page in single mode when a later page fails", async () => {
    const fetchImpl = mockApi([], (url) => url.searchParams.has("pageToken")
      ? new Response("", { status: 403 })
      : Response.json({ items: [event("one")], nextPageToken: "second" }));
    const result = await createGoogleCalendarProvider({ ...config, mode: "single" }, fetchImpl)(context);
    if (Array.isArray(result)) throw new Error("Missing partial collection");
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.calendarName).toBeUndefined();
    expect(result.events[0]?.id).toBe("one");
    expect(result.unavailableCalendars).toEqual([
      { calendarName: "Configured calendar", reason: "Calendar retrieval failed (HTTP 403)" },
    ]);
  });

  it("bounds transient retries and preserves successes when another calendar stalls", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "access" });
      if (url.pathname.endsWith("/calendarList")) return Response.json({ items: [calendar("main"), calendar("gym")] });
      if (url.pathname.includes("/main/")) return Response.json({ items: [event("one")] });
      return new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) reject(new Error("aborted"));
        else init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    try {
      const promise = createGoogleCalendarProvider(config, fetchImpl)(context);
      await vi.advanceTimersByTimeAsync(7_000);
      const result = await promise;
      if (Array.isArray(result)) throw new Error("Missing collection");
      expect(result.events).toHaveLength(1);
      expect(result.unavailableCalendars).toHaveLength(1);
      expect(fetchImpl.mock.calls.filter(([input]) => String(input).includes("/gym/events"))).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("escapes event calendar labels and failure names in HTML", async () => {
    const fetchImpl = mockApi([{ items: [
      calendar("main", { summary: "<script>owner</script>" }),
      calendar("gym", { summary: "<img>" }),
    ] }], (url) => url.pathname.includes("/gym/") ? new Response("", { status: 403 })
      : Response.json({ items: [event("1")] }));
    const run = await preview(fetchImpl);
    if (!run.briefing) throw new Error("Missing model");
    const html = renderBriefingEmail(run.briefing, "morning-briefing").html;
    expect(html).toContain('title="&lt;script&gt;owner&lt;/script&gt;"');
    expect(html).not.toContain("[&lt;script&gt;owner&lt;/script&gt;]");
    expect(html).toContain("&lt;img&gt;: Calendar unavailable");
    expect(html).not.toContain("<script>owner");
  });

  it("uses Google calendar colours as full HTML row backgrounds without repeated name labels", async () => {
    const fetchImpl = mockApi([{ items: [
      calendar("main", { summary: "Work", backgroundColor: "#Ab12EF" }),
      calendar("gym", { summary: "Exercise", backgroundColor: "#0088aa" }),
    ] }], () => Response.json({ items: [event("1")] }));
    const run = await preview(fetchImpl);
    if (!run.briefing) throw new Error("Missing model");
    const { html, text } = renderBriefingEmail(run.briefing, "morning-briefing");
    expect(html).toContain("background-color:#Ab12EF;color:#ffffff;padding:12px 14px");
    expect(html).toContain("background-color:#0088aa;color:#000000;padding:12px 14px");
    expect(html).toContain('title="Work"');
    expect(html).not.toContain("[Work]");
    expect(html).not.toContain("[Exercise]");
    expect(text).toContain("[Work]");
    expect(text).toContain("[Exercise]");
    const listCall = fetchImpl.mock.calls.find(([input]) => String(input).includes("/calendarList?"));
    expect(new URL(String(listCall?.[0])).searchParams.get("fields")).toContain("backgroundColor");
  });

  it("uses neutral row backgrounds when Google does not supply colours", async () => {
    const run = await preview(mockApi(undefined, () => Response.json({ items: [event("1")] })));
    if (!run.briefing) throw new Error("Missing model");
    expect(renderBriefingEmail(run.briefing, "morning-briefing").html).toContain("background-color:#657687;color:#ffffff");
  });

  it.each([
    ["#000000", "#ffffff"], ["#ffffff", "#000000"], ["#a4bdfc", "#000000"], ["#7ae7bf", "#000000"],
  ])("keeps text readable on %s calendar rows", async (backgroundColor, foreground) => {
    const run = await preview(mockApi([{ items: [calendar("main", { backgroundColor })] }],
      () => Response.json({ items: [event("1")] })));
    if (!run.briefing) throw new Error("Missing model");
    expect(renderBriefingEmail(run.briefing, "morning-briefing").html)
      .toContain(`background-color:${backgroundColor};color:${foreground};padding:12px 14px`);
  });

  it.each(["red", "#fff", "#000000;display:none"])("rejects unsafe or invalid Google colour %s", async (backgroundColor) => {
    await expect(createGoogleCalendarProvider(config, mockApi([
      { items: [calendar("main", { backgroundColor })] },
    ]))(context)).rejects.toThrow("expected schema");
  });
});
