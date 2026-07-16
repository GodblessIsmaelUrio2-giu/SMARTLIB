-- KIUT SmartLib Pass — Supabase schema
-- Run this in the Supabase SQL editor (Project → SQL Editor → New query)

-- 1. Extension needed for gen_random_uuid()
create extension if not exists "pgcrypto";

-- 2. Students table
create table if not exists students (
  id               uuid primary key default gen_random_uuid(),
  reg_number       text not null unique,       -- e.g. DCS/32115/2401/DT
  name             text not null,
  initials         text not null,
  alert_type       text check (alert_type in ('banned', 'vip', 'accommodation') or alert_type is null),
  notes            text,
  notify_enabled   boolean not null default true,
  created_at       timestamptz not null default now()
);

-- If you already ran this schema before, run this once to add the new columns:
-- alter table students add column if not exists alert_type text check (alert_type in ('banned','vip','accommodation') or alert_type is null);
-- alter table students add column if not exists notes text;
-- alter table students add column if not exists notify_enabled boolean not null default true;

-- 3. Entry logs table (one row per library visit)
create table if not exists entry_logs (
  id           uuid primary key default gen_random_uuid(),
  student_id   uuid not null references students(id) on delete cascade,
  time_in      timestamptz not null default now(),
  time_out     timestamptz,
  status       text not null default 'inside'
               check (status in ('inside', 'checked_out', 'flagged')),
  flag_reason  text,                       -- e.g. 'No baggage tag'
  created_at   timestamptz not null default now()
);

-- Helpful index for the dashboard's live log + search
create index if not exists idx_entry_logs_time_in on entry_logs (time_in desc);
create index if not exists idx_entry_logs_student on entry_logs (student_id);

-- 4. Row Level Security
alter table students enable row level security;
alter table entry_logs enable row level security;

-- The Render backend uses the Supabase SERVICE ROLE key, which bypasses
-- RLS entirely — so no public policies are required. These policies exist
-- only in case you ever want the frontend to talk to Supabase directly
-- with the anon key (read-only dashboard use case). Skip them if you're
-- only calling Supabase from your Render server.

create policy "Allow anon read access to students"
  on students for select
  to anon
  using (true);

create policy "Allow anon read access to entry_logs"
  on entry_logs for select
  to anon
  using (true);

-- 5. Seed data (demo students)
insert into students (reg_number, name, initials) values
  ('DCS/32115/2401/DT', 'Shafiuna Ahmadi Libiga', 'SL'),
  ('DCS/30117/2301/DT', 'Urio Ismael Godbless',   'UI'),
  ('DCS/33207/2401/DT', 'Emmanuel John Lymo',     'EL'),
  ('DCS/32594/2401/DT', 'Gift Meck Sewando',      'GS'),
  ('DCS/32584/2401/DT', 'Munna Yusuph Eliwaja',   'ME'),
  ('DCS/32834/2401/DT', 'Daifati Saidi Nandonde', 'DN'),
  ('DCS/33082/2401/DT', 'Herman Esperius',        'HE'),
  ('DCS/34146/2401/DT', 'Athumani S. Bakari',     'AB'),
  ('DCS/32114/2401/DT', 'Baraka Juma Mwanga',     'BM'),
  ('DCS/32716/2401/DT', 'Andrew Mlewa',           'AM'),
  ('DCS/35179/2401/DT', 'Tunu Hamadi Chande',     'TC')
on conflict (reg_number) do nothing;

-- 6. Handy view for the dashboard table (reg number, name, in/out, status)
create or replace view v_entry_log as
select
  e.id,
  s.reg_number,
  s.name,
  e.time_in,
  e.time_out,
  e.status,
  e.flag_reason
from entry_logs e
join students s on s.id = e.student_id
order by e.time_in desc;