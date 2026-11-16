import { describe, expect, it, vi } from "vitest";
import { briefingSectionSchema, type BriefingDefinition } from "@/briefings/briefing.types";
import { getBriefingDefinition } from "@/briefings/registry";
import { marketAssets } from "@/config/market-assets";
import { renderBriefingEmail } from "@/services/delivery/email-renderer";
import { runBriefing, summariseRun } from "@/services/orchestration/briefing-orchestrator.service";
import { createBriefingDependencies } from "@/services/orchestration/dependencies";
import { SafeError, type BriefingModel, type MarketsProvider } from "@/types/briefing";
import { marketAssetResultSchema, type MarketAssetId, type MarketAssetResult } from "@/types/markets";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const now = new Date("2026-07-01T05:00:00Z");
const marketSection = briefingSectionSchema.parse({
  id: "markets", title: "Markets", kind: "markets", provider: "mock-markets",
  assetIds: marketAssets.map((asset) => asset.id),
});

function definition(): BriefingDefinition {
  const morning = getBriefingDefinition("morning-briefing");
  if (!morning) throw new Error("Missing morning definition");
  return { ...morning, sections: [...morning.sections, marketSection] };
}

function snapshot(assetId: MarketAssetId): MarketAssetResult {
  return {
    assetId, status: "ok", price: assetId === "xrp" ? 1.2345 : 123.45,
    asOf: "2026-06-30T20:00:00Z", priceType: "close", stale: false,
    change: { percent: 0, basis: "previous-close" },
    source: { name: "Mock source", url: "https://example.com/markets" },
  };
}

function model(data: MarketAssetResult[]): BriefingModel {
  return {
    briefingId: "morning-briefing", name: "Morning Briefing", timezone: "Europe/London",
    reportingDate: "2026-07-01", generatedAt: now.toISOString(),
    sections: [{ id: "markets", title: "Markets", kind: "markets", outcome: { status: "ok", data } }],
  };
}

async function run(markets?: MarketsProvider) {
  return runBriefing("morning-briefing", "preview", {
    now: () => now,
    sectionTimeoutMs: 10,
    getDefinition: definition,
    providers: {
      calendar: { "google-calendar": async () => [] },
      weather: { "open-meteo": async () => [] },
      news: { gnews: async () => [] },
      markets: markets ? { "mock-markets": markets } : {},
    },
  });
}

describe("market foundation", () => {
  it("leaves scheduled sections and live dependencies unchanged", () => {
    expect(getBriefingDefinition("morning-briefing")?.sections.map((section) => section.kind))
      .toEqual(["calendar", "weather", "news", "news", "news"]);
    expect(createBriefingDependencies({ APP_ENV: "dev", CRON_SECRET: "x".repeat(32) }).providers.markets)
      .toBeUndefined();
    expect(marketAssets.map((asset) => asset.symbol))
      .toEqual(["NVDA", "AAPL", "MSFT", "AMZN", "GOOGL", "BTC/GBP", "ETH/GBP", "XRP/USD"]);
  });

  it("validates selections and rejects duplicate, unsupported or empty assets", () => {
    for (const assetIds of [[], ["nvda", "nvda"], ["spx"]]) {
      expect(() => briefingSectionSchema.parse({ ...marketSection, assetIds })).toThrow();
    }
  });

  it("adds Markets only when enabled, preserves order and never wires email in dev", () => {
    const dependencies = createBriefingDependencies({
      APP_ENV: "dev", CRON_SECRET: "x".repeat(32), MARKETS_ENABLED: "true", TWELVE_DATA_API_KEY: "mock-key",
    });
    expect(dependencies.providers.markets?.["twelve-data"]).toBeTypeOf("function");
    expect(dependencies.getDefinition?.("morning-briefing")?.sections.map((section) => section.id))
      .toEqual(["calendar", "weather", "tech-ai", "uk-politics-finance", "global-affairs", "markets"]);
    expect(dependencies.getDefinition?.("unknown")).toBeUndefined();
    expect(dependencies.delivery).toBeUndefined();
    expect(() => createBriefingDependencies({
      APP_ENV: "dev", CRON_SECRET: "x".repeat(32), MARKETS_ENABLED: "true",
    })).toThrow("TWELVE_DATA_API_KEY");
  });

  it("passes snapshot time, London date and cancellation; preserves configured order", async () => {
    const provider = vi.fn<MarketsProvider>().mockImplementation(async ({ assetIds }) =>
      assetIds.toReversed().map(snapshot),
    );
    const result = await run(provider);
    expect(result.status).toBe("completed");
    expect(provider.mock.calls[0]?.[0]).toMatchObject({
      now, reportingDate: "2026-07-01", timezone: "Europe/London",
      assetIds: marketAssets.map((asset) => asset.id),
    });
    expect(provider.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal);
    expect(result.briefing?.sections.map((section) => section.id)).toEqual([
      "calendar", "weather", "tech-ai", "uk-politics-finance", "global-affairs", "markets",
    ]);
    expect(result.briefing?.sections.at(-1)?.outcome).toEqual({
      status: "ok", data: marketAssets.map((asset) => snapshot(asset.id)),
    });
    const summary = summariseRun(result).sections.at(-1);
    expect(summary).toMatchObject({ status: "ok", items: 8 });
    expect(JSON.stringify(summary)).not.toMatch(/123\.45|Mock source/);
  });

  it("preserves successes when assets fail or are omitted and counts only successes", async () => {
    const result = await run(async () => [
      snapshot("nvda"), { assetId: "aapl", status: "unavailable", reason: "Quote unavailable" },
    ]);
    expect(result.status).toBe("completed-with-gaps");
    expect(result.briefing?.sections.at(-1)?.outcome).toMatchObject({
      status: "partial", data: [
        { assetId: "nvda", status: "ok" },
        { assetId: "aapl", status: "unavailable", reason: "Quote unavailable" },
        { assetId: "msft", status: "unavailable", reason: "Market provider omitted this asset" },
        {}, {}, {}, {}, {},
      ],
    });
    expect(summariseRun(result).sections.at(-1)).toMatchObject({ status: "partial", items: 1 });
  });

  it("reports empty retrieval and all-asset failures as unavailable, never fabricated zeros", async () => {
    for (const provider of [
      async () => [],
      async () => marketAssets.map((asset): MarketAssetResult => ({
        assetId: asset.id, status: "unavailable", reason: "Not accessible",
      })),
    ]) {
      const result = await run(provider);
      expect(result.briefing?.sections.at(-1)?.outcome.status).toBe("unavailable");
      expect(result.briefing?.sections[0]?.outcome.status).toBe("ok");
    }
  });

  it("reports missing providers, sanitises errors and bounds stalled retrieval", async () => {
    expect((await run()).briefing?.sections.at(-1)?.outcome).toEqual({
      status: "unavailable", reason: 'Provider "mock-markets" is not configured',
    });
    const failed = await run(async () => { throw new Error("secret-value"); });
    expect(JSON.stringify(failed)).not.toContain("secret-value");
    expect(failed.briefing?.sections.at(-1)?.outcome).toEqual({
      status: "unavailable", reason: "Provider request failed",
    });
    const timeout = await run(() => new Promise(() => undefined));
    expect(timeout.briefing?.sections.at(-1)?.outcome).toEqual({
      status: "unavailable", reason: "Timed out after 10 ms",
    });
  });

  it("rejects duplicate and unrequested provider results", async () => {
    const duplicate = await run(async () => [snapshot("nvda"), snapshot("nvda")]);
    expect(duplicate.briefing?.sections.at(-1)?.outcome).toEqual({
      status: "unavailable", reason: "Market provider returned unexpected or duplicate assets",
    });
    const result = await runBriefing("morning-briefing", "preview", {
      now: () => now,
      getDefinition: () => ({
        ...definition(), sections: [{ ...marketSection, kind: "markets", assetIds: ["nvda"] }],
      }),
      providers: { calendar: {}, weather: {}, news: {}, markets: { "mock-markets": async () => [snapshot("aapl")] } },
    });
    expect(result.briefing?.sections[0]?.outcome.status).toBe("unavailable");
  });

  it.each([NaN, Infinity, -1, 0])("rejects invalid price %s at orchestration and rendering", async (price) => {
    const valid = snapshot("nvda");
    if (valid.status !== "ok") throw new Error("Invalid fixture");
    const invalid = { ...valid, price };
    expect(marketAssetResultSchema.safeParse(invalid).success).toBe(false);
    expect((await run(async () => [invalid])).briefing?.sections.at(-1)?.outcome).toEqual({
      status: "unavailable", reason: "Market provider returned invalid data",
    });
    expect(() => renderBriefingEmail(model([invalid]), "morning-briefing")).toThrow(SafeError);
  });

  it("rejects malformed timestamps and non-finite movements", () => {
    const valid = snapshot("nvda");
    expect(marketAssetResultSchema.safeParse({ ...valid, asOf: "yesterday" }).success).toBe(false);
    expect(marketAssetResultSchema.safeParse({
      ...valid, change: { percent: NaN, basis: "24-hours" },
    }).success).toBe(false);
  });

  it.each([
    { low: 150, high: 100 }, { low: 100, high: 120 }, { open: 99, low: 100, high: 150 },
    { volume: -1 }, { volume: Infinity }, { date: "2026-02-30" },
  ])("rejects invalid session details before orchestration or rendering: %j", async (session) => {
    const invalid = { ...snapshot("nvda"), session };
    expect(marketAssetResultSchema.safeParse(invalid).success).toBe(false);
    expect((await run(async () => [invalid])).briefing?.sections.at(-1)?.outcome).toEqual({
      status: "unavailable", reason: "Market provider returned invalid data",
    });
    expect(() => renderBriefingEmail(model([invalid]), "morning-briefing")).toThrow(SafeError);
  });
});

describe("market rendering", () => {
  it("keeps only names, prices and stale notices in collapsed headers while preserving failures and details", () => {
    const stock = snapshot("nvda");
    if (stock.status !== "ok") throw new Error("Invalid fixture");
    const { html, text } = renderBriefingEmail(model([
      { ...stock, stale: true, session: { low: 100, high: 150, volume: 0 } },
      { ...stock, assetId: "bitcoin", priceType: "last-trade" },
      { assetId: "ethereum", status: "unavailable", reason: "Quote unavailable" },
    ]), "morning-briefing");
    const labels = [...html.matchAll(/<label class="disclosure-heading"[^>]*>([\s\S]*?)<\/label>/g)]
      .map((match) => match[1]);
    expect(labels).toHaveLength(2);
    expect(labels[0]).toContain("Nvidia (NVDA)");
    expect(labels[0]).toContain("USD");
    expect(labels[0]).toContain("123.45");
    expect(labels[0]).toContain("Stale quote");
    expect(labels[1]).toContain("Bitcoin (BTC/GBP)");
    expect(labels[1]).toContain("GBP");
    expect(labels.join("")).not.toMatch(/Session range|Volume|previous close|closing price/);
    expect(html).toContain("Data unavailable: Quote unavailable");
    expect(html).toContain("Session range:");
    expect(text).toContain("Volume: 0");
    expect(text).toContain("(stale)");
  });

  it("colours gains green and losses red, keeping zero and missing changes neutral", () => {
    const asset = snapshot("bitcoin");
    if (asset.status !== "ok") throw new Error("Invalid fixture");
    const { html, text } = renderBriefingEmail(model([
      { ...asset, change: { percent: 2.5, basis: "24-hours" } },
      { ...asset, assetId: "ethereum", change: { percent: -1.25, basis: "24-hours" } },
      { ...asset, assetId: "xrp", change: { percent: 0, basis: "24-hours" } },
      { ...asset, assetId: "nvda", change: undefined },
      { ...asset, assetId: "aapl", change: { percent: -3, basis: "previous-close" } },
    ]), "morning-briefing");
    expect(html).toMatch(/class="change-positive rule"[^>]*color:#75dfa7[^>]*>\+2\.50% over 24 hours/);
    expect(html).toMatch(/class="change-negative rule"[^>]*color:#ff9aa5[^>]*>-1\.25% over 24 hours/);
    expect(html).toMatch(/class="copy rule"[^>]*>0\.00% over 24 hours/);
    expect(html).toMatch(/class="copy rule"[^>]*>change unavailable/);
    expect(html).toMatch(/class="change-negative rule"[^>]*color:#ff9aa5[^>]*>-3\.00% vs previous close/);
    expect(html).toContain(".change-positive { color: #75dfa7 !important; }");
    expect(html).toContain(".change-negative { color: #ff9aa5 !important; }");
    expect(text).toContain("+2.50% over 24 hours");
    expect(text).toContain("-1.25% over 24 hours");
  });

  it("renders currency, precision, zero/positive/negative changes, timestamps and stale labels", () => {
    const stock = snapshot("nvda");
    const crypto = snapshot("bitcoin");
    if (stock.status !== "ok" || crypto.status !== "ok") throw new Error("Invalid fixture");
    const rendered = renderBriefingEmail(model([
      stock,
      { ...stock, assetId: "aapl", change: { percent: -2.14, basis: "previous-close" } },
      { ...crypto, priceType: "last-trade", stale: true, change: { percent: 1.32, basis: "24-hours" } },
      snapshot("xrp"),
    ]), "morning-briefing");
    for (const output of [rendered.text, rendered.html]) {
      expect(output).toContain("Stocks (USD)");
      expect(output).toContain("Crypto (BTC/ETH in GBP; XRP in USD)");
      expect(output).toContain("USD");
      expect(output).toContain("GBP");
      expect(output).toContain("1.2345");
      expect(output).toContain("0.00% vs previous close");
      expect(output).toContain("-2.14% vs previous close");
      expect(output).toContain("+1.32% over 24 hours");
      expect(output).toContain("closing price as of 30 Jun 2026, 21:00");
      expect(output).toContain("last trade as of 30 Jun 2026, 21:00 (stale)");
      expect(output).not.toContain("Source: Mock source");
      expect(output).not.toContain("https://example.com/markets");
    }
    expect(rendered.text).toMatch(/XRP \(XRP\/USD\): USD\s*1\.2345/);
    expect(rendered.html).toContain('aria-label="Market snapshots"');
    expect(rendered.html.match(/class="inset market-card"/g)).toHaveLength(4);
    expect(rendered.html).toContain(">Nvidia (NVDA)</span>");
    expect(rendered.html).toContain("Session range unavailable");
    expect(rendered.text.indexOf("Stocks (USD)")).toBeLessThan(rendered.text.indexOf("Crypto (BTC/ETH in GBP; XRP in USD)"));
  });

  it("renders last-session cards with genuine range positions, daily statistics and matching plain text", () => {
    const asset = snapshot("nvda");
    if (asset.status !== "ok") throw new Error("Invalid fixture");
    const rendered = renderBriefingEmail(model([{
      ...asset, price: 125,
      change: { percent: (125 / 120 - 1) * 100, basis: "previous-close" },
      session: { date: "2026-06-30", open: 110, low: 100, high: 150, previousClose: 120, volume: 0 },
    }]), "morning-briefing");
    for (const output of [rendered.html, rendered.text]) {
      expect(output).toContain("Last completed session");
      expect(output).toContain("30 Jun 2026");
      expect(output).toContain("110.00");
      expect(output).toContain("120.00");
      expect(output).toContain("100.00");
      expect(output).toContain("150.00");
      expect(output).toContain("Volume");
      expect(output).toContain("Session change");
      expect(output).toContain("+4.17% vs previous close");
    }
    expect(rendered.text).toMatch(/Volume: 0/);
    expect(rendered.text).toMatch(/Session change: \+USD\s*5\.00/);
    expect(rendered.html).toContain('role="img" aria-label="Session range:');
    expect(rendered.html).toContain("close at 50% of the range.");
    expect(rendered.html).toContain('width="50%" height="10"');
    expect(rendered.html).toMatch(/class="change-negative"[^>]*color:#ff9aa5[^>]*>Low/);
    expect(rendered.html).toMatch(/class="change-positive"[^>]*color:#75dfa7[^>]*>High/);
  });

  it.each([
    { price: 100, high: 150, position: 0 },
    { price: 150, high: 150, position: 100 },
    { price: 100, high: 100, position: undefined },
  ])("handles a close at a range endpoint or a flat session: %j", ({ price, high, position }) => {
    const asset = snapshot("nvda");
    if (asset.status !== "ok") throw new Error("Invalid fixture");
    const rendered = renderBriefingEmail(model([{
      ...asset, price, session: { low: 100, high, open: price },
    }]), "morning-briefing");
    expect(rendered.html).not.toMatch(/NaN|Infinity|width="0%"/);
    expect(rendered.html).toContain(position === undefined
      ? "Flat session: high, low and price are equal."
      : `White marker: close within the range (${position}%).`);
  });

  it("does not mistake the crypto daily bar for a completed session or rolling 24-hour range", () => {
    const asset = snapshot("bitcoin");
    if (asset.status !== "ok") throw new Error("Invalid fixture");
    const rendered = renderBriefingEmail(model([{
      ...asset, priceType: "last-trade", change: { percent: 2, basis: "24-hours" },
      session: { low: 100, high: 150, open: 120 },
    }]), "morning-briefing");
    for (const output of [rendered.html, rendered.text]) {
      expect(output).toContain("Quoted daily bar");
      expect(output).toContain("Daily-bar range");
      expect(output).toContain("24-hour change and daily-bar range cover different periods.");
      expect(output).not.toContain("Last completed session");
    }
  });

  it("shows winter timestamps, absent changes and per-asset failures explicitly", () => {
    const asset = snapshot("nvda");
    if (asset.status !== "ok") throw new Error("Invalid fixture");
    const rendered = renderBriefingEmail(model([
      { ...asset, asOf: "2026-11-04T21:00:00Z", change: undefined },
      { assetId: "ethereum", status: "unavailable", reason: "Not configured <test>" },
    ]), "morning-briefing");
    expect(rendered.text).toContain("change unavailable");
    expect(rendered.text).toContain("4 Nov 2026, 21:00");
    expect(rendered.text).toContain("Ethereum (ETH/GBP): Data unavailable: Not configured <test>");
    expect(rendered.html).toContain("&lt;test&gt;");
    expect(rendered.html).not.toContain("<test>");
  });

  it("renders empty and unavailable sections distinctly", () => {
    expect(renderBriefingEmail(model([]), "morning-briefing").text).toContain("No market snapshots available.");
    const briefing = model([]);
    briefing.sections[0] = {
      id: "markets", title: "Markets", kind: "markets",
      outcome: { status: "unavailable", reason: "Awaiting provider permission" },
    };
    expect(renderBriefingEmail(briefing, "morning-briefing").text)
      .toContain("Data unavailable: Awaiting provider permission");
  });

  it("omits market source text and links while still rejecting unsafe metadata", () => {
    const asset = snapshot("nvda");
    if (asset.status !== "ok") throw new Error("Invalid fixture");
    const rendered = renderBriefingEmail(model([
      { ...asset, source: { name: "<script>", url: "https://example.com/?a=1&b=2" } },
    ]), "morning-briefing");
    expect(rendered.html).not.toContain("example.com");
    expect(rendered.html).not.toContain("&lt;script&gt;");
    for (const url of ["javascript:alert(1)", "https://user:password@example.com"]) {
      expect(() => renderBriefingEmail(model([{ ...asset, source: { name: "Source", url } }]), "morning-briefing"))
        .toThrow(/link/);
    }
  });
});
