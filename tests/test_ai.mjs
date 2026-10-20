import {test} from 'node:test';import assert from 'node:assert/strict';
import {backend} from './helpers/free-backend.mjs';import {nearest,validateResult,analysisFingerprint,equipmentContext,recommend,DEFAULT_VISION_MODEL,checkVisionConnection} from '../cloudflare/vision.mjs';
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
 assert.equal(validateResult({...result,candidates:[result.candidates[0],result.candidates[0]]},cfg.workTypes,cfg.ambiguityGroups).candidates.length,1);
});
test('disabled AI makes no external call; enabled per-photo analysis is cached and never confirms work',async()=>{
 const c=b.client();await c.login();let job=await(await c.request('/api/jobs',{})).json();const photoId='1'.repeat(24);
 job=await(await c.request(`/api/jobs/${job.id}/source/${photoId}`,jpeg(),{'X-Photo-Meta':encodeURIComponent(JSON.stringify({path:'20261016_위치_GIS/측정.jpg',hash:'b'.repeat(64)})),'X-Revision':String(job.revision)})).json();
 let response=await c.request(`/api/jobs/${job.id}/analyse/${photoId}`,jpeg(),{'X-Visual-Signature':JSON.stringify(values)});assert.equal(response.status,503);assert.equal(b.externalCalls.length,0);
 b.env.AI_ENABLED='true';b.env.OPENAI_API_KEY='test-only-ai-key';b.env.AI_DAILY_LIMIT='1';
 response=await c.request(`/api/jobs/${job.id}/analyse/${photoId}`,jpeg(),{'X-Visual-Signature':JSON.stringify(values)});assert.equal(response.status,200,await response.clone().text());job=await response.json();
 assert.equal(job.photos[0].confirmed,false);assert.equal(job.photos[0].work,'');assert.equal(job.photos[0].recommendation.result.ambiguityGroupId,'pma-measurement');assert.equal(b.externalCalls.length,2);assert.equal(b.externalCalls[0].store,false);
 response=await c.request(`/api/jobs/${job.id}/analyse/${photoId}`,jpeg(),{'X-Visual-Signature':JSON.stringify(values)});assert.equal(response.status,200,await response.clone().text());job=await response.json();assert.equal(b.externalCalls.length,2);
 job.photos[0].equipmentType='other GIS';job=await(await c.request(`/api/jobs/${job.id}/save`,{revision:job.revision,photos:job.photos})).json();
 response=await c.request(`/api/jobs/${job.id}/analyse/${photoId}`,jpeg(),{'X-Visual-Signature':JSON.stringify(values)});assert.equal(response.status,429);assert.equal(b.externalCalls.length,2);
 const usage=await b.aiRpc('usage');assert.equal(usage.attempts24h,1);assert.equal(usage.providerCalls24h,2);assert.equal(usage.inputTokens24h,200);
});
test('cache signature changes with rotation and reviewed examples',async()=>{
 const cfg=await b.rpc('config_get'),p={hash:'x',rotation:0,equipmentType:'GIS'};const a=await analysisFingerprint(p,cfg,[reference],'test');assert.notEqual(a,await analysisFingerprint({...p,rotation:1},cfg,[reference],'test'));assert.notEqual(a,await analysisFingerprint(p,cfg,[{...reference,updated_at:'changed'}],'test'));
});

test('zero reviewed references still allows image analysis and lifetime cap survives a new day',async()=>{
 const isolated=await backend({visionResult:result});try{
 isolated.env.AI_ENABLED='true';isolated.env.OPENAI_API_KEY='test-only-ai-key';isolated.env.AI_TOTAL_LIMIT='1';
 const c=isolated.client();await c.login();let job=await(await c.request('/api/jobs',{})).json();const id='2'.repeat(24);
 job=await(await c.request(`/api/jobs/${job.id}/source/${id}`,jpeg(),{'X-Photo-Meta':encodeURIComponent(JSON.stringify({path:'folder/photo.jpg',hash:'c'.repeat(64)})),'X-Revision':String(job.revision)})).json();
 const request=()=>c.request(`/api/jobs/${job.id}/analyse/${id}`,jpeg(),{'X-Visual-Signature':JSON.stringify(values)});
 let response=await request();assert.equal(response.status,200,await response.clone().text());job=await response.json();assert.equal(isolated.externalCalls.length,1);assert.equal(isolated.externalCalls[0].model,DEFAULT_VISION_MODEL);assert.equal(isolated.externalCalls[0].max_output_tokens,6000);assert.equal(isolated.externalCalls[0].reasoning.effort,'medium');assert.equal(job.photos[0].confirmed,false);
 // Cache continues to work at the total cap.
 response=await request();assert.equal(response.status,200);job=await response.json();assert.equal(isolated.externalCalls.length,1);
 await isolated.db.exec("update np_ai_runs set created_at=now()-interval '25 hours'");
 job.photos[0].rotation=1;job=await(await c.request(`/api/jobs/${job.id}/save`,{revision:job.revision,photos:job.photos})).json();
 response=await request();assert.equal(response.status,429);assert.match((await response.json()).error,/전체 시험/);assert.equal(isolated.externalCalls.length,1);
 }finally{await isolated.db.close();}
});
test('only same-folder target equipment contributes context; it invalidates cached recommendations',async()=>{
 const target={id:'target',group:'folder/a',equipment:'GIS',equipmentType:'PMA GIS',analysisStatus:'complete',recommendation:{result:{candidates:[{work:'대상 기기'}],observations:['PMA 표기']}}};
 const photo={id:'work',group:'folder/a',hash:'h',rotation:0,equipmentType:''};
 assert.deepEqual(equipmentContext({photos:[{...target,group:'folder/b'}]},photo),[]);
 assert.deepEqual(equipmentContext({photos:[{...target,excluded:true}]},photo),[]);
 const context=equipmentContext({photos:[target,photo]},photo);assert.equal(context.length,1);assert.equal(context[0].source,'ai-inferred');
 const cfg=await b.rpc('config_get');assert.notEqual(await analysisFingerprint(photo,cfg,[],DEFAULT_VISION_MODEL),await analysisFingerprint(photo,cfg,[],DEFAULT_VISION_MODEL,context));
});
test('provider quota error is actionable and has no automatic paid retry',async()=>{
 let calls=0;const cfg=await b.rpc('config_get');await assert.rejects(recommend({env:{OPENAI_API_KEY:'test'},image:jpeg(),photo:{},works:cfg.workTypes,groups:cfg.ambiguityGroups,references:[],context:[],fetcher:async()=>{calls++;return new Response(null,{status:429});}}),e=>e.status===429);assert.equal(calls,1);
});

test('admin connection probe sends no photos and performs no billable inference',async()=>{
 let calls=0;const value=await checkVisionConnection({OPENAI_API_KEY:'test-only-key'},async(url,options)=>{calls++;assert.ok(url.endsWith('/models/'+DEFAULT_VISION_MODEL));assert.equal(options.body,undefined);return Response.json({id:DEFAULT_VISION_MODEL});});assert.equal(value.keyVerified,true);assert.equal(value.analysisEnabled,false);assert.equal(calls,1);
 await assert.rejects(checkVisionConnection({},()=>{throw Error('must not call');}),/Secret/);
 const worker=b.client();await worker.login();assert.equal((await worker.request('/api/ai-status')).status,403);
});

test('only admin can change daily trial calls; total trial cap stays independent',async()=>{
 const isolated=await backend();try{const worker=isolated.client(),admin=isolated.client();await worker.login();await admin.login('admin');assert.equal((await worker.request('/api/settings',{aiDailyLimit:100})).status,403);assert.equal((await admin.request('/api/settings',{aiDailyLimit:201})).status,400);const saved=await admin.request('/api/settings',{aiDailyLimit:100});assert.equal(saved.status,200);const settings=await(await worker.request('/api/settings')).json();assert.equal(settings.aiDailyLimit,100);assert.equal(settings.aiTotalLimit,10000);}finally{await isolated.db.close();}
});

test('reference selection balances distinct work types instead of repeating the dominant class',()=>{
 const base={reviewed:true,image_ready:true,split:'train',object_path:'private.jpg',visual_signature:{version:'color-spatial-v1',values:Array(64).fill(.2)}};
 const refs=[{...base,id:'a',label:{work:'동작특성 시험'}},{...base,id:'b',label:{work:'동작특성 시험'}},{...base,id:'c',label:{work:'코일 저항 측정'}},{...base,id:'d',label:{work:'점검'}},{...base,id:'e',split:'evaluation',label:{work:'평가 정답'}}];
 assert.deepEqual(nearest(refs,Array(64).fill(.2),'').map(r=>r.id),['a','c','d']);
});
test('an unsupported model ambiguity ID cannot turn a generic tester into PMA equipment',async()=>{
 const cfg=await b.rpc('config_get');const generic=validateResult({...result,equipmentType:'GIS',ambiguityGroupId:'pma-measurement'},cfg.workTypes,cfg.ambiguityGroups);assert.equal(generic.ambiguityGroupId,null);
 assert.equal(validateResult({...result,equipmentType:'GIS'},cfg.workTypes,cfg.ambiguityGroups,'PMA GIS').ambiguityGroupId,'pma-measurement');
});

test('100 historical calls no longer block analysis; budget blocks new calls but allows cache',async()=>{
 const isolated=await backend({visionResult:result});try{
 isolated.env.AI_ENABLED='true';isolated.env.OPENAI_API_KEY='test-only-ai-key';
 await isolated.db.exec("insert into np_ai_runs(job_id,photo_id,signature,status,usage,created_at) select gen_random_uuid(),'old','old','complete','{\"input_tokens\":100,\"output_tokens\":30}'::jsonb,now()-interval '25 hours' from generate_series(1,100)");
 const c=isolated.client();await c.login();let job=await(await c.request('/api/jobs',{})).json();const id='8'.repeat(24);
 job=await(await c.request(`/api/jobs/${job.id}/source/${id}`,jpeg(),{'X-Photo-Meta':encodeURIComponent(JSON.stringify({path:'photo.jpg',hash:'8'.repeat(64)})),'X-Revision':String(job.revision)})).json();
 const request=()=>c.request(`/api/jobs/${job.id}/analyse/${id}`,jpeg(),{'X-Visual-Signature':JSON.stringify(values)});
 let response=await request();assert.equal(response.status,200,await response.clone().text());job=await response.json();assert.equal(isolated.externalCalls.length,1);
 await isolated.db.exec("insert into np_ai_runs(job_id,photo_id,signature,status,usage,created_at) values(gen_random_uuid(),'cost','cost','complete','{\"input_tokens\":20000000,\"output_tokens\":0}'::jsonb,now()-interval '25 hours')");
 response=await request();assert.equal(response.status,200);job=await response.json();assert.equal(isolated.externalCalls.length,1);
 job.photos[0].rotation=1;job=await(await c.request(`/api/jobs/${job.id}/save`,{revision:job.revision,photos:job.photos})).json();
 response=await request();assert.equal(response.status,429);assert.match((await response.json()).error,/예산/);assert.equal(isolated.externalCalls.length,1);
 }finally{await isolated.db.close();}
});

test('server trial switch bypasses daily, lifetime, budget caps but is not worker-editable',async()=>{
 const isolated=await backend({visionResult:result});try{
 isolated.env.AI_ENABLED='true';isolated.env.OPENAI_API_KEY='test-only-ai-key';isolated.env.AI_TOTAL_LIMIT='1';isolated.env.AI_DAILY_LIMIT='1';
 await isolated.db.exec("insert into np_ai_runs(job_id,photo_id,signature,status,usage) select gen_random_uuid(),'old','old','complete','{\"input_tokens\":20000000,\"output_tokens\":0}'::jsonb from generate_series(1,201)");
 const c=isolated.client();await c.login();assert.equal((await c.request('/api/settings',{aiTrialUnlimited:true})).status,403);
 await isolated.db.exec("update np_config set payload=payload||'{\"aiTrialUnlimited\":true}'::jsonb");
 const cfg=await(await c.request('/api/settings')).json();assert.equal(cfg.aiTrialUnlimited,true);assert.equal(cfg.aiDailyLimit,null);assert.equal(cfg.aiTotalLimit,null);assert.equal(cfg.aiBudgetKrw,null);
 let job=await(await c.request('/api/jobs',{})).json();const id='9'.repeat(24);
 job=await(await c.request(`/api/jobs/${job.id}/source/${id}`,jpeg(),{'X-Photo-Meta':encodeURIComponent(JSON.stringify({path:'photo.jpg',hash:'9'.repeat(64)})),'X-Revision':String(job.revision)})).json();
 const request=()=>c.request(`/api/jobs/${job.id}/analyse/${id}`,jpeg(),{'X-Visual-Signature':JSON.stringify(values)});
 let response=await request();assert.equal(response.status,200,await response.clone().text());assert.equal(isolated.externalCalls.length,1);
 response=await request();assert.equal(response.status,200);assert.equal(isolated.externalCalls.length,1);assert.equal((await isolated.aiRpc('usage')).trialUnlimited,true);
 }finally{await isolated.db.close();}
});
