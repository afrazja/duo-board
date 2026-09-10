-- Blind first round: run once in the Supabase SQL editor of an existing
-- Duo Board database. Additive and idempotent. The same statements live in
-- schema.sql for fresh installs.
--
-- Delivery is tracked per message instead of with one cursor, so a reply
-- from the other assistant can be held back until this assistant has
-- answered the same question, and nothing is ever skipped.

-- From the earlier "working on it" change, in case it was not applied yet.
alter table public.assistants add column if not exists working_on_seq bigint;

-- 'compare' asks both assistants for a short agree / challenge / changed
-- reply about the question named in reply_to.
alter table public.messages add column if not exists kind text not null default 'message';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'messages_kind_check') then
    alter table public.messages add constraint messages_kind_check check (kind in ('message', 'compare'));
  end if;
end $$;

-- Everything at or below floor_seq is delivered to (or written by) the assistant,
-- or recorded in held_seqs.
alter table public.assistants add column if not exists floor_seq bigint not null default 0;
update public.assistants set floor_seq = last_seen_seq where floor_seq = 0 and last_seen_seq > 0;

-- Replies held back from an assistant, remembered by seq so the delivery
-- floor can move past them while they stay hidden.
alter table public.assistants add column if not exists held_seqs bigint[] not null default '{}';

create table if not exists public.assistant_deliveries (
  assistant    text   not null references public.assistants(name) on delete cascade,
  seq          bigint not null references public.messages(seq) on delete cascade,
  delivered_at timestamptz not null default now(),
  primary key (assistant, seq)
);
alter table public.assistant_deliveries enable row level security;
revoke all on public.assistant_deliveries from anon, authenticated;

-- One compare request per question, enforced by the database so two clicks
-- at once cannot create two.
create unique index if not exists messages_one_compare_per_question
  on public.messages (thread_id, reply_to) where kind = 'compare' and author = 'user';
