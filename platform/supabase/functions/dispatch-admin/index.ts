// Dispatch — admin API (read-only). Feeds Ty's dashboard page. Separate key (DISPATCH_ADMIN_KEY) so the page can
// never write or reach HighLevel; everything comes from our own tables plus one cached custom-values read per tenant.
//   GET /functions/v1/dispatch-admin/overview            queue, tenants (mode, compliance, today/7d usage), open alerts, recent failures
//   GET /functions/v1/dispatch-admin/tenant/<loc>        last runs, sends, approvals, consents, events for one sub-account
//   GET /functions/v1/dispatch-admin/run/<job_run_id>    full step transcript of one run
//   GET /functions/v1/dispatch-admin/alerts?all=1        open (or all recent) platform alerts
//   GET /functions/v1/dispatch-admin/usage?days=30       usage_daily rows
// Auth: header x-dispatch-admin-key or ?key=. CORS open (the key is the auth; the page runs on claude.ai).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { admin, env } from "../_shared/ghl.ts";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "x-dispatch-admin-key, content-type", "access-control-allow-methods": "GET, OPTIONS" };
const out = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });

// mode / bots_enabled / a2p_status live in HighLevel custom values; read through the gateway, cache 2 min per isolate.
const cvCache = new Map<string, { at: number; cv: Record<string, string> }>();
async function customValues(loc: string): Promise<Record<string, string>> {
  const hit = cvCache.get(loc);
  if (hit && Date.now() - hit.at < 120_000) return hit.cv;
  try {
    const r = await fetch(`${env("PUBLIC_BASE_URL")}/functions/v1/dispatch-hl/mcp`, {
      method: "POST", headers: { "content-type": "application/json", "x-dispatch-key": env("DISPATCH_INTERNAL_KEY"), locationId: loc },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "locations_get-custom-values", arguments: {} } }), signal: AbortSignal.timeout(15_000),
    });
    const j = await r.json();
    const cv: Record<string, string> = {};
    for (const v of JSON.parse(j.result.content[0].text).customValues ?? []) cv[v.name] = String(v.value ?? "");
    cvCache.set(loc, { at: Date.now(), cv });
    return cv;
  } catch (e) { return { _error: String((e as Error)?.message ?? e).slice(0, 120) }; }
}

async function overview(db: ReturnType<typeof admin>) {
  const today = new Date().toISOString().slice(0, 10);
  const since7 = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const [{ data: q }, { data: tenants }, { data: usage }, { data: alerts }, { data: fails }, { data: a2p }, { data: nums }, { data: pend }, { data: cfg }] = await Promise.all([
    db.from("queue_status").select("*").single(),
    db.from("tenants").select("location_id, company_id, kind, status, expires_at, last_error, last_refresh_at, settings, created_at").order("created_at"),
    db.from("usage_daily").select("*").gte("day", since7),
    db.from("platform_alerts").select("*").is("resolved_at", null).order("first_seen", { ascending: false }),
    db.from("job_runs").select("id, job_id, attempt, started_at, finished_at, status, error, summary, jobs!inner(kind, location_id)").in("status", ["failed", "blocked"]).order("started_at", { ascending: false }).limit(15),
    db.from("a2p_registrations").select("location_id, brand_status, campaign_status, updated_at"),
    db.from("numbers").select("location_id, number, kind, verified, status, purpose"),
    db.from("approvals").select("location_id").eq("status", "pending"),
    db.from("platform_settings").select("key, value, updated_at"),
  ]);
  const locs = (tenants ?? []).filter((t: any) => t.kind === "location" && t.location_id);
  const cvs = await Promise.all(locs.map((t: any) => customValues(t.location_id)));
  const pendingBy: Record<string, number> = {};
  for (const p of pend ?? []) pendingBy[p.location_id] = (pendingBy[p.location_id] ?? 0) + 1;
  const rows = locs.map((t: any, i: number) => {
    const cv = cvs[i];
    const u = (usage ?? []).filter((x: any) => x.location_id === t.location_id);
    const sum = (k: string, f: (x: any) => boolean = () => true) => u.filter(f).reduce((a: number, x: any) => a + Number(x[k] ?? 0), 0);
    const td = (x: any) => x.day === today;
    return {
      location_id: t.location_id, company: t.settings?.company_name ?? cv.company_name ?? t.location_id, status: t.status, trade: t.settings?.trade ?? cv.trade,
      mode: cv.mode ?? null, bots_enabled: cv.bots_enabled ?? null, cv_error: cv._error ?? null,
      token: { expires_at: t.expires_at, last_refresh_at: t.last_refresh_at, last_error: t.last_error },
      compliance: { a2p: (a2p ?? []).find((a: any) => a.location_id === t.location_id) ?? null, numbers: (nums ?? []).filter((n: any) => n.location_id === t.location_id), sms_paused: t.settings?.sms_paused ?? null, sms_number: t.settings?.sms_number ?? null },
      pending_approvals: pendingBy[t.location_id] ?? 0,
      today: { runs: sum("runs", td), failed: sum("runs_failed", td), cost: sum("model_cost_usd", td), sent: sum("sent", td), shadow: sum("shadow", td), blocked: sum("blocked", td), undelivered: sum("undelivered", td) },
      week: { runs: sum("runs"), failed: sum("runs_failed"), cost: sum("model_cost_usd"), sent: sum("sent"), shadow: sum("shadow"), blocked: sum("blocked"), undelivered: sum("undelivered"), input_tokens: sum("input_tokens"), output_tokens: sum("output_tokens") },
      welcome: t.settings?.welcome_at ?? null, a2p_packet_at: t.settings?.a2p_packet_at ?? null,
    };
  });
  const agency = (tenants ?? []).find((t: any) => t.kind === "agency" && t.status === "installed");
  return {
    now: new Date().toISOString(), queue: q, agency: agency ? { company_id: agency.company_id, expires_at: agency.expires_at, last_error: agency.last_error } : null,
    tenants: rows, alerts: alerts ?? [], failures: (fails ?? []).map((f: any) => ({ ...f, kind: f.jobs?.kind, location_id: f.jobs?.location_id, jobs: undefined })),
    usage: (usage ?? []).sort((a: any, b: any) => a.day < b.day ? -1 : 1), settings: cfg ?? [],
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return out(405, { error: "GET only" });
  const url = new URL(req.url);
  const key = req.headers.get("x-dispatch-admin-key") ?? url.searchParams.get("key") ?? "";
  if (!key || key !== env("DISPATCH_ADMIN_KEY")) return out(401, { error: "bad key" });
  const path = url.pathname.replace(/^.*\/dispatch-admin/, "") || "/";
  const db = admin();
  try {
    if (path === "/overview") return out(200, await overview(db));
    const m = path.match(/^\/tenant\/([A-Za-z0-9]+)$/);
    if (m) {
      const loc = m[1];
      const [{ data: runs }, { data: sends }, { data: approvals }, { data: consents }, { data: events }, { data: files }, { data: tenant }] = await Promise.all([
        db.from("job_runs").select("id, job_id, attempt, started_at, finished_at, status, input_tokens, output_tokens, summary, error, jobs!inner(kind, location_id, payload)").eq("jobs.location_id", loc).order("started_at", { ascending: false }).limit(40),
        db.from("outbound_log").select("id, created_at, contact_id, channel, template, verdict, detail, delivery_status, delivery_error, from_number").eq("location_id", loc).order("created_at", { ascending: false }).limit(60),
        db.from("approvals").select("n, status, contact_name, template, channel, text, created_at, decided_at, detail").eq("location_id", loc).order("n", { ascending: false }).limit(40),
        db.from("consents").select("status, source, created_at, contact_id").eq("location_id", loc).order("created_at", { ascending: false }).limit(40),
        db.from("tenant_events").select("event, detail, created_at").eq("location_id", loc).order("created_at", { ascending: false }).limit(40),
        db.from("tenant_files").select("path, updated_at").eq("location_id", loc),
        db.from("tenants").select("status, expires_at, last_refresh_at, last_error, settings, scopes").eq("location_id", loc).maybeSingle(),
      ]);
      const cv = await customValues(loc);
      const safeSettings = { ...(tenant?.settings ?? {}) }; delete (safeSettings as any).ingest_key; delete (safeSettings as any).ein;
      return out(200, { location_id: loc, tenant: tenant ? { ...tenant, settings: safeSettings } : null, custom_values: Object.fromEntries(Object.entries(cv).filter(([k]) => !/key/i.test(k))),
        runs: (runs ?? []).map((r: any) => ({ ...r, kind: r.jobs?.kind, jobs: undefined })), sends, approvals, consents, events, files });
    }
    const r = path.match(/^\/run\/(\d+)$/);
    if (r) { const { data } = await db.from("job_runs").select("*, jobs!inner(kind, location_id, payload, status, attempts, last_error)").eq("id", Number(r[1])).maybeSingle(); return data ? out(200, data) : out(404, { error: "no such run" }); }
    if (path === "/alerts") { const q = db.from("platform_alerts").select("*").order("first_seen", { ascending: false }).limit(100); const { data } = url.searchParams.get("all") ? await q : await q.is("resolved_at", null); return out(200, data ?? []); }
    if (path === "/usage") { const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days") ?? 30))); const { data } = await db.from("usage_daily").select("*").gte("day", new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)).order("day"); return out(200, data ?? []); }
    return out(404, { error: "routes: /overview /tenant/<loc> /run/<id> /alerts /usage" });
  } catch (e) { return out(500, { error: String((e as Error)?.message ?? e) }); }
});
