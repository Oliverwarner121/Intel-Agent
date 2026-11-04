import { describe, expect, it } from "vitest";
import {
  LONDON_TIMEZONE,
  addDays,
  isValidTimezone,
  localDate,
  localDayPeriod,
  rollingPeriod,
  startOfLocalDay,
} from "@/lib/date";

const at = (iso: string) => new Date(iso);
const hours = (period: { start: Date; end: Date }) => (period.end.getTime() - period.start.getTime()) / 3_600_000;

describe("London reporting dates", () => {
  it("treats GMT winter mornings as UTC", () => {
    const period = localDayPeriod(at("2026-01-15T05:30:00Z"), LONDON_TIMEZONE);
    expect(period.date).toBe("2026-01-15");
    expect(period.start.toISOString()).toBe("2026-01-15T00:00:00.000Z");
    expect(period.end.toISOString()).toBe("2026-01-16T00:00:00.000Z");
  });

  it("offsets BST summer days by one hour", () => {
    const period = localDayPeriod(at("2026-07-01T05:30:00Z"), LONDON_TIMEZONE);
    expect(period.date).toBe("2026-07-01");
    expect(period.start.toISOString()).toBe("2026-06-30T23:00:00.000Z");
    expect(period.end.toISOString()).toBe("2026-07-01T23:00:00.000Z");
  });

  it("uses the local date after midnight BST even when UTC is still the previous day", () => {
    expect(localDate(at("2026-06-30T23:30:00Z"), LONDON_TIMEZONE)).toBe("2026-07-01");
    expect(localDate(at("2026-06-30T22:59:59Z"), LONDON_TIMEZONE)).toBe("2026-06-30");
  });

  it("makes the spring-forward day 23 hours long", () => {
    const period = localDayPeriod(at("2026-03-29T05:00:00Z"), LONDON_TIMEZONE);
    expect(period.start.toISOString()).toBe("2026-03-29T00:00:00.000Z");
    expect(period.end.toISOString()).toBe("2026-03-29T23:00:00.000Z");
    expect(hours(period)).toBe(23);
  });

  it("makes the fall-back day 25 hours long", () => {
    const period = localDayPeriod(at("2026-10-25T05:00:00Z"), LONDON_TIMEZONE);
    expect(period.start.toISOString()).toBe("2026-10-24T23:00:00.000Z");
    expect(period.end.toISOString()).toBe("2026-10-26T00:00:00.000Z");
    expect(hours(period)).toBe(25);
  });

  it("covers both Hobby Cron windows for 0 5 * * * UTC", () => {
    expect(localDate(at("2026-01-15T05:59:00Z"), LONDON_TIMEZONE)).toBe("2026-01-15");
    expect(localDate(at("2026-07-15T05:59:00Z"), LONDON_TIMEZONE)).toBe("2026-07-15");
  });
});

describe("date helpers", () => {
  it("adds days across month and year boundaries", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });

  it("rejects invalid dates and timezones", () => {
    expect(() => startOfLocalDay("2026-02-30", LONDON_TIMEZONE)).toThrow();
    expect(() => addDays("26-1-1", 1)).toThrow();
    expect(isValidTimezone(LONDON_TIMEZONE)).toBe(true);
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
  });

  it("builds rolling windows independent of local dates", () => {
    const window = rollingPeriod(at("2026-03-29T05:00:00Z"), 24);
    expect(window.start.toISOString()).toBe("2026-03-28T05:00:00.000Z");
    expect(() => rollingPeriod(new Date(), 0)).toThrow();
  });
});
