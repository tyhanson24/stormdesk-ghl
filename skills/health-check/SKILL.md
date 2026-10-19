---
name: health-check
description: Daily pre-flight (routine R0, 5:30 AM local) that verifies the sub-account, the HighLevel connection, company files, phone/A2P status, and open approvals, then writes a one-line status to the custom value `bot_last_health` and pings the dead-man monitor. Feeds the BLOCKED line of the daily brief.
---

# Health check

Runs before the brief so the brief can say what is broken. Read-only except for the two writes at the end. Never sends to homeowners.

## Checks
1. **Connection** — `locations_get-location` returns this sub-account; `opportunities_get-pipelines` lists `Storm Response` and `Standard Jobs` with all stages named in `ghl-operating-rules`. Missing → `pipelines`.
2. **Schema** — the 25 custom fields and 17 tags from `ghl-operating-rules` exist (sample 5 fields via a contact read; list tags via `contacts_search` facets or REST `GET /locations/{id}/tags`). Missing → `schema`.
3. **Custom values** — `bots_enabled`, `mode`, `trade`, `storm_event`, `company_name`, `owner_phone`, `wh_intake`, `wh_approval`, `bot_webhook_key`, `bot_webhook_key_intake` exist and none still contain `REPLACE`. Fail → `custom_values`.
4. **Company files** — `/workspace/company-profile.md`, `service-area.md`, `pricing-guardrails.md`, `do-not-contact.csv`, and `/workspace/trades/{trade}.md` exist and parse. `owner_contact_id` and `owner_user_id` resolve to a real contact and user. Fail → `company_files`.
5. **Phone** — at least one LC Phone number on the sub-account; if `mode` is `storm` or `standard`, A2P status must be approved (REST `GET /phone-system/...` if available; else read the custom value `a2p_status` the agency maintains). Fail → `phone` (warning only in `test`/`shadow`).
6. **Workflows** — WF-01, WF-02, WF-11 are published (REST `GET /workflows/`). Fail → `workflows`.
7. **Approvals** — count tasks titled `Approve:` older than 24 h and not completed. > 0 → `stale_approvals (n)` (warning).
8. **Expired drafts** — `DRAFT:` notes older than 48 h → convert to `EXPIRED:` and re-stage if the lead is still open. Report count.
9. **Usage** — Grok Bot usage remaining this week (if visible). < 20% → `usage_low` (warning).
10. **Logins** — any browser login the bots depend on (carrier portal, county permit site, GBP) that failed in the last 24 h → `login_expired ({site})`.

## Output
- Write custom value `bot_last_health` = `{ISO timestamp} {OK|FAIL} {comma-separated failing checks}`.
- Ping the dead-man URL in company-profile (`deadman_url`) with `GET {url}` on OK, or `GET {url}/fail` on FAIL. If the value is blank, skip and report `deadman_not_configured`.
- Post the one-line result in chat. The daily brief reads `bot_last_health` for its BLOCKED line.
- If any hard check fails (`pipelines`, `schema`, `custom_values`, `company_files`, `workflows`): also email the agency address in company-profile (`agency_email`) with the failing checks. This is the only outbound this skill may do.

## Hard vs warning
Hard failures stop R1/R14 from acting on real leads (they still log). Warnings do not stop anything.
