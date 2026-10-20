// Dispatch — setup-customer. Turns an intake-form answer set into a working, test-mode sub-account.
//   POST /functions/v1/dispatch-setup   header x-dispatch-key (or Bearer DISPATCH_INTERNAL_KEY)
//   body (all strings unless noted):
//     company_name*  trade*  owner_first*  owner_last*  owner_phone*  owner_email
//     phone  website  address1  city  state  postal_code  timezone (default America/Chicago)
//     service_zips (array or comma string)  license_number  business_hours  google_profile  review_link
//     auto_ack (bool; "auto-send 3 basic replies" → true)  storm_event  ein (digits; stored in tenant settings for the A2P packet)
//     location_id   — reuse an existing sub-account instead of creating one (re-runs are idempotent)
//     snapshot_id   — default SNAPSHOT_ID below;  company_id — default PIVOT agency
//     dry_run (bool) — validate + plan only
// Does, in order: create sub-account from snapshot (agency token) → wait for the snapshot to land → tenant row +
// ingest key → owner contact → custom values (all 17, template keys never survive) → tenant_files → summary of
// what is left for Ty (owner user, phone number + A2P, golden test, welcome).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { admin, env, json, HL_VERSION } from "../_shared/ghl.ts";

const HL = "https://services.leadconnectorhq.com";
const COMPANY_ID = "MVaqjpBWfuyQDY1cZjKl";          // PIVOT agency
const SNAPSHOT_ID = "iIvtMHToswxykXgyB0G8";         // Dispatch v0.1
const TEMPLATE_LOCATION = "LTiwIPoSI1YNEcSyzYzf";   // never touch

type Log = { step: string; ok: boolean; detail?: unknown }[];

async function brokerToken(body: Record<string, string>) {
  const r = await fetch(`${env("PUBLIC_BASE_URL")}/functions/v1/dispatch-token`, {
    method: "POST", headers: { "content-type": "application/json", "x-dispatch-key": env("DISPATCH_INTERNAL_KEY") }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`broker ${r.status}: ${await r.text()}`);
  return (await r.json()).access_token as string;
}

async function hl(token: string, method: string, path: string, body?: unknown, query?: Record<string, unknown>) {
  const u = new URL(HL + path);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  const r = await fetch(u, { method, headers: { Authorization: `Bearer ${token}`, Version: HL_VERSION, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data: any = text; try { data = JSON.parse(text); } catch { /* text */ }
  if (!r.ok) throw Object.assign(new Error(`HighLevel ${r.status} ${method} ${path}: ${typeof data === "string" ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300)}`), { status: r.status, data });
  return data;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ingestKey = () => "ik_" + [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const e164 = (p: string) => { const d = String(p ?? "").replace(/\D/g, ""); return d.length === 10 ? `+1${d}` : d.length === 11 && d.startsWith("1") ? `+${d}` : String(p ?? "").trim(); };
const zips = (v: unknown): string[] => (Array.isArray(v) ? v : String(v ?? "").split(/[\s,;]+/)).map((z) => String(z).trim()).filter((z) => /^\d{5}$/.test(z));

function files(b: any, ownerContactId: string, locName: string) {
  const zipList = zips(b.service_zips);
  const trade = String(b.trade).toLowerCase();
  const company = String(b.company_name).trim();
  const owner = `${b.owner_first} ${b.owner_last}`.trim();
  const auto = b.auto_ack === true || /auto/i.test(String(b.auto_ack ?? ""));
  const address = [b.address1, b.city, [b.state, b.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return {
    "company-profile.md": `# Company profile — ${company}
storm_event: "${b.storm_event ?? ""}"
timezone: ${b.timezone ?? "America/Chicago"}
trade: ${trade}
license_number: ${b.license_number ?? ""}
local_address: "${address}"
owner_name: ${owner}
owner_phone: ${e164(b.owner_phone)}
review_link: ${b.review_link ?? b.google_profile ?? ""}
website: ${b.website ?? ""}
current_lead_time: "estimates 3–5 days out; installs 3–4 weeks after approval"
hours: "${b.business_hours ?? "Mon–Sat 7:30 AM–6:00 PM"}"

## Flags
auto_ack: ${auto}
auto_book_estimates: false
auto_estimate_followups: false
status_texts_auto: false
auto_review_replies: false
auto_reviews: false

## Estimators / crews
| Name | Phone | Role | Start ZIP | Max stops/day | Days |
|---|---|---|---|---|---|
| ${b.owner_first} | ${e164(b.owner_phone)} | estimator | ${zipList[0] ?? b.postal_code ?? ""} | 20 | Mon–Sat |

## What we do / don't do
Do: ${trade} work per the trade pack; emergency make-safe; storm damage inspections.
Don't: anything outside the trade pack; out-of-area (see service-area.md).

## Voice sample
1. Hey, this is ${b.owner_first} with ${company}. Got your message — we can take a look. What's the address?
2. We're working through storm calls in order. You're on the list — I'll text when our estimator is a day out.
3. Crew is headed your way. If anything changes, text this number.

## Monitoring
agency_email: ty@pivotsolutions.io

## Owner contact record
owner_contact_id: ${ownerContactId}
sub_account: ${locName}
`,
    "service-area.md": `# Service area
ZIPs served: ${zipList.join(", ") || "(fill in — none given on the intake form)"}
Cities: ${b.city ?? ""}
Travel-fee zones: none
Out of area: reply with the out-of-area template, tag out-of-area, no opportunity.
`,
    "pricing-guardrails.md": `# Pricing guardrails
- Never state a number, range, "ballpark," or "starting at."
- Never say "free estimate" unless company-profile says estimates are free.
- If asked for price: "Every job is different — our estimator will give you a written number on site, usually within 3–5 days. No charge for the visit."
- Never comment on a competitor's price.
- Never mention financing terms.
`,
    "do-not-contact.csv": `phone,email,reason\n`,
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  const key = req.headers.get("x-dispatch-key") ?? (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (key !== env("DISPATCH_INTERNAL_KEY")) return json(401, { error: "bad key" });
  const b: any = await req.json().catch(() => null);
  if (!b || typeof b !== "object") return json(400, { error: "JSON body required" });

  const missing = ["company_name", "trade", "owner_first", "owner_last", "owner_phone"].filter((k) => !String(b[k] ?? "").trim());
  if (missing.length) return json(400, { error: "missing fields", missing });
  if (b.location_id === TEMPLATE_LOCATION) return json(400, { error: "refusing to set up the Dispatch template sub-account" });

  const log: Log = [];
  const db = admin();
  const companyId = b.company_id ?? COMPANY_ID;
  const base = env("PUBLIC_BASE_URL");
  const plan = {
    create_sub_account: !b.location_id,
    snapshot_id: b.snapshot_id ?? SNAPSHOT_ID,
    custom_values: ["company_name", "owner_phone", "license_number", "local_address", "review_link", "storm_event", "bot_webhook_key", "bot_webhook_key_intake", "wh_intake", "wh_estimate", "wh_crew_done", "wh_approval", "wh_optout", "bots_enabled", "mode", "trade", "wf02_id"],
    mode: "test",
  };
  if (b.dry_run) return json(200, { dry_run: true, plan, files: Object.keys(files(b, "(owner)", "(new)")) });

  try {
    // 1. sub-account
    let loc = b.location_id as string | undefined;
    const agencyToken = await brokerToken({ companyId });
    if (!loc) {
      const created = await hl(agencyToken, "POST", "/locations/", {
        name: String(b.company_name).trim(), companyId, snapshotId: plan.snapshot_id,
        phone: b.phone ? e164(b.phone) : undefined, website: b.website || undefined,
        address: b.address1 || undefined, city: b.city || undefined, state: b.state || undefined, country: "US", postalCode: b.postal_code || undefined,
        timezone: b.timezone ?? "America/Chicago",
        prospectInfo: { firstName: b.owner_first, lastName: b.owner_last, email: b.owner_email || undefined },
      });
      loc = created.id ?? created.location?.id;
      if (!loc) throw new Error(`create location returned no id: ${JSON.stringify(created).slice(0, 300)}`);
      log.push({ step: "create_sub_account", ok: true, detail: { location_id: loc } });
    } else log.push({ step: "create_sub_account", ok: true, detail: { reused: loc } });

    // 2. location token + wait for the snapshot (custom values + WF-02 are the tell)
    let locToken = "";
    let cvList: any[] = [], wf02 = "";
    for (let i = 0; i < 36; i++) {                           // up to ~3 min
      try {
        locToken ||= await brokerToken({ locationId: loc });
        const cv = await hl(locToken, "GET", `/locations/${loc}/customValues`);
        cvList = cv.customValues ?? [];
        const wfs = (await hl(locToken, "GET", "/workflows/", undefined, { locationId: loc })).workflows ?? [];
        wf02 = wfs.find((w: any) => /^WF-02\b/i.test(w.name ?? ""))?.id ?? "";
        if (cvList.some((v) => v.name === "mode") && wf02) break;
      } catch (e) { if (i === 35) throw e; }
      await sleep(5000);
    }
    if (!cvList.some((v) => v.name === "mode")) throw new Error("snapshot custom values never appeared (is the snapshot applied?)");
    log.push({ step: "snapshot_ready", ok: true, detail: { custom_values: cvList.length, wf02_id: wf02 || "(WF-02 not found)" } });

    // 3. tenant row + ingest key (keep an existing key on re-run)
    const { data: existing } = await db.from("tenants").select("id, settings").eq("location_id", loc).maybeSingle();
    if (!existing) throw new Error("tenant row missing after token mint — broker should have created it");
    const settings = { ...(existing.settings ?? {}) } as Record<string, unknown>;
    settings.ingest_key ||= ingestKey();
    settings.timezone = b.timezone ?? settings.timezone ?? "America/Chicago";
    settings.trade = String(b.trade).toLowerCase();
    settings.company_name = String(b.company_name).trim();
    settings.auto_ack = b.auto_ack === true || /auto/i.test(String(b.auto_ack ?? ""));
    settings.owner_phone = e164(b.owner_phone);
    if (b.ein) settings.ein = String(b.ein).replace(/\D/g, "");          // for the A2P packet only; never a custom value
    if (b.owner_email) settings.owner_email = String(b.owner_email).trim();

    // 4. owner contact (upsert by phone), tagged owner
    const up = await hl(locToken, "POST", "/contacts/upsert", {
      locationId: loc, firstName: b.owner_first, lastName: b.owner_last, phone: e164(b.owner_phone), email: b.owner_email || undefined, tags: ["owner"], source: "dispatch-setup",
    });
    const ownerContactId = up.contact?.id ?? up.id;
    settings.owner_contact_id = ownerContactId;
    log.push({ step: "owner_contact", ok: true, detail: { owner_contact_id: ownerContactId } });

    // 5. owner user id (needs users.write to create — not in our scopes; pick it up if Ty already added the user)
    try {
      const users = (await hl(locToken, "GET", "/users/", undefined, { locationId: loc })).users ?? [];
      const u = users.find((x: any) => (x.email ?? "").toLowerCase() === String(b.owner_email ?? "").toLowerCase() || e164(x.phone ?? "") === e164(b.owner_phone));
      if (u) settings.owner_user_id = u.id;
      log.push({ step: "owner_user", ok: !!u, detail: u ? { owner_user_id: u.id } : "not found — add the owner as a user in HighLevel, then re-run with location_id" });
    } catch (e) { log.push({ step: "owner_user", ok: false, detail: String(e).slice(0, 200) }); }

    const { error: terr } = await db.from("tenants").update({ settings }).eq("id", existing.id);
    if (terr) throw terr;
    log.push({ step: "tenant_settings", ok: true, detail: Object.keys(settings) });

    // 6. custom values — every one of the 17 is overwritten; template keys/URLs must never survive
    const address = [b.address1, b.city, [b.state, b.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    const want: Record<string, string> = {
      company_name: String(b.company_name).trim(),
      owner_phone: e164(b.owner_phone),
      license_number: String(b.license_number ?? ""),
      local_address: address,
      review_link: String(b.review_link ?? b.google_profile ?? ""),
      storm_event: String(b.storm_event ?? ""),
      bot_webhook_key: String(settings.ingest_key),
      bot_webhook_key_intake: String(settings.ingest_key),
      wh_intake: `${base}/functions/v1/dispatch-ingest/intake`,
      wh_estimate: `${base}/functions/v1/dispatch-ingest/appointment_completed`,
      wh_crew_done: `${base}/functions/v1/dispatch-ingest/crew_done`,
      wh_approval: `${base}/functions/v1/dispatch-ingest/approval_reply`,
      wh_optout: `${base}/functions/v1/dispatch-ingest/optout`,
      bots_enabled: "true",
      mode: "test",
      trade: String(b.trade).toLowerCase(),
      wf02_id: wf02,
    };
    const cvResult: Record<string, string> = {};
    for (const [name, value] of Object.entries(want)) {
      const row = cvList.find((v) => v.name === name);
      try {
        if (row) await hl(locToken, "PUT", `/locations/${loc}/customValues/${row.id}`, { name, value });
        else await hl(locToken, "POST", `/locations/${loc}/customValues`, { name, value });
        cvResult[name] = "ok";
      } catch (e) { cvResult[name] = String((e as Error).message).slice(0, 120); }
    }
    const cvBad = Object.entries(cvResult).filter(([, v]) => v !== "ok");
    log.push({ step: "custom_values", ok: cvBad.length === 0, detail: cvBad.length ? cvResult : `${Object.keys(want).length} written` });

    // 7. tenant_files
    const f = files(b, ownerContactId, String(b.company_name).trim());
    for (const [path, content] of Object.entries(f)) {
      const { error } = await db.from("tenant_files").upsert({ location_id: loc, path, content, updated_at: new Date().toISOString() }, { onConflict: "location_id,path" });
      if (error) throw error;
    }
    log.push({ step: "tenant_files", ok: true, detail: Object.keys(f) });

    await db.from("tenant_events").insert({ tenant_id: existing.id, location_id: loc, company_id: companyId, event: "setup-customer", detail: { company_name: want.company_name, trade: want.trade, reused: !!b.location_id, log } });

    const remaining = [
      settings.owner_user_id ? null : `Add ${b.owner_first} ${b.owner_last} as a user on sub-account ${loc} (HighLevel → Settings → Team), then re-run setup with location_id so owner_user_id is stored.`,
      `Buy a local number for ${loc} and submit A2P (Ty clicks submit).`,
      `Run golden-test on ${loc} (Office: "run golden-test on ${slug(want.company_name)}").`,
      `On PASS the welcome is queued automatically; flip mode=shadow for 48 h, then storm/standard.`,
    ].filter(Boolean);
    return json(200, { ok: true, location_id: loc, owner_contact_id: ownerContactId, ingest_key: settings.ingest_key, wf02_id: wf02, mode: "test", log, remaining });
  } catch (e) {
    console.error("dispatch-setup", e);
    return json(500, { ok: false, error: String((e as Error)?.message ?? e), log });
  }
});
