import { z } from "zod";
import { fetchJson } from "@/lib/http";
import { SafeError, type JobsProvider } from "@/types/briefing";
import { jobListingSchema, type JobListing } from "@/types/career";
import {
  classifyJobSeniority, matchesEngineeringRole, matchesJobSalary, matchJobEmployment,
  matchingJobSkills, plainJobText, selectJobs,
} from "@/services/processing/career-selection";

const quoteText = z.string().trim().min(1).max(10_000);
const responseSchema = z.object({
  success: z.literal(true),
  jobs: z.array(z.object({
    id: z.int().positive(),
    url: z.url(),
    jobTitle: quoteText,
    companyName: quoteText,
    jobGeo: quoteText,
    jobLevel: z.string().trim().max(100).nullish(),
    jobType: z.array(z.string().trim().min(1).max(100)).max(20).nullish(),
    jobExcerpt: z.string().max(10_000).optional(),
    jobDescription: z.string().max(200_000),
    pubDate: z.iso.datetime({ offset: true }),
    salaryMin: z.number().finite().nonnegative().nullish(),
    salaryMax: z.number().finite().nonnegative().nullish(),
    salaryCurrency: z.string().regex(/^[A-Z]{3}$/).nullish(),
    salaryPeriod: z.enum(["yearly", "monthly", "weekly", "daily", "hourly"]).nullish(),
  })).max(100),
  nextCursor: z.string().min(1).max(4096).nullable(),
  hasMore: z.boolean(),
}).refine((response) => response.hasMore === (response.nextCursor !== null));

export function createJobicyProvider(fetchImpl?: typeof fetch): JobsProvider {
  return async ({ window, maxJobs, signal }) => {
    const candidates: JobListing[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    let limited = false;
    for (let page = 0; page < 2; page++) {
      const params = new URLSearchParams({ count: "100", geo: "uk", industry: "engineering" });
      if (cursor) params.set("cursor", cursor);
      const response = await fetchJson(`https://jobicy.com/api/jobs?${params}`, responseSchema, {
        signal, timeoutMs: 6_000, retries: 0, maxResponseBytes: 4_194_304,
        init: { cache: "no-store", headers: { Accept: "application/json" } },
        ...(fetchImpl ? { fetchImpl } : {}),
      });
      for (const job of response.jobs) {
        const url = new URL(job.url);
        if (url.protocol !== "https:" || url.hostname !== "jobicy.com" || url.username || url.password ||
          !url.pathname.startsWith("/jobs/")) {
          throw new SafeError("Jobicy returned an invalid source link");
        }
        const title = plainJobText(job.jobTitle);
        const description = plainJobText(job.jobDescription);
        const technologies = matchingJobSkills(`${title} ${description}`);
        const seniority = classifyJobSeniority(title, job.jobLevel);
        const employment = matchJobEmployment(job.jobType ?? []);
        const ukLocation = /^(?:uk|united kingdom)$/i;
        const titleLocation = title.match(/\|\s*([^|]+?)\s*\|\s*(?:fully\s+)?remote\s*$/i)?.[1]?.trim();
        const ukEligible = job.jobGeo.split(/[,;|]/).some((geo) => ukLocation.test(geo.trim())) &&
          (titleLocation === undefined || ukLocation.test(titleLocation));
        const workingText = `${title} ${description}`;
        const fullyRemote = /\bfully[\s-]+remote\b|\b100\s*%\s*remote\b/i.test(workingText);
        const officeRequired = /\b(?:hybrid|remote[- ]first|on[\s-]?site|not fully remote|office (?:attendance|visits)|(?:attend|visit) (?:the |our )?office|(?:one|two|three|four|five|[1-5]) days? (?:a |per )?week in (?:the )?office)\b/i;
        if (!ukEligible || !fullyRemote || officeRequired.test(workingText) || seniority === "excluded" || !employment ||
          !matchesEngineeringRole(title, technologies)) continue;
        const excerpt = job.jobExcerpt ? plainJobText(job.jobExcerpt).slice(0, 280) : undefined;
        const minimum = job.salaryMin && job.salaryMin > 0 ? job.salaryMin : undefined;
        const maximum = job.salaryMax && job.salaryMax > 0 ? job.salaryMax : undefined;
        const parsed = jobListingSchema.safeParse({
          id: String(job.id), title, company: plainJobText(job.companyName),
          location: job.jobGeo, workplace: "remote", seniority, publishedAt: job.pubDate,
          ...employment,
          url: job.url, source: "Jobicy", skills: technologies,
          ...(excerpt ? { excerpt } : {}),
          ...(job.salaryCurrency && job.salaryPeriod && (minimum !== undefined || maximum !== undefined)
            ? { salary: {
              ...(minimum !== undefined ? { minimum } : {}),
              ...(maximum !== undefined ? { maximum } : {}),
              currency: job.salaryCurrency, period: job.salaryPeriod,
            } } : {}),
        });
        if (!parsed.success) throw new SafeError("Jobicy returned invalid job data");
        if (!matchesJobSalary(parsed.data.salary)) continue;
        candidates.push(parsed.data);
      }
      if (!response.hasMore || (response.jobs.length > 0 &&
        response.jobs.every((job) => Date.parse(job.pubDate) < window.start.getTime()))) break;
      if (response.nextCursor && cursors.has(response.nextCursor)) throw new SafeError("Jobicy returned repeated pagination");
      cursor = response.nextCursor;
      if (cursor) cursors.add(cursor);
      limited = page === 1;
    }
    return {
      groups: [
        { workplace: "hybrid", status: "unavailable",
          reason: "Jobicy supplies fully remote listings only; hybrid jobs require Reed." },
        { workplace: "remote", status: "ok", jobs: selectJobs(candidates, window, maxJobs) },
      ],
      notice: `Source: Jobicy. Listings appear after a 3-hour delay; original posting dates are filtered to the last 24 hours. At least one configured technology or role keyword is required. Mid-level roles first, unstated levels included, senior roles as stretch opportunities. Junior/graduate and leadership roles excluded. UK eligibility and remote status are source-reported; ambiguous office requirements are excluded. Check the original advert.${
        limited ? " Search bounded to at most 200 candidates; further matches may exist." : ""
      }`,
    };
  };
}
