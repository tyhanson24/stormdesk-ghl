-- Dispatch compliance: consent ledger, A2P tracker, number pool, delivery/carrier-block monitor.
-- Everything here is enforced by the worker's send gate (code), never by the model.

-- 1. Consent ledger: append-only; the latest row per (location, contact, channel) is the current state.
create table public.consents (
  id           bigint generated always as identity primary key,
  location_id  text not null,
  contact_id   text not null,
  phone        text,
  channel      text not null default 'SMS',                -- SMS | Email
  status       text not null check (status in ('opted_in', 'opted_out')),
  source       text not null,                              -- inbound_sms | web_form | missed_call | owner_attested | import | stop_keyword | hl_dnd
  evidence     text,                                       -- the inbound text / form id / who attested
  job_id       uuid references public.jobs(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index consents_contact_idx on public.consents (location_id, contact_id, channel, created_at desc);

-- 2. A2P 10DLC tracker (one row per sub-account). Mirrored into custom value `a2p_status` for the dashboard.
create table public.a2p_registrations (
  location_id      text primary key,
  brand_status     text not null default 'not_started' check (brand_status in ('not_started','pending','approved','rejected')),
  campaign_status  text not null default 'not_started' check (campaign_status in ('not_started','pending','approved','rejected')),
  brand_id         text,
  campaign_id      text,
  use_case         text default 'low_volume_mixed',
  submitted_at     timestamptz,
  approved_at      timestamptz,
  notes            text,
  updated_at       timestamptz not null default now()
);

-- 3. Numbers: per-sub-account numbers plus the agency toll-free pool (location_id null = unassigned pool).
create table public.numbers (
  id           bigint generated always as identity primary key,
  location_id  text,                                       -- null = agency pool, unassigned
  number       text not null unique,                       -- E.164
  kind         text not null check (kind in ('local','tollfree')),
  verified     boolean not null default false,             -- toll-free verification approved
  status       text not null default 'active' check (status in ('active','pending','released')),
  purpose      text not null default 'primary' check (purpose in ('primary','bridge')),  -- bridge = toll-free used while 10DLC pending
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index numbers_location_idx on public.numbers (location_id, status);

-- 4. Delivery tracking on every send.
alter table public.outbound_log
  add column message_id      text,
  add column from_number     text,
  add column delivery_status text,                          -- pending | sent | delivered | undelivered | failed | opt_out
  add column delivery_error  text,
  add column checked_at      timestamptz;
create index outbound_log_delivery_idx on public.outbound_log (location_id, created_at desc) where verdict = 'sent' and (delivery_status is null or delivery_status in ('pending','sent'));

-- 5. delivery_check job: every 15 min for any sub-account with unresolved sends in the last 48 h.
create or replace function public.enqueue_delivery_checks()
returns int language plpgsql as $$
declare n int := 0; l record;
begin
  for l in select distinct location_id from public.outbound_log
           where verdict = 'sent' and message_id is not null and created_at > now() - interval '48 hours'
             and (delivery_status is null or delivery_status in ('pending','sent'))
  loop
    insert into public.jobs (location_id, kind, payload, dedupe_key, priority)
    values (l.location_id, 'delivery_check', '{}'::jsonb, 'delivery_check|' || l.location_id || '|' || to_char(now(), 'YYYYMMDDHH24') || lpad(((extract(minute from now())::int / 15) * 15)::text, 2, '0'), 90)
    on conflict (dedupe_key) do nothing;
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;
select cron.schedule('dispatch-delivery-checks', '*/15 * * * *', $$select public.enqueue_delivery_checks()$$);
