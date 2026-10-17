-- Replace YOUR_PROJECT_REF with the dedicated project ref before running.
-- No key is pasted into this script or returned to the caller.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
do $$
declare token text;
begin
 if not exists(select 1 from vault.secrets where name='np_cleanup_token_v1') then
  token=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
  perform vault.create_secret(token,'np_cleanup_token_v1');
 else select decrypted_secret into token from vault.decrypted_secrets where name='np_cleanup_token_v1';end if;
 insert into public.np_maintenance(singleton,token_hash) values(true,encode(sha256(convert_to(token,'UTF8')),'hex')) on conflict(singleton) do update set token_hash=excluded.token_hash;
 if not exists(select 1 from vault.secrets where name='np_project_url') then
  perform vault.create_secret('https://YOUR_PROJECT_REF.supabase.co','np_project_url');
 end if;
end;$$;
select cron.unschedule(jobid) from cron.job where jobname='np-delete-expired-photos';
select cron.schedule('np-delete-expired-photos','*/15 * * * *',$$
 select net.http_post(
  url:=(select decrypted_secret from vault.decrypted_secrets where name='np_project_url')||'/functions/v1/np-cleanup',
  headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='np_cleanup_token_v1')),
  body:='{}'::jsonb,timeout_milliseconds:=60000
 );
$$);
