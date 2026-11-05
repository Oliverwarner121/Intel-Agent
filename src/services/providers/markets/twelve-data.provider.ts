import { z } from "zod";
import { marketAssets } from "@/config/market-assets";
import { fetchJson, HttpError } from "@/lib/http";
import { SafeError, type MarketsProvider } from "@/types/briefing";
import type { MarketAsset, MarketAssetResult } from "@/types/markets";

const decimal = z.string().regex(/^-?\d+(?:\.\d+)?$/).transform(Number).pipe(z.number().finite());
const optionalDecimal = decimal.nullish();
const quoteSchema = z.object({
  symbol: z.string().min(1),
  exchange: z.string().min(1),
  currency: z.string().optional(),
  mic_code: z.string().optional(),
  close: decimal.pipe(z.number().positive()),
  last_quote_at: z.int().positive(),
  previous_close: optionalDecimal,
  rolling_1d_change: optionalDecimal,
});
const errorSchema = z.object({ status: z.literal("error"), code: z.int() });
const responseSchema = z.union([errorSchema, quoteSchema]);

function transform(
  quote: z.infer<typeof quoteSchema>, asset: MarketAsset, now: Date,
): MarketAssetResult {
  if (quote.symbol !== asset.symbol || (quote.currency !== undefined && quote.currency !== asset.currency) ||
    (asset.kind === "stock" && (quote.currency !== "USD" || quote.mic_code !== "XNGS" || quote.exchange !== "NASDAQ"))) {
    throw new SafeError("Market quote does not match the configured symbol, currency or exchange");
  }
  const instant = new Date(quote.last_quote_at * 1000);
  if (!Number.isFinite(instant.getTime()) || instant.getTime() > now.getTime() + 60_000) {
    throw new SafeError("Market quote has an invalid or future timestamp");
  }
  const change = asset.kind === "crypto"
    ? quote.rolling_1d_change === null || quote.rolling_1d_change === undefined
      ? undefined : { percent: quote.rolling_1d_change, basis: "24-hours" as const }
    : quote.previous_close === null || quote.previous_close === undefined || quote.previous_close <= 0
      ? undefined
      : { percent: (quote.close / quote.previous_close - 1) * 100, basis: "previous-close" as const };
  if (change && !Number.isFinite(change.percent)) throw new SafeError("Market quote has an invalid change");
  return {
    assetId: asset.id, status: "ok", price: quote.close, asOf: instant.toISOString(),
    priceType: asset.kind === "stock" ? "close" : "last-trade",
    stale: now.getTime() - instant.getTime() > (asset.kind === "stock" ? 7 * 86_400_000 : 15 * 60_000),
    ...(change ? { change } : {}),
    source: { name: `Twelve Data (${quote.exchange})`, url: "https://twelvedata.com/" },
  };
}

export function createTwelveDataProvider(apiKey: string, fetchImpl?: typeof fetch): MarketsProvider {
  if (!apiKey.trim()) throw new SafeError("TWELVE_DATA_API_KEY is required");
  return async ({ assetIds, now, signal }) => {
    if (assetIds.length === 0 || assetIds.length > 8 || new Set(assetIds).size !== assetIds.length) {
      throw new SafeError("Markets requires one to eight distinct configured assets");
    }
    const assets = assetIds.map((id) => {
      const asset = marketAssets.find((candidate) => candidate.id === id);
      if (!asset) throw new SafeError("Market asset is not configured");
      return asset;
    });
    return Promise.all(assets.map(async (asset): Promise<MarketAssetResult> => {
      try {
        const params = new URLSearchParams({
          symbol: asset.symbol, interval: "1day", apikey: apiKey.trim(),
          ...(asset.kind === "stock" ? { mic_code: "XNGS", eod: "true" } : { rolling_period: "24" }),
        });
        // Eight symbols exhaust Basic's minute allowance; retries could exceed it.
        const response = await fetchJson(`https://api.twelvedata.com/quote?${params}`, responseSchema, {
          signal, timeoutMs: 6_000, retries: 0, maxResponseBytes: 16_384,
          init: { cache: "no-store" }, ...(fetchImpl ? { fetchImpl } : {}),
        });
        if ("status" in response) {
          throw new SafeError(`Twelve Data rejected the quote (code ${response.code})`);
        }
        return transform(response, asset, now);
      } catch (error) {
        return {
          assetId: asset.id, status: "unavailable",
          reason: error instanceof SafeError ? error.message
            : error instanceof HttpError ? `Market request failed (${error.message})` : "Market request failed",
        };
      }
    }));
  };
}
