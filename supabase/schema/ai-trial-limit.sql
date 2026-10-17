-- Existing installations: apply after ai-reference.sql. Keeps existing grants and data.
-- Lifetime attempts are serialized by the existing advisory lock; cache hits do not count.
do $patch$
declare definition text;
begin
 select pg_get_functiondef('public.np_ai_rpc(text,jsonb)'::regprocedure) into definition;
 if position('AI_TOTAL_LIMIT' in definition)=0 then
  definition:=replace(definition,
   '  insert into public.np_ai_runs(job_id,photo_id,signature,status)',
   E'  if (select count(*) from public.np_ai_runs)>=least(greatest(coalesce((p_data->>''totalLimit'')::integer,100),1),100) then raise exception ''AI_TOTAL_LIMIT'';end if;\n  insert into public.np_ai_runs(job_id,photo_id,signature,status)');
  if position('AI_TOTAL_LIMIT' in definition)=0 then raise exception 'AI_TRIAL_PATCH_TARGET_MISSING';end if;
  execute definition;
 end if;
 if position('totalAttempts' in definition)=0 then
 definition:=replace(definition,'''attempts24h'',',
  '''totalAttempts'',(select count(*) from public.np_ai_runs),''attempts24h'',');
 if position('totalAttempts' in definition)=0 then raise exception 'AI_USAGE_PATCH_TARGET_MISSING';end if;
 execute definition;
 end if;
end;$patch$;
revoke all on function public.np_ai_rpc(text,jsonb) from public,anon,authenticated;
grant execute on function public.np_ai_rpc(text,jsonb) to service_role;
