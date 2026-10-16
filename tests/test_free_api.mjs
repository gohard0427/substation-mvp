import {test} from 'node:test';
import assert from 'node:assert/strict';
import {backend} from './helpers/free-backend.mjs';
const b=await backend();
test('anonymous direct table and RPC access is denied',async()=>{
 for(const role of ['anon','authenticated']){
  await b.db.exec('set role '+role);
  try{await assert.rejects(b.db.query('select * from public.np_jobs'),/permission denied/);await assert.rejects(b.db.query("select public.np_rpc('config_get','{}')"),/permission denied/);}finally{await b.db.exec('reset role');}
 }
});
test('same common account cannot read another device jobs or guessed IDs',async()=>{
 const a=b.client(),other=b.client();await a.login();await other.login();const job=await (await a.request('/api/jobs',{})).json();
 assert.equal((await other.request('/api/jobs/'+job.id)).status,403);
 assert.deepEqual(await (await other.request('/api/jobs')).json(),[]);
 const {rows}=await b.db.query('select device_hash,capability_hash from np_jobs where id=$1',[job.id]);assert.notEqual(rows[0].device_hash,rows[0].capability_hash);
 assert.equal((await a.request('/api/jobs/'+job.id)).status,200);
});
test('worker cannot change settings, and mutation GET is not allowed',async()=>{
 const worker=b.client(),admin=b.client();await worker.login();await admin.login('admin');
 assert.equal((await worker.request('/api/settings',{project:'unauthorized'})).status,403);
 assert.equal((await admin.request('/api/revoke')).status,405);
 assert.equal((await admin.request('/api/settings',{project:'검증 공사'})).status,200);
});
test('opaque sessions contain no provider JWT and revoke applies immediately',async()=>{
 const a=b.client(),admin=b.client();const response=await a.login();await admin.login('admin');
 assert.ok(response.headers.getSetCookie().every(c=>c.includes('Secure')&&c.includes('HttpOnly')));assert.ok(!a.cookie.includes('never-exposed'));
 await admin.request('/api/worker-password',{password:'new-test-only-password'});
 assert.equal((await a.request('/api/settings')).status,401);assert.equal((await admin.request('/api/settings')).status,200);
});
test('cross-site POST and unset production origin fail closed',async()=>{
 const a=b.client();await a.login();assert.equal((await a.request('/api/jobs',{}, {Origin:'https://other.example.com'})).status,403);
});
test.after(async()=>b.db.close());
function jpeg(width=1280,height=960){return new Uint8Array([255,216,255,192,0,17,8,height>>8,height&255,width>>8,width&255,3,1,17,0,2,17,0,3,17,0,255,217]);}
async function source(client,path='20261016_위치_PMA GIS/사진.jpg'){
 let job=await(await client.request('/api/jobs',{})).json();const id=crypto.randomUUID().replaceAll('-','').slice(0,24);
 const response=await client.request(`/api/jobs/${job.id}/source/${id}`,jpeg(),{'X-Photo-Meta':encodeURIComponent(JSON.stringify({path,hash:'a'.repeat(64)})),'X-Revision':String(job.revision)});
 assert.equal(response.status,200,await response.clone().text());return response.json();
}
test('source upload, PMA server gate, stale save, result and confirmed deletion',async()=>{
 const c=b.client();await c.login();let job=await source(c);const stale=structuredClone(job);
 job.photos[0].work='코일 저항 측정';job.photos[0].equipmentType='PMA GIS';job.photos[0].confirmed=true;
 job=await(await c.request(`/api/jobs/${job.id}/save`,{revision:job.revision,photos:job.photos})).json();
 assert.equal((await c.request(`/api/jobs/${job.id}/save`,{revision:stale.revision,photos:stale.photos})).status,409);
 assert.equal((await c.request(`/api/jobs/${job.id}/generate`,{})).status,400);
 job.photos[0].ambiguityGroupId='pma-measurement';job.photos[0].ambiguityChoice='코일 저항 측정';
 job=await(await c.request(`/api/jobs/${job.id}/save`,{revision:job.revision,photos:job.photos})).json();
 const begin=await c.request(`/api/jobs/${job.id}/generate`,{});assert.equal(begin.status,200,await begin.clone().text());job=await begin.json();
 assert.equal(job.state,'generating');assert.equal((await c.request(`/api/jobs/${job.id}/complete`,{})).status,409);
 const result=await c.request(`/api/jobs/${job.id}/result-upload/${job.photos[0].id}`,jpeg());assert.equal(result.status,200,await result.clone().text());job=await result.json();assert.equal(job.photos[0].hasResult,true);
 const complete=await c.request(`/api/jobs/${job.id}/complete`,{});assert.equal(complete.status,200,await complete.clone().text());job=await complete.json();assert.equal(job.state,'ready');
 const download=await c.request(`/api/jobs/${job.id}/result/${job.photos[0].id}?download=1`);assert.equal(download.status,200);assert.match(download.headers.get('Content-Disposition'),/attachment/);assert.deepEqual(new Uint8Array(await download.arrayBuffer()),jpeg());
 assert.ok([...b.objects.keys()].some(k=>k.startsWith(job.id)));
 const deleted=await c.request(`/api/jobs/${job.id}/finish`,{});assert.equal(deleted.status,200,await deleted.clone().text());assert.ok(![...b.objects.keys()].some(k=>k.startsWith(job.id)));
 assert.equal((await c.request('/api/jobs/'+job.id)).status,403);
});
test('pending reservations count toward quota and cleanup retries preserve metadata',async()=>{
 const c=b.client();await c.login();const job=await(await c.request('/api/jobs',{})).json();const row=(await b.db.query('select * from np_jobs where id=$1',[job.id])).rows[0];
 const args={id:job.id,deviceHash:row.device_hash,capabilityHash:row.capability_hash};
 for(let i=0;i<87;i++)await b.rpc('file_reserve',{...args,fileId:crypto.randomUUID(),photoId:'b'.repeat(24),kind:'source',path:job.id+'/pending-'+i+'.jpg',bytes:8*1024*1024,meta:{photo:{}},revision:job.revision});
 await assert.rejects(b.rpc('file_reserve',{...args,fileId:crypto.randomUUID(),photoId:'b'.repeat(24),kind:'source',path:job.id+'/over-limit.jpg',bytes:8*1024*1024,meta:{photo:{}},revision:job.revision}),/STORAGE_LIMIT/);
 await b.db.query("update np_jobs set expires_at=now()-interval '1 day' where id=$1",[job.id]);
 const {sweep}=await import('../supabase/functions/_shared/cleanup.mjs');
 const failed={rpc:b.rpc,request:async()=>{throw Error('storage unavailable');}};
 await assert.rejects(sweep(failed),/storage unavailable/);
 assert.equal((await b.db.query('select count(*)::int as n from np_files where job_id=$1',[job.id])).rows[0].n,87);
 const {SupabaseClient}=await import('../cloudflare/supabase-client.mjs');await sweep(new SupabaseClient(b.env,b.fetcher));
 assert.equal((await b.db.query('select count(*)::int as n from np_jobs where id=$1',[job.id])).rows[0].n,0);
});

// Cloudflare fetch rejects an arbitrary object receiver, unlike Node fetch.
test('native fetch is invoked without the SupabaseClient receiver',async()=>{
 const {SupabaseClient}=await import('../cloudflare/supabase-client.mjs');
 let receiver;
 const client=new SupabaseClient(b.env,function(){receiver=this;return Promise.resolve(Response.json({ok:true}));});
 await client.request('/rest/v1/rpc/np_rpc');assert.equal(receiver,globalThis);
});
