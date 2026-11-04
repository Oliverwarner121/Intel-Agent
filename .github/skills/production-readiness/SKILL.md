---
name: production-readiness
description: "Use before deploying or enabling an Intel-Agent briefing or integration, or when checking release readiness. Verify build/tests, secrets, authenticated Cron, GMT/BST scheduling, provider permissions, safe email rendering, delivery safeguards and operational limits."
---

# Production readiness

This workflow assesses readiness; it does not authorise deployment, account changes or live email sends.

1. Inspect the worktree, package scripts, deployment configuration and README. Identify what is implemented versus planned. Missing application tooling is a blocker, not a passing check.
2. Run the actual lint, type-check, non-watch test and production-build scripts. Intended foundation scripts are `npm run lint`, `npm run typecheck`, `npm test` and `npm run build`; use these only after they exist. Do not install new tooling merely for this checklist.
3. Verify server-side Zod configuration, safe environment examples and ignored local secret files. Ensure no secrets or private calendar payloads appear in client bundles, route responses, logs or changed files.
4. Test Cron authentication and protected manual triggers. Sending must be restricted to the configured recipient. GitHub environments `development` and `production` target separate Vercel projects, both using `--prod`. Require an explicit application environment guard; `VERCEL_ENV=production` alone is insufficient. Confirm dev deployment configuration removes Cron, uses safe test credentials/recipient and cannot send scheduled production mail. Disable automatic Vercel Git deployments so they cannot bypass manual releases.
5. Verify the morning schedule `0 5 * * *` UTC and separate GMT/BST behaviour: around 05:00-05:59 GMT or 06:00-06:59 BST before processing/delivery latency. Do not promise arrival before 07:00 UK. Check local-midnight DST tests.
6. Check current Vercel plan eligibility, Cron limits, function duration and account-specific compute configuration. Bound the orchestration budget below the available function limit. Verify timeouts and retries cannot exceed it.
7. Follow verify-external-integration for each provider. Check OAuth publishing/refresh-token expiry, verified weather coordinates, news permissions/attribution, rate limits and API costs. No LLM or LLM credentials belong in V1.
8. Verify sender-domain authentication and recipient configuration. Inspect HTML and plain text using complete and partial fixtures; preserve morning ordering, escape external strings and validate links. Do not claim rendering tests prove iPhone or desktop-client compatibility.
9. Check URL-fetch policy, redirects and bounded payload parsing. Provider errors must not produce misleading empty calendars, invented weather, unsupported "no warnings" or fabricated news.
10. Verify stable per-briefing/date/recipient idempotency keys and identical-payload retries. Do not automatically change the key after a conflict. Document Resend's 24-hour retention and the absence of durable locks, execution history or automatic missed-run recovery.
11. Confirm structured logs include run ID, briefing ID, start/end/duration, successful/failed providers, selected-story count and email acceptance/failure status without private details. Do not require an AI success metric for this LLM-free V1.
12. Confirm README setup, deployment, failure recovery, scheduling, costs and extension guidance accurately describe current functionality. Report readiness as pass, fail or unverified for each applicable check.

Only deploy or perform an end-to-end send after explicit authorisation. Record actual deployment and inbox evidence separately; unresolved setup or failed checks prevent a completion claim.
