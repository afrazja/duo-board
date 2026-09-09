-- Duo Board: one shared conversation that a person and two assistants read
-- and write. Run once in the Supabase SQL editor of a project created for
-- this app. Only the server (service role) touches these tables; RLS is on
-- with no policies so the anon key can read nothing.

create table if not exists public.threads (
  id         uuid primary key default gen_random_uuid(),
  title      text not null check (char_length(title) between 1 and 120),
  archived   boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.messages (
  seq          bigserial primary key,
  id           uuid not null unique default gen_random_uuid(),
  thread_id    uuid not null references public.threads(id) on delete cascade,
  author       text not null check (author in ('user', 'claude', 'chatgpt')),
  -- Who the message is for. Assistants answer when it names them or 'both';
  -- 'none' is a note for the record that nobody has to answer.
  addressed_to text not null default 'both' check (addressed_to in ('both', 'claude', 'chatgpt', 'none')),
  body         text not null check (char_length(body) between 1 and 20000),
  reply_to     uuid references public.messages(id) on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists messages_thread_seq on public.messages (thread_id, seq);

-- One row per assistant: how far it has read, and when it last looked or
-- spoke, so the page can show whether each side is alive.
create table if not exists public.assistants (
  name            text primary key check (name in ('claude', 'chatgpt')),
  last_seen_seq   bigint not null default 0,
  last_checked_at timestamptz,
  last_posted_at  timestamptz
);

insert into public.assistants (name) values ('claude'), ('chatgpt')
on conflict (name) do nothing;

-- Thread list with counts and last activity, in one query.
create or replace view public.thread_summaries with (security_invoker = true) as
select t.id, t.title, t.archived, t.created_at,
       count(m.seq)::bigint as message_count,
       max(m.created_at)    as last_message_at
from public.threads t
left join public.messages m on m.thread_id = t.id
group by t.id;

alter table public.threads    enable row level security;
alter table public.messages   enable row level security;
alter table public.assistants enable row level security;

revoke all on public.threads, public.messages, public.assistants from anon, authenticated;
