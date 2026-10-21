-- Mirror of the HighLevel custom values the console needs (mode, bots_enabled, a2p_status …), refreshed by
-- dispatch-monitor every 5 minutes so the console and alert rules never call HighLevel.
-- (Named tenant_cv because 0001 already defines an enum type called tenant_status.)
create table if not exists public.tenant_cv (
  location_id   text primary key,
  mode          text,
  bots_enabled  boolean,
  company_name  text,
  trade         text,
  a2p_status    text,
  custom_values jsonb not null default '{}',     -- every custom value except *key* ones
  error         text,
  checked_at    timestamptz not null default now()
);
alter table public.tenant_cv enable row level security;
revoke all on public.tenant_cv from anon, authenticated;
