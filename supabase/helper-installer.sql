-- One-time handoff from the signed-in website to the Windows helper installer.
-- The permanent helper token is encrypted with the one-time code and can only
-- be recovered by the installer while that code is valid.
begin;
create table if not exists public.helper_pairings (
  code_hash text primary key check (code_hash ~ '^[a-f0-9]{64}$'),
  owner_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null references public.helper_devices(id) on delete cascade,
  conversation_id uuid not null references public.threads(id) on delete cascade,
  origin text not null check (origin ~ '^https://[^/?#]+$'),
  token_cipher text not null check (token_cipher ~ '^[A-Za-z0-9_-]+$'),
  token_iv text not null check (token_iv ~ '^[A-Za-z0-9_-]{16}$'),
  token_tag text not null check (token_tag ~ '^[A-Za-z0-9_-]{22}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create unique index if not exists helper_pairings_owner on public.helper_pairings(owner_id);
create index if not exists helper_pairings_expiry on public.helper_pairings(expires_at);
alter table public.helper_pairings enable row level security;
revoke all on public.helper_pairings from public, anon, authenticated;
grant all on public.helper_pairings to service_role;
commit;
