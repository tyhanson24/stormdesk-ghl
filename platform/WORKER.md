# Dispatch worker — routines as a cloud service

Replaces per-client Grok Bot routines for production. Grok Bot Office stays as Ty's console (golden test, onboarding checklist, ad-hoc work); the paying clients' routines run here.

## Why
One Grok Bot = one machine, one task at a time, no API to create bots/routines, dies silently when a browser session expires. A 9-figure platform needs: N clients in parallel, retries, an audit trail per run, hard safety rails, and no laptop in the loop.

## Shape
```
GHL workflow (WF-02 …) ──POST──▶ dispatch-ingest ──insert──▶ jobs (Postgres)
                                                              │  claim (SKIP LOCKED)
pg_cron (every minute) ───POST──▶ dispatch-worker ◀───────────┘
                                     │ agent loop: skill prompt + tools
                                     ▼
                               dispatch-hl (gateway) ──▶ HighLevel
                                     │
                               job_runs (transcript, tokens, result)
```
- **jobs**: one row per unit of work (`intake`, `approval_reply`, `appointment_completed`, `crew_done`, `daily_brief`, `health_check`, `custom`). `dedupe_key` makes webhooks idempotent (GHL retries ⇒ one job). `run_after` + `attempts` give exponential backoff; 5 failures ⇒ `dead` (visible in the brief's BLOCKED line).
- **dispatch-ingest**: validates the per-tenant ingest key, resolves the sub-account, inserts the job, returns 202 in <100 ms, and pokes the worker (fire-and-forget) so latency is seconds, not a minute.
- **dispatch-worker**: claims up to N jobs per invocation with a wall-clock budget, runs each as an agent: system prompt = operating rules + send-gate + the kind's skill + trade pack + company files; tools = the gateway's MCP tools (fetched live from `dispatch-hl`, so new tools appear with no worker deploy). Every `conversations_send-a-new-message` call passes a **code-enforced send gate** before it reaches HighLevel: kill switch, mode (test ⇒ block, shadow ⇒ redirect to owner), do-not-contact, quiet hours, weekly cap, hourly rate limit, duplicate, price/`!`/signature/length rules. The model cannot talk its way past these.
- **job_runs**: full tool-call transcript, token counts, outcome, one-line summary. This is the support console.
- **tenant_files**: company-profile / service-area / pricing-guardrails / do-not-contact per sub-account (what used to live in Office's `/workspace`). Written by `setup-customer`.
- **outbound_log**: every attempted send with gate verdict; feeds the cap/rate/dup checks and the brief.

## Secrets (function)
`DISPATCH_INTERNAL_KEY`, `PUBLIC_BASE_URL` (existing) · `ANTHROPIC_API_KEY` · `DISPATCH_MODEL` (default `claude-sonnet-4-5`) · `SKILLS_REF` (git ref for skills, default `main`).

## Per-tenant
`tenants.settings` jsonb: `{ "ingest_key", "timezone", "owner_contact_id", "trade", "auto_ack" }`. `setup-customer` writes `ingest_key` into the sub-account custom values `bot_webhook_key_*` and `PUBLIC_BASE_URL/functions/v1/dispatch-ingest/<kind>` into `wh_*`, so the snapshot's workflows need no change.

## Status (2026-10-20)
- Deployed: `dispatch-ingest`, `dispatch-worker`; migrations 0002 (queue) and 0003 (cron) applied; `platform_config` holds base url + key; cron `dispatch-worker-tick` (every minute, only when a job is runnable) and `dispatch-enqueue-scheduled` (every 5 min) active.
- Verified without the model: ingest 401/202/dedupe/404; ingest poked the worker; worker claimed, read custom values through the gateway, failed on the missing `ANTHROPIC_API_KEY`, recorded `job_runs`, requeued with 2-min backoff; cron tick retried it (attempt 2). Test job cancelled.
- Template tenant seeded: `tenants.settings` (timezone, owner_contact_id, trade) and `tenant_files` (company-profile, service-area, pricing-guardrails, do-not-contact).
- First real runs (mode=test, Dispatch template): W1 emergency lead → Emergency/urgency 95, tags, opportunity in Storm Response › New Lead, DRAFT ACK-1 note, approval task, owner note, BLOCKED test_mode note, nothing sent (102 s, 19 tool calls). W2 minor lead → Minor/urgency 30, ASK-PHOTOS draft, approval task (52 s, 12 calls, ~$0.14 with prompt caching). Both in `job_runs`.
- Prompt caching on system + tools (~6× cheaper per job). `tenants.settings.owner_user_id` feeds task assignedTo (HighLevel requires it).
- **WF-02 cut over to the worker on the template** (`wh_intake` → `dispatch-ingest/intake`, `bot_webhook_key_intake` = tenant ingest key; previous Cursor values logged in `tenant_events` `cutover:wh_intake`). Ingest accepts GHL's native webhook envelope (`location.id`, `customData`, form-encoded).
- Golden test (R15, Office grades; worker runs intake) iterated runs 4 → 9. Every miss was made deterministic rather than re-prompted:
  - worker fetches the inbound text itself (`INBOUND:` note → last inbound message) and feeds it verbatim with the address;
  - gateway `cleanContact` (create/upsert) and `withFieldIds` (customFields `key`/name → field id; HighLevel silently ignores `contact.*` keys);
  - worker enforces after every intake: tags `storm-lead` + `bot-drafted`, `lead_source` (webhook source), `storm_event` (custom value), `next_followup_date` = tomorrow when an ASK-* draft was written; ASCII-normalizes quotes in everything sent to HighLevel;
  - storm-intake skill now states the tag rules, "{street} = full line incl. house number", and Qualified only with photos;
  - tool-call transport errors are retried once and returned to the model as errors (not job failures); retry backoff 30 s → 2 m → 8 m → 32 m → 60 m; auto-send list is stated in the prompt (draft-only otherwise).
  - Typical intake: 60–80 s, ~30–60k billed-equivalent input tokens, 0 sends in test mode.
- **Owner approvals are code, not model** (migration 0004 `approvals`): every `DRAFT:` note the worker stages gets a per-location number `n`; the HighLevel task is renamed "Approve #n: TEMPLATE → Name" and the owner is pinged "Draft #n for … Reply APPROVE n / NO n / EDIT n". WF-11 posts the owner's text to `dispatch-ingest/approval_reply`; the worker parses APPROVE n / APPROVE ALL / YES / OK / SEND / NO n / SKIP / DECLINE / EDIT n <text>, ignores non-owner senders, runs the gate, sends, tags `bot-sent`, completes the task, writes SENT/DECLINED/BLOCKED notes and confirms to the owner — ~3 s, zero model tokens. test_mode/quiet_hours blocks keep the draft pending. The daily brief gets the pending list with the same numbers.
- Template cut over fully: `wh_intake`, `wh_approval`, `wh_estimate`, `wh_crew_done` → `dispatch-ingest/<kind>`; `bot_webhook_key*` = tenant ingest key (`tenant_events` `cutover:wh_approval`). WF-11 is published on the template.
- `dispatch-setup` + `dispatch_setup-customer` gateway tool + `skills/setup-customer`: one call onboards a client sub-account (see ONBOARDING.md).

## Rollout
1. Deploy; `mode=test` on the Dispatch template; point `wh_intake` at ingest; fire a golden lead; read `job_runs`.
2. Run both (Grok R1 + worker) in shadow on the template for a few days; compare.
3. New clients: worker only. Grok Bot keeps R15 (golden test) and R16 (onboarding) for Ty.
