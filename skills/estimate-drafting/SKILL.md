---
name: estimate-drafting
description: Turn an estimator's photos, voice-note transcript, and measurements into a draft estimate document + line items in the company's estimate template, staged for owner approval. Use after an estimate appointment is marked complete.
---

# Estimate drafting

Owner/estimator does the roof. You do the paperwork. You never set a price on your own — you fill the template from the estimator's numbers and the company's price book.

## Inputs
- Appointment note (`calendars_get-appointment-notes`) or the WF-05 webhook payload (routine R5) containing: squares/linear feet, material, tear-off layers, decking notes, pitch, special items, photos.
- `/workspace/price-book.md` — unit prices per line item (owner-maintained). If a line isn't in the price book, leave the price blank and flag it.
- `/workspace/estimate-template.md` — the layout, terms, deposit %, payment terms, warranty text.
- Contact fields: property_address, insurance_claim, carrier, claim_number.

## Steps
1. Parse the note into line items. Keep estimator's quantities exactly; if a quantity is missing, ask one question, don't guess.
2. Price each line from the price book. Show the math per line (qty × unit).
3. Apply storm-mode adders only if the price book defines them (e.g., "debris haul surcharge"). Never invent a surcharge.
4. Build the estimate as markdown (then PDF if the company's doc tool is connected). Include: scope, line items, total, deposit due, timeline language ("scheduled after permit approval and material delivery; current lead time: {from company-profile}"), warranty, what's excluded, insurance note if applicable.
5. Insurance jobs: add the line "This estimate is prepared to match the adjuster's scope where possible; supplements for hidden damage will be submitted to your carrier." Do not state what the carrier will pay.
6. Stage for approval with a 3-line summary: total, deposit, anything flagged.
7. On approval: attach to the contact (note with the file link), move opp → `Estimate Sent`, set `next_followup_date` = +2 days, stage the delivery text `EST-SENT`: "Hi {first}, your estimate for {street} is ready: {link}. Questions — reply here or call {owner_phone}. — {Company}"
8. Follow-up cadence (Standard and Storm): day 2 `EST-FU1` ("Did the estimate come through OK? Happy to walk through it."), day 5 `EST-FU2` ("Checking in — material lead times are {X} right now, so earlier signatures get earlier install dates."), day 10 `EST-FU3` ("Last note from us on this one. If you went another direction no problem — if not, we're here."). Then `Closed Lost` with reason `no response`.

## Don't
Quote outside the price book. Round totals to look nicer. Promise an install date. Email the homeowner a price before owner approval.
