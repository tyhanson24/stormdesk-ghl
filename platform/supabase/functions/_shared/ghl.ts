// Shared HighLevel OAuth helpers for Dispatch edge functions.
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

export const HL_AUTH_URL = "https://marketplace.gohighlevel.com/oauth/chooselocation";
export const HL_TOKEN_URL = "https://services.leadconnectorhq.com/oauth/token";
export const HL_LOCATION_TOKEN_URL = "https://services.leadconnectorhq.com/oauth/locationToken";
export const HL_VERSION = "2021-07-28";

export const env = (k: string): string => {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`Missing env ${k}`);
  return v;
};

export const SCOPES = [
  "contacts.readonly", "contacts.write",
  "conversations.readonly", "conversations.write",
  "conversations/message.readonly", "conversations/message.write",
  "opportunities.readonly", "opportunities.write",
  "calendars.readonly", "calendars.write",
  "calendars/events.readonly", "calendars/events.write",
  "locations.readonly", "locations.write",
  "locations/customValues.readonly", "locations/customValues.write",
  "locations/customFields.readonly",
  "locations/tags.readonly", "locations/tags.write",
  "forms.readonly", "users.readonly", "workflows.readonly",
  "snapshots.readonly", "oauth.readonly", "oauth.write",
];

export type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
  userType?: "Company" | "Location";
  companyId?: string;
  locationId?: string;
  userId?: string;
};

export function admin(): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });
}

export async function exchangeCode(code: string, redirectUri: string, userType: "Company" | "Location"): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: env("GHL_CLIENT_ID"),
    client_secret: env("GHL_CLIENT_SECRET"),
    grant_type: "authorization_code",
    code,
    user_type: userType,
    redirect_uri: redirectUri,
  });
  const r = await fetch(HL_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error(`token exchange ${r.status}: ${await r.text()}`);
  return await r.json();
}

export async function refreshToken(refresh: string, userType: "Company" | "Location"): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: env("GHL_CLIENT_ID"),
    client_secret: env("GHL_CLIENT_SECRET"),
    grant_type: "refresh_token",
    refresh_token: refresh,
    user_type: userType,
  });
  const r = await fetch(HL_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error(`refresh ${r.status}: ${await r.text()}`);
  return await r.json();
}

export async function mintLocationToken(agencyAccessToken: string, companyId: string, locationId: string): Promise<TokenResponse> {
  const body = new URLSearchParams({ companyId, locationId });
  const r = await fetch(HL_LOCATION_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Bearer ${agencyAccessToken}`, Version: HL_VERSION },
    body,
  });
  if (!r.ok) throw new Error(`locationToken ${r.status}: ${await r.text()}`);
  return await r.json();
}

export async function upsertTenant(db: SupabaseClient, t: TokenResponse, source: string) {
  const kind = t.userType === "Company" ? "agency" : "location";
  const row = {
    kind,
    company_id: t.companyId ?? "",
    location_id: kind === "location" ? t.locationId : null,
    status: "installed",
    scopes: (t.scope ?? "").split(" ").filter(Boolean),
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: new Date(Date.now() + (t.expires_in - 60) * 1000).toISOString(),
    user_type: t.userType ?? null,
    last_refresh_at: new Date().toISOString(),
    last_error: null,
    uninstalled_at: null,
  };
  const onConflict = kind === "location" ? "location_id" : undefined;
  let q = db.from("tenants").upsert(row, onConflict ? { onConflict } : undefined).select("id").single();
  if (kind === "agency") {
    // one agency row per company_id: update if exists, else insert
    const { data: existing } = await db.from("tenants").select("id").eq("kind", "agency").eq("company_id", row.company_id).maybeSingle();
    q = existing
      ? db.from("tenants").update(row).eq("id", existing.id).select("id").single()
      : db.from("tenants").insert(row).select("id").single();
  }
  const { data, error } = await q;
  if (error) throw error;
  await db.from("tenant_events").insert({ tenant_id: data.id, location_id: row.location_id, company_id: row.company_id, event: source, detail: { scopes: row.scopes, user_type: row.user_type } });
  return data.id as string;
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
