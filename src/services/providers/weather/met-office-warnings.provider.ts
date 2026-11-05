import { XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";
import { fetchText, HttpError } from "@/lib/http";
import { SafeError, type WeatherProvider } from "@/types/briefing";
import type { WeatherWarning, WeatherWarnings } from "@/types/weather";

const regions = [
  { id: "se", name: "London & South East England", locationIds: ["wheatley", "lower-earley"] },
  { id: "sw", name: "South West England", locationIds: ["wotton-under-edge"] },
] as const;
const directLink = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["www.metoffice.gov.uk", "weather.metoffice.gov.uk"].includes(url.hostname)
      && !url.username && !url.password;
  } catch {
    return false;
  }
});
const feedSchema = z.object({
  rss: z.object({
    channel: z.object({
      title: z.string().min(1),
      link: directLink,
      item: z.array(z.object({
        title: z.string().trim().min(1).max(2_000),
        link: directLink,
        pubDate: z.string().refine((value) => Number.isFinite(Date.parse(value))),
      })).max(100).optional(),
    }),
  }),
});

export function parseWarningFeed(xml: string, region: string): WeatherWarning[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw new SafeError("Warning feed is not valid safe XML");
  }
  const parser = new XMLParser({
    ignoreAttributes: true, parseTagValue: false,
    isArray: (_name, path) => path === "rss.channel.item",
    processEntities: true,
  });
  const payload: unknown = parser.parse(xml);
  const parsed = feedSchema.safeParse(payload);
  if (!parsed.success || parsed.data.rss.channel.title !== `Met Office warnings for ${region}`) {
    throw new SafeError("Warning feed did not match the expected region or schema");
  }
  const warnings = (parsed.data.rss.channel.item ?? []).map((item) => ({
    title: item.title, url: item.link, publishedAt: new Date(item.pubDate).toISOString(),
  }));
  return warnings.filter((warning, index) => warnings.findIndex((candidate) =>
    candidate.url === warning.url && candidate.title === warning.title,
  ) === index);
}

/** Regional feed entries are not proof that a warning covers an individual town. */
export function withMetOfficeWarnings(forecasts: WeatherProvider, fetchImpl?: typeof fetch): WeatherProvider {
  return async (request) => {
    const requestedRegions = regions.filter((region) => region.locationIds.some((id) => request.locationIds.includes(id)));
    const warningsPromise = Promise.all(requestedRegions.map(async (region): Promise<readonly [string, WeatherWarnings]> => {
      try {
        const xml = await fetchText(`https://www.metoffice.gov.uk/public/data/PWSCache/WarningsRSS/Region/${region.id}`, {
          signal: request.signal, timeoutMs: 6_000, retries: 1, maxResponseBytes: 131_072,
          ...(fetchImpl ? { fetchImpl } : {}),
        });
        return [region.id, {
          status: "ok", region: region.name, checkedAt: request.now.toISOString(),
          warnings: parseWarningFeed(xml, region.name),
        }];
      } catch (error) {
        return [region.id, {
          status: "unavailable", region: region.name,
          reason: error instanceof SafeError ? error.message
            : error instanceof HttpError ? `Warning request failed (${error.message})` : "Warning request failed",
        }];
      }
    }));
    const [results, warningEntries] = await Promise.all([forecasts(request), warningsPromise]);
    const warnings = new Map(warningEntries);
    return results.map((result) => {
      const region = regions.find((candidate) => candidate.locationIds.some((id) => id === result.locationId));
      const outcome = region ? warnings.get(region.id) : undefined;
      return {
        ...result,
        warnings: outcome ?? { status: "unavailable" as const, region: "Unmapped region", reason: "Warning region is not configured" },
      };
    });
  };
}
