# Dispatch platform — OAuth app + token store

Private HighLevel Marketplace app. Only Ty's agency installs it; clients are sub-accounts under that agency. Replaces per-client Private Integration tokens.

## Pieces
- `supabase/migrations/0001_tenants.sql` — `tenants` (encrypted tokens, one row per install) + `tenant_events` (audit).
- `supabase/functions/ghl-oauth` — `/install` (redirect to HighLevel consent), `/callback` (code → tokens → tenants), `/webhook` (INSTALL/UNINSTALL events).
- `supabase/functions/ghl-token` — token broker. Office / worker POST `{locationId}` with `x-dispatch-key` and get a fresh access token. Refreshes automatically; mints sub-account tokens from the agency install when no direct install exists.

## One-time setup
1. Supabase project `Dispatch` (us-east-1). Apply the migration. Deploy both functions with `verify_jwt=false` (they authenticate themselves).
2. Function secrets: `GHL_CLIENT_ID`, `GHL_CLIENT_SECRET`, `PUBLIC_BASE_URL` (`https://<ref>.supabase.co`), `DISPATCH_INTERNAL_KEY` (random 32+ chars). `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.
3. marketplace.gohighlevel.com → My Apps → Create App:
   - Name `Dispatch` · Type **Private** · Target user **Sub-account** · Who can install **Both Agency & Sub-account** · Listing **White-label**
   - Auth → Scopes: the list in `functions/_shared/ghl.ts` (`SCOPES`)
   - Redirect URL: `https://<ref>.supabase.co/functions/v1/ghl-oauth/callback`
   - Webhook URL (optional now): `https://<ref>.supabase.co/functions/v1/ghl-oauth/webhook`
   - Manage → Secrets → Client Keys → Add → copy Client ID + Secret into the function secrets above.
4. Install on the agency once: open `https://<ref>.supabase.co/functions/v1/ghl-oauth/install?kind=agency`, pick the PIVOT agency, approve. That single install covers every sub-account under it.
5. Office: store `DISPATCH_INTERNAL_KEY` and `DISPATCH_TOKEN_URL` as secrets. `setup-customer` and every routine fetch tokens with:
   `POST $DISPATCH_TOKEN_URL  {"locationId": "..."}  header x-dispatch-key` → use `access_token` as the Bearer for both the HighLevel MCP and REST.

## Per-client (zero steps)
None. `setup-customer` creates the sub-account from the snapshot with the agency token, then asks `ghl-token` for a location token; the broker mints it from the agency install.

## Security notes
- Tokens are pgsodium-encrypted at rest; only the service role reads `decrypted_tenants`.
- Webhook signature verification (HighLevel `x-wh-signature`) is a TODO before go-live.
- Private app cap: 5 agencies. We use 1. If other agencies ever need it, that is the Public-listing decision, not a code change.
- Rotate: delete the old sub-account PIT (`pit-us-737e…`) and the chat-pasted agency PIT once this is live.
