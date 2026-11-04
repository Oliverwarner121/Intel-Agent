# Intel-Agent
Daily agent emails you desired information for the day

## Project status

Phase 1 (foundation) is implemented and mock-tested; nothing is deployed yet.
V1 will deliver a morning email with calendar data, weather and selected news
headlines with source links. It will not use an LLM or generated summaries.

Implemented:

- Next.js App Router app with strict TypeScript, ESLint, Vitest and Zod.
- Briefing definition schema and registry with the `morning-briefing`
  definition (section order, news limits, `Europe/London` timezone and the
  `0 5 * * *` UTC schedule, kept in sync with [vercel.json](vercel.json) by tests).
- Generic orchestrator: concurrent section collection, per-section timeouts,
  isolated provider failures (empty vs unavailable), preview/send modes and a
  single delivery attempt per run.
- Protected Cron route `GET /api/cron/morning-briefing` (Bearer `CRON_SECRET`),
  returning only a safe run summary.
- GMT/BST-aware date utilities, bounded-retry JSON HTTP helper, structured
  logger and request-time environment validation.

Not yet implemented: Google Calendar, Resend email, Open-Meteo weather and news
providers (Phases 2–5). Until then every section reports "not configured" and
no email is sent.

## Local development

Requires Node.js 24.

```sh
npm ci
cp .env.example .env.local   # set CRON_SECRET (openssl rand -hex 32)
npm run dev
curl -H "Authorization: Bearer <CRON_SECRET>" http://localhost:3000/api/cron/morning-briefing
```

Checks: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.
Only `APP_ENV=prod` may send email; `local` and `dev` always run as previews.
Tests mock all external services and never send email.

## Copilot customisations

Project-wide conventions are in
[copilot-instructions.md](.github/copilot-instructions.md).
The initial reusable workflows are:

- [Add a briefing](.github/skills/add-briefing/SKILL.md)
- [Add a data provider](.github/skills/add-data-provider/SKILL.md)
- [Verify an external integration](.github/skills/verify-external-integration/SKILL.md)
- [Test a briefing](.github/skills/test-briefing/SKILL.md)
- [Production readiness](.github/skills/production-readiness/SKILL.md)

These customisations do not implement integrations or authorise deployment and
live email sends.

## GitHub Actions deployment pipeline

[Validate and deploy](.github/workflows/validate-and-deploy.yml) follows the
GetActive release pattern, using Vercel instead of AWS:

1. Pull requests to `main` run validation without deployment secrets.
2. Pushes to `main` (including merged PRs) validate and automatically deploy dev.
3. Production is manual: run the workflow from `main`, select
   `promote-production` and enter a successful development workflow run ID.
4. The workflow verifies that the selected run belongs to this workflow, ran
   from `main`, succeeded and actually deployed development. Production rebuilds
   that exact source commit with its own configuration, not the latest `main`
   or the development build's secrets.

### Environment setup

Create these GitHub environments and Vercel projects:

| GitHub environment | Vercel project |
| --- | --- |
| `dev` | `intel-agent-dev` |
| `prod` | `intel-agent-prod` |

In **each GitHub environment**, configure environment secrets:

- `VERCEL_TOKEN`: a Vercel deployment token.
- `VERCEL_ORG_ID`: the project's owning account/team ID.
- `VERCEL_PROJECT_ID`: that environment's project ID. Dev and prod must reference
  different projects.

Configure environment deployment branch restrictions to allow only `main`.
Where your GitHub plan/repository visibility supports required reviewers, add
them to `prod` for an additional approval gate. The workflow itself always
requires manual dispatch for production.

Store application secrets in each **Vercel project's Production environment**,
not in workflow YAML. Both projects use Vercel's `--prod` deployment target for
stable project domains; GitHub `dev` does not mean Vercel Preview.
Use separate dev credentials and a safe test recipient. When the application is
implemented, require an explicit application setting such as `APP_ENV=dev` or
`APP_ENV=prod` to guard scheduled sending: `VERCEL_ENV` is `production` in both
projects and cannot distinguish them.

Disable Vercel's automatic Git deployments in **both projects before connecting
or releasing**. The committed [Vercel configuration](vercel.json) also disables
them, so Git pushes must not bypass the manual production gate.
The deployment helper removes `crons` from the dev deployment configuration and
preserves them for prod, so only `intel-agent-prod` runs the morning Cron job.

Set these **Production** environment variables in each Vercel project:

| Variable | `intel-agent-dev` | `intel-agent-prod` |
| --- | --- | --- |
| `APP_ENV` | `dev` | `prod` |
| `CRON_SECRET` | random, `openssl rand -hex 32` | a different random value |

If you create the projects in the Vercel dashboard (which requires importing
the repository), disconnect the Git repository afterwards under **Settings →
Git** so only GitHub Actions deploys. Project and org IDs are under
**Settings → General**; the org/team ID is under your account or team
**Settings**.

### Enabling deployments

Deployments are off by default. Until there is an application package manifest,
CI runs only the workflow helper tests and explicitly reports that application
validation and deployment were not performed.

After the approved foundation provides `package.json`, `package-lock.json` and
the `lint`, `typecheck`, `test` (non-watch) and `build` npm scripts, application
checks run automatically. They must build without production secrets.
Then finish environment setup and set repository variable
`DEPLOY_ENABLED=true` to enable deployments. Enabling it before scaffolding
fails validation rather than deploying a placeholder.

For an initial dev deployment, run `deploy-development` manually from `main` or
merge a PR. Test the resulting dev application before selecting that run ID for
production. A green repository-only run or a previous production run cannot be
promoted. The selected commit must already contain the pipeline and application
foundation; changing Vercel environment values can change the rebuilt output.

The CLI is pinned to `65.11.0`; GitHub actions are pinned to commit SHAs.
Workflow helper tests can run locally without application dependencies:

```sh
node --test .github/scripts/*.test.cjs
```

The pipeline has not been executed on GitHub or deployed to Vercel yet. Vercel
acceptance is not evidence that calendar access, scheduled execution or email
receipt works. No AWS, Terraform or paid scheduling infrastructure is added.

## Weekly dependency updates

[Weekly dependency updates](.github/workflows/weekly-dependency-updates.yml)
follows the GetActive pattern instead of Dependabot version PRs. Every Monday at
05:00 UTC (or on manual dispatch) it:

1. Refreshes `package-lock.json` within existing ranges, bumps direct npm
   dependencies to their latest stable versions and runs `npm audit fix`. npm
   uses `--package-lock-only --ignore-scripts`, so no package code runs with the
   write token.
2. Holds back majors listed in `heldMajors` in
   [the update script](.github/scripts/weekly-dependency-update.cjs) and retries
   failed batches one package at a time.
3. Checks SHA-pinned GitHub Actions for newer non-major releases.
4. Force-pushes branch `deps/weekly` and opens or refreshes one PR labelled
   `dependencies`, with a summary table and production audit counts.
5. Never approves or merges. Merging the PR deploys dev like any other merge.

Until the application is scaffolded there is no `package.json`, so npm updates
are skipped and reported; only action pins are checked.

Setup:

- Enable **Settings → Actions → General → Allow GitHub Actions to create and
  approve pull requests**; otherwise the default token cannot open the PR.
- Optional: add repository secret `DEPENDENCY_UPDATE_TOKEN` (fine-grained token
  with contents, pull requests and workflows write). With it, action pins are
  updated automatically and PR checks run normally. Without it, action updates
  are listed for manual application and the workflow dispatches
  `validate-and-deploy.yml` on `deps/weekly`; that run validates only and cannot
  deploy because deployment requires `main`.
- The Vercel CLI version pinned inside the deploy workflow is not updated by
  this job; bump it by hand.
- Optionally keep Dependabot **security alerts** enabled in repository settings;
  they complement this weekly PR.

### Dependency report comment

[Dependency update report](.github/workflows/dependency-report.yml) posts one
informational comment on every PR to `main` and edits it on later pushes. It
lists root direct npm dependencies (including dev dependencies) whose locked
version is behind npm's latest stable release, with a GitHub advisory count for
each candidate version. Before the application is scaffolded it simply notes
that there is no `package.json`.

It uses `pull_request_target` so it can comment on PRs, but only checks out and
runs the trusted base-branch script; the PR's `package.json` and lockfile are
read as JSON data, never installed. It is `continue-on-error`, never blocks
deployment and must not be a required status check. Latest stable is not a
guarantee of safety or compatibility.
