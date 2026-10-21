-- Dispatch observability: metering views, platform alerts, monitor cron.
-- Read by dispatch-admin (dashboard) and dispatch-monitor (alert rules → Ty). Nothing here talks to clients.

-- ---------- platform settings (jsonb; alerts routing etc.) ----------
create table if not exists public.platform_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.platform_settings enable row level security;
revoke all on public.platform_settings from anon, authenticated;
-- Where platform alerts go. Ty's own contact record in a sub-account the app is installed on (sends go through the
-- worker's gate, so they are logged, deduped and rate-limited like everything else). Change with dispatch-admin or SQL.
insert into public.platform_settings (key, value) values ('alerts', jsonb_build_object(
  'location_id', 'ALtyNu1aX56A38VMLAZW',
  'contact_id', '1KXdC2wPwGNctTjXDR3A',
  'channels', jsonb_build_array('SMS', 'Email'),
  'min_severity', 'warn',
  'renotify_minutes', 360
)) on conflict (key) do nothing;

-- ---------- alerts (one open row per key; re-notified at most every renotify_minutes) ----------
create table if not exists public.platform_alerts (
  id               bigint generated always as identity primary key,
  key              text not null,                       -- e.g. dead_job|<job_id>, queue_stuck, token_refresh|<loc>
  severity         text not null,                       -- info | warn | crit
  title            text not null,
  detail           jsonb not null default '{}',
  location_id      text,
  first_seen       timestamptz not null default now(),
  last_seen        timestamptz not null default now(),
  count            int not null default 1,
  last_notified_at timestamptz,
  notify_result    text,
  resolved_at      timestamptz
);
create unique index if not exists platform_alerts_open_key on public.platform_alerts (key) where resolved_at is null;
create index if not exists platform_alerts_recent on public.platform_alerts (last_seen desc);
alter table public.platform_alerts enable row level security;
revoke all on public.platform_alerts from anon, authenticated;

-- ---------- metering ----------
-- Per sub-account per day: jobs, runs, tokens, model cost estimate, sends, blocks. Cost: Sonnet 4.5 list price
-- ($3 / $15 per Mtok); input_tokens already counts cache reads at 10%.
create or replace view public.usage_daily as
with runs as (
  select j.location_id, (r.started_at at time zone 'UTC')::date as day,
         count(*) as runs,
         count(*) filter (where r.status = 'succeeded') as runs_ok,
         count(*) filter (where r.status = 'failed') as runs_failed,
         count(*) filter (where r.status = 'blocked') as runs_blocked,
         count(*) filter (where r.status = 'deferred') as runs_deferred,
         coalesce(sum(r.input_tokens), 0) as input_tokens,
         coalesce(sum(r.output_tokens), 0) as output_tokens,
         coalesce(sum(extract(epoch from (r.finished_at - r.started_at))), 0)::int as seconds
  from public.job_runs r join public.jobs j on j.id = r.job_id
  group by 1, 2
), sends as (
  select location_id, (created_at at time zone 'UTC')::date as day,
         count(*) filter (where verdict = 'sent') as sent,
         count(*) filter (where verdict = 'redirected:shadow') as shadow,
         count(*) filter (where verdict like 'blocked:%') as blocked,
         count(*) filter (where verdict = 'error') as send_errors,
         count(*) filter (where delivery_status in ('failed', 'undelivered')) as undelivered
  from public.outbound_log group by 1, 2
)
select coalesce(r.location_id, s.location_id) as location_id, coalesce(r.day, s.day) as day,
       coalesce(r.runs, 0) runs, coalesce(r.runs_ok, 0) runs_ok, coalesce(r.runs_failed, 0) runs_failed, coalesce(r.runs_blocked, 0) runs_blocked, coalesce(r.runs_deferred, 0) runs_deferred,
       coalesce(r.input_tokens, 0) input_tokens, coalesce(r.output_tokens, 0) output_tokens,
       round((coalesce(r.input_tokens, 0) * 3.0 + coalesce(r.output_tokens, 0) * 15.0) / 1e6, 4) as model_cost_usd,
       coalesce(r.seconds, 0) seconds,
       coalesce(s.sent, 0) sent, coalesce(s.shadow, 0) shadow, coalesce(s.blocked, 0) blocked, coalesce(s.send_errors, 0) send_errors, coalesce(s.undelivered, 0) undelivered
from runs r full outer join sends s on s.location_id = r.location_id and s.day = r.day;

-- Queue + worker health at a glance.
create or replace view public.queue_status as
select
  (select count(*) from public.jobs where status = 'queued' and run_after <= now()) as runnable,
  (select count(*) from public.jobs where status = 'queued' and run_after > now()) as scheduled,
  (select count(*) from public.jobs where status = 'running') as running,
  (select count(*) from public.jobs where status = 'dead') as dead,
  (select count(*) from public.jobs where status = 'dead' and finished_at > now() - interval '24 hours') as dead_24h,
  (select extract(epoch from (now() - min(run_after)))::int from public.jobs where status = 'queued' and run_after <= now()) as oldest_runnable_seconds,
  (select max(started_at) from public.job_runs) as last_run_started,
  (select max(finished_at) from public.job_runs where status in ('succeeded', 'failed', 'blocked', 'deferred')) as last_run_finished,
  (select count(*) from public.job_runs where status = 'failed' and started_at > now() - interval '1 hour') as failed_1h,
  (select count(*) from public.job_runs where started_at > now() - interval '1 hour') as runs_1h;

-- ---------- monitor cron (every 5 min → dispatch-monitor; the function evaluates the rules and notifies Ty) ----------
create or replace function public.tick_monitor()
returns bigint language plpgsql as $$
declare k text; base text; rid bigint;
begin
  select value into k from public.platform_config where key = 'dispatch_internal_key';
  select value into base from public.platform_config where key = 'public_base_url';
  if k is null or base is null then return null; end if;
  select net.http_post(
    url := base || '/functions/v1/dispatch-monitor',
    headers := jsonb_build_object('content-type', 'application/json', 'x-dispatch-key', k),
    body := '{"source":"cron"}'::jsonb,
    timeout_milliseconds := 8000
  ) into rid;
  return rid;
end $$;
select cron.schedule('dispatch-monitor', '*/5 * * * *', $$select public.tick_monitor()$$);
