-- One session per conversation: run once in the Supabase SQL editor of an
-- existing Duo Board database, after blind-rounds.sql. Additive and
-- idempotent. The same statements live in schema.sql for fresh installs.
--
-- An assistant reading a single thread (read_new with thread_id) keeps its
-- delivery floor and held replies here, one row per assistant and thread,
-- instead of on the assistant row that covers every thread. Deliveries stay
-- shared in assistant_deliveries, so a message reaches exactly one reader.

create table if not exists public.assistant_thread_floors (
  assistant       text   not null references public.assistants(name) on delete cascade,
  thread_id       uuid   not null references public.threads(id) on delete cascade,
  floor_seq       bigint not null default 0,
  held_seqs       bigint[] not null default '{}',
  last_checked_at timestamptz,
  primary key (assistant, thread_id)
);
alter table public.assistant_thread_floors enable row level security;
revoke all on public.assistant_thread_floors from anon, authenticated;

notify pgrst, 'reload schema';
