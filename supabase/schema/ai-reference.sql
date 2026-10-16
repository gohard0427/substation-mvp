begin;
create table public.np_reference_photos(id uuid primary key default gen_random_uuid(),original_hash text not null unique check(original_hash ~ '^[a-f0-9]{64}$'),path text not null,archive text not null default '',ocr_raw jsonb not null default '{}',label jsonb not null default '{}',mask jsonb not null default '{"x":0.44,"y":0.75}',reviewed boolean not null default false,image_ready boolean not null default false,object_path text,image_bytes bigint not null default 0 check(image_bytes between 0 and 1048576),visual_signature jsonb,split text not null default 'train' check(split in ('train','evaluation')),updated_at timestamptz not null default now());
create index np_reference_review on public.np_reference_photos(reviewed,split);
create table public.np_ai_runs(id uuid primary key default gen_random_uuid(),job_id uuid not null,photo_id text not null,signature text not null,status text not null check(status in ('pending','complete','failed','stale')),result jsonb,usage jsonb,created_at timestamptz not null default now(),finished_at timestamptz);
create index np_ai_runs_cache on public.np_ai_runs(job_id,photo_id,signature,created_at desc);
create index np_ai_runs_budget on public.np_ai_runs(created_at);
alter table public.np_reference_photos enable row level security;
alter table public.np_ai_runs enable row level security;
revoke all on public.np_reference_photos,public.np_ai_runs from public,anon,authenticated;
create or replace function public.np_ai_rpc(p_action text,p_data jsonb default '{}') returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.np_reference_photos%rowtype; a public.np_ai_runs%rowtype; j public.np_jobs%rowtype; photo jsonb; photos jsonb; total bigint; item jsonb;
begin
 if p_action='references_list' then
  return coalesce((select jsonb_agg(to_jsonb(t) order by t.path) from (select * from public.np_reference_photos order by path limit 2000) t),'[]');
 elsif p_action='reference_get' then
  select * into strict r from public.np_reference_photos where id=(p_data->>'id')::uuid;return to_jsonb(r);
 elsif p_action='reference_review' then
  select * into strict r from public.np_reference_photos where id=(p_data->>'id')::uuid for update;
  if coalesce((p_data->>'reviewed')::boolean,false) and (not r.image_ready or r.object_path is null or not (p_data->'label'->>'work'<>'') or not (p_data->'label'->>'equipment'<>'')) then raise exception 'REFERENCE_NOT_READY';end if;
  update public.np_reference_photos set label=p_data->'label',reviewed=(p_data->>'reviewed')::boolean,split=p_data->>'split',updated_at=now() where id=r.id returning * into r;
  update public.np_reference_photos set split=r.split,updated_at=now() where archive=r.archive and regexp_replace(path,'[^/]+$','')=regexp_replace(r.path,'[^/]+$','');
  if r.reviewed then
   update public.np_config set payload=jsonb_set(payload,'{workTypes}',(select jsonb_agg(v order by v) from (select distinct jsonb_array_elements_text(payload->'workTypes') as v union select r.label->>'work') t));
  end if;return to_jsonb(r);
 elsif p_action='reference_reserve' then
  perform pg_advisory_xact_lock(883234);
  select * into strict r from public.np_reference_photos where id=(p_data->>'id')::uuid for update;
  if r.object_path is not null then raise exception 'REFERENCE_EXISTS';end if;
  if (select coalesce(sum(image_bytes),0) from public.np_reference_photos)+(p_data->>'bytes')::bigint>104857600 then raise exception 'REFERENCE_STORAGE_LIMIT';end if;
  update public.np_reference_photos set object_path=p_data->>'objectPath',image_bytes=(p_data->>'bytes')::bigint,visual_signature=p_data->'visualSignature',reviewed=false,updated_at=now() where id=r.id returning * into r;return to_jsonb(r);
 elsif p_action='reference_finalize' then
  update public.np_reference_photos set image_ready=true,updated_at=now() where id=(p_data->>'id')::uuid and object_path=p_data->>'objectPath';return '{}';
 elsif p_action='reference_abandon' then
  update public.np_reference_photos set object_path=null,image_ready=false,image_bytes=0,visual_signature=null,reviewed=false where id=(p_data->>'id')::uuid and object_path=p_data->>'objectPath';return '{}';
 elsif p_action='usage' then
  return jsonb_build_object('attempts24h',(select count(*) from public.np_ai_runs where created_at>now()-interval '24 hours'),'complete24h',(select count(*) from public.np_ai_runs where created_at>now()-interval '24 hours' and status='complete'),'inputTokens24h',(select coalesce(sum((usage->>'input_tokens')::bigint),0) from public.np_ai_runs where created_at>now()-interval '24 hours'),'outputTokens24h',(select coalesce(sum((usage->>'output_tokens')::bigint),0) from public.np_ai_runs where created_at>now()-interval '24 hours'));
 elsif p_action='analysis_claim' then
  perform pg_advisory_xact_lock(883235);
  select * into strict j from public.np_jobs where id=(p_data->>'jobId')::uuid for update;
  if j.device_hash<>p_data->>'deviceHash' or j.capability_hash<>p_data->>'capabilityHash' then raise exception 'JOB_ACCESS';end if;
  if j.state<>'uploaded' or j.expires_at<=now() then raise exception 'JOB_EXPIRED';end if;
  if j.revision<>(p_data->>'revision')::bigint then raise exception 'REVISION_CONFLICT';end if;
  if not exists(select 1 from jsonb_array_elements(j.payload->'photos') p where p->>'id'=p_data->>'photoId' and not coalesce((p->>'excluded')::boolean,false)) then raise exception 'JOB_ACCESS';end if;
  select * into a from public.np_ai_runs where job_id=j.id and photo_id=p_data->>'photoId' and signature=p_data->>'signature' and status='complete' order by created_at desc limit 1;
  if found then return jsonb_build_object('cached',true,'run',to_jsonb(a));end if;
  if exists(select 1 from public.np_ai_runs where job_id=j.id and status='pending' and created_at>now()-interval '3 minutes') then raise exception 'AI_BUSY';end if;
  if (select count(*) from public.np_ai_runs where created_at>now()-interval '24 hours')>=least(greatest((p_data->>'limit')::integer,1),200) then raise exception 'AI_DAILY_LIMIT';end if;
  insert into public.np_ai_runs(job_id,photo_id,signature,status) values(j.id,p_data->>'photoId',p_data->>'signature','pending') returning * into a;return jsonb_build_object('cached',false,'run',to_jsonb(a));
 elsif p_action='analysis_fail' then
  update public.np_ai_runs set status='failed',finished_at=now() where id=(p_data->>'runId')::uuid and status='pending';return '{}';
 elsif p_action='analysis_commit' then
  select * into strict a from public.np_ai_runs where id=(p_data->>'runId')::uuid for update;
  select * into strict j from public.np_jobs where id=a.job_id for update;
  if j.device_hash<>p_data->>'deviceHash' or j.capability_hash<>p_data->>'capabilityHash' then raise exception 'JOB_ACCESS';end if;
  if j.revision<>(p_data->>'revision')::bigint or j.state<>'uploaded' or j.expires_at<=now() then
   update public.np_ai_runs set status='stale',result=p_data->'result',usage=p_data->'usage',finished_at=now() where id=a.id;return jsonb_build_object('stale',true);
  end if;
  if a.status not in ('pending','complete') then raise exception 'AI_BUSY';end if;
  update public.np_ai_runs set status='complete',result=p_data->'result',usage=p_data->'usage',finished_at=now() where id=a.id;
  select jsonb_agg(case when p->>'id'=a.photo_id then p||jsonb_build_object('analysisStatus','complete','analysisError','','analysisEquipmentType',case when p->>'equipmentType'<>'' then p->>'equipmentType' else p_data->'result'->>'equipmentType' end,'equipmentType',case when p->>'equipmentType'<>'' then p->>'equipmentType' else p_data->'result'->>'equipmentType' end,'measurementScene',(p_data->'result'->>'measurementScene')::boolean,'recommendation',jsonb_build_object('result',p_data->'result','signature',a.signature,'inputEquipmentType',case when p->'recommendation' is not null and p->>'equipmentType'=p->>'analysisEquipmentType' then coalesce(p->'recommendation'->>'inputEquipmentType','') else coalesce(p->>'equipmentType','') end),'confirmed',false,'ambiguityChoice','','ambiguityGroupId','') else p end) into photos from jsonb_array_elements(j.payload->'photos') p;
  update public.np_jobs set payload=jsonb_set(payload,'{photos}',photos),revision=revision+1,updated_at=now(),expires_at=now()+interval '24 hours' where id=j.id;return '{}';
 end if;
 raise exception 'UNKNOWN_ACTION';
end;$$;
revoke all on function public.np_ai_rpc(text,jsonb) from public,anon,authenticated;
grant execute on function public.np_ai_rpc(text,jsonb) to service_role;
commit;
