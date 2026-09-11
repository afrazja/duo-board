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
       t.brief_audio, t.blind_first_round, t.paused
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

-- Serialize assistant inserts with Pause so no late reply can land after the
-- preference update commits. User messages may queue normally while paused.
create or replace function public.guard_paused_assistant_post()
returns trigger language plpgsql set search_path = '' as $$
declare conversation_paused boolean;
begin
  if new.author <> 'user' then
    select t.paused into conversation_paused from public.threads t
      where t.id = new.thread_id for share;
    if conversation_paused then
      raise exception 'Conversation is paused. Keep this reply pending until the person resumes it.';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_paused_assistant_post() from public, anon, authenticated;
create or replace trigger messages_guard_paused_assistant_post
  before insert on public.messages
  for each row execute function public.guard_paused_assistant_post();

-- Content-free receipts survive the hard delete so offline assistants can finish cleanup.
create table if not exists public.thread_deletions (
  thread_id uuid primary key,
  deleted_at timestamptz not null default now(),
  claude_cleaned_at timestamptz,
  chatgpt_cleaned_at timestamptz,
  claude_blocked boolean not null default false,
  chatgpt_blocked boolean not null default false
);
alter table public.thread_deletions enable row level security;
revoke all on public.thread_deletions from anon, authenticated;
grant select, update on public.thread_deletions to service_role;

create or replace function public.remove_board_conversation(p_thread_id uuid, p_confirm_title text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare conversation_title text;
begin
  select title into conversation_title from public.threads where id = p_thread_id for update;
  if not found then
    if exists (select 1 from public.thread_deletions where thread_id = p_thread_id) then
      return jsonb_build_object('deleted', true, 'thread_id', p_thread_id);
    end if;
    return jsonb_build_object('deleted', false, 'reason', 'not_found');
  end if;
  if conversation_title <> p_confirm_title then
    return jsonb_build_object('deleted', false, 'reason', 'title_mismatch');
  end if;

  insert into public.thread_deletions(thread_id) values (p_thread_id);
  update public.assistants a set
    held_seqs = array(select h from unnest(a.held_seqs) h
      where not exists (select 1 from public.messages m where m.seq = h and m.thread_id = p_thread_id)),
    working_on_seq = case when exists (select 1 from public.messages m where m.seq = a.working_on_seq and m.thread_id = p_thread_id)
      then null else a.working_on_seq end
    where exists (select 1 from public.messages m where m.thread_id = p_thread_id
      and (m.seq = any(a.held_seqs) or m.seq = a.working_on_seq));
  delete from public.threads where id = p_thread_id;
  return jsonb_build_object('deleted', true, 'thread_id', p_thread_id);
end;
$$;
revoke all on function public.remove_board_conversation(uuid, text) from public, anon, authenticated;
grant execute on function public.remove_board_conversation(uuid, text) to service_role;
notify pgrst, 'reload schema';

-- Accounts: see supabase/accounts.sql (kept identical here for fresh installs).
-- Accounts: many people, each with a private board. Run once on an existing
-- database. Everything that exists today keeps working with owner_id null
-- until the original owner signs up and the server claims it for them
-- (see claim_legacy_board and BOARD_OWNER_EMAIL in the README).

-- Every conversation belongs to one account.
alter table public.threads add column if not exists owner_id uuid references auth.users(id) on delete cascade;
create index if not exists threads_owner on public.threads (owner_id);

-- One assistant row per account and assistant, instead of one global row per
-- assistant. The old primary key (name) goes; deliveries and per-thread floors
-- are keyed by message and thread, which already belong to one account, so
-- they need no owner column and their old references to assistants(name) are
-- dropped.
do $$
declare r record;
begin
  for r in
    select conname, conrelid::regclass as tbl
    from pg_constraint
    where confrelid = 'public.assistants'::regclass and contype = 'f'
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;
end $$;
alter table public.assistants add column if not exists owner_id uuid references auth.users(id) on delete cascade;
alter table public.assistants add column if not exists id uuid not null default gen_random_uuid();
alter table public.assistants drop constraint if exists assistants_pkey;
alter table public.assistants add primary key (id);
-- Legacy rows have owner_id null; nulls not distinct keeps them unique too.
create unique index if not exists assistants_owner_name on public.assistants (owner_id, name) nulls not distinct;

-- Removal receipts outlive the thread row, so they carry the owner themselves.
alter table public.thread_deletions add column if not exists owner_id uuid references auth.users(id) on delete cascade;

-- Per-account tokens for the assistants. Only a hash is stored; the plaintext
-- is shown once when the token is created.
create table if not exists public.assistant_tokens (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users(id) on delete cascade,
  assistant    text not null check (assistant in ('claude', 'chatgpt')),
  token_hash   text not null unique,
  token_hint   text not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create index if not exists assistant_tokens_owner on public.assistant_tokens (owner_id, assistant);
alter table public.assistant_tokens enable row level security;
revoke all on public.assistant_tokens from anon, authenticated;

-- The thread list carries the owner so the server can filter it.
create or replace view public.thread_summaries with (security_invoker = true) as
select t.id, t.title, t.archived, t.created_at,
       count(m.seq)::bigint as message_count,
       max(m.created_at)    as last_message_at,
       t.brief_audio, t.blind_first_round, t.paused, t.owner_id
from public.threads t
left join public.messages m on m.thread_id = t.id
group by t.id;

-- Removal now checks the owner and records it on the receipt.
drop function if exists public.remove_board_conversation(uuid, text);
create or replace function public.remove_board_conversation(p_thread_id uuid, p_confirm_title text, p_owner uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare conversation_title text;
begin
  select title into conversation_title from public.threads
    where id = p_thread_id and owner_id is not distinct from p_owner for update;
  if not found then
    if exists (select 1 from public.thread_deletions where thread_id = p_thread_id and owner_id is not distinct from p_owner) then
      return jsonb_build_object('deleted', true, 'thread_id', p_thread_id);
    end if;
    return jsonb_build_object('deleted', false, 'reason', 'not_found');
  end if;
  if conversation_title <> p_confirm_title then
    return jsonb_build_object('deleted', false, 'reason', 'title_mismatch');
  end if;

  insert into public.thread_deletions(thread_id, owner_id) values (p_thread_id, p_owner);
  update public.assistants a set
    held_seqs = array(select h from unnest(a.held_seqs) h
      where not exists (select 1 from public.messages m where m.seq = h and m.thread_id = p_thread_id)),
    working_on_seq = case when exists (select 1 from public.messages m where m.seq = a.working_on_seq and m.thread_id = p_thread_id)
      then null else a.working_on_seq end
    where a.owner_id is not distinct from p_owner
      and exists (select 1 from public.messages m where m.thread_id = p_thread_id
        and (m.seq = any(a.held_seqs) or m.seq = a.working_on_seq));
  delete from public.threads where id = p_thread_id;
  return jsonb_build_object('deleted', true, 'thread_id', p_thread_id);
end;
$$;
revoke all on function public.remove_board_conversation(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.remove_board_conversation(uuid, text, uuid) to service_role;

-- Hand everything that predates accounts to one person: their conversations,
-- removal receipts, and the assistants' places, plus the existing environment
-- tokens as that person's tokens, so nothing breaks at cutover. Idempotent.
create or replace function public.claim_legacy_board(p_owner uuid, p_tokens jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare n_threads int; n_assistants int; t record;
begin
  update public.threads set owner_id = p_owner where owner_id is null;
  get diagnostics n_threads = row_count;
  update public.thread_deletions set owner_id = p_owner where owner_id is null;
  -- Legacy assistant rows become the owner's, unless the owner already has a
  -- row for that assistant; then the legacy place is merged into it.
  update public.assistants a set owner_id = p_owner
    where a.owner_id is null
      and not exists (select 1 from public.assistants b where b.owner_id = p_owner and b.name = a.name);
  get diagnostics n_assistants = row_count;
  update public.assistants b set
    floor_seq       = greatest(b.floor_seq, a.floor_seq),
    last_seen_seq   = greatest(b.last_seen_seq, a.last_seen_seq),
    held_seqs       = a.held_seqs,
    last_checked_at = coalesce(a.last_checked_at, b.last_checked_at),
    last_posted_at  = coalesce(a.last_posted_at, b.last_posted_at),
    working_on_seq  = coalesce(a.working_on_seq, b.working_on_seq)
    from public.assistants a
    where a.owner_id is null and b.owner_id = p_owner and b.name = a.name;
  delete from public.assistants where owner_id is null;
  for t in select * from jsonb_to_recordset(p_tokens) as x(assistant text, token_hash text, token_hint text) loop
    insert into public.assistant_tokens(owner_id, assistant, token_hash, token_hint)
      values (p_owner, t.assistant, t.token_hash, t.token_hint)
      on conflict (token_hash) do nothing;
  end loop;
  return jsonb_build_object('threads', n_threads, 'assistants', n_assistants);
end;
$$;
revoke all on function public.claim_legacy_board(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.claim_legacy_board(uuid, jsonb) to service_role;

notify pgrst, 'reload schema';
