---
name: setup-customer
description: Onboard a new Dispatch client. Takes the intake-form answers for ONE company, calls the platform's setup tool (creates the sub-account from the Dispatch snapshot, tenant + ingest key, owner contact, all 17 custom values pointed at the cloud worker, company files, mode=test), then posts the checklist of what is left for Ty. Also builds the A2P (10DLC) registration packet when Ty asks for it. Run only when Ty names the client and says to set them up.
---

# Setup customer

The heavy lifting is one tool call: `dispatch_setup-customer` on the `ghl` connector. It is idempotent — re-run with `location_id` to finish steps (for example after Ty adds the owner as a user). Nothing here sends a message to anyone.

## Before calling
1. Collect the intake answers (from the PIVOT onboarding contact tagged `dispatch-onboarding`, or from Ty in chat): company_name (exactly as on the EIN letter), ein (9 digits — only stored in tenant settings for the A2P packet, never a custom value), trade, owner first/last/cell/email, business phone, website, address, service ZIPs, license number, business hours, Google Business Profile link, text approval preference, current storm event.
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
owner contact {owner_contact_id} · ingest key stored · 17 custom values written · mode=test
Remaining:
1. {each line from `remaining`}
```
Then stop. Do not buy numbers, do not add users, do not run golden-test, do not send a welcome — each of those is its own instruction from Ty.

## A2P packet (only when Ty says "A2P packet for <client>")
1. If Ty has bought the number, register it first: `dispatch_numbers` action=add (kind local, purpose primary, location_id = the client), then action=assign.
2. Call `dispatch_a2p-packet` on the client's sub-account. It writes `a2p-packet.md`, `sms-terms.html`, `privacy.html` to the client's tenant files and notes the owner contact.
3. Post to Ty: the `missing` list first (EIN / website / address / email / number — he fills those, then you re-run), then the packet markdown verbatim. He pastes it into Settings → Phone Numbers → Trust Center.
4. When Ty reports a status change, record it with `dispatch_a2p-status` (brand_status / campaign_status / ids / notes). The send gate opens for homeowner SMS only at campaign_status=approved.

## Never
- Run against the Dispatch template sub-account (`LTiwIPoSI1YNEcSyzYzf`); the tool refuses it anyway.
- Create routines in Grok Bot for a client — client routines run in the cloud worker now.
- Reveal the ingest key in chat; say "stored".
