import type { ServerEnv } from "@/config/env";
import type { OrchestratorDependencies, RunMode } from "@/services/orchestration/briefing-orchestrator.service";
import {
  createGoogleCalendarProvider,
  googleCalendarConfigFrom,
} from "@/services/providers/calendar/google-calendar.provider";
import type { ProviderRegistry } from "@/types/briefing";
import { createResendDelivery } from "@/services/delivery/resend-delivery";
import { createOpenMeteoProvider } from "@/services/providers/weather/open-meteo.provider";
import { withMetOfficeWarnings } from "@/services/providers/weather/met-office-warnings.provider";
import { createTwelveDataProvider } from "@/services/providers/markets/twelve-data.provider";
import { createGNewsProvider } from "@/services/providers/news/gnews.provider";
import { getBriefingDefinition } from "@/briefings/registry";
import { morningMarketsSection } from "@/briefings/definitions/morning-briefing";
import { SafeError } from "@/types/briefing";

/**
 * Production wiring of providers and delivery. A provider is registered only
 * when its credentials are configured; otherwise its sections are reported as
 * unavailable rather than filled with placeholder data.
 */
export function createBriefingDependencies(env: ServerEnv): OrchestratorDependencies {
  const providers: ProviderRegistry = { calendar: {}, weather: {}, news: {} };
  providers.weather["open-meteo"] = withMetOfficeWarnings(createOpenMeteoProvider());
  providers.news.gnews = createGNewsProvider(env.GNEWS_API_KEY);

  const googleCalendar = googleCalendarConfigFrom(env);
  if (googleCalendar) providers.calendar["google-calendar"] = createGoogleCalendarProvider(googleCalendar);

  if (env.MARKETS_ENABLED === "true") {
    if (!env.TWELVE_DATA_API_KEY) throw new SafeError("TWELVE_DATA_API_KEY is required when markets are enabled");
    providers.markets = { "twelve-data": createTwelveDataProvider(env.TWELVE_DATA_API_KEY) };
  }

  return {
    providers,
    ...(env.MARKETS_ENABLED === "true" ? {
      getDefinition: (id: string) => {
        const definition = getBriefingDefinition(id);
        return definition?.id === "morning-briefing"
          ? { ...definition, sections: [...definition.sections, morningMarketsSection] }
          : definition;
      },
    } : {}),
    ...(env.APP_ENV === "prod" && env.EMAIL_SEND_ENABLED === "true"
      ? { delivery: createResendDelivery(env) } : {}),
  };
}

/**
 * Both Vercel projects deploy to their Production target, so VERCEL_ENV cannot
 * distinguish them. Only APP_ENV=prod may send; every other environment previews.
 */
export function runModeFor(env: ServerEnv): RunMode {
  return env.APP_ENV === "prod" ? "send" : "preview";
}
