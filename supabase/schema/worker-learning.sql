alter table public.np_reference_photos add column if not exists origin text not null default 'reference';
alter table public.np_reference_photos add column if not exists worker_confirmed boolean not null default false;
alter table public.np_reference_photos add column if not exists worker_blocked boolean not null default false;
create table if not exists public.np_learning_feedback(
 job_id uuid not null,photo_id text not null,original_hash text not null,label jsonb not null,ai_result jsonb,
 confirmed boolean not null,signature text not null,reference_id uuid references public.np_reference_photos(id),captured_signature text,
 note text not null default '',updated_at timestamptz not null default now(),primary key(job_id,photo_id));
alter table public.np_learning_feedback enable row level security;
revoke all on public.np_learning_feedback from public,anon,authenticated;
create index if not exists np_learning_feedback_hash on public.np_learning_feedback(original_hash);
create or replace function public.np_record_learning() returns trigger language plpgsql set search_path=public,pg_temp as $$
declare p jsonb; l jsonb; sig text; valid boolean; prior public.np_learning_feedback%rowtype;
begin
 for p in select value from jsonb_array_elements(new.payload->'photos') loop
  select * into prior from public.np_learning_feedback where job_id=new.id and photo_id=p->>'id';
  valid:=coalesce((p->>'confirmed')::boolean,false) and not coalesce((p->>'excluded')::boolean,false);
  if not valid and not found then continue;end if;
  if coalesce(p->>'hash','')!~'^[a-f0-9]{64}$' then continue;end if;
  l:=jsonb_build_object('project',new.payload->>'project','date',p->>'date','location',p->>'location','equipment',p->>'equipment','work',p->>'work','equipmentType',coalesce(p->>'equipmentType',''));
  sig:=md5(l::text||coalesce(p->>'rotation','0'));
  if prior.reference_id is not null and (not valid or prior.signature<>sig) then
   update public.np_reference_photos set worker_confirmed=false,updated_at=now() where id=prior.reference_id and origin='worker';
  end if;
  insert into public.np_learning_feedback(job_id,photo_id,original_hash,label,ai_result,confirmed,signature)
   values(new.id,p->>'id',p->>'hash',l,p->'recommendation'->'result',valid,sig)
   on conflict(job_id,photo_id) do update set original_hash=excluded.original_hash,label=excluded.label,ai_result=excluded.ai_result,confirmed=excluded.confirmed,signature=excluded.signature,updated_at=now()
   where np_learning_feedback.signature<>excluded.signature or np_learning_feedback.confirmed<>excluded.confirmed or np_learning_feedback.ai_result is distinct from excluded.ai_result;
 end loop;return new;
end;$$;
revoke all on function public.np_record_learning() from public,anon,authenticated;
drop trigger if exists np_jobs_learning on public.np_jobs;
create trigger np_jobs_learning after insert or update of payload on public.np_jobs for each row execute function public.np_record_learning();
create or replace function public.np_learning_rpc(p_action text,p_data jsonb default '{}') returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare f public.np_learning_feedback%rowtype;r public.np_reference_photos%rowtype; j public.np_jobs%rowtype; l jsonb; target uuid;
begin
 if p_action='summary' then
  return jsonb_build_object('confirmations',(select count(*) from public.np_learning_feedback where confirmed),'differentFirst',(select count(*) from public.np_learning_feedback where confirmed and ai_result is not null and regexp_replace(coalesce(ai_result->'candidates'->0->>'work',''),'\s','','g')<>regexp_replace(label->>'work','\s','','g')),'activeWorkerImages',(select count(*) from public.np_reference_photos where origin='worker' and image_ready and (reviewed or worker_confirmed)));
 elsif p_action='status' then
  return coalesce((select jsonb_agg(jsonb_build_object('photoId',fb.photo_id,'signature',fb.signature,'ready',fb.captured_signature=fb.signature and rr.image_ready and (rr.origin<>'worker' or rr.reviewed or rr.worker_confirmed or rr.worker_blocked or fb.note like '새 작업명%'),'note',fb.note)) from public.np_learning_feedback fb left join public.np_reference_photos rr on rr.id=fb.reference_id where fb.job_id=(p_data->>'jobId')::uuid and fb.confirmed),'[]');
 elsif p_action='candidates' then
  return coalesce((select jsonb_agg(to_jsonb(t)) from (select id,original_hash,path,label,origin,reviewed,worker_confirmed,image_ready,object_path,visual_signature,split,updated_at from public.np_reference_photos where image_ready and split='train' and (reviewed or worker_confirmed) order by reviewed desc,updated_at desc limit 5000)t),'[]');
 elsif p_action='claim' then
  perform pg_advisory_xact_lock(883234);
  select * into strict f from public.np_learning_feedback where job_id=(p_data->>'jobId')::uuid and photo_id=p_data->>'photoId' for update;
  if not f.confirmed or f.signature<>p_data->>'signature' then raise exception 'REVISION_CONFLICT';end if;
  select * into strict j from public.np_jobs where id=f.job_id;
  if j.expires_at<=now() or j.state='deleting' then raise exception 'JOB_EXPIRED';end if;
  l:=jsonb_set(f.label,'{work}',to_jsonb(p_data->>'standardWork'));
  select * into r from public.np_reference_photos where original_hash=f.original_hash for update;
  if found and r.origin='reference' and not r.reviewed and r.split='train' and not r.worker_blocked then
   update public.np_reference_photos set origin='worker',label=l,worker_confirmed=coalesce((p_data->>'eligible')::boolean,false),ocr_raw=ocr_raw||jsonb_build_object('priorDraftLabel',label,'workerConfirmedFrom',f.job_id),updated_at=now() where id=r.id returning * into r;
  end if;
  if found and r.image_ready then
   if r.origin='worker' and not r.reviewed and r.label->>'work'<>l->>'work' and exists(select 1 from public.np_learning_feedback other where other.original_hash=f.original_hash and other.confirmed and (other.job_id<>f.job_id or other.photo_id<>f.photo_id) and regexp_replace(other.label->>'work','\s','','g')<>regexp_replace(l->>'work','\s','','g')) then
    update public.np_reference_photos set worker_confirmed=false,worker_blocked=true,updated_at=now() where id=r.id;
    update public.np_learning_feedback set reference_id=r.id,captured_signature=f.signature,note='작업명 충돌 · 관리자 검수 필요' where job_id=f.job_id and photo_id=f.photo_id;
   else
    if r.origin='worker' and not r.reviewed and not r.worker_blocked then update public.np_reference_photos set label=l,worker_confirmed=coalesce((p_data->>'eligible')::boolean,false),updated_at=now() where id=r.id;end if;
    update public.np_learning_feedback set reference_id=r.id,captured_signature=f.signature,note=case when not coalesce((p_data->>'eligible')::boolean,false) then '새 작업명 · 관리자 표준 작업 검수 필요' when (r.reviewed or r.origin='reference') and r.label->>'work'<>l->>'work' then '기존 참고 작업명과 다름 · 관리자 확인 필요' else '' end where job_id=f.job_id and photo_id=f.photo_id;
   end if;
   return jsonb_build_object('cached',true,'reference',to_jsonb(r));
  end if;
  if found and r.origin<>'worker' then
   return jsonb_build_object('cached',true,'note','기존 참고 자료의 이미지 연결이 필요합니다.');
  end if;
  if coalesce((p_data->>'bytes')::bigint,0) not between 1 and 262144 then raise exception 'REFERENCE_STORAGE_LIMIT';end if;
  if (select coalesce(sum(image_bytes),0) from public.np_reference_photos)-coalesce(r.image_bytes,0)+(p_data->>'bytes')::bigint>268435456 then raise exception 'REFERENCE_STORAGE_LIMIT';end if;
  if r.id is null then
   insert into public.np_reference_photos(original_hash,path,archive,label,origin,ocr_raw) values(f.original_hash,p_data->>'path','worker:'||f.job_id,l,'worker',jsonb_build_object('source','worker-confirmed','originalWork',f.label->>'work')) returning * into r;
  end if;
  update public.np_reference_photos set label=l,object_path=coalesce(object_path,id::text||'/'||gen_random_uuid()::text||'.jpg'),image_bytes=(p_data->>'bytes')::bigint,visual_signature=p_data->'visualSignature',worker_confirmed=false,updated_at=now() where id=r.id returning * into r;
  update public.np_learning_feedback set reference_id=r.id where job_id=f.job_id and photo_id=f.photo_id;
  return jsonb_build_object('cached',false,'reference',to_jsonb(r));
 elsif p_action='commit' then
  select * into strict f from public.np_learning_feedback where job_id=(p_data->>'jobId')::uuid and photo_id=p_data->>'photoId' for update;
  if not f.confirmed or f.signature<>p_data->>'signature' then raise exception 'REVISION_CONFLICT';end if;
  update public.np_reference_photos set image_ready=true,worker_confirmed=coalesce((p_data->>'eligible')::boolean,false) and not worker_blocked,updated_at=now() where id=f.reference_id and object_path=p_data->>'objectPath' and origin='worker';
  if not found then raise exception 'REVISION_CONFLICT';end if;
  update public.np_learning_feedback set captured_signature=signature,note=case when coalesce((p_data->>'eligible')::boolean,false) then '' else '새 작업명 · 관리자 표준 작업 검수 필요' end where job_id=f.job_id and photo_id=f.photo_id;
  return '{}';
 elsif p_action='abandon' then
  update public.np_reference_photos set object_path=null,image_bytes=0,visual_signature=null where origin='worker' and id=(p_data->>'referenceId')::uuid and object_path=p_data->>'objectPath' and not image_ready;return jsonb_build_object('abandoned',found);
 end if;raise exception 'UNKNOWN_ACTION';
end;$$;
revoke all on function public.np_learning_rpc(text,jsonb) from public,anon,authenticated;
grant execute on function public.np_learning_rpc(text,jsonb) to service_role;
-- Existing reference quota is expanded consistently; admin edits replace automatic trust.
do $patch$ declare definition text;begin
 definition:=pg_get_functiondef('public.np_ai_rpc(text,jsonb)'::regprocedure);
 definition:=replace(definition,'>104857600','>268435456');
 definition:=replace(definition,'set label=p_data->''label'',reviewed=', 'set label=p_data->''label'',worker_confirmed=false,worker_blocked=not coalesce((p_data->>''reviewed'')::boolean,false),reviewed=');
 definition:=replace(definition,'order by path limit 2000','order by path limit 5000');
 execute definition;
end $patch$;
-- Capture existing confirmations without exporting any photos or changing revisions.
update public.np_jobs set payload=payload where exists(select 1 from jsonb_array_elements(payload->'photos') p where coalesce((p->>'confirmed')::boolean,false));
