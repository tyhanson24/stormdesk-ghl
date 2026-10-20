-- Dispatch worker: durable job queue, run audit, per-tenant files, outbound log.

create type job_status as enum ('queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled');

create table public.jobs (
  id              uuid primary key default gen_random_uuid(),
  location_id     text not null,
  kind            text not null,                  -- intake | approval_reply | appointment_completed | crew_done | daily_brief | health_check | custom
  payload         jsonb not null default '{}',
  dedupe_key      text unique,                    -- webhook idempotency (kind + contact + event ts); null = never deduped
  status          job_status not null default 'queued',
  priority        int not null default 100,       -- lower runs first
  attempts        int not null default 0,
  max_attempts    int not null default 5,
  run_after       timestamptz not null default now(),
  locked_at       timestamptz,
  locked_by       text,
  last_error      text,
  result          jsonb,
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  finished_at     timestamptz
);
create index jobs_claim_idx on public.jobs (status, run_after, priority) where status = 'queued';
create index jobs_location_idx on public.jobs (location_id, created_at desc);

create table public.job_runs (
  id              bigint generated always as identity primary key,
  job_id          uuid not null references public.jobs(id) on delete cascade,
  attempt         int not null,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  status          text not null default 'running',  -- running | succeeded | failed | blocked
  model           text,
  input_tokens    int default 0,
  output_tokens   int default 0,
  steps           jsonb not null default '[]',      -- [{tool, args, ok, ms, result_excerpt}]
  summary         text,
  error           text
);
create index job_runs_job_idx on public.job_runs (job_id, attempt);

-- What used to be Office's /workspace files, per sub-account.
create table public.tenant_files (
  location_id   text not null,
  path          text not null,                      -- company-profile.md | service-area.md | pricing-guardrails.md | do-not-contact.csv | permits.md | price-book.md | estimate-template.md
  content       text not null,
  updated_at    timestamptz not null default now(),
  primary key (location_id, path)
);

-- Every send attempt that reached the gate, with the verdict. Feeds cap / rate / duplicate checks and the daily brief.
create table public.outbound_log (
  id            bigint generated always as identity primary key,
  location_id   text not null,
  job_id        uuid references public.jobs(id) on delete set null,
  contact_id    text,
  channel       text,
  template      text,
  text_hash     text,
  verdict       text not null,                      -- sent | blocked:<check> | redirected:shadow
  detail        text,
  created_at    timestamptz not null default now()
);
create index outbound_log_contact_idx on public.outbound_log (location_id, contact_id, created_at desc);
create index outbound_log_location_idx on public.outbound_log (location_id, created_at desc);

-- Per-tenant worker settings live on tenants.settings (ingest_key, timezone, owner_contact_id, trade, auto_ack).
alter table public.tenants add column if not exists settings jsonb not null default '{}';

-- Atomic claim: N queued jobs whose run_after has passed, skipping rows other workers hold.
create or replace function public.claim_jobs(p_worker text, p_limit int default 3)
returns setof public.jobs
language plpgsql
as $$
begin
  return query
  with picked as (
    select id from public.jobs
    where status = 'queued' and run_after <= now()
    order by priority, run_after
    limit p_limit
    for update skip locked
  )
  update public.jobs j
     set status = 'running', locked_at = now(), locked_by = p_worker,
         attempts = j.attempts + 1, started_at = coalesce(j.started_at, now())
    from picked
   where j.id = picked.id
  returning j.*;
end $$;

-- Jobs stuck in 'running' (worker died mid-run) go back to the queue after 10 minutes.
create or replace function public.requeue_stale_jobs()
returns int language sql as $$
  with r as (
    update public.jobs set status = case when attempts >= max_attempts then 'dead'::job_status else 'queued'::job_status end,
           locked_at = null, locked_by = null, last_error = coalesce(last_error, '') || ' [stale run requeued]'
     where status = 'running' and locked_at < now() - interval '10 minutes'
    returning 1)
  select count(*)::int from r;
$$;

alter table public.jobs enable row level security;
alter table public.job_runs enable row level security;
alter table public.tenant_files enable row level security;
alter table public.outbound_log enable row level security;
revoke all on public.jobs, public.job_runs, public.tenant_files, public.outbound_log from anon, authenticated;
