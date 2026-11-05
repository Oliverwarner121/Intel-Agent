# Intel-Agent
Daily agent emails you desired information for the day

## Project status

Phase 1 (foundation) is deployed to `intel-agent-dev` and `intel-agent-prod`.
Phase 2 (Google Calendar) is implemented and verified against a live calendar.
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
- Google Calendar provider (read-only OAuth refresh token): today's
  `Europe/London` events including all-day, multi-day and expanded recurring
  events and working locations; cancelled and declined events are skipped; all-day
  events are listed first, then timed events by start time.
- GMT/BST-aware date utilities, bounded-retry JSON HTTP helper, structured
  logger and request-time environment validation.

Phase 3 email rendering and Resend delivery are deployed and live-verified:
the owner confirmed receipt and layout of the first manually triggered email
on 5 November 2026. Production sending is enabled; scheduled receipt is not yet
verified. Code defaults to sending disabled in new environments.
Phase 4 Open-Meteo weather is implemented, mock-tested and live-verified locally
for all three locations, but not yet deployed. News (Phase 5) is not implemented
and reports unavailable. Missing provider credentials also report unavailable.

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

### Markets (Twelve Data)

Provider-independent market models, a section contract, orchestration and HTML/
plain-text rendering support Nvidia (`NVDA`), Apple (`AAPL`), Microsoft (`MSFT`),
Amazon (`AMZN`), Alphabet (`GOOGL`), Bitcoin, Ethereum and XRP. Stocks display USD;
Bitcoin and Ethereum display GBP; XRP displays USD because the official catalog
had no `XRP/GBP` pair on 5 November 2026. The owner approved `XRP/USD` instead.
The selected assets live in
[market-assets.ts](src/config/market-assets.ts).

The server-side Twelve Data adapter is implemented and mock-tested. Markets
defaults to disabled, so existing scheduled emails are unchanged. When enabled,
runtime wiring appends Markets after the original five sections without changing
the schedule, delivery guard or delivery key.

1. Obtain a free Basic API key from [Twelve Data](https://twelvedata.com/register).
2. Save `TWELVE_DATA_API_KEY` privately in `.env.local` and the dev project's
   server environment. Never use a `NEXT_PUBLIC_` variable or share the key.
3. Set `MARKETS_ENABLED=true` in local/dev to include the section. Missing keys
   fail configuration validation. A key alone does not enable the section.
4. Keep production `MARKETS_ENABLED=false` or absent until an approved promotion.
   Restart local development or redeploy dev after environment changes.

Each run makes eight `/quote` requests concurrently with six-second timeouts,
16 KiB response limits, no caching and **no automatic retries**. Each symbol
costs one credit; all eight consume Basic's eight-credit minute allowance.
Wait at least a minute before another manual preview and avoid other requests
using the same key during that period. Rate-limit errors are explicitly
unavailable, not bypassed. No WebSocket or paid features are used.

Stocks request `eod=true`, daily quotes on `XNGS` (Nasdaq Global Select, verified
for all five symbols in the official catalog), and display the latest
completed closing price, not an index level or today's intraday quote. Percentage
movement is computed from `close` and `previous_close`. Crypto requests daily
quotes and uses `rolling_1d_change` for an actual rolling 24-hour movement;
it does not relabel daily-candle movement as 24-hour change. Stock currency,
MIC, all symbols, numeric fields and `last_quote_at` are validated. Missing
last-quote timestamps make a quote unavailable; candle-opening `timestamp` is
never presented as the price observation time. Source exchange names are shown.
These are provider quotes, not a guaranteed consolidated exchange-wide feed.

Snapshots carry source links, timestamps, closing-price/last-trade labels,
explicit stale flags and optional changes labelled either versus the previous
close or over 24 hours. Missing changes are unavailable, not zero. Asset failures
preserve successful snapshots and mark the section partial; missing assets are
reported unavailable. Summaries contain counts/statuses, not prices. Stocks
older than seven days and crypto older than fifteen minutes are labelled stale;
these are age thresholds, not a full exchange-holiday calendar. Weekend stock
closes remain dated and are not represented as live prices.

The owner confirmed provider permission for API retrieval and displaying these
prices in a private daily email on Basic on 5 November 2026. Retain that approval;
the general plan-description text alone is not that permission. Twelve Data's
[Basic plan](https://twelvedata.com/pricing) lists internal non-display usage. An
attribution exemption or successful API request does not itself establish
display rights. Reassess licensing before adding recipients, public display or
commercial use. Source links credit Twelve Data beside each quote.
The public catalog confirmed `BTC/GBP`, `ETH/GBP` and `XRP/USD`; this does not
prove account quote access. On 5 November 2026 at 13:19 UTC, an authorised local
call through the actual adapter validated all eight quotes and their change
fields using the owner's Basic key. Stocks returned the 4 November close
(last-minute candle timestamp 20:59 UTC); crypto returned 5 November 13:19 UTC
observations with rolling 24-hour changes. All passed the freshness thresholds.
An initial stock check returned 404 with the general Nasdaq MIC `XNAS`; the
catalog-confirmed `XNGS` filter resolved it. This is live adapter verification,
not evidence of deployment or inbox rendering. No email was sent by the check.
No paid subscription or production rollout is approved.

### Weather (Open-Meteo)

No API key or extra environment variables are needed. The provider is registered
as `open-meteo`, and uses the briefing's London reporting date as both
`start_date` and `end_date`. It requests daily WMO conditions, minimum/maximum
temperature in Celsius, maximum precipitation probability and maximum wind
speed in km/h. Precipitation probability is not a prediction of rainfall amount
and includes precipitation other than rain.

Coordinates are fixed in [weather-locations.ts](src/config/weather-locations.ts);
there is no daily geocoding. Verified on 5 November 2026 through the
[Open-Meteo geocoding API](https://open-meteo.com/en/docs/geocoding-api)
(GeoNames place IDs):

| Location | Latitude | Longitude | Identity |
| --- | --- | --- | --- |
| Wheatley (Oxford) | 51.74731 | -1.13936 | 2634171; Oxfordshire, South Oxfordshire |
| Wotton-under-Edge | 51.63242 | -2.34512 | 2633511; Gloucestershire, Stroud |
| Lower Earley | 51.42708 | -0.91979 | 7290015; Wokingham, Earley |

Locations are fetched concurrently in configured order, with a 6-second
timeout per attempt, at most one transient retry and a 32 KiB response limit.
Three daily forecast calls normally suffice (up to six with retries), plus
two regional warning requests described below. The provider
validates dates, units, array lengths, WMO codes and numeric ranges. Optional
null measurements are labelled unavailable, not replaced by zero.

A location failure preserves the other forecasts. The weather outcome becomes
`partial`, the run reports `completed-with-gaps`, and safe summaries include
location statuses plus the count of successful forecasts. If every location
fails, the section reports unavailable with location-specific reasons.
Public forecast values were live-validated through the actual provider for all
three locations on 5 November 2026; this is not evidence of deployed weather
or email rendering in an inbox.

### Met Office regional warnings

The weather provider also reads the official
[Met Office warning RSS feeds](https://weather.metoffice.gov.uk/guides/rss):

| Feed region | Locations |
| --- | --- |
| London & South East England (`se`) | Wheatley (Oxford), Lower Earley |
| South West England (`sw`) | Wotton-under-Edge |

Two public requests are made per briefing, concurrently with forecasts, with
6-second attempt timeouts, at most one transient retry and 128 KiB XML limits.
No API key is needed. Feeds are allowlisted and XML/schema validated; documents
with DTDs/entities, unexpected regions, invalid publication dates or non-Met
Office warning links are rejected.

These are **regional feed listings, not town-level or polygon matches**.
The email preserves warning titles (including severity/hazard when provided),
publication times and direct official links. All listed entries are shown,
including warnings for future days; consult the linked warning for validity
and affected areas. Titles are not rewritten and warning areas/times are not
inferred by scraping the website. A region is displayed once per email, with
an explicit note that its warning may not affect the exact location.

A validated empty feed displays "No warnings listed in this regional feed"
with its check time, not a blanket claim that the town is safe or warning-free.
Feeds can lag official updates, and an email is a point-in-time snapshot.
Failed or malformed retrieval displays "Warnings unavailable" and marks weather
partial while retaining forecasts and any successful region. Successful warning
listings survive forecast failures as well.

The Met Office [RSS usage guidance](https://weather.metoffice.gov.uk/guides/rss)
permits display with attribution and direct content links, subject to its
[website terms](https://www.metoffice.gov.uk/policies/tandc). The email attributes
the Met Office and includes the Open Government Licence v3.0 statement/link.
This integration uses the published RSS feeds, not undocumented web services.
Both live regional feeds were successfully parsed on 5 November 2026 and
contained zero entries. Non-empty warning parsing/rendering is mock-tested,
not yet live-verified. Official geographic boundaries are not supplied by this
RSS integration.

The free API permits this personal non-commercial use under the
[Open-Meteo terms](https://open-meteo.com/en/terms) (fewer than 10,000 calls/day,
5,000/hour and 600/minute; shared Vercel IPs can hit limits sooner).
Weather rows include [Open-Meteo attribution](https://open-meteo.com/), the
[CC BY 4.0 licence](https://creativecommons.org/licenses/by/4.0/) and a note
that daily codes were converted to condition text. Commercial use would require
reviewing the provider's paid plans first.

Roll out via the normal dev-to-prod pipeline. Production email is already
enabled: promoting weather enables its inclusion in the next scheduled email.
Do not rerun today's email merely to inspect the new weather payload; today's
stable delivery key may conflict with a previously accepted email. Never change
that key to bypass the conflict. Validate weather in preview before promotion,
and verify the next scheduled email separately.

### Resend email setup

The website domains are `intel-dev.oliverwarner.co.uk` (dev) and
`intel.oliverwarner.co.uk` (prod). The separate sending domain is
`intel-mail.oliverwarner.co.uk`.

1. Verify the sending domain in Resend using its DNS records (Vercel DNS can
   be configured through Resend's integration). Enable sending, not receiving.
   Leave open/click tracking off.
2. Create a Sending-access API key restricted to that domain and save it in a
   password manager. Do not commit it or paste it into chat.
3. Add these variables to `intel-agent-prod`, scoped to Vercel **Production**:

   | Variable | Value |
   | --- | --- |
   | `RESEND_API_KEY` | Restricted key; mark Sensitive |
   | `EMAIL_FROM` | `Intel-Agent <agent@intel-mail.oliverwarner.co.uk>` |
   | `EMAIL_TO` | `oliver.warner121@gmail.com` |
   | `EMAIL_SEND_ENABLED` | `false` until an explicitly approved send |

   Dashboard values have no surrounding quotes. In `.env.local`, quote
   `EMAIL_FROM` as shown in [.env.example](.env.example).
4. Merge and validate dev's preview behaviour before promoting the same source
   commit. Dev/local cannot send, even if the send switch is accidentally true.
   They do not need a Resend key. The send switch being absent means disabled.
5. Only after the owner's approval, set `EMAIL_SEND_ENABLED=true` in prod and
   deploy through GitHub Actions. This enables manual **and scheduled** sends:
   the daily Cron is not paused by this switch once true. Coordinate the
   first test with the schedule, and check the inbox and spam folder.

The sender does not need a mailbox, but receiving replies requires separate
configuration. Calendar text is escaped and formatted in Europe/London; email
contains both HTML and plain text and explicitly marks unavailable sections.
Private email/calendar content passes through Resend and the recipient's email
provider; do not log rendered messages or API credentials.

Resend acceptance returns a message ID, not proof of inbox receipt. Failure
returns a safe error and is never automatically retried, including timeouts,
rate limits or ambiguous responses. Check Resend before considering another
attempt. Delivery keys use briefing ID, UK reporting date and a recipient hash,
not a run ID. Resend retains keys for 24 hours: repeated identical requests are
deduplicated, but a changed payload with the same key may conflict. Never
bypass that conflict with a new key. Without durable storage there is no
exactly-once, catch-up or cross-deployment replay guarantee.

### Google Calendar setup

1. In [Google Cloud Console](https://console.cloud.google.com/), create a
   project and enable the **Google Calendar API**.
2. Under **Google Auth Platform**, configure the consent screen with audience
   **External**, then **publish the app** (In production). Apps left in
   *Testing* get refresh tokens that expire after 7 days. Publishing an External
   app requires an app name, support email, home page
   (`https://intel-agent-prod.vercel.app`) and privacy policy link
   (`https://intel-agent-prod.vercel.app/privacy`) under **Branding**; leave the
   logo empty to avoid verification. Unverified personal use is fine; Google
   shows an "unverified app" warning (choose **Advanced → Go to Intel-Agent**).
3. Create an OAuth client of type **Desktop app** (leave "AI-powered agent"
   unticked) and copy its ID and secret
   into `.env.local` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
4. Run `npm run google:auth`, open the printed link, sign in and grant
   read-only calendar access. The script verifies access and saves
   `GOOGLE_REFRESH_TOKEN` to `.env.local`. On a remote shell where the browser
   cannot reach the callback, paste the final browser address into the terminal.
5. Add the three values to both Vercel projects (Production, Sensitive).

If the token is revoked or expires, the calendar section reports "Google
authorisation failed" and the rest of the briefing continues; rerun step 4.

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
| `development` | `intel-agent-dev` |
| `production` | `intel-agent-prod` |

In **each GitHub environment**, configure environment secrets:

- `VERCEL_TOKEN`: a Vercel token, ideally scoped to that environment's project.
- `VERCEL_ORG_ID`: the project's owning account/team ID.
- `VERCEL_PROJECT_ID`: that environment's project ID. Dev and prod must reference
  different projects.

Configure environment deployment branch restrictions to allow only `main`.
Where your GitHub plan/repository visibility supports required reviewers, add
them to `production` for an additional approval gate. The workflow itself always
requires manual dispatch for production.

Store application secrets in each **Vercel project's Production environment**,
not in workflow YAML. Both projects use Vercel's `--prod` deployment target for
stable project domains; GitHub `development` does not mean Vercel Preview.
Use separate dev credentials and a safe test recipient. When the application is
implemented, require an explicit application setting such as `APP_ENV=dev` or
`APP_ENV=prod` to guard scheduled sending: `VERCEL_ENV` is `production` in both
projects and cannot distinguish them.

The committed [Vercel configuration](vercel.json) sets
`git.deploymentEnabled: false`, so the projects can stay connected to the
repository without Git pushes deploying and bypassing the manual production
gate. Branches created before that file existed are not covered.
The deployment helper removes `crons` from the dev deployment configuration and
preserves them for prod, so only `intel-agent-prod` runs the morning Cron job.

Set these **Production** environment variables in each Vercel project:

| Variable | `intel-agent-dev` | `intel-agent-prod` |
| --- | --- | --- |
| `APP_ENV` | `dev` | `prod` |
| `CRON_SECRET` | random, `openssl rand -hex 32` | a different random value |
| `GOOGLE_CLIENT_ID` | OAuth client ID | same |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret | same |
| `GOOGLE_REFRESH_TOKEN` | from `npm run google:auth` | same |
| `GOOGLE_CALENDAR_ID` | optional, defaults to `primary` | same |

Projects can be created in the Vercel dashboard by importing the repository
(Next.js preset; variables scoped to Production). The first import builds once;
after that only GitHub Actions deploys. Project IDs are under the project's
**Settings → General**; the team ID is under the team's **Settings → General**;
tokens are under **Account Settings → Tokens**.

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
