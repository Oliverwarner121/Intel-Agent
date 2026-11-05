import type { NewsCategory, NewsStory } from "@/types/news";

const relevanceTerms: Record<NewsCategory, readonly string[]> = {
  "tech-ai": [
    "artificial intelligence", "generative ai", "ai", "openai", "anthropic", "microsoft",
    "google", "nvidia", "apple", "amazon", "meta", "semiconductor", "semiconductors",
    "chip", "chips", "cloud computing", "cybersecurity", "technology", "model", "models",
  ],
  "uk-politics-finance": [
    "government", "parliament", "prime minister", "chancellor", "treasury", "bank of england",
    "interest rates", "inflation", "tax", "taxation", "budget", "economy", "markets",
    "employment", "policy", "election", "politics", "labour", "conservative",
  ],
  "global-affairs": [
    "war", "conflict", "ceasefire", "diplomacy", "sanctions", "election", "elections",
    "trade", "tariff", "tariffs", "crisis", "nato", "eu", "china", "russia", "ukraine",
    "middle east", "international", "security", "treaty", "summit", "invasion",
    "government", "economy", "economic", "united nations", "foreign policy",
  ],
};
const significantTerms = [
  "war", "conflict", "ceasefire", "sanctions", "election", "elections", "crisis",
  "interest rates", "budget", "inflation", "security", "cybersecurity", "semiconductor",
  "artificial intelligence", "treaty", "tariffs",
];
const lowImpact = /\b(celebrity|celebrities|horoscope|football|cricket|rugby|premier league|box office|shopping deals|coupon|giveaway)\b/i;
const ukContext = /\b(uk|united kingdom|britain|british|england|scotland|wales|northern ireland|westminster|downing street|bank of england)\b/i;

function words(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

function mentions(text: string, term: string): boolean {
  return ` ${text} `.includes(` ${term} `);
}

export function newsRelevance(story: NewsStory): number {
  const title = words(story.title);
  const text = `${title} ${words(story.description ?? "")}`;
  if (lowImpact.test(text)) return 0;
  if (story.category === "uk-politics-finance" && !ukContext.test(text)) return 0;
  const terms = relevanceTerms[story.category];
  const relevance = terms.reduce((score, term) =>
    score + (mentions(title, term) ? 4 : mentions(text, term) ? 1 : 0), 0);
  if (!relevance) return 0;
  return relevance + significantTerms.filter((term) => mentions(title, term)).length * 2;
}

export function canonicalNewsUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_.+|fbclid|gclid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  url.hostname = url.hostname.replace(/^www\./, "");
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.href;
}

const stopWords = new Set([
  "a", "an", "the", "of", "in", "on", "at", "for", "to", "and", "as", "by", "with",
  "from", "after", "over", "is", "are", "has", "have", "will", "new", "says", "say",
  "votes", "vote", "uk",
]);
const eventEntities = [
  "openai", "anthropic", "microsoft", "google", "nvidia", "apple", "amazon", "meta",
  "bankengland", "nato", "china", "russia", "ukraine",
];

function headlineTokens(title: string): Set<string> {
  const normalized = words(title)
    .replace(/\bbank of england\b|\bboe\b/g, "bankengland")
    .replace(/\binterest rates?\b/g, "rate")
    .replace(/\brates\b/g, "rate")
    .replace(/\b(cuts|cutting|lower|lowers|lowered|reduce|reduces|reduced)\b/g, "cut")
    .replace(/\b(hikes|hike|raises|raise|raised|increase|increases|increased)\b/g, "rise");
  return new Set(normalized.split(" ").filter((token) => token && !stopWords.has(token)));
}

function sameEvent(a: NewsStory, b: NewsStory): boolean {
  const left = headlineTokens(a.title);
  const right = headlineTokens(b.title);
  // Keep different figures and opposite policy decisions separate.
  const numbers = (title: string) => (title.match(/\d+(?:[.,]\d+)*/g) ?? []).sort().join("|");
  if (numbers(a.title) !== numbers(b.title)) return false;
  if ([...left].join(" ") === [...right].join(" ")) return true;
  const leftEntities = eventEntities.filter((entity) => left.has(entity));
  const rightEntities = eventEntities.filter((entity) => right.has(entity));
  if (leftEntities.length && rightEntities.length && leftEntities.join(",") !== rightEntities.join(",")) return false;
  if ((left.has("cut") && right.has("rise")) || (left.has("rise") && right.has("cut"))) return false;
  const common = [...left].filter((token) => right.has(token)).length;
  return common >= 3 && common / Math.min(left.size, right.size) >= 0.75 &&
    common / (left.size + right.size - common) >= 0.5;
}

/** Relevance first, then recency and stable lexical ties; no inferred reporting. */
export function selectNewsStories(stories: NewsStory[], maxStories: number): NewsStory[] {
  const ranked = stories.map((story) => ({ story, score: newsRelevance(story) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score ||
      Date.parse(b.story.publishedAt) - Date.parse(a.story.publishedAt) ||
      a.story.url.localeCompare(b.story.url, "en-GB") || a.story.title.localeCompare(b.story.title, "en-GB") ||
      a.story.publisher.localeCompare(b.story.publisher, "en-GB") ||
      (a.story.description ?? "").localeCompare(b.story.description ?? "", "en-GB"));
  const selected: NewsStory[] = [];
  const urls = new Set<string>();
  const limit = Math.max(0, Math.min(3, Math.floor(maxStories)));
  for (const { story } of ranked) {
    if (selected.length >= limit) break;
    const url = canonicalNewsUrl(story.url);
    if (urls.has(url) || selected.some((existing) => sameEvent(existing, story))) continue;
    urls.add(url);
    selected.push(story);
  }
  return selected;
}
