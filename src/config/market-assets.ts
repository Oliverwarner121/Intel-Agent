import type { MarketAsset } from "@/types/markets";

export const marketAssets = [
  { id: "nvda", name: "Nvidia", symbol: "NVDA", kind: "stock", currency: "USD" },
  { id: "aapl", name: "Apple", symbol: "AAPL", kind: "stock", currency: "USD" },
  { id: "msft", name: "Microsoft", symbol: "MSFT", kind: "stock", currency: "USD" },
  { id: "amzn", name: "Amazon", symbol: "AMZN", kind: "stock", currency: "USD" },
  { id: "googl", name: "Alphabet (Google)", symbol: "GOOGL", kind: "stock", currency: "USD" },
  { id: "bitcoin", name: "Bitcoin", symbol: "BTC/GBP", kind: "crypto", currency: "GBP" },
  { id: "ethereum", name: "Ethereum", symbol: "ETH/GBP", kind: "crypto", currency: "GBP" },
  { id: "xrp", name: "XRP", symbol: "XRP/USD", kind: "crypto", currency: "USD" },
] as const satisfies readonly MarketAsset[];
