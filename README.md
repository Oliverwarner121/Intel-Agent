# Intel-Agent

Intel-Agent is an automated briefing service that emails you the information you
need for the day: your calendar, local weather and a handful of selected news
headlines, all in one message.

## Capabilities

- **Calendar overview** – lists the day's events from Google Calendar, including
  all-day, multi-day and recurring events, with cancelled and declined events
  left out.
- **Weather** – forecasts for a set of chosen locations, plus UK Met Office
  weather warnings.
- **News headlines** – up to three recent stories for each of Worldwide Tech and
  AI, UK Politics and Finance, and Global Affairs, each shown with its publisher,
  publication time and a link to the original source.
- **Markets** – an optional section for tracked market assets.
- **Scheduled delivery** – the briefing is generated and emailed automatically
  every morning, and is built from a configurable briefing definition.
- **Resilient by design** – each section is collected independently, so if one
  source is unavailable the rest of the email is still delivered and the gap is
  clearly marked.
- **Correct local times** – all dates and times use `Europe/London`, including
  across GMT/BST changes.
- **No AI-generated text** – the email contains only data from the providers and
  headlines chosen by deterministic rules.

## How it works

```
Scheduler → briefing orchestrator → data providers → processing → email renderer → delivery
```

- **Briefing definitions** describe which sections a briefing contains, their
  order and their limits.
- **Providers** wrap each external service and return shared, validated types:
  Google Calendar, Open-Meteo, Met Office warnings, GNews and Twelve Data.
- **Delivery** goes through Resend, using a stable key per briefing, date and
  recipient so the same briefing is not sent twice.
- **Scheduling** uses a protected Vercel Cron route.

## Tech stack

Next.js (App Router), TypeScript, Node.js, Zod, Vitest and ESLint. The test suite
mocks every external service and never sends real email.

## Security

- Credentials are kept server-side and are never committed to the repository.
- Scheduled and manual triggers are authenticated, and recipients are fixed in
  server-side configuration.
- Email content is escaped, and only validated HTTP(S) source links are rendered.
