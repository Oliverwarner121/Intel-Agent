import { z } from "zod";

export const marketAssetIds = ["nvda", "aapl", "msft", "amzn", "googl", "bitcoin", "ethereum", "xrp"] as const;
export type MarketAssetId = typeof marketAssetIds[number];

export interface MarketAsset {
  id: MarketAssetId;
  name: string;
  symbol: string;
  kind: "stock" | "crypto";
  currency: "USD" | "GBP";
}

export const marketAssetResultSchema = z.discriminatedUnion("status", [
  z.object({
    assetId: z.enum(marketAssetIds),
    status: z.literal("ok"),
    price: z.number().finite().positive(),
    asOf: z.iso.datetime({ offset: true }),
    priceType: z.enum(["last-trade", "close"]),
    stale: z.boolean(),
    change: z.object({
      percent: z.number().finite(),
      basis: z.enum(["previous-close", "24-hours"]),
    }).optional(),
    session: z.object({
      date: z.iso.date().optional(),
      open: z.number().finite().positive().optional(),
      high: z.number().finite().positive().optional(),
      low: z.number().finite().positive().optional(),
      previousClose: z.number().finite().positive().optional(),
      volume: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    }).optional(),
    source: z.object({ name: z.string().trim().min(1), url: z.url() }),
  }),
  z.object({
    assetId: z.enum(marketAssetIds),
    status: z.literal("unavailable"),
    reason: z.string().trim().min(1),
  }),
]).superRefine((result, context) => {
  if (result.status !== "ok" || !result.session) return;
  const { low, high, open } = result.session;
  if (low !== undefined && high !== undefined && low > high) {
    context.addIssue({ code: "custom", path: ["session"], message: "Session low exceeds high" });
    return;
  }
  for (const price of [open, result.price]) {
    if (price !== undefined && ((low !== undefined && price < low) || (high !== undefined && price > high))) {
      context.addIssue({ code: "custom", path: ["session"], message: "Session price is outside its range" });
    }
  }
});

export type MarketAssetResult = z.infer<typeof marketAssetResultSchema>;
