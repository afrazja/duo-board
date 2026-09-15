-- Step 6: one responder per assistant per account. Apply after helper-ui.sql.
-- ChatGPT is helper-managed for every paired account; Claude only while the
-- paired helper reports that Claude Code is installed beside it.
begin;
create or replace function public.helper_assistant_owner(p_owner uuid, p_assistant text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.helper_devices where owner_id=p_owner and p_assistant=any(managed_assistants));
$$;
revoke all on function public.helper_assistant_owner(uuid,text) from public,anon,authenticated;
grant execute on function public.helper_assistant_owner(uuid,text) to service_role;

create or replace function public.helper_chatgpt_owner(p_owner uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.helper_assistant_owner(p_owner,'chatgpt');
$$;
revoke all on function public.helper_chatgpt_owner(uuid) from public,anon,authenticated;
grant execute on function public.helper_chatgpt_owner(uuid) to service_role;

-- A stopped/revoked/offline helper does not silently hand old work back to a
-- legacy loop. Cached replies from that loop are rejected as well as new reads.
-- Only helper_publish_answer sets helper_reply_for, from a persisted result.
create or replace function public.helper_guard_legacy_post()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.author in ('chatgpt','claude') and new.helper_reply_for is null and exists(
    select 1 from public.helper_devices d join public.threads t on t.owner_id=d.owner_id
    where t.id=new.thread_id and new.author=any(d.managed_assistants)
  ) then raise exception '% is managed by the background helper. Stop the legacy loop; do not retry this reply.',
    case when new.author='claude' then 'Claude' else 'ChatGPT' end; end if;
  return new;
end;
$$;
revoke all on function public.helper_guard_legacy_post() from public,anon,authenticated;
create or replace trigger helper_no_legacy_post before insert on public.messages
for each row execute function public.helper_guard_legacy_post();
notify pgrst, 'reload schema';
commit;
