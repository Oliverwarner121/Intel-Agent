import { HttpError } from "@/lib/http";
import { hybridPostingDates, selectJobs } from "@/services/processing/career-selection";
import { SafeError, type JobsProvider } from "@/types/briefing";
import { jobGroupSchema, type JobGroup } from "@/types/career";

export function createJobsProvider(remote: JobsProvider, hybrid?: JobsProvider): JobsProvider {
  return async (request) => {
    const collect = async (provider: JobsProvider | undefined, workplace: "remote" | "hybrid") => {
      try {
        if (!provider) throw new SafeError("REED_API_KEY is not configured; hybrid jobs are unavailable");
        const response = await provider(request);
        const parsed = jobGroupSchema.safeParse(response.groups.find((group) => group.workplace === workplace));
        if (!parsed.success || (parsed.data.status !== "unavailable" && parsed.data.jobs.some((job) => job.workplace !== workplace))) {
          throw new SafeError("Jobs source returned an invalid group");
        }
        return { group: parsed.data };
      } catch (error) {
        const reason = error instanceof SafeError ? error.message
          : error instanceof HttpError ? `Jobs source request failed (${error.message})` : "Jobs source request failed";
        const group: JobGroup = { workplace, status: "unavailable", reason };
        return { group };
      }
    };
    const results = await Promise.all([collect(hybrid, "hybrid"), collect(remote, "remote")]);
    const selected = selectJobs(results.flatMap(({ group }) => group.status === "unavailable" ? [] : group.jobs),
      request.window, request.maxJobs, hybridPostingDates(request.reportingDate, request.timezone));
    const ids = new Set(selected.map((job) => job.id));
    return {
      groups: results.map(({ group }) => group.status === "unavailable"
        ? group : { ...group, jobs: group.jobs.filter((job) => ids.has(job.id)) }),
      notice: results.filter(({ group }) => group.status !== "unavailable").map(({ group }) =>
        group.workplace === "hybrid" ? "Reed: today/yesterday" : "Jobicy: 24h (3h delay)",
      ).join(" · "),
    };
  };
}
