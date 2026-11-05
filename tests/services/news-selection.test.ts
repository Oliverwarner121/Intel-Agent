import { describe, expect, it } from "vitest";
import { canonicalNewsUrl, selectNewsStories } from "@/services/processing/news-selection";
import type { NewsStory } from "@/types/news";

const story = (title: string, extra: Partial<NewsStory> = {}): NewsStory => ({
  title, url: `https://news.example/${encodeURIComponent(title)}`, publisher: "Fixture Publisher",
  category: "uk-politics-finance", publishedAt: "2026-11-04T14:00:00Z", ...extra,
});

describe("deterministic news selection", () => {
  it("groups the Bank of England example as one event across publishers", () => {
    const candidates = [
      story("Bank of England cuts interest rates", { publisher: "Fixture A" }),
      story("BoE votes to lower UK rates", { publisher: "Fixture B", description: "The Bank of England lowers rates." }),
      story("Interest rates cut by Bank of England", { publisher: "Fixture C" }),
    ];
    expect(selectNewsStories(candidates, 3)).toHaveLength(1);
    expect(selectNewsStories([...candidates].reverse(), 3)).toEqual(selectNewsStories(candidates, 3));
  });

  it("removes canonical URL duplicates while keeping real query identifiers", () => {
    const original = story("UK government announces Budget", { url: "https://www.news.example/story/?id=1&utm_source=test#top" });
    const duplicate = story("British chancellor reveals new budget", { url: "https://news.example/story?id=1&fbclid=track" });
    expect(selectNewsStories([original, duplicate], 3)).toHaveLength(1);
    expect(canonicalNewsUrl(original.url)).toBe("https://news.example/story?id=1");
    expect(canonicalNewsUrl("https://news.example/story?id=2")).not.toBe(canonicalNewsUrl(original.url));
  });

  it("ranks relevant important stories rather than taking the first three", () => {
    const candidates = [
      story("Celebrity football shopping deals", { category: "tech-ai" }),
      story("Technology weekly chat", { category: "tech-ai" }),
      story("Technology office routines", { category: "tech-ai" }),
      story("Artificial intelligence semiconductor cybersecurity crisis", { category: "tech-ai" }),
      story("AI models transform cloud computing", { category: "tech-ai" }),
      story("Nvidia chips power generative AI", { category: "tech-ai" }),
    ];
    const selected = selectNewsStories(candidates, 3);
    expect(selected).toHaveLength(3);
    expect(selected[0]?.title).toBe("Artificial intelligence semiconductor cybersecurity crisis");
    expect(selected.map((item) => item.title)).not.toContain("Technology weekly chat");
    expect(selectNewsStories([...candidates].reverse(), 3)).toEqual(selected);
    expect(selectNewsStories(candidates, 10)).toHaveLength(3);
    expect(selectNewsStories(candidates, 0)).toEqual([]);
  });

  it("keeps opposite policy decisions, different figures and different events separate", () => {
    const candidates = [
      story("Bank of England cuts interest rates"),
      story("Bank of England raises interest rates"),
      story("UK government announces inflation at 2 percent"),
      story("UK government announces inflation at 4 percent"),
    ];
    expect(selectNewsStories(candidates.slice(0, 2), 3)).toHaveLength(2);
    expect(selectNewsStories(candidates.slice(2), 3)).toHaveLength(2);
    expect(selectNewsStories([
      story("UK inflation drops to 2.5 percent"),
      story("UK inflation drops to 5.2 percent"),
    ], 3)).toHaveLength(2);
    expect(selectNewsStories([
      story("OpenAI launches new AI model", { category: "tech-ai" }),
      story("Google launches new AI model", { category: "tech-ai" }),
    ], 3)).toHaveLength(2);
    expect(selectNewsStories([
      story("Nvidia launches AI semiconductor model", { category: "tech-ai" }),
      story("Google launches AI cybersecurity model", { category: "tech-ai" }),
    ], 3)).toHaveLength(2);
  });

  it("rejects irrelevant global affairs and leaves fewer than three rather than fabricating filler", () => {
    expect(selectNewsStories([
      story("International celebrity football tournament", { category: "global-affairs" }),
      story("NATO negotiates international ceasefire treaty", { category: "global-affairs" }),
    ], 3)).toHaveLength(1);
    expect(selectNewsStories([], 3)).toEqual([]);
  });

  it("uses recency and stable URL ties for equal relevance", () => {
    const first = story("UK budget policy changes", { url: "https://news.example/a" });
    const second = story("UK budget policy changes", { url: "https://news.example/b", publishedAt: "2026-11-04T15:00:00Z" });
    expect(selectNewsStories([first, second], 3)[0]).toBe(second);
    expect(selectNewsStories([first, { ...second, publishedAt: first.publishedAt }], 3)[0]).toBe(first);
  });
});
