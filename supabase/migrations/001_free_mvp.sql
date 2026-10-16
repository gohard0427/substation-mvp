-- Dedicated Supabase FREE project. No client table/RPC access is granted.
begin;
create table if not exists public.np_config(singleton boolean primary key default true check(singleton), payload jsonb not null);
insert into public.np_config values(true,'{"project":"전력설비 점검 및 정비공사","workTypes":["대상 기기","작업 전","작업 후","분리","조립","청소","점검","교체","동작특성 시험","코일 저항 측정","PMA 전압 측정"],"ambiguityGroups":[{"id":"pma-measurement","name":"PMA 타입 GIS 측정","equipmentMatch":"PMA","options":["코일 저항 측정","PMA 전압 측정"],"reason":"측정 위치 및 계측기 동일","required":true}],"workerEpoch":1,"adminEpoch":1}') on conflict do nothing;
create table if not exists public.np_sessions(token_hash text primary key check(token_hash ~ '^[a-f0-9]{64}$'),role text not null check(role in ('worker','admin')),user_id uuid not null,epoch bigint not null,expires_at timestamptz not null default now()+interval '12 hours');
create table if not exists public.np_login_attempts(identity_hash text not null,created_at timestamptz not null default now());
create index if not exists np_attempts_lookup on public.np_login_attempts(identity_hash,created_at);
create table if not exists public.np_jobs(id uuid primary key,device_hash text not null check(device_hash ~ '^[a-f0-9]{64}$'),capability_hash text not null check(capability_hash ~ '^[a-f0-9]{64}$'),revision bigint not null default 1,state text not null default 'uploaded' check(state in ('uploaded','generating','ready','deleting')),payload jsonb not null default '{"photos":[],"warnings":[]}',updated_at timestamptz not null default now(),expires_at timestamptz not null default now()+interval '24 hours');
create index if not exists np_jobs_device on public.np_jobs(device_hash);
create index if not exists np_jobs_expiry on public.np_jobs(expires_at);
create table if not exists public.np_files(id uuid primary key,job_id uuid not null references public.np_jobs(id),photo_id text not null check(photo_id ~ '^[a-f0-9]{24}$'),kind text not null check(kind in ('source','result')),object_path text not null unique,bytes bigint not null check(bytes>0 and bytes<=8388608),status text not null default 'pending' check(status in ('pending','ready','deleting')),signature text,meta jsonb not null default '{}',created_at timestamptz not null default now());
create index if not exists np_files_job on public.np_files(job_id);
-- Quota includes pending uploads and files waiting for deletion, so failures do
-- not allow quota bypass. A private bucket is configured in the next migration.
create or replace function public.np_rpc(p_action text,p_data jsonb default '{}') returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
 cfg jsonb; j public.np_jobs%rowtype; f public.np_files%rowtype; sess public.np_sessions%rowtype;
 photos jsonb; item jsonb; total_bytes bigint; answer jsonb; epoch_key text; role_value text;
 jid uuid; fid uuid; file_ids uuid[];
begin
 select payload into cfg from public.np_config where singleton;
 if p_action='config_get' then
  return cfg || jsonb_build_object('storageBytes',(select coalesce(sum(bytes),0) from public.np_files),'storageLimit',734003200);
 elsif p_action='config_set' then
  update public.np_config set payload=payload || (p_data-'workerEpoch'-'adminEpoch'-'storageBytes'-'storageLimit') where singleton;
  return '{}'::jsonb;
 elsif p_action='login_check' then
  if (select count(*) from public.np_login_attempts where identity_hash=p_data->>'identity' and created_at>now()-interval '10 minutes')>=8 then raise exception 'LOGIN_LIMIT'; end if;
  return '{}';
 elsif p_action='login_failed' then
  insert into public.np_login_attempts(identity_hash) values(p_data->>'identity');return '{}';
 elsif p_action='session_create' then
  role_value=p_data->>'role';epoch_key=case when role_value='admin' then 'adminEpoch' else 'workerEpoch' end;
  insert into public.np_sessions(token_hash,role,user_id,epoch) values(p_data->>'tokenHash',role_value,(p_data->>'userId')::uuid,(cfg->>epoch_key)::bigint);
  delete from public.np_login_attempts where identity_hash=p_data->>'identity';return '{}';
 elsif p_action='session_get' then
  select * into sess from public.np_sessions where token_hash=p_data->>'tokenHash' and expires_at>now();
  if not found then raise exception 'AUTH_REQUIRED';end if;
  epoch_key=case when sess.role='admin' then 'adminEpoch' else 'workerEpoch' end;
  if sess.epoch<>(cfg->>epoch_key)::bigint then raise exception 'AUTH_REQUIRED';end if;
  return jsonb_build_object('role',sess.role,'userId',sess.user_id);
 elsif p_action='sessions_revoke' then
  update public.np_config set payload=jsonb_set(payload,'{workerEpoch}',to_jsonb((payload->>'workerEpoch')::bigint+1)) where singleton;
  delete from public.np_sessions where role='worker';
  if coalesce((p_data->>'all')::boolean,false) then
   update public.np_config set payload=jsonb_set(payload,'{adminEpoch}',to_jsonb((payload->>'adminEpoch')::bigint+1)) where singleton;
   delete from public.np_sessions;
  end if;return '{}';
 elsif p_action='jobs_list' then
  return coalesce((select jsonb_agg(payload || jsonb_build_object('id',id,'revision',revision,'state',state,'expiresAt',expires_at) order by updated_at desc) from public.np_jobs where device_hash=p_data->>'deviceHash' and (expires_at>now() or state='deleting')),'[]');
 elsif p_action='job_create' then
  perform pg_advisory_xact_lock(70164001);
  if (select count(*) from public.np_jobs where device_hash=p_data->>'deviceHash' and expires_at>now())>=3 then raise exception 'DEVICE_JOB_LIMIT';end if;
  if (select count(*) from public.np_jobs)>=30 then raise exception 'JOB_LIMIT';end if;
  insert into public.np_jobs(id,device_hash,capability_hash) values((p_data->>'id')::uuid,p_data->>'deviceHash',p_data->>'capabilityHash');
  return public.np_rpc('job_get',p_data);
 elsif p_action='cleanup_list' then
  update public.np_jobs set state='deleting' where expires_at<=now();
  update public.np_files set status='deleting' where job_id in (select id from public.np_jobs where state='deleting') or (status='pending' and created_at<now()-interval '24 hours');
  delete from public.np_jobs where state='deleting' and not exists(select 1 from public.np_files where job_id=np_jobs.id);
  delete from public.np_sessions where expires_at<=now();delete from public.np_login_attempts where created_at<now()-interval '1 day';
  return coalesce((select jsonb_agg(to_jsonb(x)) from (select id,object_path from public.np_files where status='deleting' order by created_at limit 100) x),'[]');
 elsif p_action='files_forget' then
  select array_agg(value::uuid) into file_ids from jsonb_array_elements_text(p_data->'ids');
  delete from public.np_files where id=any(file_ids) and status='deleting';
  delete from public.np_jobs where state='deleting' and not exists(select 1 from public.np_files where job_id=np_jobs.id);return '{}';
 end if;
 -- All remaining actions require BOTH device ownership and a per-job capability.
 jid=(p_data->>'id')::uuid;
 select * into j from public.np_jobs where id=jid and device_hash=p_data->>'deviceHash' and capability_hash=p_data->>'capabilityHash' for update;
 if not found then raise exception 'JOB_ACCESS';end if;
 if p_action='job_delete' then
  update public.np_jobs set state='deleting',expires_at=now() where id=jid;
  update public.np_files set status='deleting' where job_id=jid;
  return coalesce((select jsonb_agg(jsonb_build_object('id',id,'object_path',object_path)) from public.np_files where job_id=jid),'[]');
 end if;
 if j.expires_at<=now() or j.state='deleting' then raise exception 'JOB_EXPIRED';end if;
 if p_action='job_get' then
  return j.payload || jsonb_build_object('id',j.id,'revision',j.revision,'state',j.state,'expiresAt',j.expires_at,'files',coalesce((select jsonb_agg(to_jsonb(x)-'meta') from public.np_files x where job_id=jid and status='ready'),'[]'));
 elsif p_action='job_save' then
  if j.state='generating' then raise exception 'GENERATION_ACTIVE';end if;
  if (p_data->>'revision')::bigint<>j.revision then raise exception 'REVISION_CONFLICT';end if;
  update public.np_jobs set payload=p_data->'payload',revision=revision+1,state='uploaded',updated_at=now(),expires_at=now()+interval '24 hours' where id=jid;
 elsif p_action='job_warnings' then
  update public.np_jobs set payload=jsonb_set(payload,'{warnings}',p_data->'warnings'),revision=revision+1,updated_at=now(),expires_at=now()+interval '24 hours' where id=jid;
 elsif p_action='generation_begin' then
  if j.state='generating' then return public.np_rpc('job_get',p_data);end if;
  if (p_data->>'revision')::bigint<>j.revision then raise exception 'REVISION_CONFLICT';end if;
  update public.np_jobs set payload=jsonb_set(payload,'{generation}',p_data->'generation'),revision=revision+1,state='generating',updated_at=now(),expires_at=now()+interval '24 hours' where id=jid;
 elsif p_action='generation_pause' then
  update public.np_jobs set state='uploaded',revision=revision+1,updated_at=now(),expires_at=now()+interval '24 hours' where id=jid;
 elsif p_action='generation_complete' then
  if j.state<>'generating' then raise exception 'GENERATION_INACTIVE';end if;
  for item in select value from jsonb_array_elements(j.payload->'photos') loop
   if not coalesce((item->>'excluded')::boolean,false) and not exists(select 1 from public.np_files where job_id=jid and photo_id=item->>'id' and kind='result' and status='ready' and signature=j.payload->'generation'->'signatures'->> (item->>'id')) then raise exception 'RESULT_MISSING';end if;
  end loop;
  update public.np_jobs set state='ready',revision=revision+1,updated_at=now(),expires_at=now()+interval '24 hours' where id=jid;
 elsif p_action='file_reserve' then
  perform pg_advisory_xact_lock(70164002);
  select coalesce(sum(bytes),0) into total_bytes from public.np_files;
  if total_bytes+(p_data->>'bytes')::bigint>734003200 then raise exception 'STORAGE_LIMIT';end if;
  if p_data->>'kind'='source' then
   if j.state<>'uploaded' or jsonb_array_length(j.payload->'photos')>=50 then raise exception 'PHOTO_LIMIT';end if;
   if (p_data->>'revision')::bigint<>j.revision then raise exception 'REVISION_CONFLICT';end if;
   if exists(select 1 from jsonb_array_elements(j.payload->'photos') x where x->>'id'=p_data->>'photoId') then raise exception 'PHOTO_EXISTS';end if;
  else
   if j.state<>'generating' or p_data->'meta'->>'generationId'<>j.payload->'generation'->>'id' then raise exception 'GENERATION_INACTIVE';end if;
   if not exists(select 1 from jsonb_array_elements(j.payload->'photos') x where x->>'id'=p_data->>'photoId' and not coalesce((x->>'excluded')::boolean,false)) then raise exception 'PHOTO_MISSING';end if;
   if p_data->>'signature'<>j.payload->'generation'->'signatures'->>(p_data->>'photoId') then raise exception 'STALE_RESULT';end if;
  end if;
  insert into public.np_files(id,job_id,photo_id,kind,object_path,bytes,signature,meta) values((p_data->>'fileId')::uuid,jid,p_data->>'photoId',p_data->>'kind',p_data->>'path',(p_data->>'bytes')::bigint,p_data->>'signature',(p_data->'meta') || jsonb_build_object('revision',j.revision));
  return '{}';
 elsif p_action='file_finalize' then
  select * into f from public.np_files where id=(p_data->>'fileId')::uuid and job_id=jid for update;
  if not found or f.status='deleting' then raise exception 'FILE_MISSING';end if;
  if f.status='ready' then return public.np_rpc('job_get',p_data);end if;
  if f.kind='source' then
   if j.state<>'uploaded' or (f.meta->>'revision')::bigint<>j.revision then raise exception 'REVISION_CONFLICT';end if;
   photos=j.payload->'photos';
   update public.np_jobs set payload=jsonb_set(payload,'{photos}',photos || jsonb_build_array(f.meta->'photo')),revision=revision+1,updated_at=now(),expires_at=now()+interval '24 hours' where id=jid;
  else
   if j.state<>'generating' or f.meta->>'generationId'<>j.payload->'generation'->>'id' then raise exception 'GENERATION_INACTIVE';end if;
   update public.np_files set status='deleting' where job_id=jid and photo_id=f.photo_id and kind='result' and id<>f.id and status='ready';
   update public.np_jobs set updated_at=now(),expires_at=now()+interval '24 hours' where id=jid;
  end if;
  update public.np_files set status='ready' where id=f.id;
 elsif p_action='file_abandon' then
  update public.np_files set status='deleting' where id=(p_data->>'fileId')::uuid and job_id=jid and status='pending';return coalesce((select jsonb_agg(jsonb_build_object('id',id,'object_path',object_path)) from public.np_files where id=(p_data->>'fileId')::uuid and job_id=jid and status='deleting'),'[]');
 else raise exception 'UNKNOWN_ACTION';
 end if;
 return public.np_rpc('job_get',p_data);
end;
$$;
alter table public.np_config enable row level security;
alter table public.np_sessions enable row level security;
alter table public.np_login_attempts enable row level security;
alter table public.np_jobs enable row level security;
alter table public.np_files enable row level security;
revoke all on public.np_config,public.np_sessions,public.np_login_attempts,public.np_jobs,public.np_files from public,anon,authenticated;
revoke all on function public.np_rpc(text,jsonb) from public,anon,authenticated;
grant execute on function public.np_rpc(text,jsonb) to service_role;
commit;
