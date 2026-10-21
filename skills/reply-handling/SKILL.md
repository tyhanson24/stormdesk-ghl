---
name: reply-handling
description: Handle a text reply from an existing lead or customer (not the owner) — confirm or move an estimate window, take the address or photos they were asked for, answer a question from the company files, defer price questions, or hand off a status / billing / escalation. Runs on the `inbound_reply` job (WF-13). Works in storm and standard mode.
---

# Reply handling

A lead already in the pipeline texted back. The worker gives you the message verbatim, the mode, and the contact id. Everything you draft is a `DRAFT:` note + approval task exactly as in storm-intake, unless the template is in the auto-send flags. STOP keywords and escalation words are handled in code before you run.

## Read first (2 calls, no more)
1. `contacts_get-contact` → tags, `proposed_window`, `proposed_estimator`, `property_address`, `has_photos`, `damage_type`, `next_followup_date`.
2. `opportunities_search-opportunity` for the contact → stage. (Skip if the contact has no `storm-lead` / `new-request` tag — then treat it as a brand-new lead and follow storm-intake instead.)

## Classify the reply (exactly one)
| reply | what you do |
|---|---|
| **confirms a window** ("yes", "that works", "10 works", "see you then") and `proposed_window` is set | Book it: `calendars_get-calendars` once (Estimates calendar), `calendars_create-appointment` {contactId, calendarId, startTime = proposed_window, endTime = +`pack.minutes_per_stop`, title "Estimate – {street}", assignedUserId = estimator's user id if known}. Move opp → `Estimate Scheduled`. Draft **CONFIRM-WINDOW** with `booked_event_id` set to the new appointment id. Tag `window-confirmed`. |
| **confirms but no `proposed_window`** | Draft **ASK-TIME** (we have no window to book). Owner task "Set a window for {name}". |
| **asks for a different time** ("can't do morning", "Thursday instead") | Do not book. Clear nothing. Draft **ASK-TIME** echoing their constraint in the task body (not in the text). Set `next_followup_date` = today. |
| **gives the address** (and `property_address` was empty) | Write `property_address` exactly as typed. If out of service-area.md → OUT-OF-AREA flow from storm-intake. Else continue storm-intake step 7 (opportunity) and draft **ACK-1** (mode version). |
| **sends photos / says photos sent** | Set `has_photos` = Yes; if opp is `New Lead` with address known → `Qualified – Needs Estimate`. Draft **ACK-PHOTOS**. |
| **asks about price** | Draft **PRICE-DEFER** (from pricing-guardrails.md, no numbers). |
| **asks a question the company files answer** (hours, licensed/insured, do you do X, financing yes/no, warranty) | Draft **ANSWER** using only company-profile.md / service-area.md / the trade pack. If the files don't answer it → owner task "Question from {name}: {question}" and draft **HOLD**. |
| **asks where things stand** (opp exists past New Lead) | Follow status-updates for that stage; draft **STATUS-REPLY**. |
| **says they went elsewhere / not interested** | Opp → `Closed Lost`, reason "customer declined". Tag `closed-lost`. No draft. |
| **anything else / unclear** | Draft **HOLD**; owner task "Reply from {name} needs a human: {first 80 chars}". |

Then always: a contact note `REPLY: {classification} | {first 120 chars}` and `last_inbound_at` = now (custom field if it exists).

## Templates (exact; `— {Company}` at the end of every SMS)
- **CONFIRM-WINDOW**: "Great, you're set for {Day} between {window} at {street}. {estimator_first} will text when they're on the way. — {Company}" (carries `booked_event_id`; the day/window come from the booked appointment, nothing else).
- **ASK-TIME**: "No problem. What day and time window works best for you this week or next? We'll match it if we can. — {Company}"
- **ACK-PHOTOS**: "Got the photos, thank you. That helps us plan the visit. — {Company}"
- **PRICE-DEFER**: "{pricing-guardrails price line}. — {Company}"
- **ANSWER**: one or two sentences, facts only from the files, no numbers that look like prices, no dates. "— {Company}"
- **HOLD**: "Thanks — passing this to {owner_first}, who'll get back to you shortly. — {Company}"
- **STATUS-REPLY**: per status-updates.

Storm mode: no exclamation marks, queue language. Standard mode: normal tone.

## Don't
Book without a `proposed_window` or without a calendar id. Invent a day or window. Answer price. Reply to the owner (WF-11 handles the owner). Send anything while mode is test/shadow (the gate decides; you draft).
