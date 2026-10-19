---
name: send-gate
description: The single checkpoint every outbound message (SMS, email, call, GBP post) must pass before it leaves. Run it immediately before any send, in every routine, no exceptions. Blocks on do-not-contact, DND, quiet hours, weekly cap, price/date leaks, template drift, test/shadow mode, kill switch.
---

# Send gate

Nothing goes out without passing all checks. If any check fails: do not send, write a `BLOCKED:` note on the contact with the failing check, and put it in the run log. There is no override inside a routine; only the owner changing a flag or file unblocks it.

## Inputs
- `message` (channel, recipient contact id, full text, template id if any)
- `/workspace/company-profile.md` (mode, flags, owner_contact_id, timezone)
- Custom values: `bots_enabled`, `mode`
- Contact record (tags, DND status, `last_status_text_sent`, send history)

## Checks (in order; stop at the first failure)

1. **Kill switch.** Custom value `bots_enabled` must be `true`. Anything else → BLOCKED `kill_switch`.
2. **Mode.**
   - `test` → BLOCKED `test_mode` for every recipient. Log what would have been sent.
   - `shadow` → rewrite the recipient to `owner_contact_id` and prefix the text with `[SHADOW → {original name} {original phone}] `. Send only to the owner. Log it.
   - `storm` / `standard` → continue.
3. **Recipient allowed.** Contact must not be tagged `do-not-contact`, must not match `/workspace/do-not-contact.csv` (phone or email), and GHL DND must be off for that channel. Fail → BLOCKED `dnc`.
4. **Approval.** The message must carry an approval token: an owner `APPROVE` reply via WF-11 naming this draft, the owner completing its GHL task, or an `auto_*` flag in company-profile that explicitly covers this exact template. Fail → BLOCKED `no_approval`.
5. **Template integrity.** If a template id is set, the text must match that template with only placeholders substituted. Any added sentence → BLOCKED `template_drift`.
6. **Content rules.**
   - No `$` followed by a digit, no "ballpark", "around", "roughly" next to a number → BLOCKED `price`.
   - No calendar date or weekday unless the message carries a `booked_event_id` or a confirmed opportunity field it came from → BLOCKED `date`.
   - No `!` in storm mode → BLOCKED `tone`.
   - Must end with the company name → BLOCKED `signature`.
   - Must be ≤ 320 characters for SMS → BLOCKED `length`.
7. **Quiet hours.** Local time 8:00 PM–7:30 AM is blocked unless the contact texted first in the last 15 minutes, or the recipient is the owner / tagged `crew`. Fail → BLOCKED `quiet_hours`.
8. **Frequency.** Max 2 outbound texts per contact per rolling 7 days (status + reminders count; replies to an inbound within 15 minutes do not). Fail → BLOCKED `weekly_cap`.
9. **Rate limit.** Max 30 outbound per sub-account per hour. Over → pause the batch, BLOCKED `rate_limit`, ask the owner.
10. **Escalation words.** If the *inbound* thread contains lawyer, attorney, sue, injured, injury, mold, fire, fraud, OSHA: no bot reply. Tag `review-needed`, create an owner task "Call {name} — escalation word: {word}", BLOCKED `escalation`.
11. **Idempotency.** Same template to the same contact within 10 minutes → BLOCKED `duplicate`.

## On pass
Send. Tag `bot-sent`. Convert the `DRAFT:` note to `SENT: {timestamp}`. Update `last_status_text_sent` if it was a status text. Log one line: `SENT {template} → {name} ({channel})`.

## On block
Do not retry automatically. Log one line: `BLOCKED {check} → {name}: {reason}`. Blocked items appear in the next brief under APPROVALS WAITING or BLOCKED.

## Never
Skip the gate because the owner "already approved yesterday." Edit the text to make it pass. Send a different channel to get around a block.
