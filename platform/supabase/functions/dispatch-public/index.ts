// Dispatch — public pages (no auth). Linked from each client's A2P campaign, web form, and website footer.
//   GET /functions/v1/dispatch-public/sms-terms/<location_id>   SMS terms & conditions for that client
//   GET /functions/v1/dispatch-public/privacy/<location_id>     Privacy policy for that client
// Company name / contact come from tenants.settings (set by dispatch-setup) and company-profile.md. Nothing else is exposed.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { admin, env } from "../_shared/ghl.ts";
import { policyUrls, privacyHtml, smsTermsHtml } from "../_shared/a2p.ts";

const html = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });

Deno.serve(async (req) => {
  if (req.method !== "GET") return new Response("GET only", { status: 405 });
  const m = new URL(req.url).pathname.match(/\/dispatch-public\/(sms-terms|privacy)\/([A-Za-z0-9]{10,40})\/?$/);
  if (!m) return html(404, "<!doctype html><title>Not found</title><p>Not found.");
  const [, kind, loc] = m;
  const db = admin();
  const { data: t } = await db.from("tenants").select("settings").eq("location_id", loc).maybeSingle();
  if (!t) return html(404, "<!doctype html><title>Not found</title><p>Not found.");
  const s = t.settings ?? {};
  const { data: f } = await db.from("tenant_files").select("content").eq("location_id", loc).eq("path", "company-profile.md").maybeSingle();
  const prof = f?.content ?? "";
  const company = String(s.company_name ?? prof.match(/^# Company profile — (.+)$/m)?.[1] ?? "This company").trim();
  const address = prof.match(/^local_address:\s*"?([^"\n]*)"?/m)?.[1]?.trim() || undefined;
  const phone = s.sms_number ?? s.owner_phone ?? undefined;
  const email = s.owner_email ?? undefined;
  const urls = policyUrls(env("PUBLIC_BASE_URL"), loc);
  return html(200, kind === "privacy" ? privacyHtml(company, phone, email, address) : smsTermsHtml(company, phone, email, urls.privacy));
});
