-- Pause and resume a conversation: run once in the Supabase SQL editor of an
-- existing Duo Board database. Additive and idempotent. The same statements
-- live in schema.sql for fresh installs.
--
-- While paused, assistants' scoped reads of the conversation deliver nothing
-- and stamp nothing, and their loops skip it. Nothing is lost: resuming lets
-- the next read deliver everything that arrived meanwhile, in order.

alter table public.threads add column if not exists paused boolean not null default false;

create or replace view public.thread_summaries with (security_invoker = true) as
select t.id, t.title, t.archived, t.created_at,
       count(m.seq)::bigint as message_count,
       max(m.created_at) as last_message_at,
       t.brief_audio, t.blind_first_round, t.paused
from public.threads t
left join public.messages m on m.thread_id = t.id
group by t.id;

notify pgrst, 'reload schema';
