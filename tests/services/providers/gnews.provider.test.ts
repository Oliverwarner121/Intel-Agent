import { afterEach, describe, expect, it, vi } from "vitest";
import { createGNewsProvider, gnewsQueries } from "@/services/providers/news/gnews.provider";
import { createBriefingDependencies } from "@/services/orchestration/dependencies";
import { runBriefing, summariseRun } from "@/services/orchestration/briefing-orchestrator.service";
import { renderBriefingEmail } from "@/services/delivery/email-renderer";
import { rollingPeriod } from "@/lib/date";
import { getServerEnv } from "@/config/env";
import { logger } from "@/lib/logger";
import { newsCategories } from "@/types/news";
import type { NewsProvider } from "@/types/briefing";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const now = new Date("2026-11-05T05:00:00Z");
const key = "test-key-not-for-logs";
const request: Parameters<NewsProvider>[0] = {
  now, timezone: "Europe/London", reportingDate: "2026-11-05",
  signal: new AbortController().signal, window: rollingPeriod(now, 24), maxStories: 3, category: "tech-ai",
};
function article(extra = {}) {
  return {
    title: "Artificial intelligence semiconductor breakthrough",
    description: "Researchers report a new chip for AI models.",
    url: "https://news.example/ai?utm_source=gnews", publishedAt: "2026-11-04T15:00:00Z",
    source: { name: "Example Publisher", url: "https://news.example" },
    content: "Article body must not enter the briefing", image: "https://images.example/image.png",
    ...extra,
  };
}
const json = (articles: unknown[]) => Response.json({ totalArticles: articles.length, articles });
const mockApi = (articles: unknown[] = [article()]) =>
  vi.fn<typeof fetch>().mockImplementation(async () => json(articles));

describe("GNews provider", () => {
  it("normalizes metadata, preserves source URL/time, and ignores full content and images", async () => {
    const fetchImpl = mockApi();
    const result = await createGNewsProvider(key, fetchImpl)(request);
    expect(result).toEqual({
      stories: [{
        title: "Artificial intelligence semiconductor breakthrough",
        description: "Researchers report a new chip for AI models.",
        url: "https://news.example/ai?utm_source=gnews", publishedAt: "2026-11-04T15:00:00Z",
        publisher: "Example Publisher", category: "tech-ai",
      }],
      notice: "News coverage delayed approximately 12 hours (GNews Free).",
    });
    expect(JSON.stringify(result)).not.toContain("Article body");
    const [input, init] = fetchImpl.mock.calls[0] ?? [];
    const url = new URL(String(input));
    expect(url.origin + url.pathname).toBe("https://gnews.io/api/v4/search");
    expect(url.searchParams.get("q")).toBe(gnewsQueries["tech-ai"]);
    expect(url.searchParams.get("max")).toBe("10");
    expect(url.searchParams.get("lang")).toBe("en");
    expect(url.searchParams.get("country")).toBeNull();
    expect(url.searchParams.get("from")).toBe("2026-11-04T05:00:00.000Z");
    expect(url.searchParams.get("to")).toBe("2026-11-04T17:00:00.000Z");
    expect(url.searchParams.get("sortby")).toBe("relevance");
    expect(String(input)).not.toContain(key);
    expect(init?.headers).toEqual({ "X-Api-Key": key });
    expect(init?.cache).toBe("no-store");
    expect(init?.redirect).toBe("error");
  });

  it.each(newsCategories)("assigns %s and uses the expected country/query", async (category) => {
    const fetchImpl = mockApi([article({
      title: category === "uk-politics-finance" ? "Bank of England cuts interest rates"
        : category === "global-affairs" ? "NATO diplomacy secures ceasefire treaty" : "AI models improve cybersecurity",
    })]);
    const result = await createGNewsProvider(key, fetchImpl)({ ...request, category });
    expect(result).toMatchObject({ stories: [{ category }] });
    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.searchParams.get("country")).toBe(category === "uk-politics-finance" ? "gb" : null);
    expect(url.searchParams.get("q")).toBe(gnewsQueries[category]);
    expect(gnewsQueries[category].length).toBeLessThanOrEqual(200);
  });

  it("does not mistake UK-published US political news for UK subject matter", async () => {
    const fetchImpl = mockApi([
      article({ title: "US government changes taxation", description: "Congress debates the US budget." }),
      article({ title: "UK government publishes Budget", url: "https://news.example/uk" }),
    ]);
    expect(await createGNewsProvider(key, fetchImpl)({ ...request, category: "uk-politics-finance" }))
      .toMatchObject({ stories: [{ title: "UK government publishes Budget" }] });
  });

  it("handles null descriptions and limits long excerpts without using content", async () => {
    const noDescription = await createGNewsProvider(key, mockApi([article({ description: null })]))(request);
    expect(noDescription).toMatchObject({ stories: [{ title: expect.any(String) }] });
    if (Array.isArray(noDescription)) throw new Error("Missing collection");
    expect(noDescription.stories[0]?.description).toBeUndefined();
    const long = await createGNewsProvider(key, mockApi([article({ description: "Brief factual metadata. ".repeat(100) })]))(request);
    if (Array.isArray(long)) throw new Error("Missing collection");
    expect(long.stories[0]?.description?.length).toBeLessThanOrEqual(280);
    expect(long.stories[0]?.description).toMatch(/\.\.\.$/);
  });

  it("returns empty successful results with a delay notice", async () => {
    expect(await createGNewsProvider(key, mockApi([]))(request))
      .toMatchObject({ stories: [], notice: expect.stringContaining("12 hours") });
  });

  it("ranks candidates and groups event paraphrases before returning the category", async () => {
    const fetchImpl = mockApi([
      article({ title: "UK government routine policy update", url: "https://news.example/first" }),
      article({ title: "Bank of England cuts interest rates", url: "https://news.example/rates" }),
      article({ title: "BoE votes to lower UK rates", description: "The Bank of England cuts rates.", url: "https://another.example/boe" }),
      article({ title: "Interest rates cut by Bank of England", url: "https://third.example/boe" }),
      article({ title: "British chancellor unveils Budget taxation and inflation policy", url: "https://news.example/budget" }),
    ]);
    const result = await createGNewsProvider(key, fetchImpl)({ ...request, category: "uk-politics-finance" });
    if (Array.isArray(result)) throw new Error("Missing collection");
    expect(result.stories).toHaveLength(3);
    expect(result.stories[0]?.url).toBe("https://news.example/budget");
    expect(result.stories.filter((story) => /rates/i.test(story.title))).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("requires a key without making requests and validates server configuration safely", async () => {
    const fetchImpl = mockApi();
    for (const apiKey of [undefined, "", " "]) {
      await expect(createGNewsProvider(apiKey, fetchImpl)(request)).rejects.toThrow("GNEWS_API_KEY is not configured");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getServerEnv({ CRON_SECRET: "x".repeat(32), GNEWS_API_KEY: " " }).GNEWS_API_KEY).toBeUndefined();
    expect(getServerEnv({ CRON_SECRET: "x".repeat(32), GNEWS_API_KEY: ` ${key} ` }).GNEWS_API_KEY).toBe(key);
  });

  it.each([400, 401, 403, 429, 500, 503])("surfaces HTTP %s without retries or raw secret responses", async (status) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(`${key} private provider response`, { status }));
    const result = createGNewsProvider(key, fetchImpl)(request);
    await expect(result).rejects.toThrow(String(status));
    await expect(result).rejects.not.toThrow(key);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    {}, { totalArticles: 1 }, { totalArticles: 1, articles: [article({ source: {} })] },
    { totalArticles: 1, articles: [article({ url: "javascript:alert(1)" })] },
    { totalArticles: 1, articles: [article({ url: "https://user:password@news.example" })] },
    { totalArticles: 1, articles: [article({ publishedAt: "invalid" })] },
    { totalArticles: 11, articles: Array.from({ length: 11 }, () => article()) },
  ])("rejects malformed or unsafe responses without a false empty success", async (payload) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload));
    await expect(createGNewsProvider(key, fetchImpl)(request)).rejects.toThrow("expected schema");
  });

  it("rejects malformed JSON and bounded oversized responses", async () => {
    for (const response of [new Response("{"), new Response("x".repeat(262_145))]) {
      await expect(createGNewsProvider(key, vi.fn<typeof fetch>().mockResolvedValue(response))(request))
        .rejects.toThrow(/valid JSON|size limit/);
    }
  });

  it("excludes stale/future/too-recent articles and preserves valid reporting-window boundaries", async () => {
    const fetchImpl = mockApi([
      article({ publishedAt: "2026-11-04T04:59:59Z", url: "https://news.example/stale" }),
      article({ publishedAt: "2026-11-05T06:00:00Z", url: "https://news.example/future" }),
      article({ publishedAt: "2026-11-04T17:00:01Z", url: "https://news.example/too-recent" }),
      article({ publishedAt: "2026-11-04T05:00:00Z", url: "https://news.example/start" }),
      article({ title: "Cybersecurity crisis strikes cloud computing", publishedAt: "2026-11-04T17:00:00Z", url: "https://news.example/end" }),
    ]);
    const result = await createGNewsProvider(key, fetchImpl)(request);
    if (Array.isArray(result)) throw new Error("Missing collection");
    expect(new Set(result.stories.map((story) => story.url)))
      .toEqual(new Set(["https://news.example/start", "https://news.example/end"]));
    await expect(createGNewsProvider(key, mockApi([article({ publishedAt: "2026-11-05T06:00:00Z" })]))(request))
      .rejects.toThrow("no articles within");
  });

  it("does not fetch an inaccessible short reporting window", async () => {
    const fetchImpl = mockApi();
    await expect(createGNewsProvider(key, fetchImpl)({ ...request, window: rollingPeriod(now, 6) }))
      .rejects.toThrow("no accessible articles");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reuses identical queries within an instance, while new reporting times fetch again", async () => {
    const fetchImpl = mockApi();
    const provider = createGNewsProvider(key, fetchImpl);
    const [a, b] = await Promise.all([provider(request), provider(request)]);
    expect(a).toEqual(b);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await provider({ ...request, now: new Date("2026-11-05T05:01:00Z") });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("bounds network failures and timeouts with no retries", async () => {
    const failedFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error(`private ${key}`));
    await expect(createGNewsProvider(key, failedFetch)(request)).rejects.toThrow("Network request failed");
    expect(failedFetch).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    const stalledFetch = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const result = createGNewsProvider(key, stalledFetch)(request);
    const assertion = expect(result).rejects.toThrow("Request timed out");
    await vi.advanceTimersByTimeAsync(6_001);
    await assertion;
    expect(stalledFetch).toHaveBeenCalledTimes(1);
  });

  it("honours parent cancellation", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const result = createGNewsProvider(key, fetchImpl)({ ...request, signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toThrow("request aborted");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("spaces category request starts to respect one request per second even after failure", async () => {
    const starts: number[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
      starts.push(Date.now());
      if (starts.length === 1) return new Response("", { status: 429 });
      return json([]);
    });
    const provider = createGNewsProvider(key, fetchImpl);
    const results = await Promise.allSettled(newsCategories.map((category) => provider({ ...request, category })));
    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
    expect(starts).toHaveLength(3);
    expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(1_100);
    expect((starts[2] ?? 0) - (starts[1] ?? 0)).toBeGreaterThanOrEqual(1_100);
  });

  it("cancels a waiting category without fetching or blocking the next category", async () => {
    const controller = new AbortController();
    const fetchImpl = mockApi([]);
    const provider = createGNewsProvider(key, fetchImpl);
    await provider(request);
    const waiting = provider({ ...request, category: "uk-politics-finance", signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(waiting).rejects.toThrow("request aborted");
    await provider({ ...request, category: "global-affairs" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("makes three searches and preserves successful categories when UK news fails", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const query = new URL(String(input)).searchParams.get("q");
      if (query === gnewsQueries["uk-politics-finance"]) return new Response(`${key} raw error`, { status: 429 });
      return json([article({ title: query === gnewsQueries["tech-ai"] ? "<b>AI cybersecurity breakthrough</b>"
        : "NATO negotiates international ceasefire treaty", description: "Metadata <script>unsafe</script> & context" })]);
    });
    const delivery = vi.fn();
    const dependencies = createBriefingDependencies({ APP_ENV: "local", CRON_SECRET: "x".repeat(32), GNEWS_API_KEY: key });
    const run = await runBriefing("morning-briefing", "preview", {
      ...dependencies, now: () => now, delivery,
      providers: { calendar: {}, weather: {}, news: { gnews: createGNewsProvider(key, fetchImpl) } },
    });
    expect(dependencies.providers.news.gnews).toBeTypeOf("function");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(delivery).not.toHaveBeenCalled();
    expect(run.status).toBe("completed-with-gaps");
    const news = run.briefing?.sections.filter((section) => section.kind === "news");
    expect(news?.map((section) => section.outcome.status)).toEqual(["ok", "unavailable", "ok"]);
    if (!run.briefing) throw new Error("Missing model");
    const { html, text } = renderBriefingEmail(run.briefing, "morning-briefing");
    expect(html).toContain("&lt;b&gt;AI cybersecurity");
    expect(html).toContain("&lt;script&gt;unsafe&lt;/script&gt;");
    expect(html).not.toContain("<script>unsafe");
    expect(html).toContain("Read more");
    for (const output of [html, text]) {
      expect(output).toContain("News coverage delayed approximately 12 hours");
      expect(output.match(/News coverage delayed approximately 12 hours/g)).toHaveLength(1);
      expect(output).not.toContain("Selected from the reporting window");
      expect(output).toContain("Publisher excerpt:");
      expect(output).toContain("Example Publisher");
      expect(output).toContain("4 Nov, 15:00");
      expect(output).toContain("GNews rate limit reached");
      expect(output).not.toContain(key);
    }
    expect(JSON.stringify(summariseRun(run))).not.toContain(key);
    expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain(key);
    expect(text).toContain("https://news.example/ai?utm_source=gnews");
  });

  it("keeps all three categories explicitly unavailable with a missing key", async () => {
    const dependencies = createBriefingDependencies({ APP_ENV: "local", CRON_SECRET: "x".repeat(32) });
    const run = await runBriefing("morning-briefing", "preview", {
      ...dependencies, now: () => now,
      providers: { calendar: {}, weather: {}, news: dependencies.providers.news },
    });
    expect(run.briefing?.sections.filter((section) => section.kind === "news").map((section) => section.outcome))
      .toEqual(Array.from({ length: 3 }, () => ({ status: "unavailable", reason: "GNEWS_API_KEY is not configured" })));
  });
});
