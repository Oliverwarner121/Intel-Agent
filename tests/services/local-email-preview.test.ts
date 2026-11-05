import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { writeEmailPreview } from "@/services/delivery/local-email-preview";
import { morningBriefing } from "@/briefings/definitions/morning-briefing";
import type { BriefingDelivery, ProviderRegistry } from "@/types/briefing";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

describe("local email preview", () => {
  it("writes real renderer output privately and never calls delivery, retaining failed sections", async () => {
    const directory = await mkdtemp(join(tmpdir(), "intel-email-preview-"));
    const delivery = vi.fn<BriefingDelivery>();
    const providers: ProviderRegistry = {
      calendar: { "google-calendar": async () => [{
        id: "1", title: "Private <meeting>",
        timing: { kind: "all-day", startDate: "2026-11-05", endDate: "2026-11-06" },
      }] },
      weather: {}, news: {},
    };
    try {
      // Reusing an existing file must not retain permissive permissions.
      await writeFile(join(directory, "morning-briefing.html"), "old", { mode: 0o644 });
      const result = await writeEmailPreview({
        providers, delivery, now: () => new Date("2026-11-05T05:00:00Z"),
      }, directory);
      expect(delivery).not.toHaveBeenCalled();
      expect(result.status).toBe("completed-with-gaps");
      const html = await readFile(result.htmlPath, "utf8");
      expect(html).toContain("<!doctype html>");
      expect(html).toContain("Private &lt;meeting&gt;");
      expect(html).not.toContain("Private <meeting>");
      expect(await readFile(result.textPath, "utf8")).toContain("All day: Private <meeting>");
      expect(html).toContain("Data unavailable:");
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      for (const path of [result.htmlPath, result.textPath]) {
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it("reports a disabled briefing rather than creating a success-shaped preview", async () => {
    await expect(writeEmailPreview({
      providers: { calendar: {}, weather: {}, news: {} },
      getDefinition: () => ({ ...morningBriefing, enabled: false }),
    })).rejects.toThrow("disabled");
  });
});
