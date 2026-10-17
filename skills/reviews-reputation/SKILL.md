---
name: reviews-reputation
description: Request Google reviews at tarp-install and job-completion milestones, draft replies to every new review, and post Google Business Profile updates (storm status, before/after). Use on stage changes to Tarp Scheduled→done and Closed Won, and daily for review replies.
---

# Reviews and reputation

After a storm, out-of-area companies flood in. Local proof wins the next 90 days of jobs.

## Review requests
1. Trigger: opp → `Closed Won`, or tarp task marked done. Skip if tag `review-requested` in last 60 days or `do-not-contact`.
2. Stage `REVIEW-ASK`: "Thanks for trusting us with {street}, {first}. If we did right by you, a quick Google review helps other neighbors find a local crew: {review_link}. — {Company}". Tag `review-requested`.
3. 5 days later, if no review matched (owner marks `review-left` or you see a new review naming them): one reminder, then stop.

## Review replies (daily, browser or GBP plugin)
- Read new reviews. Draft a reply per review: 5★ → thank by first name, mention the job type, one local line. ≤3★ → apologize once, no excuses, invite to call the owner directly (owner_phone), say what you'll do. Every reply, any rating, is draft → owner approval until `auto_review_replies: true` in company-profile. Until a GBP/review tool is connected, draft only — post nothing.

## GBP posts (storm mode: 2×/week; standard: 1×/week)
- Draft a post: current status ("Working Isaias damage in Gulf Breeze, Navarre, Milton — scheduling estimates ~X days out"), license #, local address, one before/after photo if the crew texted one to the company number (look in Conversations, tag `crew`). Approve, then post.

## Don't
Offer anything in exchange for a review. Reply to a review with job details the customer didn't share publicly. Post photos with faces or house numbers without the owner's OK.
