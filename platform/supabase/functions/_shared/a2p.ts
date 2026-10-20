// Dispatch — A2P (10DLC) registration packet + public SMS policy pages. Pure functions; no network.
// The packet is what Ty pastes into HighLevel's Trust Center (brand + campaign) for a client sub-account.
// Everything comes from the sub-account record, tenant settings (ein, owner_*), company-profile.md and the trade pack.

export type A2pInput = {
  loc: string;
  base: string;                       // PUBLIC_BASE_URL
  company: string;                    // legal / DBA name
  ein?: string;                       // digits only
  address?: string;                   // "123 Main St, Pensacola, FL 32501"
  website?: string;
  owner_first?: string;
  owner_last?: string;
  owner_phone?: string;
  business_phone?: string;            // the number homeowners call/text (LC number once bought, else Business Info phone)
  owner_email?: string;
  trade?: string;
  storm_event?: string;
  review_link?: string;
  pack: Record<string, string>;       // parsed trade pack (key: value lines)
  sms_number?: string;
};

export function parsePack(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([a-z0-9_.]+):\s*(.*)$/i);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

export function policyUrls(base: string, loc: string) {
  return { sms_terms: `${base}/functions/v1/dispatch-public/sms-terms/${loc}`, privacy: `${base}/functions/v1/dispatch-public/privacy/${loc}` };
}

const fmtPhone = (p?: string) => { const d = (p ?? "").replace(/\D/g, ""); return d.length === 10 ? `+1${d}` : d.length === 11 && d.startsWith("1") ? `+${d}` : (p ?? ""); };
const fmtEin = (e?: string) => (e && e.length === 9 ? `${e.slice(0, 2)}-${e.slice(2)}` : e ?? "");

export function sampleMessages(i: A2pInput): string[] {
  const c = i.company;
  const p = i.pack;
  const next = p.estimate_next_step || "we'll text you an estimate window";
  const photos = p.photo_guidance || "2–3 photos from the ground";
  const noun = p.trade_noun || i.trade || "repair";
  const event = (i.storm_event || "").replace(/\s*\d{4}-\d{2}(-\d{2})?\s*$/, "").trim() || "storm";   // "Isaias 2026-10" → "Isaias"
  return [
    `Thanks Maria. You're on our list for 1420 Oak St. We're working ${event} damage in order of severity and date received. Next step: ${next}. Reply here anytime. Reply STOP to opt out. — ${c}`,
    `Got it, 1420 Oak St. If you can safely take ${photos}, text them here — it helps us put you in the right line. — ${c}`,
    `${c}: our estimator is scheduled for your ${noun} Tue 2–4 PM. Reply YES to confirm or tell us a better window. Reply STOP to opt out.`,
    `Hi Maria, your ${noun} job at 1420 Oak St is complete. Thank you for trusting ${c}. If anything needs a second look, reply here. — ${c}`,
  ];
}

export function buildPacket(i: A2pInput): { markdown: string; missing: string[] } {
  const urls = policyUrls(i.base, i.loc);
  const missing: string[] = [];
  if (!i.ein) missing.push("ein (9 digits; re-run setup-customer with ein=… or set tenants.settings.ein)");
  if (!i.address) missing.push("business address (sub-account Business Info)");
  if (!i.website) missing.push("website (sub-account Business Info; a Google Business Profile URL is accepted)");
  if (!i.owner_email) missing.push("owner_email (setup-customer owner_email)");
  if (!i.sms_number) missing.push("phone number (buy one LC Phone number first; the campaign needs a number to attach)");
  const owner = [i.owner_first, i.owner_last].filter(Boolean).join(" ") || "(owner)";
  const samples = sampleMessages(i);
  const md = `# A2P 10DLC registration packet — ${i.company}
Sub-account: ${i.loc} · Trade: ${i.trade ?? ""} · Generated: ${new Date().toISOString().slice(0, 10)}
${missing.length ? `\n> **Missing before submit:** ${missing.join("; ")}\n` : ""}
Paste into HighLevel → Settings → Phone Numbers → Trust Center. Submit the **Brand** first; when it shows Verified, submit the **Campaign**. Then update the tracker: \`dispatch_a2p-status\` brand_status / campaign_status.

## 1. Brand (Standard)
| Field | Value |
|---|---|
| Legal business name | ${i.company} |
| DBA / brand name | ${i.company} |
| EIN | ${fmtEin(i.ein) || "**MISSING**"} |
| Business type | Private company (LLC/Corp) — change to Sole Proprietor if no EIN |
| Industry / vertical | Construction / Home services (${i.trade ?? "contractor"}) |
| Country | US |
| Address | ${i.address || "**MISSING**"} |
| Website | ${i.website || "**MISSING**"} |
| Contact name | ${owner} |
| Contact phone | ${fmtPhone(i.owner_phone)} |
| Contact email | ${i.owner_email || "**MISSING**"} |
| Stock exchange / ticker | n/a (private) |

## 2. Campaign (Low Volume Mixed)
| Field | Value |
|---|---|
| Use case | Low Volume Mixed |
| Sub-use cases | Customer Care, Delivery Notifications (appointment / crew updates), Account Notifications |
| Campaign description | ${i.company} is a licensed ${i.trade ?? "home-service"} contractor. We text homeowners who contacted us about ${i.pack.job_noun || "repair"} work: to confirm we received their request, ask for property details or photos, schedule and confirm estimate and crew visits, send job-status updates, and follow up after the job. Conversational, one-to-one, low volume. No marketing blasts. |
| Message flow / how consumers opt in | Homeowners opt in by (1) texting our business number first with a service request, (2) submitting our "Storm Damage Request" web form, which includes the SMS consent checkbox and disclosure below, or (3) calling our business line, where the greeting states that we reply by text, and receiving our missed-call text-back. Every reply includes STOP instructions on the first message. Consent is recorded per contact with timestamp and source. Terms: ${urls.sms_terms} · Privacy: ${urls.privacy} |
| Opt-in keywords | (none — opt-in is by inbound inquiry / web form) |
| Opt-in message | Thanks for contacting ${i.company}. We'll reply here by text about your request. Msg & data rates may apply. Msg frequency varies. Reply HELP for help, STOP to opt out. |
| Opt-out keywords | STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT |
| Opt-out message | You're unsubscribed from ${i.company} texts. No more messages will be sent. Reply START to resubscribe. |
| Help keywords | HELP, INFO |
| Help message | ${i.company}: text or call ${fmtPhone(i.business_phone ?? i.owner_phone) || "our office"}${i.owner_email ? ` or email ${i.owner_email}` : ""}. Msg & data rates may apply. Reply STOP to opt out. |
| Subscriber opt-in | Yes |
| Subscriber opt-out | Yes |
| Subscriber help | Yes |
| Number pooling | No |
| Direct lending / loan arrangement | No |
| Embedded links | ${i.review_link ? "Yes — a Google review link is sent once after job completion; no shortened URLs" : "No"} |
| Embedded phone numbers | Yes — our own business number in HELP replies |
| Age-gated content | No |
| Affiliate marketing | No |

### Sample messages
${samples.map((s, n) => `${n + 1}. ${s}`).join("\n")}

## 3. Web form consent language (add to "Storm Damage Request")
Checkbox (unchecked by default, required): **I agree to receive text messages from ${i.company} about my service request at the number provided. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help. See our [SMS Terms](${urls.sms_terms}) and [Privacy Policy](${urls.privacy}).**

## 4. Website footer / Google Business Profile
Add links to the SMS Terms and Privacy Policy above. If the company has no site, use the Google Business Profile URL as the website and put both links in the profile description.
The hosted URLs above serve the policies as plain text (Supabase only renders HTML on a custom domain). Preferred: paste tenant files \`sms-terms.html\` and \`privacy.html\` (same text, styled) onto the client's website or a HighLevel page in this sub-account and link those instead.

## 5. Checklist
- [ ] Phone number bought (LC Phone) and set as the sub-account default
- [ ] EIN, address, website, contact email all filled above
- [ ] Brand submitted → Verified
- [ ] Campaign submitted (Low Volume Mixed) → Approved (typically 1–7 business days; rejections usually cite opt-in flow or sample messages)
- [ ] \`dispatch_a2p-status\` updated at each step (gate stays closed until campaign_status=approved)
- [ ] Web form consent checkbox added (section 3)
- [ ] Policy links live (section 4)
- [ ] While pending: assign a verified toll-free bridge from the agency pool (\`dispatch_numbers\` assign) if the client needs to text before approval
`;
  return { markdown: md, missing };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;color:#1a1a1a}h1{font-size:26px}h2{font-size:19px;margin-top:28px}p,li{margin:8px 0}footer{margin-top:40px;color:#666;font-size:14px}</style></head><body>${body}</body></html>`;
}

export function smsTermsHtml(company: string, phone?: string, email?: string, privacyUrl?: string): string {
  const contact = [phone ? `call or text ${esc(phone)}` : "", email ? `email ${esc(email)}` : ""].filter(Boolean).join(" or ") || "contact us";
  return page(`${company} — SMS Terms`, `<h1>${esc(company)} — SMS Terms &amp; Conditions</h1>
<p>By texting ${esc(company)}, submitting our service request form with the SMS consent box checked, or calling us and receiving our text reply, you agree to receive text messages from ${esc(company)} about your service request.</p>
<h2>What we send</h2>
<p>Confirmations that we received your request, questions about your property or damage, estimate and crew scheduling, job-status updates, and a follow-up after the work is done. Messages are conversational and specific to your request. We do not send marketing blasts.</p>
<h2>Frequency and cost</h2>
<p>Message frequency varies with your request. Message and data rates may apply. Carriers are not liable for delayed or undelivered messages.</p>
<h2>Opting out</h2>
<p>Reply <strong>STOP</strong> at any time to stop receiving texts. You will get one confirmation message and nothing further. Reply <strong>START</strong> to resubscribe.</p>
<h2>Help</h2>
<p>Reply <strong>HELP</strong> for help, or ${contact}.</p>
<h2>Privacy</h2>
<p>Your phone number and messages are used only to handle your service request. We do not sell or share your mobile information with third parties for their marketing. ${privacyUrl ? `See our <a href="${esc(privacyUrl)}">Privacy Policy</a>.` : ""}</p>
<footer>${esc(company)}</footer>`);
}

export function privacyHtml(company: string, phone?: string, email?: string, address?: string): string {
  const contact = [phone ? `call or text ${esc(phone)}` : "", email ? `email ${esc(email)}` : ""].filter(Boolean).join(" or ") || "contact us";
  return page(`${company} — Privacy Policy`, `<h1>${esc(company)} — Privacy Policy</h1>
<p>Effective ${new Date().toISOString().slice(0, 10)}. This policy covers information ${esc(company)} collects when you contact us about ${esc(company)} services by phone, text, email, or our web form.</p>
<h2>Information we collect</h2>
<p>Your name, phone number, email, property address, a description of the work you need, photos you choose to send, and the messages exchanged with us.</p>
<h2>How we use it</h2>
<p>To respond to your request, schedule estimates and work, send job-status updates, handle insurance or permit paperwork you ask us to handle, and follow up after the job. We keep records as required for licensing, warranty, and tax purposes.</p>
<h2>Text messaging</h2>
<p>If you text us, submit our form with the SMS consent box checked, or call us and receive a text reply, we may text you about your request. Reply STOP to opt out at any time, HELP for help. <strong>No mobile information will be shared with third parties or affiliates for marketing or promotional purposes.</strong> Text-messaging originator opt-in data and consent are not shared with any third parties.</p>
<h2>Sharing</h2>
<p>We share information only with the service providers that run our phone, text, email, and scheduling systems, with your insurer or permitting office when you ask us to, and when required by law. We do not sell your information.</p>
<h2>Your choices</h2>
<p>To correct or delete your information, or to stop all contact, ${contact}.</p>
<footer>${esc(company)}${address ? ` · ${esc(address)}` : ""}</footer>`);
}
