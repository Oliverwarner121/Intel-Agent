import { describe, expect, it, vi } from "vitest";
import { morningCareerSections } from "@/briefings/definitions/morning-briefing";
import { getBriefingDefinition } from "@/briefings/registry";
import { engineeringSources } from "@/config/engineering-sources";
import { marketAssets } from "@/config/market-assets";
import { createJobicyProvider } from "@/services/providers/jobs/jobicy.provider";
import { createGitHubReleasesProvider } from "@/services/providers/engineering/github-releases.provider";
import { createBriefingDependencies } from "@/services/orchestration/dependencies";
import { runBriefing, summariseRun } from "@/services/orchestration/briefing-orchestrator.service";
import { renderBriefingEmail } from "@/services/delivery/email-renderer";
import { matchJobEmployment, matchesJobSalary, matchingJobSkills } from "@/services/processing/career-selection";
import type { BriefingModel, EngineeringProvider, JobsProvider } from "@/types/briefing";
import type { JobListing } from "@/types/career";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const now = new Date("2026-11-16T10:00:00Z");
const context = () => ({
  now, timezone: "Europe/London", reportingDate: "2026-11-16",
  signal: new AbortController().signal,
  window: { start: new Date("2026-11-15T10:00:00Z"), end: now },
});
const rawJob = (id = 1) => ({
  id, url: `https://jobicy.com/jobs/${id}-engineer`, jobTitle: "Full Stack Engineer",
  companyName: `Company ${id}`, jobGeo: "UK", jobDescription: "<p>Fully remote. React and TypeScript.</p>",
  jobExcerpt: "<p>Build <strong>products</strong>.</p>", pubDate: "2026-11-16T06:00:00Z",
});
const page = (jobs: unknown[] = [rawJob()], nextCursor: string | null = null) =>
  ({ success: true, jobs, nextCursor, hasMore: nextCursor !== null });
const normalJob: JobListing = {
  id: "1", title: "<Engineer>", company: "Company & Co", location: "UK", workplace: "remote",
  publishedAt: "2026-11-16T06:00:00Z", url: "https://jobicy.com/jobs/1-engineer",
  source: "Jobicy", skills: ["TypeScript"], excerpt: "<script>Not HTML</script>",
};
const profileSkills = [
  "TypeScript", "Cloud", "AWS", "Azure", "React", "Node.js", "CI/CD", "Terraform",
  "Platform engineering", "AI engineering", "Full stack", "Frontend", "Backend", "AI agents", "Agentic workflows",
];

describe("Jobicy UK jobs", () => {
  it("shares the salary floor and employment rules, retaining missing and incomparable salary details", async () => {
    const annual = { salaryMin: 48_000, salaryMax: 55_000, salaryCurrency: "GBP", salaryPeriod: "yearly" };
    const overrides = [
      {},
      { salaryMin: 47_999, salaryMax: 90_000 },
      { jobType: ["Contract", "Full-Time"] },
      { jobType: ["Permanent", "Part-Time"] },
      { jobType: null, salaryMin: 0, salaryMax: 0 },
      { salaryMin: null, salaryMax: 47_999 },
      { salaryMin: null, salaryMax: 50_000 },
      { salaryCurrency: "USD", salaryMin: 40_000 },
      { salaryPeriod: "daily", salaryMin: 400, salaryMax: 500 },
      { jobType: ["Full-Time"] },
    ];
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(page(overrides.map((override, index) => ({
      ...rawJob(index + 1), ...annual, jobType: ["Permanent", "Full-Time"], ...override,
    })))));
    const result = await createJobicyProvider(fetchImpl)({ ...context(), maxJobs: 10 });
    const group = result.groups[1];
    if (!group || group.status !== "ok") throw new Error("Missing remote matches");
    expect(group.jobs.map((job) => job.id)).toEqual(["1", "10", "5", "7", "8", "9"]);
    expect(group.jobs[0]).toMatchObject({ contractType: "permanent", jobType: "full-time" });
    expect(group.jobs.find((job) => job.id === "5")?.salary).toBeUndefined();
    expect(group.jobs.find((job) => job.id === "10")).toMatchObject({ jobType: "full-time" });
    expect(group.jobs.find((job) => job.id === "10")).not.toHaveProperty("contractType");
    const { html, text } = renderBriefingEmail({
      briefingId: "morning-briefing", name: "Morning Briefing", timezone: "Europe/London",
      reportingDate: "2026-11-16", generatedAt: now.toISOString(), sections: [{
        id: "jobs", kind: "jobs", title: "Jobs", outcome: { status: "ok", data: [group] },
      }],
    }, "morning-briefing");
    for (const output of [html, text]) {
      expect(output).toContain("Employment: Permanent | Full-time");
      expect(output).toContain("Permanent unconfirmed | Full-time");
      expect(output).toContain("GBP 48,000/year minimum unconfirmed");
    }
  });

  it("does not cap higher salaries or mistake missing hours or permanence for confirmation", () => {
    expect(matchesJobSalary({ minimum: 150_000, currency: "GBP", period: "yearly" })).toBe(true);
    expect(matchesJobSalary(undefined)).toBe(true);
    expect(matchJobEmployment([])).toEqual({});
    expect(matchJobEmployment(["Unknown"])).toEqual({});
    expect(matchJobEmployment(["Full Time"])).toEqual({ jobType: "full-time" });
    expect(matchJobEmployment(["Permanent"])).toEqual({ contractType: "permanent" });
    for (const type of ["Temporary", "Fixed-term", "Freelance", "Part time", "Non-permanent", "Contract", "Seasonal"]) {
      expect(matchJobEmployment([type, "Full-Time"])).toBeUndefined();
    }
  });

  it("requires a requested match, retains all matched tags and still allows Python roles with a requested technology", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(page([
      { ...rawJob(1), jobTitle: "Software Engineer", jobDescription: "Fully remote. TypeScript cloud services on Amazon Web Services and Microsoft Azure. ReactJS, Node JS, CI/ CD pipelines and Terraform. Platform engineering, AI engineering, full-stack, FE and BE, AI coding agents and agentic AI workflows." },
      { ...rawJob(2), jobTitle: "Python Developer", jobDescription: "Fully remote. Python and Django." },
      { ...rawJob(3), jobTitle: "Software Engineer", jobDescription: "Fully remote. Java and SQL." },
      { ...rawJob(4), jobTitle: "Python Developer", jobDescription: "Fully remote. Python and AWS." },
    ])));
    const result = await createJobicyProvider(fetchImpl)({ ...context(), maxJobs: 10 });
    expect(result.groups[1]).toMatchObject({ status: "ok", jobs: [
      { id: "1", skills: profileSkills }, { id: "4", skills: ["AWS"] },
    ] });
  });

  it("recognises common keyword variants without treating ordinary 'be', generic nodes or AI mentions as matches", () => {
    for (const text of ["NodeJS", "Node.js", "Node JS"]) expect(matchingJobSkills(text)).toEqual(["Node.js"]);
    for (const text of ["CI/CD pipelines", "CI/ CD", "CICD", "CI-CD", "continuous integration", "continuous deployment"]) {
      expect(matchingJobSkills(text)).toEqual(["CI/CD"]);
    }
    expect(matchingJobSkills("Fullstack front-end back-end")).toEqual(["Full stack", "Frontend", "Backend"]);
    expect(matchingJobSkills("FE developer and BE engineer")).toEqual(["Frontend", "Backend"]);
    expect(matchingJobSkills("To be successful, use Python, graph nodes, reactive systems and AI tools.")).toEqual([]);
  });

  it("prioritises mid-level and unspecified roles over senior stretch roles and excludes unsuitable levels", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(page([
      { ...rawJob(1), jobTitle: "Senior Full Stack Engineer", jobLevel: "Senior" },
      { ...rawJob(2), jobTitle: "Software Engineer", jobLevel: "Mid-Level", jobDescription: "Fully remote. Terraform." },
      { ...rawJob(3), jobTitle: "Software Engineer", jobLevel: null },
      { ...rawJob(4), jobTitle: "Junior Software Engineer" },
      { ...rawJob(5), jobTitle: "Graduate Software Engineer" },
      { ...rawJob(6), jobTitle: "Software Engineer", jobLevel: "Junior" },
      ...["Lead", "Staff", "Principal", "Engineering Manager", "Intern", "Apprentice", "Entry-level"].map((level, index) => ({
        ...rawJob(7 + index), jobTitle: `${level} Software Engineer`,
      })),
      { ...rawJob(14), jobTitle: "Software Engineer", jobLevel: "Management" },
      { ...rawJob(15), jobTitle: "Software Engineer II", jobLevel: "Senior" },
      { ...rawJob(16), jobTitle: "Mid-level Software Engineer", jobLevel: "Junior" },
      { ...rawJob(17), jobTitle: "Software Engineer II" },
      { ...rawJob(18), jobTitle: "Software Engineer - Identity and Access Management" },
    ])));
    const result = await createJobicyProvider(fetchImpl)({ ...context(), maxJobs: 10 });
    const remote = result.groups.find((group) => group.workplace === "remote");
    if (!remote || remote.status !== "ok") throw new Error("Missing remote matches");
    expect(remote.jobs.map((job) => ({ id: job.id, seniority: job.seniority }))).toEqual([
      { id: "17", seniority: "mid-level" }, { id: "2", seniority: "mid-level" },
      { id: "18", seniority: "unspecified" }, { id: "3", seniority: "unspecified" },
      { id: "1", seniority: "senior" }, { id: "15", seniority: "senior" },
    ]);
    expect(result.notice).toContain("senior roles as stretch opportunities");
  });

  it("uses the free fixed endpoint, filters UK remote engineering roles and dates, and preserves attribution and gaps", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(page([
      rawJob(),
      { ...rawJob(2), jobGeo: "Anywhere" },
      { ...rawJob(3), jobDescription: "React. Hybrid, one day per week in the office." },
      { ...rawJob(4), pubDate: "2026-11-15T09:59:59Z" },
      { ...rawJob(5), pubDate: "2026-11-16T10:00:01Z" },
      { ...rawJob(6), jobTitle: "Sales Engineer" },
      { ...rawJob(7), jobGeo: "USA" },
      { ...rawJob(8), jobDescription: "TypeScript, remote-first, office visits." },
      { ...rawJob(9), jobDescription: "Fully remote. Python and AWS", jobTitle: "Python Developer", pubDate: "2026-11-15T10:00:00Z" },
      { ...rawJob(10), companyName: "Company 1" },
      { ...rawJob(11), jobDescription: "React. Flexible remote working." },
      { ...rawJob(12), jobDescription: "React. Not fully remote." },
      { ...rawJob(13), jobTitle: "Full Stack Engineer | Sweden | Remote" },
      { ...rawJob(14), jobTitle: "Full Stack Engineer | Germany | Remote" },
    ])));
    const result = await createJobicyProvider(fetchImpl)({ ...context(), maxJobs: 10 });
    expect(result.groups[0]).toMatchObject({ workplace: "hybrid", status: "unavailable" });
    expect(result.groups[1]).toMatchObject({
      workplace: "remote", status: "ok", jobs: [{ id: "1", skills: ["TypeScript", "React", "Full stack"] }, { id: "9", skills: ["AWS"] }],
    });
    expect(result.notice).toMatch(/Jobicy.*3-hour delay/);
    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(`${url.origin}${url.pathname}`).toBe("https://jobicy.com/api/jobs");
    expect(Object.fromEntries(url.searchParams)).toEqual({ count: "100", geo: "uk", industry: "engineering" });
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ cache: "no-store", redirect: "error" });
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).has("Authorization")).toBe(false);
  });

  it("bounds pagination, keeps cursor opaque, caps results and preserves supplied salary currency and period", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(page([{
        ...rawJob(), salaryMin: 600, salaryMax: 800, salaryCurrency: "USD", salaryPeriod: "daily",
      }], "opaque/+ token")))
      .mockResolvedValueOnce(Response.json(page([rawJob(2)], "next")));
    const result = await createJobicyProvider(fetchImpl)({ ...context(), maxJobs: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchImpl.mock.calls[1]?.[0])).searchParams.get("cursor")).toBe("opaque/+ token");
    expect(result.groups[1]).toMatchObject({ status: "ok", jobs: [{
      salary: { minimum: 600, maximum: 800, currency: "USD", period: "daily" },
    }] });
    expect(result.notice).toContain("further matches may exist");
  });

  it("distinguishes empty matches from request, schema and pagination failures without retrying", async () => {
    const empty = await createJobicyProvider(vi.fn<typeof fetch>().mockResolvedValue(Response.json(page([]))))({
      ...context(), maxJobs: 10,
    });
    expect(empty.groups[1]).toEqual({ workplace: "remote", status: "ok", jobs: [] });
    for (const response of [
      new Response("private response", { status: 429 }),
      new Response("private response", { status: 403 }),
      Response.json({ success: false }),
      Response.json(page([{ ...rawJob(), url: "https://attacker.example/jobs/1" }])),
      Response.json(page([{ ...rawJob(), pubDate: "not-a-date" }])),
      Response.json(page([{ ...rawJob(), salaryMin: 10, salaryMax: 1, salaryCurrency: "GBP", salaryPeriod: "yearly" }])),
    ]) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(createJobicyProvider(fetchImpl)({ ...context(), maxJobs: 10 })).rejects.not.toThrow("private response");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
    const repeated = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(page([rawJob()], "same")));
    await expect(createJobicyProvider(repeated)({ ...context(), maxJobs: 10 })).rejects.toThrow("repeated pagination");
  });

  it("honours cancellation and bounds a stalled request", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    try {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("private cancellation details")), { once: true });
      }));
      const request = createJobicyProvider(fetchImpl)({ ...context(), maxJobs: 10 });
      const checked = expect(request).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(6_001);
      await checked;
      const controller = new AbortController();
      const cancelled = createJobicyProvider(fetchImpl)({ ...context(), signal: controller.signal, maxJobs: 10 });
      const cancellation = expect(cancelled).rejects.toThrow("aborted");
      controller.abort();
      await cancellation;
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });
});

const release = (repo: string, id = 1) => ({
  id, name: "Release 1.0", tag_name: "v1.0", html_url: `https://github.com/${repo}/releases/tag/v1.0`,
  published_at: "2026-11-16T06:00:00Z", draft: false, prerelease: false,
});
describe("official engineering releases", () => {
  it("selects stable last-day releases from approved repositories, one per product, preserving independent successes", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const repo = engineeringSources.find((source) => String(url).includes(`/repos/${source.repo}/`))?.repo;
      if (!repo) throw new Error("Unapproved request");
      if (repo === engineeringSources[0].repo) return new Response("private response", { status: 403 });
      return Response.json([
        release(repo),
        { ...release(repo, 2), published_at: "2026-11-16T07:00:00Z", tag_name: "v1.1" },
        { ...release(repo, 3), prerelease: true, published_at: "2026-11-16T08:00:00Z" },
        { ...release(repo, 4), draft: true },
        { ...release(repo, 5), published_at: "2026-11-17T00:00:00Z" },
        { ...release(repo, 6), published_at: "2026-11-15T09:59:59Z" },
      ]);
    });
    const result = await createGitHubReleasesProvider(fetchImpl)({ ...context(), maxUpdates: 3 });
    expect(fetchImpl).toHaveBeenCalledTimes(engineeringSources.length);
    expect(result.updates).toHaveLength(3);
    expect(new Set(result.updates.map((update) => update.source)).size).toBe(3);
    expect(result.updates.every((update) => update.version === "v1.1")).toBe(true);
    expect(result.unavailableSources).toEqual([{ source: "VS Code", reason: "GitHub releases request failed (HTTP 403)" }]);
  });

  it("reports all-source failure explicitly and distinguishes no releases from bad links", async () => {
    await expect(createGitHubReleasesProvider(vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response("private response", { status: 429 }),
    ))({ ...context(), maxUpdates: 3 })).rejects.toThrow("All configured");
    const empty = await createGitHubReleasesProvider(vi.fn<typeof fetch>().mockImplementation(async () => Response.json([])))({
      ...context(), maxUpdates: 3,
    });
    expect(empty).toEqual({ updates: [], unavailableSources: [] });
    await expect(createGitHubReleasesProvider(vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json([{ ...release("microsoft/vscode"), html_url: "https://attacker.example/release" }]),
    ))({ ...context(), maxUpdates: 3 })).rejects.toThrow("All configured");
  });
});

describe("career orchestration and email", () => {
  it("keeps a fully populated email with ten jobs and three releases below 100 KiB", () => {
    const jobs = Array.from({ length: 10 }, (_, index): JobListing => ({
      id: `${index < 5 ? "reed:" : ""}${index}`, seniority: "mid-level",
      title: "Mid-level Full Stack TypeScript and AI Software Engineer",
      company: "Example Engineering Company", skills: profileSkills,
      location: index < 5 ? "Guildford" : "UK", workplace: index < 5 ? "hybrid" : "remote",
      source: index < 5 ? "Reed" : "Jobicy",
      url: index < 5 ? `https://www.reed.co.uk/jobs/software-engineer/${index}` : `https://jobicy.com/jobs/${index}-engineer`,
      ...(index < 5 ? { publishedDate: "2026-11-15" } : { publishedAt: "2026-11-16T06:00:00Z" }),
      excerpt: "Verified employer-provided excerpt. ".repeat(8).slice(0, 280),
      salary: { minimum: 70_000, maximum: 90_000, currency: "USD", period: "yearly" },
    }));
    const model: BriefingModel = {
      briefingId: "morning-briefing", name: "Morning Briefing", timezone: "Europe/London",
      reportingDate: "2026-11-16", generatedAt: now.toISOString(), sections: [
        { id: "calendar", kind: "calendar", title: "Today's Calendar", outcome: { status: "ok", data: [
          { id: "meeting", title: "Team meeting", timing: { kind: "timed", start: "2026-11-16T09:00:00Z", end: "2026-11-16T09:30:00Z" } },
          { id: "office", title: "Office", timing: { kind: "all-day", startDate: "2026-11-16", endDate: "2026-11-17" } },
        ] } },
        { id: "weather", kind: "weather", title: "Weather", outcome: { status: "ok", data: [
          { locationId: "wheatley", locationName: "Wheatley (Oxford)" },
          { locationId: "wotton-under-edge", locationName: "Wotton-under-Edge" },
          { locationId: "lower-earley", locationName: "Lower Earley" },
        ].map((location) => ({
          ...location, date: "2026-11-16", summary: "Partly cloudy", temperatureMinC: 4, temperatureMaxC: 12,
          precipitationProbabilityPercent: 45, windSpeedMaxKph: 18,
          hourly: [6, 9, 12, 15, 18, 21].map((hour) => ({
            at: `2026-11-16T${String(hour).padStart(2, "0")}:00:00Z`, summary: "Partly cloudy",
            emoji: "🌤️", temperatureC: 8, precipitationProbabilityPercent: 40,
          })),
        })) } },
        ...(["tech-ai", "uk-politics-finance", "global-affairs"] as const).map((category) => ({
          id: category, kind: "news" as const, title: category, outcome: { status: "ok" as const,
            data: Array.from({ length: 3 }, (_, index) => ({
              category, title: "A verified headline about the latest developments in this news category",
              description: "Publisher-provided excerpt. ".repeat(10), publisher: "News publisher",
              publishedAt: "2026-11-16T06:00:00Z", url: `https://example.com/${category}/${index}`,
            })),
          },
        })),
        { id: "markets", kind: "markets", title: "Markets", outcome: { status: "ok", data: marketAssets.map((asset) => ({
          assetId: asset.id, status: "ok", price: 123.45, asOf: "2026-11-15T20:00:00Z",
          priceType: "close", stale: false, change: { percent: 2, basis: "previous-close" },
          session: { date: "2026-11-15", open: 121, previousClose: 120, low: 119, high: 125, volume: 1_000_000 },
          source: { name: "Twelve Data", url: "https://twelvedata.com" },
        })) } },
        { id: "jobs", kind: "jobs", title: "New Engineering Jobs", outcome: { status: "ok", data: [
          { workplace: "hybrid", status: "ok", jobs: jobs.slice(0, 5) },
          { workplace: "remote", status: "ok", jobs: jobs.slice(5) },
        ], notice: "Reed: today/yesterday · Jobicy: 24h (3h delay)" } },
        { id: "engineering", kind: "engineering", title: "AI Engineering Updates", outcome: { status: "ok",
          data: engineeringSources.slice(0, 3).map((source) => ({
            id: source.repo, source: source.name, title: "Official product release with developer tooling updates",
            version: "v1.2.3", publishedAt: "2026-11-16T06:00:00Z", url: `https://github.com/${source.repo}/releases/tag/v1.2.3`,
          })),
        } },
      ],
    };
    const { html, text } = renderBriefingEmail(model, "morning-briefing");
    expect(html.match(/<input class="disclosure-toggle"/g)).toHaveLength(32);
    expect(text.match(/https:\/\/jobicy.com\/jobs\//g)).toHaveLength(5);
    expect(text.match(/https:\/\/www.reed.co.uk\/jobs\//g)).toHaveLength(5);
    expect(Buffer.byteLength(html, "utf8")).toBeLessThan(100 * 1024);
  });

  it("is opt-in, appends after markets and never enables delivery outside prod", () => {
    const base = { APP_ENV: "dev", CRON_SECRET: "x".repeat(32) } as const;
    expect(createBriefingDependencies(base).providers.jobs).toBeUndefined();
    const dependencies = createBriefingDependencies({
      ...base, CAREER_INTEL_ENABLED: "true", MARKETS_ENABLED: "true", TWELVE_DATA_API_KEY: "test",
    });
    expect(dependencies.getDefinition?.("morning-briefing")?.sections.map((section) => section.id)).toEqual([
      "calendar", "weather", "tech-ai", "uk-politics-finance", "global-affairs", "markets", "engineering-jobs", "ai-engineering",
    ]);
    expect(dependencies.providers.jobs?.["career-jobs"]).toBeTypeOf("function");
    expect(dependencies.delivery).toBeUndefined();
  });

  it("passes rolling windows, preserves gaps and renders safe independent expandable cards in both formats", async () => {
    const jobs = vi.fn<JobsProvider>().mockResolvedValue({
      groups: [
        { workplace: "hybrid", status: "unavailable", reason: "Hybrid source not configured" },
        { workplace: "remote", status: "ok", jobs: [{ ...normalJob, seniority: "senior" }] },
      ], notice: "Jobicy: 3-hour delay.",
    });
    const engineering = vi.fn<EngineeringProvider>().mockResolvedValue({
      updates: [{ id: "release", title: "Version 1", source: "VS Code", version: "v1",
        publishedAt: "2026-11-16T06:00:00Z", url: "https://github.com/microsoft/vscode/releases/tag/v1" }],
      unavailableSources: [{ source: "Other", reason: "Source request failed" }],
    });
    const run = await runBriefing("morning-briefing", "preview", {
      now: () => now,
      getDefinition: () => {
        const definition = getBriefingDefinition("morning-briefing");
        if (!definition) throw new Error("Missing definition");
        return { ...definition, sections: morningCareerSections };
      },
      providers: { calendar: {}, weather: {}, news: {}, jobs: { "career-jobs": jobs }, engineering: { "github-releases": engineering } },
    });
    expect(run.status).toBe("completed-with-gaps");
    expect(jobs.mock.calls[0]?.[0]).toMatchObject({ window: context().window, maxJobs: 10 });
    expect(engineering.mock.calls[0]?.[0]).toMatchObject({ window: context().window, maxUpdates: 3 });
    expect(summariseRun(run).sections).toMatchObject([
      { status: "partial", items: 1 }, { status: "partial", items: 1, unavailableSources: 1 },
    ]);
    if (!run.briefing) throw new Error("Missing briefing");
    const { html, text } = renderBriefingEmail(run.briefing, "morning-briefing");
    for (const output of [html, text]) {
      expect(output).toContain("Salary not disclosed");
      expect(output).toContain("Permanent unconfirmed");
      expect(output).toContain("Full-time unconfirmed");
      expect(output).toContain("GBP 48,000/year minimum unconfirmed");
      expect(output).toContain("Source: Jobicy");
      expect(output).toContain("Senior — stretch opportunity");
      expect(output).toContain("Hybrid source not configured");
      expect(output).toContain("Other unavailable: Source request failed");
      expect(output).toContain("https://jobicy.com/jobs/1-engineer");
    }
    expect(html).toContain("&lt;Engineer&gt;");
    expect(html).toContain("&lt;script&gt;Not HTML&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html.match(/<input class="disclosure-toggle"/g)).toHaveLength(2);
    expect(text).toContain("Listing excerpt: <script>Not HTML</script>");
    expect(text).toContain("16 Nov, 06:00");
    expect(text).not.toContain("<input");
  });

  it("rejects unsafe career links even when rendering a model directly", () => {
    const model: BriefingModel = {
      briefingId: "morning-briefing", name: "Morning Briefing", timezone: "Europe/London",
      reportingDate: "2026-11-16", generatedAt: now.toISOString(), sections: [{
        id: "jobs", kind: "jobs", title: "Jobs", outcome: {
          status: "ok", data: [{ workplace: "remote", status: "ok", jobs: [{ ...normalJob, url: "javascript:alert(1)" }] }],
        },
      }],
    };
    expect(() => renderBriefingEmail(model, "morning-briefing")).toThrow("invalid job data");
  });
});
