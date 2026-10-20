// Dispatch — token broker. Office (and later the worker) calls this instead of holding tokens.
//   POST /functions/v1/ghl-token   headers: x-dispatch-key: <DISPATCH_INTERNAL_KEY>
//   body: { "locationId": "..." }   -> { access_token, expires_at, location_id, source }
//   body: { "companyId": "..." }    -> agency token for that company
// Behaviour: returns a fresh token; refreshes if it expires within 5 minutes; if no row exists for a
// location but an agency install covers its company, mints one via /oauth/locationToken and stores it.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { admin, env, refreshToken, mintLocationToken, upsertTenant, json } from "../_shared/ghl.ts";

const SOON_MS = 5 * 60 * 1000;

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  if (req.headers.get("x-dispatch-key") !== env("DISPATCH_INTERNAL_KEY")) return json(401, { error: "bad key" });
  const { locationId, companyId } = await req.json().catch(() => ({}));
  if (!locationId && !companyId) return json(400, { error: "locationId or companyId required" });
  const db = admin();

  async function fresh(row: any): Promise<{ token: string; expires_at: string; source: string }> {
    const expiresAt = new Date(row.expires_at).getTime();
    if (expiresAt - Date.now() > SOON_MS && row.status === "installed") {
      return { token: row.access_token, expires_at: row.expires_at, source: "cache" };
    }
    if (row.refresh_token === "agency-derived") {
      // Minted from the agency token: re-mint instead of refreshing.
      const { data: a } = await db.from("decrypted_tenants").select("*").eq("kind", "agency").eq("company_id", row.company_id).eq("status", "installed").maybeSingle();
      if (!a) throw new Error("agency install missing for re-mint");
      const af = await fresh(a);
      const t = await mintLocationToken(af.token, a.company_id, row.location_id);
      t.userType = "Location"; t.companyId ??= a.company_id; t.locationId ??= row.location_id; t.refresh_token ??= "agency-derived";
      await upsertTenant(db, t, "location_token");
      return { token: t.access_token, expires_at: new Date(Date.now() + (t.expires_in - 60) * 1000).toISOString(), source: "location_token" };
    }
    try {
      const t = await refreshToken(row.refresh_token, row.kind === "agency" ? "Company" : "Location");
      t.companyId ??= row.company_id; t.locationId ??= row.location_id; t.userType ??= row.kind === "agency" ? "Company" : "Location";
      await upsertTenant(db, t, "refresh");
      return { token: t.access_token, expires_at: new Date(Date.now() + (t.expires_in - 60) * 1000).toISOString(), source: "refresh" };
    } catch (e) {
      await db.from("tenants").update({ last_error: String(e) }).eq("id", row.id);
      await db.from("tenant_events").insert({ tenant_id: row.id, location_id: row.location_id, company_id: row.company_id, event: "refresh_failed", detail: { error: String(e) } });
      throw e;
    }
  }

  try {
    if (companyId) {
      const { data: row } = await db.from("decrypted_tenants").select("*").eq("kind", "agency").eq("company_id", companyId).maybeSingle();
      if (!row) return json(404, { error: "no agency install for company" });
      const f = await fresh(row);
      return json(200, { access_token: f.token, expires_at: f.expires_at, company_id: companyId, source: f.source });
    }

    const { data: row } = await db.from("decrypted_tenants").select("*").eq("location_id", locationId).maybeSingle();
    if (row && row.status === "installed") {
      const f = await fresh(row);
      return json(200, { access_token: f.token, expires_at: f.expires_at, location_id: locationId, source: f.source });
    }

    // No direct install: derive from an agency install. We try every agency row (there is normally one).
    const { data: agencies } = await db.from("decrypted_tenants").select("*").eq("kind", "agency").eq("status", "installed");
    for (const a of agencies ?? []) {
      try {
        const af = await fresh(a);
        const t = await mintLocationToken(af.token, a.company_id, locationId);
        t.userType = "Location"; t.companyId ??= a.company_id; t.locationId ??= locationId;
        // locationToken responses may omit refresh_token; keep a placeholder so the row is valid, and re-mint on expiry.
        t.refresh_token ??= "agency-derived";
        await upsertTenant(db, t, "location_token");
        return json(200, { access_token: t.access_token, expires_at: new Date(Date.now() + (t.expires_in - 60) * 1000).toISOString(), location_id: locationId, source: "location_token" });
      } catch (e) {
        console.error("locationToken via agency", a.company_id, e);
      }
    }
    return json(404, { error: "no install covers this location", locationId });
  } catch (e) {
    return json(502, { error: String(e) });
  }
});
