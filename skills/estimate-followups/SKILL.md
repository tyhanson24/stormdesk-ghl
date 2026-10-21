---
name: estimate-followups
description: Once a day, find estimates that are out with no answer and stage the next follow-up text (day 2 / 5 / 10) as drafts for the owner. Runs on the `followup_sweep` job. Draft-only — every text goes through owner approval unless `auto_estimate_followups` is true.
---

# Estimate follow-ups

Copy below is the cadence from estimate-drafting. **Status: cadence copy pending Ty's sign-off; the daily sweep is not scheduled until he approves it.** When scheduled: 09:00 local, after the brief.

## Find
`opportunities_search-opportunity` pipeline `Standard Jobs` and `Storm Response`, stage `Estimate Sent`. For each, read the contact: `next_followup_date`, `estimate_sent_at` (or the note date of `SENT: EST-SENT`), tags.

Skip: `next_followup_date` in the future, tag `do-not-contact` / `closed-lost` / `unresponsive`, or a `SENT: EST-FU3` note already present, or any inbound from the contact after the estimate went out (they replied — reply-handling owns it).

## Cadence (days since the estimate was sent)
| day | template | text |
|---|---|---|
| 2 | **EST-FU1** | "Hi {first}, did the estimate for {street} come through OK? Happy to walk through any line on it. — {Company}" |
| 5 | **EST-FU2** | "{first}, checking in on the {street} estimate. Material lead times are {pack.lead_time or company-profile current_lead_time} right now, so earlier sign-offs get earlier install dates. — {Company}" |
| 10 | **EST-FU3** | "Last note from us on {street}. If you went another direction, no problem at all — if not, we're here when you're ready. — {Company}" |
| 14 | — | Opp → `Closed Lost`, reason `no response`; tag `unresponsive`; no text. |

If the contact's first name or street address is blank, do not draft: create an owner task "Fill in name/address for {contact} before follow-up" and skip. The send gate blocks any text that still contains a `{placeholder}`, so never guess a value.

Draft the one template that matches today (never two in one day for one contact). Set `next_followup_date` to the next step's date. Note `FOLLOW-UP: EST-FUn drafted`.

## Output
One approval per contact (DRAFT note + task, same as intake). End with SUMMARY: counts per step, who was skipped and why.

## Don't
Mention price, discounts, or a deadline that is not a real material lead time. Text anyone twice in the sweep. Follow up on an estimate the owner hasn't approved sending (no `SENT: EST-SENT` note → skip).
