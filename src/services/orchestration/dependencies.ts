import type { ServerEnv } from "@/config/env";
import type { OrchestratorDependencies, RunMode } from "@/services/orchestration/briefing-orchestrator.service";
import {
  createGoogleCalendarProvider,
  googleCalendarConfigFrom,
} from "@/services/providers/calendar/google-calendar.provider";
import type { ProviderRegistry } from "@/types/briefing";

/**
 * Production wiring of providers and delivery. A provider is registered only
 * when its credentials are configured; otherwise its sections are reported as
 * unavailable rather than filled with placeholder data.
 */
export function createBriefingDependencies(env: ServerEnv): OrchestratorDependencies {
  const providers: ProviderRegistry = { calendar: {}, weather: {}, news: {} };

  const googleCalendar = googleCalendarConfigFrom(env);
  if (googleCalendar) providers.calendar["google-calendar"] = createGoogleCalendarProvider(googleCalendar);

  return { providers };
}

/**
 * Both Vercel projects deploy to their Production target, so VERCEL_ENV cannot
 * distinguish them. Only APP_ENV=prod may send; every other environment previews.
 */
export function runModeFor(env: ServerEnv): RunMode {
  return env.APP_ENV === "prod" ? "send" : "preview";
}
