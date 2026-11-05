import { z } from "zod";
import type { ServerEnv } from "@/config/env";
import { addDays } from "@/lib/date";
import { HttpError, fetchJson, type FetchJsonOptions } from "@/lib/http";
import { SafeError, type CalendarProvider } from "@/types/briefing";
import type { CalendarCollection, CalendarEvent } from "@/types/calendar";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_CALENDAR_API_URL = "https://www.googleapis.com/calendar/v3";

/** Bounds event retrieval; exhaustion is explicitly reported as incomplete. */
const MAX_PAGES = 4;
const PAGE_SIZE = 250;

export interface GoogleCalendarConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  calendarId: string;
  mode?: "single" | "owned";
}

/** Returns the config only when every required credential is present. */
export function googleCalendarConfigFrom(env: ServerEnv): GoogleCalendarConfig | undefined {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GOOGLE_CALENDAR_ID } = env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) return undefined;
  return {
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    refreshToken: GOOGLE_REFRESH_TOKEN,
    calendarId: GOOGLE_CALENDAR_ID ?? "primary",
    ...(env.GOOGLE_CALENDAR_MODE ? { mode: env.GOOGLE_CALENDAR_MODE } : {}),
  };
}

const tokenResponseSchema = z.object({ access_token: z.string().min(1) });

const eventTimeSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTime: z.string().optional(),
});

const eventSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
  summary: z.string().optional(),
  location: z.string().optional(),
  eventType: z.string().optional(),
  start: eventTimeSchema.optional(),
  end: eventTimeSchema.optional(),
  attendees: z.array(z.object({ self: z.boolean().optional(), responseStatus: z.string().optional() })).optional(),
});

const eventsResponseSchema = z.object({
  items: z.array(eventSchema).default([]),
  nextPageToken: z.string().optional(),
});

const calendarListSchema = z.object({
  items: z.array(z.object({
    id: z.string().min(1), summary: z.string().optional(), summaryOverride: z.string().optional(),
    accessRole: z.string(), deleted: z.boolean().optional(), primary: z.boolean().optional(),
    backgroundColor: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  })).max(250).default([]),
  nextPageToken: z.string().optional(),
});

export type GoogleCalendarEvent = z.infer<typeof eventSchema>;

async function getAccessToken(config: GoogleCalendarConfig, options: FetchJsonOptions): Promise<string> {
  try {
    const token = await fetchJson(GOOGLE_TOKEN_URL, tokenResponseSchema, {
      ...options,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          refresh_token: config.refreshToken,
          grant_type: "refresh_token",
        }),
      },
    });
    return token.access_token;
  } catch (error) {
    if (error instanceof HttpError && (error.status === 400 || error.status === 401)) {
      throw new SafeError(
        `Google authorisation failed (HTTP ${error.status}): the refresh token may be expired or revoked`,
      );
    }
    throw error;
  }
}

/** Converts a Google event to the shared model, or drops it. */
export function normaliseGoogleEvent(event: GoogleCalendarEvent, date: string): CalendarEvent | undefined {
  if (event.status === "cancelled") return undefined;
  if (event.attendees?.some((attendee) => attendee.self && attendee.responseStatus === "declined")) {
    return undefined;
  }
  const title = event.summary?.trim() || "(No title)";
  const location = event.location?.trim() || undefined;
  const base = { id: event.id, title, ...(location ? { location } : {}) };

  if (event.start?.dateTime && event.end?.dateTime) {
    const start = new Date(event.start.dateTime);
    const end = new Date(event.end.dateTime);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return undefined;
    return { ...base, timing: { kind: "timed", start: start.toISOString(), end: end.toISOString() } };
  }
  if (event.start?.date) {
    const startDate = event.start.date;
    // Google all-day end dates are exclusive; a missing end means a single day.
    const endDate = event.end?.date ?? addDays(startDate, 1);
    if (startDate > date || endDate <= date) return undefined;
    return { ...base, timing: { kind: "all-day", startDate, endDate } };
  }
  return undefined;
}

/** All-day events first, then timed events by start time, then by title. */
export function compareCalendarEvents(a: CalendarEvent, b: CalendarEvent): number {
  if (a.timing.kind !== b.timing.kind) return a.timing.kind === "all-day" ? -1 : 1;
  const aStart = a.timing.kind === "timed" ? a.timing.start : a.timing.startDate;
  const bStart = b.timing.kind === "timed" ? b.timing.start : b.timing.startDate;
  if (aStart !== bStart) return aStart < bStart ? -1 : 1;
  return a.title.localeCompare(b.title, "en-GB");
}

/**
 * Reads one local day's events using unattended OAuth (a refresh token).
 * Google expands recurring events into instances (singleEvents=true).
 */
export function createGoogleCalendarProvider(
  config: GoogleCalendarConfig,
  fetchImpl?: typeof fetch,
): CalendarProvider {
  return async ({ period, timezone, signal }) => {
    const options: FetchJsonOptions = {
      signal,
      timeoutMs: config.mode === "owned" ? 4_000 : 8_000,
      retries: config.mode === "owned" ? 0 : 1,
      maxResponseBytes: 524_288,
      ...(fetchImpl ? { fetchImpl } : {}),
    };
    const accessToken = await getAccessToken(config, options);
    if (config.mode === "owned") {
      return collectOwnedCalendars(accessToken, period, timezone, options);
    }
    const response = await collectEvents(config.calendarId, accessToken, period, timezone, options);
    if (response.reason) {
      if (!response.events.length) throw new SafeError(response.reason);
      return {
        events: response.events.sort(compareCalendarEvents),
        unavailableCalendars: [{ calendarName: "Configured calendar", reason: response.reason }],
      };
    }
    return response.events.sort(compareCalendarEvents);
  };
}

async function collectEvents(
  calendarId: string, accessToken: string,
  period: Parameters<CalendarProvider>[0]["period"], timezone: string, options: FetchJsonOptions,
): Promise<{ events: CalendarEvent[]; reason?: string }> {
  const events: CalendarEvent[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        timeMin: period.start.toISOString(),
        timeMax: period.end.toISOString(),
        timeZone: timezone,
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: String(PAGE_SIZE),
        fields:
          "items(id,status,summary,location,eventType,start(date,dateTime),end(date,dateTime),attendees(self,responseStatus)),nextPageToken",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const url = `${GOOGLE_CALENDAR_API_URL}/calendars/${encodeURIComponent(calendarId)}/events?${params}`;
      const response = await fetchJson(url, eventsResponseSchema, {
        ...options,
        init: { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" },
      });
      for (const item of response.items) {
        const event = normaliseGoogleEvent(item, period.date);
        if (event && !seen.has(event.id)) {
          seen.add(event.id);
          events.push(event);
        }
      }
      pageToken = response.nextPageToken;
      if (!pageToken) break;
    }
    if (pageToken) return { events, reason: "Calendar event pagination limit reached; events may be missing" };
    return { events };
  } catch (error) {
    return { events, reason: calendarFailureReason(error) };
  }
}

function calendarFailureReason(error: unknown): string {
  return error instanceof SafeError ? error.message
    : error instanceof HttpError ? `Calendar retrieval failed (${error.message})` : "Calendar retrieval failed";
}

async function collectOwnedCalendars(
  accessToken: string, period: Parameters<CalendarProvider>[0]["period"], timezone: string,
  options: FetchJsonOptions,
): Promise<CalendarCollection> {
  const calendars = new Map<string, { id: string; name: string; primary: boolean; color?: string }>();
  let pageToken: string | undefined;
  for (let page = 0; page < 2; page++) {
    const params = new URLSearchParams({
      minAccessRole: "owner", showHidden: "true", showDeleted: "false", maxResults: "250",
      fields: "items(id,summary,summaryOverride,accessRole,deleted,primary,backgroundColor),nextPageToken",
    });
    if (pageToken) params.set("pageToken", pageToken);
    let response: z.infer<typeof calendarListSchema>;
    try {
      response = await fetchJson(`${GOOGLE_CALENDAR_API_URL}/users/me/calendarList?${params}`, calendarListSchema, {
        ...options, timeoutMs: 3_000,
        init: { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" },
      });
    } catch (error) {
      throw new SafeError(`Owned calendar discovery failed: ${calendarFailureReason(error)}`);
    }
    for (const calendar of response.items) {
      if (calendar.accessRole !== "owner" || calendar.deleted) continue;
      calendars.set(calendar.id, {
        id: calendar.id, name: calendar.summaryOverride?.trim() || calendar.summary?.trim() || "Unnamed calendar",
        primary: calendar.primary ?? false,
        ...(calendar.backgroundColor ? { color: calendar.backgroundColor } : {}),
      });
    }
    if (calendars.size > 20) throw new SafeError("Owned calendar limit exceeded (maximum 20)");
    pageToken = response.nextPageToken;
    if (!pageToken) break;
  }
  if (pageToken) throw new SafeError("Owned calendar discovery pagination limit reached");
  if (!calendars.size) throw new SafeError("No owned calendars were found for the connected Google account");
  const selected = [...calendars.values()].sort((a, b) =>
    Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name, "en-GB") || a.id.localeCompare(b.id),
  );
  const results = await Promise.all(selected.map(async (calendar) => {
    const deadline = AbortSignal.timeout(6_500);
    const result = await collectEvents(calendar.id, accessToken, period, timezone, {
      ...options, signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
      timeoutMs: 3_000, retries: 1,
    });
    return {
      events: result.events.map((event) => ({
        ...event, id: JSON.stringify([calendar.id, event.id]), calendarName: calendar.name,
        ...(calendar.color ? { calendarColor: calendar.color } : {}),
      })),
      ...(result.reason ? { failure: { calendarName: calendar.name, reason: result.reason } } : {}),
    };
  }));
  const unavailableCalendars = results.flatMap((result) => result.failure ? [result.failure] : []);
  const events = results.flatMap((result) => result.events).sort(compareCalendarEvents);
  if (unavailableCalendars.length === selected.length && !events.length) {
    throw new SafeError(`All ${selected.length} owned calendars were unavailable`);
  }
  return { events, unavailableCalendars };
}
