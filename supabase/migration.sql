-- Shadow Lab — Supabase migration
-- Run this in the Supabase SQL Editor

create table if not exists shadowing_sessions (
  id uuid primary key default gen_random_uuid(),
  student_name text not null,
  video_url text not null,
  video_id text,
  video_title text,
  transcript jsonb,
  notes text,
  created_at timestamptz default now()
);

create index if not exists shadowing_sessions_student_idx on shadowing_sessions (student_name);
create index if not exists shadowing_sessions_created_idx on shadowing_sessions (created_at desc);

-- Row Level Security (opzionale ma consigliato)
alter table shadowing_sessions enable row level security;

-- Policy: accesso completo con service key (il backend usa la service key)
create policy "service_full_access" on shadowing_sessions
  for all using (true);
