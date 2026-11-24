# Intel-Agent

Intel-Agent creates a personal morning briefing and delivers it by email. It
collects calendar events, local weather and selected news, with optional market
data, job listings and AI engineering updates.

## Briefing outline

- **Today's Calendar** — events from the configured Google Calendar.
- **Weather** — forecasts for Wheatley (Oxford), Wotton-under-Edge and Lower Earley, plus UK weather warnings.
- **Worldwide Tech and AI**, **UK Politics and Finance**, and **Global Affairs** — selected recent headlines with publishers, publication times and source links.
- **Optional Markets** — quotes for configured assets.
- **Optional Career and AI Engineering Updates** — UK job listings and selected software/AI release and product updates.

The briefing uses `Europe/London` dates and times. Sections are collected
independently, so a source problem is reported without discarding other
available sections. Story and update selection is deterministic; the project
does not generate summaries or introductions with an LLM.

## Data APIs and feeds

- **Google Calendar API** — calendar events; requires Google OAuth configuration.
- **Open-Meteo Forecast API** — local forecasts.
- **UK Met Office warnings RSS** — active weather warnings.
- **GNews API** — news headlines; requires `GNEWS_API_KEY`.
- **Twelve Data quote API** — optional market prices; enable with
  `MARKETS_ENABLED=true` and configure `TWELVE_DATA_API_KEY`.
- **Jobicy API** — optional remote engineering jobs.
- **Reed Jobseeker API** — optional UK hybrid jobs; requires `REED_API_KEY`.
- **GitHub REST API (releases)** — optional software and AI engineering updates.
- **GitHub Copilot changelog RSS** — Copilot product announcements.

Resend is used for email delivery; it is not a data source. Scheduled runs use
an authenticated Vercel Cron route. Email sending is separately configured and
only enabled in the production application environment.

## Project

The app is built with Next.js, TypeScript, Zod, and Vitest. Its flow is:

`Vercel Cron → briefing orchestrator → data providers → selection → email → delivery`

Local development: `npm install`, then `npm run dev`. Run checks with
`npm run lint`, `npm run typecheck`, and `npm test`. Use `npm run email:preview`
to render a local email preview without sending it.
