---
name: test-briefing
description: "Use when implementing, testing or reviewing Intel-Agent briefing behaviour. Cover provider transformations, London reporting windows, orchestration, partial failures, deterministic news selection, safe rendering, authenticated triggers and delivery failures."
---

# Test a briefing

1. Inspect the actual runner, scripts and existing fixtures. Use Vitest once established. If tooling does not exist, report the foundation prerequisite rather than claiming tests ran.
2. Use a fixed clock and deterministic fixtures. Mock every external integration, including delivery. Prevent real network access where the runner supports it; do not load production credentials.
3. Cover applicable provider behaviour:
   - Valid and invalid responses, empty results, API failure, timeout, retry limits and pagination.
   - Calendar timed/all-day/multi-day events, cancelled and recurring instances, chronological ordering and metadata minimisation.
   - Consecutive London midnight boundaries in GMT, BST and both DST transitions; include 23-hour and 25-hour days.
   - Weather transformations, Celsius, missing optional fields, all three configured locations and individual failures.
   - News categories, canonical URL and headline duplicates, conservative overlap grouping, invalid/future/stale timestamps, deterministic ranking and maximum three stories per category.
4. Cover orchestration:
   - Definition lookup and validation; unknown and disabled briefings.
   - Only configured providers are resolved with the correct reporting periods.
   - Independent failures preserve successful sections and are explicitly recorded.
   - Empty results differ from unavailable data; section order comes from the definition.
   - All-provider failure is explicit rather than a success-shaped fabricated briefing.
   - Delivery failure returns a failure result; successful sends are not retried.
   - Retries of an ambiguous send reuse the exact prepared payload and stable key.
   - Separate invocations derive the same logical key without claiming an in-memory lock guarantees distributed exactly-once delivery.
5. Cover rendering with complete, empty and partial fixtures:
   - Morning Calendar-first section order, followed by weather and the three news categories.
   - HTML and plain text, readable mobile layout, source attribution and publication dates.
   - Zero to three news stories; no invented values or generated summaries.
   - Escaped untrusted text and rejection of unsafe link protocols.
6. Cover routes with missing, incorrect and valid credentials, appropriate status codes and safe responses. Preview/manual testing must not send implicitly or accept arbitrary recipients.
7. Run the smallest combined relevant selectors, then type-check/lint for code changes. Run broader checks only when warranted. Report commands, results and gaps.

V1 does not use AI: do not add LLM fallback tests or dependencies. If AI is explicitly introduced later, add its validation and fallback cases then.
