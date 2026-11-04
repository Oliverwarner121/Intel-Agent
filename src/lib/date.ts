export const LONDON_TIMEZONE = "Europe/London";

/** A half-open interval [start, end) of UTC instants. */
export interface ReportingPeriod {
  start: Date;
  end: Date;
}

export interface LocalDayPeriod extends ReportingPeriod {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  timezone: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let existing = formatters.get(timezone);
  if (!existing) {
    existing = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timezone, existing);
  }
  return existing;
}

export function isValidTimezone(timezone: string): boolean {
  try {
    formatter(timezone);
    return true;
  } catch {
    return false;
  }
}

function wallClock(instant: Date, timezone: string) {
  const parts: Record<string, number> = {};
  for (const part of formatter(timezone).formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const get = (type: string): number => {
    const value = parts[type];
    if (value === undefined || Number.isNaN(value)) {
      throw new Error(`Could not resolve ${type} for timezone ${timezone}`);
    }
    return value;
  };
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** Offset of the timezone from UTC at the given instant, in milliseconds. */
export function timezoneOffsetMs(instant: Date, timezone: string): number {
  const wall = wallClock(instant, timezone);
  const asUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The local calendar date (YYYY-MM-DD) of an instant in a timezone. */
export function localDate(instant: Date, timezone: string): string {
  const { year, month, day } = wallClock(instant, timezone);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseDate(date: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`Invalid local date: ${date}`);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new Error(`Invalid local date: ${date}`);
  }
  return [year, month, day];
}

/** Adds whole calendar days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const [year, month, day] = parseDate(date);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** The UTC instant of local midnight at the start of a date in a timezone. */
export function startOfLocalDay(date: string, timezone: string): Date {
  const [year, month, day] = parseDate(date);
  const wallMidnight = Date.UTC(year, month - 1, day);
  let guess = wallMidnight - timezoneOffsetMs(new Date(wallMidnight), timezone);
  // A second pass corrects guesses that land on the other side of a DST change.
  guess = wallMidnight - timezoneOffsetMs(new Date(guess), timezone);
  return new Date(guess);
}

/**
 * The local calendar day containing an instant, bounded by consecutive local
 * midnights. DST days in London are 23 or 25 hours long.
 */
export function localDayPeriod(instant: Date, timezone: string): LocalDayPeriod {
  const date = localDate(instant, timezone);
  return {
    date,
    timezone,
    start: startOfLocalDay(date, timezone),
    end: startOfLocalDay(addDays(date, 1), timezone),
  };
}

/** A rolling window ending at an instant, independent of local dates. */
export function rollingPeriod(end: Date, hours: number): ReportingPeriod {
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error("Rolling period hours must be positive");
  }
  return { start: new Date(end.getTime() - hours * 3_600_000), end: new Date(end) };
}
