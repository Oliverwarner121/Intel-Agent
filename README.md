# Intel-Agent
Daily agent emails you desired information for the day

## Project status

Planning stage: the application has not been scaffolded or deployed.
V1 will deliver a morning email with calendar data, weather and selected news
headlines with source links. It will not use an LLM or generated summaries.

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
live email sends. Application implementation awaits approval of the phased plan.
