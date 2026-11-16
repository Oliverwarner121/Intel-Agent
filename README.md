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

## Email appearance

The iPhone-first email uses an illuminated coding wallpaper, translucent panels,
layered reflective rims, rounded controls and Apple system typography. The
material is inspired by the references at
[Liquid Glass Design](https://liquidglassdesign.com/) and
[Apple's Liquid Glass overview](https://developer.apple.com/documentation/technologyoverviews/liquid-glass),
with denser content panels following
[Apple's material guidance](https://developer.apple.com/design/human-interface-guidelines/materials).
The binary wallpaper is original, embedded decoration: no remote images or fonts
are loaded.

This is an email-safe interpretation, not native Liquid Glass. Clients that
support the CSS enhancements show translucency, blur and static edge reflections;
other clients retain solid navy panels with readable inline text colours.
Native refraction, fluid morphing and interactive web lenses are not available
in email; the design does not load JavaScript or imitate those behaviours.
Clients may omit the decorative wallpaper. Reduced-transparency and
increased-contrast preferences disable the glass and wallpaper where supported.
Content, source links, calendar colours and the plain-text version are preserved.

Use `npm run email:preview` to generate a private local HTML preview without
sending an email. Browser previews do not prove identical rendering in Apple
Mail, Gmail or Outlook; check the delivered email on the target device before
considering its appearance verified there.

### Expandable content

In supporting clients such as Apple Mail, Wotton-under-Edge and Lower Earley
start collapsed; Wheatley (Oxford) and the calendar stay fully visible. Each
news headline expands to its publisher excerpt, source, publication time and
link. Market cards initially show the asset name and price; expanding reveals
the daily statistics and range graphic. Stale prices remain labelled even when
collapsed. Weather warnings and unavailable locations/assets remain visible.
Each expandable heading has a right-aligned 44px plus control, changing to minus
when open; the whole heading is also a tap target.

The controls use labelled checkboxes and CSS, without JavaScript, forms or
additional requests. Clients that strip the inputs or interactive CSS show
the full content instead; Gmail and Outlook behaviour can differ from Apple
Mail. The plain-text email always includes all details. Compatibility references:
[checkboxes](https://www.caniemail.com/features/html-input-checkbox/) and
[checked-state selectors](https://www.caniemail.com/features/css-pseudo-class-checked/).
Actual iPhone Mail interaction still needs verification on a delivered email.

## Daily market cards

When Markets is enabled, each asset has a card instead of a comparison-table row.
Stocks use Twelve Data's `eod=true` quote for the last completed trading session,
which can be several calendar days ago after weekends or holidays. Cards show
the close, percentage and monetary change from the previous close, open, high,
low, volume and the source timestamp where supplied. Missing statistics are
explicitly unavailable, never zero-filled.

The low/high graphic marks the price's position inside the quoted daily range;
it is not an intraday price path. Flat sessions are labelled without inventing
a percentage position. Green/red movement colours indicate gains/losses versus
the previous close (or the existing 24-hour change for crypto).
Crypto's quoted daily-bar range is labelled separately from its rolling
24-hour percentage change. No weekly or annual history is fetched.

These fields come from the existing eight `/quote` requests: no chart service,
extra API calls or historical-price endpoint is added. Basic's documented limits
are eight credits per minute and 800 per day; previews also consume credits.
Set `MARKETS_ENABLED=true` and `TWELVE_DATA_API_KEY` in each intended environment.
Only enable email display when your account/agreement permits it: the published
Basic plan lists non-display use, so API access alone is not display permission.
See the [quote documentation](https://twelvedata.com/docs/market-data/quote) and
[current plan terms](https://twelvedata.com/pricing).

## Career and AI engineering intel (opt-in)

Set `CAREER_INTEL_ENABLED=true` to append **New Engineering Jobs** and
**AI Engineering Updates** after the existing sections (and Markets when enabled).
Jobicy and GitHub releases require no new keys; optional Reed hybrid coverage
requires `REED_API_KEY`. No paid service or LLM has been added.
It is disabled by default; deployment and email sending still require approval.
For a local, no-send preview:

```sh
CAREER_INTEL_ENABLED=true npm run email:preview
```

### Jobs: UK remote and Reed hybrid coverage

- Two groups: **Hybrid — Camberley / London / Brighton / Crawley / Woking / Guildford**,
  and **Fully Remote — UK**. Searches use a 20-mile radius around each hybrid
  centre as a default, with overlapping areas covering the London–Brighton
  corridor. Location/radius coverage is source-reported, not independently
  geocoded or a guarantee of commute time. Centres and radius are maintained in
  [job-search.ts](src/config/job-search.ts).
- Set `REED_API_KEY` in the ignored local environment file and, after deployment
  approval, the relevant Vercel server environment. A blank/missing key reports
  hybrid coverage unavailable without preventing remote jobs. The key is used
  only as the username in Basic authentication to fixed HTTPS Reed endpoints,
  with an empty password; redirects are rejected. Never put it in client-side
  variables or paste it into chat.
- The [Reed Jobseeker API](https://www.reed.co.uk/developers/jobseeker) provides
  location searches and full advert details. Reed's
  [Content Rights terms](https://www.reed.co.uk/policies#termsConditions)
  permit copying for private/domestic purposes. This adapter is for this owner's
  personal email, **not** a public newsletter or commercial redistribution.
  Keep Reed attribution and original Reed job links. Public API documentation
  does not specify account quotas or guarantee ongoing API pricing: check the
  terms supplied with your key; do not assume unlimited free access.
- **Approved Reed freshness exception:** both search `date` and detail
  `datePosted` are calendar dates (`DD/MM/YYYY`), not timestamps. Include only
  the source's dates matching today or yesterday in the London reporting
  calendar, explicitly labelled "date only; posting time unavailable".
  Store these as `publishedDate`; never fabricate midnight in `publishedAt`.
  This may include jobs older than 24 hours, and cannot establish the hour,
  source timezone or current-day publication time. Jobicy keeps its exact
  rolling-24-hour filter. Expiry dates before the reporting date are excluded.
- Reed searches `hybrid engineer` and `hybrid developer`, up to 50 results for
  each query per centre, with no undocumented
  filter or sorting parameters. Deduplicate IDs, preselect engineering titles
  by seniority/keyword evidence, then verify at most ten full adverts in batches
  of five. Search snippets alone do not establish hybrid working or a match.
  Require explicit hybrid-working evidence and reject negated hybrid,
  fully-remote/fully-on-site, junior and leadership roles. "Hybrid cloud" alone
  does not establish hybrid working. Confirm the employer's actual arrangement
  through the original advert.
- At most twelve search plus ten detail requests per run, six seconds/request,
  no immediate retries, 1 MiB/response, and a 17-second overall Reed budget.
  The scan is deliberately bounded, not exhaustive. Successful adverts/locations
  survive independent failures with an explicit incomplete-coverage notice.
  A failing Reed source does not discard Jobicy results, or vice versa.
- The free [Jobicy API](https://jobicy.com/jobs-rss-feed) supplies remote roles.
  Its published fair-use terms explicitly permit newsletters with Jobicy
  attribution and links to the original Jobicy job pages. The integration never
  sends a paid Bearer key or requests direct ATS links.
- Requests use the verified `geo=uk` and `industry=engineering` slugs.
  Only listings explicitly including UK eligibility and "fully remote" or
  "100% remote" wording are retained; "Anywhere",
  Europe-only and ambiguous office/hybrid requirements are not treated as UK
  fully remote jobs. If an advert has a structured `| location | Remote` title,
  that location must also explicitly say UK/United Kingdom; broad source tags do
  not override country-specific advert titles. Eligibility and working arrangements are source-reported,
  not independently guaranteed. Employer incorporation in the UK is not verified.
- Engineering/developer roles must match **at least one** configured technology
  or role keyword in the title or description: TypeScript, Cloud, AWS
  (including Amazon Web Services), Azure, React, Node.js, CI/CD pipelines,
  Terraform, platform engineering, AI engineering, full stack, frontend,
  backend, AI agents or agentic workflows. Recognise common variants such as
  Node JS/NodeJS, CI/ CD/continuous integration/delivery/deployment,
  full-stack, front-end/back-end and contextual FE/BE abbreviations.
  Python alone and generic Software Engineer titles without a keyword match
  do not qualify; Python roles may still qualify through another listed match.
  Prioritise
  explicit mid-level/intermediate roles (including Engineer II), then roles
  without a stated level, then senior roles labelled as stretch opportunities.
  Within each level, rank by matched technologies, publication date and stable ID.
  When date-only jobs are mixed with timed jobs, compare London calendar dates
  consistently rather than inventing time ordering; timed-only results retain
  precise recency ordering.
  Exclude junior/graduate/entry-level, intern/apprentice/trainee and
  lead/staff/principal/management roles using the advert title and Jobicy's
  optional `jobLevel`. Explicit excluded levels override other labels; a senior
  label overrides mid-level if the source and title conflict. These are
  deterministic source/title classifications, not an assessment of suitability
  or years of experience. Deduplicate company/title and listing ID.
- The locally mirrored profile targets Software Engineer and related engineering
  roles, permanent and full-time, with an advertised annual GBP minimum of
  **GBP 48,000** and no upper salary cap. Apply this to both Reed hybrid and
  Jobicy UK remote jobs; this does not link to or sync the Reed account.
  For annual GBP ranges, the advertised lower bound must reach the minimum
  (GBP 45,000–55,000 is excluded; GBP 48,000–55,000 qualifies).
  An upper-bound-only salary below the floor is excluded; an upper bound reaching
  it remains eligible with the minimum unconfirmed. Undisclosed salaries,
  non-GBP amounts and non-annual periods remain eligible with an explicit
  unconfirmed salary-fit label; do not convert currencies or invent annual pay.
  Zero-only bounds count as undisclosed.
  Use the providers' structured employment types: exclude explicit contract,
  temporary, fixed-term, freelance, part-time and other incompatible types.
  Confirm permanent and full-time separately; full-time alone does not establish
  permanence. Missing/unrecognised types remain eligible and visibly unconfirmed.
  Check the original advert for details not captured by these fields.
  Do not set restrictive Reed salary/employment search parameters that could
  remove the approved unconfirmed listings before detail checks.
  The existing engineering-title and technology rules approximate the IT role
  preference; the public Reed API does not expose the account's IT & Telecoms
  sector filter or personalised recommendations.
- Up to ten matches total across both groups, selected together before grouping.
  The email shows only a small source-window caption; operational details remain
  documented here. Unavailable/incomplete coverage warnings stay visible.
  Jobicy uses original publication timestamps within the preceding rolling
  24 hours, while Reed uses the approved today/yesterday exception above.
  Jobicy delays new listings by three hours, so
  the newest three hours are normally absent. Do not fill quiet days with older
  roles or invent missing salaries. Supplied salary currencies and periods are
  retained; incomplete salary information is labelled undisclosed.
- Jobicy scans at most two pages of 100 jobs, with an explicit notice if the scan is
  truncated. Requests have a six-second timeout, no retries and a 4 MiB response
  cap per page. Do not repeatedly regenerate live previews. Start automated
  synchronisation passes no more than hourly, per Jobicy's fair-use guidance.
  **Before production enablement**, agree a non-zero Cron minute: Jobicy asks
  integrations to avoid minute 00, whereas the currently approved Cron is
  `0 5 * * *`. It is unchanged in this branch; an offset needs owner approval.
  Vercel Hobby's hourly invocation precision also means an exact minute cannot
  be guaranteed.
- Unavailable or incomplete source coverage makes the run `completed-with-gaps`;
  it does not prevent delivery of successful sections. Empty or unselected
  groups are distinct from a retrieval failure. Missing salary period/currency
  or zero-only Reed bounds are not fabricated into an annual salary.

Free jobs API research (official sources checked 16 November 2026):

| Source | Finding | Decision |
| --- | --- | --- |
| [Jobicy](https://jobicy.com/jobs-rss-feed) | No key; newsletters explicitly allowed with attribution; remote-only; three-hour delay | Implemented for UK remote |
| [Remotive](https://remotive.com/remote-jobs/api) | Source links/attribution required; public jobs delayed 24 hours | Does not meet the fresh last-24-hour requirement |
| [Adzuna](https://developer.adzuna.com/docs/terms_of_service) | Personal search permitted, but the free key is described as evaluation access; ongoing limits/plans are account-specific | Not assumed to be a permanently free production source |
| [Reed](https://www.reed.co.uk/developers/jobseeker) | Key-authenticated UK search/details; private/domestic copying permitted; date-only postings | Implemented for personal hybrid searches with the approved date-window exception; account limits/pricing must be checked |
| [Arbeitnow UK](https://www.arbeitnow.co.uk/terms) | UK API exists; API terms require a backlink, alongside restrictive general reuse terms | Email redistribution permission remains unresolved; not integrated |

### AI Engineering Updates: official GitHub releases

The initial allowlist is VS Code, Claude Code, OpenAI Agents SDK for Python,
LangGraph, CrewAI and PydanticAI. Fetch only public release metadata, not code,
release bodies or user profiles, using the
[GitHub releases API](https://docs.github.com/en/rest/releases/releases#list-releases).
Display the official release title, version, original publication time in London
time and source link. Exclude drafts, prereleases, future and older releases.
Choose at most three updates and one release per product, deterministically.
Independent source failures are shown while successful sources remain usable.
No releases is different from all sources failing.

This is not yet a comprehensive model-announcement or proprietary-tool changelog
feed. No generated summaries are added. Project Spotlight, Developer Tip and
Resource of the Day remain a later phase.

There are six concurrent GitHub requests per run, each bounded to 30 releases,
six seconds and 1 MiB, without retries or authentication. GitHub documents a
[60 requests/hour limit for unauthenticated REST calls](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api);
the limit is shared by the originating IP, so shared hosting or frequent previews
can exhaust it. Failures are explicit, not converted into "no updates".

The new cards reuse the expandable plus controls and include full plain text.
Collapsed content still counts toward email size; verify the complete generated
HTML stays below typical clipping limits when ten jobs are present. Browser
testing is not evidence of delivery or actual Apple Mail interaction.

## Security

- Credentials are kept server-side and are never committed to the repository.
- Scheduled and manual triggers are authenticated, and recipients are fixed in
  server-side configuration.
- Email content is escaped, and only validated HTTP(S) source links are rendered.
