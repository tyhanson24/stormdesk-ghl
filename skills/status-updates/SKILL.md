---
name: status-updates
description: Send every open job a short "where you stand" text on a weekly cadence (and immediately on stage change) so homeowners stop calling for updates. Use weekly (storm mode: Mon + Thu) and on stage-change webhooks.
---

# Status updates

Most inbound calls after a storm are "where am I in line?" Answer before they ask.

## Steps
1. Pull all open opps in `Storm Response` and `Standard Jobs`, stages 2–10.
2. Compute `queue_position` per stage group (by date entered stage, Emergency first). Write it to the contact.
3. Skip anyone with `last_status_text_sent` < 3 days ago unless their stage changed.
4. Draft per stage (one message, no price, no promise beyond what's in the fields):
   - Qualified – Needs Estimate: "You're #{n} for an estimate visit. We're texting windows {X} days out right now."
   - Estimate Sent: "Your estimate is waiting on your OK. Reply with questions anytime."
   - Signed – Awaiting Insurance: "We're working with {carrier} on your scope. Last update: {date}. We'll text when it moves."
   - Signed – Awaiting Permit: "Permit {submitted/approved} with {county}. Materials arrive ~{date}."
   - Scheduled for Install: "Install {date}. Crew arrives ~{time}. Please clear driveway/patio."
   - In Progress: "Crew on site today. Expected completion {date}."
   - Complete – Collect: "Job complete. Final inspection {date}. Invoice: {link}."
5. Stage all as one batch for approval (show count per stage + 2 samples). Owner approves the batch, not each text — unless `status_texts_auto: true`, in which case send.
6. Update `last_status_text_sent`. Tag `bot-sent`.

## Don't
Send to anyone who replied "stop/unsubscribe" (GHL DND respects this; double-check). Send more than 2 per week. Include numbers you can't verify from a field.
