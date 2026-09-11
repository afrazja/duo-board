-- Account-based Duo Board isolation. Existing conversations remain unowned
-- until the first authenticated owner claims them with the previous board password.

create table if not exists public.board_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text not null check (char_length(display_name) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.threads add column if not exists owner_id uuid references auth.users(id) on delete cascade;
alter table public.assistants add column if not exists owner_id uuid references auth.users(id) on delete cascade;
alter table public.assistant_deliveries add column if not exists owner_id uuid references auth.users(id) on delete cascade;
alter table public.assistant_thread_floors add column if not exists owner_id uuid references auth.users(id) on delete cascade;
alter table public.thread_deletions add column if not exists owner_id uuid references auth.users(id) on delete cascade;

-- The original schema had one global Claude row and one global ChatGPT row.
-- Accounts need one pair per owner. Delivery/floor rows are scoped explicitly.
alter table public.assistant_deliveries drop constraint if exists assistant_deliveries_assistant_fkey;
alter table public.assistant_thread_floors drop constraint if exists assistant_thread_floors_assistant_fkey;
alter table public.assistants drop constraint if exists assistants_pkey;
alter table public.assistant_deliveries drop constraint if exists assistant_deliveries_pkey;
alter table public.assistant_thread_floors drop constraint if exists assistant_thread_floors_pkey;

drop index if exists public.assistants_owner_name_unique;
create unique index assistants_owner_name_unique on public.assistants (owner_id, name) nulls not distinct;
drop index if exists public.assistant_deliveries_owner_unique;
create unique index assistant_deliveries_owner_unique on public.assistant_deliveries (owner_id, assistant, seq) nulls not distinct;
drop index if exists public.assistant_thread_floors_owner_unique;
create unique index assistant_thread_floors_owner_unique on public.assistant_thread_floors (owner_id, assistant, thread_id) nulls not distinct;

create table if not exists public.agent_tokens (
  owner_id uuid not null references auth.users(id) on delete cascade,
  assistant text not null check (assistant in ('claude', 'chatgpt')),
  token_hash text not null unique,
  token_last_four text not null check (char_length(token_last_four) = 4),
  created_at timestamptz not null default now(),
  primary key (owner_id, assistant)
);

create index if not exists threads_owner_created on public.threads (owner_id, created_at desc);
create index if not exists thread_deletions_owner_deleted on public.thread_deletions (owner_id, deleted_at desc);

alter table public.board_profiles enable row level security;
alter table public.agent_tokens enable row level security;
revoke all on public.board_profiles, public.agent_tokens from anon, authenticated;
grant all on public.board_profiles, public.agent_tokens to service_role;

-- Atomically attach every legacy row to the authenticated owner. The server
-- exposes this only after verifying the previous board password/session.
create or replace function public.claim_legacy_board(p_owner_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare claimed bigint;
begin
  update public.threads set owner_id = p_owner_id where owner_id is null;
  get diagnostics claimed = row_count;

  update public.assistants set owner_id = p_owner_id where owner_id is null;
  update public.assistant_deliveries d set owner_id = p_owner_id
    where d.owner_id is null and exists (
      select 1 from public.messages m join public.threads t on t.id = m.thread_id
      where m.seq = d.seq and t.owner_id = p_owner_id
    );
  update public.assistant_thread_floors f set owner_id = p_owner_id
    where f.owner_id is null and exists (
      select 1 from public.threads t where t.id = f.thread_id and t.owner_id = p_owner_id
    );
  update public.thread_deletions set owner_id = p_owner_id where owner_id is null;

  insert into public.assistants (owner_id, name)
  values (p_owner_id, 'claude'), (p_owner_id, 'chatgpt')
  on conflict do nothing;
  return jsonb_build_object('claimed_threads', claimed);
end;
$$;
revoke all on function public.claim_legacy_board(uuid) from public, anon, authenticated;
grant execute on function public.claim_legacy_board(uuid) to service_role;

drop function if exists public.remove_board_conversation(uuid, text);
create or replace function public.remove_board_conversation(p_thread_id uuid, p_confirm_title text, p_owner_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare conversation_title text;
begin
  select title into conversation_title from public.threads
    where id = p_thread_id and owner_id = p_owner_id for update;
  if not found then
    if exists (select 1 from public.thread_deletions where thread_id = p_thread_id and owner_id = p_owner_id) then
      return jsonb_build_object('deleted', true, 'thread_id', p_thread_id);
    end if;
    return jsonb_build_object('deleted', false, 'reason', 'not_found');
  end if;
  if conversation_title <> p_confirm_title then
    return jsonb_build_object('deleted', false, 'reason', 'title_mismatch');
  end if;

  insert into public.thread_deletions(thread_id, owner_id) values (p_thread_id, p_owner_id);
  update public.assistants a set
    held_seqs = array(select h from unnest(a.held_seqs) h
      where not exists (select 1 from public.messages m where m.seq = h and m.thread_id = p_thread_id)),
    working_on_seq = case when exists (select 1 from public.messages m where m.seq = a.working_on_seq and m.thread_id = p_thread_id)
      then null else a.working_on_seq end
    where a.owner_id = p_owner_id and exists (select 1 from public.messages m where m.thread_id = p_thread_id
      and (m.seq = any(a.held_seqs) or m.seq = a.working_on_seq));
  delete from public.threads where id = p_thread_id and owner_id = p_owner_id;
  return jsonb_build_object('deleted', true, 'thread_id', p_thread_id);
end;
$$;
revoke all on function public.remove_board_conversation(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.remove_board_conversation(uuid, text, uuid) to service_role;

create or replace view public.thread_summaries with (security_invoker = true) as
select t.id, t.title, t.archived, t.created_at,
       count(m.seq)::bigint as message_count,
       max(m.created_at) as last_message_at,
       t.brief_audio, t.blind_first_round, t.paused, t.owner_id
from public.threads t
left join public.messages m on m.thread_id = t.id
group by t.id;

notify pgrst, 'reload schema';
