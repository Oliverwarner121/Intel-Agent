# Intel-Agent project instructions

## Scope and status

- Intel-Agent is a personal, configuration-driven briefing platform. V1 implements only the morning email; additional briefings remain future work.
- Phase 1 (foundation) exists: registry, orchestrator, date/HTTP/logger utilities, env validation and the protected Cron route. Phase 2 adds the Google Calendar provider (`src/services/providers/calendar`, OAuth helper `npm run google:auth`). Email, weather and news providers are not implemented yet. Inspect the repository before changes; do not assume proposed paths exist.
- Deployment and live email sends require the owner's explicit approval. Only `APP_ENV=prod` may send.
- GitHub Actions deploys `main` to `intel-agent-dev` via GitHub environment `development`; manual releases select a successful dev run's source commit for `intel-agent-prod` via `production`. Both are Vercel Production targets, so use an explicit application environment guard, not `VERCEL_ENV`, to distinguish them. Remove Cron from dev and disable automatic Vercel Git deployments.
- V1 has no LLM, AI-generated summaries or introductions. Display verified calendar and weather data plus selected news headlines, publishers, publication times and source links.

## Architecture and stack

- Use Next.js App Router, strict TypeScript, Node.js server integrations, Zod, Vitest and ESLint once the application is established.
- Keep routes thin: scheduler -> generic briefing orchestrator -> providers -> deterministic processing -> email renderer -> delivery.
- Use validated TypeScript briefing definitions and a simple registry. Keep provider-specific responses internal and return shared domain types.
- Use ordinary functions and explicit dependencies, not a workflow engine or dependency-injection container.
- Do not add a database, Redis, queues, microservices, Docker, Kubernetes or AWS to V1.
- Reuse providers and delivery across briefing types. Do not create a standalone integration script for each briefing.

## Correctness and safety

- Use strict types; no `any` or unchecked casts. Validate external payloads at provider boundaries.
- Keep secrets and integrations server-side. Never commit credentials or log tokens, full private calendar details or raw sensitive responses.
- Authenticate scheduled and manual triggers. Keep recipients configured server-side; do not accept arbitrary delivery addresses.
- Distinguish empty results from failed retrieval. Preserve successful sections after independent provider failures and explicitly report unavailable data.
- Bound requests with timeouts and limited transient-error retries. Never blindly retry email sends or bypass idempotency conflicts.
- Use escaped text and validated HTTP(S) source links. Only fetch configured, approved sources; verify permissions as well as endpoint availability.
- Do not introduce paid services without explaining costs and obtaining approval.

## Morning briefing constraints

- Preserve section order: Today's Calendar, Weather, Worldwide Tech and AI, UK Politics and Finance, Global Affairs.
- Weather locations are Wheatley (Oxford), Wotton-under-Edge and Lower Earley. Verify coordinates before storing them; do not geocode daily.
- Select at most three news stories per category, normally from the preceding 24 hours. Preserve original timestamps and label any older exceptions.
- Use `Europe/London` for reporting dates and displayed times. Compute consecutive local midnights; DST days are not always 24 hours.
- The agreed Hobby schedule is `0 5 * * *` UTC: invocation around 05:00-05:59 GMT or 06:00-06:59 BST. Arrival before 07:00 UK is not guaranteed.
- Use stable delivery keys per briefing, UK reporting date and recipient. Resend's documented retention is 24 hours; no database means no durable exactly-once or catch-up guarantee.

## Verification and documentation

- Make focused changes and preserve unrelated work. Follow actual repository scripts and conventions as they are introduced.
- Test changed behaviour with mocked external APIs; automated tests must never send real emails.
- Distinguish implemented, mock-tested, live-verified and deployed. Never claim provider acceptance proves inbox delivery.
- Update directly related setup and operation documentation. Add environment examples only for variables actually required.
- Use the matching workflow in [skills](./skills/) for adding briefings/providers, verifying integrations, testing or production readiness.

## Next.js version

This version of Next.js has breaking changes: APIs, conventions and file structure may differ from what you expect. Read the relevant guide in `node_modules/next/dist/docs/` before writing Next.js code, and heed deprecation notices.
