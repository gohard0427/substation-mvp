import {test} from 'node:test';import assert from 'node:assert/strict';
import {backend} from './helpers/free-backend.mjs';import {SupabaseClient} from '../cloudflare/supabase-client.mjs';
import {maintenanceHandler} from '../supabase/functions/_shared/maintenance.mjs';import {hash,DEFAULT_PROJECT} from '../shared/free-model.mjs';
const b=await backend(),client=new SupabaseClient(b.env,b.fetcher),token='1'.repeat(64);await b.db.query('insert into np_maintenance(token_hash) values($1)',[await hash(token)]);test.after(()=>b.db.close());
const req=(body={},credential=token)=>new Request('https://test/functions/v1/np-cleanup',{method:'POST',headers:{Authorization:'Bearer '+credential},body:JSON.stringify(body)});
test('cleanup requires dedicated credential and private RPC is inaccessible to users',async()=>{
 assert.equal((await maintenanceHandler(req({},'2'.repeat(64)),client)).status,403);
 await b.db.exec('set role anon');try{await assert.rejects(b.db.query("select np_maintenance_rpc('status','{}')"),/permission denied/);}finally{await b.db.exec('reset role');}
});
test('expired probe bytes, file reservation and job are removed in order',async()=>{
 const response=await maintenanceHandler(req({selfTest:true}),client,new Uint8Array([255,216,255,217]));assert.equal(response.status,200,await response.clone().text());const result=await response.json();assert.deepEqual(result.selfTest,{jobGone:true,fileGone:true,objectGone:true});assert.equal(b.objects.size,0);assert.equal((await b.maintenanceRpc('status')).runs,1);
});
test('cleanup failure retains file reservation and is retryable',async()=>{
 const p=await b.maintenanceRpc('probe_prepare',{bytes:4});b.objects.set(p.path,new Uint8Array(4));const failed=new SupabaseClient(b.env,(url,o)=>o.method==='DELETE'?Promise.resolve(new Response(null,{status:503})):b.fetcher(url,o));assert.equal((await maintenanceHandler(req(),failed)).status,503);assert.equal((await b.db.query('select count(*)::integer as n from np_files where id=$1',[p.fileId])).rows[0].n,1);assert.ok(b.objects.has(p.path));assert.equal((await maintenanceHandler(req(),client)).status,200);assert.equal(b.objects.size,0);
});
test('logout revokes only session and retains device recovery permission',async()=>{
 const c=b.client();await c.login();const job=await(await c.request('/api/jobs',{})).json();const device=c.cookie.split('; ').find(v=>v.startsWith('np_device='));assert.equal((await c.request('/api/logout',{})).status,200);assert.equal((await c.request('/api/settings')).status,401);await c.login();assert.ok(c.cookie.includes(device));assert.equal((await c.request('/api/jobs/'+job.id)).status,200);
});
test('fixed default and per-job alternative projects do not overwrite one another',async()=>{
 const admin=b.client(),worker=b.client();await admin.login('admin');await worker.login();const saved=await admin.request('/api/settings',{extraProjects:['별도 점검공사']});assert.equal(saved.status,200);const cfg=await(await worker.request('/api/settings')).json();assert.equal(cfg.project,DEFAULT_PROJECT);assert.deepEqual(cfg.projects,[DEFAULT_PROJECT,'별도 점검공사']);let job=await(await worker.request('/api/jobs',{})).json();assert.equal(job.project,DEFAULT_PROJECT);job=await(await worker.request('/api/jobs/'+job.id+'/save',{revision:job.revision,photos:[],project:'별도 점검공사'})).json();assert.equal(job.project,'별도 점검공사');assert.equal((await b.rpc('config_get')).project,DEFAULT_PROJECT);assert.equal((await worker.request('/api/maintenance')).status,403);assert.equal((await admin.request('/api/maintenance')).status,200);
});

test('explicit recovery refreshes activity, but cannot revive an expired job',async()=>{
 const c=b.client();await c.login();const job=await(await c.request('/api/jobs',{})).json();await b.db.query("update np_jobs set expires_at=now()+interval '1 minute' where id=$1",[job.id]);const recovered=await c.request('/api/jobs/'+job.id+'?touch=1');assert.equal(recovered.status,200);const expiry=(await b.db.query("select expires_at>now()+interval '23 hours' as extended from np_jobs where id=$1",[job.id])).rows[0].extended;assert.equal(expiry,true);await b.db.query("update np_jobs set expires_at=now()-interval '1 minute' where id=$1",[job.id]);assert.equal((await c.request('/api/jobs/'+job.id+'?touch=1')).status,410);
});
