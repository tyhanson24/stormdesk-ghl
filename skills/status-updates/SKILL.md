---
name: status-updates
description: Send every open job a short "where you stand" text on a weekly cadence (and immediately on stage change) so homeowners stop calling for updates. Use weekly (storm mode: Mon + Thu) and on stage-change webhooks.
---

# Status updates

Most inbound calls after a storm are "where am I in line?" Answer before they ask.

## Steps
1. Pull all open opps in `Storm Response` and `Standard Jobs`, every stage from `Qualified – Needs Estimate` through `Complete – Collect` (by name).
2. Compute `queue_position` per stage group (by date entered stage, Emergency first). Write it to the contact.
3. Skip anyone with `last_status_text_sent` < 3 days ago unless their stage changed.
4. Draft per stage (one message, no price, no promise beyond what's in the fields):
   - Qualified – Needs Estimate: "You're #{n} in line for an estimate visit. We'll text your window as soon as it's set."
   - Estimate Sent: "Your estimate is waiting on your OK. Reply with questions anytime."
   - Signed – Awaiting Insurance: "We're working with {carrier} on your scope. We'll text the moment it moves."
   - Signed – Awaiting Permit: "Permit {submitted/approved} with {county}. We'll confirm your install date once materials are confirmed."
   - Scheduled for Install: "Install {booked calendar date — only if an appointment exists}. Crew arrives ~{time}. Please clear driveway/patio."
   - In Progress: "Crew on site today. We'll text when the work is complete."
   - Complete – Collect: "Job complete. {Final inspection {date} — only if booked.} Invoice: {link}."
5. Stage all as one batch for approval (show count per stage + 2 samples). Owner approves the batch, not each text — unless `status_texts_auto: true`, in which case send. Stage-change texts count toward the 2-per-contact-per-week cap; when `status_texts_auto` is false they join the next batch instead of going out immediately.
6. Update `last_status_text_sent`. Tag `bot-sent`.

## Don't
Send to anyone who replied "stop/unsubscribe" (GHL DND respects this; double-check). Send more than 2 per week. Include numbers you can't verify from a field.
