import { describe, expect, it, vi } from "vitest";
import { createTwelveDataProvider } from "@/services/providers/markets/twelve-data.provider";
import { marketAssets } from "@/config/market-assets";
import type { MarketAssetId } from "@/types/markets";

const now = new Date("2026-11-05T05:00:00Z");
const request = (assetIds: MarketAssetId[] = marketAssets.map((asset) => asset.id)) => ({
  assetIds, now, reportingDate: "2026-11-05", timezone: "Europe/London",
  signal: new AbortController().signal,
});
function quote(symbol = "NVDA") {
  const crypto = symbol.includes("/");
  return {
    symbol, exchange: crypto ? "Coinbase Pro" : "NASDAQ",
    ...(crypto ? {} : { currency: "USD", mic_code: "XNGS" }),
    close: "110.00", previous_close: "100.00", rolling_1d_change: "-2.50",
    last_quote_at: Math.floor(new Date(crypto ? "2026-11-05T04:59:00Z" : "2026-11-04T21:00:00Z").getTime() / 1000),
  };
}
const fetchQuotes = () => vi.fn<typeof fetch>().mockImplementation(async (input) =>
  Response.json(quote(new URL(String(input)).searchParams.get("symbol") ?? "")),
);

describe("Twelve Data provider", () => {
  it("retrieves eight configured assets once, validates currency/exchange and computes labelled changes", async () => {
    const fetchImpl = fetchQuotes();
    const result = await createTwelveDataProvider("test-secret", fetchImpl)(request());
    expect(fetchImpl).toHaveBeenCalledTimes(8);
    expect(result).toHaveLength(8);
    expect(result.every((asset) => asset.status === "ok")).toBe(true);
    expect(result[0]).toMatchObject({
      assetId: "nvda", price: 110, priceType: "close", asOf: "2026-11-04T21:00:00.000Z", stale: false,
      change: { basis: "previous-close", percent: expect.closeTo(10, 8) },
      source: { name: "Twelve Data (NASDAQ)", url: "https://twelvedata.com/" },
    });
    expect(result[5]).toMatchObject({
      assetId: "bitcoin", priceType: "last-trade", change: { percent: -2.5, basis: "24-hours" },
    });
    for (const [input, init] of fetchImpl.mock.calls) {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://api.twelvedata.com");
      expect(url.pathname).toBe("/quote");
      expect(url.searchParams.get("apikey")).toBe("test-secret");
      expect(url.searchParams.get("interval")).toBe("1day");
      expect(init).toMatchObject({ redirect: "error", cache: "no-store" });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (!url.searchParams.get("symbol")?.includes("/")) {
        expect(url.searchParams.get("eod")).toBe("true");
        expect(url.searchParams.get("mic_code")).toBe("XNGS");
      }
    }
  });

  it("uses last_quote_at rather than the opening-candle timestamp", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      ...quote(), timestamp: 1, datetime: "1990-01-01",
    }));
    expect((await createTwelveDataProvider("key", fetchImpl)(request(["nvda"])))[0])
      .toMatchObject({ status: "ok", asOf: "2026-11-04T21:00:00.000Z" });
  });

  it("preserves zero changes and labels missing changes unavailable instead of inventing them", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      ...quote("BTC/GBP"), rolling_1d_change: "0",
    }));
    expect((await createTwelveDataProvider("key", fetchImpl)(request(["bitcoin"])))[0])
      .toMatchObject({ status: "ok", change: { percent: 0, basis: "24-hours" } });
    for (const previous_close of [null, undefined, "0"]) {
      const absent = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...quote(), previous_close }));
      const result = (await createTwelveDataProvider("key", absent)(request(["nvda"])))[0];
      expect(result?.status).toBe("ok");
      expect(result).not.toHaveProperty("change");
    }
  });

  it("marks stale stocks and crypto with distinct age thresholds", async () => {
    for (const [id, symbol, age] of [
      ["nvda", "NVDA", 8 * 86_400],
      ["bitcoin", "BTC/GBP", 16 * 60],
    ] as const) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
        ...quote(symbol), last_quote_at: now.getTime() / 1000 - age,
      }));
      expect((await createTwelveDataProvider("key", fetchImpl)(request([id])))[0])
        .toMatchObject({ status: "ok", stale: true });
    }
  });

  it.each([
    { symbol: "AAPL" }, { currency: "GBP" }, { mic_code: "XLON" }, { mic_code: "XNAS" }, { exchange: "IEX" },
    { close: "-1" }, { close: "NaN" }, { close: "" }, { close: 123 },
    { last_quote_at: undefined }, { last_quote_at: 0 },
    { last_quote_at: now.getTime() / 1000 + 120 },
  ])("rejects malformed or mismatched quote %j", async (fields) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...quote(), ...fields }));
    expect((await createTwelveDataProvider("key", fetchImpl)(request(["nvda"])))[0]?.status)
      .toBe("unavailable");
  });

  it("isolates a failed asset without exposing error response text or credentials", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const symbol = new URL(String(input)).searchParams.get("symbol") ?? "";
      return Response.json(symbol === "NVDA"
        ? { status: "error", code: 401, message: "secret-test-key raw response" } : quote(symbol));
    });
    const result = await createTwelveDataProvider("secret-test-key", fetchImpl)(request());
    expect(result[0]).toEqual({
      assetId: "nvda", status: "unavailable", reason: "Twelve Data rejected the quote (code 401)",
    });
    expect(result.slice(1).every((asset) => asset.status === "ok")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret-test-key");
    expect(JSON.stringify(result)).not.toContain("raw response");
  });

  it.each([401, 403, 429, 500])("does not retry HTTP %s against the exhausted minute budget", async (status) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("private-error", { status }));
    const result = await createTwelveDataProvider("key", fetchImpl)(request(["nvda"]));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result[0]).toEqual({
      assetId: "nvda", status: "unavailable", reason: `Market request failed (HTTP ${status})`,
    });
    expect(JSON.stringify(result)).not.toContain("private-error");
  });

  it("does not retry API-level rate limiting, invalid JSON or oversized responses", async () => {
    for (const response of [
      Response.json({ status: "error", code: 429, message: "private" }),
      new Response("not-json"),
      Response.json({ ...quote(), padding: "x".repeat(16_384) }),
      Response.json({}),
    ]) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
      expect((await createTwelveDataProvider("key", fetchImpl)(request(["nvda"])))[0]?.status)
        .toBe("unavailable");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("bounds timeouts, propagates cancellation and never retries", async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    try {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(new Error("aborted"));
          else signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
      );
      const timedOut = createTwelveDataProvider("key", fetchImpl)(request(["nvda"]));
      await vi.advanceTimersByTimeAsync(6_000);
      expect((await timedOut)[0]).toEqual({
        assetId: "nvda", status: "unavailable", reason: "Market request failed (Request timed out)",
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      fetchImpl.mockClear();
      const controller = new AbortController();
      const promise = createTwelveDataProvider("key", fetchImpl)({
        ...request(["nvda"]), signal: controller.signal,
      });
      controller.abort();
      expect((await promise)[0]).toEqual({
        assetId: "nvda", status: "unavailable", reason: "Market request failed (Request aborted)",
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      timeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("requires a key and rejects empty or duplicate selection before fetching", async () => {
    expect(() => createTwelveDataProvider(" ")).toThrow("TWELVE_DATA_API_KEY");
    const fetchImpl = vi.fn<typeof fetch>();
    for (const assetIds of [[], ["nvda", "nvda"]] satisfies MarketAssetId[][]) {
      await expect(createTwelveDataProvider("key", fetchImpl)(request(assetIds))).rejects.toThrow("distinct");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
