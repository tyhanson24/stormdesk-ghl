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
const skillCache = new Map<string, string>();
async function repoFile(path: string): Promise<string> {
  if (skillCache.has(path)) return skillCache.get(path)!;
  const r = await fetch(`${SKILLS_BASE()}/${path}`);
  const t = r.ok ? await r.text() : "";
  if (r.ok) skillCache.set(path, t);
  return t;
}

const KIND_SPEC: Record<string, { skills: string[]; task: (p: any) => string }> = {
  intake: { skills: ["storm-intake"], task: (p) => `New lead webhook received. Run storm-intake on contact ${p.contact_id} using this payload: ${JSON.stringify(p)}. Draft the reply as a contact note (exact DRAFT format) + an approval task for the owner. If auto_ack covers ACK-1, send it through the gate.` },
  approval_reply: { skills: [], task: (p) => `Owner replied to an approval. Reply text: ${JSON.stringify(p.message ?? p.body ?? "")}. Owner contact: ${p.contact_id}. Find the matching open "Approve:" task(s) on the owner's tasks and the DRAFT notes they reference. APPROVE ALL / APPROVE n → send that draft exactly as written via conversations_send-a-new-message with template set to the draft's template id and approval set to "owner-reply"; tag bot-sent; mark the task complete; convert the DRAFT note to SENT. NO n → mark the task complete with the owner's note, do not send. EDIT n <text> → replace the draft text, re-run the gate, send. Anything else → leave tasks open and say so.` },
  appointment_completed: { skills: ["estimate-drafting"], task: (p) => `Appointment complete for contact ${p.contact_id}. Payload: ${JSON.stringify(p)}. Draft the estimate from the appointment notes and photos per estimate-drafting. Stage for approval as a contact task. Send nothing.` },
  crew_done: { skills: ["permits-inspections"], task: (p) => `Job marked done for contact ${p.contact_id}. Payload: ${JSON.stringify(p)}. Per permits-inspections: request inspection, draft the homeowner window text as a DRAFT note + approval task. Send nothing to the homeowner.` },
  daily_brief: { skills: ["daily-brief"], task: () => `Produce the daily brief per daily-brief. Deliver it to the owner's contact record (SMS + email) through the gate.` },
  health_check: { skills: ["health-check"], task: () => `Run health-check. Write bot_last_health. Report hard failures.` },
  custom: { skills: [], task: (p) => String(p.instruction ?? "No instruction given. Say so and stop.") },
};

// ---------- gateway (our MCP) ----------
async function mcp(loc: string, method: string, params: unknown) {
  const r = await fetch(`${env("PUBLIC_BASE_URL")}/functions/v1/dispatch-hl/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-dispatch-key": env("DISPATCH_INTERNAL_KEY"), locationId: loc },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(60_000),
  });
  const j = await r.json();
  if (j.error) throw new Error(`gateway ${method}: ${j.error.message}`);
  return j.result;
}
async function callTool(loc: string, name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
  const res = await mcp(loc, "tools/call", { name, arguments: args });
  return { text: res?.content?.[0]?.text ?? "", isError: !!res?.isError };
}

// ---------- model ----------
type Msg = { role: "user" | "assistant"; content: any };
async function claude(system: string, messages: Msg[], tools: any[]) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL(), max_tokens: 4096, system, messages, tools, tool_choice: { type: "auto" } }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!r.ok) throw new Error(`model ${r.status}: ${(await r.text()).slice(0, 500)}`);
  return await r.json();
}

// ---------- one job ----------
async function runJob(db: ReturnType<typeof admin>, job: any) {
  const loc = job.location_id as string;
  const t0 = Date.now();
  const { data: run } = await db.from("job_runs").insert({ job_id: job.id, attempt: job.attempts, model: MODEL() }).select("id").single();
  const steps: any[] = [];
  let inTok = 0, outTok = 0;
  const log = (s: any) => { steps.push(s); };

  try {
    const spec = KIND_SPEC[job.kind] ?? KIND_SPEC.custom;
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

    const trade = (cv.trade ?? settings.trade ?? "").toString().trim().toLowerCase();
    const [rules, sendGate, ...kindSkills] = await Promise.all([
      repoFile("skills/ghl-operating-rules/SKILL.md"), repoFile("skills/send-gate/SKILL.md"),
      ...spec.skills.map((s) => repoFile(`skills/${s}/SKILL.md`)),
      ...((job.payload?.skills as string[] | undefined) ?? []).map((s) => repoFile(`skills/${s}/SKILL.md`)),
    ]);
    const pack = trade ? await repoFile(`trades/${trade}.md`) : "";

    const system = [
      `You are Dispatch, the operations agent for one home-service contractor's HighLevel sub-account (locationId ${loc}). You act ONLY through the tools provided. There is no filesystem: the company files you would read from /workspace are included below. Mode and flags come from the custom values already read: mode=${cv.mode ?? "?"}, bots_enabled=${cv.bots_enabled ?? "?"}, trade=${trade || "?"}, company_name=${cv.company_name ?? "?"}. Owner contact id: ${settings.owner_contact_id ?? "unknown (search by owner_phone custom value if needed)"}. Timezone: ${settings.timezone ?? "America/Chicago"}. Now: ${new Date().toISOString()}.`,
      `Every send through conversations_send-a-new-message is checked by a code-level send gate before it reaches HighLevel; if it comes back BLOCKED, write the BLOCKED note as the send-gate skill says and move on — never retry with different wording or another channel. Pass "template" (template id) and, for approved drafts, "approval" on every send call.`,
      `Be economical: at most ${MAX_TOOL_CALLS} tool calls. When done, end with a final message whose last paragraph starts with "SUMMARY:" and has 3–8 lines: what you read, what you changed, what's waiting on approval, what blocked you.`,
      "\n# ghl-operating-rules\n" + rules, "\n# send-gate\n" + sendGate,
      ...kindSkills.map((s, i) => `\n# skill ${i + 1}\n` + s),
      pack ? "\n# trade pack\n" + pack : "",
      ...Object.entries(fileMap).map(([p, c]) => `\n# /workspace/${p}\n` + c),
    ].join("\n");

    const SEND = "conversations_send-a-new-message";
    const tools = toolList.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
    const sendTool = tools.find((t) => t.name === SEND);
    if (sendTool) sendTool.input_schema = { ...sendTool.input_schema, properties: { ...sendTool.input_schema.properties, template: { type: "string", description: "Template id (e.g. ACK-1). Required." }, approval: { type: "string", description: "Approval token: 'owner-reply' when sending an owner-approved draft." }, booked_event_id: { type: "string", description: "Calendar event id if the text states a date." } } };

    const dnc = (fileMap["do-not-contact.csv"] ?? "").split(/\r?\n/).slice(1).map((l: string) => l.split(",")[0]?.trim()).filter(Boolean);
    const gctx: GateCtx = {
      db, locationId: loc, jobId: job.id, jobKind: job.kind, customValues: cv, settings,
      inboundText: typeof job.payload?.message === "string" ? job.payload.message : undefined,
      getContact: async (id) => { const r = await callTool(loc, "contacts_get-contact", { contactId: id }); return JSON.parse(r.text); },
      dncList: dnc,
    };

    const messages: Msg[] = [{ role: "user", content: spec.task(job.payload ?? {}) }];
    let calls = 0, finalText = "";
    for (let turn = 0; turn < MAX_TOOL_CALLS + 5; turn++) {
      if (Date.now() - t0 > JOB_BUDGET_MS) throw new Error("job time budget exceeded");
      const resp = await claude(system, messages, tools);
      inTok += resp.usage?.input_tokens ?? 0; outTok += resp.usage?.output_tokens ?? 0;
      messages.push({ role: "assistant", content: resp.content });
      const uses = (resp.content as any[]).filter((b) => b.type === "tool_use");
      finalText = (resp.content as any[]).filter((b) => b.type === "text").map((b) => b.text).join("\n") || finalText;
      if (resp.stop_reason !== "tool_use" || uses.length === 0) break;

      const results: any[] = [];
      for (const u of uses) {
        calls++;
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
            await db.from("outbound_log").insert({ location_id: loc, job_id: job.id, contact_id: v.args.contactId, channel: v.args.type, template: template ?? null, text_hash: h, verdict: r.isError ? "error" : (v.redirected ? "redirected:shadow" : "sent"), detail: r.isError ? r.text.slice(0, 300) : (v.redirected ? "shadow redirect to owner" : null) });
          }
        } else {
          const r = await callTool(loc, u.name, u.input);
          text = r.text; isError = r.isError;
        }
        log({ tool: u.name, args: u.name === SEND ? { ...u.input, message: String(u.input.message ?? "").slice(0, 200) } : u.input, ok: !isError, ms: Date.now() - ts, result_excerpt: text.slice(0, 300) });
        results.push({ type: "tool_result", tool_use_id: u.id, content: text.slice(0, 20_000), is_error: isError });
      }
      messages.push({ role: "user", content: results });
    }

    const summary = finalText.split("SUMMARY:").pop()?.trim().slice(0, 2000) || finalText.slice(-2000);
    await finish(db, job, run.id, "succeeded", steps, inTok, outTok, summary, null);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    const dead = job.attempts >= job.max_attempts;
    const delayMin = Math.min(60, 2 ** job.attempts);
    await db.from("job_runs").update({ finished_at: new Date().toISOString(), status: "failed", steps, input_tokens: inTok, output_tokens: outTok, error: msg }).eq("id", run.id);
    await db.from("jobs").update({ status: dead ? "dead" : "queued", last_error: msg, locked_at: null, locked_by: null, run_after: new Date(Date.now() + delayMin * 60_000).toISOString(), finished_at: dead ? new Date().toISOString() : null }).eq("id", job.id);
  }
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
