---
name: triage-and-route
description: Build tomorrow's estimate route and today's emergency/tarp list from Storm Response opportunities, grouped by neighborhood and ordered by urgency, then stage appointment texts. Use nightly or on demand ("build the route").
---

# Triage and route

## Inputs
- `opportunities_search-opportunity` in `Storm Response`, stages `Qualified – Needs Estimate` and `New Lead` with `emergency` tag.
- `calendars_get-calendar-events` for the Estimates and Tarp Crew calendars (next 2 days).
- `/workspace/company-profile.md` → estimators (name, phone, start ZIP, max stops/day, hours).

## Steps
1. Pull open opps + contact fields (address, urgency_score, damage_severity, has_photos, insurance_claim).
2. **Emergency list** (today): every `emergency`/`tarp-needed`, ordered by urgency_score desc. Output table: name, address, phone, severity note, photos Y/N.
3. **Estimate route** (tomorrow): remaining Qualified leads. Cluster by ZIP/subdivision (use street + ZIP; don't geocode via external paid APIs unless a plugin exists). Within a cluster order by urgency_score. Cap at `max_stops` per estimator; spill to day+2. Assume 25–30 min per stop in storm mode.
4. Assign 2-hour windows (8–10, 10–12, 1–3, 3–5). Keep clusters contiguous.
5. For each stop, write `proposed_window` (ISO start of the window) and `proposed_estimator` to the contact, then stage SMS `EST-WINDOW`: "Hi {first}, {Company} here. We can come look at {street} {Day} between {window}. Reply YES to confirm or send a better time. Someone 18+ should be home; we'll be about 20 min. — {Company}"
6. If `auto_book_estimates: true` in company-profile: create the calendar appointment on confirmation reply. Otherwise stage for owner approval and let the GHL workflow `WF-04 Estimate Confirmed` book it on "YES".
7. Move confirmed opps → `Estimate Scheduled`. Unconfirmed after 24h → `next_followup_date` +1 and re-stage once; after 2 tries tag `unresponsive`.
8. Stage one SMS per estimator (approval) with their stops in drive order and a Google Maps multi-stop link (addresses joined with `/`). Also save the route as a note on the owner's contact record.

## Output format (always)
```
TODAY – EMERGENCY (n)
1. Smith – 123 Oak St, Gulf Breeze – active leak, photos Y – 850-555-0101
...
TOMORROW – ESTIMATES – {Estimator} (n stops)
8–10  Jones – 45 Bay Blvd (Tiger Point)
8–10  Lee – 52 Bay Blvd (Tiger Point)
10–12 ...
Waiting on: 4 leads with no address, 7 no photos
```

## Don't
Double-book a window. Put Emergency stops on the estimate route (they go to the crew). Send route texts before approval unless auto-book is on.
