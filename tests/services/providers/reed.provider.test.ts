import { describe, expect, it, vi } from "vitest";
import { hybridJobSearch } from "@/config/job-search";
import { createReedProvider } from "@/services/providers/jobs/reed.provider";
import { createJobsProvider } from "@/services/providers/jobs/jobs.provider";
import { hybridPostingDates, selectJobs } from "@/services/processing/career-selection";
import { jobListingSchema, type JobListing } from "@/types/career";
import { renderBriefingEmail } from "@/services/delivery/email-renderer";
import { getServerEnv } from "@/config/env";
import { createBriefingDependencies } from "@/services/orchestration/dependencies";
import { morningCareerSections } from "@/briefings/definitions/morning-briefing";
import { getBriefingDefinition } from "@/briefings/registry";
import { runBriefing, summariseRun } from "@/services/orchestration/briefing-orchestrator.service";
import type { JobsProvider } from "@/types/briefing";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const request = () => ({
  now: new Date("2026-11-16T10:00:00Z"), reportingDate: "2026-11-16", timezone: "Europe/London", maxJobs: 10,
  window: { start: new Date("2026-11-15T10:00:00Z"), end: new Date("2026-11-16T10:00:00Z") },
  signal: new AbortController().signal,
});
const searchJob = (id = 1, overrides: Record<string, unknown> = {}) => ({
  jobId: id, jobTitle: "Software Engineer", employerName: `Company ${id}`, locationName: "London",
  jobDescription: "Hybrid working with TypeScript.", date: "15/11/2026", expirationDate: "30/11/2026",
  jobUrl: `https://www.reed.co.uk/jobs/software-engineer/${id}`, ...overrides,
});
const detail = (id = 1, overrides: Record<string, unknown> = {}) => ({
  jobId: id, jobTitle: "Software Engineer", employerName: `Company ${id}`, locationName: "London",
  jobDescription: "<p>Hybrid&nbsp;working: two days in the office, three from home. TypeScript and CI&#47;CD.</p>",
  datePosted: "15/11/2026", expirationDate: "30/11/2026",
  jobUrl: `https://www.reed.co.uk/jobs/software-engineer/${id}`,
  minimumSalary: 60_000, maximumSalary: 80_000, currency: "GBP", salaryType: "per annum",
  ...overrides,
});
const envelope = (results: unknown[]) => ({ results, totalResults: results.length, ambiguousLocations: [] });
const reedFetch = (rows: unknown[] = [searchJob()], overrides: Record<number, Record<string, unknown>> = {}) =>
  vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/1.0/search") return Response.json(envelope(rows));
    const id = Number(url.pathname.split("/").at(-1));
    return Response.json(detail(id, overrides[id]));
  });

describe("Reed hybrid jobs", () => {
  it("authenticates server-side, searches only the configured centres and deduplicates before verifying full details", async () => {
    const fetchImpl = reedFetch();
    const result = await createReedProvider("test-reed-key", fetchImpl)(request());
    expect(fetchImpl).toHaveBeenCalledTimes(13);
    const searches = fetchImpl.mock.calls.filter(([url]) => new URL(String(url)).pathname.endsWith("/search"));
    expect([...new Set(searches.map(([url]) => new URL(String(url)).searchParams.get("locationName")))]).toEqual(hybridJobSearch.locations);
    for (const [url, init] of searches) {
      expect(new URL(String(url)).origin).toBe("https://www.reed.co.uk");
      expect(Object.fromEntries(new URL(String(url)).searchParams)).toMatchObject({
        distanceFromLocation: "20", resultsToTake: "50", resultsToSkip: "0",
      });
      expect(hybridJobSearch.keywords).toContain(new URL(String(url)).searchParams.get("keywords"));
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Basic ${Buffer.from("test-reed-key:").toString("base64")}`);
      expect(init).toMatchObject({ cache: "no-store", redirect: "error" });
    }
    expect(result.groups).toMatchObject([{ workplace: "hybrid", status: "ok", jobs: [{
      id: "reed:1", publishedDate: "2026-11-15", source: "Reed", skills: ["TypeScript", "CI/CD"],
      salary: { minimum: 60_000, maximum: 80_000, currency: "GBP", period: "yearly" },
      excerpt: "Hybrid working: two days in the office, three from home. TypeScript and CI/CD.",
    }] }]);
    const group = result.groups[0];
    if (!group || group.status === "unavailable") throw new Error("Missing hybrid data");
    expect(group.jobs[0]).not.toHaveProperty("publishedAt");
    expect(result.notice).toContain("not an exact 24-hour window");
  });

  it("uses today and yesterday across the London DST change without inventing timestamps", async () => {
    const fetchImpl = reedFetch([
      searchJob(1, { date: "28/03/2026" }), searchJob(2, { date: "29/03/2026" }),
      searchJob(3, { date: "27/03/2026" }), searchJob(4, { date: "30/03/2026" }),
    ], { 1: { datePosted: "28/03/2026" }, 2: { datePosted: "29/03/2026" } });
    const result = await createReedProvider("test", fetchImpl)({
      ...request(), now: new Date("2026-03-29T07:00:00Z"), reportingDate: "2026-03-29",
      window: { start: new Date("2026-03-28T07:00:00Z"), end: new Date("2026-03-29T07:00:00Z") },
    });
    expect(result.groups).toMatchObject([{ status: "ok", jobs: [
      { id: "reed:2", publishedDate: "2026-03-29" }, { id: "reed:1", publishedDate: "2026-03-28" },
    ] }]);
    expect(fetchImpl.mock.calls.filter(([url]) => /\/jobs\//.test(String(url)))).toHaveLength(2);
  });

  it("requires explicit hybrid working and the existing technology and seniority filters", async () => {
    const rows = Array.from({ length: 8 }, (_, index) => searchJob(index + 1));
    const result = await createReedProvider("test", reedFetch(rows, {
      2: { jobDescription: "Fully remote. Hybrid working is also mentioned. TypeScript." },
      3: { jobDescription: "Build hybrid cloud systems using TypeScript." },
      4: { jobDescription: "No hybrid working. TypeScript." },
      5: { jobDescription: "Hybrid working. Python and Django." },
      6: { jobTitle: "Principal Software Engineer" },
      7: { jobDescription: "Hybrid working is not available. TypeScript." },
      8: { expirationDate: "14/11/2026" },
    }))(request());
    expect(result.groups).toMatchObject([{ status: "ok", jobs: [{ id: "reed:1" }] }]);
  });

  it("preserves successful locations and adverts while reporting incomplete coverage", async () => {
    const base = reedFetch([searchJob(1), searchJob(2)]);
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.searchParams.get("locationName") === "Brighton" || url.pathname.endsWith("/jobs/2")) {
        return new Response("private response", { status: 500 });
      }
      return base(input, init);
    });
    const result = await createReedProvider("test", fetchImpl)(request());
    expect(result.groups).toMatchObject([{ status: "partial", jobs: [{ id: "reed:1" }], reason: expect.stringContaining("incomplete") }]);
    expect(result.notice).toContain("Unavailable searches: Brighton");
    expect(result.notice).toContain("1 advert detail checks failed");
    expect(JSON.stringify(result)).not.toContain("private response");
    expect(fetchImpl).toHaveBeenCalledTimes(14);
  });

  it("distinguishes no matches from authentication, rate-limit and malformed-source failures without retries", async () => {
    expect((await createReedProvider("test", reedFetch([]))(request())).groups)
      .toEqual([{ workplace: "hybrid", status: "ok", jobs: [] }]);
    for (const status of [401, 403, 429]) {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response("private response", { status }));
      const result = await createReedProvider("test", fetchImpl)(request());
      expect(result.groups[0]).toMatchObject({ status: "unavailable" });
      expect(JSON.stringify(result)).not.toContain("private response");
      expect(fetchImpl).toHaveBeenCalledTimes(12);
      if (status === 401) expect(result.groups[0]).toMatchObject({ reason: expect.stringContaining("REED_API_KEY") });
    }
    for (const row of [
      searchJob(1, { date: "31/02/2026" }), searchJob(1, { jobUrl: "https://attacker.example/jobs/1" }),
    ]) {
      expect((await createReedProvider("test", reedFetch([row]))(request())).groups[0]).toMatchObject({ status: "unavailable" });
    }
  });

  it("rejects ambiguous locations and mismatched or invalid advert details", async () => {
    const ambiguous = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({ ...envelope([]), ambiguousLocations: ["London", "Another London"] }));
    expect((await createReedProvider("test", ambiguous)(request())).groups[0]).toMatchObject({ status: "unavailable" });
    for (const override of [{ jobId: 99 }, { datePosted: "invalid" }, { minimumSalary: 90_000, maximumSalary: 80_000 }]) {
      const result = await createReedProvider("test", reedFetch([searchJob()], { 1: override }))(request());
      expect(result.groups[0]).toMatchObject({ status: "partial", jobs: [] });
    }
  });

  it("preserves salary units and does not invent salaries from zero or incomplete fields", async () => {
    const result = await createReedProvider("test", reedFetch([searchJob(1), searchJob(2), searchJob(3)], {
      1: { minimumSalary: 400, maximumSalary: 500, salaryType: "per day" },
      2: { minimumSalary: 0, maximumSalary: 0 },
      3: { salaryType: "unknown" },
    }))(request());
    const group = result.groups[0];
    if (!group || group.status === "unavailable") throw new Error("Missing hybrid data");
    expect(group.jobs[0]?.salary).toEqual({ minimum: 400, maximum: 500, currency: "GBP", period: "daily" });
    expect(group.jobs[1]?.salary).toBeUndefined();
    expect(group.jobs[2]?.salary).toBeUndefined();
  });

  it("applies the profile floor and employment preferences without excluding unconfirmed details", async () => {
    const fetchImpl = reedFetch(Array.from({ length: 10 }, (_, index) => searchJob(index + 1)), {
      1: { minimumSalary: 48_000, contractType: "Permanent", jobType: "Full Time" },
      2: { minimumSalary: 47_999, maximumSalary: 90_000 },
      3: { contractType: "Contract" },
      4: { jobType: "Part Time" },
      5: { minimumSalary: 0, maximumSalary: 0 },
      6: { minimumSalary: null, maximumSalary: 47_999 },
      7: { minimumSalary: null, maximumSalary: 50_000 },
      8: { currency: "USD", minimumSalary: 40_000 },
      9: { salaryType: "per day", minimumSalary: 400, maximumSalary: 500 },
      10: { contractType: "Other", jobType: null },
    });
    const result = await createReedProvider("test", fetchImpl)(request());
    const group = result.groups[0];
    if (!group || group.status !== "ok") throw new Error("Missing hybrid matches");
    expect(group.jobs.map((job) => job.id)).toEqual(["reed:1", "reed:10", "reed:5", "reed:7", "reed:8", "reed:9"]);
    expect(group.jobs[0]).toMatchObject({ contractType: "permanent", jobType: "full-time" });
    expect(group.jobs.find((job) => job.id === "reed:5")?.salary).toBeUndefined();
    expect(group.jobs.find((job) => job.id === "reed:10")).not.toHaveProperty("contractType");
    for (const [url] of fetchImpl.mock.calls.filter(([url]) => String(url).includes("/search?"))) {
      const params = new URL(String(url)).searchParams;
      expect(params.has("minimumSalary")).toBe(false);
      expect(params.has("permanent")).toBe(false);
      expect(params.has("fullTime")).toBe(false);
    }
  });

  it("bounds search responses and full-advert verification", async () => {
    const fetchImpl = reedFetch(Array.from({ length: 50 }, (_, index) => searchJob(index + 1)));
    const result = await createReedProvider("test", fetchImpl)(request());
    expect(fetchImpl).toHaveBeenCalledTimes(22);
    expect(result.groups[0]).toMatchObject({ status: "ok", jobs: expect.any(Array) });
    expect(result.notice).toContain("10 full adverts checked");
  });

  it("aborts at its overall budget while keeping previously verified adverts", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    try {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation((input, init) => new Promise((resolve, reject) => {
        const url = new URL(String(input));
        const search = url.pathname.endsWith("/search");
        const id = Number(url.pathname.split("/").at(-1));
        const timer = search || id <= 5 ? setTimeout(() => resolve(Response.json(search
          ? envelope(Array.from({ length: 10 }, (_, index) => searchJob(index + 1))) : detail(id))), 5_900) : undefined;
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("private cancellation details"));
        }, { once: true });
      }));
      const result = createReedProvider("test", fetchImpl)(request());
      await vi.advanceTimersByTimeAsync(17_001);
      const collected = await result;
      const group = collected.groups[0];
      if (!group || group.status !== "partial") throw new Error("Missing partial coverage");
      expect(group.jobs).toHaveLength(5);
      expect(collected.notice).toContain("5 advert detail checks failed or timed out");
      expect(JSON.stringify(collected)).not.toContain("private cancellation details");
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });
});

const hybridJob: JobListing = {
  id: "reed:1", title: "Software Engineer", company: "Company", location: "Guildford",
  workplace: "hybrid", seniority: "senior", publishedDate: "2026-11-15",
  source: "Reed", skills: ["TypeScript"], url: "https://www.reed.co.uk/jobs/software-engineer/1",
};
const remoteJob: JobListing = {
  id: "1", title: "Software Engineer", company: "Company", location: "UK",
  workplace: "remote", seniority: "mid-level", publishedAt: "2026-11-16T06:00:00Z",
  source: "Jobicy", skills: ["TypeScript"], url: "https://jobicy.com/jobs/1-engineer",
};
const remote: JobsProvider = async () => ({ groups: [{ workplace: "remote", status: "ok", jobs: [remoteJob] }], notice: "Jobicy" });
const hybrid: JobsProvider = async () => ({ groups: [{ workplace: "hybrid", status: "ok", jobs: [hybridJob] }], notice: "Reed" });

describe("combined hybrid and remote jobs", () => {
  it("caps both groups together after relevance ranking rather than letting hybrid crowd out mid-level remote roles", async () => {
    const result = await createJobsProvider(remote, hybrid)({ ...request(), maxJobs: 1 });
    expect(result.groups).toMatchObject([
      { workplace: "hybrid", status: "ok", jobs: [] }, { workplace: "remote", status: "ok", jobs: [remoteJob] },
    ]);
  });

  it("isolates source failures and missing configuration in both directions", async () => {
    const failed = vi.fn<JobsProvider>().mockRejectedValue(new Error("private response"));
    expect((await createJobsProvider(remote, failed)(request())).groups).toMatchObject([
      { status: "unavailable", reason: "Jobs source request failed" }, { status: "ok", jobs: [remoteJob] },
    ]);
    expect((await createJobsProvider(failed, hybrid)(request())).groups).toMatchObject([
      { status: "ok", jobs: [hybridJob] }, { status: "unavailable" },
    ]);
    expect((await createJobsProvider(remote)(request())).groups[0]).toMatchObject({
      status: "unavailable", reason: expect.stringContaining("REED_API_KEY"),
    });
  });

  it("validates date precision explicitly and does not put date-only adverts into exact rolling windows", () => {
    expect(jobListingSchema.safeParse({ ...hybridJob, publishedAt: "2026-11-15T00:00:00Z" }).success).toBe(false);
    expect(selectJobs([hybridJob], request().window, 10)).toEqual([]);
    expect(selectJobs([hybridJob, remoteJob], request().window, 10,
      hybridPostingDates(request().reportingDate, request().timezone))).toHaveLength(2);
  });

  it("wires the optional secret without exposing it and renders date-only attribution, partial coverage and safe counts", async () => {
    const env = getServerEnv({ CRON_SECRET: "x".repeat(32), CAREER_INTEL_ENABLED: "true", REED_API_KEY: " test-key " });
    expect(env.REED_API_KEY).toBe("test-key");
    expect(getServerEnv({ CRON_SECRET: "x".repeat(32), REED_API_KEY: " " }).REED_API_KEY).toBeUndefined();
    expect(createBriefingDependencies(env).providers.jobs?.["career-jobs"]).toBeTypeOf("function");
    const jobs = createJobsProvider(remote, async () => ({
      groups: [
        { workplace: "hybrid", status: "partial", jobs: [hybridJob], reason: "Brighton search unavailable" },
      ], notice: "Operational search details should not appear in the email. ".repeat(20),
    }));
    const run = await runBriefing("morning-briefing", "preview", {
      now: () => request().now, providers: { calendar: {}, weather: {}, news: {}, jobs: { "career-jobs": jobs } },
      getDefinition: () => {
        const definition = getBriefingDefinition("morning-briefing");
        if (!definition) throw new Error("Missing definition");
        return { ...definition, sections: morningCareerSections.filter((section) => section.kind === "jobs") };
      },
    });
    expect(run.status).toBe("completed-with-gaps");
    expect(summariseRun(run).sections).toMatchObject([{ status: "partial", items: 2 }]);
    if (!run.briefing) throw new Error("Missing briefing");
    const { html, text } = renderBriefingEmail(run.briefing, "morning-briefing");
    for (const output of [html, text]) {
      expect(output).toContain("2026-11-15 (date only; posting time unavailable)");
      expect(output).toContain("Source: Reed");
      expect(output).toContain("Brighton search unavailable");
      expect(output).toContain("Camberley / London / Brighton / Crawley / Woking / Guildford");
      expect(output).not.toContain("test-key");
    }
    expect(html).toContain("View job at Reed");
    expect(html).toContain("View job at Jobicy");
    expect(html).not.toContain("15 Nov, 00:00");
    const caption = html.match(/<td class="muted career-caption" style="[^"]*font-size:10px;[^"]*">([^<]+)<\/td>/)?.[1];
    expect(caption?.length).toBeLessThan(65);
    expect(caption).toContain("today/yesterday");
    expect(caption).toContain("3h delay");
    expect(text).not.toContain("Operational search details");
    expect(text).not.toContain("ranked before grouping");
  });
});
