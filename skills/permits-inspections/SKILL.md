---
name: permits-inspections
description: Submit and track building permits on county portals, schedule inspections the moment a job is ready, watch for failed inspections and expirations, and keep permit_status in HighLevel current. Use daily for any opportunity in Signed – Awaiting Permit or later.
---

# Permits and inspections

## Inputs
- Opps in `Signed – Awaiting Permit`, `Scheduled for Install`, `In Progress`, `Complete – Collect`.
- `/workspace/permits.md` — per-county portal URL, login (secure store), form name for re-roof / fence, fee, typical turnaround, emergency/post-disaster rules in effect, inspection types required and how to request them.
- Contact fields: property_address, permit_number, permit_status, permit_expires, inspection_date.

## Daily routine
1. **Post-disaster rules check** (storm mode only): open each county's building department page and note any emergency permit waivers, expedited processes, or fee changes. If changed since `/workspace/permits.md`, tell the owner and propose the edit.
2. **To Submit**: for each opp with `permit_status = To Submit`, fill the county form from contact + estimate data (owner/contractor license, address, parcel #, scope, valuation from the signed estimate). Stop at the pay/submit step → approval with fee amount. On approval: submit, capture permit number, set `permit_status = Submitted`, `permit_expires` if shown.
3. **Submitted**: check portal status. Approved → `permit_status = Approved`, move opp to `Scheduled for Install`, add task for dispatcher. Rejected/comments → copy the reviewer's comment into a contact note, flag owner.
4. **Ready for inspection**: when a crew marks the job (crew texts "done {street}" to the company number → WF-10 webhook, or opp → `Complete – Collect`), request the inspection the same day. Set `inspection_date`, `permit_status = Inspection Scheduled`. Text the homeowner the window.
5. **Failed**: read the inspector's notes, draft the correction plan + crew task, set `permit_status = Failed`, flag owner. Re-request after crew confirms.
6. **Expiring**: any permit within 14 days of `permit_expires` and not Passed → flag owner with the extension link.

## Fence specifics
- Pull parcel/setback info from county GIS and note HOA requirement. If HOA exists, add contact task "HOA approval" and draft the ARC request from the estimate.
- Create the 811 locate ticket 3 business days before install (approval).

## Don't
Pay a fee without showing the amount. Submit under a license number not in company-profile. Guess a parcel number.
