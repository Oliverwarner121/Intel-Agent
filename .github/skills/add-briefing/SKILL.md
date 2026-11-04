---
name: add-briefing
description: "Use when adding or changing an Intel-Agent briefing, including a lunchtime update, evening briefing, weekly digest or scheduled weather email. Wire its definition, registry, reporting periods, reusable providers, template, protected trigger, schedule and tests."
---

# Add a briefing

1. Inspect existing definitions, registry, orchestrator, providers, renderers, routes and deployment configuration. If the application is not scaffolded, report that prerequisite instead of inventing a parallel implementation.
2. Confirm the requested briefing is authorised. V1 includes only morning; adding future briefings requires an explicit request. Establish sources, section order, reporting periods, delivery and scheduling intent. Ask only about unresolved behavioural choices.
3. Create or update a validated declarative definition with a unique ID, enabled status, timezone, provider configuration, ordered sections, selection policy, template ID and delivery configuration. Register it using the existing pattern.
4. Resolve reporting periods through shared date utilities. Use `Europe/London` where appropriate, including DST transitions. A rolling 24-hour news window is distinct from a local calendar day. "Since last successful delivery" requires persisted state; do not pretend it exists.
5. Reuse provider adapters and deterministic news selection. Add a provider only if needed, following the add-data-provider workflow. Do not add an LLM or generated summaries to V1.
6. Reuse or add a renderer producing HTML and plain text. Preserve the morning order: Today's Calendar, Weather, Worldwide Tech and AI, UK Politics and Finance, Global Affairs. News must retain publisher, original timestamp and safe source link; at most three stories per configured category.
7. Keep the trigger thin and authenticated. Invoke the generic orchestrator with the registered ID; do not embed provider calls or delivery logic in the route. Manual preview must not send by default.
8. Add an explicit deployed UTC schedule when scheduled execution is requested. Keep definition metadata consistent with deployment configuration. Hobby supports once-daily jobs with hourly precision; timezone metadata does not automatically change Cron. Document GMT and BST separately and obtain approval for paid scheduling.
9. Use a logical delivery key per briefing, reporting date and recipient. Do not use the random run ID as its deduplication identity. Explain the provider's retention and lack of durable execution history.
10. Test registry/configuration validation, provider resolution, reporting windows, ordering, partial failures, HTML/plain text, authentication and delivery errors with mocks. Follow test-briefing.
11. Update README setup and extension guidance. Update the environment example only if a new variable is actually required. Report verification evidence and remaining external setup; do not claim deployment or live delivery without evidence.
