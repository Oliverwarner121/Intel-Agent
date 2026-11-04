import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { morningBriefing } from "@/briefings/definitions/morning-briefing";
import { createRegistry, getBriefingDefinition, listBriefingDefinitions } from "@/briefings/registry";

const vercelConfig = z
  .object({ crons: z.array(z.object({ path: z.string(), schedule: z.string() })) })
  .parse(JSON.parse(readFileSync("vercel.json", "utf8")));

describe("briefing registry", () => {
  it("registers the morning briefing with sections in the required order", () => {
    const definition = getBriefingDefinition("morning-briefing");
    expect(definition?.timezone).toBe("Europe/London");
    expect(definition?.sections.map((section) => section.title)).toEqual([
      "Today's Calendar",
      "Weather",
      "Worldwide Tech and AI",
      "UK Politics and Finance",
      "Global Affairs",
    ]);
    expect(
      definition?.sections.flatMap((section) => (section.kind === "news" ? [section.maxStories] : [])),
    ).toEqual([3, 3, 3]);
  });

  it("keeps every Cron job and briefing schedule in sync", () => {
    const scheduled = listBriefingDefinitions()
      .filter((definition) => definition.enabled)
      .map((definition) => ({ path: definition.schedule.route, schedule: definition.schedule.cronUtc }));
    expect(vercelConfig.crons).toEqual(scheduled);
  });

  it("has a route file for every scheduled briefing", () => {
    for (const definition of listBriefingDefinitions()) {
      expect(() => readFileSync(`src/app${definition.schedule.route}/route.ts`, "utf8")).not.toThrow();
    }
  });

  it("rejects duplicates and invalid definitions", () => {
    expect(() => createRegistry([morningBriefing, morningBriefing])).toThrow(/Duplicate briefing ID/);
    expect(() => createRegistry([{ ...morningBriefing, id: "Morning Briefing" }])).toThrow();
    expect(() => createRegistry([{ ...morningBriefing, timezone: "Mars/Olympus" }])).toThrow();
    expect(() =>
      createRegistry([{ ...morningBriefing, sections: [...morningBriefing.sections, morningBriefing.sections[0]] }]),
    ).toThrow(/unique/);
  });
});
