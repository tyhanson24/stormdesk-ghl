// Code-enforced send gate. Mirrors skills/send-gate/SKILL.md; the model cannot bypass it because the worker
// runs this before forwarding any conversations_send-a-new-message call to the gateway.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type GateCtx = {
  db: SupabaseClient;
  locationId: string;
  jobId: string;
  jobKind: string;
  customValues: Record<string, string>;     // bots_enabled, mode, company_name, owner_phone …
  settings: Record<string, any>;            // tenants.settings: owner_contact_id, timezone, auto_ack
  inboundText?: string;                     // the inbound message for this job, if any (escalation words)
  getContact: (id: string) => Promise<any>; // gateway contacts_get-contact
  dncList: string[];                        // phones/emails from do-not-contact.csv
};

export type SendArgs = { type: string; contactId: string; message?: string; subject?: string; html?: string; template?: string; booked_event_id?: string; approval?: string; [k: string]: unknown };
export type Verdict = { ok: true; args: SendArgs; redirected?: boolean } | { ok: false; check: string; reason: string };

const ESCALATION = /\b(lawyer|attorney|sue|suing|injured|injury|mold|fire|fraud|osha)\b/i;
const PRICE = /(\$\s?\d)|(\b(ballpark|around|roughly|approximately)\b[^.\n]{0,20}\d)/i;
const DATE = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight)\b|\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2}\b/i;

export async function sha(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

function localHourMinute(tz: string): number {
  try {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date());
    const h = Number(p.find((x) => x.type === "hour")?.value ?? 12) % 24, m = Number(p.find((x) => x.type === "minute")?.value ?? 0);
    return h * 60 + m;
  } catch { return 12 * 60; }
}

export async function gate(ctx: GateCtx, raw: SendArgs): Promise<Verdict> {
  const cv = ctx.customValues;
  const args: SendArgs = { ...raw };
  const channel = String(args.type ?? "SMS");
  const text = String(args.message ?? args.html ?? "");
  const mode = (cv.mode ?? "test").toLowerCase();
  const ownerId = ctx.settings.owner_contact_id as string | undefined;
  const isOwner = !!ownerId && args.contactId === ownerId;

  // 1 kill switch
  if ((cv.bots_enabled ?? "").toLowerCase() !== "true") return { ok: false, check: "kill_switch", reason: "bots_enabled is not true" };

  // 2 mode
  let redirected = false;
  if (mode === "test") return { ok: false, check: "test_mode", reason: `would send ${channel} to ${args.contactId}: ${text.slice(0, 160)}` };
  if (mode === "shadow") {
    if (!ownerId) return { ok: false, check: "shadow_no_owner", reason: "owner_contact_id missing in tenant settings" };
    if (!isOwner) {
      const c = await ctx.getContact(args.contactId).catch(() => null);
      const who = c ? `${c.contact?.firstName ?? c.firstName ?? ""} ${c.contact?.lastName ?? c.lastName ?? ""} ${c.contact?.phone ?? c.phone ?? ""}`.trim() : args.contactId;
      args.contactId = ownerId;
      if (args.message) args.message = `[SHADOW → ${who}] ${args.message}`;
      if (args.subject) args.subject = `[SHADOW → ${who}] ${args.subject}`;
      redirected = true;
    }
  } else if (mode !== "storm" && mode !== "standard") {
    return { ok: false, check: "mode", reason: `unknown mode ${mode}` };
  }

  // 3 recipient allowed (tags, DND, csv)
  const contact = await ctx.getContact(args.contactId).catch(() => null);
  const c = contact?.contact ?? contact ?? {};
  const tags: string[] = (c.tags ?? []).map((t: string) => String(t).toLowerCase());
  if (tags.includes("do-not-contact")) return { ok: false, check: "dnc", reason: "contact tagged do-not-contact" };
  const dndAll = c.dnd === true;
  const dndCh = channel.toUpperCase() === "SMS" ? c.dndSettings?.SMS?.status === "active" : channel.toLowerCase() === "email" ? c.dndSettings?.Email?.status === "active" : false;
  if (dndAll || dndCh) return { ok: false, check: "dnc", reason: `DND active for ${channel}` };
  const ids = [c.phone, c.email].filter(Boolean).map((s: string) => s.replace(/\D/g, "").length >= 10 ? s.replace(/\D/g, "").slice(-10) : s.toLowerCase());
  const dnc = ctx.dncList.map((s) => s.replace(/\D/g, "").length >= 10 ? s.replace(/\D/g, "").slice(-10) : s.toLowerCase());
  if (ids.some((x: string) => dnc.includes(x))) return { ok: false, check: "dnc", reason: "matches do-not-contact.csv" };

  // 4 approval. Allowed: owner-facing messages (briefs, approval pings), approval_reply jobs (owner said APPROVE),
  //    or an explicit auto_* flag covering this exact template.
  const autoFlags: string[] = Array.isArray(ctx.settings.auto) ? ctx.settings.auto : (ctx.settings.auto_ack ? ["ACK-1"] : []);
  const approved = isOwner || redirected || ctx.jobKind === "approval_reply" || (args.template && autoFlags.includes(String(args.template)));
  if (!approved) return { ok: false, check: "no_approval", reason: "homeowner send without owner approval or auto_* flag" };

  // 6 content rules (5 template integrity is enforced by the template check in the skill; drift is caught by the owner at approval)
  if (!isOwner && !redirected) {
    if (PRICE.test(text)) return { ok: false, check: "price", reason: "price-like content" };
    if (DATE.test(text) && !args.booked_event_id) return { ok: false, check: "date", reason: "date/weekday without booked_event_id" };
    if (mode === "storm" && /!/.test(text)) return { ok: false, check: "tone", reason: "! in storm mode" };
    const company = (cv.company_name ?? "").trim();
    if (company && channel.toUpperCase() === "SMS" && !text.trim().toLowerCase().endsWith(company.toLowerCase())) return { ok: false, check: "signature", reason: `SMS must end with ${company}` };
    if (channel.toUpperCase() === "SMS" && text.length > 320) return { ok: false, check: "length", reason: `${text.length} chars > 320` };
  }

  // 6b compliance (live modes, homeowner SMS only): carrier pause, consent ledger, A2P / toll-free bridge.
  //    Owner/crew messages and shadow redirects (which go to the owner) are exempt. Email is not SMS-regulated here.
  if (!isOwner && !redirected && channel.toUpperCase() === "SMS") {
    const paused = ctx.settings.sms_paused;
    if (paused) return { ok: false, check: "carrier_pause", reason: `SMS paused ${paused.at ?? ""}: ${paused.reason ?? "carrier block"} — resume with dispatch_sms-resume after fixing` };
    const { data: cons } = await ctx.db.from("consents").select("status, source, created_at").eq("location_id", ctx.locationId).eq("contact_id", args.contactId).eq("channel", "SMS").order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!cons) return { ok: false, check: "consent", reason: "no SMS consent on file for this contact (lead has not texted in / no form consent); record it with dispatch_consent or wait for an inbound text" };
    if (cons.status === "opted_out") return { ok: false, check: "opt_out", reason: `contact opted out (${cons.source} ${String(cons.created_at).slice(0, 10)})` };
    const { data: a2p } = await ctx.db.from("a2p_registrations").select("campaign_status").eq("location_id", ctx.locationId).maybeSingle();
    if (a2p?.campaign_status !== "approved") {
      const { data: bridge } = await ctx.db.from("numbers").select("number").eq("location_id", ctx.locationId).eq("kind", "tollfree").eq("verified", true).eq("status", "active").order("purpose").limit(1).maybeSingle();
      if (!bridge) return { ok: false, check: "a2p", reason: `10DLC campaign is ${a2p?.campaign_status ?? "not_started"} and no verified toll-free bridge number is assigned` };
      args.fromNumber = bridge.number;
    }
  }

  // 7 quiet hours (owner / crew exempt)
  const crew = tags.includes("crew") || tags.includes("owner");
  if (!isOwner && !crew) {
    const hm = localHourMinute(ctx.settings.timezone ?? "America/Chicago");
    if (hm >= 20 * 60 || hm < 7 * 60 + 30) return { ok: false, check: "quiet_hours", reason: "8:00 PM–7:30 AM local" };
  }

  // 8 weekly cap, 9 rate limit, 11 duplicate — from outbound_log
  const since7d = new Date(Date.now() - 7 * 864e5).toISOString();
  const since1h = new Date(Date.now() - 3600e3).toISOString();
  const since10m = new Date(Date.now() - 600e3).toISOString();
  if (!isOwner && !redirected) {
    const { count: weekly } = await ctx.db.from("outbound_log").select("id", { count: "exact", head: true })
      .eq("location_id", ctx.locationId).eq("contact_id", args.contactId).eq("verdict", "sent").gte("created_at", since7d);
    if ((weekly ?? 0) >= 2) return { ok: false, check: "weekly_cap", reason: `${weekly} sends in 7 days` };
  }
  const { count: hourly } = await ctx.db.from("outbound_log").select("id", { count: "exact", head: true })
    .eq("location_id", ctx.locationId).eq("verdict", "sent").gte("created_at", since1h);
  if ((hourly ?? 0) >= 30) return { ok: false, check: "rate_limit", reason: `${hourly} sends in the last hour` };
  const h = await sha(`${raw.contactId}|${raw.template ?? ""}|${raw.message ?? raw.html ?? ""}`);
  const { count: dup } = await ctx.db.from("outbound_log").select("id", { count: "exact", head: true })
    .eq("location_id", ctx.locationId).eq("text_hash", h).in("verdict", ["sent", "redirected:shadow"]).gte("created_at", since10m);
  if ((dup ?? 0) > 0) return { ok: false, check: "duplicate", reason: "same message to same contact within 10 min" };

  // 10 escalation words in the inbound thread
  if (!isOwner && ctx.inboundText && ESCALATION.test(ctx.inboundText)) {
    return { ok: false, check: "escalation", reason: `inbound contains ${ctx.inboundText.match(ESCALATION)?.[0]}` };
  }

  return { ok: true, args, redirected };
}
