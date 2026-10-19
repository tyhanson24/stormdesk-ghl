# Dispatch — client onboarding (agency side)

Goal: 5 minutes of Ty per client. Everything else is the snapshot, the intake form, and Office's `setup-customer` skill.

## Fixed IDs (PIVOT agency)
- Agency company id: `MVaqjpBWfuyQDY1cZjKl`
- PIVOT sub-account (where the intake form and onboarding pipeline live): `Uwb2MCldkWZtF9RHQLqs`
- Dispatch template sub-account (was "StormDesk"): `LTiwIPoSI1YNEcSyzYzf`
- Snapshot: "Dispatch v0.1" id `iIvtMHToswxykXgyB0G8` (v3, refreshed 2026-10-19: 10 workflows, 2 pipelines, 67 fields, 16 custom values, 20 tags, form, dashboard, review settings, KB)
- Intake form: "Dispatch Onboarding" id `PZXXIJxr5BmaXhIubHNc` — https://api.leadconnectorhq.com/widget/form/PZXXIJxr5BmaXhIubHNc
- Agency token: Office secret `GHL_AGENCY_PIT` (scopes: locations r/w, snapshots r, users r, phonenumbers r, saas/location w). Agency tokens have NO contact/conversation/opportunity scopes — intake still needs a sub-account PIT per client until the Marketplace OAuth app exists.

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
2. **Sub-account (2 min, Office).** Office creates the sub-account from snapshot `iIvtMHToswxykXgyB0G8` using `GHL_AGENCY_PIT`, named after `company_name`, address/phone/website from the form.
3. **Token (3 min, Ty).** In the new sub-account: Settings → Private Integrations → "Dispatch Office" with scopes: contacts, conversations, conversations/message, opportunities, calendars, calendars/events, locations/customFields (r), locations/customValues (r/w), locations/tags (r/w), forms (r), locations (r), users (r), workflows (r). Paste into Office (per-client secret `GHL_PIT_{locationId}`).
4. **Number + A2P (10 min, Ty clicks submit).** Office buys one local number via agency token, drafts the A2P packet from the trade pack + intake answers, and opens the registration page. Ty reviews and submits. Standard brand, Low Volume Mixed campaign.
5. **Setup (Office, unattended).** `setup-customer`: fill the 16 custom values (ALL overwritten — template keys must never survive), create routines R0/R1/R9/R14 and write their URLs/keys back, write company-profile / service-area / do-not-contact from the form, load `/workspace/trades/{trade}.md`, set `mode=test`, add owner user to the sub-account, create owner contact, run `golden-test`, post the report.
6. **Welcome (automatic on golden PASS).** Owner gets the welcome text + email: brief at 5:50, APPROVE n / NO n / EDIT n, STOP BOTS.
7. **Go-live.** A2P approved → `mode=shadow` 48 h → Ty flips `mode=storm` or `standard`.

## Guards
- `health-check` fails hard if any custom value still equals the template's value (webhook keys, wf02_id) or contains REPLACE.
- `send-gate` blocks everything in `test`; redirects to owner in `shadow`.
- Nothing is sent to anyone but the owner until mode is `storm`/`standard`.

## Still to build
- WF-00 (PIVOT): form submit → tag → notify Ty → webhook to Office "new client".
- `setup-customer` skill.
- WF-00 welcome sequence inside the snapshot (text + email + day-3 recap).
- A2P packet generator (template in `config/a2p-template.md`).
- Marketplace OAuth app (removes the per-client token step).
