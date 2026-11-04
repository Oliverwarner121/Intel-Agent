export type CalendarEventTiming =
  | { kind: "timed"; start: string; end: string }
  | { kind: "all-day"; startDate: string; endDate: string };

/** A calendar event normalised from any calendar provider. ISO 8601 strings. */
export interface CalendarEvent {
  id: string;
  title: string;
  timing: CalendarEventTiming;
  location?: string;
}
