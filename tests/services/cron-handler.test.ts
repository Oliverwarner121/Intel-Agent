import { describe, expect, it, vi } from "vitest";
import type { ServerEnv } from "@/config/env";
import type { OrchestratorDependencies } from "@/services/orchestration/briefing-orchestrator.service";
import { handleCronRequest, isAuthorizedCronRequest } from "@/services/orchestration/cron-handler";
import { createBriefingDependencies, runModeFor } from "@/services/orchestration/dependencies";
import type { BriefingDelivery } from "@/types/briefing";
import { GET } from "@/app/api/cron/morning-briefing/route";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const SECRET = "s".repeat(40);
const request = (authorization?: string) =>
  new Request("https://intel-agent.test/api/cron/morning-briefing", {
    headers: authorization ? { authorization } : {},
  });
const env = (APP_ENV: ServerEnv["APP_ENV"]) => () => ({ APP_ENV, CRON_SECRET: SECRET });

describe("isAuthorizedCronRequest", () => {
  it("accepts only the exact bearer secret", () => {
    expect(isAuthorizedCronRequest(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(isAuthorizedCronRequest(SECRET, SECRET)).toBe(false);
    expect(isAuthorizedCronRequest(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(isAuthorizedCronRequest(null, SECRET)).toBe(false);
  });
});

describe("handleCronRequest", () => {
  it("rejects unauthenticated requests before running anything", async () => {
    const dependencies = vi.fn(() => createBriefingDependencies(env("prod")()));
    const response = await handleCronRequest(request("Bearer wrong"), "morning-briefing", {
      env: env("prod"),
      dependencies,
    });
    expect(response.status).toBe(401);
    expect(dependencies).not.toHaveBeenCalled();
  });

  it("fails closed with a generic error when configuration is invalid", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const response = await GET(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Server configuration error" });
    vi.unstubAllEnvs();
  });

  it("previews outside prod and returns a safe summary", async () => {
    const delivery = vi.fn<BriefingDelivery>();
    const dependencies = (): OrchestratorDependencies => ({ ...createBriefingDependencies(env("dev")()), delivery });
    const response = await handleCronRequest(request(`Bearer ${SECRET}`), "morning-briefing", {
      env: env("dev"),
      dependencies,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({ briefingId: "morning-briefing", mode: "preview", status: "completed-with-gaps" });
    expect(body.delivery).toEqual({ status: "skipped", reason: "Preview mode" });
    expect(delivery).not.toHaveBeenCalled();
    expect(body).not.toHaveProperty("briefing");
  });

  it("sends only in prod and reports delivery failure as 502", async () => {
    expect(runModeFor({ APP_ENV: "prod", CRON_SECRET: SECRET })).toBe("send");
    expect(runModeFor({ APP_ENV: "local", CRON_SECRET: SECRET })).toBe("preview");
    const delivery = vi.fn<BriefingDelivery>().mockRejectedValue(new Error("boom"));
    const response = await handleCronRequest(request(`Bearer ${SECRET}`), "morning-briefing", {
      env: env("prod"),
      dependencies: () => ({ ...createBriefingDependencies(env("dev")()), delivery }),
    });
    expect(response.status).toBe(502);
    expect(delivery).toHaveBeenCalledTimes(1);
  });

  it("returns a generic 500 for unexpected orchestration errors", async () => {
    const response = await handleCronRequest(request(`Bearer ${SECRET}`), "unknown-briefing", { env: env("prod") });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Briefing run failed" });
  });
});

describe("createBriefingDependencies", () => {
  it("registers Google Calendar only when its credentials are configured", () => {
    expect(createBriefingDependencies(env("dev")()).providers.calendar["google-calendar"]).toBeUndefined();
    const configured = createBriefingDependencies({
      ...env("dev")(),
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
      GOOGLE_REFRESH_TOKEN: "token",
    });
    expect(configured.providers.calendar["google-calendar"]).toBeTypeOf("function");
  });
});
