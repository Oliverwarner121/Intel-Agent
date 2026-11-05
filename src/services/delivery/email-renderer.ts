import { SafeError, type BriefingModel, type BriefingSectionResult } from "@/types/briefing";
import { addDays, localDate, startOfLocalDay } from "@/lib/date";
import { marketAssets } from "@/config/market-assets";
import { marketAssetResultSchema } from "@/types/markets";
import type { HourlyWeatherForecast } from "@/types/weather";

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

interface EmailItem {
  text: string;
  url?: string;
  compact?: boolean;
  columns?: [string, string, string, string];
  changeTone?: "positive" | "negative";
  hours?: HourlyWeatherForecast[];
  weather?: { location: string; summary: string; pills: string[] };
  calendar?: { text: string; name?: string; color?: string };
}

function sectionItems(section: BriefingSectionResult, briefing: BriefingModel): EmailItem[] {
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
    case "calendar": {
      const failures = section.outcome.status === "partial"
        ? section.outcome.unavailableCalendars.map((calendar) => ({
          text: `${calendar.calendarName}: Calendar unavailable or incomplete: ${calendar.reason}`,
        })) : [];
      if (!section.outcome.data.length) return [
        { text: failures.length ? "No events retrieved from the available calendars." : "No events scheduled today." },
        ...failures,
      ];
      return [...section.outcome.data.map((event) => {
        const timing = event.timing;
        const label = timing.kind === "all-day"
          ? `All day${timing.startDate !== briefing.reportingDate || timing.endDate !== addDays(briefing.reportingDate, 1)
            ? ` (${timing.startDate} to ${timing.endDate}, end exclusive)` : ""}`
          : `${time(timing.start)}-${time(timing.end)}${
            localDate(new Date(timing.start), briefing.timezone) !== briefing.reportingDate ||
            localDate(new Date(timing.end), briefing.timezone) !== briefing.reportingDate
              ? ` (${dateTime(timing.start)} to ${dateTime(timing.end)})` : ""
          }`;
        const text = `${label}: ${event.title}${event.location ? ` - ${event.location}` : ""}`;
        return {
          text: `${text}${event.calendarName ? ` [${event.calendarName}]` : ""}`,
          calendar: { text, name: event.calendarName, color: event.calendarColor },
        };
      }), ...failures];
    }
    case "weather": {
      if (!section.outcome.data.length) return [{ text: "No forecast data available." }];
      const rows = section.outcome.data.flatMap((forecast) => {
        if ("unavailableReason" in forecast) {
          return [{ text: `${forecast.locationName}: Data unavailable: ${forecast.unavailableReason}` }];
        }
        const items: EmailItem[] = [{
        text: `${forecast.locationName}: ${forecast.summary}; ${forecast.temperatureMinC}-${forecast.temperatureMaxC} C${
          forecast.precipitationProbabilityPercent === undefined ? "; precipitation probability unavailable" : `; precipitation probability up to ${forecast.precipitationProbabilityPercent}%`
        }${forecast.windSpeedMaxKph === undefined ? "; maximum wind unavailable" : `; wind up to ${forecast.windSpeedMaxKph} km/h`}`,
        weather: {
          location: forecast.locationName,
          summary: forecast.summary,
          pills: [
            `Temperature ${forecast.temperatureMinC}–${forecast.temperatureMaxC} °C`,
            forecast.precipitationProbabilityPercent === undefined
              ? "Precipitation unavailable" : `Precipitation up to ${forecast.precipitationProbabilityPercent}%`,
            forecast.windSpeedMaxKph === undefined
              ? "Wind unavailable" : `Wind up to ${forecast.windSpeedMaxKph} km/h`,
          ],
        },
        }];
        if (forecast.hourly?.length) {
          const hours = forecast.hourly.filter((hour) =>
            localDate(new Date(hour.at), briefing.timezone) === briefing.reportingDate &&
            ["06:00", "09:00", "12:00", "15:00", "18:00", "21:00"].includes(time(hour.at)),
          );
          const summary = items[0]?.text ?? forecast.locationName;
          items[0] = {
            ...items[0],
            text: `${summary}\nToday's forecast highlights (${briefing.timezone}): ${hours.map((hour) =>
              `${new Intl.DateTimeFormat("en-GB", { timeZone: briefing.timezone, hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(new Date(hour.at))} ${hour.emoji} ${hour.summary}, ${hour.temperatureC} C${
                hour.precipitationProbabilityPercent === undefined ? "; rain chance unavailable" : `; precipitation ${hour.precipitationProbabilityPercent}%`
              }${hour.temperatureC <= 0 ? " ❄️ freezing" : hour.temperatureC >= 30 ? " 🌡️ hot" : ""}`,
            ).join(" | ")}`,
            hours,
          };
        } else if (forecast.hourlyUnavailableReason) {
          items.push({ text: `Hourly forecast unavailable: ${forecast.hourlyUnavailableReason}` });
        }
        return items;
      });
      const seenRegions = new Set<string>();
      const emptyRegions = new Map<string, string[]>();
      for (const location of section.outcome.data) {
        const warnings = location.warnings;
        if (!warnings || seenRegions.has(warnings.region)) continue;
        seenRegions.add(warnings.region);
        if (warnings.status === "unavailable" || warnings.warnings.length > 0) {
          rows.push({ text: `Met Office regional warnings - ${warnings.region}. Regional coverage may not affect your exact location.` });
        }
        if (warnings.status === "unavailable") {
          rows.push({ text: `Warnings unavailable: ${warnings.reason}` });
        } else {
          const checked = dateTime(warnings.checkedAt);
          if (warnings.warnings.length === 0) {
            const regions = emptyRegions.get(warnings.checkedAt) ?? [];
            regions.push(warnings.region);
            emptyRegions.set(warnings.checkedAt, regions);
          }
          for (const warning of warnings.warnings) {
            rows.push({
              text: `${warning.title} (issued ${dateTime(warning.publishedAt)}; feed checked ${checked})`,
              url: sourceUrl(warning.url),
            });
          }
          rows.push(
            { text: "Warnings: Met Office", url: "https://weather.metoffice.gov.uk/warnings-and-advice/uk-warnings", compact: true },
            { text: "Contains public sector information licensed under the Open Government Licence v3.0",
              url: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/", compact: true },
          );
        }
      }
      for (const [checkedAt, regions] of emptyRegions) {
        rows.push({
          text: `Met Office regional warnings - ${regions.join("; ")}. No warnings listed in ${
            regions.length === 1 ? "this regional feed" : "these regional feeds"
          } when checked ${dateTime(checkedAt)}. Regional coverage may not affect your exact location.`,
        });
      }
      if (section.outcome.data.some((location) => !location.warnings)) {
        rows.push({ text: "Official weather warnings are not supplied by this forecast provider." });
      }
      const credits = new Set<string>();
      for (const forecast of section.outcome.data) {
        if ("unavailableReason" in forecast || !forecast.attribution) continue;
        const attribution = forecast.attribution;
        const url = sourceUrl(attribution.url);
        const licenceUrl = sourceUrl(attribution.licenceUrl);
        const key = `${attribution.name}/${url}/${licenceUrl}`;
        if (credits.has(key)) continue;
        credits.add(key);
        rows.push(
          { text: `Weather: ${attribution.name} (condition codes converted to text)`, url, compact: true },
          { text: "CC BY 4.0", url: licenceUrl, compact: true },
        );
      }
      return rows;
    }
    case "markets": {
      if (!section.outcome.data.length) return [{ text: "No market snapshots available." }];
      if (!marketAssetResultSchema.array().safeParse(section.outcome.data).success) {
        throw new SafeError("Email contains invalid market data");
      }
      const marketTime = (value: string) => new Intl.DateTimeFormat("en-GB", {
        timeZone: briefing.timezone, day: "numeric", month: "short", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      }).format(new Date(value));
      const rows: EmailItem[] = [];
      for (const kind of ["stock", "crypto"] as const) {
        const assets = section.outcome.data.filter((result) =>
          marketAssets.find((asset) => asset.id === result.assetId)?.kind === kind,
        );
        if (!assets.length) continue;
        rows.push({ text: kind === "stock" ? "Stocks (USD)" : "Crypto (BTC/ETH in GBP; XRP in USD)" });
        for (const result of assets) {
          const asset = marketAssets.find((asset) => asset.id === result.assetId);
          if (!asset) throw new SafeError("Email contains an unknown market asset");
          const label = `${asset.name} (${asset.symbol})`;
          if (result.status === "unavailable") {
            rows.push({
              text: `${label}: Data unavailable: ${result.reason}`,
              columns: [label, "Unavailable", "-", result.reason],
            });
            continue;
          }
          const price = new Intl.NumberFormat("en-GB", {
            style: "currency", currency: asset.currency, currencyDisplay: "code",
            minimumFractionDigits: 2, maximumFractionDigits: asset.id === "xrp" ? 4 : 2,
          }).format(result.price);
          const movement = result.change
            ? `${new Intl.NumberFormat("en-GB", { signDisplay: "exceptZero", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(result.change.percent)}% ${
              result.change.basis === "24-hours" ? "over 24 hours" : "vs previous close"
            }`
            : "change unavailable";
          const observation = `${result.priceType === "close" ? "closing price" : "last trade"} as of ${
            marketTime(result.asOf)
          }${result.stale ? " (stale)" : ""}`;
          sourceUrl(result.source.url);
          rows.push({
            text: `${label}: ${price}; ${movement}; ${result.priceType === "close" ? "closing price" : "last trade"} as of ${
              marketTime(result.asOf)
            }${result.stale ? " (stale)" : ""}`,
            columns: [label, price, movement, observation],
            ...(asset.kind === "crypto" && result.change && result.change.percent !== 0
              ? { changeTone: result.change.percent > 0 ? "positive" as const : "negative" as const }
              : {}),
          });
        }
      }
      rows.push({ text: "Point-in-time snapshots, not a live feed. For personal informational use only." });
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

function renderHourly(hours: HourlyWeatherForecast[], timezone: string): string {
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, hour: "2-digit", minute: "2-digit",
  });
  const rows = [];
  for (let offset = 0; offset < hours.length; offset += 6) {
    rows.push(`<tr>${hours.slice(offset, offset + 6).map((hour) =>
      `<td class="copy" width="16.66%" align="center" style="width:16.66%;padding:8px 1px;vertical-align:top;color:#34495b;font-size:11px;line-height:1.7"><span class="muted" style="color:#657687">${escape(clock.format(new Date(hour.at)))}</span><br><span role="img" aria-label="${escape(hour.summary)}" title="${escape(hour.summary)}" style="font-size:23px">${escape(hour.emoji)}</span><br><strong>${escape(String(Math.round(hour.temperatureC)))}°C</strong><br><span class="muted" style="color:#657687;font-size:10px">${hour.precipitationProbabilityPercent === undefined ? "n/a" : `${hour.precipitationProbabilityPercent}%`}</span>${hour.temperatureC <= 0 ? '<br><span title="Freezing">❄️</span>' : hour.temperatureC >= 30 ? '<br><span title="Hot">🌡️</span>' : ""}</td>`
    ).join("")}${"<td></td>".repeat(Math.max(0, 6 - hours.slice(offset, offset + 6).length))}</tr>`);
  }
  return `<table role="presentation" width="100%" style="width:100%;table-layout:fixed">${rows.join("")}</table>`;
}

function renderWeatherCard(item: EmailItem, timezone: string): string {
  if (!item.weather) return escape(item.text);
  return `<h3 class="heading" style="margin:0 0 10px;color:#182d3e;font-size:17px;font-weight:600">${escape(item.weather.location)}</h3>
<div class="rule" style="padding:12px 8px;border:1px solid #e8eef2;border-radius:10px">
<p class="copy" style="margin:0 4px 10px;font-size:13px;font-weight:600">${escape(item.weather.summary)}</p>
<p style="margin:0 0 10px">${item.weather.pills.map((pill) =>
    `<span class="copy rule" style="display:inline-block;margin:3px 2px;padding:5px 9px;border:1px solid #dce5eb;border-radius:16px;color:#34495b;font-size:11px;line-height:1.5">${escape(pill)}</span>`,
  ).join(" ")}</p>
${item.hours?.length ? renderHourly(item.hours, timezone) : ""}
</div>`;
}

function renderCalendarEvent(calendar: NonNullable<EmailItem["calendar"]>): string {
  if (calendar.color !== undefined && !/^#[0-9a-f]{6}$/i.test(calendar.color)) {
    throw new SafeError("Email contains an invalid calendar colour");
  }
  const background = calendar.color ?? "#657687";
  const linear = (offset: number) => {
    const channel = Number.parseInt(background.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * linear(1) + 0.7152 * linear(3) + 0.0722 * linear(5);
  const foreground = (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? "#000000" : "#ffffff";
  return `<div${calendar.name ? ` title="${escape(calendar.name)}"` : ""} style="background-color:${background};color:${foreground};padding:12px 14px;border-radius:8px">${escape(calendar.text)}</div>`;
}

function renderItems(section: BriefingSectionResult, items: EmailItem[], timezone: string): string {
  if (section.kind === "markets" && items.some((item) => item.columns)) {
    const cell = "padding:12px 4px;border-bottom:1px solid #e8eef2;vertical-align:top;overflow-wrap:anywhere;line-height:1.6";
    return `<table width="100%" aria-label="Market snapshots" style="width:100%;table-layout:fixed;font-size:13px;border-collapse:collapse">
<thead><tr>${[["Asset", "38%"], ["Price", "30%"], ["Change", "32%"]].map(([label, width]) =>
      `<th scope="col" class="muted rule" align="${label === "Asset" ? "left" : "right"}" style="${cell};width:${width};color:#657687;font-size:11px;text-transform:uppercase;letter-spacing:1px">${label}</th>`
    ).join("")}</tr></thead><tbody>${items.map((item) => {
      if (!item.columns) return `<tr><td colspan="3" class="muted rule" style="${cell};color:#657687;font-size:12px;font-weight:600">${escape(item.text)}</td></tr>`;
      const [asset, price, change, observation] = item.columns;
      const changeColor = item.changeTone === "positive" ? "#137347" : item.changeTone === "negative" ? "#b42332" : "#34495b";
      return `<tr><th scope="row" class="copy rule" align="left" style="${cell};color:#34495b;font-weight:600">${escape(asset)}<br><span class="muted" style="color:#657687;font-size:11px;font-weight:400">${escape(observation)}</span></th><td class="copy rule" align="right" style="${cell};color:#34495b;font-variant-numeric:tabular-nums">${escape(price)}</td><td class="${item.changeTone ? `change-${item.changeTone}` : "copy"} rule" align="right" style="${cell};color:${changeColor};font-variant-numeric:tabular-nums">${escape(change)}</td></tr>`;
    }).join("")}</tbody></table>`;
  }
  return `<table role="presentation" width="100%" style="width:100%">${items.map((item, index) =>
    `<tr><td class="${item.compact ? "muted" : "copy"} rule${section.outcome.status === "unavailable" ? " notice" : ""}" style="padding:${index === 0 ? "0" : item.compact ? "4px" : "13px"} 0 ${index === items.length - 1 ? "0" : item.compact ? "4px" : "13px"};${index === items.length - 1 || item.compact ? "" : "border-bottom:1px solid #e8eef2;"}color:${section.outcome.status === "unavailable" ? "#8a5a17" : item.compact ? "#657687" : "#34495b"};font-size:${item.compact ? "11px" : "15px"};line-height:1.7;overflow-wrap:anywhere;word-break:break-word">${item.calendar ? renderCalendarEvent(item.calendar) : item.weather ? renderWeatherCard(item, timezone) : item.url ? `<a class="link" href="${escape(item.url)}" style="color:#08796d;text-decoration:underline">${escape(item.text)}</a>` : escape(item.text)}</td></tr>`
  ).join("")}</table>`;
}

export function renderBriefingEmail(briefing: BriefingModel, template: string): { html: string; text: string } {
  if (template !== "morning-briefing") throw new SafeError("Email template is not configured");
  const date = new Intl.DateTimeFormat("en-GB", {
    timeZone: briefing.timezone, weekday: "long", day: "numeric", month: "long", year: "numeric",
  }).format(startOfLocalDay(briefing.reportingDate, briefing.timezone));
  const credits = new Map<string, EmailItem>();
  const sections = briefing.sections.map((section) => {
    const items = sectionItems(section, briefing);
    for (const item of items) {
      if (item.compact) credits.set(`${item.text}/${item.url ?? ""}`, item);
    }
    return { section, items: items.filter((item) => !item.compact) };
  });
  const attribution = [...credits.values()];
  return {
    text: `${briefing.name}\n${date}\nTimes: ${briefing.timezone}\n\n${sections.map(({ section, items }) =>
      `${section.title}\n${items.map((item) => `- ${item.text}${item.url ? `\n  ${item.url}` : ""}`).join("\n")}`
    ).join("\n\n")}${attribution.length ? `\n\nData credits\n${attribution.map((item) => `${item.text}${item.url ? `\n${item.url}` : ""}`).join("\n")}` : ""}`,
    html: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escape(briefing.name)}</title>
<style>
:root { color-scheme: light dark; supported-color-schemes: light dark; }
body { margin: 0; padding: 0; }
table { border-collapse: collapse; }
a { text-decoration: underline; text-underline-offset: 3px; }
@media only screen and (max-width: 620px) {
  .outer { padding: 16px 10px !important; }
  .header { padding: 28px 22px !important; }
  .card { padding: 22px !important; }
  .headline { font-size: 30px !important; }
}
@media (prefers-color-scheme: dark) {
  .page { background-color: #101820 !important; color: #e7edf3 !important; }
  .surface { background-color: #19242f !important; border-color: #324252 !important; }
  .heading, .copy { color: #e7edf3 !important; }
  .muted { color: #b0bfce !important; }
  .rule { border-color: #324252 !important; }
  .link { color: #7dd3c7 !important; }
  .notice { color: #efc986 !important; }
  .change-positive { color: #75dfa7 !important; }
  .change-negative { color: #ff9aa5 !important; }
}
</style>
</head>
<body class="page" style="margin:0;padding:0;background-color:#edf2f5;color:#203040;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;-webkit-text-size-adjust:100%">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">Your daily briefing for ${escape(date)}. Calendar, weather and market snapshots, in one place.</div>
<table role="presentation" width="100%" class="page" style="width:100%;background-color:#edf2f5"><tr><td class="outer" align="center" style="padding:32px 16px">
<!--[if mso]><table role="presentation" width="640" align="center"><tr><td><![endif]-->
<table role="presentation" width="100%" style="width:100%;max-width:640px">
<tr><td class="header" style="padding:34px 32px;background-color:#123e49;border-radius:18px 18px 0 0;border-top:4px solid #42c7b1">
<p style="margin:0 0 22px;color:#9be5d8;font-size:12px;font-weight:700;letter-spacing:3px;text-transform:uppercase">INTEL-AGENT / DAILY EDITION</p>
<h1 class="headline" style="margin:0 0 12px;color:#ffffff;font-size:36px;font-weight:700;letter-spacing:-1px;line-height:1.15">${escape(briefing.name)}</h1>
<p style="margin:0;color:#d4e5e9;font-size:15px;line-height:1.6">${escape(date)}</p>
<p style="margin:18px 0 0;color:#9be5d8;font-size:12px;line-height:1.5">YOUR DAY, AT A GLANCE &nbsp;&middot;&nbsp; ${escape(briefing.timezone)}</p>
</td></tr>
<tr><td style="height:20px;font-size:1px;line-height:20px">&nbsp;</td></tr>
${sections.map(({ section, items }, index) => {
  const accent = section.outcome.status === "unavailable" ? "#b77926" : "#168477";
  return `<tr><td class="surface card" style="padding:26px 30px;background-color:#ffffff;border:1px solid #dce5eb;border-radius:14px">
<p class="muted" style="margin:0 0 9px;color:#657687;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase"><span style="color:${accent}">${String(index + 1).padStart(2, "0")}</span> &nbsp;/&nbsp; ${section.kind === "markets" ? "MARKET SNAPSHOT" : section.kind === "calendar" ? "YOUR SCHEDULE" : section.kind === "weather" ? "LOCAL OUTLOOK" : "THE HEADLINES"}</p>
<h2 class="heading" style="margin:0 0 18px;color:#182d3e;font-size:22px;font-weight:700;letter-spacing:-0.4px;line-height:1.3">${escape(section.title)}</h2>
${renderItems(section, items, briefing.timezone)}
</td></tr><tr><td style="height:16px;font-size:1px;line-height:16px">&nbsp;</td></tr>`;
}).join("")}
<tr><td align="center" style="padding:12px 24px 24px">
<p class="muted" style="margin:0 0 8px;color:#657687;font-size:12px;font-weight:700;letter-spacing:2px">INTEL-AGENT</p>
<p class="muted" style="margin:0;color:#657687;font-size:12px;line-height:1.7">Your personal daily briefing.<br>Times shown in ${escape(briefing.timezone)}. Data is a snapshot, not a live feed.</p>
${attribution.length ? `<p class="muted" style="margin:16px 0 0;color:#657687;font-size:11px;line-height:1.7">${attribution.map((item) =>
  item.url ? `<a class="muted" href="${escape(item.url)}" style="color:#657687;text-decoration:underline">${escape(item.text)}</a>` : escape(item.text),
).join("<br>")}</p>` : ""}
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body></html>`,
  };
}
