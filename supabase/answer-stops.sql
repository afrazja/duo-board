-- Stop one answer: run once in the Supabase SQL editor of an existing Duo
-- Board database, after accounts.sql. Additive and idempotent. Fresh
-- installs run it after schema.sql and accounts.sql.
--
-- The person can stop one assistant's work on one of their messages from
-- that assistant's waiting card. The stopped message is never delivered to
-- that assistant, its next read reports the stop once so a session already
-- working on it drops the task, and no answer to it from that assistant is
-- accepted, even a late one. The other assistant is unaffected.

create table if not exists public.question_stops (
  question_id uuid        not null references public.messages(id) on delete cascade,
  assistant   text        not null check (assistant in ('claude', 'chatgpt')),
  thread_id   uuid        not null references public.threads(id) on delete cascade,
  owner_id    uuid        references auth.users(id) on delete cascade,
  stopped_at  timestamptz not null default now(),
  -- When the assistant's read first reported the stop; null until then.
  notified_at timestamptz,
  primary key (question_id, assistant)
);
create index if not exists question_stops_thread on public.question_stops (thread_id, assistant);
create index if not exists question_stops_unnotified on public.question_stops (owner_id, assistant) where notified_at is null;
alter table public.question_stops enable row level security;
revoke all on public.question_stops from anon, authenticated;
grant select, insert, update, delete on public.question_stops to service_role;

-- Record a stop. The message row is locked first, so an answer being
-- inserted at the same moment is serialized with it: either the answer
-- commits first and the stop is refused as already answered, or the stop
-- commits first and the trigger below refuses the answer.
create or replace function public.stop_board_question(p_owner_id uuid, p_question_id uuid, p_assistant text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  q_seq bigint;
  q_thread uuid;
  q_author text;
  q_audience text;
  stopped_time timestamptz;
begin
  if p_assistant not in ('claude', 'chatgpt') then
    return jsonb_build_object('stopped', false, 'reason', 'invalid_assistant');
  end if;
  select m.seq, m.thread_id, m.author, m.addressed_to into q_seq, q_thread, q_author, q_audience
    from public.messages m
    join public.threads t on t.id = m.thread_id
    where m.id = p_question_id and t.owner_id = p_owner_id
    for update of m;
  if not found or q_author <> 'user' then
    return jsonb_build_object('stopped', false, 'reason', 'not_found');
  end if;
  if q_audience not in ('both', p_assistant) then
    return jsonb_build_object('stopped', false, 'reason', 'not_addressed');
  end if;
  if exists (select 1 from public.messages r where r.reply_to = p_question_id and r.author = p_assistant) then
    return jsonb_build_object('stopped', false, 'reason', 'already_answered');
  end if;
  insert into public.question_stops (question_id, assistant, thread_id, owner_id)
    values (p_question_id, p_assistant, q_thread, p_owner_id)
    on conflict (question_id, assistant) do nothing;
  select s.stopped_at into stopped_time from public.question_stops s
    where s.question_id = p_question_id and s.assistant = p_assistant;
  -- The card stops saying "Working on an answer" at once.
  update public.assistants set working_on_seq = null
    where owner_id = p_owner_id and name = p_assistant and working_on_seq = q_seq;
  return jsonb_build_object('stopped', true, 'question_id', p_question_id, 'assistant', p_assistant, 'stopped_at', stopped_time);
end;
$$;
revoke all on function public.stop_board_question(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.stop_board_question(uuid, uuid, text) to service_role;

-- Refuse an assistant's post whose reply chain leads to a message the person
-- stopped for that assistant. Each row on the chain is locked in share mode,
-- so this waits for a stop being recorded at the same moment and then sees it.
-- The server also refuses unlinked notes that would sit under a stopped message.
create or replace function public.guard_stopped_assistant_post()
returns trigger language plpgsql set search_path = '' as $$
declare
  target uuid;
  row_author text;
  row_parent uuid;
  hops int := 0;
begin
  if new.author = 'user' or new.reply_to is null then
    return new;
  end if;
  target := new.reply_to;
  loop
    select m.author, m.reply_to into row_author, row_parent
      from public.messages m where m.id = target and m.thread_id = new.thread_id for share;
    if not found then
      return new;
    end if;
    exit when row_author = 'user';
    hops := hops + 1;
    if row_parent is null or hops > 8 then
      return new;
    end if;
    target := row_parent;
  end loop;
  if exists (select 1 from public.question_stops s where s.question_id = target and s.assistant = new.author) then
    raise exception 'The person stopped this question for you. Drop the task: do not answer it or post about it.';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_stopped_assistant_post() from public, anon, authenticated;
create or replace trigger messages_guard_stopped_assistant_post
  before insert on public.messages
  for each row execute function public.guard_stopped_assistant_post();

notify pgrst, 'reload schema';
