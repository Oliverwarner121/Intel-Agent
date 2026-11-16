import { z } from "zod";
import { engineeringSources } from "@/config/engineering-sources";
import { fetchJson, HttpError } from "@/lib/http";
import { SafeError, type EngineeringProvider } from "@/types/briefing";
import { engineeringUpdateSchema, type CareerSourceFailure } from "@/types/career";

const releasesSchema = z.array(z.object({
  id: z.int().positive(),
  name: z.string().max(300).nullable(),
  tag_name: z.string().trim().min(1).max(200),
  html_url: z.url(),
  published_at: z.iso.datetime({ offset: true }).nullable(),
  draft: z.boolean(),
  prerelease: z.boolean(),
})).max(30);

export function createGitHubReleasesProvider(fetchImpl?: typeof fetch): EngineeringProvider {
  return async ({ window, maxUpdates, signal }) => {
    const results = await Promise.all(engineeringSources.map(async (source) => {
      try {
        const releases = await fetchJson(`https://api.github.com/repos/${source.repo}/releases?per_page=30`, releasesSchema, {
          signal, timeoutMs: 6_000, retries: 0, maxResponseBytes: 1_048_576,
          init: { cache: "no-store", headers: {
            Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10",
            "User-Agent": "Intel-Agent",
          } },
          ...(fetchImpl ? { fetchImpl } : {}),
        });
        const updates = releases.filter((release) => {
          const at = release.published_at ? Date.parse(release.published_at) : NaN;
          return !release.draft && !release.prerelease && at >= window.start.getTime() && at < window.end.getTime();
        }).map((release) => {
          const url = new URL(release.html_url);
          if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password ||
              !url.pathname.toLowerCase().startsWith(`/${source.repo}/releases/tag/`.toLowerCase())) {
            throw new SafeError("GitHub returned an invalid release link");
          }
          return engineeringUpdateSchema.parse({
            id: `${source.repo}/${release.id}`, source: source.name,
            title: release.name?.trim() || release.tag_name, version: release.tag_name,
            publishedAt: release.published_at, url: release.html_url,
          });
        });
        return { updates, failures: [] };
      } catch (error) {
        const failure: CareerSourceFailure = {
          source: source.name,
          reason: error instanceof SafeError ? error.message
            : error instanceof HttpError ? `GitHub releases request failed (${error.message})` : "GitHub releases response was invalid",
        };
        return { updates: [], failures: [failure] };
      }
    }));
    const unavailableSources = results.flatMap((result) => result.failures);
    if (unavailableSources.length === engineeringSources.length) {
      throw new SafeError("All configured GitHub release sources are unavailable; check network access and GitHub rate limits");
    }
    // One release per product prevents a busy repository crowding out the others.
    const seenSources = new Set<string>();
    const updates = results.flatMap((result) => result.updates)
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || a.id.localeCompare(b.id))
      .filter((update) => {
        if (seenSources.has(update.source)) return false;
        seenSources.add(update.source);
        return true;
      }).slice(0, maxUpdates);
    return { updates, unavailableSources };
  };
}
