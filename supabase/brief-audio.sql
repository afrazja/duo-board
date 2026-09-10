-- Additive migration: existing clients and messages keep working.
alter table public.threads
  add column if not exists brief_audio boolean not null default false;
alter table public.messages
  add column if not exists spoken_summary text
  check (spoken_summary is null or char_length(spoken_summary) between 1 and 1200);

-- Append the new view column so existing column positions are preserved.
create or replace view public.thread_summaries with (security_invoker = true) as
select t.id, t.title, t.archived, t.created_at,
       count(m.seq)::bigint as message_count,
       max(m.created_at) as last_message_at,
       t.brief_audio
from public.threads t
left join public.messages m on m.thread_id = t.id
group by t.id;

notify pgrst, 'reload schema';
