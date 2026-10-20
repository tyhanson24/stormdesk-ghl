// Dispatch — HighLevel OAuth: install link, callback, app webhooks.
// Routes (all under /functions/v1/ghl-oauth):
//   GET  /install?kind=agency|location   -> 302 to HighLevel consent screen
//   GET  /callback?code=...               -> exchange code, store tenant, show a done page
//   POST /webhook                         -> HighLevel app events (INSTALL / UNINSTALL)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { admin, env, exchangeCode, upsertTenant, json, HL_AUTH_URL, SCOPES } from "../_shared/ghl.ts";

const html = (title: string, body: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title>
<style>body{font:16px/1.5 -apple-system,Segoe UI,sans-serif;max-width:560px;margin:12vh auto;padding:0 16px;color:#111}h1{font-size:22px}code{background:#f3f4f6;padding:2px 6px;border-radius:4px}</style>
<h1>${title}</h1>${body}`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/ghl-oauth/, "") || "/";
  const redirectUri = `${env("PUBLIC_BASE_URL")}/functions/v1/ghl-oauth/callback`;

  if (req.method === "GET" && path === "/install") {
    const kind = url.searchParams.get("kind") === "agency" ? "agency" : "location";
    const state = crypto.randomUUID();
    const authUrl = new URL(HL_AUTH_URL);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("client_id", env("GHL_CLIENT_ID"));
    authUrl.searchParams.set("scope", SCOPES.join(" "));
    authUrl.searchParams.set("state", `${kind}:${state}`);
    return Response.redirect(authUrl.toString(), 302);
  }

  if (req.method === "GET" && path === "/callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? "location:";
    if (!code) return html("Install failed", "<p>No authorization code was returned by HighLevel.</p>");
    const userType = state.startsWith("agency") ? "Company" : "Location";
    try {
      const tok = await exchangeCode(code, redirectUri, userType);
      const db = admin();
      const id = await upsertTenant(db, tok, "install");
      const where = tok.userType === "Company" ? `agency <code>${tok.companyId}</code>` : `sub-account <code>${tok.locationId}</code>`;
      return html("Dispatch is connected", `<p>Installed on ${where}.</p><p>You can close this tab. Dispatch will finish setting up your account; nothing is sent to your customers until your account is switched live.</p><p style="color:#6b7280;font-size:13px">ref ${id}</p>`);
    } catch (e) {
      console.error("callback", e);
      return html("Install failed", `<p>${(e as Error).message.replace(/</g, "&lt;")}</p><p>Try the install link again. If it keeps failing, tell Ty.</p>`);
    }
  }

  if (req.method === "POST" && path === "/webhook") {
    // HighLevel app lifecycle events. Signature verification (x-wh-signature, HL public key) to be added before go-live.
    const body = await req.json().catch(() => ({}));
    const type = String(body?.type ?? "");
    const db = admin();
    const locationId = body?.locationId ?? null;
    const companyId = body?.companyId ?? null;
    if (type === "UNINSTALL") {
      if (locationId) {
        await db.from("tenants").update({ status: "uninstalled", uninstalled_at: new Date().toISOString() }).eq("location_id", locationId);
      } else if (companyId) {
        await db.from("tenants").update({ status: "uninstalled", uninstalled_at: new Date().toISOString() }).eq("kind", "agency").eq("company_id", companyId);
      }
    }
    await db.from("tenant_events").insert({ location_id: locationId, company_id: companyId, event: `webhook:${type || "unknown"}`, detail: body });
    return json(200, { ok: true });
  }

  return json(404, { error: "not found", path });
});
