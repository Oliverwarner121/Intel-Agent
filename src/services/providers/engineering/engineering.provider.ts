import { HttpError } from "@/lib/http";
import { selectEngineeringUpdates } from "@/services/processing/career-selection";
import { SafeError, type EngineeringProvider } from "@/types/briefing";
import { engineeringUpdateSchema, type EngineeringCollection } from "@/types/career";

export function createEngineeringProvider(
  releases: EngineeringProvider, changelog: EngineeringProvider,
): EngineeringProvider {
  return async (request) => {
    const collect = async (
      provider: EngineeringProvider, source: string,
    ): Promise<EngineeringCollection & { failed: boolean }> => {
      try {
        const result = await provider(request);
        const parsed = engineeringUpdateSchema.array().max(90).safeParse(result.updates);
        if (!parsed.success) throw new SafeError("Engineering source returned invalid updates");
        return { updates: parsed.data, unavailableSources: result.unavailableSources, failed: false };
      } catch (error) {
        return { updates: [], failed: true, unavailableSources: [{
          source, reason: error instanceof SafeError ? error.message
            : error instanceof HttpError ? `Engineering request failed (${error.message})` : "Engineering source could not be processed",
        }] };
      }
    };
    const results = await Promise.all([
      collect(releases, "GitHub releases"), collect(changelog, "GitHub Copilot changelog"),
    ]);
    if (results.every((result) => result.failed)) {
      throw new SafeError("All configured engineering update sources are unavailable");
    }
    return {
      updates: selectEngineeringUpdates(results.flatMap((result) => result.updates), request.window, request.maxUpdates),
      unavailableSources: results.flatMap((result) => result.unavailableSources),
    };
  };
}
