---
name: setup-customer
description: Onboard a new Dispatch client. Takes the intake-form answers for ONE company, calls the platform's setup tool (creates the sub-account from the Dispatch snapshot, tenant + ingest key, owner contact, all 16 custom values pointed at the cloud worker, company files, mode=test), then posts the checklist of what is left for Ty. Run only when Ty names the client and says to set them up.
---

# Setup customer

The heavy lifting is one tool call: `dispatch_setup-customer` on the `ghl` connector. It is idempotent — re-run with `location_id` to finish steps (for example after Ty adds the owner as a user). Nothing here sends a message to anyone.

## Before calling
1. Collect the intake answers (from the PIVOT onboarding contact tagged `dispatch-onboarding`, or from Ty in chat): company_name (exactly as on the EIN letter), trade, owner first/last/cell/email, business phone, website, address, service ZIPs, license number, business hours, Google Business Profile link, text approval preference, current storm event.
2. Map `text_approval_preference`: "auto-send 3 basic replies" → `auto_ack: true`; otherwise `false`.
3. If anything required is missing (company_name, trade, owner first/last/cell), ask Ty for it — do not guess.
4. Call once with `dry_run: true` and show Ty the plan (one line). Proceed only if Ty has already said "set up <client>" in this conversation; otherwise stop and ask.

## Call
`dispatch_setup-customer` with every field you have. Typical wait: 1–3 minutes (the snapshot has to land). If it returns an error:
- `HighLevel 4xx POST /locations/` → HighLevel refused to create the sub-account (plan limit or permissions). Tell Ty to create it in the HighLevel UI from snapshot "Dispatch v0.1", then re-run with `location_id`.
- `snapshot custom values never appeared` → wait 2 minutes and re-run with `location_id`.
- anything else → post the error verbatim to Ty and stop.

## After
Post to Ty, in this order, nothing else:
```
SETUP — {company_name} — {location_id}
owner contact {owner_contact_id} · ingest key stored · 16 custom values written · mode=test
Remaining:
1. {each line from `remaining`}
```
Then stop. Do not buy numbers, do not add users, do not run golden-test, do not send a welcome — each of those is its own instruction from Ty.

## Never
- Run against the Dispatch template sub-account (`LTiwIPoSI1YNEcSyzYzf`); the tool refuses it anyway.
- Create routines in Grok Bot for a client — client routines run in the cloud worker now.
- Reveal the ingest key in chat; say "stored".
