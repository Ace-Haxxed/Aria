-- NOVA memory sync — Supabase schema.
--
-- This is the entire backend. There is no server to run: NOVA talks to
-- Supabase's PostgREST API directly, and this file is the one-time setup you
-- paste into the Supabase SQL editor (Dashboard → SQL → New query → Run).
--
-- What is stored: the facts NOVA has been asked to remember, and the rolling
-- per-conversation summaries it writes. Never conversation transcripts, API
-- keys, audio, or screenshots.
--
-- Identity: rows are keyed by a SHA-256 digest of a random per-install id, so
-- the raw identifier never reaches Supabase and one install cannot guess
-- another's key.

create table if not exists public.nova_memory (
  -- SHA-256 hex digest of the install id. 64 chars, computed client-side.
  user_id     text primary key,
  facts       jsonb       not null default '{}'::jsonb,
  summaries   jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- Row-level security ON, with no policies granted to the public roles. That is
-- deliberate: it means the anon and authenticated keys — the ones that ship in
-- client apps and are effectively public — cannot read or write this table at
-- all.
--
-- NOVA syncs using your project's SERVICE-ROLE key, which bypasses RLS. Keep
-- that key secret; NOVA stores it locally at 0600 and never displays it again.
-- This is the right trade for a single-user personal backup: no auth flow to
-- set up, and the table is unreadable to anyone who only has the public key.
alter table public.nova_memory enable row level security;

revoke all on public.nova_memory from anon, authenticated;

-- Touch updated_at on every write, so "last synced" is trustworthy even if the
-- client clock is wrong.
create or replace function public.nova_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists nova_memory_touch on public.nova_memory;
create trigger nova_memory_touch
  before update on public.nova_memory
  for each row execute function public.nova_touch_updated_at();
