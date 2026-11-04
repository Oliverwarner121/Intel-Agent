import { z } from "zod";
import { isValidTimezone } from "@/lib/date";
import { newsCategories } from "@/types/news";

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a lowercase kebab-case identifier");

const sectionBase = {
  id: slug,
  title: z.string().trim().min(1),
  /** Provider ID resolved from the provider registry for this section kind. */
  provider: slug,
};

const calendarSectionSchema = z.object({
  ...sectionBase,
  kind: z.literal("calendar"),
  period: z.literal("local-day"),
});

const weatherSectionSchema = z.object({
  ...sectionBase,
  kind: z.literal("weather"),
  locationIds: z.array(slug).min(1),
});

const newsSectionSchema = z.object({
  ...sectionBase,
  kind: z.literal("news"),
  category: z.enum(newsCategories),
  maxStories: z.int().min(1).max(10),
  windowHours: z.int().min(1).max(168),
});

export const briefingSectionSchema = z.discriminatedUnion("kind", [
  calendarSectionSchema,
  weatherSectionSchema,
  newsSectionSchema,
]);

export const briefingDefinitionSchema = z.object({
  id: slug,
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  enabled: z.boolean(),
  timezone: z.string().refine(isValidTimezone, "must be a valid IANA timezone"),
  /**
   * Describes the deployed schedule. Vercel Cron runs in UTC and vercel.json
   * controls execution; tests keep the two consistent.
   */
  schedule: z.object({
    cronUtc: z.string().regex(/^\S+ \S+ \S+ \S+ \S+$/, "must be a five-field cron expression"),
    route: z.string().regex(/^\/api\/cron\/[a-z0-9-]+$/),
    description: z.string().trim().min(1),
  }),
  sections: z
    .array(briefingSectionSchema)
    .min(1)
    .refine((sections) => new Set(sections.map((section) => section.id)).size === sections.length, {
      message: "section IDs must be unique",
    }),
  template: slug,
  delivery: z.object({
    channel: z.literal("email"),
    subject: z.string().trim().min(1),
  }),
});

export type BriefingDefinition = z.infer<typeof briefingDefinitionSchema>;
export type BriefingSection = z.infer<typeof briefingSectionSchema>;
export type SectionKind = BriefingSection["kind"];
export type SectionOfKind<K extends SectionKind> = Extract<BriefingSection, { kind: K }>;
