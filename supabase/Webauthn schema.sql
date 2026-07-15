-- Run this AFTER schema.sql — adds fingerprint (WebAuthn) credential storage.

create table if not exists webauthn_credentials (
  id               uuid primary key default gen_random_uuid(),
  student_id       uuid not null references students(id) on delete cascade,
  credential_id    text not null unique,   -- base64url credential ID from the authenticator
  public_key       text not null,          -- base64url COSE public key
  counter          bigint not null default 0,
  device_type      text,                   -- 'singleDevice' | 'multiDevice'
  backed_up        boolean default false,
  transports       text[],                 -- e.g. {internal}
  created_at       timestamptz not null default now()
);

create index if not exists idx_webauthn_student on webauthn_credentials (student_id);

alter table webauthn_credentials enable row level security;
-- No public policies: only the Render backend (service role key) reads/writes this table.