---
name: verify-external-integration
description: "Use when verifying or claiming completion of an Intel-Agent external integration: Google OAuth or Calendar, weather, RSS, Resend or Vercel Cron. Collect evidence and distinguish mock-tested implementation from live verification and deployment."
---

# Verify an external integration

1. Identify the provider, implemented behaviour, environment and exact claim being verified. Read setup documentation and relevant code; do not assume an account or secret exists.
2. Verify current official documentation for permissions, authentication, usage terms, quotas and cost. Resolve any licensing restriction before a live call. Do not treat RSS availability as approval for reuse.
3. Confirm configuration validation and server-only boundaries. Check that missing configuration produces an actionable error without exposing values. Never ask for credentials in chat.
4. Run the smallest relevant mocked tests for transformation, invalid responses, empty data, failure and timeouts. Automated tests must not use real credentials or send emails.
5. Obtain authorisation before accessing private Calendar data, sending an email, changing account/DNS configuration or triggering production jobs. Public read-only endpoint checks may be performed when permitted. Use approved local secret handling; never print tokens.
6. Make a bounded development call where authorised. Confirm authentication, response validation and normalised output, not merely HTTP success. Record safe evidence such as status, item counts and verification time, without full private data.
7. For OAuth, verify unattended token refresh and document reauthorisation. External Google OAuth Testing tokens with Calendar scopes expire after seven days; publishing status does not eliminate every revocation or verification requirement.
8. For weather, verify location identity, coordinates, units and available fields. For news, verify dates, canonical links, publisher attribution and permitted use. For email, verify sender domain and fixed recipient; distinguish API acceptance from receipt and spam placement.
9. For Cron, confirm production configuration and bearer authentication, then check execution evidence if authorised. Test GMT/BST conversions separately. A manual invocation is not proof that scheduled invocation occurred.
10. Verify safe logs and failure handling using mocks rather than disruptive production experiments. Update setup and troubleshooting documentation.

## Completion report

Report each applicable level separately:

- Implemented: code/configuration exists.
- Mock-tested: relevant tests passed, with commands.
- Live-verified: authorised real call succeeded, with safe evidence.
- Deployed: production deployment/configuration confirmed.
- Scheduled/received: actual scheduled run or inbox receipt observed, if applicable.

Mark missing evidence as unverified or blocked, with the prerequisite. Never substitute a plausible implementation for live evidence. V1 has no LLM integration to configure or verify.
