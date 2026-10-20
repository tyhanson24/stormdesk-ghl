// Dispatch — ingest. HighLevel workflows POST here; we turn each event into one durable job and return fast.
//   POST /functions/v1/dispatch-ingest/<kind>        kind = intake | approval_reply | appointment_completed | crew_done | custom
//   headers: Authorization: Bearer <tenant ingest_key  OR  DISPATCH_INTERNAL_KEY>
//   body: the workflow's JSON (must carry location_id, or a link containing /location/<id>/)
// Idempotent: dedupe_key = kind + contact_id + (event_id | message snippet | minute bucket). HighLevel retries ⇒ one job.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { admin, env, json } from "../_shared/ghl.ts";

const KINDS = new Set(["intake", "approval_reply", "appointment_completed", "crew_done", "custom"]);

async function sha(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  const url = new URL(req.url);
  const kind = url.pathname.replace(/^.*\/dispatch-ingest\/?/, "").replace(/\/$/, "") || "custom";
  if (!KINDS.has(kind)) return json(404, { error: "unknown kind", kind });

  const key = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "") || req.headers.get("x-dispatch-key") || "";
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return json(400, { error: "JSON body required" });

  // Resolve the sub-account.
  let locationId: string | null = body.location_id ?? body.locationId ?? null;
  if (!locationId && typeof body.link === "string") locationId = body.link.match(/\/location\/([A-Za-z0-9]+)\//)?.[1] ?? null;
  if (!locationId) return json(400, { error: "location_id missing (add \"location_id\":\"{{location.id}}\" to the webhook body)" });

  const db = admin();
  const { data: tenant } = await db.from("tenants").select("id, status, settings").eq("location_id", locationId).maybeSingle();
  const ingestKey = tenant?.settings?.ingest_key as string | undefined;
  const masterOk = key && key === env("DISPATCH_INTERNAL_KEY");
  const tenantOk = ingestKey && key === ingestKey;
  if (!masterOk && !tenantOk) return json(401, { error: "bad key" });
  if (tenant && tenant.status !== "installed") return json(409, { error: "tenant not installed", status: tenant.status });

  const contactId = body.contact_id ?? body.contactId ?? body?.contact?.id ?? null;
  const eventId = body.event_id ?? body.eventId ?? body.message_id ?? null;
  const bucket = new Date().toISOString().slice(0, 16); // minute
  const dedupe = await sha(`${locationId}|${kind}|${contactId ?? ""}|${eventId ?? (body.message ?? "").toString().slice(0, 200) + bucket}`);

  const priority = kind === "intake" || kind === "approval_reply" ? 50 : 100;
  const { data: job, error } = await db.from("jobs")
    .insert({ location_id: locationId, kind, payload: body, dedupe_key: dedupe, priority })
    .select("id").single();
  if (error) {
    if ((error as any).code === "23505") return json(202, { ok: true, deduped: true });
    return json(500, { error: error.message });
  }

  // Poke the worker so the job starts now rather than at the next cron tick. Fire-and-forget.
  fetch(`${env("PUBLIC_BASE_URL")}/functions/v1/dispatch-worker`, {
    method: "POST",
    headers: { "x-dispatch-key": env("DISPATCH_INTERNAL_KEY"), "content-type": "application/json" },
    body: JSON.stringify({ poke: job.id }),
  }).catch(() => {});

  return json(202, { ok: true, job_id: job.id, kind, location_id: locationId });
});
