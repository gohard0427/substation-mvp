-- One-time, explicit expansion from worker-confirmed company terms.
-- Never promote evaluation, excluded/conflicting references or stale captures.
begin;
with requested(work) as (select unnest(array['케이블 입상','판넬 대체 전','판넬 대체 완료','판넬 철거','새 판넬 안치','축전지 전압 측정','설치 대상 축전지','축전지 설치 완료','보호계전기 교체 전','보호계전기 교체 완료','보호장치 절연저항 측정','신유 주유','케이블 분리','공기 누기량 측정','호흡기 오일 교체']::text[])), additions as (
 select coalesce(jsonb_agg(work order by work),'[]'::jsonb) items from requested where exists(select 1 from public.np_learning_feedback f where f.confirmed and regexp_replace(f.label->>'work','\s','','g')=regexp_replace(work,'\s','','g')) and not exists(select 1 from public.np_config c,jsonb_array_elements_text(c.payload->'workTypes') w where regexp_replace(w,'\s','','g')=regexp_replace(work,'\s','','g'))
)
update public.np_config set payload=jsonb_set(payload,'{workTypes}',(payload->'workTypes')||additions.items) from additions where singleton;
update public.np_reference_photos r set worker_confirmed=true,updated_at=now()
where r.origin='worker' and not r.reviewed and not r.worker_confirmed and not r.worker_blocked and r.split='train' and r.image_ready and coalesce(r.ocr_raw->'workAudit'->>'blocked','false')<>'true'
and exists(select 1 from public.np_config c,jsonb_array_elements_text(c.payload->'workTypes') w where regexp_replace(w,'\s','','g')=regexp_replace(r.label->>'work','\s','','g') or (regexp_replace(w,'\s','','g')='캐패시터전압측정' and regexp_replace(r.label->>'work','\s','','g')='콘덴서전압측정'))
and exists(select 1 from public.np_learning_feedback f where f.reference_id=r.id and f.confirmed and f.captured_signature=f.signature and regexp_replace(f.label->>'work','\s','','g')=regexp_replace(r.label->>'work','\s','','g'))
and not exists(select 1 from public.np_learning_feedback f where f.original_hash=r.original_hash and f.confirmed and regexp_replace(f.label->>'work','\s','','g')<>regexp_replace(r.label->>'work','\s','','g'));
commit;
