-- Server-only, least-privilege scheduler credential. Raw token remains in Vault.
begin;
create table public.np_maintenance(singleton boolean primary key default true check(singleton),token_hash text not null check(token_hash ~ '^[a-f0-9]{64}$'),last_success_at timestamptz,last_removed integer not null default 0,runs bigint not null default 0);
alter table public.np_maintenance enable row level security;
revoke all on public.np_maintenance from public,anon,authenticated;
create or replace function public.np_maintenance_rpc(p_action text,p_data jsonb default '{}') returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare jid uuid;fid uuid;pid text;object_path text;
begin
 if p_action='authorize' then
  return jsonb_build_object('authorized',exists(select 1 from public.np_maintenance where singleton and token_hash=p_data->>'tokenHash'));
 elsif p_action='status' then
  return coalesce((select jsonb_build_object('lastSuccessAt',last_success_at,'lastRemoved',last_removed,'runs',runs) from public.np_maintenance where singleton),'{}');
 elsif p_action='complete' then
  update public.np_maintenance set last_success_at=now(),last_removed=(p_data->>'removed')::integer,runs=runs+1 where singleton;return '{}';
 elsif p_action='probe_prepare' then
  jid=gen_random_uuid();fid=gen_random_uuid();pid=replace(gen_random_uuid()::text,'-','');pid=substr(pid,1,24);object_path=jid::text||'/maintenance-probe/'||fid::text||'.jpg';
  insert into public.np_jobs(id,device_hash,capability_hash,expires_at,payload) values(jid,repeat('0',64),repeat('0',64),now()-interval '1 minute',jsonb_build_object('photos',jsonb_build_array(jsonb_build_object('id',pid,'path','__maintenance_probe__.jpg')),'warnings','[]'::jsonb,'maintenanceProbe',true));
  insert into public.np_files(id,job_id,photo_id,kind,object_path,bytes,status) values(fid,jid,pid,'source',object_path,(p_data->>'bytes')::bigint,'ready');
  return jsonb_build_object('jobId',jid,'fileId',fid,'path',object_path);
 elsif p_action='probe_status' then
  return jsonb_build_object('jobGone',not exists(select 1 from public.np_jobs where id=(p_data->>'jobId')::uuid),'fileGone',not exists(select 1 from public.np_files where id=(p_data->>'fileId')::uuid));
 end if;
 raise exception 'UNKNOWN_ACTION';
end;$$;
revoke all on function public.np_maintenance_rpc(text,jsonb) from public,anon,authenticated;
grant execute on function public.np_maintenance_rpc(text,jsonb) to service_role;
commit;
