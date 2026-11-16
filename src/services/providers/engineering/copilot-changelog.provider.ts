import { XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";
import { copilotChangelog } from "@/config/engineering-sources";
import { fetchText } from "@/lib/http";
import { plainJobText, selectEngineeringUpdates } from "@/services/processing/career-selection";
import { SafeError, type EngineeringProvider } from "@/types/briefing";
import { engineeringUpdateSchema } from "@/types/career";

const articleUrl = z.url().max(4096).refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && url.hostname === "github.blog" &&
    !url.port && !url.username && !url.password && !url.search && !url.hash &&
    /^\/changelog\/\d{4}-\d{2}-\d{2}-[^/]+\/?$/.test(url.pathname);
});
const feedSchema = z.object({
  rss: z.object({ channel: z.object({
    link: z.literal(copilotChangelog.channelUrl),
    item: z.array(z.object({
      title: z.string().trim().min(1).max(300), link: articleUrl,
      pubDate: z.string().max(100).refine((value) => Number.isFinite(Date.parse(value))),
    })).max(100).optional(),
  }) }),
});

function isModelAvailability(title: string): boolean {
  const model = /\b(?:models?(?!\s+context\s+protocol)|gpt(?:-\w+)*|o[134](?:-\w+)*|gemini|deepseek|qwen|mistral|claude(?![\s-]+code))\b/i;
  const availability = /\b(?:availab\w*|launch\w*|releas\w*|introduc\w*|preview|deprecat\w*|retire\w*)\b|\bin github copilot\b/i;
  return model.test(title) && availability.test(title);
}

export function createCopilotChangelogProvider(fetchImpl?: typeof fetch): EngineeringProvider {
  return async ({ window, maxUpdates, signal }) => {
    const xml = await fetchText(copilotChangelog.url, {
      signal, timeoutMs: 6_000, retries: 0, maxResponseBytes: 1_048_576,
      init: { cache: "no-store", headers: { Accept: "application/rss+xml, application/xml" } },
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    // Article HTML may contain DOCTYPE inside CDATA; XML declarations may not.
    const declarations = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
    if (/<!DOCTYPE|<!ENTITY/i.test(declarations) || XMLValidator.validate(xml) !== true) {
      throw new SafeError("Copilot changelog is not valid safe XML");
    }
    const payload: unknown = new XMLParser({
      ignoreAttributes: true, parseTagValue: false, processEntities: false,
      isArray: (_name, path) => path === "rss.channel.item",
    }).parse(xml);
    const feed = feedSchema.safeParse(payload);
    if (!feed.success) throw new SafeError("Copilot changelog did not match the expected source or schema");
    const updates = (feed.data.rss.channel.item ?? []).map((item) => {
      const title = plainJobText(item.title);
      return engineeringUpdateSchema.parse({
        id: `copilot:${new URL(item.link).pathname}`, kind: "announcement",
        category: isModelAvailability(title) ? "models" : "tools",
        title, source: copilotChangelog.name, url: item.link,
        publishedAt: new Date(item.pubDate).toISOString(),
      });
    });
    return { updates: selectEngineeringUpdates(updates, window, maxUpdates), unavailableSources: [] };
  };
}
