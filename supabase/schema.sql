-- Duo Board: one shared conversation that a person and two assistants read
-- and write. Run once in the Supabase SQL editor of a project created for
-- this app. Only the server (service role) touches these tables; RLS is on
-- with no policies so the anon key can read nothing.

create table if not exists public.threads (
  id         uuid primary key default gen_random_uuid(),
  title      text not null check (char_length(title) between 1 and 120),
  archived   boolean not null default false,
  created_at timestamptz not null default now(),
  brief_audio boolean not null default false
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
  spoken_summary text check (spoken_summary is null or char_length(spoken_summary) between 1 and 1200),
  reply_to     uuid references public.messages(id) on delete set null,
  created_at   timestamptz not null default now(),
  -- 'compare' asks both assistants for a short agree / challenge / changed
  -- reply about the question named in reply_to.
  kind         text not null default 'message' check (kind in ('message', 'compare'))
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

-- The seq of the latest message addressed to the assistant that it has read
-- but not yet answered. read_new sets it, posting clears it, and the page
-- turns it into "read this 2m ago, working" instead of a blank wait.
-- Additive: existing installs run just this line.
alter table public.assistants add column if not exists working_on_seq bigint;

-- Blind first round (additive; existing installs run this block once).
-- Delivery is tracked per message instead of with one cursor, so a reply
-- from the other assistant can be held back until this assistant has
-- answered the same question, and nothing is ever skipped.
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

-- Replies held back from an assistant, remembered by seq so the delivery
-- floor can move past them while they stay hidden.
alter table public.assistants add column if not exists held_seqs bigint[] not null default '{}';

-- One compare request per question, enforced by the database so two clicks
-- at once cannot create two.
create unique index if not exists messages_one_compare_per_question
  on public.messages (thread_id, reply_to) where kind = 'compare' and author = 'user';

-- Pause and resume: while paused, assistants' scoped reads of the
-- conversation deliver nothing and their loops skip it; nothing is lost, and
-- resuming lets the next read deliver everything that arrived meanwhile.
alter table public.threads add column if not exists paused boolean not null default false;

-- One session per conversation: an assistant reading a single thread keeps
-- its delivery floor and held replies here, one row per assistant and thread,
-- instead of on the assistant row that covers every thread. Deliveries stay
-- shared, so a message reaches exactly one reader.
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

-- Seed existing conversations from each assistant's unscoped place, so a
-- scoped read never replays messages the global floor already covered.
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

-- Thread list with counts and last activity, in one query.
alter table public.threads add column if not exists blind_first_round boolean not null default true;
alter table public.messages add column if not exists blind_round boolean not null default true;
create or replace view public.thread_summaries with (security_invoker = true) as
select t.id, t.title, t.archived, t.created_at,
       count(m.seq)::bigint as message_count,
       max(m.created_at)    as last_message_at,
       t.brief_audio, t.blind_first_round
from public.threads t
left join public.messages m on m.thread_id = t.id
group by t.id;

alter table public.threads    enable row level security;
alter table public.messages   enable row level security;
alter table public.assistants enable row level security;

revoke all on public.threads, public.messages, public.assistants from anon, authenticated;

-- Optional separate first answers. Existing questions keep the old behavior.
alter table public.threads add column if not exists blind_first_round boolean not null default true;
alter table public.messages add column if not exists blind_round boolean not null default true;

-- Capture the preference when a question is inserted, including writes from
-- either API. An ongoing question must never change mode halfway through.
-- Compare follows its original question even if the conversation mode changed.
create or replace function public.snapshot_answer_mode()
returns trigger language plpgsql set search_path = '' as $$
declare selected_mode boolean;
begin
  if new.author = 'user' then
    if new.kind = 'compare' and new.reply_to is not null then
      select m.blind_round into selected_mode from public.messages m
        where m.id = new.reply_to and m.thread_id = new.thread_id;
    end if;
    if selected_mode is null then
      select t.blind_first_round into selected_mode from public.threads t
        where t.id = new.thread_id for share;
    end if;
    new.blind_round := coalesce(selected_mode, true);
  end if;
  return new;
end;
$$;
revoke all on function public.snapshot_answer_mode() from public, anon, authenticated;
create or replace trigger messages_snapshot_answer_mode
  before insert on public.messages
  for each row execute function public.snapshot_answer_mode();

create or replace view public.thread_summaries with (security_invoker = true) as
select t.id, t.title, t.archived, t.created_at,
       count(m.seq)::bigint as message_count,
       max(m.created_at) as last_message_at,
       t.brief_audio, t.blind_first_round, t.paused
from public.threads t
left join public.messages m on m.thread_id = t.id
group by t.id;

notify pgrst, 'reload schema';
