// Dispatch — HighLevel gateway. Office (and the worker) talk to HighLevel through this; they never hold a HighLevel token.
//   POST /functions/v1/dispatch-hl/mcp        -> Dispatch MCP server (Streamable HTTP, stateless JSON responses).
//                                                Tool names mirror HighLevel's own MCP so the skills don't change.
//   *    /functions/v1/dispatch-hl/api/<path> -> https://services.leadconnectorhq.com/<path>  (raw REST pass-through)
// Caller auth: `Authorization: Bearer <DISPATCH_INTERNAL_KEY>` (or `x-dispatch-key`) + `locationId: <sub-account>` header.
// HighLevel's first-party MCP only accepts Private Integration Tokens, not marketplace OAuth tokens — hence our own.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { admin, env, json } from "../_shared/ghl.ts";

const HL = "https://services.leadconnectorhq.com";
const HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "authorization", "x-dispatch-key", "apikey", "locationid"]);

// ---------- token (per-isolate cache in front of the broker) ----------
const cache = new Map<string, { token: string; exp: number }>();
async function tokenFor(locationId: string): Promise<string> {
  const hit = cache.get(locationId);
  if (hit && hit.exp - Date.now() > 60_000) return hit.token;
  const r = await fetch(`${env("PUBLIC_BASE_URL")}/functions/v1/dispatch-token`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-dispatch-key": env("DISPATCH_INTERNAL_KEY") },
    body: JSON.stringify({ locationId }),
  });
  if (!r.ok) throw new Error(`broker ${r.status}: ${await r.text()}`);
  const j = await r.json();
  cache.set(locationId, { token: j.access_token, exp: new Date(j.expires_at).getTime() });
  return j.access_token;
}

// ---------- REST helper ----------
type Ctx = { loc: string; token: string };
async function hl(ctx: Ctx, method: string, path: string, body?: unknown, query?: Record<string, unknown>) {
  const u = new URL(HL + path);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  const r = await fetch(u, {
    method,
    headers: { Authorization: `Bearer ${ctx.token}`, Version: "2021-07-28", Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data: unknown = text;
  try { data = JSON.parse(text); } catch { /* keep text */ }
  if (!r.ok) throw Object.assign(new Error(`HighLevel ${r.status} ${method} ${path}: ${typeof data === "string" ? data : JSON.stringify(data)}`), { status: r.status, data });
  return data;
}

// ---------- tools ----------
type Tool = { description: string; input: Record<string, unknown>; required?: string[]; run: (ctx: Ctx, a: any) => Promise<unknown> };
const S = (description: string, type = "string") => ({ type, description });
const tools: Record<string, Tool> = {
  // contacts
  "contacts_get-contact": { description: "Get a contact by id.", input: { contactId: S("Contact id") }, required: ["contactId"], run: (c, a) => hl(c, "GET", `/contacts/${a.contactId}`) },
  "contacts_search": { description: "Search contacts in this sub-account. `query` is free text (name, phone, email); optional `filters` array uses HighLevel's search filter syntax.", input: { query: S("Free-text search"), filters: S("HighLevel filters array", "array"), limit: S("Max results (default 20)", "number"), page: S("Page", "number") }, run: (c, a) => hl(c, "POST", "/contacts/search", { locationId: c.loc, query: a.query, filters: a.filters, pageLimit: a.limit ?? 20, page: a.page ?? 1 }) },
  "contacts_create-contact": { description: "Create a contact. Fields: firstName, lastName (or name), email, phone, address1, city, state, postalCode, tags[], customFields[{id|key,value}], source. Give at least one of firstName/lastName/name/email/phone.", input: { contact: S("Contact fields object", "object") }, required: ["contact"], run: async (c, a) => hl(c, "POST", "/contacts/", await withFieldIds(c, cleanContact(a.contact, c.loc))) },
  "contacts_upsert-contact": { description: "Upsert a contact by phone/email.", input: { contact: S("Contact fields object", "object") }, required: ["contact"], run: async (c, a) => hl(c, "POST", "/contacts/upsert", await withFieldIds(c, cleanContact(a.contact, c.loc))) },
  "contacts_update-contact": { description: "Update contact fields (firstName, lastName, email, phone, address, customFields[{id|key,value}], tags[] …). customFields may use the field's name as key (e.g. urgency_score); it is resolved to the field id for you.", input: { contactId: S("Contact id"), fields: S("Fields to update", "object") }, required: ["contactId", "fields"], run: async (c, a) => hl(c, "PUT", `/contacts/${a.contactId}`, await withFieldIds(c, a.fields)) },
  "contacts_add-tags": { description: "Add tags to a contact.", input: { contactId: S("Contact id"), tags: S("Tags", "array") }, required: ["contactId", "tags"], run: (c, a) => hl(c, "POST", `/contacts/${a.contactId}/tags`, { tags: a.tags }) },
  "contacts_remove-tags": { description: "Remove tags from a contact.", input: { contactId: S("Contact id"), tags: S("Tags", "array") }, required: ["contactId", "tags"], run: (c, a) => hl(c, "DELETE", `/contacts/${a.contactId}/tags`, { tags: a.tags }) },
  "contacts_create-note": { description: "Add a note to a contact.", input: { contactId: S("Contact id"), body: S("Note text") }, required: ["contactId", "body"], run: (c, a) => hl(c, "POST", `/contacts/${a.contactId}/notes`, { body: a.body }) },
  "contacts_get-notes": { description: "List a contact's notes.", input: { contactId: S("Contact id") }, required: ["contactId"], run: (c, a) => hl(c, "GET", `/contacts/${a.contactId}/notes`) },
  "contacts_create-task": { description: "Create a task on a contact.", input: { contactId: S("Contact id"), title: S("Title"), body: S("Body"), dueDate: S("ISO due date"), assignedTo: S("User id"), completed: S("Completed", "boolean") }, required: ["contactId", "title", "dueDate"], run: (c, a) => hl(c, "POST", `/contacts/${a.contactId}/tasks`, { title: a.title, body: a.body ?? "", dueDate: a.dueDate, assignedTo: a.assignedTo, completed: a.completed ?? false }) },
  "contacts_get-all-tasks": { description: "List a contact's tasks.", input: { contactId: S("Contact id") }, required: ["contactId"], run: (c, a) => hl(c, "GET", `/contacts/${a.contactId}/tasks`) },
  "contacts_add-to-workflow": { description: "Enroll a contact in a workflow.", input: { contactId: S("Contact id"), workflowId: S("Workflow id"), eventStartTime: S("Optional ISO start time") }, required: ["contactId", "workflowId"], run: (c, a) => hl(c, "POST", `/contacts/${a.contactId}/workflow/${a.workflowId}`, a.eventStartTime ? { eventStartTime: a.eventStartTime } : {}) },
  "contacts_remove-from-workflow": { description: "Remove a contact from a workflow.", input: { contactId: S("Contact id"), workflowId: S("Workflow id") }, required: ["contactId", "workflowId"], run: (c, a) => hl(c, "DELETE", `/contacts/${a.contactId}/workflow/${a.workflowId}`) },
  // conversations
  "conversations_search-conversation": { description: "Search conversations. Filter by contactId, free-text query, status (all|read|unread|starred|recents), lastMessageType.", input: { contactId: S("Contact id"), query: S("Free text"), status: S("Status filter"), lastMessageType: S("e.g. TYPE_SMS"), limit: S("Max (default 20)", "number") }, run: (c, a) => hl(c, "GET", "/conversations/search", undefined, { locationId: c.loc, contactId: a.contactId, query: a.query, status: a.status, lastMessageType: a.lastMessageType, limit: a.limit ?? 20 }) },
  "conversations_get-messages": { description: "Get messages in a conversation (newest first).", input: { conversationId: S("Conversation id"), limit: S("Max (default 20)", "number"), lastMessageId: S("Paging cursor"), type: S("Comma-separated message types") }, required: ["conversationId"], run: (c, a) => hl(c, "GET", `/conversations/${a.conversationId}/messages`, undefined, { limit: a.limit ?? 20, lastMessageId: a.lastMessageId, type: a.type }) },
  "conversations_send-a-new-message": { description: "Send a message to a contact. type: SMS | Email | WhatsApp | Live_Chat. Email needs subject/html. ONLY after the send-gate skill has approved the send.", input: { type: S("SMS|Email|WhatsApp|Live_Chat"), contactId: S("Contact id"), message: S("Text body"), subject: S("Email subject"), html: S("Email HTML"), emailFrom: S("From address"), fromNumber: S("Sending number"), toNumber: S("Destination number override"), scheduledTimestamp: S("Unix seconds to schedule", "number") }, required: ["type", "contactId"], run: (c, a) => hl(c, "POST", "/conversations/messages", { type: a.type, contactId: a.contactId, message: a.message, subject: a.subject, html: a.html, emailFrom: a.emailFrom, fromNumber: a.fromNumber, toNumber: a.toNumber, scheduledTimestamp: a.scheduledTimestamp }) },
  // opportunities
  "opportunities_get-pipelines": { description: "List pipelines and their stages (ids + names).", input: {}, run: (c) => hl(c, "GET", "/opportunities/pipelines", undefined, { locationId: c.loc }) },
  "opportunities_search-opportunity": { description: "Search opportunities. Filter by contact_id, pipeline_id, pipeline_stage_id, status (open|won|lost|abandoned|all), q (text).", input: { contact_id: S("Contact id"), pipeline_id: S("Pipeline id"), pipeline_stage_id: S("Stage id"), status: S("Status"), q: S("Text"), limit: S("Max (default 20)", "number") }, run: (c, a) => hl(c, "GET", "/opportunities/search", undefined, { location_id: c.loc, contact_id: a.contact_id, pipeline_id: a.pipeline_id, pipeline_stage_id: a.pipeline_stage_id, status: a.status, q: a.q, limit: a.limit ?? 20 }) },
  "opportunities_get-opportunity": { description: "Get an opportunity.", input: { opportunityId: S("Opportunity id") }, required: ["opportunityId"], run: (c, a) => hl(c, "GET", `/opportunities/${a.opportunityId}`) },
  "opportunities_create-opportunity": { description: "Create an opportunity: pipelineId, pipelineStageId, name, contactId, status (open), monetaryValue, assignedTo.", input: { opportunity: S("Fields", "object") }, required: ["opportunity"], run: (c, a) => hl(c, "POST", "/opportunities/", { ...a.opportunity, locationId: c.loc }) },
  "opportunities_update-opportunity": { description: "Update an opportunity (pipelineStageId, status, name, monetaryValue, assignedTo …).", input: { opportunityId: S("Opportunity id"), fields: S("Fields to update", "object") }, required: ["opportunityId", "fields"], run: (c, a) => hl(c, "PUT", `/opportunities/${a.opportunityId}`, a.fields) },
  // calendars
  "calendars_get-calendars": { description: "List calendars.", input: {}, run: (c) => hl(c, "GET", "/calendars/", undefined, { locationId: c.loc }) },
  "calendars_get-calendar-events": { description: "Events between startTime and endTime (ISO or epoch ms). Give exactly one of calendarId, userId, groupId.", input: { startTime: S("ISO or ms"), endTime: S("ISO or ms"), calendarId: S("Calendar id"), userId: S("User id"), groupId: S("Group id") }, required: ["startTime", "endTime"], run: (c, a) => hl(c, "GET", "/calendars/events", undefined, { locationId: c.loc, startTime: ms(a.startTime), endTime: ms(a.endTime), calendarId: a.calendarId, userId: a.userId, groupId: a.groupId }) },
  "calendars_get-appointment-notes": { description: "Notes on an appointment.", input: { appointmentId: S("Appointment id"), limit: S("Max", "number"), offset: S("Offset", "number") }, required: ["appointmentId"], run: (c, a) => hl(c, "GET", `/calendars/appointments/${a.appointmentId}/notes`, undefined, { limit: a.limit ?? 10, offset: a.offset ?? 0 }) },
  "calendars_create-appointment": { description: "Book an appointment: calendarId, contactId, startTime, endTime, title, assignedUserId, appointmentStatus.", input: { appointment: S("Fields", "object") }, required: ["appointment"], run: (c, a) => hl(c, "POST", "/calendars/events/appointments", { ...a.appointment, locationId: c.loc }) },
  // location / config
  "locations_get-location": { description: "This sub-account's details (name, address, phone, timezone, settings).", input: {}, run: (c) => hl(c, "GET", `/locations/${c.loc}`) },
  "locations_get-custom-fields": { description: "Contact/opportunity custom field definitions.", input: { model: S("contact|opportunity|all") }, run: (c, a) => hl(c, "GET", `/locations/${c.loc}/customFields`, undefined, { model: a.model }) },
  "locations_get-custom-values": { description: "All custom values (bots_enabled, mode, trade, wh_* …).", input: {}, run: (c) => hl(c, "GET", `/locations/${c.loc}/customValues`) },
  "locations_update-custom-value": { description: "Set a custom value by its id (get ids from locations_get-custom-values).", input: { customValueId: S("Custom value id"), name: S("Name"), value: S("New value") }, required: ["customValueId", "name", "value"], run: (c, a) => hl(c, "PUT", `/locations/${c.loc}/customValues/${a.customValueId}`, { name: a.name, value: a.value }) },
  "locations_get-tags": { description: "List tags.", input: {}, run: (c) => hl(c, "GET", `/locations/${c.loc}/tags`) },
  "workflows_get-workflows": { description: "List workflows (id, name, status).", input: {}, run: (c) => hl(c, "GET", "/workflows/", undefined, { locationId: c.loc }) },
  "users_get-users": { description: "Users on this sub-account.", input: {}, run: (c) => hl(c, "GET", "/users/", undefined, { locationId: c.loc }) },
  // Dispatch platform (not HighLevel): onboarding. Proxies to dispatch-setup with the internal key.
  "dispatch_setup-customer": { description: "Set up a NEW client sub-account for Dispatch: creates it from the Dispatch snapshot (or reuses location_id), waits for the snapshot, creates the tenant + ingest key, owner contact, writes all 16 custom values (webhooks point at the cloud worker, mode=test) and the company files. Idempotent: re-run with location_id to finish steps. Returns location_id, owner_contact_id and the list of remaining manual steps. Pass dry_run=true to validate only. Only call this when Ty has asked to onboard a specific client.", input: { company_name: S("Company name exactly as on the EIN letter"), trade: S("roofing|fencing|gutters|screen-enclosures|tree-service|restoration|turf|other"), owner_first: S("Owner first name"), owner_last: S("Owner last name"), owner_phone: S("Owner cell"), owner_email: S("Owner email"), phone: S("Business phone"), website: S("Website"), address1: S("Street"), city: S("City"), state: S("State"), postal_code: S("ZIP"), timezone: S("IANA tz, default America/Chicago"), service_zips: S("ZIPs served (comma string or array)"), license_number: S("License number"), business_hours: S("Business hours"), google_profile: S("Google Business Profile link"), review_link: S("Review link"), auto_ack: S("true when the owner chose 'auto-send 3 basic replies'", "boolean"), storm_event: S("Current storm event label, e.g. 'Isaias 2026-10'"), location_id: S("Existing sub-account id to reuse (re-run)"), dry_run: S("Validate only", "boolean") }, required: ["company_name", "trade", "owner_first", "owner_last", "owner_phone"], run: async (_c, a) => {
    const r = await fetch(`${env("PUBLIC_BASE_URL")}/functions/v1/dispatch-setup`, { method: "POST", headers: { "content-type": "application/json", "x-dispatch-key": env("DISPATCH_INTERNAL_KEY") }, body: JSON.stringify(a) });
    const text = await r.text();
    if (!r.ok) throw new Error(`dispatch-setup ${r.status}: ${text.slice(0, 500)}`);
    return JSON.parse(text);
  } },
  // Dispatch platform: owner welcome sequence (W-1 SMS + W-2 email now, W-3 SMS day 3). Code-only, owner-only; waits while mode=test.
  "dispatch_welcome": { description: "Queue the owner welcome sequence for THIS sub-account (W-1 text + W-2 email, then the day-3 recap). Owner-only onboarding messages from config/welcome-copy.md; the worker holds them while mode=test and sends once the account is in shadow/storm/standard. Call once, right after the golden test PASSES on a client sub-account (never on the template).", input: { location_id: S("Sub-account id (defaults to this one)") }, run: async (c, a) => {
    const loc = String(a.location_id ?? c.loc);
    const r = await fetch(`${env("PUBLIC_BASE_URL")}/functions/v1/dispatch-ingest/welcome`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env("DISPATCH_INTERNAL_KEY")}` }, body: JSON.stringify({ location_id: loc, step: 1, source: "golden-test" }) });
    const text = await r.text();
    if (!r.ok) throw new Error(`dispatch-ingest ${r.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } },
  // Dispatch platform: compliance (consent ledger, A2P tracker, numbers, carrier pause). All enforced by the worker's send gate.
  "dispatch_consent": { description: "Record SMS consent for a contact in the Dispatch consent ledger. The gate blocks live homeowner SMS without an opted_in record. Use status=opted_in with source=owner_attested only when the owner confirms the customer asked for texts (say who/when in evidence); use opted_out when a customer asks to stop by any channel.", input: { contact_id: S("Contact id"), status: S("opted_in|opted_out"), source: S("owner_attested|web_form|inbound_sms|missed_call|import|stop_keyword"), evidence: S("What proves it: who said what, when, form id, etc.") }, required: ["contact_id", "status", "source", "evidence"], run: async (c, a) => {
    if (!["opted_in", "opted_out"].includes(a.status)) throw new Error("status must be opted_in or opted_out");
    const db = admin();
    const { error } = await db.from("consents").insert({ location_id: c.loc, contact_id: a.contact_id, channel: "SMS", status: a.status, source: a.source, evidence: String(a.evidence).slice(0, 500) });
    if (error) throw new Error(error.message);
    if (a.status === "opted_out") { await hl(c, "POST", `/contacts/${a.contact_id}/tags`, { tags: ["do-not-contact"] }).catch(() => null); await hl(c, "PUT", `/contacts/${a.contact_id}`, { dnd: true }).catch(() => null); }
    const { data } = await db.from("consents").select("status, source, created_at").eq("location_id", c.loc).eq("contact_id", a.contact_id).order("created_at", { ascending: false }).limit(5);
    return { ok: true, history: data };
  } },
  "dispatch_a2p-status": { description: "Read or update this sub-account's 10DLC (A2P) registration tracker. With no args: returns current status. To update: pass brand_status/campaign_status (not_started|pending|approved|rejected) and optional ids/notes. The gate refuses live homeowner SMS until campaign_status=approved (or a verified toll-free bridge number is assigned). Also mirrors a2p_status into the sub-account custom value.", input: { brand_status: S("not_started|pending|approved|rejected"), campaign_status: S("not_started|pending|approved|rejected"), brand_id: S("Brand id"), campaign_id: S("Campaign id"), notes: S("Notes (rejection reason, resubmit date…)") }, run: async (c, a) => {
    const db = admin();
    const ok = (v: unknown) => v === undefined || ["not_started", "pending", "approved", "rejected"].includes(String(v));
    if (!ok(a.brand_status) || !ok(a.campaign_status)) throw new Error("status must be not_started|pending|approved|rejected");
    if (a.brand_status || a.campaign_status || a.brand_id || a.campaign_id || a.notes) {
      const { data: cur } = await db.from("a2p_registrations").select("*").eq("location_id", c.loc).maybeSingle();
      const row: Record<string, unknown> = { location_id: c.loc, ...(cur ?? {}), updated_at: new Date().toISOString() };
      for (const k of ["brand_status", "campaign_status", "brand_id", "campaign_id", "notes"]) if (a[k] !== undefined) row[k] = a[k];
      if (row.campaign_status === "pending" && !row.submitted_at) row.submitted_at = new Date().toISOString();
      if (row.campaign_status === "approved" && !row.approved_at) row.approved_at = new Date().toISOString();
      const { error } = await db.from("a2p_registrations").upsert(row, { onConflict: "location_id" });
      if (error) throw new Error(error.message);
      try {
        const cv: any = await hl(c, "GET", `/locations/${c.loc}/customValues`);
        const m = (cv.customValues ?? []).find((v: any) => v.name === "a2p_status");
        const val = `brand=${row.brand_status} campaign=${row.campaign_status}`;
        if (m) await hl(c, "PUT", `/locations/${c.loc}/customValues/${m.id}`, { name: "a2p_status", value: val }); else await hl(c, "POST", `/locations/${c.loc}/customValues`, { name: "a2p_status", value: val });
      } catch { /* custom value is a mirror only */ }
    }
    const { data } = await db.from("a2p_registrations").select("*").eq("location_id", c.loc).maybeSingle();
    const { data: nums } = await db.from("numbers").select("number, kind, verified, status, purpose").eq("location_id", c.loc);
    return { a2p: data ?? { location_id: c.loc, brand_status: "not_started", campaign_status: "not_started" }, numbers: nums ?? [] };
  } },
  "dispatch_numbers": { description: "Dispatch number registry (per sub-account + agency toll-free pool). action=list (this sub-account + unassigned pool), add (number, kind local|tollfree, verified, purpose primary|bridge; location_id optional — omit to add to the pool), assign (number → this sub-account, purpose), release (number → back to pool / status released). A verified, active toll-free number assigned here is used as the from-number for homeowner SMS while 10DLC is pending.", input: { action: S("list|add|assign|release"), number: S("E.164, e.g. +18505550123"), kind: S("local|tollfree"), verified: S("Toll-free verification approved", "boolean"), purpose: S("primary|bridge"), location_id: S("Sub-account to add to (add only); omit for the agency pool"), notes: S("Notes") }, required: ["action"], run: async (c, a) => {
    const db = admin();
    const now = new Date().toISOString();
    if (a.action === "add") {
      if (!a.number || !a.kind) throw new Error("number and kind required");
      const { error } = await db.from("numbers").insert({ location_id: a.location_id ?? null, number: a.number, kind: a.kind, verified: !!a.verified, purpose: a.purpose ?? (a.kind === "tollfree" ? "bridge" : "primary"), notes: a.notes ?? null });
      if (error) throw new Error(error.message);
    } else if (a.action === "assign") {
      if (!a.number) throw new Error("number required");
      const { error } = await db.from("numbers").update({ location_id: c.loc, status: "active", purpose: a.purpose ?? "bridge", updated_at: now }).eq("number", a.number);
      if (error) throw new Error(error.message);
      const s = await db.from("tenants").select("settings").eq("location_id", c.loc).maybeSingle();
      if (a.purpose === "primary" || !s.data?.settings?.sms_number) await db.from("tenants").update({ settings: { ...(s.data?.settings ?? {}), sms_number: a.number } }).eq("location_id", c.loc);
    } else if (a.action === "release") {
      if (!a.number) throw new Error("number required");
      const { error } = await db.from("numbers").update({ location_id: null, status: "released", updated_at: now }).eq("number", a.number);
      if (error) throw new Error(error.message);
    } else if (a.action !== "list") throw new Error("action must be list|add|assign|release");
    const { data: mine } = await db.from("numbers").select("number, kind, verified, status, purpose, notes").eq("location_id", c.loc);
    const { data: pool } = await db.from("numbers").select("number, kind, verified, status, purpose, notes").is("location_id", null).neq("status", "released");
    return { location: c.loc, assigned: mine ?? [], pool: pool ?? [] };
  } },
  "dispatch_sms-resume": { description: "Clear the carrier-block SMS pause on this sub-account (set automatically by the delivery monitor when sends start failing). Only after the cause is fixed (number/A2P). Returns the pause record that was cleared.", input: { note: S("What was fixed") }, run: async (c, a) => {
    const db = admin();
    const { data: t } = await db.from("tenants").select("settings").eq("location_id", c.loc).maybeSingle();
    const paused = t?.settings?.sms_paused ?? null;
    if (!paused) return { ok: true, was_paused: false };
    const { sms_paused: _p, ...rest } = t!.settings;
    await db.from("tenants").update({ settings: rest }).eq("location_id", c.loc);
    await db.from("tenant_events").insert({ location_id: c.loc, event: "carrier_block_cleared", detail: { paused, note: a.note ?? null } });
    return { ok: true, was_paused: true, cleared: paused };
  } },
  // escape hatch
  "hl_request": { description: "Raw HighLevel REST call for anything above doesn't cover. path like /contacts/{id}/notes. locationId is NOT added automatically — include it in query/body where the endpoint needs it (this sub-account's id is in the `locationId` field of locations_get-location).", input: { method: S("GET|POST|PUT|DELETE"), path: S("Path under services.leadconnectorhq.com"), query: S("Query params", "object"), body: S("JSON body", "object") }, required: ["method", "path"], run: (c, a) => hl(c, a.method.toUpperCase(), a.path, a.body, a.query) },
};
// HighLevel rejects a contact body with both `name` and firstName/lastName, empty strings, or unknown keys like contactId.
function cleanContact(input: any, loc: string) {
  const c: Record<string, unknown> = { ...(input ?? {}) };
  if ((c.firstName || c.lastName) && c.name) delete c.name;
  if (c.name && !c.firstName && !c.lastName) { const [f, ...r] = String(c.name).trim().split(/\s+/); c.firstName = f; if (r.length) c.lastName = r.join(" "); delete c.name; }
  for (const k of Object.keys(c)) if (c[k] === "" || c[k] === null || c[k] === undefined) delete c[k];
  delete c.id; delete c.contactId; delete c.locationId;
  if (Array.isArray(c.tags)) c.tags = c.tags.map((t: unknown) => String(t).toLowerCase());
  return { ...c, locationId: loc };
}
// HighLevel only reliably applies customFields by id. Models write {key:"contact.urgency_score"} / {key:"urgency_score"} /
// {id:"urgency_score"}; resolve every entry to {id, field_value} using the location's field definitions (cached 10 min).
const fieldCache = new Map<string, { at: number; byKey: Map<string, string>; ids: Set<string> }>();
async function fieldMap(ctx: Ctx) {
  const hit = fieldCache.get(ctx.loc);
  if (hit && Date.now() - hit.at < 600_000) return hit;
  const data: any = await hl(ctx, "GET", `/locations/${ctx.loc}/customFields`, undefined, { model: "contact" });
  const byKey = new Map<string, string>(), ids = new Set<string>();
  for (const f of data?.customFields ?? []) {
    ids.add(f.id);
    const fk = String(f.fieldKey ?? "");                       // "contact.urgency_score"
    const bare = fk.replace(/^contact\./, "");
    for (const k of [fk, bare, String(f.name ?? "").toLowerCase().replace(/\s+/g, "_")]) if (k) byKey.set(k.toLowerCase(), f.id);
  }
  const entry = { at: Date.now(), byKey, ids };
  fieldCache.set(ctx.loc, entry);
  return entry;
}
async function withFieldIds(ctx: Ctx, body: any) {
  if (!body || !Array.isArray(body.customFields) || body.customFields.length === 0) return body;
  const fm = await fieldMap(ctx);
  const out: any[] = [];
  for (const cf of body.customFields) {
    if (!cf || typeof cf !== "object") continue;
    const value = cf.field_value ?? cf.value;
    let id: string | undefined = fm.ids.has(cf.id) ? cf.id : undefined;
    if (!id) for (const cand of [cf.key, cf.id, cf.fieldKey, cf.name]) { const hit = cand && fm.byKey.get(String(cand).toLowerCase()); if (hit) { id = hit; break; } }
    out.push(id ? { id, field_value: value } : cf);          // unknown field: pass through untouched so HL reports it
  }
  return { ...body, customFields: out };
}
const ms = (v: string | number) => (typeof v === "number" || /^\d+$/.test(String(v))) ? Number(v) : new Date(v).getTime();

function toolList() {
  return Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: { type: "object", properties: t.input, required: t.required ?? [] } }));
}

// ---------- MCP (JSON-RPC over POST; stateless) ----------
async function rpc(ctx: Ctx, msg: any): Promise<any | null> {
  const { id, method, params } = msg;
  if (id === undefined) return null; // notification
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const err = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  switch (method) {
    case "initialize":
      return ok({ protocolVersion: params?.protocolVersion ?? "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "dispatch-hl", version: "1.0.0" } });
    case "ping": return ok({});
    case "tools/list": return ok({ tools: toolList() });
    case "tools/call": {
      const t = tools[params?.name];
      if (!t) return err(-32602, `unknown tool ${params?.name}`);
      try {
        const data = await t.run(ctx, params?.arguments ?? {});
        return ok({ content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }], isError: false });
      } catch (e: any) {
        return ok({ content: [{ type: "text", text: e?.message ?? String(e) }], isError: true });
      }
    }
    default: return err(-32601, `method not found: ${method}`);
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/dispatch-hl/, "") || "/";

  const key = req.headers.get("x-dispatch-key") ?? (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (key !== env("DISPATCH_INTERNAL_KEY")) return json(401, { error: "bad key" });
  const loc = req.headers.get("locationid") ?? url.searchParams.get("locationId");
  if (!loc) return json(400, { error: "locationId header required" });

  let token: string;
  try { token = await tokenFor(loc); } catch (e) { return json(502, { error: String(e) }); }
  const ctx: Ctx = { loc, token };

  if (path === "/mcp" || path === "/mcp/") {
    if (req.method === "GET") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    if (req.method === "DELETE") return new Response(null, { status: 204 });
    if (req.method !== "POST") return json(405, { error: "POST only" });
    let body: any;
    try { body = await req.json(); } catch { return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => rpc(ctx, m)))).filter(Boolean);
      return out.length ? json(200, out) : new Response(null, { status: 202 });
    }
    const out = await rpc(ctx, body);
    return out ? json(200, out) : new Response(null, { status: 202 });
  }

  if (path.startsWith("/api/")) {
    const target = `${HL}${path.slice(4)}${url.search}`;
    const headers = new Headers();
    for (const [k, v] of req.headers) if (!HOP.has(k.toLowerCase())) headers.set(k, v);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("Version", "2021-07-28");
    const upstream = await fetch(target, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(), redirect: "manual" });
    const out = new Headers();
    for (const [k, v] of upstream.headers) if (!HOP.has(k.toLowerCase())) out.set(k, v);
    return new Response(upstream.body, { status: upstream.status, headers: out });
  }

  return json(404, { error: "use /mcp or /api/<highlevel path>", path });
});
