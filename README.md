# StormDesk — HighLevel plugin for Grok Bot

Gives a Grok Bot structured access to one HighLevel sub-account through HighLevel's official MCP server, plus the operating skills a home-service company needs during a storm surge and in normal weeks.

## What it connects

`mcp.json` → `https://services.leadconnectorhq.com/mcp/` (HighLevel's first-party MCP, universal endpoint). Auth is a sub-account Private Integration Token + `locationId` header. The token's scopes are the bot's ceiling — give it only what the skills need.

Tools available through the MCP (depends on scopes): `contacts_*` (get, search, create, upsert, update, add/remove tags, tasks), `conversations_search-conversation`, `conversations_get-messages`, `conversations_send-a-new-message`, `opportunities_get-pipelines`, `opportunities_search-opportunity`, `opportunities_get-opportunity`, `opportunities_update-opportunity`, `calendars_get-calendar-events`, `calendars_get-appointment-notes`, `locations_get-location`, `locations_get-custom-fields`, `payments_*` (read).

## Install

1. In the contractor's sub-account: Settings → Private Integrations → create token with the scopes listed in `.cursor-plugin/plugin.json`. Copy the token and the Location ID (Settings → Business Profile).
2. Local test: clone this folder to `~/.cursor/plugins/local/stormdesk-ghl`, reload Cursor, set `GHL_PIT` and `GHL_LOCATION_ID` under Plugins → Configure.
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
