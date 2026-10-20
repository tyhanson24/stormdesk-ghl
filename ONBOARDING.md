# Dispatch — client onboarding (agency side)

Goal: 5 minutes of Ty per client. Everything else is the snapshot, the intake form, and Office's `setup-customer` skill.

## Fixed IDs (PIVOT agency)
- Agency company id: `MVaqjpBWfuyQDY1cZjKl`
- PIVOT sub-account (where the intake form and onboarding pipeline live): `Uwb2MCldkWZtF9RHQLqs`
- Dispatch template sub-account (was "StormDesk"): `LTiwIPoSI1YNEcSyzYzf`
- Snapshot: "Dispatch v0.1" id `iIvtMHToswxykXgyB0G8` (v3, refreshed 2026-10-19: 10 workflows, 2 pipelines, 67 fields, 16 custom values, 20 tags, form, dashboard, review settings, KB)
- Intake form: "Dispatch Onboarding" id `PZXXIJxr5BmaXhIubHNc` — https://api.leadconnectorhq.com/widget/form/PZXXIJxr5BmaXhIubHNc
- HighLevel auth: the Dispatch gateway (`platform/README.md`). Agency-level calls (create sub-account from snapshot, users, phone numbers): `POST .../dispatch-token {"companyId":"MVaqjpBWfuyQDY1cZjKl"}` with `x-dispatch-key`. Sub-account calls: the `ghl` MCP (gateway) with `locationId`. Office secret `GHL_AGENCY_PIT` is legacy — retire once `setup-customer` uses the broker.

## Intake form fields (PIVOT contact custom fields, folder "Additional Info")
| Form label | key |
|---|---|
| First / Last / Phone (owner cell) / Email | standard |
| Company name (exactly as on your EIN letter) | `company_name` (form-only single line) |
| Website | `contact.website` |
| Service ZIP codes | `service_zip_codes` |
| License number | `license_number` |
| Google Business Profile link | `google_business_profile_link` |
| Business hours | `business_hours` |
| Trade (dropdown: Roofing, Fencing, Gutters, Screen enclosures, Tree service, Water / storm restoration, Artificial turf, Other) | `trade` |
| Crew size | `crew_size` |
| Text approval preference (radio: approve every text / auto-send 3 basic replies) | `text_approval_preference` |
| EIN letter (CP-575 or 147C) — private file, PDF/JPG/PNG | `ein_letter_cp575_or_147c` |

## The flow
1. **Call (15 min).** Fill the intake form with the client on the phone, or send them the link. Submission creates a contact in PIVOT tagged `dispatch-onboarding` (WF-00 in PIVOT — to build).
2. **Setup (2–3 min, Office, one tool call).** Say "set up <Company>" to Office. The `setup-customer` skill calls `dispatch_setup-customer` (gateway → `dispatch-setup` edge function), which: creates the sub-account from snapshot `iIvtMHToswxykXgyB0G8` with an agency token (or reuses `location_id`), waits for the snapshot, creates the tenant row + per-client ingest key, upserts the owner contact (tag `owner`), overwrites **all 16 custom values** (`wh_*` → `dispatch-ingest/<kind>`, `bot_webhook_key*` → ingest key, `wf02_id`, `mode=test`, `bots_enabled=true`, trade, company, owner phone, address, license, review link, storm event), writes company-profile / service-area / pricing-guardrails / do-not-contact into `tenant_files`, and returns the remaining-steps list. Idempotent: re-run with `location_id`.
   - Needs HighLevel to allow API sub-account creation (Agency Pro). If it refuses, create the sub-account from the snapshot in the UI and re-run with `location_id`.
   - The marketplace app auto-installs on the new sub-account; the gateway mints its token from the agency install.
3. **Owner user (1 min, Ty).** Add the owner as a user on the sub-account (our app has `users.readonly` only). Re-run setup with `location_id` so `owner_user_id` is stored (tasks are assigned to it).
4. **Number + A2P (10 min, Ty clicks submit).** Buy one local number; A2P packet from the trade pack + intake answers (generator still to build). Standard brand, Low Volume Mixed campaign.
5. **Golden test (Office, 8 min).** "run golden-test on <Company>" — the cloud worker runs intake; Office grades. Must PASS.
6. **Welcome (automatic).** Golden PASS queues `dispatch_welcome`; the owner gets W-1 text + W-2 email the moment Ty flips `mode` to `shadow` (held while `test`), and the W-3 recap 3 days later. Copy: `config/welcome-copy.md` (approved).
7. **Go-live.** A2P approved → `mode=shadow` 48 h → Ty flips `mode=storm` or `standard`.

Client routines no longer live in Grok Bot: WF-02 / WF-05 / WF-08 / WF-11 post to `dispatch-ingest` and the cloud worker runs them (`platform/WORKER.md`).

## Guards
- `health-check` fails hard if any custom value still equals the template's value (webhook keys, wf02_id) or contains REPLACE.
- `send-gate` blocks everything in `test`; redirects to owner in `shadow`.
- Nothing is sent to anyone but the owner until mode is `storm`/`standard`.
- In `storm`/`standard`, a homeowner SMS also needs: a consent row (they texted/formed/called in, or the owner attested), an approved 10DLC campaign or a verified toll-free bridge number, and no carrier pause. See `platform/WORKER.md` → Compliance.

## Still to build
- WF-00 (PIVOT): form submit → tag → notify Ty → webhook to Office "new client".
- ~~`setup-customer` skill~~ — done (`skills/setup-customer`, `platform/supabase/functions/dispatch-setup`).
- A2P packet generator (template in `config/a2p-template.md`).
- ~~Marketplace OAuth app~~ — done (platform/).
