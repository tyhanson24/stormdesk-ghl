---
name: storm-intake
description: Turn a new inbound (missed-call text-back reply, web form, voicemail transcript, FB/Nextdoor message) into a qualified HighLevel contact + Storm Response opportunity with address, damage type, severity, photos, insurance status. Use whenever a new lead or reply arrives.
---

# Storm intake

Goal: within minutes, every inbound becomes a complete contact + opportunity in `Storm Response › New Lead` or `Qualified – Needs Estimate`, and the homeowner knows they're on the list.

## Trigger inputs you may receive
- Webhook payload from GHL workflow `WF-02 New Storm Lead` (contact id, source, first message) → routine R1.
- Email forwarded to the Bot's `+intake` alias.
- Scheduled sweep: `conversations_search-conversation` for unread inbound in the last N minutes.

## Steps
1. Load `ghl-operating-rules` and the trade pack. Check `bots_enabled` and `mode`. Read company-profile, service-area, do-not-contact. If a company file is missing, proceed with defaults (service area = any address in the sub-account's state; auto_ack = false; storm_event = the `storm_event` custom value) and say which files were missing in the log.
2. `contacts_get-contact`. Read the full thread with `conversations_get-messages`.
3. Extract: property address, damage type, severity words ("water coming in", "tarp", "shingles in yard", "fence down on neighbor's side"), photos attached?, insurance mentioned?, how they found us. Copy the address **exactly as the lead wrote it, house number included** — `{street}` in every field, opportunity name and template means the full street line (e.g. "210 Golden Test Way"), never just the street name.
4. Address check: inside service-area? If not → tag `out-of-area`, set urgency_score 0, write the OUT-OF-AREA draft as a `DRAFT:` note plus an owner approval task (same as any other reply), no opportunity, stop.
5. Severity from the trade pack: `Emergency` = `{pack.emergency_rule}`. `Major` = `{pack.major_rule}`. `Minor` = `{pack.minor_rule}`. `Unknown` = no detail yet.
6. Upsert contact fields: property_address, damage_type, damage_severity, has_photos, insurance_claim, lead_source, storm_event.
7. Opportunity (REST `POST /opportunities/`): search first with `opportunities_search-opportunity`. If none, create in `Storm Response › New Lead` with name `"{Last name} – {damage_type} – {street}"`. Move to `Qualified – Needs Estimate` only when ALL of: address known, severity is Major or Minor (not Unknown), and photos are attached (`has_photos` = Yes). No photos → stays in `New Lead` (ask for them). If Emergency → tag `emergency` + `{pack.emergency_tag}`, notify owner immediately (GHL SMS to the owner's contact record; WF-03 also calls the owner natively), keep in `New Lead` until Dispatcher schedules the tarp.
8. Draft the reply (see templates). Write it as a contact note (REST) in exactly this format and nothing else:
   ```
   DRAFT: {template id} | sms | {ISO timestamp}
   {message text, verbatim as it would be sent}
   ```
   Two lines only: no explanation, no severity notes, no "why" after the message (reasoning goes in your run log, not the note). Then create a contact task (REST) titled `Approve: intake reply → {name}` assigned to the owner, due now. Missing info → ask for ONE thing at a time (address first, then photos).
9. Set `next_followup_date` = +1 day if waiting on info, else leave for Dispatcher.
10. Tags (use `contacts_add-tags`; add every one that applies, in one call):
   - always `storm-lead` and `bot-drafted`;
   - `needs-photos` when no photos were attached (whenever you draft ASK-PHOTOS);
   - `insurance` when the lead mentions insurance or a claim;
   - `emergency` + `{pack.emergency_tag}` when severity is Emergency;
   - `out-of-area` per step 4; `storm-chaser-risk` when door-knockers are mentioned.
   Then log.
11. Notes you may create on the lead: exactly one `DRAFT:` note per reply, plus any `BLOCKED:` note the send-gate requires. No summary / "intake processed" / "EMERGENCY INTAKE" notes — that reasoning belongs in your run log (SUMMARY), not on the contact.

## Templates (adapt to company voice; never add price)

**ACK-1** (first reply when address + damage known):
"Thanks {first}. You're on our list for {street}. We're working {storm_event} damage in order of severity and date received. Next step: {pack.estimate_next_step | pack.emergency_next_step}. Reply here anytime. — {Company}"

**ASK-ADDRESS**: "Thanks for reaching out. What's the property address? Then send a couple photos of the damage if you can safely take them. — {Company}"

**ASK-PHOTOS**: "Got it, {street}. If you can safely take {pack.photo_guidance}, text them here — it helps us put you in the right line. — {Company}"

**OUT-OF-AREA**: "Thanks for reaching out. {Street} is outside the area we can reach right now while we work storm damage locally. If that changes we'll let you know. — {Company}"

**STORM-CHASER-NOTE** (only if homeowner mentions door-knockers): add one line: "Quick note: ask any company for their Florida license number and local address before signing anything."

## Scoring (writes `urgency_score`)
Emergency 90–100 · Major with photos 60–80 · Major no photos 50 · Unknown (no detail yet) 40 · Minor 20–40 · Insurance=Yes +5 · Elderly/medical mention +10 · Repeat customer +10 · out-of-area → 0. Never leave urgency_score blank.

## Sending
Any send (including auto_ack) passes through `send-gate` first.

## Don't
Quote price. Promise a date. Diagnose from photos ("you need a full replacement"). Send before approval unless `auto_ack: true` and the message is exactly ACK-1 / ASK-ADDRESS / ASK-PHOTOS.
