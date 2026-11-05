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

/**
 * Production wiring of providers and delivery. A provider is registered only
 * when its credentials are configured; otherwise its sections are reported as
 * unavailable rather than filled with placeholder data.
 */
export function createBriefingDependencies(env: ServerEnv): OrchestratorDependencies {
  const providers: ProviderRegistry = { calendar: {}, weather: {}, news: {} };
  providers.weather["open-meteo"] = withMetOfficeWarnings(createOpenMeteoProvider());

  const googleCalendar = googleCalendarConfigFrom(env);
  if (googleCalendar) providers.calendar["google-calendar"] = createGoogleCalendarProvider(googleCalendar);

  return {
    providers,
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
