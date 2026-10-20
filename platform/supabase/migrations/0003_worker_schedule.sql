-- Dispatch worker: pg_cron tick + per-tenant scheduled jobs.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- Platform config readable only by the cron functions (service role / postgres).
-- Rows: public_base_url, dispatch_internal_key (inserted by hand after deploy).
create table if not exists public.platform_config (key text primary key, value text not null);
alter table public.platform_config enable row level security;
revoke all on public.platform_config from anon, authenticated;

-- Enqueue scheduled jobs per tenant in its own timezone (settings->>'timezone', default America/Chicago).
-- Runs every 5 minutes; a job is inserted once per tenant per day thanks to dedupe_key.
create or replace function public.enqueue_scheduled_jobs()
returns int language plpgsql as $$
declare t record; n int := 0; tz text; lt time; d date;
begin
  for t in select location_id, settings from public.tenants where kind = 'location' and status = 'installed' and location_id is not null loop
    tz := coalesce(t.settings->>'timezone', 'America/Chicago');
    lt := (now() at time zone tz)::time;
    d  := (now() at time zone tz)::date;
    if lt >= time '05:30' and lt < time '05:40' then
      insert into public.jobs (location_id, kind, payload, dedupe_key, priority)
      values (t.location_id, 'health_check', '{}'::jsonb, 'health_check|' || t.location_id || '|' || d, 80)
      on conflict (dedupe_key) do nothing;
      if found then n := n + 1; end if;
    end if;
    if lt >= time '06:00' and lt < time '06:10' then
      insert into public.jobs (location_id, kind, payload, dedupe_key, priority)
      values (t.location_id, 'daily_brief', '{}'::jsonb, 'daily_brief|' || t.location_id || '|' || d, 60)
      on conflict (dedupe_key) do nothing;
      if found then n := n + 1; end if;
    end if;
  end loop;
  return n;
end $$;

-- Tick the worker. Only bothers the function when there is something runnable.
create or replace function public.tick_worker()
returns bigint language plpgsql as $$
declare k text; base text; rid bigint;
begin
  if not exists (select 1 from public.jobs where status = 'queued' and run_after <= now())
     and not exists (select 1 from public.jobs where status = 'running' and locked_at < now() - interval '10 minutes') then
    return null;
  end if;
  select value into k from public.platform_config where key = 'dispatch_internal_key';
  select value into base from public.platform_config where key = 'public_base_url';
  if k is null or base is null then return null; end if;
  select net.http_post(
    url := base || '/functions/v1/dispatch-worker',
    headers := jsonb_build_object('content-type', 'application/json', 'x-dispatch-key', k),
    body := '{"source":"cron"}'::jsonb,
    timeout_milliseconds := 5000
  ) into rid;
  return rid;
end $$;

select cron.schedule('dispatch-worker-tick', '* * * * *', $$select public.tick_worker()$$);
select cron.schedule('dispatch-enqueue-scheduled', '*/5 * * * *', $$select public.enqueue_scheduled_jobs()$$);
