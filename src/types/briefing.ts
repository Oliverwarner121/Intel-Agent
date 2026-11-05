import type { SectionKind } from "@/briefings/briefing.types";
import type { LocalDayPeriod, ReportingPeriod } from "@/lib/date";
import type { CalendarCollection, CalendarEvent, CalendarRetrievalFailure } from "@/types/calendar";
import type { NewsCategory, NewsCollection, NewsStory } from "@/types/news";
import type { WeatherLocationResult } from "@/types/weather";
import type { MarketAssetId, MarketAssetResult } from "@/types/markets";

export interface SectionDataByKind {
  calendar: CalendarEvent[];
  weather: WeatherLocationResult[];
  news: NewsStory[];
  markets: MarketAssetResult[];
}

/** Empty data is "ok" with no items; failed retrieval is "unavailable". */
export type SectionOutcome<K extends SectionKind> =
  | { status: "ok"; data: SectionDataByKind[K]; notice?: string }
  | { status: "unavailable"; reason: string }
  | (K extends "calendar" ? {
    status: "partial"; data: CalendarEvent[]; unavailableCalendars: CalendarRetrievalFailure[];
  } : never)
  | (K extends "weather" | "markets" ? { status: "partial"; data: SectionDataByKind[K] } : never);

export type BriefingSectionResult = {
  [K in SectionKind]: { id: string; title: string; kind: K; outcome: SectionOutcome<K> };
}[SectionKind];

export interface BriefingModel {
  briefingId: string;
  name: string;
  timezone: string;
  /** Local reporting date, YYYY-MM-DD. */
  reportingDate: string;
  generatedAt: string;
  sections: BriefingSectionResult[];
}

export interface ProviderContext {
  now: Date;
  timezone: string;
  reportingDate: string;
  signal: AbortSignal;
}

export type CalendarProvider = (
  request: ProviderContext & { period: LocalDayPeriod },
) => Promise<CalendarEvent[] | CalendarCollection>;

export type WeatherProvider = (
  request: ProviderContext & { locationIds: string[] },
) => Promise<WeatherLocationResult[]>;

export type NewsProvider = (
  request: ProviderContext & { category: NewsCategory; window: ReportingPeriod; maxStories: number },
) => Promise<NewsStory[] | NewsCollection>;

export type MarketsProvider = (
  request: ProviderContext & { assetIds: MarketAssetId[] },
) => Promise<MarketAssetResult[]>;

/** Provider implementations keyed by the provider ID used in definitions. */
export interface ProviderRegistry {
  calendar: Partial<Record<string, CalendarProvider>>;
  weather: Partial<Record<string, WeatherProvider>>;
  news: Partial<Record<string, NewsProvider>>;
  markets?: Partial<Record<string, MarketsProvider>>;
}

export interface DeliveryRequest {
  briefing: BriefingModel;
  subject: string;
  template: string;
}

export type BriefingDelivery = (request: DeliveryRequest) => Promise<{ messageId: string }>;

/** An error whose message is safe to show in run results and logs. */
export class SafeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeError";
  }
}
