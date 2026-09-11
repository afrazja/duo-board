-- Stop one assistant's current answer without pausing the conversation or the
-- other assistant. Additive and idempotent; also included in schema.sql.

alter table public.messages
  add column if not exists stopped_for text[] not null default '{}';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'messages_stopped_for_check'
  ) then
    alter table public.messages add constraint messages_stopped_for_check
      check (stopped_for <@ array['claude', 'chatgpt']::text[]);
  end if;
end $$;

create or replace function public.stop_board_task(
  p_owner_id uuid,
  p_thread_id uuid,
  p_message_id uuid,
  p_assistant text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare stopped_message public.messages%rowtype;
begin
  if p_assistant not in ('claude', 'chatgpt') then
    raise exception 'Unknown assistant';
  end if;

  update public.messages m set stopped_for = case
    when p_assistant = any(m.stopped_for) then m.stopped_for
    else array_append(m.stopped_for, p_assistant)
  end
  where m.id = p_message_id
    and m.thread_id = p_thread_id
    and m.author = 'user'
    and m.addressed_to in ('both', p_assistant)
    and exists (
      select 1 from public.threads t
      where t.id = p_thread_id and t.owner_id = p_owner_id
    )
  returning m.* into stopped_message;

  if not found then
    raise exception 'Task not found';
  end if;

  update public.assistants set working_on_seq = null
  where owner_id = p_owner_id
    and name = p_assistant
    and working_on_seq = stopped_message.seq;

  return to_jsonb(stopped_message);
end;
$$;
revoke all on function public.stop_board_task(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.stop_board_task(uuid, uuid, uuid, text) to service_role;

-- Serialize an assistant's final post with Stop. If Stop committed first, the
-- reply is rejected even when the assistant began composing it earlier.
create or replace function public.guard_paused_assistant_post()
returns trigger language plpgsql set search_path = '' as $$
declare conversation_paused boolean;
declare task_stopped boolean := false;
begin
  if new.author <> 'user' then
    select t.paused into conversation_paused from public.threads t
      where t.id = new.thread_id for share;
    if conversation_paused then
      raise exception 'Conversation is paused. Keep this reply pending until the person resumes it.';
    end if;

    if new.reply_to is not null then
      select new.author = any(m.stopped_for) into task_stopped
      from public.messages m
      where m.id = new.reply_to and m.thread_id = new.thread_id
      for share;
    end if;
    if task_stopped then
      raise exception 'The person stopped this task. Do not continue or post an answer.';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_paused_assistant_post() from public, anon, authenticated;

notify pgrst, 'reload schema';
