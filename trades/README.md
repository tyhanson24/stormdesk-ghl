# Trade packs

One file per trade. `company-profile.md` names the trade(s); every skill loads `/workspace/trades/{trade}.md` and uses its values wherever a template says `{pack.*}`. Multi-trade companies list several; `damage_type` on each lead picks the pack.

Every pack defines the same keys so skills never branch on trade name:

| key | used by |
|---|---|
| `primary_type`, `damage_types` | intake, forms |
| `emergency_rule`, `major_rule`, `minor_rule` | intake severity |
| `emergency_tag`, `emergency_next_step` | intake, triage |
| `photo_guidance` | ASK-PHOTOS, form |
| `trade_noun`, `job_noun`, `crew_noun` | all templates |
| `minutes_per_stop`, `max_stops_day` | triage-and-route |
| `insurance_applies`, `permit_applies`, `inspection_applies` | claims, permits, status |
| `skip_stages` | status-updates, pipeline moves |
| `price_book_categories` | estimate-drafting |
| `escalation_words_extra` | send-gate |
| `golden.emergency_phrase`, `golden.minor_phrase` | golden-test |

Adding a trade = copy `roofing.md`, change the values, add the form to the snapshot.
