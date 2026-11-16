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

## Security

- Credentials are kept server-side and are never committed to the repository.
- Scheduled and manual triggers are authenticated, and recipients are fixed in
  server-side configuration.
- Email content is escaped, and only validated HTTP(S) source links are rendered.
