-- Run after deploying np-cleanup. Store np_project_url and np_service_role_key
-- in Supabase Vault via its dashboard first. Never paste real keys into GitHub.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
select cron.unschedule(jobid) from cron.job where jobname='np-delete-expired-photos';
select cron.schedule('np-delete-expired-photos','*/15 * * * *',$$
 select net.http_post(
  url:=(select decrypted_secret from vault.decrypted_secrets where name='np_project_url')||'/functions/v1/np-cleanup',
  headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='np_service_role_key')),
  body:='{}'::jsonb, timeout_milliseconds:=60000
 );
$$);
