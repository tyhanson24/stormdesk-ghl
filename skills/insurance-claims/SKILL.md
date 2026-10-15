---
name: insurance-claims
description: Track insurance jobs from first notice of loss through supplement approval — homeowner FNOL checklist, adjuster contact capture, carrier portal status, 3-day adjuster nudges, supplement drafts. Use for any opportunity tagged insurance.
---

# Insurance claims

## Inputs
- Opps tagged `insurance` in stages `Signed – Awaiting Insurance` (and earlier if `insurance_claim = Yes`).
- Contact fields: carrier, claim_number, adjuster_*.
- `/workspace/carriers.md` — portal URLs, typical response times, known quirks per carrier.
- Carrier portal logins are in the bot's secure credential store, never in chat.

## Steps
**A. Homeowner side (right after intake if insurance_claim = Yes/Unsure)**
1. Stage `FNOL-CHECKLIST` text: "Since this may be an insurance claim, here's what helps: 1) call your carrier to open the claim (number on your policy card), 2) text us the claim number and adjuster's name/phone when you have them, 3) keep all receipts (tarps, hotel, etc.). We'll handle the rest with the adjuster. — {Company}"
2. When claim_number arrives → update fields, add contact task "Confirm adjuster inspection date."

**B. Adjuster side**
3. If adjuster inspection date known → create a calendar event on the Insurance Meetings calendar so the estimator can be on site. Draft `ADJ-INTRO` email to the adjuster: who we are, license #, that we'll meet them on site, our scope attached. Always approve.
4. After adjuster scope is received: compare to our estimate line by line. List missing/under-scoped items. Draft the supplement request with photo references. Always approve.
5. Nudge cadence: no response from adjuster in 3 business days → draft a polite nudge. Max 3 nudges, then flag owner to call.

**C. Status**
6. Weekly: check carrier portal (browser) for claim status; update a contact note with date-stamped status. Don't paste portal contents into chat beyond status + amounts.
7. When approved → move opp to `Signed – Awaiting Permit` (or `Scheduled for Install` if no permit) and stage the homeowner text: "Good news — your carrier approved the scope. Next: {permit/materials}. We'll text the install window soon. — {Company}"

## Don't
Tell a homeowner what the carrier will pay or that a claim "will be approved." Submit anything to a carrier without approval. Argue with an adjuster — draft, the owner sends. Store policy numbers in chat.
