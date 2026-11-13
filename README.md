# Intel-Agent

A personal, configuration-driven platform that emails a daily briefing: a
calendar overview, local weather and a handful of selected news headlines.

> This is a personal project, shared publicly to show how it is built. It is not
> packaged for others to deploy, and setup instructions are intentionally not
> provided.

## What it does

The first briefing is a morning email with these sections, in order:

1. **Today's Calendar** – events from Google Calendar for the current day.
2. **Weather** – forecasts for a few fixed locations, plus UK Met Office warnings.
3. **Worldwide Tech and AI**, **UK Politics and Finance** and **Global Affairs** –
   up to three recent headlines per category, with publisher, publication time
   and a link to the original source.

A markets section also exists in the code but is optional and disabled by default.

There is no AI-generated content. The email shows data from the providers and
selected headlines only. Each section is collected independently, so if one
source fails the rest of the email is still sent and the gap is clearly marked.
All times use the `Europe/London` timezone, including across GMT/BST changes.

## How it works

```
Scheduler → briefing orchestrator → data providers → deterministic processing → email renderer → delivery
```

- **Briefing definitions** are validated TypeScript objects held in a simple registry.
- **Providers** wrap each external service and return shared domain types:
  Google Calendar, Open-Meteo, Met Office warnings, GNews and Twelve Data.
- **News selection** is deterministic: no model decides what is shown.
- **Delivery** goes through Resend, with a stable delivery key per briefing,
  date and recipient so a run is not delivered twice.
- **Scheduling** uses a Vercel Cron job that calls a protected route.

## Tech stack

Next.js (App Router), strict TypeScript, Node.js, Zod for validating external
data, Vitest and ESLint. All external services are mocked in the test suite,
which never sends real email.

## Security notes

- All credentials are held server-side and are not committed to the repository.
- Scheduled and manual triggers are authenticated, and recipients are fixed in
  server-side configuration.
- Email content is escaped, and only validated HTTP(S) source links are rendered.

## Status

Under active, personal development. It is built for one user's needs and is
not production-ready software for general use.
