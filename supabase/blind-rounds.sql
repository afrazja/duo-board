-- Blind first round: run once in the Supabase SQL editor of an existing
-- Duo Board database. Additive and idempotent. The same statements live in
-- schema.sql for fresh installs.
--
-- Delivery is tracked per message instead of with one cursor, so a reply
-- from the other assistant can be held back until this assistant has
-- answered the same question, and nothing is ever skipped.

-- 'compare' asks both assistants for a short agree / challenge / changed
-- reply about the question named in reply_to.
alter table public.messages add column if not exists kind text not null default 'message';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'messages_kind_check') then
    alter table public.messages add constraint messages_kind_check check (kind in ('message', 'compare'));
  end if;
end $$;

-- Everything at or below floor_seq is delivered to (or written by) the assistant.
alter table public.assistants add column if not exists floor_seq bigint not null default 0;
update public.assistants set floor_seq = last_seen_seq where floor_seq = 0 and last_seen_seq > 0;

create table if not exists public.assistant_deliveries (
  assistant    text   not null references public.assistants(name) on delete cascade,
  seq          bigint not null references public.messages(seq) on delete cascade,
  delivered_at timestamptz not null default now(),
  primary key (assistant, seq)
);
alter table public.assistant_deliveries enable row level security;
revoke all on public.assistant_deliveries from anon, authenticated;
