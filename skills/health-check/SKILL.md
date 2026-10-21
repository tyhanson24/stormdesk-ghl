---
name: health-check
description: Daily pre-flight (routine R0, 5:30 AM local) that verifies the sub-account, the HighLevel connection, company files, phone/A2P status, and open approvals, then writes a one-line status to the custom value `bot_last_health` and pings the dead-man monitor. Feeds the BLOCKED line of the daily brief.
---

# Health check

**Runs as code in the cloud worker** (`dispatch-worker` → `healthCheck`), not as a model run: zero tokens, same checks. This file documents what it checks so Office and the daily brief can explain a failure. Runs before the brief so the brief can say what is broken. Never sends to homeowners.

## Checks
1. **Connection** — `locations_get-location` returns this sub-account; `opportunities_get-pipelines` lists `Storm Response` and `Standard Jobs` with all stages named in `ghl-operating-rules`. Missing → `pipelines`.
2. **Schema** — the 25 custom fields and 20 tags from `ghl-operating-rules` exist (sample 5 fields via a contact read; list tags via `contacts_search` facets or REST `GET /locations/{id}/tags`). Missing → `schema`.
3. **Custom values** — `bots_enabled`, `mode`, `trade`, `storm_event`, `company_name`, `owner_phone`, `wh_intake`, `wh_approval`, `bot_webhook_key`, `bot_webhook_key_intake` exist and none still contain `REPLACE`. Fail → `custom_values`.
4. **Company files** — `/workspace/company-profile.md`, `service-area.md`, `pricing-guardrails.md`, `do-not-contact.csv`, and `/workspace/trades/{trade}.md` exist and parse. `owner_contact_id` and `owner_user_id` resolve to a real contact and user. Fail → `company_files`.
5. **Phone** — at least one LC Phone number on the sub-account; if `mode` is `storm` or `standard`, A2P status must be approved (REST `GET /phone-system/...` if available; else read the custom value `a2p_status` the agency maintains). Fail → `phone` (warning only in `test`/`shadow`).
5b. **Compliance** — read `dispatch_a2p-status` (campaign status + numbers). In `storm`/`standard`: campaign not `approved` and no verified toll-free number → FAIL `a2p`; tenant `sms_paused` set → FAIL `carrier_pause` (say when and why). Any mode: contacts tagged `storm-lead` created in the last 7 days with no consent row → warning `consent_missing (n)` (they'll be blocked at send time, not an outage). Failed/undelivered sends in the last 24 h > 0 → warning `delivery_failures (n)`.
6. **Workflows** — WF-01, WF-02, WF-11 are published (REST `GET /workflows/`). Fail → `workflows`.
7. **Approvals** — count tasks titled `Approve:` older than 24 h and not completed. > 0 → `stale_approvals (n)` (warning).
8. **Expired drafts** — `DRAFT:` notes older than 48 h → convert to `EXPIRED:` and re-stage if the lead is still open. Report count.
9. **Usage** — model spend per sub-account is metered in `usage_daily`; the platform monitor raises `budget` when a day passes $25.
10. **Logins** — (future: permit portals) any browser login the bots depend on that failed in the last 24 h → `login_expired ({site})`.

## Output
- Write custom value `bot_last_health` = `{ISO timestamp} {OK|FAIL} {comma-separated failing checks}`.
- Log `tenant_events` `health:ok` / `health:fail` with the lists; the platform monitor turns a `health:fail` into a `health_fail` alert to Ty (email + SMS) and clears it when the next check passes.
- The daily brief gets the line verbatim for its BLOCKED line.

## Hard vs warning
Hard failures stop R1/R14 from acting on real leads (they still log). Warnings do not stop anything.
