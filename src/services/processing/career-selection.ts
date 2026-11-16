import { addDays, localDate, type ReportingPeriod } from "@/lib/date";
import { jobSearchPreferences } from "@/config/job-search";
import type { JobListing } from "@/types/career";
import { SafeError } from "@/types/briefing";

const skills = [
  ["TypeScript", /\btypescript\b/i],
  ["Cloud", /\bcloud\b/i],
  ["AWS", /\b(?:aws|amazon\s+web\s+services)\b/i],
  ["Azure", /\bazure\b/i],
  ["React", /\breact(?:[.\s-]?js)?\b/i],
  ["Node.js", /\bnode[.\s-]?js\b/i],
  ["CI/CD", /\bci(?:\s*[/&-]\s*|\s*)cd\b|\bcontinuous[\s-]+(?:integration|delivery|deployment)\b/i],
  ["Terraform", /\bterraform\b/i],
  ["Platform engineering", /\bplatform[\s-]+engineer(?:ing|s)?\b/i],
  ["AI engineering", /\b(?:ai(?:\s*\/\s*ml)?|artificial\s+intelligence|machine[\s-]+learning)[\s-]+engineer(?:ing|s)?\b/i],
  ["Full stack", /\bfull[\s-]?stack\b/i],
  ["Frontend", /\b(?:front[\s-]?end|fe[\s-]+(?:engineer|developer|development))\b|\bfe\s*(?:[/&]|and)\s*be\b/i],
  ["Backend", /\b(?:back[\s-]?end|be[\s-]+(?:engineer|developer|development))\b|\bfe\s*(?:[/&]|and)\s*be\b/i],
  ["AI agents", /\b(?:ai|artificial\s+intelligence)(?:[\s-]+(?:powered|coding|autonomous))?[\s-]+agents?\b/i],
  ["Agentic workflows", /\bagentic(?:[\s-]+ai)?[\s-]+workflows?\b/i],
] as const;

export const jobSeniorityRank = { "mid-level": 0, unspecified: 1, senior: 2 };

export function matchingJobSkills(text: string): string[] {
  return skills.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

export function isEngineeringRoleTitle(title: string): boolean {
  return /\b(?:engineer|developer)\b/i.test(title) &&
    !/\b(?:sales|support|recruitment)\b/i.test(title);
}

export function matchesEngineeringRole(title: string, technologies: string[]): boolean {
  return technologies.length > 0 && isEngineeringRoleTitle(title);
}

export function matchJobEmployment(labels: readonly string[]): Pick<JobListing, "contractType" | "jobType"> | undefined {
  const text = labels.join(" ");
  if (/\b(?:contract(?:or)?|temporary|temp|freelance|fixed[\s-]?term|part[\s-]?time|internship|apprenticeship|casual|seasonal|non[\s-]?permanent)\b/i.test(text)) {
    return undefined;
  }
  return {
    ...(/\bpermanent\b/i.test(text) ? { contractType: "permanent" as const } : {}),
    ...(/\bfull[\s-]?time\b/i.test(text) ? { jobType: "full-time" as const } : {}),
  };
}

export function matchesJobSalary(salary: JobListing["salary"]): boolean {
  if (!salary || salary.currency !== "GBP" || salary.period !== "yearly") return true;
  const bound = salary.minimum ?? salary.maximum;
  return bound === undefined || bound >= jobSearchPreferences.minimumAnnualSalaryGBP;
}

export function plainJobText(value: string): string {
  const entities: Readonly<Record<string, string>> = { amp: "&", nbsp: " ", lt: "<", gt: ">", quot: '"', apos: "'" };
  return value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " ")
    .replace(/&([a-z]+|#\d+|#x[\da-f]+);/gi, (entity: string, code: string) => {
      if (!code.startsWith("#")) return entities[code.toLowerCase()] ?? entity;
      const point = code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : entity;
    }).replace(/\s+/g, " ").trim();
}

export function hybridPostingDates(reportingDate: string, timezone: string) {
  return { startDate: addDays(reportingDate, -1), endDate: reportingDate, timezone };
}

export function classifyJobSeniority(title: string, sourceLevel?: string | null): NonNullable<JobListing["seniority"]> | "excluded" {
  const text = `${title} ${sourceLevel ?? ""}`;
  if (/\b(?:junior|jr|graduate|entry[\s-]?level|intern|internship|apprentice|trainee|lead|staff|principal|head|director|manager|chief|distinguished|fellow)\b/i.test(text) ||
    /\bmanagement\b/i.test(sourceLevel ?? "")) {
    return "excluded";
  }
  if (/\b(?:senior|sr)\b/i.test(text)) return "senior";
  if (/\b(?:mid(?:[\s-]?(?:level|weight))?|intermediate)\b|\b(?:engineer|developer)\s+(?:ii|2)\b/i.test(text)) return "mid-level";
  return "unspecified";
}

export function selectJobs(
  jobs: JobListing[], window: ReportingPeriod, maximum: number,
  dateOnlyWindow?: ReturnType<typeof hybridPostingDates>,
): JobListing[] {
  const seenIds = new Set<string>();
  const seenRoles = new Set<string>();
  const eligible = jobs.filter((job) => {
    if (job.publishedAt === undefined) {
      return dateOnlyWindow !== undefined && job.publishedDate >= dateOnlyWindow.startDate && job.publishedDate <= dateOnlyWindow.endDate;
    }
    const at = Date.parse(job.publishedAt);
    return at >= window.start.getTime() && at < window.end.getTime();
  });
  const hasDateOnly = eligible.some((job) => job.publishedDate !== undefined);
  const comparePublication = (a: JobListing, b: JobListing) => {
    // Mixed sources use calendar dates consistently, never an invented time for Reed.
    if (hasDateOnly && dateOnlyWindow) {
      const date = (job: JobListing) => job.publishedDate ?? localDate(new Date(job.publishedAt), dateOnlyWindow.timezone);
      return date(b).localeCompare(date(a));
    }
    if (a.publishedAt === undefined || b.publishedAt === undefined) throw new SafeError("Date-only job requires an explicit reporting-date window");
    return Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
  };
  return eligible.sort((a, b) => jobSeniorityRank[a.seniority ?? "unspecified"] - jobSeniorityRank[b.seniority ?? "unspecified"] ||
    b.skills.length - a.skills.length ||
    comparePublication(a, b) || a.id.localeCompare(b.id),
  ).filter((job) => {
    const role = `${job.company}/${job.title}/${job.workplace}`.toLowerCase().replace(/\s+/g, " ").trim();
    if (seenIds.has(job.id) || seenRoles.has(role)) return false;
    seenIds.add(job.id);
    seenRoles.add(role);
    return true;
  }).slice(0, maximum);
}
