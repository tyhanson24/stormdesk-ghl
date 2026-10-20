-- Owner approvals: every DRAFT the worker stages gets a per-location number the owner replies with (APPROVE n / NO n / EDIT n).
create table if not exists approvals (
  id bigserial primary key,
  location_id text not null,
  n int not null,
  contact_id text not null,
  contact_name text,
  task_id text,
  note_id text,
  template text,
  channel text not null default 'SMS',
  text text not null,
  status text not null default 'pending',   -- pending | sent | declined | blocked | superseded
  job_id uuid,
  decided_job_id uuid,
  detail text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (location_id, n)
);
create index if not exists approvals_loc_status on approvals (location_id, status);
create index if not exists approvals_contact on approvals (location_id, contact_id);
alter table approvals enable row level security;
