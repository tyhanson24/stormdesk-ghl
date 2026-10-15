---
name: daily-brief
description: 6:00 AM owner brief — new leads overnight, today's emergency and estimate route, stuck deals, approvals waiting, cash collected/outstanding, and anything that blocked the bot. Use daily; also "give me the brief" on demand.
---

# Daily brief

Keep it under 25 lines. Owner reads it in the truck.

## Pull
- New contacts/opps since yesterday 6 AM (count by source, by severity).
- Unanswered inbound conversations older than 2 hours.
- Today's calendar: Emergency/Tarp, Estimates, Insurance Meetings, Installs.
- Opps with `next_followup_date` ≤ today.
- Stuck: Estimate Sent > 10 days, Awaiting Insurance > 14 days with no note, Awaiting Permit > 7 days Submitted, permits expiring ≤ 14 days.
- Payments: `payments_list-transactions` last 24h; `Complete – Collect` opps with no payment > 7 days.
- Approvals queued by the other bots.

## Format
```
STORMDESK BRIEF – {Day, date} – {Company}
NEW: {n} leads overnight ({emergency} emergency, {major} major) · {unanswered} unanswered > 2h
TODAY: {n} tarps · {n} estimates ({estimator}: {n}) · {n} installs · {n} adjuster meetings
APPROVALS WAITING: {n} texts, {n} estimates, {n} permit fees (${total}) → reply APPROVE ALL or open the queue
STUCK: {list ≤5, one line each, oldest first}
CASH: collected ${x} yesterday · ${y} outstanding on {n} completed jobs
BLOCKED: {logins expired / portal down / missing price book line}
```
Send as SMS + email to the owner via `conversations_send-a-new-message` on the owner's contact record (tag `owner`), and post in the bot chat.
