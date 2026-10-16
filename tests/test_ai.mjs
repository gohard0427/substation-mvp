import {test} from 'node:test';import assert from 'node:assert/strict';
import {backend} from './helpers/free-backend.mjs';import {nearest,validateResult,analysisFingerprint} from '../cloudflare/vision.mjs';
const result={equipmentType:'PMA GIS',candidates:[{work:'코일 저항 측정',reason:'측정 장면'}],observations:['조작부에 계측기를 연결함'],measurementScene:true,ambiguityGroupId:null,needsUserReview:false};
const b=await backend({visionResult:result});test.after(()=>b.db.close());
const jpeg=(w=960,h=720)=>new Uint8Array([255,216,255,192,0,17,8,h>>8,h&255,w>>8,w&255,3,1,17,0,2,17,0,3,17,0,255,217]);
const values=Array(64).fill(.2);let reference;
test('reference table and AI RPC reject direct anonymous/authenticated access',async()=>{
 for(const role of ['anon','authenticated']){await b.db.exec('set role '+role);try{await assert.rejects(b.db.query('select * from public.np_reference_photos'),/permission denied/);await assert.rejects(b.db.query("select public.np_ai_rpc('references_list','{}')"),/permission denied/);}finally{await b.db.exec('reset role');}}
});
test('only admin uploads and explicitly reviewed training references are searched',async()=>{
 const id=crypto.randomUUID();await b.db.query('insert into public.np_reference_photos(id,original_hash,path,archive,label) values($1,$2,$3,$4,$5)',[id,'f'.repeat(64),'group/ref.jpg','sample.zip',JSON.stringify({equipment:'GIS',work:'코일 저항 측정'})]);
 const worker=b.client(),admin=b.client();await worker.login();await admin.login('admin');assert.equal((await worker.request('/api/references')).status,403);
 const pending=await admin.request(`/api/references/${id}`,{label:{project:'공사',date:'2026-10-16',location:'위치',equipment:'GIS',work:'코일 저항 측정',equipmentType:'PMA GIS'},reviewed:true,split:'train'});assert.equal(pending.status,409);
 const uploaded=await admin.request(`/api/references/${id}/image`,jpeg(),{'X-Visual-Signature':JSON.stringify(values)});assert.equal(uploaded.status,200,await uploaded.clone().text());
 let refs=await b.aiRpc('references_list');assert.equal(nearest(refs,values,'').length,0);
 const saved=await admin.request(`/api/references/${id}`,{label:{project:'공사',date:'2026-10-16',location:'위치',equipment:'GIS',work:'코일 저항 측정',equipmentType:'PMA GIS'},reviewed:true,split:'train'});assert.equal(saved.status,200,await saved.clone().text());reference=await saved.json();
 refs=await b.aiRpc('references_list');assert.equal(nearest(refs,values,'').length,1);assert.equal(nearest([{...reference,split:'evaluation'}],values,'').length,0);
});
test('vision output rejects synonyms outside standards and enforces PMA choice regardless of model',async()=>{
 const cfg=await b.rpc('config_get');const checked=validateResult(result,cfg.workTypes,cfg.ambiguityGroups);assert.equal(checked.needsUserReview,true);assert.equal(checked.ambiguityGroupId,'pma-measurement');
 assert.throws(()=>validateResult({...result,candidates:[{work:'상상한 작업',reason:'없음'}]},cfg.workTypes,cfg.ambiguityGroups));
 assert.throws(()=>validateResult({...result,candidates:[result.candidates[0],result.candidates[0]]},cfg.workTypes,cfg.ambiguityGroups));
});
test('disabled AI makes no external call; enabled per-photo analysis is cached and never confirms work',async()=>{
 const c=b.client();await c.login();let job=await(await c.request('/api/jobs',{})).json();const photoId='1'.repeat(24);
 job=await(await c.request(`/api/jobs/${job.id}/source/${photoId}`,jpeg(),{'X-Photo-Meta':encodeURIComponent(JSON.stringify({path:'20261016_위치_GIS/측정.jpg',hash:'b'.repeat(64)})),'X-Revision':String(job.revision)})).json();
 let response=await c.request(`/api/jobs/${job.id}/analyse/${photoId}`,jpeg(),{'X-Visual-Signature':JSON.stringify(values)});assert.equal(response.status,503);assert.equal(b.externalCalls.length,0);
 b.env.AI_ENABLED='true';b.env.OPENAI_API_KEY='test-only-ai-key';b.env.AI_DAILY_LIMIT='1';
 response=await c.request(`/api/jobs/${job.id}/analyse/${photoId}`,jpeg(),{'X-Visual-Signature':JSON.stringify(values)});assert.equal(response.status,200,await response.clone().text());job=await response.json();
 assert.equal(job.photos[0].confirmed,false);assert.equal(job.photos[0].work,'');assert.equal(job.photos[0].recommendation.result.ambiguityGroupId,'pma-measurement');assert.equal(b.externalCalls.length,1);assert.equal(b.externalCalls[0].store,false);
 response=await c.request(`/api/jobs/${job.id}/analyse/${photoId}`,jpeg(),{'X-Visual-Signature':JSON.stringify(values)});assert.equal(response.status,200,await response.clone().text());job=await response.json();assert.equal(b.externalCalls.length,1);
 job.photos[0].equipmentType='other GIS';job=await(await c.request(`/api/jobs/${job.id}/save`,{revision:job.revision,photos:job.photos})).json();
 response=await c.request(`/api/jobs/${job.id}/analyse/${photoId}`,jpeg(),{'X-Visual-Signature':JSON.stringify(values)});assert.equal(response.status,429);assert.equal(b.externalCalls.length,1);
 const usage=await b.aiRpc('usage');assert.equal(usage.attempts24h,1);assert.equal(usage.inputTokens24h,100);
});
test('cache signature changes with rotation and reviewed examples',async()=>{
 const cfg=await b.rpc('config_get'),p={hash:'x',rotation:0,equipmentType:'GIS'};const a=await analysisFingerprint(p,cfg,[reference],'test');assert.notEqual(a,await analysisFingerprint({...p,rotation:1},cfg,[reference],'test'));assert.notEqual(a,await analysisFingerprint(p,cfg,[{...reference,updated_at:'changed'}],'test'));
});
