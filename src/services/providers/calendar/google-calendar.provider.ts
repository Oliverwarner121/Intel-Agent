import { z } from "zod";
import type { ServerEnv } from "@/config/env";
import { addDays } from "@/lib/date";
import { HttpError, fetchJson, type FetchJsonOptions } from "@/lib/http";
import { SafeError, type CalendarProvider } from "@/types/briefing";
import type { CalendarEvent } from "@/types/calendar";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_CALENDAR_API_URL = "https://www.googleapis.com/calendar/v3";

/** Guards against runaway pagination; a single day never needs more. */
const MAX_PAGES = 4;
const PAGE_SIZE = 250;

export interface GoogleCalendarConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  calendarId: string;
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
    const options: FetchJsonOptions = { signal, timeoutMs: 8_000, retries: 1, ...(fetchImpl ? { fetchImpl } : {}) };
    const accessToken = await getAccessToken(config, options);
    const events: CalendarEvent[] = [];
    let pageToken: string | undefined;

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
      const url = `${GOOGLE_CALENDAR_API_URL}/calendars/${encodeURIComponent(config.calendarId)}/events?${params}`;
      const response = await fetchJson(url, eventsResponseSchema, {
        ...options,
        init: { headers: { Authorization: `Bearer ${accessToken}` } },
      });
      for (const item of response.items) {
        const event = normaliseGoogleEvent(item, period.date);
        if (event) events.push(event);
      }
      pageToken = response.nextPageToken;
      if (!pageToken) break;
    }

    return events.sort(compareCalendarEvents);
  };
}
