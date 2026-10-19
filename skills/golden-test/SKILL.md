---
name: golden-test
description: Acceptance test for a sub-account. Submits three canned leads, runs intake on each, then grades the result against an exact expected outcome and reports PASS/FAIL per check. Run before any customer goes live, after every skill change, and on demand ("run the golden test").
---

# Golden test

Purpose: prove the whole chain works on this sub-account before real homeowners touch it, and catch regressions after edits. It never sends anything: it forces `mode: test` for the duration and restores the previous mode afterward.

## Setup
1. Read `company-profile.md`; record `mode`, then set custom value `mode` = `test`.
2. Confirm `bots_enabled` = `true`, the `ghl` MCP answers `locations_get-location`, and `opportunities_get-pipelines` returns `Storm Response` and `Standard Jobs`. If not → FAIL `preflight` and stop.
3. Load the trade pack named in company-profile (`/workspace/trades/{trade}.md`). If missing → FAIL `trade_pack` and stop.

## The three leads (create via REST `POST /contacts/`, tag each `golden-test`)
Use the owner's phone/email so nothing can reach a stranger even if a gate fails.

| # | Name | Payload | Expected |
|---|---|---|---|
| G1 | Golden Emergency | address inside service area, damage_type = pack's primary type, message "{pack.emergency_phrase}", 2 photos attached, insurance Yes | severity `Emergency`; tags `storm-lead`, `emergency`, `tarp-needed` (or pack's emergency tag), `insurance`, `bot-drafted`; stage `New Lead`; urgency 95–100 (90–100 + 5); template `ACK-1` with the pack's emergency next-step phrase; owner task created and assigned; DRAFT note present; **0 sends** |
| G2 | Golden Minor | address inside service area, damage_type = pack's primary type, message "{pack.minor_phrase}", no photos, insurance No | severity `Minor`; tags `storm-lead`, `needs-photos`, `bot-drafted`; stage `New Lead`; urgency 20–40; template `ASK-PHOTOS`; `next_followup_date` = tomorrow; **0 sends** |
| G3 | Golden Out-of-area | address with a ZIP not in service-area.md, message "roof damage" | tag `out-of-area`; urgency 0; template `OUT-OF-AREA`; **no opportunity created**; **0 sends** |

Each lead is enrolled in WF-02 by adding the tag `storm-lead` (WF-02's tag trigger), which exercises the real webhook path. Wait up to 3 minutes per lead for R1 to finish.

## Grading
For each lead, read the contact back with `contacts_get-contact` and the opportunity with `opportunities_search-opportunity`, then compare every expected item above. Also run these global checks:

- `no_sends`: `conversations_search-conversation` shows zero outbound messages for all three contacts.
- `webhook_latency`: R1 started within 90 s of the tag being added (compare timestamps).
- `fields_complete`: `property_address`, `damage_type`, `damage_severity`, `has_photos`, `insurance_claim`, `lead_source`, `storm_event`, `urgency_score` all non-blank on G1 and G2.
- `one_opportunity`: exactly one open opportunity per contact on G1/G2, zero on G3.
- `template_exact`: DRAFT text equals the pack template with placeholders filled, no extra sentences, no `$`, no `!`, ends with company name.
- `task_assigned`: G1/G2 tasks have `assignedTo` = `owner_user_id`.
- `log_present`: your own R1 log for each lead is 3–8 lines and names test mode.

## Report (post in chat and save as a note on the owner contact)
```
GOLDEN TEST — {company} — {date time}
G1 Emergency   PASS/FAIL  (list failed checks)
G2 Minor       PASS/FAIL
G3 Out-of-area PASS/FAIL
Global         no_sends ✓ latency 42s ✓ fields ✓ one_opp ✓ template ✓ task ✓ log ✓
RESULT: PASS | FAIL (n checks)
```

## Teardown
Delete nothing. Tag the three contacts `golden-test` (already) and close their opportunities as `Closed Lost` with reason "golden test". Restore `mode` to the value recorded in Setup. If the previous mode was `shadow` or `test`, say so in the report so the owner knows the account is not live yet.

## Rules
A FAIL on any check means the sub-account is not live-ready. Never "fix" a result by editing data by hand; fix the skill or the setup, then rerun. Run after every change to any skill file, the snapshot, or the trade pack.
