import { createHash, timingSafeEqual } from "node:crypto";
import { ConfigError, getServerEnv, type ServerEnv } from "@/config/env";
import { logger } from "@/lib/logger";
import {
  runBriefing,
  summariseRun,
  type OrchestratorDependencies,
} from "@/services/orchestration/briefing-orchestrator.service";
import { createBriefingDependencies, runModeFor } from "@/services/orchestration/dependencies";

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Constant-time check of the "Authorization: Bearer <CRON_SECRET>" header Vercel Cron sends. */
export function isAuthorizedCronRequest(authorization: string | null, secret: string): boolean {
  if (authorization === null) return false;
  return timingSafeEqual(digest(authorization), digest(`Bearer ${secret}`));
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export interface CronHandlerOptions {
  env?: () => ServerEnv;
  dependencies?: () => OrchestratorDependencies;
}

/**
 * Thin, authenticated trigger: validates configuration and the Cron secret,
 * then delegates to the generic orchestrator. Responses contain only a safe
 * run summary, never briefing contents.
 */
export async function handleCronRequest(
  request: Request,
  briefingId: string,
  options: CronHandlerOptions = {},
): Promise<Response> {
  // Reading request headers first also keeps this route out of build-time prerendering.
  const authorization = request.headers.get("authorization");

  let env: ServerEnv;
  try {
    env = (options.env ?? getServerEnv)();
  } catch (error) {
    logger.error("cron.config.invalid", {
      briefingId,
      variables: error instanceof ConfigError ? error.invalidVariables : [],
    });
    return json({ error: "Server configuration error" }, 500);
  }

  if (!isAuthorizedCronRequest(authorization, env.CRON_SECRET)) {
    logger.warn("cron.unauthorized", { briefingId });
    return json({ error: "Unauthorized" }, 401);
  }

  try {
    const run = await runBriefing(
      briefingId,
      runModeFor(env),
      (options.dependencies ?? createBriefingDependencies)(),
    );
    return json(summariseRun(run), run.status === "delivery-failed" ? 502 : 200);
  } catch (error) {
    logger.error("cron.run.failed", { briefingId, error: error instanceof Error ? error.name : "unknown" });
    return json({ error: "Briefing run failed" }, 500);
  }
}
