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
       t.brief_audio, t.blind_first_round
from public.threads t
left join public.messages m on m.thread_id = t.id
group by t.id;

notify pgrst, 'reload schema';
