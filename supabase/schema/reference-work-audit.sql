begin;
-- Source-nameplate work audit is distinct from full administrator review.
create or replace function public.np_reference_work_usable(r jsonb) returns boolean language sql immutable security invoker set search_path=public,pg_temp as $$
 select not coalesce((r->>'worker_blocked')::boolean,false)
 and not coalesce((r->'ocr_raw'->'workAudit'->>'blocked')::boolean,false)
 and (coalesce((r->>'reviewed')::boolean,false) or coalesce((r->>'worker_confirmed')::boolean,false)
 or (r->>'origin'='reference' and r->'ocr_raw'->'workAudit'->>'version'='reference-work-audit-20261020-v1'
 and coalesce((r->'ocr_raw'->'workAudit'->>'workVerified')::boolean,false)
 and regexp_replace(r->'label'->>'work','\s','','g')=regexp_replace(r->'ocr_raw'->'workAudit'->>'canonicalWork','\s','','g')));
$$;
revoke all on function public.np_reference_work_usable(jsonb) from public,anon,authenticated;
grant execute on function public.np_reference_work_usable(jsonb) to service_role;
create or replace function public.np_apply_reference_work_audit(p_rows jsonb) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare x jsonb; r public.np_reference_photos%rowtype; a jsonb; n integer:=0; changed integer:=0; skipped integer:=0; accept boolean;
begin
 if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>200 then raise exception 'AUDIT_ROWS_INVALID';end if;
 for x in select value from jsonb_array_elements(p_rows) loop
  if coalesce(x->>'hash','') !~ '^[a-f0-9]{64}$' or length(coalesce(x->>'work',''))>150 or length(coalesce(x->>'reason',''))>800 then raise exception 'AUDIT_ROW_INVALID';end if;
  select * into r from public.np_reference_photos where original_hash=x->>'hash' for update;
  if not found or r.origin<>'reference' then skipped:=skipped+1;continue;end if;
  -- Never overwrite reviewed labels, worker labels, or an explicit admin exclusion.
  accept:=not r.reviewed and not r.worker_blocked and (regexp_replace(coalesce(r.label->>'work',''),'\s','','g')=regexp_replace(coalesce(x->>'expectedWork',''),'\s','','g') or regexp_replace(coalesce(r.label->>'work',''),'\s','','g')=regexp_replace(coalesce(x->>'work',''),'\s','','g'));
  a:=jsonb_build_object('version','reference-work-audit-20261020-v1','workVerified',coalesce((x->>'verified')::boolean,false) and (accept or regexp_replace(coalesce(r.label->>'work',''),'\s','','g')=regexp_replace(coalesce(x->>'work',''),'\s','','g')),'blocked',coalesce((x->>'blocked')::boolean,false),'canonicalWork',x->>'work','reason',x->>'reason','sourceWork',x->>'sourceWork');
  if coalesce((r.ocr_raw->'workAudit'->>'adminOverride')::boolean,false) then skipped:=skipped+1;continue;end if;
  if accept and coalesce((x->>'verified')::boolean,false) and not coalesce((x->>'blocked')::boolean,false) and coalesce(x->>'work','')<>'' then
   update public.np_reference_photos set label=jsonb_set(label,'{work}',x->'work'),ocr_raw=ocr_raw||jsonb_build_object('preWorkAuditLabel',coalesce(ocr_raw->'preWorkAuditLabel',label),'workAudit',a),updated_at=now() where id=r.id and (label->>'work' is distinct from x->>'work' or ocr_raw->'workAudit' is distinct from a);
   if found and r.label->>'work' is distinct from x->>'work' then changed:=changed+1;end if;
  else
   update public.np_reference_photos set ocr_raw=ocr_raw||jsonb_build_object('preWorkAuditLabel',coalesce(ocr_raw->'preWorkAuditLabel',label),'workAudit',a),updated_at=now() where id=r.id and ocr_raw->'workAudit' is distinct from a;
  end if;n:=n+1;
 end loop;
 -- Add only usable reference works; preserve existing standards and project settings.
 update public.np_config set payload=jsonb_set(payload,'{workTypes}',(select jsonb_agg(w order by w) from (select distinct jsonb_array_elements_text(payload->'workTypes') w union select label->>'work' from public.np_reference_photos q where image_ready and split='train' and public.np_reference_work_usable(to_jsonb(q)) and length(label->>'work')>0)t));
 return jsonb_build_object('matched',n,'labelUpdates',changed,'skipped',skipped);
end;$$;
revoke all on function public.np_apply_reference_work_audit(jsonb) from public,anon,authenticated;
grant execute on function public.np_apply_reference_work_audit(jsonb) to service_role;
do $patch$ declare d text;old text;new text;begin
 d:=pg_get_functiondef('public.np_learning_rpc(text,jsonb)'::regprocedure);
 old:='select id,original_hash,path,label,origin,reviewed,worker_confirmed,image_ready,object_path,visual_signature,split,updated_at from public.np_reference_photos where image_ready and split=''train'' and (reviewed or worker_confirmed)';
 new:='select id,original_hash,path,label,origin,reviewed,worker_confirmed,worker_blocked,image_ready,object_path,visual_signature,split,updated_at,ocr_raw->''workAudit'' as work_audit from public.np_reference_photos q where image_ready and split=''train'' and public.np_reference_work_usable(to_jsonb(q))';
 if position(old in d)>0 then execute replace(d,old,new);elsif position('np_reference_work_usable' in d)=0 then raise exception 'AUDIT_CANDIDATE_PATCH_MISSING';end if;
 d:=pg_get_functiondef('public.np_ai_rpc(text,jsonb)'::regprocedure);
 -- A later explicit administrator review can revalidate an audit-blocked case.
 old:='set label=p_data->''label'',worker_confirmed=false,';
 new:='set label=p_data->''label'',ocr_raw=case when coalesce((p_data->>''reviewed'')::boolean,false) and ocr_raw ? ''workAudit'' then jsonb_set(ocr_raw,''{workAudit}'',ocr_raw->''workAudit''||''{"blocked":false,"adminOverride":true}''::jsonb) else ocr_raw end,worker_confirmed=false,';
 if position(old in d)>0 then d:=replace(d,old,new);elsif position('adminOverride' in d)=0 then raise exception 'AUDIT_ADMIN_PATCH_MISSING';end if;
 if position('analysis_checkpoint' in d)=0 then
  d:=replace(d,' if p_action=''references_list'' then',E' if p_action=''analysis_checkpoint'' then\n  update public.np_ai_runs set usage=p_data->''usage'',result=p_data->''result'' where id=(p_data->>''runId'')::uuid and status=''pending'';return ''{}'';\n elsif p_action=''references_list'' then');
  if position('analysis_checkpoint' in d)=0 then raise exception 'AUDIT_CHECKPOINT_PATCH_MISSING';end if;
 end if;
 if position('providerCalls24h' in d)=0 then d:=replace(d,'''attempts24h'',','''providerCalls24h'',(select coalesce(sum(coalesce((usage->>''api_calls'')::bigint,1)),0) from public.np_ai_runs where created_at>now()-interval ''24 hours''),''attempts24h'',');end if;
 execute d;
end $patch$;
commit;
