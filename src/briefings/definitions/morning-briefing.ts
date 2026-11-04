import type { z } from "zod";
import type { briefingDefinitionSchema } from "@/briefings/briefing.types";
import { LONDON_TIMEZONE } from "@/lib/date";

export const morningBriefing = {
  id: "morning-briefing",
  name: "Morning Briefing",
  description: "Today's calendar, local weather and overnight news, delivered each morning.",
  enabled: true,
  timezone: LONDON_TIMEZONE,
  schedule: {
    cronUtc: "0 5 * * *",
    route: "/api/cron/morning-briefing",
    description:
      "Daily within 05:00–05:59 UTC on Vercel Hobby: 05:00–05:59 UK time in GMT, 06:00–06:59 in BST. Arrival before 07:00 is not guaranteed.",
  },
  sections: [
    { id: "calendar", kind: "calendar", title: "Today's Calendar", provider: "google-calendar", period: "local-day" },
    {
      id: "weather",
      kind: "weather",
      title: "Weather",
      provider: "open-meteo",
      locationIds: ["wheatley", "wotton-under-edge", "lower-earley"],
    },
    {
      id: "tech-ai",
      kind: "news",
      title: "Worldwide Tech and AI",
      provider: "rss",
      category: "tech-ai",
      maxStories: 3,
      windowHours: 24,
    },
    {
      id: "uk-politics-finance",
      kind: "news",
      title: "UK Politics and Finance",
      provider: "rss",
      category: "uk-politics-finance",
      maxStories: 3,
      windowHours: 24,
    },
    {
      id: "global-affairs",
      kind: "news",
      title: "Global Affairs",
      provider: "rss",
      category: "global-affairs",
      maxStories: 3,
      windowHours: 24,
    },
  ],
  template: "morning-briefing",
  delivery: { channel: "email", subject: "Your Intel-Agent morning briefing" },
} satisfies z.input<typeof briefingDefinitionSchema>;
