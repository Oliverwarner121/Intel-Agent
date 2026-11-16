import { SafeError, type BriefingModel, type BriefingSectionResult } from "@/types/briefing";
import { addDays, localDate, startOfLocalDay } from "@/lib/date";
import { marketAssets } from "@/config/market-assets";
import { marketAssetResultSchema } from "@/types/markets";
import { engineeringUpdateSchema, jobGroupSchema } from "@/types/career";
import { hybridJobSearch, jobSearchPreferences } from "@/config/job-search";
import { engineeringCategories } from "@/config/engineering-sources";
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

type MarketCard = {
  name: string;
  symbol: string;
} & ({
  status: "unavailable";
  reason: string;
} | {
  status: "ok";
  price: string;
  movement: string;
  observation: string;
  stale: boolean;
  sessionLabel: string;
  rangeTitle: string;
  markerLabel: string;
  changeTone?: "positive" | "negative";
  stats: { label: string; value: string }[];
  range?: { low: string; high: string; position?: number };
  note?: string;
});

interface EmailItem {
  text: string;
  url?: string;
  compact?: boolean;
  caption?: boolean;
  market?: MarketCard;
  hours?: HourlyWeatherForecast[];
  weather?: { locationId: string; location: string; summary: string; pills: string[]; hourlyUnavailableReason?: string };
  calendar?: { text: string; name?: string; color?: string };
  news?: { title: string; description?: string; publisher: string; published: string };
  career?: { title: string; subtitle?: string; details: string[]; action: string };
  notice?: boolean;
}

function sectionTitle(section: BriefingSectionResult): string {
  const emoji = { calendar: "📅", weather: "🌤️", news: "📰", markets: "💰", jobs: "💼", engineering: "🤖" }[section.kind];
  return `${emoji} ${section.title}`;
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
    case "jobs": {
      if (!jobGroupSchema.array().safeParse(section.outcome.data).success) throw new SafeError("Email contains invalid job data");
      const rows: EmailItem[] = [];
      for (const workplace of ["hybrid", "remote"] as const) {
        rows.push({ text: workplace === "hybrid" ? `Hybrid — ${hybridJobSearch.locations.join(" / ")}` : "Fully Remote — UK" });
        const group = section.outcome.data.find((item) => item.workplace === workplace);
        if (!group || group.status === "unavailable") {
          rows.push({ text: `Coverage unavailable: ${group?.reason ?? "Group omitted by provider"}`, notice: true });
          continue;
        }
        if (group.status === "partial") rows.push({ text: `Coverage incomplete: ${group.reason}`, notice: true });
        if (!group.jobs.length) rows.push({ text: workplace === "hybrid"
          ? "No hybrid jobs selected for today or yesterday (date-only postings)."
          : "No remote jobs selected from the accessible last-24-hour window." });
        for (const job of group.jobs) {
          const salary = job.salary;
          const level = job.seniority ? {
            "mid-level": "Mid-level target", senior: "Senior — stretch opportunity", unspecified: "Level not specified",
          }[job.seniority] : undefined;
          const symbols: Record<string, string> = { GBP: "£", USD: "$" };
          const currency = salary?.currency ?? "GBP";
          const money = (value: number) => `${symbols[currency] ?? `${currency} `}${new Intl.NumberFormat("en-GB", {
            maximumFractionDigits: 2,
          }).format(value)}`;
          let pay = "Salary not disclosed";
          if (salary) {
            if (salary.minimum !== undefined && salary.maximum !== undefined) pay = `${money(salary.minimum)}–${money(salary.maximum)}`;
            else if (salary.minimum !== undefined) pay = `From ${money(salary.minimum)}`;
            else if (salary.maximum !== undefined) pay = `Up to ${money(salary.maximum)}`;
            else throw new SafeError("Email contains invalid salary data");
            pay += ` (${salary.period})`;
          }
          const details = [
            `Location: ${job.location} | ${workplace === "remote" ? "Remote as listed by source" : "Hybrid"}`,
            `Employment: ${job.contractType ? "Permanent" : "Permanent unconfirmed"} | ${job.jobType ? "Full-time" : "Full-time unconfirmed"}`,
            ...(!salary || salary.currency !== "GBP" || salary.period !== "yearly" || salary.minimum === undefined
              ? [`Salary fit: £${jobSearchPreferences.minimumAnnualSalaryGBP.toLocaleString("en-GB")}/year minimum unconfirmed`] : []),
            ...(job.skills.length ? [`Matched skills: ${job.skills.join(", ")}`] : []),
            ...(job.excerpt ? [`Listing excerpt: ${job.excerpt}`] : []),
            `Source: ${job.source} | Posted: ${job.publishedAt !== undefined ? dateTime(job.publishedAt)
              : `${job.publishedDate} (date only; posting time unavailable)`}`,
          ];
          rows.push({
            text: `${job.title} — ${job.company}\n${pay}${level ? `\nLevel: ${level} (based on title/source level)` : ""}\n${details.join("\n")}`,
            url: sourceUrl(job.url),
            career: { title: job.title, subtitle: `${job.company} | ${pay}${level ? ` | ${level}` : ""}`, details, action: `View job at ${job.source}` },
          });
        }
      }
      if (section.outcome.notice) rows.push({ text: section.outcome.notice, caption: true });
      return rows;
    }
    case "engineering": {
      if (!engineeringUpdateSchema.array().safeParse(section.outcome.data).success) throw new SafeError("Email contains invalid engineering data");
      const rows: EmailItem[] = [];
      for (const category of engineeringCategories) {
        const updates = section.outcome.data.filter((update) => update.category === category.id);
        rows.push({ text: `${category.name}${updates.length ? "" : " - none selected (24h)."}` });
        for (const update of updates) {
          const title = `${update.source}: ${update.title}`;
          const details = [
            ...(update.category === "models" ? ["Type: Copilot availability update, not a vendor model launch"] : []),
            ...(update.kind === "release" ? [`Version: ${update.version}`] : []),
            `Source: ${update.source} | Published: ${dateTime(update.publishedAt)}`,
          ];
          const action = update.kind === "release" ? "Official release notes" : "Official announcement";
          rows.push({
            text: `${title}\n${details.join("\n")}`, url: sourceUrl(update.url),
            career: { title, details, action },
          });
        }
      }
      if (section.outcome.status === "partial") {
        rows.push(...section.outcome.unavailableSources.map((source) => ({
          text: `${source.source} unavailable: ${source.reason}`, notice: true,
        })));
      }
      rows.push({ text: "24h · Models: Copilot availability, not vendor launches. No Cursor/Windsurf or generated summaries.", caption: true });
      return rows;
    }
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
        }${forecast.windSpeedMaxKph === undefined ? "; maximum wind unavailable" : `; wind up to ${forecast.windSpeedMaxKph} km/h`}${
          forecast.hourlyUnavailableReason && !forecast.hourly?.length
            ? `\nHourly forecast unavailable: ${forecast.hourlyUnavailableReason}` : ""
        }`,
        weather: {
          locationId: forecast.locationId,
          location: forecast.locationName,
          summary: forecast.summary,
          hourlyUnavailableReason: forecast.hourlyUnavailableReason,
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
        }
      }
      const emptyList = [...emptyRegions.values()].flat();
      if (emptyList.length > 0) {
        rows.push({ text: emptyList.length === seenRegions.size ? "No weather warnings for today" : `No warnings listed for ${emptyList.join("; ")}.` });
      }
      if (section.outcome.data.some((location) => !location.warnings)) {
        rows.push({ text: "Official weather warnings are not supplied by this forecast provider." });
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
              market: { name: asset.name, symbol: asset.symbol, status: "unavailable", reason: result.reason },
            });
            continue;
          }
          const money = (value: number, signed = false) => new Intl.NumberFormat("en-GB", {
            style: "currency", currency: asset.currency, currencyDisplay: "code",
            minimumFractionDigits: 2, maximumFractionDigits: asset.id === "xrp" ? 4 : 2,
            ...(signed ? { signDisplay: "exceptZero" } : {}),
          }).format(value);
          const price = money(result.price);
          const movement = result.change
            ? `${new Intl.NumberFormat("en-GB", { signDisplay: "exceptZero", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(result.change.percent)}% ${
              result.change.basis === "24-hours" ? "over 24 hours" : "vs previous close"
            }`
            : "change unavailable";
          const observation = `${result.priceType === "close" ? "closing price" : "last trade"} as of ${
            marketTime(result.asOf)
          }${result.stale ? " (stale)" : ""}`;
          const session = result.session;
          const sessionLabel = `${asset.kind === "stock" ? "Last completed session" : "Quoted daily bar"}${
            session?.date ? ` · ${new Intl.DateTimeFormat("en-GB", {
              timeZone: "UTC", day: "numeric", month: "short", year: "numeric",
            }).format(new Date(`${session.date}T00:00:00Z`))}` : ""
          }`;
          const rangeTitle = asset.kind === "stock" ? "Session range" : "Daily-bar range";
          const stats = [
            { label: "Open", value: session?.open === undefined ? "Unavailable" : money(session.open) },
            { label: asset.kind === "stock" ? "Previous close" : "Previous bar close",
              value: session?.previousClose === undefined ? "Unavailable" : money(session.previousClose) },
            { label: "Volume", value: session?.volume === undefined ? "Unavailable"
              : new Intl.NumberFormat("en-GB", { maximumFractionDigits: 8 }).format(session.volume) },
            { label: asset.kind === "stock" ? "Session change" : "Daily-bar change",
              value: session?.previousClose === undefined ? "Unavailable" : money(result.price - session.previousClose, true) },
          ];
          const range = session?.low !== undefined && session.high !== undefined ? {
            low: money(session.low), high: money(session.high),
            ...(session.high > session.low
              ? { position: (result.price - session.low) / (session.high - session.low) * 100 } : {}),
          } : undefined;
          const note = asset.kind === "crypto" ? "24-hour change and daily-bar range cover different periods." : undefined;
          sourceUrl(result.source.url);
          rows.push({
            text: `${label}: ${price}; ${movement}; ${observation}\n${sessionLabel}\n${
              stats.map((stat) => `${stat.label}: ${stat.value}`).join("; ")
            }\n${rangeTitle}: ${range ? `Low ${range.low}; High ${range.high}${
              range.position === undefined ? "; flat session" : ""
            }` : "Unavailable"}${note ? `\n${note}` : ""}`,
            market: {
              name: asset.name, symbol: asset.symbol, status: "ok", price, movement, observation,
              stale: result.stale, sessionLabel, rangeTitle, stats, range, note,
              markerLabel: result.priceType === "close" ? "close" : "last trade",
              ...(result.change && result.change.percent !== 0
                ? { changeTone: result.change.percent > 0 ? "positive" as const : "negative" as const } : {}),
            },
          });
        }
      }
      return rows;
    }
    case "news": {
      const notice = section.outcome.notice ? [{ text: section.outcome.notice, compact: true }] : [];
      if (!section.outcome.data.length) return [...notice, { text: "No stories selected." }];
      return [...notice, ...section.outcome.data.map((story) => {
        const published = `${dateTime(story.publishedAt)}${
          new Date(story.publishedAt).getTime() < new Date(briefing.generatedAt).getTime() - 86_400_000
            ? " (older than 24 hours)" : ""
        }`;
        return {
          text: `${story.title}${story.description ? `\nPublisher excerpt: ${story.description}` : ""}\nSource: ${story.publisher} | Published: ${published}`,
          url: sourceUrl(story.url),
          news: { title: story.title, description: story.description, publisher: story.publisher, published },
        };
      })];
    }
  }
}

function renderHourly(hours: HourlyWeatherForecast[], timezone: string): string {
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, hour: "2-digit", minute: "2-digit",
  });
  const rows = [];
  for (let offset = 0; offset < hours.length; offset += 6) {
    rows.push(`<tr>${hours.slice(offset, offset + 6).map((hour) =>
      `<td class="copy" width="16.66%" align="center" style="width:16.66%;padding:10px 1px;vertical-align:top;color:#e3edf8;font-size:11px;line-height:1.8"><span class="muted" style="color:#adbed0">${escape(clock.format(new Date(hour.at)))}</span><br><span role="img" aria-label="${escape(hour.summary)}" title="${escape(hour.summary)}" style="font-size:23px">${escape(hour.emoji)}</span><br><strong>${escape(String(Math.round(hour.temperatureC)))}°C</strong><br><span class="muted" style="color:#adbed0;font-size:10px">${hour.precipitationProbabilityPercent === undefined ? "n/a" : `${hour.precipitationProbabilityPercent}%`}</span>${hour.temperatureC <= 0 ? '<br><span title="Freezing">❄️</span>' : hour.temperatureC >= 30 ? '<br><span title="Hot">🌡️</span>' : ""}</td>`
    ).join("")}${"<td></td>".repeat(Math.max(0, 6 - hours.slice(offset, offset + 6).length))}</tr>`);
  }
  return `<table role="presentation" width="100%" style="width:100%;table-layout:fixed">${rows.join("")}</table>`;
}

function renderDisclosure(id: string, title: string, content: string, name?: string): string {
  // Content stays visible unless the client retains both the input and interactive CSS.
  return `<div class="disclosure">
<input class="disclosure-toggle" type="checkbox" id="${id}"${name === undefined ? "" : ` aria-label="Show details for ${escape(name)}"`} aria-controls="${id}-content" style="display:none;mso-hide:all">
<label class="disclosure-heading" for="${id}" style="display:block;padding:12px 0;color:#f4f8ff;line-height:1.5;overflow-wrap:anywhere">${title}<span class="disclosure-indicator" aria-hidden="true" style="display:none"></span></label>
<div class="disclosure-content" id="${id}-content" style="padding-top:12px">${content}</div>
</div>`;
}

function renderWeatherCard(item: EmailItem, timezone: string, id: string): string {
  if (!item.weather) return escape(item.text);
  const content = `<div class="inset rule" style="padding:16px 10px;border:1px solid #34495c;border-radius:20px;background-color:#102231">
<p class="copy" style="margin:0 4px 10px;color:#e3edf8;font-size:14px;font-weight:500">${escape(item.weather.summary)}</p>
<p style="margin:0 0 10px">${item.weather.pills.map((pill) =>
    `<span class="copy rule pill" style="display:inline-block;margin:3px 2px;padding:6px 9px;border:1px solid #34495c;border-radius:99px;background-color:#1b3245;color:#e3edf8;font-size:11px;line-height:1.5">${escape(pill)}</span>`,
  ).join(" ")}</p>
${item.hours?.length ? renderHourly(item.hours, timezone) : ""}
${item.weather.hourlyUnavailableReason ? `<p class="notice" style="margin:10px 4px 0;color:#ffd28c;font-size:12px;line-height:1.6">Hourly forecast unavailable: ${escape(item.weather.hourlyUnavailableReason)}</p>` : ""}
</div>`;
  if (item.weather.locationId === "wheatley") {
    return `<h3 class="heading" style="margin:0 0 12px;color:#f4f8ff;font-size:19px;font-weight:600;letter-spacing:-0.4px">${escape(item.weather.location)}</h3>${content}`;
  }
  return renderDisclosure(id,
    `<span class="heading" role="heading" aria-level="3" style="font-size:19px;font-weight:600;letter-spacing:-0.4px">${escape(item.weather.location)}</span>`,
    content, item.weather.location);
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
  return `<div${calendar.name ? ` title="${escape(calendar.name)}"` : ""} style="background-color:${background};color:${foreground};padding:12px 14px;border-radius:16px;box-shadow:inset 0 1px 0 rgba(255,255,255,0.28);font-weight:500">${escape(calendar.text)}</div>`;
}

function renderMarketCard(market: MarketCard, id: string): string {
  const heading = `${market.name} (${market.symbol})`;
  if (market.status === "unavailable") {
    return `<div class="inset market-card" style="padding:20px;background-color:#102231;border:1px solid #34495c;border-radius:22px">
<h3 class="heading" style="margin:0 0 10px;color:#f4f8ff;font-size:18px">${escape(heading)}</h3>
<p class="notice" style="margin:0;color:#ffd28c;font-size:14px;line-height:1.6">Data unavailable: ${escape(market.reason)}</p></div>`;
  }
  const color = market.changeTone === "positive" ? "#75dfa7" : market.changeTone === "negative" ? "#ff9aa5" : "#b9d1e6";
  const position = market.range?.position === undefined ? undefined : Number(market.range.position.toFixed(2));
  const rangeDescription = market.range ? `${market.rangeTitle}: low ${market.range.low}, high ${market.range.high}. ${
    position === undefined ? "Flat session; high, low and price are equal."
      : `${market.markerLabel} at ${position}% of the range.`
  }` : `${market.rangeTitle} unavailable`;
  const statsRows = [];
  for (let index = 0; index < market.stats.length; index += 2) {
    statsRows.push(`<tr>${market.stats.slice(index, index + 2).map((stat) =>
      `<td width="50%" style="width:50%;padding:10px 6px 0 0;vertical-align:top;overflow-wrap:anywhere"><span class="muted" style="color:#adbed0;font-size:11px">${escape(stat.label)}</span><br><span class="copy" style="color:#e3edf8;font-size:14px;font-weight:600">${escape(stat.value)}</span></td>`,
    ).join("")}</tr>`);
  }
  const content = `<p class="muted" style="margin:0 0 14px;color:#adbed0;font-family:'SFMono-Regular',Consolas,monospace;font-size:10px;line-height:1.6">${escape(market.sessionLabel)}</p>
<p class="${market.changeTone ? `change-${market.changeTone}` : "copy"} rule" style="margin:8px 0 0;color:${color};font-size:12px;font-weight:600;line-height:1.6">${escape(market.movement)}</p>
<p class="muted" style="margin:20px 0 8px;color:#adbed0;font-size:11px">${escape(market.rangeTitle)}</p>
${market.range ? `<table role="presentation" width="100%" style="width:100%;table-layout:fixed"><tr><td class="change-negative" style="padding:0 4px 8px 0;color:#ff9aa5;font-size:12px;overflow-wrap:anywhere">Low<br><strong>${escape(market.range.low)}</strong></td><td class="change-positive" align="right" style="padding:0 0 8px 4px;color:#75dfa7;font-size:12px;overflow-wrap:anywhere">High<br><strong>${escape(market.range.high)}</strong></td></tr></table>
<div role="img" aria-label="${escape(rangeDescription)}">
<table role="presentation" aria-hidden="true" width="100%" style="width:100%;table-layout:fixed;border-collapse:separate;border-spacing:0"><tr>${
  position !== undefined && position > 0
    ? `<td width="${position}%" height="10" style="width:${position}%;height:10px;background-color:${color};border-right:3px solid #f4f8ff;font-size:0;line-height:0">&nbsp;</td>` : ""
}${
  position === undefined || position < 100
    ? `<td width="${position === undefined ? 100 : 100 - position}%" height="10" style="height:10px;background-color:#34495c;${position === 0 ? "border-left:3px solid #f4f8ff;" : ""}font-size:0;line-height:0">&nbsp;</td>` : ""
}</tr></table></div>
<p class="muted" style="margin:8px 0 0;color:#adbed0;font-size:11px;line-height:1.6">${position === undefined
    ? "Flat session: high, low and price are equal."
    : `White marker: ${escape(market.markerLabel)} within the range (${position}%).`}</p>` : `<p class="muted" style="margin:0;color:#adbed0;font-size:12px">${escape(rangeDescription)}</p>`}
<table role="presentation" width="100%" style="width:100%;table-layout:fixed">${statsRows.join("")}</table>
<p class="muted" style="margin:16px 0 0;color:#adbed0;font-size:11px;line-height:1.6">${escape(market.observation)}${market.note ? `<br>${escape(market.note)}` : ""}</p>`;
  return `<div class="inset market-card" style="padding:12px 20px;background-color:#102231;border:1px solid #34495c;border-radius:22px">${renderDisclosure(id,
    `<span class="heading" role="heading" aria-level="3" style="display:block;font-size:18px;font-weight:600">${escape(heading)}</span>
<span class="heading market-price" style="display:block;margin-top:6px;font-size:24px;font-weight:600;letter-spacing:-0.6px;font-variant-numeric:tabular-nums">${escape(market.price)}</span>${
  market.stale ? '<span class="notice" style="display:block;color:#ffd28c;font-size:11px">Stale quote</span>' : ""
}`,
    content, heading)}</div>`;
}

function renderItems(section: BriefingSectionResult, items: EmailItem[], timezone: string, sectionIndex: number): string {
  if (section.kind === "news" || section.kind === "jobs" || section.kind === "engineering") {
    return `<table role="presentation" width="100%" style="width:100%">${items.map((item, index) => {
      if ((!item.news && !item.career) || !item.url) {
        return `<tr><td class="${item.notice ? "notice" : "muted"}${item.caption ? " career-caption" : ""}" style="padding:0 0 ${item.caption ? "0" : "12px"};color:${item.notice ? "#ffd28c" : "#adbed0"};font-size:${item.caption ? "10px" : "13px"};line-height:${item.caption ? "1.4" : "1.6"}">${escape(item.text)}</td></tr>`;
      }
      if (item.career) {
        return `<tr><td style="padding:12px 0;border-top:1px solid #34495c;overflow-wrap:anywhere">${renderDisclosure(
          `c${sectionIndex}-${index}`,
          `<strong style="font-size:17px">${escape(item.career.title)}</strong>${
            item.career.subtitle ? `<br><small>${escape(item.career.subtitle)}</small>` : ""
          }`,
          `<p style="margin:0 0 12px;font-size:13px;line-height:1.6">${item.career.details.map(escape).join("<br>")}</p><a class="link" href="${escape(item.url)}" style="display:inline-block;padding:12px 0;line-height:20px;color:#a6e2ff">${escape(item.career.action)} &nearr;</a>`,
        )}</td></tr>`;
      }
      const title = item.news?.title ?? item.text;
      return `<tr><td class="rule" style="padding:20px 0;border-bottom:1px solid #34495c;overflow-wrap:anywhere">
${renderDisclosure(`disclosure-${sectionIndex}-${index}`,
    `<span class="heading" role="heading" aria-level="3" style="font-size:18px;font-weight:600;letter-spacing:-0.3px">${escape(title)}</span>`,
    `${item.news?.description ? `<p class="copy" style="margin:0 0 12px;color:#e3edf8;font-size:14px;line-height:1.7"><span class="muted" style="color:#adbed0;font-size:11px">Publisher excerpt:</span> ${escape(item.news.description)}</p>` : ""}
${item.news ? `<p class="muted" style="margin:0 0 14px;color:#adbed0;font-size:12px;line-height:1.6">Source: ${escape(item.news.publisher)} | Published: ${escape(item.news.published)}</p>` : ""}
<a class="link glass-action" href="${escape(item.url)}" style="display:inline-block;min-height:44px;box-sizing:border-box;padding:12px 18px;border:1px solid #4d718c;border-radius:99px;background-color:#203e55;color:#a6e2ff;font-size:13px;font-weight:600;line-height:20px;text-decoration:underline;box-shadow:inset 0 1px 0 rgba(255,255,255,0.18)">Read more <span aria-hidden="true">&nearr;</span></a>`,
    title)}
</td></tr>`;
    }).join("")}</table>`;
  }
  if (section.kind === "markets" && items.some((item) => item.market)) {
    return `<div role="group" aria-label="Market snapshots">${items.map((item, index) => item.market
      ? `<div style="padding:0 0 14px">${renderMarketCard(item.market, `disclosure-${sectionIndex}-${index}`)}</div>`
      : `<p class="muted" style="margin:8px 0 16px;color:#adbed0;font-size:12px;line-height:1.7">${escape(item.text)}</p>`,
    ).join("")}</div>`;
  }
  return `<table role="presentation" width="100%" style="width:100%">${items.map((item, index) =>
    `<tr><td class="${item.compact ? "muted" : "copy"} rule${section.outcome.status === "unavailable" ? " notice" : ""}" style="padding:${index === 0 ? "0" : item.compact ? "4px" : "16px"} 0 ${index === items.length - 1 ? "0" : item.compact ? "4px" : "16px"};${index === items.length - 1 || item.compact ? "" : "border-bottom:1px solid #34495c;"}color:${section.outcome.status === "unavailable" ? "#ffd28c" : item.compact ? "#adbed0" : "#e3edf8"};font-size:${item.compact ? "11px" : "15px"};line-height:1.7;overflow-wrap:anywhere;word-break:break-word">${item.calendar ? renderCalendarEvent(item.calendar) : item.weather ? renderWeatherCard(item, timezone, `disclosure-${sectionIndex}-${index}`) : item.url ? `<a class="link" href="${escape(item.url)}" style="color:#a6e2ff;text-decoration:underline">${escape(item.text)}</a>` : escape(item.text)}</td></tr>`
  ).join("")}</table>`;
}

// Original decorative wallpaper, embedded so the email never needs an image host.
const codeWallpaper = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="720" viewBox="0 0 480 720"><defs><radialGradient id="cyan"><stop stop-color="#147c9e" stop-opacity=".7"/><stop offset="1" stop-color="#147c9e" stop-opacity="0"/></radialGradient><radialGradient id="blue"><stop stop-color="#354fa3" stop-opacity=".6"/><stop offset="1" stop-color="#354fa3" stop-opacity="0"/></radialGradient><linearGradient id="fade" x2="0" y2="1"><stop stop-color="#419aba" stop-opacity=".2"/><stop offset=".6" stop-color="#70ddff" stop-opacity=".85"/><stop offset="1" stop-color="#419aba" stop-opacity=".2"/></linearGradient></defs><ellipse cx="130" cy="240" rx="130" ry="240" fill="url(#cyan)"/><ellipse cx="360" cy="520" rx="120" ry="200" fill="url(#blue)"/><g fill="url(#fade)" font-family="monospace" font-size="11">${Array.from({ length: 20 }, (_, index) =>
    `<text x="${index * 25 + 6}" y="${-80 + index % 4 * 28}" style="writing-mode:vertical-rl;letter-spacing:9px" opacity="${index % 3 === 0 ? ".9" : ".5"}">${index % 2 === 0 ? "01001101011010010110010101001011010010110101" : "10110010100101101001011010010110101100101001"}</text>`,
  ).join("")}</g></svg>`,
)}`;

export function renderBriefingEmail(briefing: BriefingModel, template: string): { html: string; text: string } {
  if (template !== "morning-briefing") throw new SafeError("Email template is not configured");
  const date = new Intl.DateTimeFormat("en-GB", {
    timeZone: briefing.timezone, weekday: "long", day: "numeric", month: "long", year: "numeric",
  }).format(startOfLocalDay(briefing.reportingDate, briefing.timezone));
  const sections = briefing.sections.map((section) => ({
    section, items: sectionItems(section, briefing).filter((item) => !item.compact),
  }));
  return {
    text: `Intel Agent\n${date}\n\n${sections.map(({ section, items }) =>
      `${sectionTitle(section)}\n${items.map((item) => `- ${item.text}${item.url ? `\n  ${item.url}` : ""}`).join("\n")}`
    ).join("\n\n")}`,
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
.glass {
  background-image: radial-gradient(ellipse at 0% 0%, rgba(235,249,255,0.24), transparent 55%), radial-gradient(ellipse at 100% 100%, rgba(131,200,255,0.14), transparent 50%), linear-gradient(135deg, rgba(255,255,255,0.10), rgba(255,255,255,0.01) 42%, rgba(192,225,255,0.03) 70%, rgba(231,246,255,0.12));
  background-clip: padding-box;
  border-color: rgba(192,224,255,0.32) !important;
  border-top-color: rgba(242,251,255,0.72) !important;
  border-bottom-color: rgba(163,210,255,0.46) !important;
  box-shadow: inset 0 0 0 1px rgba(255,255,255,0.08), inset 1px 2px 1px rgba(255,255,255,0.28), inset -1px -2px 1px rgba(173,220,255,0.16), 0 2px 3px rgba(0,0,0,0.18), 0 18px 42px rgba(0,4,15,0.38);
}
.glass-action, .pill {
  background-image: radial-gradient(ellipse at 30% 0%, rgba(255,255,255,0.24), transparent 70%), linear-gradient(160deg, rgba(222,246,255,0.12), rgba(222,246,255,0.02) 55%, rgba(176,218,255,0.14));
  border-color: rgba(213,237,255,0.42) !important;
  border-top-color: rgba(255,255,255,0.7) !important;
  box-shadow: inset 0 1px 1px rgba(255,255,255,0.3), inset 0 -1px 1px rgba(185,226,255,0.2), 0 4px 12px rgba(0,0,0,0.18) !important;
}
.glass .muted { color: #c3d1e0 !important; }
.glass-action { color: #eaf7ff !important; }
@supports (-webkit-appearance: none) {
  .disclosure-toggle { display: block !important; position: absolute; width: 1px; height: 1px; padding: 0; margin: 0; opacity: 0; clip-path: inset(50%); }
  .disclosure-toggle + .disclosure-heading { position: relative; box-sizing: border-box; min-height: 68px !important; padding-right: 60px !important; cursor: pointer; }
  .disclosure-toggle:not(:checked) + .disclosure-heading + .disclosure-content { display: none !important; }
  .disclosure-toggle + .disclosure-heading .disclosure-indicator { display: block !important; position: absolute; right: 0; top: 50%; margin-top: -22px; box-sizing: border-box; width: 44px; height: 44px; border: 1px solid #4d718c; border-radius: 14px; background-color: #203e55; color: #b5e7ff; font-size: 32px; font-weight: 400; line-height: 40px; text-align: center; }
  .disclosure-toggle + .disclosure-heading .disclosure-indicator::after { content: "+"; }
  .disclosure-toggle:checked + .disclosure-heading .disclosure-indicator::after { content: "-"; }
  .disclosure-toggle:focus-visible + .disclosure-heading { outline: 2px solid #90d9ff; outline-offset: 3px; border-radius: 8px; }
}
@supports ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px))) {
  .glass { background-color: rgba(11,25,40,0.46) !important; -webkit-backdrop-filter: blur(9px) saturate(150%); backdrop-filter: blur(9px) saturate(150%); }
  .header.glass { background-color: rgba(16,31,47,0.24) !important; -webkit-backdrop-filter: blur(6px) saturate(155%); backdrop-filter: blur(6px) saturate(155%); }
  .glass-action, .pill { background-color: rgba(203,233,255,0.09) !important; }
  .glass-action { -webkit-backdrop-filter: blur(6px) saturate(140%); backdrop-filter: blur(6px) saturate(140%); }
  .inset { background-color: rgba(5,18,31,0.4) !important; border-color: rgba(186,221,250,0.2) !important; box-shadow: inset 0 1px 8px rgba(0,0,0,0.12); }
}
@media only screen and (max-width: 620px) {
  .outer { padding: 20px 12px !important; }
  .header { padding: 28px 22px !important; border-radius: 28px !important; }
  .card { padding: 24px 18px !important; border-radius: 26px !important; }
  .headline { font-size: 38px !important; }
  .section-heading { font-size: 23px !important; }
}
@media (prefers-color-scheme: dark) {
  .page { background-color: #06121f !important; color: #e3edf8 !important; }
  .heading { color: #f4f8ff !important; }
  .copy { color: #e3edf8 !important; }
  .muted { color: #adbed0 !important; }
  .rule { border-color: #34495c !important; }
  .link { color: #a6e2ff !important; }
  .notice { color: #ffd28c !important; }
  .change-positive { color: #75dfa7 !important; }
  .change-negative { color: #ff9aa5 !important; }
}
@media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
  .glass, .glass-action, .pill { background-image: none !important; -webkit-backdrop-filter: none !important; backdrop-filter: none !important; box-shadow: none !important; border-color: #4b657b !important; }
  .glass, .header.glass { background-color: #112537 !important; -webkit-backdrop-filter: none !important; backdrop-filter: none !important; }
  .glass-action, .pill { background-color: #203e55 !important; }
  .inset { background-color: #102231 !important; border-color: #34495c !important; box-shadow: none !important; }
  .backdrop { background-image: none !important; }
}
</style>
</head>
<body class="page" style="margin:0;padding:0;background-color:#06121f;color:#e3edf8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;-webkit-text-size-adjust:100%">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">Your daily briefing for ${escape(date)}. Your day, at a glance.</div>
<table role="presentation" width="100%" class="page backdrop" style="width:100%;background-color:#06121f;background-image:url('${codeWallpaper}');background-repeat:repeat;background-position:center top"><tr><td class="outer" align="center" style="padding:40px 20px">
<!--[if mso]><table role="presentation" width="640" align="center"><tr><td><![endif]-->
<table role="presentation" width="100%" style="width:100%;max-width:640px;border-collapse:separate;border-spacing:0">
<tr><td class="header glass" style="padding:36px 32px;background-color:#112537;border:1px solid #4b657b;border-radius:32px">
<h1 class="headline heading" style="margin:0 0 16px;color:#f4f8ff;font-size:48px;font-weight:700;letter-spacing:-2px;line-height:1.05">Intel Agent</h1>
<p class="copy" style="margin:0;color:#e3edf8;font-size:16px;line-height:1.6">${escape(date)}</p>
</td></tr>
<tr><td style="height:20px;font-size:1px;line-height:20px">&nbsp;</td></tr>
${sections.map(({ section, items }, index) => {
  const accent = section.outcome.status === "unavailable" ? "#ffd28c" : "#90d9ff";
  return `<tr><td class="glass card" style="padding:28px 30px;background-color:#112537;border:1px solid #4b657b;border-radius:28px">
<p class="muted" style="margin:0 0 12px;color:#adbed0;font-family:'SFMono-Regular',Consolas,monospace;font-size:10px;font-weight:500;letter-spacing:2px;text-transform:uppercase"><span style="color:${accent}">${String(index + 1).padStart(2, "0")}</span> &nbsp;/&nbsp; ${section.kind === "markets" ? "MARKET SNAPSHOT" : section.kind === "calendar" ? "YOUR SCHEDULE" : section.kind === "weather" ? "LOCAL OUTLOOK" : section.kind === "jobs" || section.kind === "engineering" ? "CAREER &amp; ENGINEERING" : "THE HEADLINES"}</p>
<h2 class="heading section-heading" style="margin:0 0 20px;color:#f4f8ff;font-size:26px;font-weight:600;letter-spacing:-0.7px;line-height:1.25">${escape(sectionTitle(section))}</h2>
${renderItems(section, items, briefing.timezone, index)}
</td></tr><tr><td style="height:16px;font-size:1px;line-height:16px">&nbsp;</td></tr>`;
}).join("")}
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body></html>`,
  };
}
