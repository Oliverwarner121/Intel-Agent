import { describe, expect, it, vi } from "vitest";
import { copilotChangelog } from "@/config/engineering-sources";
import { createCopilotChangelogProvider } from "@/services/providers/engineering/copilot-changelog.provider";
import { createEngineeringProvider } from "@/services/providers/engineering/engineering.provider";
import { selectEngineeringUpdates } from "@/services/processing/career-selection";
import { renderBriefingEmail } from "@/services/delivery/email-renderer";
import { engineeringUpdateSchema, type EngineeringUpdate } from "@/types/career";
import type { EngineeringProvider } from "@/types/briefing";

const request = () => ({
  now: new Date("2026-11-16T10:00:00Z"), reportingDate: "2026-11-16", timezone: "Europe/London", maxUpdates: 3,
  window: { start: new Date("2026-11-15T10:00:00Z"), end: new Date("2026-11-16T10:00:00Z") },
  signal: new AbortController().signal,
});
const article = (slug: string) => `https://github.blog/changelog/2026-11-16-${slug}`;
const rss = (items: { title: string; url?: string; at?: string }[] = []) => `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel><link>${copilotChangelog.channelUrl}</link>${items.map((item, index) => `<item>
<title>${item.title}</title><link>${item.url ?? article(`update-${index}`)}</link>
<pubDate>${item.at ?? "Mon, 16 Nov 2026 06:00:00 GMT"}</pubDate>
<content:encoded><![CDATA[<!DOCTYPE html><html>Article body not for display.</html>]]></content:encoded>
</item>`).join("")}</channel></rss>`;
const software = (
  id: string, category: "tools" | "frameworks" = "tools", publishedAt = "2026-11-16T09:00:00Z",
): EngineeringUpdate => ({
  id, kind: "release", category, source: id, title: `Release ${id}`, version: "v1",
  publishedAt, url: `https://github.com/example/${id}/releases/tag/v1`,
});
const model: EngineeringUpdate = {
  id: "model", kind: "announcement", category: "models", source: "GitHub Copilot",
  title: "Gemini example now available in GitHub Copilot", publishedAt: "2026-11-15T10:00:00Z",
  url: article("gemini-example"),
};
const provider = (updates: EngineeringUpdate[] = []): EngineeringProvider => async () => ({ updates, unavailableSources: [] });

describe("official Copilot changelog", () => {
  it("uses only the configured feed and preserves headline metadata, not article HTML or invented versions", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(rss([
      { title: "Gemini example in GitHub Copilot" },
      { title: "Tools &amp; agent improvements" },
      { title: "An older announcement", at: "Sun, 15 Nov 2026 09:59:59 GMT" },
      { title: "Future announcement", at: "Mon, 16 Nov 2026 10:00:00 GMT" },
    ])));
    const result = await createCopilotChangelogProvider(fetchImpl)(request());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(copilotChangelog.url);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", cache: "no-store" });
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).has("Authorization")).toBe(false);
    expect(result.updates).toMatchObject([
      { kind: "announcement", category: "models", publishedAt: "2026-11-16T06:00:00.000Z" },
      { kind: "announcement", category: "tools", title: "Tools & agent improvements" },
    ]);
    expect(JSON.stringify(result)).not.toContain("Article body");
    for (const update of result.updates) expect(update).not.toHaveProperty("version");
  });

  it.each([
    ["Claude example is now available", "models"],
    ["Upcoming deprecation of selected models", "models"],
    ["GPT-example release in GitHub Copilot", "models"],
    ["Claude Code release improvements", "tools"],
    ["Model Context Protocol support is now available", "tools"],
    ["New model instruction settings", "tools"],
  ])("classifies '%s' without claiming a vendor model launch", async (title, category) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(rss([{ title }])));
    const result = await createCopilotChangelogProvider(fetchImpl)(request());
    expect(result.updates[0]).toMatchObject({ category, kind: "announcement" });
  });

  it("distinguishes empty coverage from malformed, unsafe and off-source feeds", async () => {
    const empty = await createCopilotChangelogProvider(vi.fn<typeof fetch>().mockResolvedValue(new Response(rss())))(request());
    expect(empty).toEqual({ updates: [], unavailableSources: [] });
    for (const xml of [
      "<rss>broken",
      '<!DOCTYPE rss [<!ENTITY x SYSTEM "https://attacker.example/">]><rss/>',
      rss([{ title: "Update", url: "https://attacker.example/changelog/2026-11-16-update" }]),
      rss([{ title: "Update", url: "https://github.blog:8443/changelog/2026-11-16-update" }]),
      rss([{ title: "Update", at: "invalid" }]),
      rss().replace(copilotChangelog.channelUrl, "https://example.com/"),
    ]) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(xml));
      await expect(createCopilotChangelogProvider(fetchImpl)(request())).rejects.toThrow();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("bounds responses and reports HTTP failures without retries or response-body leaks", async () => {
    for (const response of [
      new Response("private response", { status: 429 }),
      new Response("private response", { status: 403 }),
      new Response("x".repeat(1_048_577)),
    ]) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(createCopilotChangelogProvider(fetchImpl)(request())).rejects.not.toThrow("private response");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("honours request cancellation and the six-second timeout", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    try {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("private cancellation")), { once: true });
      }));
      const pending = createCopilotChangelogProvider(fetchImpl)(request());
      const checked = expect(pending).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(6_001);
      await checked;
      const controller = new AbortController();
      const cancelled = createCopilotChangelogProvider(fetchImpl)({ ...request(), signal: controller.signal });
      const cancellation = expect(cancelled).rejects.toThrow("aborted");
      controller.abort();
      await cancellation;
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("combined engineering updates", () => {
  it("reserves category coverage before filling spare places and deduplicates products and source links", () => {
    const framework = software("framework", "frameworks", "2026-11-16T05:00:00Z");
    const firstTool = software("tool-0");
    const busyTools = [firstTool, ...Array.from({ length: 4 }, (_, index) => software(`tool-${index + 1}`))];
    const candidates = [
      ...busyTools, model, framework, { ...model, id: "duplicate" },
      { ...software("same-link", "tools", "2026-11-16T08:00:00Z"), url: firstTool.url },
      { ...software("repeat-product", "tools", "2026-11-16T08:00:00Z"), source: "tool-0" },
      software("stale", "frameworks", "2026-11-15T09:59:59Z"),
      software("future", "frameworks", "2026-11-16T10:00:00Z"),
    ];
    const selected = selectEngineeringUpdates(candidates, request().window, 3);
    expect(selected.map((update) => update.category)).toEqual(["models", "tools", "frameworks"]);
    expect(selectEngineeringUpdates([...candidates].reverse(), request().window, 3)).toEqual(selected);
    const all = selectEngineeringUpdates(candidates, request().window, 10);
    expect(all).toHaveLength(7);
    expect(new Set(all.map((update) => update.url)).size).toBe(7);
    expect(all.filter((update) => update.source === "tool-0")).toHaveLength(1);
    expect(selectEngineeringUpdates(busyTools, request().window, 3)).toHaveLength(3);
    expect(engineeringUpdateSchema.safeParse({ ...software("sdk"), category: "models" }).success).toBe(false);
  });

  it("combines sources before the final cap and preserves success when either source fails", async () => {
    const failed = vi.fn<EngineeringProvider>().mockRejectedValue(new Error("private response"));
    const collected = await createEngineeringProvider(
      provider([software("tool"), software("framework", "frameworks")]), provider([model]),
    )(request());
    expect(collected.updates.map((update) => update.category)).toEqual(["models", "tools", "frameworks"]);
    const cases: [EngineeringProvider, EngineeringProvider][] = [
      [provider([software("tool")]), failed], [failed, provider([model])],
    ];
    for (const [releases, changelog] of cases) {
      const result = await createEngineeringProvider(releases, changelog)(request());
      expect(result.updates).toHaveLength(1);
      expect(result.unavailableSources).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain("private response");
    }
    await expect(createEngineeringProvider(failed, failed)(request())).rejects.toThrow("All configured");
  });

  it("retains empty successful and partial coverage instead of falsely reporting all-source failure", async () => {
    const failed: EngineeringProvider = async () => { throw new Error("private response"); };
    const partial: EngineeringProvider = async () => ({
      updates: [], unavailableSources: [{ source: "VS Code", reason: "Request failed" }],
    });
    expect(await createEngineeringProvider(provider(), failed)(request())).toMatchObject({
      updates: [], unavailableSources: [{ source: "GitHub Copilot changelog" }],
    });
    expect(await createEngineeringProvider(partial, failed)(request())).toMatchObject({
      updates: [], unavailableSources: [{ source: "VS Code" }, { source: "GitHub Copilot changelog" }],
    });
  });

  it("renders three categories, honest model labels, original times, escaped text and partial failures", () => {
    const { html, text } = renderBriefingEmail({
      briefingId: "morning-briefing", name: "Morning Briefing", timezone: "Europe/London",
      reportingDate: "2026-11-16", generatedAt: request().now.toISOString(), sections: [{
        id: "ai-engineering", kind: "engineering", title: "AI Engineering Updates", outcome: {
          status: "partial", data: [{ ...model, title: "<Model> availability" }, software("framework", "frameworks")],
          unavailableSources: [{ source: "VS Code", reason: "HTTP 429" }],
        },
      }],
    }, "morning-briefing");
    for (const output of [html, text]) {
      expect(output).toContain("Models - Copilot availability");
      expect(output).toContain("Developer tools");
      expect(output).toContain("Agent frameworks");
      expect(output).toContain("Copilot availability update, not a vendor model launch");
      expect(output).toContain("Developer tools - none selected (24h).");
      expect(output).toContain("VS Code unavailable: HTTP 429");
      expect(output).toContain("15 Nov, 10:00");
      expect(output).not.toContain("Version: undefined");
    }
    expect(html).toContain("&lt;Model&gt;");
    expect(html.match(/<input class="disclosure-toggle"/g)).toHaveLength(2);
    expect(text).not.toContain("<input");
  });
});
