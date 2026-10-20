# Dispatch — HighLevel plugin for Grok Bot

Gives a Grok Bot structured access to one HighLevel sub-account through the Dispatch gateway (our own MCP server in front of HighLevel's REST API), plus the operating skills a home-service company needs during a storm surge and in normal weeks.

## What it connects

`mcp.json` → `https://jlkkvrvytvydkcahezob.supabase.co/functions/v1/dispatch-hl/mcp` (the Dispatch gateway, see `../platform/README.md`). Auth is the Dispatch key + `locationId` header. The gateway fetches a HighLevel OAuth token for that sub-account from the token broker on every call, so the bot never holds a HighLevel token and there is nothing per-client to create or rotate. HighLevel's own MCP is not used: it only accepts Private Integration Tokens, not marketplace OAuth tokens.

Tools (33, names mirror HighLevel's MCP): `contacts_*` (get-contact, search, create-contact, upsert-contact, update-contact, add-tags, remove-tags, create-note, get-notes, create-task, get-all-tasks, add-to-workflow, remove-from-workflow), `conversations_search-conversation`, `conversations_get-messages`, `conversations_send-a-new-message`, `opportunities_get-pipelines`, `opportunities_search-opportunity`, `opportunities_get-opportunity`, `opportunities_create-opportunity`, `opportunities_update-opportunity`, `calendars_get-calendars`, `calendars_get-calendar-events`, `calendars_get-appointment-notes`, `calendars_create-appointment`, `locations_get-location`, `locations_get-custom-fields`, `locations_get-custom-values`, `locations_update-custom-value`, `locations_get-tags`, `workflows_get-workflows`, `users_get-users`, and `hl_request` (raw REST escape hatch: method, path, query, body). Every REST step in the skills can be done with `hl_request`.

## Install

1. Nothing in the contractor's sub-account. The agency's Dispatch marketplace install covers every sub-account (auto-install on new ones). You only need the Location ID (Settings → Business Profile).
2. Local test: clone this folder to `~/.cursor/plugins/local/dispatch-ghl`, reload Cursor, set `DISPATCH_KEY` and `GHL_LOCATION_ID` under Plugins → Configure.
3. Marketplace: push to a public repo, submit at cursor.com/marketplace/publish. After approval, install from Grok Bot → Plugins, enter the two variables.
4. One plugin install = one sub-account. For multiple contractors on one Grok Bot account, see the agency note in `../RUNBOOK.md` (shared-machine limitation).

## Skills

| Skill | Use |
|---|---|
| ghl-operating-rules | Always loaded first. Pipeline/stage/field names, approval matrix, never-do list. |
| storm-intake | New lead from missed-call text-back, form, or voicemail transcript → qualified opportunity. |
| triage-and-route | Score urgency, group by neighborhood, build the daily estimate route. |
| estimate-drafting | Photos + voice notes → draft estimate + deposit invoice, staged for approval. |
| insurance-claims | FNOL checklist, adjuster tracking, supplement nudges. |
| permits-inspections | County permit submission tracking, inspection scheduling, expiration watch. |
| status-updates | Weekly "where am I in line" texts to every open job. |
| daily-brief | 6:00 AM owner brief: new leads, today's route, stuck deals, cash. |
| reviews-reputation | Review requests at milestones, review replies, GBP posts. |

Do not put real tokens in this repo.
