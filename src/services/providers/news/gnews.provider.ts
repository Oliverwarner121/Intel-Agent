import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { fetchJson, HttpError } from "@/lib/http";
import { SafeError, type NewsProvider } from "@/types/briefing";
import type { NewsCategory, NewsCollection } from "@/types/news";
import { selectNewsStories } from "@/services/processing/news-selection";

const SEARCH_URL = "https://gnews.io/api/v4/search";
const DELAY_MS = 12 * 60 * 60 * 1_000;
const NEWS_NOTICE = "News coverage delayed approximately 12 hours (GNews Free).";

export const gnewsQueries: Record<NewsCategory, string> = {
  "tech-ai": 'AI OR "artificial intelligence" OR technology OR semiconductors OR cybersecurity OR "cloud computing" OR OpenAI OR Anthropic OR Nvidia',
  "uk-politics-finance": '(UK OR Britain OR British OR "Bank of England") AND (government OR parliament OR economy OR inflation OR budget OR taxation OR "interest rates" OR employment OR markets OR finance)',
  "global-affairs": 'war OR diplomacy OR sanctions OR elections OR "global trade" OR "financial crisis" OR NATO OR "foreign policy" OR "international security" OR ceasefire OR tariffs OR "economic policy"',
};

const httpUrl = z.string().max(4096).refine((value) => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
});
const responseSchema = z.object({
  totalArticles: z.number().int().nonnegative(),
  articles: z.array(z.object({
    title: z.string().trim().min(1).max(1000),
    description: z.string().max(10_000).nullable().optional(),
    url: httpUrl,
    publishedAt: z.iso.datetime({ offset: true }),
    source: z.object({ name: z.string().trim().min(1).max(300), url: httpUrl }),
  })).max(10),
});

function excerpt(description: string | null | undefined): string | undefined {
  const text = description?.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  if (text.length <= 280) return text;
  const lastSpace = text.lastIndexOf(" ", 277);
  return `${text.slice(0, lastSpace > 0 ? lastSpace : 277)}...`;
}

function requestFailure(error: unknown): SafeError {
  if (!(error instanceof HttpError)) return new SafeError("GNews request failed");
  switch (error.status) {
    case 400: return new SafeError("GNews rejected the request; check API key and search configuration (HTTP 400)");
    case 401: return new SafeError("GNews API key was rejected (HTTP 401)");
    case 403: return new SafeError("GNews access denied; check email verification, plan and daily quota (HTTP 403)");
    case 429: return new SafeError("GNews rate limit reached (HTTP 429); request was not retried");
    default: return new SafeError(`GNews request failed (${error.message})`);
  }
}

/** Server wiring only; each instance caches at most one in-flight/result query per category. */
export function createGNewsProvider(apiKey: string | undefined, fetchImpl?: typeof fetch): NewsProvider {
  const cached = new Map<NewsCategory, { key: string; result: Promise<NewsCollection> }>();
  let nextRequestAt = 0;
  let requestSlot = Promise.resolve();
  function pacedRequest<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    const slot = requestSlot.then(async () => {
      signal.throwIfAborted();
      const waitMs = nextRequestAt - Date.now();
      if (waitMs > 0) await delay(waitMs, undefined, { signal });
      signal.throwIfAborted();
      try {
        return await task();
      } finally {
        nextRequestAt = Date.now() + 1_100;
      }
    });
    // A cancelled slot must not block other categories.
    requestSlot = slot.then(() => undefined, () => undefined);
    return slot;
  }
  return (request) => {
    if (!apiKey?.trim()) return Promise.reject(new SafeError("GNEWS_API_KEY is not configured"));
    const { category, window, now, maxStories, signal } = request;
    const key = `${window.start.toISOString()}/${window.end.toISOString()}/${now.toISOString()}/${maxStories}`;
    const existing = cached.get(category);
    if (existing?.key === key) return existing.result;
    const result = (async (): Promise<NewsCollection> => {
      const start = window.start.getTime();
      const end = Math.min(window.end.getTime(), now.getTime() - DELAY_MS);
      if (start >= end) throw new SafeError("GNews Free delay leaves no accessible articles in this reporting window");
      const params = new URLSearchParams({
        q: gnewsQueries[category], lang: "en", max: "10", in: "title,description",
        nullable: "description,image,content", truncate: "content", sortby: "relevance",
        from: new Date(start).toISOString(), to: new Date(end).toISOString(),
        ...(category === "uk-politics-finance" ? { country: "gb" } : {}),
      });
      let response: z.infer<typeof responseSchema>;
      try {
        response = await pacedRequest(signal, () => fetchJson(`${SEARCH_URL}?${params}`, responseSchema, {
          signal, timeoutMs: 6_000, retries: 0, maxResponseBytes: 262_144,
          init: { headers: { "X-Api-Key": apiKey.trim() }, cache: "no-store" },
          ...(fetchImpl ? { fetchImpl } : {}),
        }));
      } catch (error) {
        if (signal.aborted) throw new SafeError("GNews request aborted");
        throw requestFailure(error);
      }
      const candidates = response.articles.filter((article) => {
        const published = Date.parse(article.publishedAt);
        return published >= start && published <= end;
      }).map((article) => {
        const description = excerpt(article.description);
        return {
          title: article.title, url: article.url, publisher: article.source.name,
          publishedAt: article.publishedAt, category,
          ...(description ? { description } : {}),
        };
      });
      if (response.articles.length && !candidates.length) {
        throw new SafeError("GNews returned no articles within the requested delayed reporting window");
      }
      return { stories: selectNewsStories(candidates, maxStories), notice: NEWS_NOTICE };
    })();
    cached.set(category, { key, result });
    return result;
  };
}
