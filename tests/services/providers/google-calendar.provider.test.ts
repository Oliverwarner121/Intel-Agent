import { describe, expect, it, vi } from "vitest";
import { localDayPeriod, LONDON_TIMEZONE } from "@/lib/date";
import {
  createGoogleCalendarProvider,
  googleCalendarConfigFrom,
  normaliseGoogleEvent,
  type GoogleCalendarConfig,
} from "@/services/providers/calendar/google-calendar.provider";
import { SafeError } from "@/types/briefing";

const config: GoogleCalendarConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  refreshToken: "refresh-token-value",
  calendarId: "primary",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function run(eventPages: unknown[], now = new Date("2026-11-04T05:00:00Z")) {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    if (String(input).startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "access" });
    return json(eventPages.shift() ?? { items: [] });
  });
  const period = localDayPeriod(now, LONDON_TIMEZONE);
  const result = createGoogleCalendarProvider(config, fetchImpl)({
    now,
    timezone: LONDON_TIMEZONE,
    reportingDate: period.date,
    signal: new AbortController().signal,
    period,
  });
  return { fetchImpl, result };
}

const eventUrl = (fetchImpl: ReturnType<typeof run>["fetchImpl"], call = 1) =>
  new URL(String(fetchImpl.mock.calls[call]?.[0]));

describe("googleCalendarConfigFrom", () => {
  const base = { APP_ENV: "dev" as const, CRON_SECRET: "x".repeat(32) };

  it("requires the client ID, client secret and refresh token", () => {
    expect(googleCalendarConfigFrom(base)).toBeUndefined();
    expect(googleCalendarConfigFrom({ ...base, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" })).toBeUndefined();
  });

  it("defaults to the primary calendar", () => {
    expect(
      googleCalendarConfigFrom({
        ...base,
        GOOGLE_CLIENT_ID: "id",
        GOOGLE_CLIENT_SECRET: "secret",
        GOOGLE_REFRESH_TOKEN: "token",
      }),
    ).toEqual({ clientId: "id", clientSecret: "secret", refreshToken: "token", calendarId: "primary" });
  });
});

describe("createGoogleCalendarProvider", () => {
  it("exchanges the refresh token and queries the London day with expanded recurrences", async () => {
    const { fetchImpl, result } = run([{ items: [] }]);
    await expect(result).resolves.toEqual([]);

    const [tokenUrl, tokenInit] = fetchImpl.mock.calls[0] ?? [];
    expect(String(tokenUrl)).toBe("https://oauth2.googleapis.com/token");
    expect(tokenInit?.method).toBe("POST");
    expect(Object.fromEntries(new URLSearchParams(String(tokenInit?.body)))).toEqual({
      client_id: "client-id",
      client_secret: "client-secret",
      refresh_token: "refresh-token-value",
      grant_type: "refresh_token",
    });

    const url = eventUrl(fetchImpl);
    expect(url.pathname).toBe("/calendar/v3/calendars/primary/events");
    expect(url.searchParams.get("timeMin")).toBe("2026-11-04T00:00:00.000Z");
    expect(url.searchParams.get("timeMax")).toBe("2026-11-05T00:00:00.000Z");
    expect(url.searchParams.get("timeZone")).toBe("Europe/London");
    expect(url.searchParams.get("singleEvents")).toBe("true");
    expect(new Headers(fetchImpl.mock.calls[1]?.[1]?.headers).get("authorization")).toBe("Bearer access");
  });

  it("uses the BST day boundaries in summer", async () => {
    const { fetchImpl, result } = run([{ items: [] }], new Date("2026-07-01T05:00:00Z"));
    await result;
    expect(eventUrl(fetchImpl).searchParams.get("timeMin")).toBe("2026-06-30T23:00:00.000Z");
    expect(eventUrl(fetchImpl).searchParams.get("timeMax")).toBe("2026-07-01T23:00:00.000Z");
  });

  it("covers the 25-hour day when the clocks go back", async () => {
    const { fetchImpl, result } = run([{ items: [] }], new Date("2026-10-25T05:00:00Z"));
    await result;
    expect(eventUrl(fetchImpl).searchParams.get("timeMin")).toBe("2026-10-24T23:00:00.000Z");
    expect(eventUrl(fetchImpl).searchParams.get("timeMax")).toBe("2026-10-26T00:00:00.000Z");
  });

  it("normalises, filters and sorts events across pages", async () => {
    const { fetchImpl, result } = run([
      {
        items: [
          {
            id: "standup_20261104",
            summary: "Stand-up",
            start: { dateTime: "2026-11-04T09:30:00Z" },
            end: { dateTime: "2026-11-04T09:45:00Z" },
          },
          {
            id: "dentist",
            summary: " Dentist ",
            location: " High Street ",
            start: { dateTime: "2026-11-04T08:00:00+00:00" },
            end: { dateTime: "2026-11-04T08:30:00+00:00" },
          },
          { id: "cancelled", status: "cancelled" },
          {
            id: "declined",
            summary: "Declined meeting",
            start: { dateTime: "2026-11-04T10:00:00Z" },
            end: { dateTime: "2026-11-04T11:00:00Z" },
            attendees: [{ self: true, responseStatus: "declined" }],
          },
        ],
        nextPageToken: "page-2",
      },
      {
        items: [
          { id: "holiday", summary: "Holiday", start: { date: "2026-11-03" }, end: { date: "2026-11-06" } },
          { id: "office", summary: "Office", eventType: "workingLocation", start: { date: "2026-11-04" }, end: { date: "2026-11-05" } },
          {
            id: "untitled",
            start: { dateTime: "2026-11-04T09:30:00Z" },
            end: { dateTime: "2026-11-04T10:00:00Z" },
          },
        ],
      },
    ]);

    await expect(result).resolves.toEqual([
      { id: "holiday", title: "Holiday", timing: { kind: "all-day", startDate: "2026-11-03", endDate: "2026-11-06" } },
      { id: "office", title: "Office", timing: { kind: "all-day", startDate: "2026-11-04", endDate: "2026-11-05" } },
      {
        id: "dentist",
        title: "Dentist",
        location: "High Street",
        timing: { kind: "timed", start: "2026-11-04T08:00:00.000Z", end: "2026-11-04T08:30:00.000Z" },
      },
      {
        id: "untitled",
        title: "(No title)",
        timing: { kind: "timed", start: "2026-11-04T09:30:00.000Z", end: "2026-11-04T10:00:00.000Z" },
      },
      {
        id: "standup_20261104",
        title: "Stand-up",
        timing: { kind: "timed", start: "2026-11-04T09:30:00.000Z", end: "2026-11-04T09:45:00.000Z" },
      },
    ]);
    expect(eventUrl(fetchImpl, 2).searchParams.get("pageToken")).toBe("page-2");
  });

  it("reports a rejected refresh token without exposing credentials", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ error: "invalid_grant" }, 400));
    const period = localDayPeriod(new Date("2026-11-04T05:00:00Z"), LONDON_TIMEZONE);
    const error = await createGoogleCalendarProvider(config, fetchImpl)({
      now: new Date(),
      timezone: LONDON_TIMEZONE,
      reportingDate: period.date,
      signal: new AbortController().signal,
      period,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SafeError);
    expect((error as SafeError).message).toContain("refresh token may be expired or revoked");
    expect((error as SafeError).message).not.toContain("refresh-token-value");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("normaliseGoogleEvent", () => {
  it("treats a missing all-day end as one day and drops days that do not overlap", () => {
    expect(normaliseGoogleEvent({ id: "a", summary: "A", start: { date: "2026-11-04" } }, "2026-11-04")?.timing).toEqual({
      kind: "all-day",
      startDate: "2026-11-04",
      endDate: "2026-11-05",
    });
    expect(
      normaliseGoogleEvent({ id: "b", start: { date: "2026-11-03" }, end: { date: "2026-11-04" } }, "2026-11-04"),
    ).toBeUndefined();
  });
});
