-- OAuth for the connectors. The claude.ai and ChatGPT connectors cannot set
-- headers, so instead of a token in the URL they can sign in: register as a
-- client, send the person to /oauth/authorize, and trade the code for an
-- access token bound to one account and one assistant. Only hashes of
-- secrets, codes and tokens are stored. Run once, after accounts.sql if the
-- board uses accounts (owner_id stays null on a password-mode board).

create table if not exists public.oauth_clients (
  id            text primary key,
  name          text,
  redirect_uris text[] not null,
  auth_method   text not null default 'none' check (auth_method in ('none', 'client_secret_post', 'client_secret_basic')),
  secret_hash   text,
  created_at    timestamptz not null default now()
);

-- One-time codes, ten minutes long, deleted when spent.
create table if not exists public.oauth_codes (
  code_hash      text primary key,
  client_id      text not null references public.oauth_clients(id) on delete cascade,
  owner_id       uuid references auth.users(id) on delete cascade,
  assistant      text not null check (assistant in ('claude', 'chatgpt')),
  redirect_uri   text not null,
  code_challenge text not null,
  scope          text,
  resource       text,
  expires_at     timestamptz not null,
  created_at     timestamptz not null default now()
);

-- A signed-in connector. The access token is renewed with the refresh token;
-- revoking the row signs the connector out.
create table if not exists public.oauth_grants (
  id                 uuid primary key default gen_random_uuid(),
  client_id          text not null references public.oauth_clients(id) on delete cascade,
  client_name        text,
  owner_id           uuid references auth.users(id) on delete cascade,
  assistant          text not null check (assistant in ('claude', 'chatgpt')),
  scope              text,
  access_hash        text not null unique,
  access_expires_at  timestamptz not null,
  refresh_hash       text not null unique,
  refresh_expires_at timestamptz not null,
  created_at         timestamptz not null default now(),
  last_used_at       timestamptz,
  revoked_at         timestamptz
);
create index if not exists oauth_grants_owner on public.oauth_grants (owner_id, assistant);

alter table public.oauth_clients enable row level security;
alter table public.oauth_codes   enable row level security;
alter table public.oauth_grants  enable row level security;
revoke all on public.oauth_clients, public.oauth_codes, public.oauth_grants from anon, authenticated;

notify pgrst, 'reload schema';
