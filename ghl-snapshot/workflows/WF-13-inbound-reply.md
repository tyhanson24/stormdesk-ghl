# WF-13 Inbound Reply → Bot
Purpose: a lead or customer who is already in the pipeline texts back (confirms a window, sends the address/photos, asks a question). WF-02 only fires for contacts created in the last day; this one covers everyone else. The worker runs `reply-handling` (kind `inbound_reply`). Not yet in a snapshot: add to the Dispatch template, publish, re-snapshot (v5), then existing clients get it via `locations_update-custom-value` `wh_reply` + a manual copy of the workflow.

Trigger: Customer Replied — channel SMS (add FB/IG/GBP if the sub-account uses them)
Filters (all):
- Contact tag includes `storm-lead` OR `new-request`
- Contact tag does NOT include `owner`, `crew`, `do-not-contact`
- Contact created more than 1 day ago (WF-02 owns day-one replies) — if the builder has no "created before" filter, leave it out; the worker's dedupe key is per contact + message, so both firing is harmless.
Allow re-entry: yes (every reply)

1. Webhook action: POST {{custom_values.wh_reply}}
   Header: Authorization: Bearer {{custom_values.bot_webhook_key_intake}}
   Body (JSON):
   {"event":"inbound_reply","location_id":"{{location.id}}","contact_id":"{{contact.id}}","name":"{{contact.name}}","phone":"{{contact.phone}}","message":"{{message.body}}","message_id":"{{message.id}}","link":"https://app.gohighlevel.com/v2/location/{{location.id}}/contacts/detail/{{contact.id}}"}
2. End.

Notes
- STOP / UNSUBSCRIBE etc. still go through WF-12 (opt-out) first; the worker also catches them in code on this path.
- Custom value `wh_reply` = `{PUBLIC_BASE_URL}/functions/v1/dispatch-ingest/inbound_reply` (dispatch-setup writes it; health check warns when it is missing).
