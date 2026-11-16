import { Buffer } from "node:buffer";
import { z } from "zod";
import { hybridJobSearch } from "@/config/job-search";
import { fetchJson, HttpError } from "@/lib/http";
import {
  classifyJobSeniority, hybridPostingDates, isEngineeringRoleTitle, jobSeniorityRank,
  matchesEngineeringRole, matchesJobSalary, matchJobEmployment, matchingJobSkills, plainJobText, selectJobs,
} from "@/services/processing/career-selection";
import { SafeError, type JobsProvider } from "@/types/briefing";
import { jobListingSchema, type JobListing } from "@/types/career";

const text = z.string().trim().min(1).max(10_000);
const reedDate = z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/)
  .transform((value) => `${value.slice(6)}-${value.slice(3, 5)}-${value.slice(0, 2)}`).pipe(z.iso.date());
const sourceUrl = z.url().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["www.reed.co.uk", "reed.co.uk"].includes(url.hostname) &&
      !url.port && !url.username && !url.password && url.pathname.startsWith("/jobs/");
  } catch {
    return false;
  }
});
const searchJob = z.object({
  jobId: z.int().positive(), jobTitle: text, employerName: text, locationName: text,
  jobDescription: z.string().max(200_000), date: reedDate, expirationDate: reedDate,
  jobUrl: sourceUrl,
});
const searchSchema = z.object({
  results: z.array(searchJob).max(50),
  ambiguousLocations: z.array(z.unknown()).max(50),
  totalResults: z.int().nonnegative(),
});
const detailSchema = z.object({
  jobId: z.int().positive(), jobTitle: text, employerName: text, locationName: text,
  jobDescription: z.string().max(200_000), datePosted: reedDate, expirationDate: reedDate,
  jobUrl: sourceUrl,
  minimumSalary: z.number().finite().nonnegative().nullish(),
  maximumSalary: z.number().finite().nonnegative().nullish(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullish(),
  salaryType: z.string().max(100).nullish(),
  contractType: z.string().trim().max(100).nullish(),
  jobType: z.string().trim().max(100).nullish(),
});
const salaryPeriods: Readonly<Record<string, "hourly" | "daily" | "weekly" | "monthly" | "yearly">> = {
  "per hour": "hourly", "per day": "daily", "per week": "weekly", "per month": "monthly", "per annum": "yearly",
};

function failureReason(error: unknown): string {
  if (error instanceof HttpError && error.status === 401) return "Reed authentication failed; check REED_API_KEY";
  if (error instanceof HttpError) return `Reed request failed (${error.message})`;
  if (error instanceof SafeError) return error.message;
  return "Reed response could not be processed";
}

function explicitlyHybrid(title: string, description: string): boolean {
  const text = `${title} ${description}`;
  if (/\b(?:not|no|non)[\s-]+hybrid\b|\bhybrid(?:\s+working)?\s+(?:is\s+)?(?:not\s+(?:available|offered|supported)|unavailable)\b/i.test(text) ||
    /\b(?:fully|100\s*%)[\s-]*(?:remote|on[\s-]?site|office[\s-]+based)\b/i.test(text)) return false;
  return /\bhybrid\b(?![\s-]+(?:cloud|infrastructure|architecture|systems?))/i.test(title) ||
    /\bhybrid[\s-]+(?:work(?:ing)?|role|position|arrangement|model|schedule|pattern)\b|\bwork(?:ing)?[\s-]+hybrid\b|\bhybrid\s*:/i.test(description);
}

export function createReedProvider(apiKey: string, fetchImpl?: typeof fetch): JobsProvider {
  if (!apiKey.trim()) throw new SafeError("REED_API_KEY is required for hybrid jobs");
  const headers = { Authorization: `Basic ${Buffer.from(`${apiKey.trim()}:`).toString("base64")}`, Accept: "application/json" };
  return async ({ reportingDate, timezone, window, maxJobs, signal }) => {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(17_000)]);
    const options = {
      signal: requestSignal, timeoutMs: 6_000, retries: 0, maxResponseBytes: 1_048_576,
      init: { cache: "no-store" as const, headers }, ...(fetchImpl ? { fetchImpl } : {}),
    };
    const dates = hybridPostingDates(reportingDate, timezone);
    const queries = hybridJobSearch.locations.flatMap((location) => hybridJobSearch.keywords.map((keywords) => ({ location, keywords })));
    const searches = await Promise.all(queries.map(async ({ location, keywords }) => {
      try {
        const params = new URLSearchParams({
          keywords, locationName: location, distanceFromLocation: String(hybridJobSearch.radiusMiles),
          resultsToTake: "50", resultsToSkip: "0",
        });
        const result = await fetchJson(`https://www.reed.co.uk/api/1.0/search?${params}`, searchSchema, options);
        if (result.ambiguousLocations.length) throw new SafeError(`Reed returned an ambiguous location for ${location}`);
        return { location, jobs: result.results, failure: undefined };
      } catch (error) {
        return { location, jobs: [], failure: failureReason(error) };
      }
    }));
    const failedSearches = searches.filter((search) => search.failure !== undefined);
    if (failedSearches.length === searches.length) {
      return { groups: [{ workplace: "hybrid", status: "unavailable",
        reason: failedSearches[0]?.failure ?? "All Reed location searches failed" }],
      notice: "Source: Reed. All configured hybrid searches were unavailable." };
    }
    const unique = new Map<number, z.infer<typeof searchJob>>();
    for (const search of searches) for (const job of search.jobs) unique.set(job.jobId, job);
    const candidates = [...unique.values()].flatMap((job) => {
      const title = plainJobText(job.jobTitle);
      const seniority = classifyJobSeniority(title);
      if (job.date < dates.startDate || job.date > dates.endDate || job.expirationDate < reportingDate ||
        seniority === "excluded" || !isEngineeringRoleTitle(title)) return [];
      return [{ ...job, seniority, skills: matchingJobSkills(`${title} ${plainJobText(job.jobDescription)}`) }];
    }).sort((a, b) => jobSeniorityRank[a.seniority] - jobSeniorityRank[b.seniority] ||
      b.skills.length - a.skills.length || b.date.localeCompare(a.date) || a.jobId - b.jobId).slice(0, 10);
    const jobs: JobListing[] = [];
    let unverified = 0;
    for (let offset = 0; offset < candidates.length; offset += 5) {
      if (requestSignal.aborted) {
        unverified += candidates.length - offset;
        break;
      }
      const results = await Promise.all(candidates.slice(offset, offset + 5).map(async (candidate) => {
        try {
          const detail = await fetchJson(`https://www.reed.co.uk/api/1.0/jobs/${candidate.jobId}`, detailSchema, options);
          if (detail.jobId !== candidate.jobId) throw new SafeError("Reed returned an unexpected job ID");
          const title = plainJobText(detail.jobTitle);
          const description = plainJobText(detail.jobDescription);
          const skills = matchingJobSkills(`${title} ${description}`);
          const seniority = classifyJobSeniority(title);
          const employment = matchJobEmployment([detail.contractType ?? "", detail.jobType ?? ""]);
          if (detail.datePosted < dates.startDate || detail.datePosted > dates.endDate || detail.expirationDate < reportingDate ||
            seniority === "excluded" || !employment || !matchesEngineeringRole(title, skills) || !explicitlyHybrid(title, description)) {
            return { status: "filtered" as const };
          }
          const minimum = detail.minimumSalary && detail.minimumSalary > 0 ? detail.minimumSalary : undefined;
          const maximum = detail.maximumSalary && detail.maximumSalary > 0 ? detail.maximumSalary : undefined;
          const period = detail.salaryType ? salaryPeriods[detail.salaryType.trim().toLowerCase()] : undefined;
          const parsed = jobListingSchema.safeParse({
            id: `reed:${detail.jobId}`, title, company: plainJobText(detail.employerName),
            location: plainJobText(detail.locationName), workplace: "hybrid", seniority,
            ...employment,
            publishedDate: detail.datePosted, url: detail.jobUrl, source: "Reed", skills,
            excerpt: description.slice(0, 280),
            ...(detail.currency && period && (minimum !== undefined || maximum !== undefined) ? { salary: {
              ...(minimum !== undefined ? { minimum } : {}), ...(maximum !== undefined ? { maximum } : {}),
              currency: detail.currency, period,
            } } : {}),
          });
          if (!parsed.success) throw new SafeError("Reed returned invalid job data");
          if (!matchesJobSalary(parsed.data.salary)) return { status: "filtered" as const };
          return { status: "ok" as const, job: parsed.data };
        } catch (error) {
          return { status: "failed" as const, reason: failureReason(error) };
        }
      }));
      for (const result of results) {
        if (result.status === "ok") jobs.push(result.job);
        else if (result.status === "failed") unverified++;
      }
    }
    if (signal.aborted) throw new SafeError("Reed request was cancelled");
    const selected = selectJobs(jobs, window, maxJobs, dates);
    const incomplete = failedSearches.length > 0 || unverified > 0;
    return {
      groups: [incomplete
        ? { workplace: "hybrid", status: "partial", jobs: selected,
          reason: `Reed coverage incomplete.${
            failedSearches.length ? ` Searches unavailable: ${[...new Set(failedSearches.map((search) => search.location))].join(", ")}.` : ""
          }${unverified ? ` ${unverified} advert details unverified.` : ""}` }
        : { workplace: "hybrid", status: "ok", jobs: selected }],
      notice: `Source: Reed. Hybrid jobs use posting dates ${dates.startDate} to ${dates.endDate} inclusive, not an exact 24-hour window; posting times are unavailable. Search radius ${hybridJobSearch.radiusMiles} miles around ${hybridJobSearch.locations.join(", ")} is source-reported. At most 50 results per query/centre and 10 full adverts checked; further matches may exist.${
        failedSearches.length ? ` Unavailable searches: ${[...new Set(failedSearches.map((search) => search.location))].join(", ")}.` : ""
      }${unverified ? ` ${unverified} advert detail checks failed or timed out.` : ""}`,
    };
  };
}
