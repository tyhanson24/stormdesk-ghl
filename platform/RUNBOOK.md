# Dispatch platform runbook

What to do when the platform pages you. Every alert email names its rule; find it below. The console is the Dispatch Console artifact (`platform/admin/dashboard.html`): it reads the database through the viewer's own Supabase connector (claude.ai asks once to allow it; read-only SELECTs on the views). The same data is also served by `dispatch-admin` (`/overview`, `/tenant/<loc>`, `/run/<id>`, `/alerts`, `/usage`, header `x-dispatch-admin-key` = `DISPATCH_ADMIN_KEY`) for scripts.

## Where things are
- Supabase project `jlkkvrvytvydkcahezob`: Edge Functions `dispatch-oauth` (install/callback), `dispatch-token` (broker), `dispatch-hl` (gateway + MCP), `dispatch-ingest` (webhooks → jobs), `dispatch-worker` (runs jobs), `dispatch-setup` (onboarding), `dispatch-public` (SMS terms / privacy pages), `dispatch-monitor` (alert rules, every 5 min), `dispatch-admin` (console API).
- pg_cron: `dispatch-worker-tick` (1 min), `dispatch-enqueue-scheduled` (5 min: health_check 05:30, daily_brief 06:00 local), `dispatch-delivery-checks` (15 min), `dispatch-monitor` (5 min).
- Tables: `tenants` (tokens + settings), `jobs` / `job_runs` (queue + transcripts), `outbound_log` (every send with gate verdict + delivery), `approvals`, `consents`, `a2p_registrations`, `numbers`, `tenant_files`, `tenant_events`, `platform_alerts`, `platform_settings` (`alerts` routing), `platform_config` (cron secrets), `tenant_cv` (mode / bots_enabled / a2p_status mirrored from HighLevel by the monitor every 5 min). Views `queue_status`, `usage_daily`.
- Secrets (Edge Functions → Secrets): `DISPATCH_INTERNAL_KEY` (everything internal), `DISPATCH_ADMIN_KEY` (console, read-only), `GHL_CLIENT_ID/SECRET`, `ANTHROPIC_API_KEY`, `PUBLIC_BASE_URL`, optional `DISPATCH_MODEL`, `SKILLS_REF`.

## Alert rules (dispatch-monitor) and the fix
| Rule | Fires when | Severity | Do this |
|---|---|---|---|
| `dead_jobs` | a job hit 5 failed attempts in the last 24 h | crit | Console → failed runs → open the run, read the error. Fix the cause (usually HighLevel 4xx on a bad id, model timeout, or a bug). Re-queue: `update jobs set status='queued', attempts=0, run_after=now() where id='…'`. If the job is moot, `update jobs set status='succeeded', result='{"status":"blocked","summary":"closed by Ty"}'`. |
| `queue_stuck` | runnable jobs waiting > 10 min | crit | Edge Functions → dispatch-worker → logs. Check `cron.job_run_details` for `dispatch-worker-tick`. Kick it: `POST /functions/v1/dispatch-worker` with `x-dispatch-key`. If `platform_config` lost `dispatch_internal_key` / `public_base_url`, re-insert them. |
| `failure_spike` | ≥3 failed runs and ≥50 % of runs in the last hour | warn | Same as dead jobs; look for one shared error (Anthropic 529, HighLevel 401 → token, 429 → rate). Nothing to do if it was a burst that already recovered. |
| `token_refresh` / `token_expired` | `tenants.last_error` set, or `expires_at` > 1 h past | crit | Reinstall the app on that sub-account: open `/functions/v1/dispatch-oauth/install` (agency: `?kind=agency`) while logged into HighLevel as the agency. The broker heals on the next call. |
| `carrier_block` | `tenants.settings.sms_paused` set by the delivery monitor | crit | Console → tenant → sends: read `delivery_error`. Fix the number / A2P (Trust Center), then call `dispatch_sms-resume` from Office (or clear `settings.sms_paused` in SQL). |
| `gateway_down` | the monitor's own gateway probe failed | crit | status.supabase.com, then dispatch-hl / dispatch-token logs. A HighLevel outage looks like 5xx from services.leadconnectorhq.com in the logs; wait it out. |
| `budget` | one sub-account over $25 model spend today | warn | Console → tenant → runs. A loop looks like the same kind + contact every few minutes; kill it by setting `bots_enabled=false` on that sub-account (custom value) and fix the trigger. Raise `BUDGET_USD_PER_DAY` in dispatch-monitor if the spend is legitimate. |
| `cv_read` | the monitor could not read a sub-account's custom values | warn | Token problem on that sub-account: reinstall the app there. |
| `health_fail` | the 05:30 code health check (`dispatch-worker` kind `health_check`, 0 model tokens) wrote `health:fail` for a sub-account in the last 36 h | crit | The title lists the failing checks (`custom_values:*`, `setup:*`, `company_files:*`, `pipelines:*`, `workflows:WF-xx_*`, `phone:no_number`, `a2p:*`, `carrier_pause`, `custom_values:renamed(key→name)`). `skills/health-check/SKILL.md` explains each. Fix in HighLevel / `tenant_files`, then insert a `health_check` job (`insert into jobs (location_id, kind, dedupe_key) values ('…','health_check','health|…|manual')`) to clear it. A renamed custom value (key ≠ name) means a workflow webhook is pointing at the wrong value: rename it back with `locations_update-custom-value`. |
| `uninstalled` | app uninstalled on a sub-account that still exists | warn | Reinstall (see token), or if the client left, leave it; the worker refuses jobs for it anyway. |

Alerts auto-resolve when the condition clears; one open row per key; re-notified every 6 h while open (`platform_settings.alerts.renotify_minutes`).

## Alert routing
`platform_settings` key `alerts`: `{location_id, contact_id, channels:["SMS","Email"], min_severity:"warn", renotify_minutes:360, email_from?}`. Today it points at Ty's contact in Dispatch Test Co (email works; SMS needs a number on that sub-account). To move it to the PIVOT sub-account: install the app there, create a contact for Ty, update the row.

## Kill switches (fastest → broadest)
1. One client: custom value `bots_enabled=false` (Office: `locations_update-custom-value`). Every job for it finishes `blocked` immediately; nothing is sent.
2. One client, texts only: `update tenants set settings = settings || '{"sms_paused":{"at":"…","reason":"manual"}}' where location_id='…'`.
3. Everything: `select cron.unschedule('dispatch-worker-tick');` — jobs queue up and nothing runs until `select cron.schedule('dispatch-worker-tick','* * * * *',$$select public.tick_worker()$$);`.

## Reading a run
Console → run: steps are the tool calls in order with args and the first 300 chars of each result; `ok:false` steps are red. The gate's verdicts appear as `BLOCKED <check>: <reason>` in the send step. Tokens are the model's bill (cache reads counted at 10 %).

## Metering
`usage_daily` (per sub-account per UTC day): runs by status, tokens, `model_cost_usd` at Sonnet 4.5 list price, sends / shadow / blocked / undelivered. The console's chart is the last 7 days; `GET /dispatch-admin/usage?days=30` for more. Billing (#6) will read this view.

## Deploys
Edge functions deploy from the files in `platform/supabase/functions/` (each function folder + `_shared/`). After a deploy, the smoke test is a `custom` job on Dispatch Test Co: `POST /dispatch-ingest/custom {location_id, instruction:"call locations_get-custom-values once, end with SUMMARY: ok"}` and check the run in the console. Migrations live in `platform/supabase/migrations/` and are applied in order.
