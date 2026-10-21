---
name: daily-brief
description: 6:00 AM owner brief — new leads overnight, today's emergency and estimate route, stuck deals, approvals waiting, cash collected/outstanding, and anything that blocked the bot. Use daily; also "give me the brief" on demand.
---

# Daily brief

The task gives you the mode and the health line (from the code health check); the health line's failing checks are the BLOCKED line. Storm mode leads with the queue; standard mode leads with the pipeline and today's visits.

Keep it under 25 lines. Owner reads it in the truck.

## Pull
- New contacts/opps since yesterday 6 AM (count by source, by severity).
- Unanswered inbound conversations older than 2 hours.
- Today's calendar: Emergency/Tarp, Estimates, Insurance Meetings, Installs.
- Opps with `next_followup_date` ≤ today.
- Stuck: Estimate Sent > 10 days, Awaiting Insurance > 14 days with no note, Awaiting Permit > 7 days Submitted, permits expiring ≤ 14 days.
- Payments: `payments_list-transactions` last 24h; `Complete – Collect` opps with no payment > 7 days.
- Approvals queued by the other bots.

## Format — storm mode
```
DISPATCH BRIEF – {Day, date} – {Company}
NEW: {n} leads overnight ({emergency} emergency, {major} major) · {unanswered} unanswered > 2h
TODAY: {n} tarps · {n} estimates ({estimator}: {n}) · {n} installs · {n} adjuster meetings
APPROVALS WAITING: {n} texts, {n} estimates, {n} permit fees (${total}) → reply APPROVE ALL or open the queue
STUCK: {list ≤5, one line each, oldest first}
CASH: collected ${x} yesterday · ${y} outstanding on {n} completed jobs
BLOCKED: {logins expired / portal down / missing price book line}
```
## Format — standard mode
```
DISPATCH BRIEF – {Day, date} – {Company}
NEW: {n} requests since yesterday ({repair} repair, {quote} quotes, {maintenance} maintenance, {warranty} warranty) · {unanswered} unanswered > 2h
TODAY: {n} estimates ({estimator}: {n}) · {n} jobs · {n} inspections
APPROVALS WAITING: {n} texts, {n} estimates → reply APPROVE ALL or open the queue
FOLLOW UP: {n} estimates out > 5 days with no answer · {n} due today
STUCK: {list ≤5, one line each, oldest first}
CASH: collected ${x} yesterday · ${y} outstanding on {n} completed jobs
BLOCKED: {health line failures, or "nothing"}
```
Skip any line whose count is zero except NEW and APPROVALS WAITING.

Send as SMS + email to the owner via `conversations_send-a-new-message` on the owner's contact record (tag `owner`), and post in the bot chat.
