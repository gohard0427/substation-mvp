begin;
create or replace function public.np_work_key(v text) returns text language sql immutable security invoker set search_path=public,pg_temp as $$
 select case regexp_replace(lower(coalesce(v,'')),'\s','','g') when '단자대점검' then '단자점검' when '캐패시터전압측정' then '콘덴서전압측정' when '스크로크측정' then '스트로크측정' else regexp_replace(lower(coalesce(v,'')),'\s','','g') end;
$$;
revoke all on function public.np_work_key(text) from public,anon,authenticated;
grant execute on function public.np_work_key(text) to service_role;
do $patch$
declare definition text;
begin
 definition:=pg_get_functiondef('public.np_learning_rpc(text,jsonb)'::regprocedure);
 definition:=replace(definition,'regexp_replace(other.label->>''work'',''\s'','''',''g'')<>regexp_replace(l->>''work'',''\s'','''',''g'')','public.np_work_key(other.label->>''work'')<>public.np_work_key(l->>''work'')');
 if position('np_work_key(other.label' in definition)=0 then raise exception 'WORK_KEY_PATCH_MISSING';end if;
 execute definition;
end $patch$;
with names as(select value,ordinality as ord,public.np_work_key(value) as k from public.np_config,jsonb_array_elements_text(payload->'workTypes') with ordinality), canonical as(select distinct on(k) case k when '단자점검' then '단자 점검' when '콘덴서전압측정' then '콘덴서 전압 측정' when '스트로크측정' then '스트로크 측정' else value end as work,ord from names order by k,ord)
update public.np_config set payload=jsonb_set(payload||'{"autoLearnConfirmed":true}'::jsonb,'{workTypes}',(select jsonb_agg(work order by ord) from canonical)) where singleton;
update public.np_reference_photos r set worker_confirmed=true,updated_at=now()
where origin='worker' and not worker_confirmed and not worker_blocked and not reviewed and split='train' and image_ready and coalesce(ocr_raw->'workAudit'->>'blocked','false')<>'true'
and exists(select 1 from public.np_learning_feedback f where f.reference_id=r.id and f.confirmed and f.captured_signature=f.signature and public.np_work_key(f.label->>'work')=public.np_work_key(r.label->>'work'))
and not exists(select 1 from public.np_learning_feedback f where f.original_hash=r.original_hash and f.confirmed and public.np_work_key(f.label->>'work')<>public.np_work_key(r.label->>'work'));
commit;
