-- Step 3: authenticated, durable delivery to the local helper.
-- Apply after schema.sql, permanent-removal.sql, and accounts.sql.
-- These tables are private to the server. Assistant MCP tokens have no access.
begin;
create table if not exists public.helper_devices (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  instance_id uuid,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.helper_devices add column if not exists conversation_report jsonb not null default '[]';
alter table public.helper_devices add column if not exists report_at timestamptz;
-- Which assistants the connected helper runs: ChatGPT (Codex) always, Claude
-- (Claude Code) when it is installed beside it. The helper reports this itself.
alter table public.helper_devices add column if not exists managed_assistants text[] not null default '{chatgpt}';
alter table public.helper_devices drop constraint if exists helper_devices_managed_assistants_check;
alter table public.helper_devices add constraint helper_devices_managed_assistants_check check (managed_assistants <@ array['chatgpt','claude']::text[]);
-- Optional helper features are reported explicitly so a newer board never
-- queues work that an older installed helper cannot understand.
alter table public.helper_devices add column if not exists capabilities text[] not null default '{}';
alter table public.helper_devices drop constraint if exists helper_devices_capabilities_check;
alter table public.helper_devices add constraint helper_devices_capabilities_check check (capabilities <@ array['local_transcription']::text[]);
create table if not exists public.helper_requests (
  seq bigint generated always as identity unique,
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null references public.helper_devices(id) on delete cascade,
  thread_id uuid not null references public.threads(id) on delete cascade,
  action text not null check (action in ('wake', 'message', 'stop', 'pause', 'activity', 'transcribe')),
  message_id uuid references public.messages(id) on delete cascade,
  prompt text,
  status text not null default 'pending' check (status in ('pending','received','stop_requested','completed','stopped','failed','attention','cancelled')),
  received_at timestamptz,
  finished_at timestamptz,
  result text,
  error text,
  created_at timestamptz not null default now(),
  check (action <> 'message' or message_id is not null),
  check (action not in ('pause','activity') or message_id is null),
  check (prompt is null or char_length(prompt) between 1 and 100000),
  check (result is null or char_length(result) <= 1000000)
);
-- Also upgrade a development database that already applied step 3.
alter table public.helper_requests drop constraint if exists helper_requests_action_check;
alter table public.helper_requests add constraint helper_requests_action_check check (action in ('wake','message','stop','pause','activity','transcribe'));
alter table public.helper_requests drop constraint if exists helper_requests_check1;
alter table public.helper_requests drop constraint if exists helper_requests_activity_message_check;
alter table public.helper_requests add constraint helper_requests_activity_message_check check (action <> 'activity' or message_id is null);
-- A message addressed to both assistants becomes one request per assistant.
alter table public.helper_requests add column if not exists assistant text not null default 'chatgpt';
alter table public.helper_requests add column if not exists audio_sha256 text;
alter table public.helper_requests add column if not exists audio_bytes integer;
alter table public.helper_requests drop constraint if exists helper_requests_audio_sha256_check;
alter table public.helper_requests add constraint helper_requests_audio_sha256_check check (audio_sha256 is null or audio_sha256 ~ '^[a-f0-9]{64}$');
alter table public.helper_requests drop constraint if exists helper_requests_audio_bytes_check;
alter table public.helper_requests add constraint helper_requests_audio_bytes_check check (audio_bytes is null or audio_bytes between 44 and 20971520);
alter table public.helper_requests drop constraint if exists helper_requests_assistant_check;
alter table public.helper_requests add constraint helper_requests_assistant_check check (assistant in ('chatgpt','claude'));
create index if not exists helper_requests_delivery on public.helper_requests(device_id, seq) where received_at is null and status = 'pending';
create index if not exists helper_requests_thread on public.helper_requests(owner_id, thread_id, seq desc);
alter table public.helper_devices enable row level security;
alter table public.helper_requests enable row level security;
revoke all on public.helper_devices, public.helper_requests from public, anon, authenticated;
grant all on public.helper_devices, public.helper_requests to service_role;
grant usage, select on sequence public.helper_requests_seq_seq to service_role;

-- Called ONLY by the authenticated website route after requireUser(). The owner
-- comes from the verified account, never from request JSON.
create or replace function public.helper_user(p_owner uuid, p_action text, p_args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare d public.helper_devices%rowtype;
declare r public.helper_requests%rowtype;
declare m public.messages%rowtype;
declare tid uuid;
declare mid uuid;
declare rid uuid;
declare kind text;
declare asst text;
begin
  if p_owner is null then raise exception 'HELPER_UNAUTHORIZED'; end if;
  if p_action = 'configure' then
    insert into public.helper_devices(owner_id, name, token_hash)
      values(p_owner, p_args->>'name', p_args->>'token_hash')
      on conflict(owner_id) do update set name=excluded.name, token_hash=excluded.token_hash,
        revoked_at=null, instance_id=null, last_seen_at=null,conversation_report='[]',report_at=null,capabilities='{}' returning * into d;
    return jsonb_build_object('device_id',d.id,'owner_id',d.owner_id);
  end if;
  select * into d from public.helper_devices where owner_id=p_owner for no key update;
  if p_action = 'status' then
    if not found then return jsonb_build_object('configured',false); end if;
    return jsonb_build_object('configured',d.revoked_at is null,'device_id',d.id,'name',d.name,
      'last_seen_at',d.last_seen_at,'connected',d.revoked_at is null and coalesce(d.last_seen_at > now()-interval '45 seconds',false),
      'managed_assistants',to_jsonb(d.managed_assistants),'capabilities',to_jsonb(d.capabilities));
  end if;
  if p_action = 'revoke' then
    update public.helper_devices set revoked_at=now() where owner_id=p_owner;
    return jsonb_build_object('revoked',true);
  end if;
  tid := (p_args->>'thread_id')::uuid;
  if not exists(select 1 from public.threads where id=tid and owner_id=p_owner and not archived) then raise exception 'HELPER_NOT_FOUND'; end if;
  if p_action = 'requests' then
    return jsonb_build_object('configured',d.id is not null and d.revoked_at is null,
      'connected',d.revoked_at is null and coalesce(d.report_at>now()-interval '45 seconds',false),
      'managed_assistants',to_jsonb(coalesce(d.managed_assistants,'{}'::text[])),'capabilities',to_jsonb(coalesce(d.capabilities,'{}'::text[])),
      'conversation',(select x from jsonb_array_elements(d.conversation_report) x where x->>'thread_id'=tid::text limit 1),
      'requests',coalesce((select jsonb_agg(x order by x.seq) from
      (select id,seq,thread_id,action,assistant,message_id,status,received_at,finished_at,error
       from public.helper_requests where owner_id=p_owner and thread_id=tid and action<>'activity' order by seq desc limit 100) x),'[]'::jsonb));
  end if;
  if d.id is null or d.revoked_at is not null then raise exception 'HELPER_NOT_CONFIGURED'; end if;
  if p_action <> 'enqueue' then raise exception 'HELPER_BAD_REQUEST'; end if;
  rid := (p_args->>'id')::uuid;
  mid := (p_args->>'message_id')::uuid;
  kind := p_args->>'action';
  asst := coalesce(p_args->>'assistant','chatgpt');
  if rid is null or kind not in ('wake','message','stop','activity','transcribe') or asst not in ('chatgpt','claude') or (kind='message' and mid is null) or (kind in ('activity','transcribe') and mid is not null) then raise exception 'HELPER_BAD_REQUEST'; end if;
  if kind='transcribe' and (not ('local_transcription'=any(d.capabilities)) or coalesce(p_args->>'audio_path','') !~ ('^'||p_owner::text||'/'||rid::text||'\.wav$') or coalesce(p_args->>'audio_sha256','') !~ '^[a-f0-9]{64}$' or coalesce((p_args->>'audio_bytes')::integer,0) not between 44 and 20971520) then raise exception 'HELPER_BAD_REQUEST'; end if;
  select * into r from public.helper_requests where id=rid;
  if found then
    if r.owner_id<>p_owner or r.thread_id<>tid or r.action<>kind or r.message_id is distinct from mid or (mid is not null and r.assistant<>asst) then raise exception 'HELPER_CONFLICT'; end if;
    return jsonb_build_object('id',r.id,'status',r.status,'duplicate',true);
  end if;
  if mid is not null then
    select * into m from public.messages where id=mid and thread_id=tid and author='user' and addressed_to in (asst,'both');
    if not found then raise exception 'HELPER_NOT_FOUND'; end if;
    if kind<>'stop' and asst=any(m.stopped_for) then raise exception 'HELPER_TASK_STOPPED'; end if;
  end if;
  insert into public.helper_requests(id,owner_id,device_id,thread_id,action,message_id,prompt,assistant,audio_sha256,audio_bytes)
    values(rid,p_owner,d.id,tid,kind,mid,case when kind='transcribe' then p_args->>'audio_path' else m.body end,asst,
      case when kind='transcribe' then p_args->>'audio_sha256' end,
      case when kind='transcribe' then (p_args->>'audio_bytes')::integer end) returning * into r;
  if kind='stop' then
    -- Serialize Stop with delivery/results using the same device row lock. A
    -- card Stop cancels one assistant's answer; a conversation Stop cancels all.
    update public.helper_requests set status=case when received_at is null then 'cancelled' else 'stop_requested' end,
      result=null where device_id=d.id and thread_id=tid and seq<r.seq and message_id is not null
      and action in ('wake','message') and (mid is null or (message_id=mid and assistant=asst)) and status in ('pending','received');
  end if;
  return jsonb_build_object('id',r.id,'status',r.status,'duplicate',false);
end;
$$;

-- Authenticate and act in ONE transaction, so revocation cannot race a prior
-- token check. The first connection pins this key to its persisted instance ID.
create or replace function public.helper_device(p_hash text, p_instance uuid, p_action text, p_args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare d public.helper_devices%rowtype;
declare r public.helper_requests%rowtype;
declare response jsonb;
declare wanted text;
begin
  select * into d from public.helper_devices where token_hash=p_hash and revoked_at is null for no key update;
  if not found or p_instance is null then raise exception 'HELPER_UNAUTHORIZED'; end if;
  if d.instance_id is not null and d.instance_id<>p_instance then raise exception 'HELPER_INSTANCE_CONFLICT'; end if;
  if p_action not in ('receive','ack','result') then raise exception 'HELPER_BAD_REQUEST'; end if;
  update public.helper_devices set instance_id=p_instance,last_seen_at=now() where id=d.id;
  if p_args ? 'conversations' then
    update public.helper_devices set report_at=now(),conversation_report=coalesce((
      select jsonb_agg(x) from jsonb_array_elements(p_args->'conversations') x
      join public.threads t on t.id=(x->>'thread_id')::uuid and t.owner_id=d.owner_id and not t.archived
    ),'[]'::jsonb) where id=d.id;
  end if;
  if p_args ? 'assistants' then
    -- The helper reports which assistants it can run. Only known names are kept.
    update public.helper_devices set managed_assistants=coalesce((
      select array_agg(distinct x) from jsonb_array_elements_text(p_args->'assistants') x where x in ('chatgpt','claude')
    ),'{}'::text[]) where id=d.id;
  end if;
  if p_args ? 'capabilities' then
    update public.helper_devices set capabilities=coalesce((
      select array_agg(distinct x) from jsonb_array_elements_text(p_args->'capabilities') x where x in ('local_transcription')
    ),'{}'::text[]) where id=d.id;
  end if;
  if p_action='receive' then
    -- Reads do not consume requests. Lost responses are redelivered until the
    -- helper has saved the command locally and acknowledged it.
    select coalesce(jsonb_agg(x order by x.seq),'[]'::jsonb) into response from
      (select q.id,q.seq,q.thread_id,q.action,q.assistant,q.message_id,q.prompt,q.audio_sha256,q.audio_bytes,q.status,q.created_at,t.title
       from public.helper_requests q join public.threads t on t.id=q.thread_id
       where q.device_id=d.id and q.owner_id=d.owner_id and t.owner_id=d.owner_id
       and not t.archived and (not t.paused or q.action in ('stop','pause','activity')) and q.received_at is null and q.status='pending'
       order by q.seq limit 50) x;
    return jsonb_build_object('device_id',d.id,'owner_id',d.owner_id,'requests',response,'server_now',clock_timestamp());
  end if;
  select * into r from public.helper_requests where id=(p_args->>'id')::uuid
    and owner_id=d.owner_id and device_id=d.id;
  if not found then raise exception 'HELPER_NOT_FOUND'; end if;
  if not exists(select 1 from public.threads t where t.id=r.thread_id and t.owner_id=d.owner_id and not t.archived) then raise exception 'HELPER_NOT_FOUND'; end if;
  if p_action='ack' then
    if r.received_at is null then
      update public.helper_requests set received_at=now(),status=case
        when status='pending' then case when p_args->>'rejected'='true' then 'attention' else 'received' end else status end,
        error=case when p_args->>'rejected'='true' then 'This conversation is not linked in the helper or its command could not be accepted.' else error end
        where id=r.id returning * into r;
    end if;
    return jsonb_build_object('id',r.id,'status',r.status);
  end if;
  wanted := p_args->>'status';
  -- Local transcription can take minutes. Its durable result atomically
  -- acknowledges the request so a helper restart simply receives it again.
  if p_action='result' and r.action='transcribe' and r.received_at is null then
    update public.helper_requests set received_at=now(),status='received' where id=r.id returning * into r;
  end if;
  if wanted not in ('completed','stopped','failed','attention') or r.received_at is null then raise exception 'HELPER_BAD_REQUEST'; end if;
  if r.status in ('completed','stopped','failed','attention') then
    return jsonb_build_object('id',r.id,'status',r.status,'duplicate',true);
  end if;
  -- A queued Stop beats a late answer, even if the helper was disconnected.
  if r.status in ('stop_requested','cancelled') then wanted := 'stopped'; end if;
  update public.helper_requests set status=wanted,finished_at=now(),
    result=case when wanted='completed' then p_args->>'result' else null end,
    error=left(p_args->>'error',1000) where id=r.id returning * into r;
  return jsonb_build_object('id',r.id,'status',r.status,'duplicate',false);
end;
$$;
revoke all on function public.helper_user(uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.helper_device(text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.helper_user(uuid,text,jsonb),public.helper_device(text,uuid,text,jsonb) to service_role;

-- A new board conversation gets a durable Wake event. The local helper uses
-- only its own trusted workspace root and creates one Codex task and one Claude
-- session for this UUID.
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
