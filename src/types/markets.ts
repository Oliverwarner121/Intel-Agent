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
    source: z.object({ name: z.string().trim().min(1), url: z.url() }),
  }),
  z.object({
    assetId: z.enum(marketAssetIds),
    status: z.literal("unavailable"),
    reason: z.string().trim().min(1),
  }),
]);

export type MarketAssetResult = z.infer<typeof marketAssetResultSchema>;
