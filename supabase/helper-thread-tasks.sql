-- Create a durable helper event whenever a signed-in user creates a board
-- conversation. The Windows helper chooses the local workspace and creates the
-- corresponding Codex task; no remote request can supply a path or task ID.
begin;
create or replace function public.helper_queue_new_thread()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.helper_requests(id,owner_id,device_id,thread_id,action)
    select gen_random_uuid(),new.owner_id,d.id,new.id,'wake'
    from public.helper_devices d
    where d.owner_id=new.owner_id and d.revoked_at is null;
  return new;
end;
$$;
revoke all on function public.helper_queue_new_thread() from public,anon,authenticated;
drop trigger if exists helper_new_thread on public.threads;
create trigger helper_new_thread after insert on public.threads
for each row execute function public.helper_queue_new_thread();
notify pgrst, 'reload schema';
commit;
