import { SafeError, type BriefingModel, type BriefingSectionResult } from "@/types/briefing";
import { addDays, localDate, startOfLocalDay } from "@/lib/date";

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

function sourceUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SafeError("Email contains an invalid source link");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new SafeError("Email contains an unsafe source link");
  }
  return url.href;
}

function sectionItems(section: BriefingSectionResult, briefing: BriefingModel): { text: string; url?: string }[] {
  if (section.outcome.status === "unavailable") {
    return [{ text: `Data unavailable: ${section.outcome.reason}` }];
  }
  const time = (value: string) => new Intl.DateTimeFormat("en-GB", {
    timeZone: briefing.timezone, hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
  const dateTime = (value: string) => new Intl.DateTimeFormat("en-GB", {
    timeZone: briefing.timezone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  }).format(new Date(value));
  switch (section.kind) {
    case "calendar":
      if (!section.outcome.data.length) return [{ text: "No events scheduled today." }];
      return section.outcome.data.map((event) => {
        const timing = event.timing;
        const label = timing.kind === "all-day"
          ? `All day${timing.startDate !== briefing.reportingDate || timing.endDate !== addDays(briefing.reportingDate, 1)
            ? ` (${timing.startDate} to ${timing.endDate}, end exclusive)` : ""}`
          : `${time(timing.start)}-${time(timing.end)}${
            localDate(new Date(timing.start), briefing.timezone) !== briefing.reportingDate ||
            localDate(new Date(timing.end), briefing.timezone) !== briefing.reportingDate
              ? ` (${dateTime(timing.start)} to ${dateTime(timing.end)})` : ""
          }`;
        return { text: `${label}: ${event.title}${event.location ? ` - ${event.location}` : ""}` };
      });
    case "weather": {
      if (!section.outcome.data.length) return [{ text: "No forecast data available." }];
      const rows = section.outcome.data.flatMap((forecast) => {
        if ("unavailableReason" in forecast) {
          return [{ text: `${forecast.locationName}: Data unavailable: ${forecast.unavailableReason}` }];
        }
        const items: { text: string; url?: string }[] = [{
        text: `${forecast.locationName}: ${forecast.summary}; ${forecast.temperatureMinC}-${forecast.temperatureMaxC} C${
          forecast.precipitationProbabilityPercent === undefined ? "; precipitation probability unavailable" : `; precipitation probability up to ${forecast.precipitationProbabilityPercent}%`
        }${forecast.windSpeedMaxKph === undefined ? "; maximum wind unavailable" : `; wind up to ${forecast.windSpeedMaxKph} km/h`}`,
        }];
        if (forecast.attribution) {
          items.push(
            { text: `${forecast.locationName} weather data by ${forecast.attribution.name} (daily forecast, condition code converted to text)`, url: sourceUrl(forecast.attribution.url) },
            { text: "Licence: CC BY 4.0", url: sourceUrl(forecast.attribution.licenceUrl) },
          );
        }
        return items;
      });
      const seenRegions = new Set<string>();
      for (const location of section.outcome.data) {
        const warnings = location.warnings;
        if (!warnings || seenRegions.has(warnings.region)) continue;
        seenRegions.add(warnings.region);
        rows.push({ text: `Met Office regional warnings - ${warnings.region}. Regional coverage may not affect your exact location.` });
        if (warnings.status === "unavailable") {
          rows.push({ text: `Warnings unavailable: ${warnings.reason}` });
        } else {
          const checked = dateTime(warnings.checkedAt);
          if (warnings.warnings.length === 0) {
            rows.push({ text: `No warnings listed in this regional feed when checked ${checked}.` });
          }
          for (const warning of warnings.warnings) {
            rows.push({
              text: `${warning.title} (issued ${dateTime(warning.publishedAt)}; feed checked ${checked})`,
              url: sourceUrl(warning.url),
            });
          }
          rows.push(
            { text: "Source: Met Office - check the official warning for affected areas and validity", url: "https://weather.metoffice.gov.uk/warnings-and-advice/uk-warnings" },
            { text: "Contains public sector information licensed under the Open Government Licence v3.0",
              url: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/" },
          );
        }
      }
      if (section.outcome.data.some((location) => !location.warnings)) {
        rows.push({ text: "Official weather warnings are not supplied by this forecast provider." });
      }
      return rows;
    }
    case "news":
      if (!section.outcome.data.length) return [{ text: "No stories selected." }];
      return section.outcome.data.map((story) => ({
        text: `${story.title} - ${story.publisher}, ${dateTime(story.publishedAt)}${
          new Date(story.publishedAt).getTime() < new Date(briefing.generatedAt).getTime() - 86_400_000
            ? " (older than 24 hours)" : ""
        }`,
        url: sourceUrl(story.url),
      }));
  }
}

export function renderBriefingEmail(briefing: BriefingModel, template: string): { html: string; text: string } {
  if (template !== "morning-briefing") throw new SafeError("Email template is not configured");
  const date = new Intl.DateTimeFormat("en-GB", {
    timeZone: briefing.timezone, weekday: "long", day: "numeric", month: "long", year: "numeric",
  }).format(startOfLocalDay(briefing.reportingDate, briefing.timezone));
  const sections = briefing.sections.map((section) => ({ section, items: sectionItems(section, briefing) }));
  return {
    text: `${briefing.name}\n${date}\nTimes: ${briefing.timezone}\n\n${sections.map(({ section, items }) =>
      `${section.title}\n${items.map((item) => `- ${item.text}${item.url ? `\n  ${item.url}` : ""}`).join("\n")}`
    ).join("\n\n")}`,
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f4f5f7;color:#17202a;font-family:Arial,sans-serif"><main style="max-width:600px;margin:0 auto;padding:24px;background:#ffffff"><h1>${escape(briefing.name)}</h1><p>${escape(date)}<br>Times: ${escape(briefing.timezone)}</p>${sections.map(({ section, items }) =>
      `<section><h2 style="font-size:20px;margin-top:28px">${escape(section.title)}</h2><ul style="padding-left:20px">${items.map((item) =>
        `<li style="margin-bottom:12px;line-height:1.5;overflow-wrap:anywhere">${item.url ? `<a href="${escape(item.url)}">${escape(item.text)}</a>` : escape(item.text)}</li>`
      ).join("")}</ul></section>`
    ).join("")}</main></body></html>`,
  };
}
