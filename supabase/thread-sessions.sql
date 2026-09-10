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

-- Seed existing conversations from each assistant's unscoped place. Messages
-- older than the blind-round migration have no delivery rows: the global
-- floor implied their delivery. A scoped read starting at zero would replay
-- them, so every existing conversation starts at the global floor, carrying
-- only its own held replies. Conversations created later start at zero.
insert into public.assistant_thread_floors (assistant, thread_id, floor_seq, held_seqs)
select a.name, t.id, a.floor_seq,
       coalesce(
         (select array_agg(h) from unnest(a.held_seqs) as h
            join public.messages m on m.seq = h
           where m.thread_id = t.id),
         '{}')
from public.assistants a
cross join public.threads t
on conflict (assistant, thread_id) do nothing;

notify pgrst, 'reload schema';
