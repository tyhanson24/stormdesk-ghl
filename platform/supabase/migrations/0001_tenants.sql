-- Dispatch platform: tenant + OAuth token store
-- One row per HighLevel install (agency or sub-account). Tokens are encrypted at rest with pgsodium.

create extension if not exists pgsodium;
create extension if not exists pgcrypto;

create type install_kind as enum ('agency', 'location');
create type tenant_status as enum ('installed', 'uninstalled', 'suspended');

create table public.tenants (
  id                uuid primary key default gen_random_uuid(),
  kind              install_kind not null,
  company_id        text not null,                 -- HighLevel agency (companyId)
  location_id       text unique,                   -- null for agency-level installs
  name              text,
  status            tenant_status not null default 'installed',
  scopes            text[] not null default '{}',
  access_token      text not null,                 -- encrypted (see pgsodium TCE below)
  refresh_token     text not null,                 -- encrypted
  expires_at        timestamptz not null,
  user_type         text,                          -- 'Company' | 'Location' as returned by HL
  installed_at      timestamptz not null default now(),
  uninstalled_at    timestamptz,
  last_refresh_at   timestamptz,
  last_error        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index tenants_company_idx on public.tenants (company_id);
create index tenants_status_idx on public.tenants (status);

-- Transparent column encryption: pgsodium encrypts on write, decrypts for the service role via decrypted_tenants.
-- A real key must exist first (the all-zero placeholder id does not exist in a fresh project and makes every insert fail).
do $$
declare k uuid;
begin
  select id into k from pgsodium.key where name = 'dispatch_tenant_tokens' and status = 'valid' limit 1;
  if k is null then
    select id into k from pgsodium.create_key(name => 'dispatch_tenant_tokens');
  end if;
  execute format('security label for pgsodium on column public.tenants.access_token  is %L', 'ENCRYPT WITH KEY ID ' || k);
  execute format('security label for pgsodium on column public.tenants.refresh_token is %L', 'ENCRYPT WITH KEY ID ' || k);
end $$;

-- Audit of every token exchange / refresh / webhook so support can see what happened per tenant.
create table public.tenant_events (
  id           bigint generated always as identity primary key,
  tenant_id    uuid references public.tenants(id) on delete set null,
  location_id  text,
  company_id   text,
  event        text not null,        -- install | refresh | refresh_failed | uninstall | location_token | webhook:<type>
  detail       jsonb,
  created_at   timestamptz not null default now()
);
create index tenant_events_tenant_idx on public.tenant_events (tenant_id, created_at desc);

-- Lock everything down: only the service role (edge functions) touches these tables.
alter table public.tenants enable row level security;
alter table public.tenant_events enable row level security;
revoke all on public.tenants from anon, authenticated;
revoke all on public.tenant_events from anon, authenticated;

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger tenants_touch before update on public.tenants for each row execute function public.touch_updated_at();
