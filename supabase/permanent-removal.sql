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
      then null else a.working_on_seq end;
  delete from public.threads where id = p_thread_id;
  return jsonb_build_object('deleted', true, 'thread_id', p_thread_id);
end;
$$;
revoke all on function public.remove_board_conversation(uuid, text) from public, anon, authenticated;
grant execute on function public.remove_board_conversation(uuid, text) to service_role;
notify pgrst, 'reload schema';
