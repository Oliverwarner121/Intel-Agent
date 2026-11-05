import { randomUUID } from "node:crypto";
import type { BriefingDefinition, BriefingSection } from "@/briefings/briefing.types";
import { getBriefingDefinition } from "@/briefings/registry";
import { localDayPeriod, rollingPeriod } from "@/lib/date";
import { HttpError } from "@/lib/http";
import { logger } from "@/lib/logger";
import { marketAssetResultSchema } from "@/types/markets";
import {
  SafeError,
  type BriefingDelivery,
  type BriefingModel,
  type BriefingSectionResult,
  type ProviderContext,
  type ProviderRegistry,
} from "@/types/briefing";

export type RunMode = "send" | "preview";

export type DeliveryOutcome =
  | { status: "sent"; messageId: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

export type RunStatus = "completed" | "completed-with-gaps" | "delivery-failed" | "disabled";

export interface BriefingRunResult {
  runId: string;
  briefingId: string;
  mode: RunMode;
  status: RunStatus;
  reportingDate: string;
  durationMs: number;
  /** Contains private calendar data: never log or return it from routes. */
  briefing?: BriefingModel;
  delivery: DeliveryOutcome;
}

export interface OrchestratorDependencies {
  providers: ProviderRegistry;
  /** Absent until delivery is configured; sending is then skipped, not faked. */
  delivery?: BriefingDelivery;
  now?: () => Date;
  sectionTimeoutMs?: number;
  getDefinition?: (id: string) => BriefingDefinition | undefined;
  createRunId?: () => string;
}

export class UnknownBriefingError extends Error {
  constructor(id: string) {
    super(`Unknown briefing: ${id}`);
    this.name = "UnknownBriefingError";
  }
}

const DEFAULT_SECTION_TIMEOUT_MS = 20_000;

function safeReason(error: unknown): string {
  if (error instanceof SafeError) return error.message;
  if (error instanceof HttpError) return `Provider request failed (${error.message})`;
  return "Provider request failed";
}

async function withTimeout<T>(task: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SafeError(`Timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([task(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function unavailable(section: BriefingSection, reason: string): BriefingSectionResult {
  const base = { id: section.id, title: section.title };
  const outcome = { status: "unavailable", reason } as const;
  switch (section.kind) {
    case "calendar":
      return { ...base, kind: "calendar", outcome };
    case "weather":
      return { ...base, kind: "weather", outcome };
    case "news":
      return { ...base, kind: "news", outcome };
    case "markets":
      return { ...base, kind: "markets", outcome };
  }
}

function notConfigured(section: BriefingSection): BriefingSectionResult {
  return unavailable(section, `Provider "${section.provider}" is not configured`);
}

async function collectSection(
  section: BriefingSection,
  providers: ProviderRegistry,
  context: Omit<ProviderContext, "signal">,
  timeoutMs: number,
): Promise<BriefingSectionResult> {
  const base = { id: section.id, title: section.title };
  try {
    switch (section.kind) {
      case "calendar": {
        const provider = providers.calendar[section.provider];
        if (!provider) return notConfigured(section);
        const period = localDayPeriod(context.now, context.timezone);
        const data = await withTimeout((signal) => provider({ ...context, signal, period }), timeoutMs);
        return { ...base, kind: "calendar", outcome: { status: "ok", data } };
      }
      case "weather": {
        const provider = providers.weather[section.provider];
        if (!provider) return notConfigured(section);
        const data = await withTimeout(
          (signal) => provider({ ...context, signal, locationIds: section.locationIds }),
          timeoutMs,
        );
        const failures = data.filter((location) => "unavailableReason" in location);
        if (failures.length === data.length && failures.length > 0 && !data.some((location) => location.warnings?.status === "ok")) {
          return unavailable(section, failures.map((location) => `${location.locationName}: ${location.unavailableReason}`).join("; "));
        }
        if (failures.length > 0 || data.some((location) => location.warnings?.status === "unavailable" ||
          (!("unavailableReason" in location) && location.hourlyUnavailableReason))) {
          return { ...base, kind: "weather", outcome: { status: "partial", data } };
        }
        return { ...base, kind: "weather", outcome: { status: "ok", data } };
      }
      case "news": {
        const provider = providers.news[section.provider];
        if (!provider) return notConfigured(section);
        const data = await withTimeout(
          (signal) =>
            provider({
              ...context,
              signal,
              category: section.category,
              maxStories: section.maxStories,
              window: rollingPeriod(context.now, section.windowHours),
            }),
          timeoutMs,
        );
        return {
          ...base,
          kind: "news",
          outcome: { status: "ok", data: data.slice(0, section.maxStories) },
        };
      }
      case "markets": {
        const provider = providers.markets?.[section.provider];
        if (!provider) return notConfigured(section);
        const response = await withTimeout(
          (signal) => provider({ ...context, signal, assetIds: section.assetIds }),
          timeoutMs,
        );
        const parsed = marketAssetResultSchema.array().safeParse(response);
        if (!parsed.success) throw new SafeError("Market provider returned invalid data");
        const results = parsed.data;
        if (new Set(results.map((asset) => asset.assetId)).size !== results.length ||
          results.some((asset) => !section.assetIds.includes(asset.assetId))) {
          throw new SafeError("Market provider returned unexpected or duplicate assets");
        }
        const data = section.assetIds.map((assetId) =>
          results.find((asset) => asset.assetId === assetId) ??
          { assetId, status: "unavailable" as const, reason: "Market provider omitted this asset" },
        );
        const failures = data.filter((asset) => asset.status === "unavailable");
        if (failures.length === data.length) {
          return unavailable(section, failures.map((asset) => `${asset.assetId}: ${asset.reason}`).join("; "));
        }
        return { ...base, kind: "markets", outcome: { status: failures.length ? "partial" : "ok", data } };
      }
    }
  } catch (error) {
    return unavailable(section, safeReason(error));
  }
}

/**
 * Runs one registered briefing: resolves its definition and reporting date,
 * collects sections concurrently, isolates provider failures and delivers at
 * most once per run. Delivery is never retried here.
 */
export async function runBriefing(
  briefingId: string,
  mode: RunMode,
  dependencies: OrchestratorDependencies,
): Promise<BriefingRunResult> {
  const definition = (dependencies.getDefinition ?? getBriefingDefinition)(briefingId);
  if (!definition) throw new UnknownBriefingError(briefingId);

  const now = (dependencies.now ?? (() => new Date()))();
  const runId = (dependencies.createRunId ?? randomUUID)();
  const reportingDate = localDayPeriod(now, definition.timezone).date;
  const finish = (result: Omit<BriefingRunResult, "runId" | "briefingId" | "mode" | "reportingDate" | "durationMs">) => {
    const run: BriefingRunResult = {
      runId,
      briefingId,
      mode,
      reportingDate,
      durationMs: Date.now() - now.getTime(),
      ...result,
    };
    logger.info("briefing.run.finished", summariseRun(run));
    return run;
  };

  if (!definition.enabled) {
    return finish({ status: "disabled", delivery: { status: "skipped", reason: "Briefing is disabled" } });
  }

  const context = { now, timezone: definition.timezone, reportingDate };
  const timeoutMs = dependencies.sectionTimeoutMs ?? DEFAULT_SECTION_TIMEOUT_MS;
  const sections = await Promise.all(
    definition.sections.map((section) => collectSection(section, dependencies.providers, context, timeoutMs)),
  );
  const briefing: BriefingModel = {
    briefingId,
    name: definition.name,
    timezone: definition.timezone,
    reportingDate,
    generatedAt: now.toISOString(),
    sections,
  };
  const hasGaps = sections.some((section) => section.outcome.status !== "ok");

  let delivery: DeliveryOutcome;
  if (mode === "preview") {
    delivery = { status: "skipped", reason: "Preview mode" };
  } else if (!dependencies.delivery) {
    delivery = { status: "skipped", reason: "Delivery is not configured" };
  } else {
    try {
      const sent = await dependencies.delivery({
        briefing,
        subject: definition.delivery.subject,
        template: definition.template,
      });
      delivery = { status: "sent", messageId: sent.messageId };
    } catch (error) {
      delivery = { status: "failed", reason: error instanceof SafeError ? error.message : "Delivery failed" };
    }
  }

  return finish({
    status: delivery.status === "failed" ? "delivery-failed" : hasGaps ? "completed-with-gaps" : "completed",
    briefing,
    delivery,
  });
}

/** Safe-to-log/return summary with item counts only; no section contents. */
export function summariseRun(run: BriefingRunResult) {
  return {
    runId: run.runId,
    briefingId: run.briefingId,
    mode: run.mode,
    status: run.status,
    reportingDate: run.reportingDate,
    durationMs: run.durationMs,
    sections: (run.briefing?.sections ?? []).map((section) =>
      section.outcome.status === "unavailable"
        ? { id: section.id, status: "unavailable" as const, reason: section.outcome.reason }
        : section.kind === "weather"
          ? {
            id: section.id, status: section.outcome.status,
            items: section.outcome.data.filter((location) => !("unavailableReason" in location)).length,
            locations: section.outcome.data.map((location) => "unavailableReason" in location
              ? { id: location.locationId, status: "unavailable" as const, reason: location.unavailableReason,
                ...(location.warnings ? { warningsStatus: location.warnings.status } : {}) }
              : { id: location.locationId, status: "ok" as const,
                ...(location.warnings ? { warningsStatus: location.warnings.status } : {}) }),
          }
          : section.kind === "markets"
            ? {
              id: section.id, status: section.outcome.status,
              items: section.outcome.data.filter((asset) => asset.status === "ok").length,
              assets: section.outcome.data.map((asset) => ({
                id: asset.assetId, status: asset.status,
                ...(asset.status === "unavailable" ? { reason: asset.reason } : {}),
              })),
            }
            : { id: section.id, status: "ok" as const, items: section.outcome.data.length },
    ),
    delivery: run.delivery,
  };
}
