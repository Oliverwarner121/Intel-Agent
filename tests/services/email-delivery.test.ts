import { describe, expect, it, vi } from "vitest";
import { ConfigError, getServerEnv, type ServerEnv } from "@/config/env";
import { renderBriefingEmail } from "@/services/delivery/email-renderer";
import { createResendDelivery } from "@/services/delivery/resend-delivery";
import { createBriefingDependencies } from "@/services/orchestration/dependencies";
import { morningBriefing } from "@/briefings/definitions/morning-briefing";
import type { BriefingModel, DeliveryRequest } from "@/types/briefing";

const env: ServerEnv = {
  APP_ENV: "prod", CRON_SECRET: "x".repeat(32), EMAIL_SEND_ENABLED: "true",
  RESEND_API_KEY: "secret-test-key", EMAIL_FROM: "Intel-Agent <agent@example.com>", EMAIL_TO: "owner@example.com",
};
function model(): BriefingModel {
  return {
    briefingId: "morning-briefing", name: "Morning Briefing", timezone: "Europe/London",
    reportingDate: "2026-07-01", generatedAt: "2026-07-01T05:00:00Z",
    sections: [
      { id: "calendar", kind: "calendar", title: "Today's Calendar", outcome: { status: "ok", data: [
        { id: "office", title: "Office", timing: { kind: "all-day", startDate: "2026-07-01", endDate: "2026-07-02" } },
        { id: "meeting", title: '<script>alert("x")</script>', location: "A & B", timing: {
          kind: "timed", start: "2026-07-01T08:00:00Z", end: "2026-07-01T09:00:00Z",
        } },
      ] } },
      { id: "weather", kind: "weather", title: "Weather", outcome: { status: "unavailable", reason: "Not configured" } },
      ...(["tech-ai", "uk-politics-finance", "global-affairs"] as const).map((category) => ({
        id: category, kind: "news" as const,
        title: morningBriefing.sections.find((section) => section.id === category)?.title ?? category,
        outcome: { status: "ok" as const, data: [] },
      })),
    ],
  };
}
const request = (): DeliveryRequest => ({ briefing: model(), template: "morning-briefing", subject: "Morning briefing" });

describe("email renderer", () => {
  it("renders both formats in section order with UK times and escaped text", () => {
    const rendered = renderBriefingEmail(model(), "morning-briefing");
    expect(rendered.text).toContain("All day: Office");
    expect(rendered.text).toContain("09:00-10:00");
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).toContain("&lt;script&gt;");
    expect(rendered.html).toContain("A &amp; B");
    expect(rendered.text).toContain("Data unavailable: Not configured");
    expect(rendered.text).toContain("No stories selected.");
    for (const output of [rendered.html, rendered.text]) {
      const positions = morningBriefing.sections.map((section) => output.indexOf(
        output === rendered.html ? section.title.replace("'", "&#39;") : section.title,
      ));
      expect(positions.every((value, index) => value >= 0 && (index === 0 || value > (positions[index - 1] ?? -1)))).toBe(true);
    }
  });

  it("distinguishes an empty calendar from a retrieval failure", () => {
    const briefing = model();
    briefing.sections[0] = { id: "calendar", title: "Today's Calendar", kind: "calendar", outcome: { status: "ok", data: [] } };
    expect(renderBriefingEmail(briefing, "morning-briefing").text).toContain("No events scheduled today.");
  });

  it.each(["javascript:alert(1)", "https://user:password@example.com", "invalid"])("rejects unsafe link %s", (url) => {
    const briefing = model();
    briefing.sections[2] = { id: "tech-ai", kind: "news", title: "Tech", outcome: { status: "ok", data: [
      { title: "News", publisher: "Publisher", url, publishedAt: "2026-06-30T04:00:00Z", category: "tech-ai" },
    ] } };
    expect(() => renderBriefingEmail(briefing, "morning-briefing")).toThrow(/link/);
  });

  it("includes source links, publisher, publication time and older labels", () => {
    const briefing = model();
    briefing.sections[2] = { id: "tech-ai", kind: "news", title: "Tech", outcome: { status: "ok", data: [
      { title: "News", publisher: "Publisher", url: "https://example.com/?a=1&b=2", publishedAt: "2026-06-30T04:00:00Z", category: "tech-ai" },
    ] } };
    const rendered = renderBriefingEmail(briefing, "morning-briefing");
    expect(rendered.html).toContain('href="https://example.com/?a=1&amp;b=2"');
    expect(rendered.text).toContain("Publisher, 30 Jun, 05:00 (older than 24 hours)");
  });

  it("rejects unknown templates", () => {
    expect(() => renderBriefingEmail(model(), "unknown")).toThrow("template");
  });

  it("shows multi-day dates and preserves zero-valued weather measurements", () => {
    const briefing = model();
    briefing.sections[0] = {
      id: "calendar", kind: "calendar", title: "Today's Calendar", outcome: { status: "ok", data: [
        { id: "holiday", title: "Holiday", timing: { kind: "all-day", startDate: "2026-06-30", endDate: "2026-07-03" } },
      ] },
    };
    briefing.sections[1] = {
      id: "weather", kind: "weather", title: "Weather", outcome: { status: "ok", data: [{
        locationId: "wheatley", locationName: "Wheatley", date: "2026-07-01", summary: "Clear",
        temperatureMinC: 0, temperatureMaxC: 10, precipitationProbabilityPercent: 0, windSpeedMaxKph: 0,
      }] },
    };
    const rendered = renderBriefingEmail(briefing, "morning-briefing");
    expect(rendered.text).toContain("2026-06-30 to 2026-07-03, end exclusive");
    expect(rendered.text).toContain("Wheatley: Clear; 0-10 C; rain 0%; wind up to 0 km/h");
  });

  it("displays winter times without the summer offset", () => {
    const briefing = model();
    briefing.reportingDate = "2026-11-05";
    briefing.generatedAt = "2026-11-05T05:00:00Z";
    briefing.sections[0] = {
      id: "calendar", kind: "calendar", title: "Today's Calendar", outcome: { status: "ok", data: [{
        id: "meeting", title: "Meeting",
        timing: { kind: "timed", start: "2026-11-05T08:00:00Z", end: "2026-11-05T09:00:00Z" },
      }] },
    };
    expect(renderBriefingEmail(briefing, "morning-briefing").text).toContain("08:00-09:00: Meeting");
  });
});

describe("Resend delivery", () => {
  it("sends a fixed recipient, both formats and a stable key", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ id: "message-id" }));
    const send = createResendDelivery(env, fetchImpl);
    await expect(send(request())).resolves.toEqual({ messageId: "message-id" });
    await send(request());
    const init = fetchImpl.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ from: env.EMAIL_FROM, to: [env.EMAIL_TO], subject: "Morning briefing" });
    expect(body.html).toContain("<!doctype html>");
    expect(body.text).toContain("Morning Briefing");
    const headers = new Headers(init?.headers);
    expect(headers.get("idempotency-key")).toMatch(/^morning-briefing\/2026-07-01\/[a-f0-9]{16}$/);
    expect(headers.get("idempotency-key")).toBe(new Headers(fetchImpl.mock.calls[1]?.[1]?.headers).get("idempotency-key"));
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each(["local", "dev"] as const)("blocks %s even if enabled", async (APP_ENV) => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(createResendDelivery({ ...env, APP_ENV }, fetchImpl)(request())).rejects.toThrow("disabled");
    expect(createBriefingDependencies({ ...env, APP_ENV }).delivery).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stays disabled in prod until explicitly enabled", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const disabled = { ...env, EMAIL_SEND_ENABLED: "false" as const };
    await expect(createResendDelivery(disabled, fetchImpl)(request())).rejects.toThrow("disabled");
    expect(createBriefingDependencies(disabled).delivery).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([409, 429, 500])("never retries HTTP %i or leaks responses", async (status) => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response("private-response", { status }));
    await expect(createResendDelivery(env, fetchImpl)(request())).rejects.toThrow(status === 409 ? /conflict/ : /uncertain/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry network failures or invalid successful responses", async () => {
    for (const fetchImpl of [
      vi.fn<typeof fetch>().mockRejectedValue(new Error("private network details")),
      vi.fn<typeof fetch>().mockResolvedValue(Response.json({ unexpected: "private" })),
    ]) {
      await expect(createResendDelivery(env, fetchImpl)(request())).rejects.toThrow(/uncertain/);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
});

describe("email configuration", () => {
  it("requires all delivery settings when enabled", () => {
    expect(() => getServerEnv({ CRON_SECRET: env.CRON_SECRET, EMAIL_SEND_ENABLED: "true" })).toThrow(ConfigError);
  });
  it.each([
    { EMAIL_TO: "not-an-email" }, { EMAIL_FROM: "Invalid sender" }, { EMAIL_SEND_ENABLED: "yes" },
  ])("rejects invalid settings without exposing values", (settings) => {
    expect(() => getServerEnv({ CRON_SECRET: env.CRON_SECRET, ...settings })).toThrow(ConfigError);
  });
});
