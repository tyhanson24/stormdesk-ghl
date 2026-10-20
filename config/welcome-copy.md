# Welcome copy — DRAFT for Ty's approval (nothing here is sent until Ty says so)

Sent to the owner only, once the golden test passes (ONBOARDING step 6). Variables: `{first}` owner first name, `{Company}`, `{number}` the sub-account's texting number, `{brief_time}` default 5:50 AM.

## W-1 — SMS, day 0 (right after golden PASS)
```
{first}, this is Dispatch for {Company}. I'm the texting assistant on {number}.
Here's how I work: every reply to a homeowner is a DRAFT until you say so. I'll text you "Draft #n for <name>" — reply APPROVE n, NO n, or EDIT n <your words>. APPROVE ALL clears the list.
Every morning at {brief_time} you get a one-screen brief. Text STOP BOTS any time to pause me, START BOTS to resume.
Nothing goes to a customer without you. — Dispatch
```
(≈ 430 chars; 3 SMS segments. Owner-facing, so the 320-char homeowner rule does not apply.)

## W-2 — Email, day 0 (same moment)
Subject: `{Company} × Dispatch — you're set up`

```
{first},

Dispatch is live on {Company}'s HighLevel account in test mode. What that means today:

WHAT I DO
• New lead comes in (missed call, web form, text) → within about a minute the lead is in your pipeline with address, damage type, severity and an urgency score, and I've drafted the first reply.
• You get a text: "Draft #n for <name>: <message>". Reply APPROVE n / NO n / EDIT n <new text>. APPROVE ALL sends every pending draft.
• {brief_time} every morning: a one-screen brief — new leads, what's waiting on you, what I blocked and why.

WHAT I NEVER DO
• Send a homeowner anything you haven't approved (unless you turn on auto-send for the three basic replies).
• Quote a price, promise a date, or text between 8 PM and 7:30 AM.
• Text anyone on your do-not-contact list, or anyone who opted out.

KILL SWITCH
Text STOP BOTS to the Dispatch number and I stop instantly. START BOTS resumes.

NEXT STEPS
1. Save the Dispatch number {number} in your phone as "Dispatch".
2. Reply to this email with any crew phone numbers you want alerted on emergencies.
3. For the next 48 hours I'm in shadow mode: every message I would have sent goes to YOU instead, so you can see exactly what customers would get. After that, Ty flips you live.

Questions: reply here or text Ty.

— Dispatch, for {Company}
```

## W-3 — SMS, day 3 recap
```
{first} — 3-day check-in from Dispatch. Since go-live: {leads_count} leads, {approved_count} replies you approved, {blocked_count} I held back. Anything you want worded differently? Reply here and Ty will adjust. — Dispatch
```

## Rules
- These three are the only "marketing/drip"-shaped messages in the product and they go to the owner, never to homeowners. They are onboarding, per Ty's standing rule.
- Sent by the worker as owner messages through the send gate (owner-facing: no price/date/length checks, quiet hours exempt).
- Trigger: `welcome` job kind (to add) enqueued by `golden-test` on PASS **only after Ty approves this copy** and says "send welcomes".
