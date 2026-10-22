-- Daily estimate follow-up sweep (kind followup_sweep, skill estimate-followups): 09:00 local per sub-account.
-- Draft-only: every follow-up is a numbered approval the owner must APPROVE; EST-FU* are never on an auto-send list.
-- Approved by Ty 2026-10-22 ("just make sure there is an approval process").
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
    -- Estimate follow-ups: skipped on the Dispatch template (never a real pipeline there).
    if lt >= time '09:00' and lt < time '09:10' and t.location_id <> 'LTiwIPoSI1YNEcSyzYzf' then
      insert into public.jobs (location_id, kind, payload, dedupe_key, priority)
      values (t.location_id, 'followup_sweep', '{}'::jsonb, 'followup_sweep|' || t.location_id || '|' || d, 90)
      on conflict (dedupe_key) do nothing;
      if found then n := n + 1; end if;
    end if;
  end loop;
  return n;
end $$;
