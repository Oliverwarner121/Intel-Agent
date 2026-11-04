export const newsCategories = [
  "tech-ai",
  "uk-politics-finance",
  "global-affairs",
] as const;

export type NewsCategory = (typeof newsCategories)[number];

/** A real published article. V1 never generates or rewrites story content. */
export interface NewsStory {
  title: string;
  url: string;
  publisher: string;
  publishedAt: string;
  category: NewsCategory;
}
