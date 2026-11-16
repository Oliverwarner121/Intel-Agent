import { z } from "zod";

const sourceUrl = z.string().max(4096).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}, "must be an HTTPS source link without credentials");
const text = z.string().trim().min(1).max(300);

export const jobListingSchema = z.object({
  id: text,
  title: text,
  company: text,
  location: text,
  workplace: z.enum(["remote", "hybrid"]),
  contractType: z.literal("permanent").optional(),
  jobType: z.literal("full-time").optional(),
  seniority: z.enum(["mid-level", "senior", "unspecified"]).optional(),
  url: sourceUrl,
  source: text,
  excerpt: z.string().max(280).optional(),
  skills: z.array(text).max(15),
  salary: z.object({
    minimum: z.number().finite().nonnegative().optional(),
    maximum: z.number().finite().nonnegative().optional(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    period: z.enum(["yearly", "monthly", "weekly", "daily", "hourly"]),
  }).refine((salary) =>
    (salary.minimum !== undefined || salary.maximum !== undefined) &&
    (salary.minimum === undefined || salary.maximum === undefined || salary.minimum <= salary.maximum),
  ).optional(),
}).and(z.union([
  z.object({ publishedAt: z.iso.datetime({ offset: true }), publishedDate: z.never().optional() }),
  z.object({ publishedDate: z.iso.date(), publishedAt: z.never().optional() }),
]));

export const jobGroupSchema = z.discriminatedUnion("status", [
  z.object({ workplace: z.enum(["hybrid", "remote"]), status: z.literal("ok"), jobs: z.array(jobListingSchema).max(10) }),
  z.object({ workplace: z.enum(["hybrid", "remote"]), status: z.literal("partial"), jobs: z.array(jobListingSchema).max(10), reason: text }),
  z.object({ workplace: z.enum(["hybrid", "remote"]), status: z.literal("unavailable"), reason: text }),
]);

export const engineeringUpdateSchema = z.object({
  id: text,
  title: text,
  source: text,
  version: text,
  publishedAt: z.iso.datetime({ offset: true }),
  url: sourceUrl,
});

export type JobListing = z.infer<typeof jobListingSchema>;
export type JobGroup = z.infer<typeof jobGroupSchema>;
export type EngineeringUpdate = z.infer<typeof engineeringUpdateSchema>;
export interface CareerSourceFailure { source: string; reason: string }
export interface JobsCollection { groups: JobGroup[]; notice: string }
export interface EngineeringCollection { updates: EngineeringUpdate[]; unavailableSources: CareerSourceFailure[] }
