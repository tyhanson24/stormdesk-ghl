// Dispatch — worker. Claims queued jobs and runs each as an agent: skill prompt + gateway tools + code-enforced send gate.
//   POST /functions/v1/dispatch-worker   header x-dispatch-key   body {} | {poke: jobId} | {limit: n}
// Called by pg_cron every minute and poked by dispatch-ingest. Safe to run concurrently (claim_jobs uses SKIP LOCKED).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { admin, env, json } from "../_shared/ghl.ts";
import { gate, sha, type GateCtx, type SendArgs } from "./gate.ts";

const WORKER_ID = `w-${crypto.randomUUID().slice(0, 8)}`;
const INVOCATION_BUDGET_MS = 300_000;   // Supabase Pro wall clock is 400 s; leave headroom
const JOB_BUDGET_MS = 200_000;
const MAX_TOOL_CALLS = 30;
const SKILLS_BASE = () => `https://raw.githubusercontent.com/tyhanson24/stormdesk-ghl/${Deno.env.get("SKILLS_REF") ?? "main"}`;
const MODEL = () => Deno.env.get("DISPATCH_MODEL") ?? "claude-sonnet-4-5";

// ---------- skills (cached per isolate) ----------
const skillCache = new Map<string, { at: number; text: string }>();
const SKILL_TTL_MS = 5 * 60_000;   // a skill push on main is live within 5 minutes without a redeploy
async function repoFile(path: string): Promise<string> {
  const hit = skillCache.get(path);
  if (hit && Date.now() - hit.at < SKILL_TTL_MS) return hit.text;
  const r = await fetch(`${SKILLS_BASE()}/${path}`);
  const t = r.ok ? await r.text() : (hit?.text ?? "");
  if (r.ok) skillCache.set(path, { at: Date.now(), text: t });
  return t;
}
const TEMPLATE_LOCATION = "LTiwIPoSI1YNEcSyzYzf";
// Hard guard (mirrors the health-check skill): a client sub-account still carrying template leftovers must not run.
function setupProblems(loc: string, cv: Record<string, string>): string[] {
  const base = env("PUBLIC_BASE_URL");
  const out: string[] = [];
  for (const [k, v] of Object.entries(cv)) if (k !== "review_link" && /REPLACE/i.test(v)) out.push(`${k} still says REPLACE`);   // review_link is set at go-live, not intake-critical
  for (const k of ["wh_intake", "wh_approval", "wh_optout", "wh_reply"]) if (cv[k] && !cv[k].startsWith(`${base}/functions/v1/dispatch-ingest/`)) out.push(`${k} does not point at dispatch-ingest`);
  for (const k of ["bot_webhook_key", "bot_webhook_key_intake"]) if (cv[k] && !/^ik_[a-f0-9]{48}$/.test(cv[k])) out.push(`${k} is not a Dispatch ingest key`);
  if (loc !== TEMPLATE_LOCATION && cv.wf02_id === "59c92c05-5fc0-4891-832c-bf3d991c4c6a") out.push("wf02_id is the template's");
  if (loc !== TEMPLATE_LOCATION && /template/i.test(cv.company_name ?? "")) out.push("company_name is the template's");
  return out;
}

// Per kind: which skills, which gateway tools (allowlist — the full list is ~60 tools and costs ~8K tokens a turn),
// which company files, and the task text. ALL = every tool. Code-only kinds never call the model.
const CORE_TOOLS = ["contacts_get-contact", "contacts_search", "contacts_update-contact", "contacts_add-tags", "contacts_remove-tags", "contacts_create-note", "contacts_get-notes", "contacts_create-task", "contacts_get-all-tasks", "conversations_search-conversation", "conversations_get-messages", "conversations_send-a-new-message", "locations_get-custom-values", "users_get-users", "hl_request"];
const OPP_TOOLS = ["opportunities_get-pipelines", "opportunities_search-opportunity", "opportunities_get-opportunity", "opportunities_create-opportunity", "opportunities_update-opportunity"];
const CAL_TOOLS = ["calendars_get-calendars", "calendars_get-calendar-events", "calendars_get-appointment-notes", "calendars_create-appointment"];
const ALL_FILES = ["company-profile.md", "service-area.md", "pricing-guardrails.md", "do-not-contact.csv", "permits.md", "price-book.md", "estimate-template.md"];
const KIND_SPEC: Record<string, { skills: string[]; tools: string[] | "ALL"; files: string[]; task: (p: any) => string }> = {
  intake: { skills: ["storm-intake"], tools: [...CORE_TOOLS, ...OPP_TOOLS, "contacts_upsert-contact", "contacts_create-contact"], files: ["company-profile.md", "service-area.md", "pricing-guardrails.md", "do-not-contact.csv"], task: (p) => `New lead webhook received. Run storm-intake on contact ${p.contact_id} using this payload: ${JSON.stringify(p)}. Draft the reply as a contact note (exact DRAFT format) + an approval task for the owner. Do NOT call conversations_send-a-new-message unless the template you drafted is explicitly listed in the auto-send flags given in the system prompt; the DRAFT note + approval task IS the deliverable otherwise.` },
  approval_reply: { skills: [], tools: CORE_TOOLS, files: [], task: (p) => `Owner replied to an approval. Reply text: ${JSON.stringify(p.message ?? p.body ?? "")}. Owner contact: ${p.contact_id}.` },
  inbound_reply: { skills: ["reply-handling", "storm-intake"], tools: [...CORE_TOOLS, ...OPP_TOOLS, ...CAL_TOOLS], files: ["company-profile.md", "service-area.md", "pricing-guardrails.md", "do-not-contact.csv"], task: (p) => `A lead or customer (contact ${p.contact_id}) texted back. Run reply-handling. Payload: ${JSON.stringify(p)}. Draft replies as DRAFT notes + approval tasks; book a calendar appointment only when reply-handling says so.` },
  followup_sweep: { skills: ["estimate-followups"], tools: [...CORE_TOOLS, ...OPP_TOOLS], files: ["company-profile.md"], task: () => `Daily estimate follow-up sweep. Run estimate-followups: find Estimate Sent opportunities due today, stage one draft each. Send nothing yourself.` },
  appointment_completed: { skills: ["estimate-drafting"], tools: [...CORE_TOOLS, ...OPP_TOOLS, ...CAL_TOOLS], files: ["company-profile.md", "pricing-guardrails.md", "price-book.md", "estimate-template.md"], task: (p) => `Appointment complete for contact ${p.contact_id}. Payload: ${JSON.stringify(p)}. Draft the estimate from the appointment notes and photos per estimate-drafting. Stage for approval as a contact task. Send nothing.` },
  crew_done: { skills: ["permits-inspections"], tools: [...CORE_TOOLS, ...OPP_TOOLS, ...CAL_TOOLS], files: ["company-profile.md", "permits.md"], task: (p) => `Job marked done for contact ${p.contact_id}. Payload: ${JSON.stringify(p)}. Per permits-inspections: request inspection, draft the homeowner window text as a DRAFT note + approval task. Send nothing to the homeowner.` },
  daily_brief: { skills: ["daily-brief"], tools: [...CORE_TOOLS, ...OPP_TOOLS, ...CAL_TOOLS], files: ["company-profile.md"], task: (p) => `Produce the daily brief per daily-brief for mode=${p.mode ?? "?"} (standard mode leads with pipeline and today's visits; storm mode leads with the queue). Deliver it to the owner's contact record (SMS + email) through the gate. Health line (verbatim, from the code health check): ${p.health ?? "n/a"}. Pending approvals (use these exact numbers in the APPROVE n lines): ${JSON.stringify(p.pending_approvals ?? [])}. Compliance line for the BLOCKED/STATUS section (verbatim): ${p.compliance ?? "n/a"}` },
  health_check: { skills: [], tools: [], files: [], task: () => "(code-only: setup, compliance, workflow and approval checks → bot_last_health)" },
  welcome: { skills: [], tools: [], files: [], task: () => "(code-only: owner welcome sequence)" },
  delivery_check: { skills: [], tools: [], files: [], task: () => "(code-only: delivery status + carrier-block monitor)" },
  optout: { skills: [], tools: [], files: [], task: () => "(code-only: STOP keyword → consent ledger + DND)" },
  custom: { skills: [], tools: "ALL", files: ALL_FILES, task: (p) => String(p.instruction ?? "No instruction given. Say so and stop.") },
};

// ---------- owner welcome copy (config/welcome-copy.md, approved by Ty 2026-10-20) ----------
const WELCOME = {
  w1: (v: Record<string, string>) => `${v.first}, this is Dispatch for ${v.company}. I'm the texting assistant on ${v.number}.\nHere's how I work: every reply to a homeowner is a DRAFT until you say so. I'll text you "Draft #n for <name>" — reply APPROVE n, NO n, or EDIT n <your words>. APPROVE ALL clears the list.\nEvery morning at ${v.brief_time} you get a one-screen brief. Text STOP BOTS any time to pause me, START BOTS to resume.\nNothing goes to a customer without you. — Dispatch`,
  w2subject: (v: Record<string, string>) => `${v.company} × Dispatch — you're set up`,
  w2: (v: Record<string, string>) => `${v.first},\n\nDispatch is live on ${v.company}'s HighLevel account in test mode. What that means today:\n\nWHAT I DO\n• New lead comes in (missed call, web form, text) → within about a minute the lead is in your pipeline with address, damage type, severity and an urgency score, and I've drafted the first reply.\n• You get a text: "Draft #n for <name>: <message>". Reply APPROVE n / NO n / EDIT n <new text>. APPROVE ALL sends every pending draft.\n• ${v.brief_time} every morning: a one-screen brief — new leads, what's waiting on you, what I blocked and why.\n\nWHAT I NEVER DO\n• Send a homeowner anything you haven't approved (unless you turn on auto-send for the three basic replies).\n• Quote a price, promise a date, or text between 8 PM and 7:30 AM.\n• Text anyone on your do-not-contact list, or anyone who opted out.\n\nKILL SWITCH\nText STOP BOTS to the Dispatch number and I stop instantly. START BOTS resumes.\n\nNEXT STEPS\n1. Save the Dispatch number ${v.number} in your phone as "Dispatch".\n2. Reply to this email with any crew phone numbers you want alerted on emergencies.\n3. For the next 48 hours I'm in shadow mode: every message I would have sent goes to YOU instead, so you can see exactly what customers would get. After that, Ty flips you live.\n\nQuestions: reply here or text Ty.\n\n— Dispatch, for ${v.company}`,
  w3: (v: Record<string, string>) => `${v.first} — 3-day check-in from Dispatch. Since go-live: ${v.leads_count} leads, ${v.approved_count} replies you approved, ${v.blocked_count} I held back. Anything you want worded differently? Reply here and Ty will adjust. — Dispatch`,
};
const WELCOME_DEFER_MS = 30 * 60_000;      // re-check mode every 30 min while the account is still in test
const WELCOME_MAX_DEFERS = 14 * 48;        // give up after 14 days

// ---------- gateway (our MCP) ----------
async function mcp(loc: string, method: string, params: unknown) {
  const r = await fetch(`${env("PUBLIC_BASE_URL")}/functions/v1/dispatch-hl/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-dispatch-key": env("DISPATCH_INTERNAL_KEY"), locationId: loc },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await r.text();
  let j: any; try { j = JSON.parse(text); } catch { throw new Error(`gateway ${method}: HTTP ${r.status} ${text.slice(0, 200)}`); }
  if (!r.ok || j.error) throw new Error(`gateway ${method}: ${j?.error?.message ?? (typeof j?.error === "string" ? j.error : JSON.stringify(j?.error ?? j).slice(0, 200))}`);
  return j.result;
}
// One retry on transport-level failures (gateway 5xx / broker hiccup / timeout) so a blip doesn't cost a whole attempt.
async function callTool(loc: string, name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
  for (let i = 0; ; i++) {
    try {
      const res = await mcp(loc, "tools/call", { name, arguments: args });
      return { text: res?.content?.[0]?.text ?? "", isError: !!res?.isError };
    } catch (e) {
      if (i >= 1) throw e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

// Templates are matched byte-for-byte by the golden test and by owners' eyes; the model likes typographic quotes.
// Normalize every string the model sends to HighLevel (notes, drafts, messages, names).
function asciiQuotes<T>(v: T): T {
  if (typeof v === "string") return v.replace(/[\u2018\u2019\u201A\u2032]/g, "'").replace(/[\u201C\u201D\u201E\u2033]/g, '"').replace(/\u2026/g, "...") as unknown as T;
  if (Array.isArray(v)) return v.map(asciiQuotes) as unknown as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, asciiQuotes(x)])) as unknown as T;
  return v;
}

// Every real send lands in outbound_log with HighLevel's messageId so delivery_check can follow it up.
// Opt-out keywords. Strong words (STOP/UNSUBSCRIBE/QUIT) count at the start of a short message ("Stop texting me now");
// weak words (CANCEL/END) only alone or with one trailing word, so "cancel my appointment tomorrow" is not an opt-out.
const STOP_RE = /^\s*(?:(?:STOP|STOPALL|UNSUBSCRIBE|QUIT)(?:\s+\w+){0,5}|(?:CANCEL|END)(?:\s+\w+)?)\s*[.!]*\s*$/i;
async function logSend(db: ReturnType<typeof admin>, loc: string, jobId: string, a: SendArgs, template: string | null, hash: string, r: { text: string; isError: boolean }, redirected: boolean) {
  let messageId: string | null = null;
  try { const j = JSON.parse(r.text); messageId = j.messageId ?? j.id ?? null; } catch { /* non-JSON */ }
  await db.from("outbound_log").insert({
    location_id: loc, job_id: jobId, contact_id: a.contactId, channel: a.type, template, text_hash: hash,
    verdict: r.isError ? "error" : (redirected ? "redirected:shadow" : "sent"),
    detail: r.isError ? r.text.slice(0, 300) : (redirected ? "shadow redirect to owner" : null),
    message_id: r.isError ? null : messageId, from_number: (a.fromNumber as string | undefined) ?? null, delivery_status: r.isError ? null : "pending",
  });
}
async function recordConsent(db: ReturnType<typeof admin>, loc: string, contactId: string, status: "opted_in" | "opted_out", source: string, evidence: string, jobId?: string, phone?: string) {
  await db.from("consents").insert({ location_id: loc, contact_id: contactId, phone: phone ?? null, channel: "SMS", status, source, evidence: evidence.slice(0, 500), job_id: jobId ?? null });
}

// ---------- model ----------
type Msg = { role: "user" | "assistant"; content: any };
async function claude(system: string, messages: Msg[], tools: any[]) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01" },
    // Prompt caching: the skill bundle (system) and the tool list are identical on every turn of a job — cache them.
    body: JSON.stringify({
      model: MODEL(), max_tokens: 4096,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages,
      tools: tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t)),
      tool_choice: { type: "auto" },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!r.ok) throw new Error(`model ${r.status}: ${(await r.text()).slice(0, 500)}`);
  return await r.json();
}

// ---------- one job ----------
async function runJob(db: ReturnType<typeof admin>, job: any) {
  const loc = job.location_id as string;
  const t0 = Date.now();
  const { data: runRow, error: runErr } = await db.from("job_runs").insert({ job_id: job.id, attempt: job.attempts, model: MODEL() }).select("id").single();
  if (runErr || !runRow) throw runErr ?? new Error("could not create job_run");
  const run = runRow as { id: number };
  const steps: any[] = [];
  let inTok = 0, outTok = 0;
  const log = (s: any) => { steps.push(s); };

  try {
    const spec = KIND_SPEC[job.kind] ?? KIND_SPEC.custom;
    if (job.kind === "daily_brief") {
      const { data: pend } = await db.from("approvals").select("n, contact_name, template, text, created_at").eq("location_id", loc).eq("status", "pending").order("n");
      const dayAgo = new Date(Date.now() - 864e5).toISOString();
      const [{ data: a2p }, { count: failedSends }, { count: optOuts }, { data: tn }] = await Promise.all([
        db.from("a2p_registrations").select("brand_status, campaign_status").eq("location_id", loc).maybeSingle(),
        db.from("outbound_log").select("id", { count: "exact", head: true }).eq("location_id", loc).in("delivery_status", ["failed", "undelivered"]).gte("created_at", dayAgo),
        db.from("consents").select("id", { count: "exact", head: true }).eq("location_id", loc).eq("status", "opted_out").gte("created_at", dayAgo),
        db.from("tenants").select("settings").eq("location_id", loc).maybeSingle(),
      ]);
      const compliance = `A2P brand=${a2p?.brand_status ?? "not_started"} campaign=${a2p?.campaign_status ?? "not_started"}; last 24h: ${failedSends ?? 0} failed sends, ${optOuts ?? 0} opt-outs${tn?.settings?.sms_paused ? `; SMS PAUSED (${tn.settings.sms_paused.reason})` : ""}`;
      job.payload = { ...(job.payload ?? {}), pending_approvals: (pend ?? []).map((a: any) => ({ n: a.n, who: a.contact_name, template: a.template, text: a.text.slice(0, 160), since: a.created_at })), compliance };
    }
    const { data: tenant } = await db.from("tenants").select("settings").eq("location_id", loc).maybeSingle();
    const settings = tenant?.settings ?? {};
    const { data: files } = await db.from("tenant_files").select("path, content").eq("location_id", loc);
    const fileMap = Object.fromEntries((files ?? []).map((f: any) => [f.path, f.content]));

    // tools from the gateway (live), custom values, trade pack
    const toolList = (await mcp(loc, "tools/list", {})).tools as any[];
    const cvRaw = await callTool(loc, "locations_get-custom-values", {});
    const cv: Record<string, string> = {};
    try { for (const v of JSON.parse(cvRaw.text).customValues ?? []) cv[v.name] = String(v.value ?? ""); } catch { /* leave empty */ }
    log({ tool: "locations_get-custom-values", ok: !cvRaw.isError, ms: Date.now() - t0, result_excerpt: `mode=${cv.mode} bots_enabled=${cv.bots_enabled} trade=${cv.trade}` });

    if ((cv.bots_enabled ?? "").toLowerCase() !== "true" && job.kind !== "health_check") {
      await finish(db, job, run.id, "blocked", steps, inTok, outTok, "bots_enabled is not true — nothing done", null);
      return;
    }
    const problems = setupProblems(loc, cv);
    if (problems.length && job.kind !== "health_check") {
      log({ tool: "setup_guard", ok: false, result_excerpt: problems.join("; ").slice(0, 300) });
      await finish(db, job, run.id, "blocked", steps, inTok, outTok, `setup incomplete — ${problems.join("; ")}`, null);
      return;
    }

    const trade = (cv.trade ?? settings.trade ?? "").toString().trim().toLowerCase();
    if (job.kind === "health_check") {
      const summary = await healthCheck(db, loc, job, cv, settings, trade, log);
      await finish(db, job, run.id, summary.includes(" FAIL") ? "blocked" : "succeeded", steps, inTok, outTok, summary, null);
      return;
    }
    if (job.kind === "daily_brief") job.payload = { ...(job.payload ?? {}), mode: cv.mode ?? "?", health: cv.bot_last_health ?? "no health check yet" };
    const [rules, sendGate, ...kindSkills] = await Promise.all([
      repoFile("skills/ghl-operating-rules/SKILL.md"), repoFile("skills/send-gate/SKILL.md"),
      ...spec.skills.map((s) => repoFile(`skills/${s}/SKILL.md`)),
      ...((job.payload?.skills as string[] | undefined) ?? []).map((s) => repoFile(`skills/${s}/SKILL.md`)),
    ]);
    const pack = trade ? await repoFile(`trades/${trade}.md`) : "";

    const system = [
      `You are Dispatch, the operations agent for one home-service contractor's HighLevel sub-account (locationId ${loc}). You act ONLY through the tools provided. There is no filesystem: the company files you would read from /workspace are included below. Mode and flags come from the custom values already read: mode=${cv.mode ?? "?"}, bots_enabled=${cv.bots_enabled ?? "?"}, trade=${trade || "?"}, company_name=${cv.company_name ?? "?"}. Owner contact id: ${settings.owner_contact_id ?? "unknown (search by owner_phone custom value if needed)"}. Owner user id for task assignedTo (required by HighLevel): ${settings.owner_user_id ?? "unknown — call users_get-users once"}. Timezone: ${settings.timezone ?? "America/Chicago"}. Auto-send flags (templates that may be sent without owner approval): ${JSON.stringify(Array.isArray(settings.auto) ? settings.auto : (settings.auto_ack ? ["ACK-1"] : []))} — anything else is draft-only.`,
      `Every send through conversations_send-a-new-message is checked by a code-level send gate before it reaches HighLevel; if it comes back BLOCKED, write the BLOCKED note as the send-gate skill says and move on — never retry with different wording or another channel. Pass "template" (template id) and, for approved drafts, "approval" on every send call.`,
      `Be economical: at most ${MAX_TOOL_CALLS} tool calls. When done, end with a final message whose last paragraph starts with "SUMMARY:" and has 3–8 lines: what you read, what you changed, what's waiting on approval, what blocked you.`,
      "\n# ghl-operating-rules\n" + rules, "\n# send-gate\n" + sendGate,
      ...kindSkills.map((s, i) => `\n# skill ${i + 1}\n` + s),
      pack ? "\n# trade pack\n" + pack : "",
      ...Object.entries(fileMap).filter(([p]) => spec.files.includes(p)).map(([p, c]) => `\n# /workspace/${p}\n` + c),   // only the files this kind reads (A2P artifacts are for Ty, not the model)
    ].join("\n");

    const SEND = "conversations_send-a-new-message";
    const tools = toolList.filter((t) => spec.tools === "ALL" || spec.tools.includes(t.name)).map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
    const sendTool = tools.find((t) => t.name === SEND);
    if (sendTool) sendTool.input_schema = { ...sendTool.input_schema, properties: { ...sendTool.input_schema.properties, template: { type: "string", description: "Template id (e.g. ACK-1). Required." }, approval: { type: "string", description: "Approval token: 'owner-reply' when sending an owner-approved draft." }, booked_event_id: { type: "string", description: "Calendar event id if the text states a date." } } };

    const dnc = (fileMap["do-not-contact.csv"] ?? "").split(/\r?\n/).slice(1).map((l: string) => l.split(",")[0]?.trim()).filter(Boolean);
    const gctx: GateCtx = {
      db, locationId: loc, jobId: job.id, jobKind: job.kind, customValues: cv, settings,
      inboundText: typeof job.payload?.message === "string" ? job.payload.message : undefined,
      getContact: async (id) => { const r = await callTool(loc, "contacts_get-contact", { contactId: id }); return JSON.parse(r.text); },
      dncList: dnc,
    };

    // welcome is pure code: fixed owner-only copy, held while mode=test, step 3 self-scheduled.
    if (job.kind === "welcome") {
      const w = await welcome(db, loc, job, cv, settings, gctx, log);
      if (w.defer) { await defer(db, job, run.id, steps, w.summary, WELCOME_DEFER_MS); return; }
      await finish(db, job, run.id, w.blocked ? "blocked" : "succeeded", steps, inTok, outTok, w.summary, null);
      return;
    }

    // Intake: the webhook rarely carries the inbound text (missed-call text-backs and golden-test leads put it in an
    // INBOUND: note). Fetch it deterministically so classification never depends on the model remembering to look.
    let inbound = typeof job.payload?.message === "string" ? job.payload.message.trim() : "";
    let inboundVia: "payload" | "note" | "sms" | "" = inbound ? "payload" : "";
    if ((job.kind === "intake" || job.kind === "inbound_reply") && job.payload?.contact_id) {
      try {
        const notesRaw = await callTool(loc, "contacts_get-notes", { contactId: job.payload.contact_id });
        const notes: any[] = JSON.parse(notesRaw.text).notes ?? [];
        const inboundNotes = notes.filter((n) => /^\s*INBOUND:/i.test(n.body ?? "")).sort((a, b) => String(b.dateAdded).localeCompare(String(a.dateAdded)));
        if (!inbound && inboundNotes[0]) { inbound = String(inboundNotes[0].body).replace(/^\s*INBOUND:\s*/i, "").trim(); inboundVia = "note"; }
        if (!inbound) {
          const convRaw = await callTool(loc, "conversations_search-conversation", { contactId: job.payload.contact_id, limit: 1 });
          const conv = (JSON.parse(convRaw.text).conversations ?? [])[0];
          if (conv?.id) {
            const msgsRaw = await callTool(loc, "conversations_get-messages", { conversationId: conv.id, limit: 10 });
            const msgs: any[] = JSON.parse(msgsRaw.text).messages?.messages ?? JSON.parse(msgsRaw.text).messages ?? [];
            const lastIn = msgs.find((m) => m.direction === "inbound" && m.body);
            if (lastIn) { inbound = String(lastIn.body).trim(); inboundVia = lastIn.messageType === "TYPE_SMS" || /sms/i.test(String(lastIn.messageType ?? "")) ? "sms" : "payload"; }
          }
        }
        log({ tool: "inbound_lookup", ok: true, ms: Date.now() - t0, result_excerpt: inbound ? `[${inboundVia}] ` + inbound.slice(0, 200) : "(no inbound text found)" });
      } catch (e) { log({ tool: "inbound_lookup", ok: false, ms: Date.now() - t0, result_excerpt: String(e).slice(0, 200) }); }
      gctx.inboundText = inbound || undefined;
      // A reply that just arrived (job created < 15 min ago) may be answered through quiet hours and past the weekly cap.
      if (job.kind === "inbound_reply") gctx.inboundAt = new Date(job.created_at ?? Date.now()).getTime();

      // Compliance, in code: an opt-out keyword ends the job before the model sees it; otherwise the way the lead
      // reached us is the consent record the gate will require before any live SMS.
      const p = job.payload ?? {};
      const src = String(p.source ?? p.lead_source ?? p.contact_source ?? p.contact?.source ?? (job.kind === "inbound_reply" ? "sms" : "")).toLowerCase();
      if (inbound && STOP_RE.test(inbound)) {
        await recordConsent(db, loc, p.contact_id, "opted_out", "stop_keyword", inbound, job.id);
        await callTool(loc, "contacts_add-tags", { contactId: p.contact_id, tags: ["do-not-contact"] });
        await callTool(loc, "contacts_update-contact", { contactId: p.contact_id, fields: { dnd: true } });
        log({ tool: "optout", ok: true, result_excerpt: "STOP keyword — consent opted_out, do-not-contact tag, DND on" });
        await finish(db, job, run.id, "succeeded", steps, inTok, outTok, "Opt-out keyword received — recorded, tagged do-not-contact, DND on. No draft.", null);
        return;
      }
      const consentSource = inboundVia === "sms" || /sms|text|mctb|conversation/.test(src) ? "inbound_sms"
        : /form|web|site|landing/.test(src) ? "web_form"
        : /missed|call|phone|voicemail/.test(src) ? "missed_call" : null;
      if (consentSource) {
        await recordConsent(db, loc, p.contact_id, "opted_in", consentSource, inbound || `source=${src}`, job.id, p.phone ?? p.contact?.phone);
        log({ tool: "consent", ok: true, result_excerpt: `opted_in via ${consentSource}` });
      } else log({ tool: "consent", ok: true, result_excerpt: `no consent recorded (source="${src}", inbound via ${inboundVia || "none"}) — live SMS to this lead will be blocked until they text in or the owner attests` });
    }
    if (job.kind === "delivery_check") {
      const summary = await deliveryCheck(db, loc, job, settings, gctx, log);
      await finish(db, job, run.id, "succeeded", steps, inTok, outTok, summary, null);
      return;
    }
    if (job.kind === "optout") {
      const p = job.payload ?? {};
      const cid = p.contact_id ?? p.contactId ?? p.contact?.id;
      if (!cid) { await finish(db, job, run.id, "blocked", steps, inTok, outTok, "optout: no contact_id in payload", null); return; }
      const msg = String(p.message ?? p.body ?? "").trim();
      if (msg && !STOP_RE.test(msg)) { await finish(db, job, run.id, "succeeded", steps, inTok, outTok, `optout ignored: "${msg.slice(0, 60)}" is not a bare opt-out keyword`, null); return; }
      await recordConsent(db, loc, cid, "opted_out", "stop_keyword", msg || "STOP (keyword match in workflow)", job.id, p.phone);
      await callTool(loc, "contacts_add-tags", { contactId: cid, tags: ["do-not-contact"] });
      await callTool(loc, "contacts_update-contact", { contactId: cid, fields: { dnd: true } });
      await db.from("approvals").update({ status: "blocked", decided_at: new Date().toISOString(), detail: "contact opted out" }).eq("location_id", loc).eq("contact_id", cid).eq("status", "pending");
      await finish(db, job, run.id, "succeeded", steps, inTok, outTok, `opt-out recorded for ${cid}; pending drafts closed`, null);
      return;
    }
    // approval_reply is pure code: the owner's text is a command over numbered drafts we recorded ourselves.
    if (job.kind === "approval_reply") {
      const summary = await approvalReply(db, loc, job, settings, gctx, log);
      await finish(db, job, run.id, "succeeded", steps, inTok, outTok, summary, null);
      return;
    }

    const taskText = `Now: ${new Date().toISOString()} (${settings.timezone ?? "America/Chicago"}). Mode: ${cv.mode ?? "?"}.\n` + spec.task(job.payload ?? {}) + (job.kind === "intake"
      ? (inbound ? `\n\nINBOUND MESSAGE FROM THE LEAD (verbatim — this is what you are classifying; copy any address from it exactly, including the house number): """${inbound}"""`
                 : `\n\nNo inbound message text exists yet for this lead (webhook had none, no INBOUND: note, no inbound conversation). Treat it as a lead with unknown damage: ask for the one most useful thing (address first, then photos).`)
      : job.kind === "inbound_reply" ? `\n\nTHE REPLY (verbatim): """${inbound || "(no text found — say so and stop)"}"""` : "");
    const messages: Msg[] = [{ role: "user", content: taskText }];
    let calls = 0, finalText = "";
    for (let turn = 0; turn < MAX_TOOL_CALLS + 5; turn++) {
      if (Date.now() - t0 > JOB_BUDGET_MS) throw new Error("job time budget exceeded");
      const resp = await claude(system, messages, tools);
      inTok += (resp.usage?.input_tokens ?? 0) + (resp.usage?.cache_creation_input_tokens ?? 0) + Math.round((resp.usage?.cache_read_input_tokens ?? 0) / 10); // cache reads billed at 10%
      outTok += resp.usage?.output_tokens ?? 0;
      messages.push({ role: "assistant", content: resp.content });
      const uses = (resp.content as any[]).filter((b) => b.type === "tool_use");
      finalText = (resp.content as any[]).filter((b) => b.type === "text").map((b) => b.text).join("\n") || finalText;
      if (resp.stop_reason !== "tool_use" || uses.length === 0) break;

      const results: any[] = [];
      for (const u of uses) {
        calls++;
        u.input = asciiQuotes(u.input);
        const ts = Date.now();
        let text = "", isError = false;
        if (calls > MAX_TOOL_CALLS) { text = "Tool budget exhausted. Stop and summarize."; isError = true; }
        else if (u.name === SEND) {
          const v = await gate(gctx, u.input as SendArgs);
          const h = await sha(`${u.input.contactId}|${u.input.template ?? ""}|${u.input.message ?? u.input.html ?? ""}`);
          if (!v.ok) {
            await db.from("outbound_log").insert({ location_id: loc, job_id: job.id, contact_id: u.input.contactId, channel: u.input.type, template: u.input.template ?? null, text_hash: h, verdict: `blocked:${v.check}`, detail: v.reason });
            text = `BLOCKED ${v.check}: ${v.reason}. Do not retry. Write the BLOCKED note and continue.`; isError = true;
          } else {
            const { template, approval, booked_event_id, ...fwd } = v.args;
            const r = await callTool(loc, SEND, fwd);
            text = r.text; isError = r.isError;
            await logSend(db, loc, job.id, v.args, template ?? null, h, r, !!v.redirected);
          }
        } else {
          try {
            const r = await callTool(loc, u.name, u.input);
            text = r.text; isError = r.isError;
          } catch (e) {
            text = `TRANSIENT ERROR calling ${u.name}: ${String((e as Error)?.message ?? e).slice(0, 300)}. You may retry this call once.`; isError = true;
          }
        }
        log({ tool: u.name, args: u.name === SEND ? { ...u.input, message: String(u.input.message ?? "").slice(0, 200) } : u.input, ok: !isError, ms: Date.now() - ts, result_excerpt: text.slice(0, 300) });
        results.push({ type: "tool_result", tool_use_id: u.id, content: text.slice(0, 20_000), is_error: isError });
      }
      messages.push({ role: "user", content: results });
    }

    // Intake invariants the skill requires on every lead, enforced in code (idempotent) so a forgetful run can't drop them:
    //   - tags `storm-lead` + `bot-drafted`
    //   - when the draft asks the lead for something (ASK-* template), next_followup_date = tomorrow
    // Conditional tags (needs-photos, insurance, emergency…) stay with the model.
    if (job.kind === "intake" && job.payload?.contact_id) {
      const ts = Date.now();
      // `storm-lead` stays the WF-02 trigger tag in every mode (snapshot); `new-request` is the mode-neutral marker.
      const enforced = ["storm-lead", "new-request", "bot-drafted"];
      const r = await callTool(loc, "contacts_add-tags", { contactId: job.payload.contact_id, tags: enforced });
      log({ tool: "contacts_add-tags", args: { enforced: true, tags: enforced }, ok: !r.isError, ms: Date.now() - ts, result_excerpt: r.text.slice(0, 200) });
      // Facts the worker knows without the model: lead_source (webhook source), storm_event (custom value), and the
      // follow-up date whenever the draft asks the lead for something (ASK-* template).
      const p = job.payload ?? {};
      const fields: { key: string; value: string }[] = [];
      const src = p.source ?? p.lead_source ?? p.contact_source ?? p.contact?.source;
      if (src) fields.push({ key: "lead_source", value: String(src) });
      if (cv.storm_event) fields.push({ key: "storm_event", value: cv.storm_event });
      const askedForInfo = steps.some((s) => /DRAFT:\s*ASK-/i.test(JSON.stringify(s.args ?? "")));
      if (askedForInfo) fields.push({ key: "next_followup_date", value: new Date(Date.now() + 864e5).toISOString().slice(0, 10) });
      if (fields.length) {
        const t2 = Date.now();
        const r2 = await callTool(loc, "contacts_update-contact", { contactId: p.contact_id, fields: { customFields: fields } });
        log({ tool: "contacts_update-contact", args: { enforced: true, fields }, ok: !r2.isError, ms: Date.now() - t2, result_excerpt: r2.text.slice(0, 200) });
      }
    }

    // Every DRAFT the model staged becomes a numbered approval the owner can answer (APPROVE n / NO n / EDIT n).
    if (job.kind !== "approval_reply") await recordDrafts(db, loc, job, steps, log, gctx, settings);

    const summary = finalText.split("SUMMARY:").pop()?.trim().slice(0, 2000) || finalText.slice(-2000);
    await finish(db, job, run.id, "succeeded", steps, inTok, outTok, summary, null);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    const dead = job.attempts >= job.max_attempts;
    const delaySec = Math.min(3600, 30 * 4 ** (job.attempts - 1));   // 30 s, 2 min, 8 min, 32 min, 60 min
    await db.from("job_runs").update({ finished_at: new Date().toISOString(), status: "failed", steps, input_tokens: inTok, output_tokens: outTok, error: msg }).eq("id", run.id);
    await db.from("jobs").update({ status: dead ? "dead" : "queued", last_error: msg, locked_at: null, locked_by: null, run_after: new Date(Date.now() + delaySec * 1000).toISOString(), finished_at: dead ? new Date().toISOString() : null }).eq("id", job.id);
  }
}

// ---------- approvals ----------
const DRAFT_RE = /^\s*DRAFT:\s*([A-Z0-9-]+)\s*\|\s*(\w+)\s*\|[^\n]*\n([\s\S]+)$/i;
const idIn = (excerpt: string) => excerpt.match(/"id"\s*:\s*"([A-Za-z0-9]+)"/)?.[1];
const contactOf = (step: any): string | undefined => step.args?.contactId ?? String(step.args?.path ?? "").match(/\/contacts\/([A-Za-z0-9]+)\//)?.[1];

async function recordDrafts(db: ReturnType<typeof admin>, loc: string, job: any, steps: any[], log: (s: any) => void, gctx: GateCtx, settings: Record<string, any>) {
  const drafts: { contactId: string; template: string; channel: string; text: string; noteId?: string }[] = [];
  const tasks: { contactId: string; taskId?: string; title?: string; dueDate?: string; assignedTo?: string }[] = [];
  for (const st of steps) {
    if (st.ok === false || st.ok === "false") continue;
    const body = st.args?.body?.body ?? st.args?.body;                      // contacts_create-note {body} | hl_request {body:{body}}
    const m = typeof body === "string" ? body.match(DRAFT_RE) : null;
    const cid = contactOf(st);
    if (m && cid && (st.tool === "contacts_create-note" || /\/notes\/?$/.test(String(st.args?.path ?? "")))) {
      drafts.push({ contactId: cid, template: m[1].toUpperCase(), channel: m[2].toLowerCase() === "email" ? "Email" : "SMS", text: m[3].trim(), noteId: idIn(st.result_excerpt ?? "") });
    }
    const isTask = st.tool === "contacts_create-task" || (/\/tasks\/?$/.test(String(st.args?.path ?? "")) && String(st.args?.method ?? "").toUpperCase() === "POST");
    if (isTask && cid) {
      const t = st.args?.body?.title ? st.args.body : st.args;
      if (/^approve:/i.test(String(t?.title ?? ""))) tasks.push({ contactId: cid, taskId: idIn(st.result_excerpt ?? ""), title: t.title, dueDate: t.dueDate, assignedTo: t.assignedTo });
    }
  }
  for (const d of drafts) {
    const { data: dup } = await db.from("approvals").select("id").eq("location_id", loc).eq("contact_id", d.contactId).eq("status", "pending").eq("text", d.text).maybeSingle();
    if (dup) continue;
    await db.from("approvals").update({ status: "superseded", decided_at: new Date().toISOString(), detail: "newer draft for same contact" }).eq("location_id", loc).eq("contact_id", d.contactId).eq("status", "pending");
    const task = tasks.find((t) => t.contactId === d.contactId);
    let contactName = "", golden = false;
    try { const c = JSON.parse((await callTool(loc, "contacts_get-contact", { contactId: d.contactId })).text).contact; contactName = `${c?.firstName ?? ""} ${c?.lastName ?? ""}`.trim(); golden = (c?.tags ?? []).map((t: string) => String(t).toLowerCase()).includes("golden-test"); } catch { /* optional */ }
    let n = 0;
    for (let i = 0; i < 5 && !n; i++) {
      const { data: mx } = await db.from("approvals").select("n").eq("location_id", loc).order("n", { ascending: false }).limit(1).maybeSingle();
      const cand = (mx?.n ?? 0) + 1;
      // Golden-test leads get a number (the grader checks the task title) but never sit in the owner's pending list or brief.
      const { error } = await db.from("approvals").insert({ location_id: loc, n: cand, contact_id: d.contactId, contact_name: contactName, task_id: task?.taskId ?? null, note_id: d.noteId ?? null, template: d.template, channel: d.channel, text: d.text, job_id: job.id, ...(golden ? { status: "superseded", decided_at: new Date().toISOString(), detail: "golden-test lead" } : {}) });
      if (!error) n = cand; else if ((error as any).code !== "23505") throw error;
    }
    if (task?.taskId) {
      const body = `#${n} — reply APPROVE ${n} / NO ${n} / EDIT ${n} <new text>\n\n${d.text}`;
      const r = await callTool(loc, "hl_request", { method: "PUT", path: `/contacts/${d.contactId}/tasks/${task.taskId}`, body: { title: `Approve #${n}: ${d.template} → ${contactName || d.contactId}`, body, dueDate: task.dueDate ?? new Date().toISOString(), assignedTo: task.assignedTo, completed: false } });
      log({ tool: "approval_recorded", ok: !r.isError, args: { n, template: d.template, contact: d.contactId, task: task.taskId }, result_excerpt: r.text.slice(0, 120) });
    } else log({ tool: "approval_recorded", ok: true, args: { n, template: d.template, contact: d.contactId, task: null } });
    // Ping the owner (gate decides: test mode blocks, shadow/live sends to the owner's own record).
    const owner = settings.owner_contact_id as string | undefined;
    if (owner && n && !golden) {
      const ping = `Draft #${n} for ${contactName || "new lead"} (${d.template}): "${d.text}"\nReply APPROVE ${n} / NO ${n} / EDIT ${n} <new text>`;
      const v = await gate(gctx, { type: "SMS", contactId: owner, message: ping, template: "OWNER-PING" });
      if (!v.ok) log({ tool: "conversations_send-a-new-message", ok: false, args: { to: "owner", n, message: ping.slice(0, 120) }, result_excerpt: `BLOCKED ${v.check}: ${v.reason}` });
      else { const { template, approval, booked_event_id, ...fwd } = v.args; const r = await callTool(loc, "conversations_send-a-new-message", fwd); await logSend(db, loc, job.id, v.args, "OWNER-PING", await sha(`${owner}|OWNER-PING|${ping}`), r, false); log({ tool: "conversations_send-a-new-message", ok: !r.isError, args: { to: "owner", n, message: ping.slice(0, 120) }, result_excerpt: r.text.slice(0, 120) }); }
    }
  }
}

async function approvalReply(db: ReturnType<typeof admin>, loc: string, job: any, settings: Record<string, any>, gctx: GateCtx, log: (s: any) => void): Promise<string> {
  const SEND = "conversations_send-a-new-message";
  const p = job.payload ?? {};
  const from = p.contact_id ?? p.contactId ?? p.contact?.id;
  const text = String(p.message ?? p.body ?? p.text ?? "").trim();
  const owner = settings.owner_contact_id as string | undefined;
  if (!owner || from !== owner) { log({ tool: "approval_reply", ok: false, result_excerpt: `ignored: sender ${from} is not the owner ${owner}` }); return `Ignored: reply from ${from} is not the owner.`; }

  const tellOwner = async (msg: string) => {
    const v = await gate(gctx, { type: "SMS", contactId: owner, message: msg, template: "OWNER-REPLY" });
    if (!v.ok) { log({ tool: SEND, ok: false, args: { to: "owner", message: msg.slice(0, 120) }, result_excerpt: `BLOCKED ${v.check}: ${v.reason}` }); return; }
    const { template, approval, booked_event_id, ...fwd } = v.args;
    const r = await callTool(loc, SEND, fwd);
    await logSend(db, loc, job.id, v.args, "OWNER-REPLY", await sha(`${owner}|OWNER-REPLY|${msg}`), r, false);
    log({ tool: SEND, ok: !r.isError, args: { to: "owner", message: msg.slice(0, 120) }, result_excerpt: r.text.slice(0, 120) });
  };
  const completeTask = async (a: any, note: string) => {
    if (a.task_id) await callTool(loc, "hl_request", { method: "PUT", path: `/contacts/${a.contact_id}/tasks/${a.task_id}/completed`, body: { completed: true } }).catch(() => null);
    await callTool(loc, "contacts_create-note", { contactId: a.contact_id, body: note });
  };

  const cmd = text.toUpperCase().replace(/\s+/g, " ").trim();
  const results: string[] = [];
  const nums = (s: string) => [...s.matchAll(/\d+/g)].map((m) => Number(m[0]));
  let targets: number[] = [], action: "approve" | "no" | "edit" | null = null, editText = "";
  if (/^APPROVE ALL\b/.test(cmd)) { action = "approve"; const { data } = await db.from("approvals").select("n").eq("location_id", loc).eq("status", "pending"); targets = (data ?? []).map((r: any) => r.n); }
  else if (/^(APPROVE|YES|OK|SEND)\b/.test(cmd)) { action = "approve"; targets = nums(cmd); }
  else if (/^(NO|SKIP|DECLINE)\b/.test(cmd)) { action = "no"; targets = nums(cmd); }
  else if (/^EDIT\s+(\d+)\s+([\s\S]+)$/i.test(text)) { action = "edit"; const m = text.match(/^EDIT\s+(\d+)\s+([\s\S]+)$/i)!; targets = [Number(m[1])]; editText = m[2].trim(); }
  if (!action || targets.length === 0) {
    await tellOwner(`Didn't catch that. Reply APPROVE n, APPROVE ALL, NO n, or EDIT n <new text>. — Dispatch`);
    return `Unparsed owner reply: "${text.slice(0, 80)}"`;
  }

  for (const n of targets) {
    const { data: a } = await db.from("approvals").select("*").eq("location_id", loc).eq("n", n).maybeSingle();
    if (!a) { results.push(`#${n}: not found`); continue; }
    if (a.status !== "pending") { results.push(`#${n}: already ${a.status}`); continue; }
    if (action === "no") {
      await db.from("approvals").update({ status: "declined", decided_at: new Date().toISOString(), decided_job_id: job.id }).eq("id", a.id);
      await completeTask(a, `DECLINED by owner (#${n}): ${a.template} not sent.`);
      results.push(`#${n}: declined`); continue;
    }
    const msg = action === "edit" ? editText : a.text;
    const v = await gate(gctx, { type: a.channel, contactId: a.contact_id, message: msg, template: a.template, approval: "owner-reply" });
    const h = await sha(`${a.contact_id}|${a.template}|${msg}`);
    if (!v.ok) {
      await db.from("outbound_log").insert({ location_id: loc, job_id: job.id, contact_id: a.contact_id, channel: a.channel, template: a.template, text_hash: h, verdict: `blocked:${v.check}`, detail: v.reason });
      // test mode and quiet hours are temporary conditions: keep the draft pending so the owner can approve again later.
      const keep = v.check === "test_mode" || v.check === "quiet_hours";
      await db.from("approvals").update(keep ? { detail: `${v.check}: ${v.reason}` } : { status: "blocked", decided_at: new Date().toISOString(), decided_job_id: job.id, detail: `${v.check}: ${v.reason}` }).eq("id", a.id);
      await callTool(loc, "contacts_create-note", { contactId: a.contact_id, body: `BLOCKED: ${v.check} — ${v.reason} (owner approved #${n})` });
      log({ tool: SEND, ok: false, args: { n, contactId: a.contact_id, message: msg.slice(0, 120) }, result_excerpt: `BLOCKED ${v.check}: ${v.reason}` });
      results.push(`#${n}: BLOCKED ${v.check}`); continue;
    }
    const { template, approval, booked_event_id, ...fwd } = v.args;
    const r = await callTool(loc, SEND, fwd);
    await logSend(db, loc, job.id, v.args, a.template, h, r, !!v.redirected);
    log({ tool: SEND, ok: !r.isError, args: { n, contactId: a.contact_id, message: msg.slice(0, 120) }, result_excerpt: r.text.slice(0, 120) });
    if (r.isError) { results.push(`#${n}: send error`); continue; }
    await db.from("approvals").update({ status: "sent", decided_at: new Date().toISOString(), decided_job_id: job.id, text: msg, detail: action === "edit" ? "edited by owner" : null }).eq("id", a.id);
    await callTool(loc, "contacts_add-tags", { contactId: a.contact_id, tags: ["bot-sent"] });
    await completeTask(a, `SENT: ${a.template} | ${a.channel.toLowerCase()} | ${new Date().toISOString()}${v.redirected ? " (shadow → owner)" : ""}\n${msg}`);
    results.push(`#${n}: sent${v.redirected ? " (shadow)" : ""}`);
  }
  const line = results.join(" · ");
  await tellOwner(`${line} — Dispatch`);
  return `Owner replied "${text.slice(0, 40)}": ${line}`;
}

// Owner welcome sequence. Step 1 = W-1 SMS + W-2 email (then schedules step 3 for +3 days); step 3 = W-3 recap with real counts.
// Never on the template; never while mode=test (deferred 30 min at a time, up to 14 days); owner-only, so the gate's
// homeowner rules (price/date/length/quiet hours/weekly cap) do not apply but kill switch, DND and dedupe do.
async function welcome(db: ReturnType<typeof admin>, loc: string, job: any, cv: Record<string, string>, settings: Record<string, any>, gctx: GateCtx, log: (s: any) => void): Promise<{ summary: string; defer?: boolean; blocked?: boolean }> {
  const SEND = "conversations_send-a-new-message";
  const p = job.payload ?? {};
  const step = Number(p.step ?? 1) === 3 ? 3 : 1;
  if (loc === TEMPLATE_LOCATION) return { summary: "welcome skipped: template sub-account never gets welcomes", blocked: true };
  const owner = settings.owner_contact_id as string | undefined;
  if (!owner) return { summary: "welcome blocked: owner_contact_id missing in tenant settings", blocked: true };
  const mode = (cv.mode ?? "test").toLowerCase();
  if (mode === "test") {
    const d = Number(p.deferred ?? 0);
    if (d >= WELCOME_MAX_DEFERS) return { summary: `welcome step ${step} abandoned: mode still test after 14 days`, blocked: true };
    return { summary: `mode=test — welcome step ${step} waits for shadow/storm/standard (check ${d + 1})`, defer: true };
  }

  const c = await gctx.getContact(owner).catch(() => null);
  const co = c?.contact ?? c ?? {};
  const v: Record<string, string> = {
    first: String(co.firstName ?? "").trim() || "Hi",
    company: String(cv.company_name ?? settings.company_name ?? "").trim() || "your company",
    number: String(settings.sms_number ?? "").trim() || "this number",
    brief_time: String(settings.brief_time ?? "6:00 AM"),
    leads_count: "0", approved_count: "0", blocked_count: "0",
  };

  const results: string[] = [];
  const send = async (template: string, args: Partial<SendArgs>) => {
    const text = String(args.message ?? args.html ?? "");
    const vd = await gate(gctx, { type: "SMS", ...args, contactId: owner, template } as SendArgs);
    const h = await sha(`${owner}|${template}|${text}`);
    if (!vd.ok) {
      await db.from("outbound_log").insert({ location_id: loc, job_id: job.id, contact_id: owner, channel: String(args.type ?? "SMS"), template, text_hash: h, verdict: `blocked:${vd.check}`, detail: vd.reason });
      log({ tool: SEND, ok: false, args: { template, to: "owner" }, result_excerpt: `BLOCKED ${vd.check}: ${vd.reason}` });
      results.push(`${template}: BLOCKED ${vd.check}`); return false;
    }
    const { template: _t, approval: _a, booked_event_id: _b, ...fwd } = vd.args;
    const r = await callTool(loc, SEND, fwd);
    await logSend(db, loc, job.id, vd.args, template, h, r, false);
    log({ tool: SEND, ok: !r.isError, args: { template, to: "owner", chars: text.length }, result_excerpt: r.text.slice(0, 120) });
    results.push(`${template}: ${r.isError ? "send error" : "sent"}`); return !r.isError;
  };

  if (step === 1) {
    await send("WELCOME-1", { type: "SMS", message: WELCOME.w1(v) });
    const html = WELCOME.w2(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
    await send("WELCOME-2", { type: "Email", subject: WELCOME.w2subject(v), html });
    const runAt = new Date(Date.now() + 3 * 864e5).toISOString();
    const { error } = await db.from("jobs").insert({ location_id: loc, kind: "welcome", payload: { step: 3, since: new Date().toISOString(), source: "welcome-step-1" }, dedupe_key: `welcome3|${loc}`, priority: 100, run_after: runAt });
    results.push(error ? (error.code === "23505" ? "W-3 already scheduled" : `W-3 schedule error: ${error.message}`) : `W-3 scheduled ${runAt.slice(0, 16)}Z`);
  } else {
    const since = typeof p.since === "string" ? p.since : new Date(Date.now() - 3 * 864e5).toISOString();
    const [leads, approved, blocked] = await Promise.all([
      db.from("jobs").select("id", { count: "exact", head: true }).eq("location_id", loc).eq("kind", "intake").gte("created_at", since),
      db.from("approvals").select("id", { count: "exact", head: true }).eq("location_id", loc).eq("status", "sent").gte("created_at", since),
      db.from("approvals").select("id", { count: "exact", head: true }).eq("location_id", loc).in("status", ["blocked", "declined"]).gte("created_at", since),
    ]);
    v.leads_count = String(leads.count ?? 0); v.approved_count = String(approved.count ?? 0); v.blocked_count = String(blocked.count ?? 0);
    await send("WELCOME-3", { type: "SMS", message: WELCOME.w3(v) });
  }
  const line = results.join(" · ");
  await callTool(loc, "contacts_create-note", { contactId: owner, body: `WELCOME step ${step} | ${new Date().toISOString()} | ${line}` }).catch(() => null);
  await db.from("tenant_events").insert({ location_id: loc, event: `welcome:${step}`, detail: { results, mode } });
  return { summary: `welcome step ${step}: ${line}`, blocked: !results.some((r) => r.endsWith(": sent")) };
}

// Health check, in code (was a 175K-token model run). Mirrors skills/health-check/SKILL.md. Writes custom value
// bot_last_health = "{ISO} {OK|FAIL} {failing checks}"; emails the agency on a hard failure. Never messages homeowners.
async function healthCheck(db: ReturnType<typeof admin>, loc: string, job: any, cv: Record<string, string>, settings: Record<string, any>, trade: string, log: (s: any) => void): Promise<string> {
  const hard: string[] = [], warn: string[] = [];
  const mode = (cv.mode ?? "test").toLowerCase();
  // custom values + setup guard
  for (const k of ["bots_enabled", "mode", "trade", "company_name", "owner_phone", "wh_intake", "wh_approval", "wh_optout", "bot_webhook_key", "bot_webhook_key_intake", "wf02_id"]) if (!cv[k]) hard.push(`custom_values:${k}`);
  for (const p of setupProblems(loc, cv)) hard.push(`setup:${p.replace(/\s+/g, "_").slice(0, 40)}`);
  // company files + owner ids
  const { data: files } = await db.from("tenant_files").select("path").eq("location_id", loc);
  const have = new Set((files ?? []).map((f: any) => f.path));
  for (const f of ["company-profile.md", "service-area.md", "pricing-guardrails.md", "do-not-contact.csv"]) if (!have.has(f)) hard.push(`company_files:${f}`);
  if (!settings.owner_contact_id) hard.push("company_files:owner_contact_id"); if (!settings.owner_user_id) warn.push("owner_user_id_missing");
  if (!cv.wh_reply) warn.push("custom_values:wh_reply_missing(WF-13_replies_not_wired)");
  if (trade && !(await repoFile(`trades/${trade}.md`))) hard.push(`company_files:trades/${trade}.md`);
  // pipelines + workflows (one gateway call each)
  try { const r = await callTool(loc, "opportunities_get-pipelines", {}); const names = (JSON.parse(r.text).pipelines ?? []).map((p: any) => p.name); for (const n of ["Storm Response", "Standard Jobs"]) if (!names.includes(n)) hard.push(`pipelines:${n.replace(/\s+/g, "_")}`); } catch (e) { hard.push("pipelines:unreadable"); log({ tool: "opportunities_get-pipelines", ok: false, result_excerpt: String(e).slice(0, 120) }); }
  try { const r = await callTool(loc, "workflows_get-workflows", {}); const wfs: any[] = JSON.parse(r.text).workflows ?? []; for (const want of ["WF-02", "WF-11", "WF-12"]) { const w = wfs.find((x) => String(x.name ?? "").startsWith(want)); if (!w) hard.push(`workflows:${want}_missing`); else if (String(w.status ?? "").toLowerCase() !== "published") hard.push(`workflows:${want}_${w.status}`); } } catch (e) { warn.push("workflows_unreadable"); log({ tool: "workflows_get-workflows", ok: false, result_excerpt: String(e).slice(0, 120) }); }
  // phone + compliance (tables)
  const [{ data: a2p }, { data: nums }, { count: stale }, { count: failed24 }, { data: leads }] = await Promise.all([
    db.from("a2p_registrations").select("campaign_status").eq("location_id", loc).maybeSingle(),
    db.from("numbers").select("number, kind, verified, status").eq("location_id", loc).eq("status", "active"),
    db.from("approvals").select("id", { count: "exact", head: true }).eq("location_id", loc).eq("status", "pending").lt("created_at", new Date(Date.now() - 864e5).toISOString()),
    db.from("outbound_log").select("id", { count: "exact", head: true }).eq("location_id", loc).in("delivery_status", ["failed", "undelivered"]).gte("created_at", new Date(Date.now() - 864e5).toISOString()),
    db.from("jobs").select("payload").eq("location_id", loc).eq("kind", "intake").gte("created_at", new Date(Date.now() - 7 * 864e5).toISOString()),
  ]);
  const live = mode === "storm" || mode === "standard";
  if (!settings.sms_number && !(nums ?? []).length) (live ? hard : warn).push("phone:no_number");
  const bridge = (nums ?? []).some((n: any) => n.kind === "tollfree" && n.verified);
  if (live && a2p?.campaign_status !== "approved" && !bridge) hard.push(`a2p:${a2p?.campaign_status ?? "not_started"}`);
  if (settings.sms_paused) hard.push("carrier_pause");
  if ((stale ?? 0) > 0) warn.push(`stale_approvals(${stale})`);
  if ((failed24 ?? 0) > 0) warn.push(`delivery_failures(${failed24})`);
  const cids = [...new Set((leads ?? []).map((j: any) => j.payload?.contact_id).filter(Boolean))];
  if (cids.length) { const { data: cons } = await db.from("consents").select("contact_id").eq("location_id", loc).in("contact_id", cids); const withC = new Set((cons ?? []).map((c: any) => c.contact_id)); const missing = cids.filter((c) => !withC.has(c)).length; if (missing) warn.push(`consent_missing(${missing})`); }
  const status = hard.length ? "FAIL" : "OK";
  const line = `${new Date().toISOString()} ${status} ${[...hard, ...warn].join(",") || "all_checks_passed"}`;
  // write bot_last_health. HighLevel keeps the merge key ({{custom_values.x}}) even if a value is renamed, so match on
  // the key, and flag any value whose name no longer matches its key (a renamed wh_* breaks the workflow webhooks).
  let hLine = line;
  try {
    const r = await callTool(loc, "locations_get-custom-values", {});
    const all: any[] = JSON.parse(r.text).customValues ?? [];
    const keyOf = (v: any) => String(v.fieldKey ?? "").replace(/^\{\{\s*custom_values\.|\s*\}\}$/g, "").trim();
    const renamed = all.filter((v) => keyOf(v) && keyOf(v) !== v.name).map((v) => `${keyOf(v)}→${v.name}`);
    if (renamed.length) { hard.push(`custom_values:renamed(${renamed.join(";")})`); hLine = `${new Date().toISOString()} FAIL ${[...hard, ...warn].join(",")}`; }
    const m = all.find((v) => keyOf(v) === "bot_last_health") ?? all.find((v) => v.name === "bot_last_health");
    if (m) await callTool(loc, "locations_update-custom-value", { customValueId: m.id, name: "bot_last_health", value: hLine });
    else await callTool(loc, "hl_request", { method: "POST", path: `/locations/${loc}/customValues`, body: { name: "bot_last_health", value: hLine } });
    log({ tool: "bot_last_health", ok: true, result_excerpt: hLine });
  } catch (e) { log({ tool: "bot_last_health", ok: false, result_excerpt: String(e).slice(0, 120) }); }
  const finalStatus = hard.length ? "FAIL" : "OK";
  await db.from("tenant_events").insert({ location_id: loc, event: `health:${finalStatus.toLowerCase()}`, detail: { hard, warn, mode } });
  return `health_check ${finalStatus}: ${[...hard, ...warn].join(", ") || "all checks passed"}`;
}

// Delivery monitor: follow up every send with HighLevel's message status; auto-pause SMS on a carrier block pattern.
const CARRIER_ERR = /30007|30008|30034|carrier|spam|filtered|blocked|unregistered|10dlc|a2p/i;
async function deliveryCheck(db: ReturnType<typeof admin>, loc: string, job: any, settings: Record<string, any>, gctx: GateCtx, log: (s: any) => void): Promise<string> {
  const since = new Date(Date.now() - 48 * 3600e3).toISOString();
  const { data: rows } = await db.from("outbound_log").select("id, message_id, contact_id, channel").eq("location_id", loc).eq("verdict", "sent").not("message_id", "is", null).gte("created_at", since).or("delivery_status.is.null,delivery_status.in.(pending,sent)").limit(100);
  let checked = 0, delivered = 0, failed = 0, optouts = 0;
  const errors: string[] = [];
  for (const row of rows ?? []) {
    const r = await callTool(loc, "hl_request", { method: "GET", path: `/conversations/messages/${row.message_id}` });
    checked++;
    if (r.isError) { log({ tool: "delivery_check", ok: false, args: { id: row.id }, result_excerpt: r.text.slice(0, 120) }); continue; }
    let m: any = {}; try { m = JSON.parse(r.text); m = m.message ?? m; } catch { /* keep */ }
    const status = String(m.status ?? "pending").toLowerCase();
    const err = m.error ? String(m.error).slice(0, 300) : null;
    await db.from("outbound_log").update({ delivery_status: status, delivery_error: err, checked_at: new Date().toISOString() }).eq("id", row.id);
    if (status === "delivered" || status === "read") delivered++;
    if (status === "failed" || status === "undelivered") { failed++; if (err) errors.push(err); }
    if (status === "opt_out") { optouts++; await recordConsent(db, loc, row.contact_id, "opted_out", "hl_dnd", `message ${row.message_id} status opt_out`, job.id); await callTool(loc, "contacts_add-tags", { contactId: row.contact_id, tags: ["do-not-contact"] }); }
  }
  // Carrier-block rule over the trailing hour of SMS: ≥3 failures and ≥50% failure rate, or ≥2 failures with a carrier/spam error text.
  const hourAgo = new Date(Date.now() - 3600e3).toISOString();
  const { data: recent } = await db.from("outbound_log").select("delivery_status, delivery_error").eq("location_id", loc).eq("verdict", "sent").eq("channel", "SMS").gte("created_at", hourAgo).not("delivery_status", "is", null);
  const sms = recent ?? [];
  const f = sms.filter((x: any) => x.delivery_status === "failed" || x.delivery_status === "undelivered");
  const carrierHits = f.filter((x: any) => CARRIER_ERR.test(String(x.delivery_error ?? ""))).length;
  const block = (f.length >= 3 && f.length / Math.max(1, sms.length) >= 0.5) || carrierHits >= 2;
  let paused = "";
  if (block && !settings.sms_paused) {
    const reason = `carrier block pattern: ${f.length}/${sms.length} SMS failed in the last hour${carrierHits ? ` (${carrierHits} carrier/spam errors)` : ""}`;
    const newSettings = { ...settings, sms_paused: { at: new Date().toISOString(), reason } };
    await db.from("tenants").update({ settings: newSettings }).eq("location_id", loc);
    await db.from("tenant_events").insert({ location_id: loc, event: "carrier_block", detail: { reason, errors: errors.slice(0, 5) } });
    const owner = settings.owner_contact_id as string | undefined;
    if (owner) {
      await callTool(loc, "contacts_create-note", { contactId: owner, body: `SMS PAUSED | ${new Date().toISOString()} | ${reason}. Texting to homeowners is paused until Ty resumes it (dispatch_sms-resume).` });
      const v = await gate(gctx, { type: "Email", contactId: owner, subject: "Dispatch paused texting — carrier block", html: `Dispatch stopped sending texts to homeowners: ${reason}.<br><br>Nothing is lost — drafts keep queuing for your approval. Ty is checking the number/A2P registration and will resume texting.<br><br>— Dispatch`, template: "OWNER-ALERT" });
      if (v.ok) { const { template: _t, approval: _a, booked_event_id: _b, ...fwd } = v.args; const r = await callTool(loc, "conversations_send-a-new-message", fwd); await logSend(db, loc, job.id, v.args, "OWNER-ALERT", await sha(`${owner}|OWNER-ALERT|${reason}`), r, false); }
    }
    paused = ` — SMS PAUSED (${reason})`;
    log({ tool: "carrier_block", ok: false, result_excerpt: reason });
  }
  return `delivery_check: ${checked} checked, ${delivered} delivered, ${failed} failed, ${optouts} opt-outs${paused}`;
}

// Put a job back in the queue for later without charging it an attempt (used when a precondition is not met yet).
async function defer(db: ReturnType<typeof admin>, job: any, runId: number, steps: any[], summary: string, ms: number) {
  await db.from("job_runs").update({ finished_at: new Date().toISOString(), status: "deferred", steps, summary }).eq("id", runId);
  await db.from("jobs").update({ status: "queued", run_after: new Date(Date.now() + ms).toISOString(), attempts: Math.max(0, Number(job.attempts) - 1), payload: { ...(job.payload ?? {}), deferred: Number(job.payload?.deferred ?? 0) + 1 }, locked_at: null, locked_by: null }).eq("id", job.id);
}

async function finish(db: ReturnType<typeof admin>, job: any, runId: number, status: string, steps: any[], inTok: number, outTok: number, summary: string, error: string | null) {
  await db.from("job_runs").update({ finished_at: new Date().toISOString(), status, steps, input_tokens: inTok, output_tokens: outTok, summary, error }).eq("id", runId);
  await db.from("jobs").update({ status: "succeeded", result: { status, summary }, locked_at: null, locked_by: null, finished_at: new Date().toISOString() }).eq("id", job.id);
}

// ---------- entry ----------
Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  const key = req.headers.get("x-dispatch-key") ?? (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (key !== env("DISPATCH_INTERNAL_KEY")) return json(401, { error: "bad key" });
  const body = await req.json().catch(() => ({}));
  const db = admin();
  const started = Date.now();
  const done: any[] = [];

  await db.rpc("requeue_stale_jobs");
  const limit = Math.max(1, Math.min(5, Number(body.limit ?? 3)));
  while (Date.now() - started < INVOCATION_BUDGET_MS - JOB_BUDGET_MS) {
    const { data: jobs, error } = await db.rpc("claim_jobs", { p_worker: WORKER_ID, p_limit: 1 });
    if (error) return json(500, { error: error.message, done });
    if (!jobs || jobs.length === 0) break;
    for (const job of jobs) {
      await runJob(db, job);
      done.push({ id: job.id, kind: job.kind, location_id: job.location_id });
      if (done.length >= limit) break;
    }
    if (done.length >= limit) break;
  }
  return json(200, { worker: WORKER_ID, processed: done.length, jobs: done, ms: Date.now() - started });
});
