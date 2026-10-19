import {test} from 'node:test';import assert from 'node:assert/strict';
import {backend} from './helpers/free-backend.mjs';import {nearest,FEATURE_VERSION} from '../cloudflare/vision.mjs';
const b=await backend();test.after(()=>b.db.close());
const jpeg=new Uint8Array([255,216,255,192,0,17,8,2,208,3,192,3,1,17,0,2,17,0,3,17,0,255,217]),values=Array(64).fill(.1);
async function confirmed(c,hash='a'.repeat(64),work='점검'){
 let job=await(await c.request('/api/jobs',{})).json();const id=crypto.randomUUID().replaceAll('-','').slice(0,24);
 job=await(await c.request(`/api/jobs/${job.id}/source/${id}`,jpeg,{'X-Photo-Meta':encodeURIComponent(JSON.stringify({path:'20261019_위치_GIS/사진.jpg',hash})),'X-Revision':String(job.revision)})).json();
 Object.assign(job.photos[0],{date:'2026-10-19',location:'위치',equipment:'GIS',work,confirmed:true});
 const response=await c.request(`/api/jobs/${job.id}/save`,{revision:job.revision,photos:job.photos});assert.equal(response.status,200,await response.clone().text());return response.json();
}
async function capture(c,j){const status=await(await c.request(`/api/jobs/${j.id}/learn`)).json();const record=status.photos?.find(r=>r.photo.id===j.photos[0].id);return c.request(`/api/jobs/${j.id}/learn/${j.photos[0].id}`,jpeg,{'X-Visual-Signature':JSON.stringify(values),'X-Learning-Signature':record?.signature||''});}
test('learning is private, records final labels, reuses images and survives temporary job deletion',async()=>{
 const c=b.client(),other=b.client();await c.login();await other.login();const job=await confirmed(c);
 assert.equal((await other.request(`/api/jobs/${job.id}/learn`)).status,403);
 for(const role of ['anon','authenticated']){await b.db.exec('set role '+role);try{await assert.rejects(b.db.query('select * from np_learning_feedback'),/permission denied/);await assert.rejects(b.db.query("select np_learning_rpc('candidates','{}')"),/permission denied/);}finally{await b.db.exec('reset role');}}
 let response=await capture(c,job);assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).reused,false);
 let refs=await b.learningRpc('candidates');const ref=refs.find(r=>r.original_hash==='a'.repeat(64));assert.equal(ref.worker_confirmed,true);assert.equal(ref.reviewed,false);assert.equal(nearest(refs,values,'GIS')[0].id,ref.id);
 const before=[...b.objects.keys()].filter(k=>k.startsWith('reference/')).length;response=await capture(c,job);assert.equal((await response.json()).reused,true);assert.equal([...b.objects.keys()].filter(k=>k.startsWith('reference/')).length,before);
 await c.request(`/api/jobs/${job.id}/finish`,{});refs=await b.learningRpc('candidates');assert.ok(refs.some(r=>r.id===ref.id));assert.equal((await b.db.query('select count(*)::int as n from np_learning_feedback where job_id=$1',[job.id])).rows[0].n,1);assert.equal(b.externalCalls.length,0);
});
test('admin rejection removes worker case from retrieval and reconfirmation cannot override rejection',async()=>{
 const c=b.client(),admin=b.client();await c.login();await admin.login('admin');let job=await confirmed(c,'b'.repeat(64));assert.equal((await capture(c,job)).status,200);
 let ref=(await b.aiRpc('references_list')).find(r=>r.original_hash==='b'.repeat(64));const rejected=await admin.request('/api/references/'+ref.id,{label:ref.label,reviewed:false,split:'train'});assert.equal(rejected.status,200,await rejected.clone().text());
 assert.ok(!(await b.learningRpc('candidates')).some(r=>r.id===ref.id));assert.equal((await capture(c,job)).status,200);assert.ok(!(await b.learningRpc('candidates')).some(r=>r.id===ref.id));
});
test('unconfirmation withdraws worker trust; unknown work stays pending standardization',async()=>{
 const c=b.client();await c.login();let job=await confirmed(c,'c'.repeat(64));await capture(c,job);job.photos[0].confirmed=false;
 job=await(await c.request(`/api/jobs/${job.id}/save`,{revision:job.revision,photos:job.photos})).json();assert.ok(!(await b.learningRpc('candidates')).some(r=>r.original_hash==='c'.repeat(64)));assert.equal((await capture(c,job)).status,409);job.photos[0].confirmed=true;job=await(await c.request(`/api/jobs/${job.id}/save`,{revision:job.revision,photos:job.photos})).json();const retry=await(await c.request(`/api/jobs/${job.id}/learn`)).json();assert.equal(retry.photos[0].ready,false);assert.equal((await capture(c,job)).status,200);assert.ok((await b.learningRpc('candidates')).some(r=>r.original_hash==='c'.repeat(64)));
 const unknown=await confirmed(c,'d'.repeat(64),'신규 특수 시험');assert.equal((await capture(c,unknown)).status,200);assert.ok(!(await b.learningRpc('candidates')).some(r=>r.original_hash==='d'.repeat(64)));
 const record=(await b.db.query('select * from np_learning_feedback where job_id=$1',[unknown.id])).rows[0];assert.equal(record.label.work,'신규 특수 시험');assert.match(record.note,/검수/);
});

test('later correction of the same photo updates its work without duplicating the stored image',async()=>{
 const c=b.client();await c.login();let job=await confirmed(c,'e'.repeat(64));await capture(c,job);
 job.photos[0].work='청소';job=await(await c.request(`/api/jobs/${job.id}/save`,{revision:job.revision,photos:job.photos})).json();
 const countBefore=[...b.objects.keys()].filter(k=>k.startsWith('reference/')).length;assert.equal((await capture(c,job)).status,200);
 const ref=(await b.learningRpc('candidates')).find(r=>r.original_hash==='e'.repeat(64));assert.equal(ref.label.work,'청소');assert.equal(ref.worker_confirmed,true);assert.equal([...b.objects.keys()].filter(k=>k.startsWith('reference/')).length,countBefore);
});

test('reference quota stops new images but retains worker correction records',async()=>{
 await b.db.exec("insert into np_reference_photos(original_hash,path,image_bytes) select md5(i::text)||md5(i::text),'quota.jpg',1048576 from generate_series(1,257) i");
 const c=b.client();await c.login();const job=await confirmed(c,'f'.repeat(64));const response=await capture(c,job);assert.equal(response.status,413);
 const record=(await b.db.query('select * from np_learning_feedback where job_id=$1',[job.id])).rows[0];assert.equal(record.confirmed,true);assert.equal(record.reference_id,null);
});

test('worker confirmation improves OCR drafts without overwriting reviewed or evaluation labels',async()=>{
 const c=b.client();await c.login();
 for(const [char,reviewed,split] of [['2',false,'train'],['3',false,'evaluation'],['4',true,'train']]){
  const id=crypto.randomUUID(),path=id+'/'+crypto.randomUUID()+'.jpg';
  await b.db.query('insert into np_reference_photos(id,original_hash,path,label,reviewed,split,image_ready,object_path,image_bytes,visual_signature) values($1,$2,$3,$4,$5,$6,true,$7,$8,$9)',[id,char.repeat(64),'draft.jpg',JSON.stringify({project:'공사',date:'2026-10-19',location:'위치',equipment:'GIS',work:'청소',equipmentType:''}),reviewed,split,path,jpeg.length,JSON.stringify({version:FEATURE_VERSION,values})]);b.objects.set('reference/'+path,jpeg);
  const job=await confirmed(c,char.repeat(64));assert.equal((await capture(c,job)).status,200);
  const ref=(await b.aiRpc('reference_get',{id}));
  if(char==='2'){assert.equal(ref.label.work,'점검');assert.equal(ref.ocr_raw.priorDraftLabel.work,'청소');assert.equal(ref.worker_confirmed,true);}else{assert.equal(ref.label.work,'청소');assert.equal(ref.split,split);assert.equal(ref.reviewed,reviewed);}
 }
});
