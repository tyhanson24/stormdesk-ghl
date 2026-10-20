# Dispatch platform — OAuth app + token store

Private HighLevel Marketplace app. Only Ty's agency installs it; clients are sub-accounts under that agency. Replaces per-client Private Integration tokens.

## Pieces
- `supabase/migrations/0001_tenants.sql` — `tenants` (encrypted tokens, one row per install) + `tenant_events` (audit).
- `supabase/functions/dispatch-oauth` — `/install` (redirect to HighLevel consent), `/callback` (code → tokens → tenants), `/webhook` (INSTALL/UNINSTALL events).
- `supabase/functions/dispatch-token` — token broker. Office / worker POST `{locationId}` with `x-dispatch-key` and get a fresh access token. Refreshes automatically; mints sub-account tokens from the agency install when no direct install exists.
- `supabase/functions/dispatch-hl` — **the gateway Office actually uses.** `POST /mcp` is a Dispatch-served MCP server (33 tools, names mirror HighLevel's MCP, plus `hl_request` for raw REST); `/api/<path>` is a raw REST pass-through. Caller sends `Authorization: Bearer <DISPATCH_INTERNAL_KEY>` + `locationId` header; the gateway gets a token from the broker per request. Built because HighLevel's own MCP only accepts Private Integration Tokens, not marketplace OAuth tokens.

## One-time setup
1. Supabase project `Dispatch` (us-east-1). Apply the migration. Deploy both functions with `verify_jwt=false` (they authenticate themselves).
2. Function secrets: `GHL_CLIENT_ID`, `GHL_CLIENT_SECRET`, `PUBLIC_BASE_URL` (`https://<ref>.supabase.co`), `DISPATCH_INTERNAL_KEY` (random 32+ chars). `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.
3. marketplace.gohighlevel.com (separate developer login, not the agency login) → My Apps → Create App:
   - Name `Dispatch` · Type **Private** · Target user **Sub-account** · Who can install **Agency only** · Listing **White-label**
   - Auth → Scopes: the list in `functions/_shared/ghl.ts` (`SCOPES`, 25). Save button sits off-screen below 1200px wide.
   - Redirect URL: `https://<ref>.supabase.co/functions/v1/dispatch-oauth/callback` — white-label rule: the URL must not contain "ghl" or "highlevel".
   - Webhook URL (optional now): `https://<ref>.supabase.co/functions/v1/dispatch-oauth/webhook`
   - Manage → Secrets → Client Keys → Add → copy Client ID + Secret into the function secrets above.
   - Manage → Versions → ⋮ on the draft → **Publish**. Private apps skip review and go live immediately; until this is done OAuth returns "No integration found".
4. Install on the agency once: open `https://<ref>.supabase.co/functions/v1/dispatch-oauth/install?kind=agency`, approve, and on the last screen keep **Install under all locations** and tick **Enable automatic installation to future locations**. That single install covers every sub-account under it, including ones created later by `setup-customer`.
5. Office: the plugin's `mcp.json` points the `ghl` MCP at `/functions/v1/dispatch-hl/mcp` with plugin variables `DISPATCH_KEY` (= `DISPATCH_INTERNAL_KEY`) and `GHL_LOCATION_ID`. For agency-level work (`setup-customer`): `POST /functions/v1/dispatch-token {"companyId":"<agency>"}` with `x-dispatch-key` → agency access token.

## Per-client (zero steps)
None. `setup-customer` creates the sub-account from the snapshot with the agency token, then asks `dispatch-token` for a location token; the broker mints it from the agency install.

## Status (2026-10-20)
- Live: project `jlkkvrvytvydkcahezob`, both functions deployed, app `6ad6bfa4f15bd83fc063fc73` published (private), agency install done (company `MVaqjpBWfuyQDY1cZjKl`, 25 scopes).
- Verified: broker minted a token for the Dispatch sub-account from the agency install (`source: location_token`), token read the location + contacts (200), second call served from cache; bad key → 401.
- `ghl-oauth` / `ghl-token` are 410 stubs — delete from the dashboard.
- TODO: callback page is served as `text/plain` by the gateway despite the `text/html` header (cosmetic); delete the `company_id='TEST'` tenants row (marked uninstalled); webhook signature check.

## Security notes
- Tokens are pgsodium-encrypted at rest with key `dispatch_tenant_tokens` (created by the migration — the placeholder zero key id does not exist and breaks every insert); only the service role reads `decrypted_tenants`.
- Webhook signature verification (HighLevel `x-wh-signature`) is a TODO before go-live.
- Private app cap: 5 agencies. We use 1. If other agencies ever need it, that is the Public-listing decision, not a code change.
- Rotate: delete the old sub-account PIT (`pit-us-737e…`) and the chat-pasted agency PIT once this is live.
