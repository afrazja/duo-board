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
