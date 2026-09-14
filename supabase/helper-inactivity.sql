-- Step 4. Reapply the updated helper-queue.sql first, then this file.
-- Record message activity in the same transaction as the message. No browser
-- timer, read_new, status poll, or helper health check can produce activity.
begin;
create or replace function public.helper_record_message_activity()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.helper_requests(id,owner_id,device_id,thread_id,action,created_at)
    select gen_random_uuid(),t.owner_id,d.id,t.id,'activity',clock_timestamp()
    from public.threads t join public.helper_devices d on d.owner_id=t.owner_id
    where t.id=new.thread_id and not t.archived and d.revoked_at is null;
  return new;
end;
$$;
revoke all on function public.helper_record_message_activity() from public,anon,authenticated;
drop trigger if exists helper_message_activity on public.messages;
create trigger helper_message_activity after insert on public.messages
for each row execute function public.helper_record_message_activity();
notify pgrst, 'reload schema';
commit;
