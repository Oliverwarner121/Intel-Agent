import type { ServerEnv } from "@/config/env";
import type { OrchestratorDependencies, RunMode } from "@/services/orchestration/briefing-orchestrator.service";

/**
 * Production wiring of providers and delivery. Real providers are added in
 * later phases (Calendar, Email, Weather, News). Until then their sections are
 * reported as unavailable rather than filled with placeholder data.
 */
export function createBriefingDependencies(): OrchestratorDependencies {
  return {
    providers: { calendar: {}, weather: {}, news: {} },
  };
}

/**
 * Both Vercel projects deploy to their Production target, so VERCEL_ENV cannot
 * distinguish them. Only APP_ENV=prod may send; every other environment previews.
 */
export function runModeFor(env: ServerEnv): RunMode {
  return env.APP_ENV === "prod" ? "send" : "preview";
}
