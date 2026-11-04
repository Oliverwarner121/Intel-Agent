---
name: add-data-provider
description: "Use when adding or replacing an Intel-Agent data source or provider adapter, such as Google Calendar, weather, RSS news, financial markets, traffic or alerts. Keep integrations server-only, validated, normalised, bounded and independently testable."
---

# Add a data provider

1. Inspect existing provider contracts, domain models, request helpers, environment validation and error/logging patterns. Reuse them; do not create a framework or duplicate an existing integration.
2. Verify official endpoint availability, authentication, permitted retrieval and processing, attribution, quotas and cost. An accessible feed is not permission to extract or analyse it. Block the integration if permissions remain unresolved.
3. Define the smallest domain output needed by briefings, with explicit reporting periods and input configuration. Keep external DTOs internal. Distinguish empty, unavailable and partial results; never invent values or imply that missing warnings mean no warnings.
4. Implement server-only access. Validate provider payloads with Zod before transforming them. Validate units, timestamps, coordinates and pagination as applicable; do not use `any` or unchecked casts.
5. Use shared HTTP helpers with request cancellation, bounded response sizes and limited retries for transient failures within the run budget. Respect rate limits. Do not retry invalid configuration or ordinary permanent authentication failures.
6. Fetch only approved configured endpoints. Validate redirects and external URLs against the integration's policy; do not turn caller-supplied URLs into an unrestricted server fetch.
7. Preserve independent successes. Fetch weather locations concurrently and expose individual failures; keep remaining news sources usable if one fails. Surface errors with safe codes and structured logging, not secrets or private payloads.
8. Wire the adapter into provider resolution and only the definitions that need it. Do not add provider-specific API calls to orchestration or rendering.
9. Add mocked tests for valid/invalid payloads, transformations, empty results, pagination where applicable, authentication failure, rate limiting, timeout, retry limits and partial failures.
10. Document setup, permissions, field limitations and attribution. Add only required environment variables, with safe examples. Use verify-external-integration before calling the integration live-verified; obtain permission before live side effects.

## V1 specifics

- Calendar: use the narrowest suitable read-only event scope, refresh-token OAuth, recurrence expansion and pagination. Preserve all-day dates and London boundaries; omit unnecessary personal metadata.
- Weather: verify fixed coordinates once, use Celsius and make unsupported warning fields explicit. Open-Meteo personal-use access needs no API key.
- News: preserve original publisher, URL and publication time. Use deterministic category/ranking rules; no LLM or generated summaries in V1.
