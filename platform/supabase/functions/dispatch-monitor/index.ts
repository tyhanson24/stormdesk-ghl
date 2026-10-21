// Dispatch — platform monitor. pg_cron calls this every 5 minutes (tick_monitor). It evaluates the alert rules below
// against the database + a live gateway probe, keeps one open row per alert key in platform_alerts, auto-resolves
// what cleared, and notifies Ty (platform_settings.alerts → his own contact record) at most once per renotify window.
//   POST /functions/v1/dispatch-monitor   header x-dispatch-key   body {} | {dry_run: true}
// Alerts only ever go to the configured contact (Ty). Clients are never messaged from here.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { admin, env, json } from "../_shared/ghl.ts";

type Sev = "info" | "warn" | "crit";
type Found = { key: string; severity: Sev; title: string; detail?: Record<string, unknown>; location_id?: string | null };
const RANK: Record<Sev, number> = { info: 0, warn: 1, crit: 2 };
const BUDGET_USD_PER_DAY = 25;      // per sub-account model spend before a warn
const QUEUE_STUCK_SEC = 600;        // runnable job older than this with no worker activity
const AUTO_RESOLVE_PREFIX = ["cv_read|", "queue_stuck", "worker_silent", "failure_spike", "token_refresh|", "token_expired|", "carrier_block|", "gateway_down", "budget|", "uninstalled|", "dead_jobs"];

// Read one sub-account's custom values through the gateway (the token broker → HighLevel). Returns {cv} or {error}.
async function readCv(loc: string): Promise<{ cv?: Record<string, string>; error?: string }> {
  try {
    const r = await fetch(`${env("PUBLIC_BASE_URL")}/functions/v1/dispatch-hl/mcp`, {
      method: "POST", headers: { "content-type": "application/json", "x-dispatch-key": env("DISPATCH_INTERNAL_KEY"), locationId: loc },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "locations_get-custom-values", arguments: {} } }), signal: AbortSignal.timeout(20_000),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) return { error: `HTTP ${r.status}` };
    if (j?.error) return { error: String(j.error.message ?? j.error) };
    if (j?.result?.isError) return { error: String(j.result.content?.[0]?.text ?? "tool error").slice(0, 200) };
    const cv: Record<string, string> = {};
    for (const v of JSON.parse(j.result.content[0].text).customValues ?? []) cv[v.name] = String(v.value ?? "");
    return { cv };
  } catch (e) { return { error: String((e as Error)?.message ?? e).slice(0, 200) }; }
}
// Mirror custom values into tenant_cv for the console (never exposes *key* values).
async function refreshTenantCv(db: ReturnType<typeof admin>, locs: string[]): Promise<Record<string, string>> {
  const errors: Record<string, string> = {};
  await Promise.all(locs.map(async (loc) => {
    const r = await readCv(loc);
    if (r.error) { errors[loc] = r.error; await db.from("tenant_cv").upsert({ location_id: loc, error: r.error, checked_at: new Date().toISOString() }, { onConflict: "location_id" }); return; }
    const cv = r.cv!;
    const safe = Object.fromEntries(Object.entries(cv).filter(([k]) => !/key/i.test(k)));
    await db.from("tenant_cv").upsert({ location_id: loc, mode: cv.mode ?? null, bots_enabled: (cv.bots_enabled ?? "").toLowerCase() === "true", company_name: cv.company_name ?? null, trade: cv.trade ?? null, a2p_status: cv.a2p_status ?? null, custom_values: safe, error: null, checked_at: new Date().toISOString() }, { onConflict: "location_id" });
  }));
  return errors;
}

async function probeGateway(loc: string): Promise<string | null> {
  try {
    const r = await fetch(`${env("PUBLIC_BASE_URL")}/functions/v1/dispatch-hl/mcp`, {
      method: "POST", headers: { "content-type": "application/json", "x-dispatch-key": env("DISPATCH_INTERNAL_KEY"), locationId: loc },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "locations_get-custom-values", arguments: {} } }), signal: AbortSignal.timeout(20_000),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) return `HTTP ${r.status}`;
    if (j?.error) return String(j.error.message ?? j.error);
    if (j?.result?.isError) return String(j.result.content?.[0]?.text ?? "tool error").slice(0, 200);
    return null;
  } catch (e) { return String((e as Error)?.message ?? e).slice(0, 200); }
}

async function evaluate(db: ReturnType<typeof admin>, alertLoc: string): Promise<Found[]> {
  const out: Found[] = [];
  const [{ data: q }, { data: dead }, { data: tenants }, { data: blocks }, { data: usage }] = await Promise.all([
    db.from("queue_status").select("*").single(),
    db.from("jobs").select("id, kind, location_id, last_error, finished_at").eq("status", "dead").gte("finished_at", new Date(Date.now() - 24 * 3600e3).toISOString()).order("finished_at", { ascending: false }).limit(20),
    db.from("tenants").select("location_id, company_id, kind, status, expires_at, last_error, last_refresh_at, settings").in("kind", ["location", "agency"]),
    db.from("tenant_events").select("location_id, detail, created_at").eq("event", "carrier_block").gte("created_at", new Date(Date.now() - 7 * 864e5).toISOString()),
    db.from("usage_daily").select("location_id, day, model_cost_usd, runs").eq("day", new Date().toISOString().slice(0, 10)),
  ]);
  const qs: any = q ?? {};
  // 1 dead jobs (one alert, listing ids; re-raised as new ones die because the key includes the newest id)
  if ((dead ?? []).length) {
    const newest = dead![0];
    out.push({ key: `dead_jobs|${newest.id}`, severity: "crit", title: `${dead!.length} dead job${dead!.length > 1 ? "s" : ""} in 24h (newest ${newest.kind} @ ${newest.location_id}: ${String(newest.last_error ?? "").slice(0, 120)})`, detail: { jobs: dead!.map((d: any) => ({ id: d.id, kind: d.kind, location_id: d.location_id, error: String(d.last_error ?? "").slice(0, 200) })) }, location_id: newest.location_id });
  }
  // 2 queue stuck / worker silent
  if ((qs.runnable ?? 0) > 0 && (qs.oldest_runnable_seconds ?? 0) > QUEUE_STUCK_SEC) {
    const silentMin = qs.last_run_started ? Math.round((Date.now() - new Date(qs.last_run_started).getTime()) / 60000) : null;
    out.push({ key: "queue_stuck", severity: "crit", title: `${qs.runnable} runnable job(s) waiting ${Math.round(qs.oldest_runnable_seconds / 60)} min; last worker run ${silentMin === null ? "never" : silentMin + " min ago"}`, detail: qs });
  }
  // 3 failure spike
  if ((qs.failed_1h ?? 0) >= 3 && qs.failed_1h / Math.max(1, qs.runs_1h) >= 0.5) out.push({ key: "failure_spike", severity: "warn", title: `${qs.failed_1h}/${qs.runs_1h} runs failed in the last hour`, detail: { failed: qs.failed_1h, runs: qs.runs_1h } });
  // 4 tokens
  for (const t of tenants ?? []) {
    if (t.status !== "installed") { if (t.kind === "location" && t.location_id) out.push({ key: `uninstalled|${t.location_id}`, severity: "warn", title: `app ${t.status} on ${t.settings?.company_name ?? t.location_id}`, location_id: t.location_id }); continue; }
    const id = t.location_id ?? `agency:${t.company_id}`;
    if (t.last_error) out.push({ key: `token_refresh|${id}`, severity: "crit", title: `token refresh failing for ${t.settings?.company_name ?? id}: ${String(t.last_error).slice(0, 120)}`, location_id: t.location_id });
    else if (t.expires_at && new Date(t.expires_at).getTime() < Date.now() - 3600e3) out.push({ key: `token_expired|${id}`, severity: "crit", title: `token for ${t.settings?.company_name ?? id} expired ${Math.round((Date.now() - new Date(t.expires_at).getTime()) / 3600e3)} h ago and was not refreshed`, location_id: t.location_id });
    // 5 carrier pause (open while sms_paused is set)
    if (t.settings?.sms_paused) out.push({ key: `carrier_block|${t.location_id}`, severity: "crit", title: `SMS paused on ${t.settings?.company_name ?? id}: ${t.settings.sms_paused.reason}`, detail: { since: t.settings.sms_paused.at, recent: (blocks ?? []).filter((b: any) => b.location_id === t.location_id).length }, location_id: t.location_id });
  }
  // 6 budget
  for (const u of usage ?? []) if (Number(u.model_cost_usd) > BUDGET_USD_PER_DAY) out.push({ key: `budget|${u.location_id}|${u.day}`, severity: "warn", title: `${u.location_id} spent $${Number(u.model_cost_usd).toFixed(2)} on the model today (${u.runs} runs)`, detail: u, location_id: u.location_id });
  // 7 gateway probe (through the token broker → HighLevel) — doubles as the tenant_cv refresh for the console.
  const locs = (tenants ?? []).filter((t: any) => t.kind === "location" && t.status === "installed" && t.location_id).map((t: any) => t.location_id as string);
  const cvErrors = await refreshTenantCv(db, locs);
  const err = cvErrors[alertLoc] ?? (locs.includes(alertLoc) ? null : await probeGateway(alertLoc));
  if (err) out.push({ key: "gateway_down", severity: "crit", title: `gateway/broker probe failed: ${err}`, detail: { location_id: alertLoc } });
  for (const [loc, e] of Object.entries(cvErrors)) if (loc !== alertLoc) out.push({ key: `cv_read|${loc}`, severity: "warn", title: `cannot read custom values for ${(tenants ?? []).find((t: any) => t.location_id === loc)?.settings?.company_name ?? loc}: ${e}`, location_id: loc });
  return out;
}

// What each rule means and what Ty does about it (mirrors platform/RUNBOOK.md).
const RUNBOOK: Record<string, { what: string; fix: string }> = {
  dead_jobs:     { what: "A job failed 5 times and stopped retrying. The lead/owner it was for got nothing.", fix: "Open the run in the dashboard, fix the cause, then re-queue: update jobs set status='queued', attempts=0 where id=…" },
  queue_stuck:   { what: "Jobs are waiting but the worker is not picking them up.", fix: "Check Supabase → Edge Functions → dispatch-worker logs and the pg_cron job dispatch-worker-tick; POST /dispatch-worker with the internal key to kick it." },
  failure_spike: { what: "Most runs in the last hour failed.", fix: "Look at the newest failed run's error in the dashboard; usually the model API or HighLevel is erroring." },
  token_refresh: { what: "The HighLevel token for this account cannot be refreshed; every call to it is failing.", fix: "Reinstall the app on that sub-account (dispatch-oauth/install) — the broker heals itself on the next call." },
  token_expired: { what: "The HighLevel token expired and was never refreshed.", fix: "Same as token refresh: reinstall the app on that sub-account." },
  carrier_block: { what: "Homeowner texting is paused because sends were failing at the carrier.", fix: "Check the number / A2P status in Trust Center, fix it, then dispatch_sms-resume." },
  gateway_down:  { what: "The gateway or token broker is not answering.", fix: "Check Supabase status and the dispatch-hl / dispatch-token logs." },
  budget:        { what: "Model spend for this account is above the daily budget.", fix: "Check the dashboard for a job loop (same contact over and over); raise the budget in dispatch-monitor if it is legitimate." },
  cv_read:       { what: "The platform could not read this sub-account's settings from HighLevel.", fix: "Usually a token problem on that sub-account: reinstall the app there." },
  uninstalled:   { what: "The Dispatch app is no longer installed on this sub-account — nothing runs for it.", fix: "Reinstall from the agency or confirm the client is gone and set tenants.status accordingly." },
};
const ruleOf = (key: string) => key.split("|")[0];
const SEV_COLOR: Record<string, string> = { crit: "#b42318", warn: "#b54708", info: "#175cd3" };
const SEV_BG: Record<string, string> = { crit: "#fef3f2", warn: "#fffaeb", info: "#eff8ff" };

async function notify(db: ReturnType<typeof admin>, cfg: any, alerts: any[]): Promise<string> {
  // Company names instead of location ids.
  const { data: tenants } = await db.from("tenants").select("location_id, settings").eq("kind", "location");
  const nameOf = (loc?: string | null) => (tenants ?? []).find((t: any) => t.location_id === loc)?.settings?.company_name ?? loc ?? "platform";
  const crit = alerts.filter((a) => a.severity === "crit").length, warn = alerts.filter((a) => a.severity === "warn").length;
  const headline = [crit ? `${crit} critical` : "", warn ? `${warn} warning${warn > 1 ? "s" : ""}` : ""].filter(Boolean).join(", ") || `${alerts.length} alert${alerts.length > 1 ? "s" : ""}`;
  const where = [...new Set(alerts.map((a) => nameOf(a.location_id)))].join(", ");
  const subject = `Dispatch: ${headline} — ${where}`.slice(0, 120);
  const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: cfg.timezone ?? "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const sms = `Dispatch: ${headline}\n` + alerts.slice(0, 3).map((a) => `• ${nameOf(a.location_id)}: ${RUNBOOK[ruleOf(a.key)]?.what ?? a.title}`).join("\n").slice(0, 400) + (alerts.length > 3 ? `\n+${alerts.length - 3} more` : "") + "\nDetails in your email.";
  const cards = alerts.map((a) => {
    const rb = RUNBOOK[ruleOf(a.key)] ?? { what: a.title, fix: "See platform/RUNBOOK.md." };
    return `<tr><td style="padding:0 0 14px 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e4e7ec;border-left:4px solid ${SEV_COLOR[a.severity] ?? "#667085"};border-radius:8px;background:#fff">
<tr><td style="padding:14px 16px">
<div style="font:600 11px/1 -apple-system,Segoe UI,Roboto,sans-serif;letter-spacing:.06em;color:${SEV_COLOR[a.severity]};background:${SEV_BG[a.severity]};display:inline-block;padding:4px 8px;border-radius:999px">${a.severity.toUpperCase()}</div>
<div style="font:600 16px/1.35 -apple-system,Segoe UI,Roboto,sans-serif;color:#101828;margin:10px 0 4px">${esc(nameOf(a.location_id))}</div>
<div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#344054">${esc(rb.what)}</div>
<div style="font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#344054;margin-top:10px"><b>What to do:</b> ${esc(rb.fix)}</div>
<div style="font:12px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#667085;margin-top:10px">${esc(a.title)}<br>Since ${esc(when(a.first_seen))}${a.count > 1 ? ` · seen ${a.count}×` : ""}</div>
</td></tr></table></td></tr>`;
  }).join("");
  const html = `<!doctype html><html><body style="margin:0;background:#f2f4f7;padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">
<tr><td style="padding:0 0 16px 0;font:600 20px/1.3 -apple-system,Segoe UI,Roboto,sans-serif;color:#101828">Dispatch — ${esc(headline)}</td></tr>
${cards}
<tr><td style="padding:8px 0 0 0;font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#667085">Sent ${esc(when(new Date().toISOString()))}. You get one email per new alert; repeats at most every ${Math.round(Number(cfg.renotify_minutes ?? 360) / 60)} h while it stays open. Full picture: the Dispatch admin dashboard.</td></tr>
</table></td></tr></table></body></html>`;
  const results: string[] = [];
  for (const ch of (cfg.channels ?? ["Email"]) as string[]) {
    const body = ch === "Email" ? { type: "Email", contactId: cfg.contact_id, subject, html, ...(cfg.email_from ? { emailFrom: cfg.email_from } : {}) } : { type: "SMS", contactId: cfg.contact_id, message: sms };
    try {
      const r = await fetch(`${env("PUBLIC_BASE_URL")}/functions/v1/dispatch-hl/mcp`, {
        method: "POST", headers: { "content-type": "application/json", "x-dispatch-key": env("DISPATCH_INTERNAL_KEY"), locationId: cfg.location_id },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "conversations_send-a-new-message", arguments: body } }), signal: AbortSignal.timeout(30_000),
      });
      const j = await r.json().catch(() => null);
      const text = String(j?.result?.content?.[0]?.text ?? j?.error?.message ?? r.status);
      let messageId: string | null = null; try { messageId = JSON.parse(text).messageId ?? null; } catch { /* non-JSON */ }
      const ok = r.ok && !j?.error && !j?.result?.isError;
      await db.from("outbound_log").insert({ location_id: cfg.location_id, contact_id: cfg.contact_id, channel: ch, template: "PLATFORM-ALERT", text_hash: "platform", verdict: ok ? "sent" : "error", detail: ok ? `platform alert digest (${alerts.length})` : text.slice(0, 300), message_id: messageId, delivery_status: ok ? "pending" : null });
      results.push(`${ch}: ${ok ? "sent" : "error " + text.slice(0, 80)}`);
    } catch (e) { results.push(`${ch}: ${String((e as Error)?.message ?? e).slice(0, 80)}`); }
  }
  return results.join(" · ");
}
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  const key = req.headers.get("x-dispatch-key") ?? (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (key !== env("DISPATCH_INTERNAL_KEY")) return json(401, { error: "bad key" });
  const body = await req.json().catch(() => ({}));
  const db = admin();
  const { data: cfgRow } = await db.from("platform_settings").select("value").eq("key", "alerts").maybeSingle();
  const cfg = cfgRow?.value ?? {};
  if (!cfg.location_id || !cfg.contact_id) return json(500, { error: "platform_settings.alerts missing location_id/contact_id" });

  const found = await evaluate(db, cfg.location_id);
  const now = new Date().toISOString();
  const { data: open } = await db.from("platform_alerts").select("*").is("resolved_at", null);
  const openByKey = new Map((open ?? []).map((a: any) => [a.key, a]));
  const raised: string[] = [], resolved: string[] = [];
  if (!body.dry_run) {
    for (const f of found) {
      const cur = openByKey.get(f.key);
      if (cur) await db.from("platform_alerts").update({ last_seen: now, count: cur.count + 1, title: f.title, detail: f.detail ?? cur.detail, severity: f.severity }).eq("id", cur.id);
      else { await db.from("platform_alerts").insert({ key: f.key, severity: f.severity, title: f.title, detail: f.detail ?? {}, location_id: f.location_id ?? null }); raised.push(f.key); }
    }
    const activeKeys = new Set(found.map((f) => f.key));
    for (const a of open ?? []) {
      if (activeKeys.has(a.key)) continue;
      if (AUTO_RESOLVE_PREFIX.some((p) => a.key === p || a.key.startsWith(p))) { await db.from("platform_alerts").update({ resolved_at: now }).eq("id", a.id); resolved.push(a.key); }
    }
  }
  // Notify: open alerts at/above min severity that were never notified or whose renotify window passed.
  let notified = "";
  if (!body.dry_run) {
    const minRank = RANK[(cfg.min_severity as Sev) ?? "warn"] ?? 1;
    const renotifyMs = Number(cfg.renotify_minutes ?? 360) * 60_000;
    const { data: due } = await db.from("platform_alerts").select("*").is("resolved_at", null).order("severity").order("first_seen");
    const toSend = (due ?? []).filter((a: any) => RANK[a.severity as Sev] >= minRank && (!a.last_notified_at || Date.now() - new Date(a.last_notified_at).getTime() > renotifyMs));
    if (toSend.length) {
      notified = await notify(db, cfg, toSend);
      for (const a of toSend) await db.from("platform_alerts").update({ last_notified_at: now, notify_result: notified }).eq("id", a.id);
    }
  }
  return json(200, { ok: true, found: found.map((f) => ({ key: f.key, severity: f.severity, title: f.title })), raised, resolved, notified: notified || null, dry_run: !!body.dry_run });
});
