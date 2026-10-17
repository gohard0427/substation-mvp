-- Idempotent upgrade for installations created before the audit fixes.
do $patch$
declare definition text;
begin
 definition=pg_get_functiondef('public.np_rpc(text,jsonb)'::regprocedure);
 if position('session_delete' in definition)=0 then
  definition=replace(definition,$old$ elsif p_action='session_get' then$old$,$new$ elsif p_action='session_delete' then
  delete from public.np_sessions where token_hash=p_data->>'tokenHash';return '{}';
 elsif p_action='session_get' then$new$);
 end if;
 if position('job_touch' in definition)=0 then
  definition=replace(definition,$old$ elsif p_action='job_save' then$old$,$new$ elsif p_action='job_touch' then
  update public.np_jobs set updated_at=now(),expires_at=now()+interval '24 hours' where id=jid;
 elsif p_action='job_save' then$new$);
 end if;
 definition=replace(definition,$old$insert into public.np_jobs(id,device_hash,capability_hash) values((p_data->>'id')::uuid,p_data->>'deviceHash',p_data->>'capabilityHash');$old$,$new$insert into public.np_jobs(id,device_hash,capability_hash,payload) values((p_data->>'id')::uuid,p_data->>'deviceHash',p_data->>'capabilityHash',jsonb_build_object('photos','[]'::jsonb,'warnings','[]'::jsonb,'project',cfg->>'project'));$new$);
 execute definition;
end;$patch$;
select public.np_rpc('config_set','{"project":"2026~2026년도 시흥전력지사 변전협력회사 총액공사"}'::jsonb);
