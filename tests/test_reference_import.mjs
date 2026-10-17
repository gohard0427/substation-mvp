import {test} from 'node:test';import assert from 'node:assert/strict';
import {backend} from './helpers/free-backend.mjs';import {importHandler} from '../supabase/functions/np-reference-import/index.ts';import {hash} from '../shared/free-model.mjs';
const b=await backend();test.after(()=>b.db.close());const token='a'.repeat(64),env=b.env;
const image=Uint8Array.from([255,216,255,192,0,17,8,2,208,3,192,3,1,17,0,2,17,0,3,17,0,255,217]);
const input={hash:'f'.repeat(64),path:'folder/photo.jpg',archive:'test.zip',label:{project:'공사',location:'위치',equipment:'GIS',work:'점검',date:'2026-10-17',equipmentType:''},mask:{x:.55,y:.78},split:'train',ocr:{work:'점검'},visualSignature:{version:'color-spatial-v1',values:Array(64).fill(.2)},image:Buffer.from(image).toString('base64'),plate:Buffer.from(image).toString('base64')};
async function fetcher(url,options){if(new URL(url).pathname==='/rest/v1/np_reference_photos'){
 if(options.method==='PATCH'){const i=JSON.parse(options.body);await b.db.query('update np_reference_photos set ocr_raw=$1 where id=$2',[i.ocr_raw,new URL(url).searchParams.get('id').slice(3)]);return new Response(null,{status:204});}
 if(options.method==='POST'){const i=JSON.parse(options.body);return Response.json((await b.db.query('insert into np_reference_photos(original_hash,path,archive,ocr_raw,label,mask,reviewed,split) values($1,$2,$3,$4,$5,$6,$7,$8) returning *',[i.original_hash,i.path,i.archive,i.ocr_raw,i.label,i.mask,i.reviewed,i.split])).rows);}
 return Response.json((await b.db.query('select * from np_reference_photos where original_hash=$1',[new URL(url).searchParams.get('original_hash').slice(3)])).rows);
}return b.fetcher(url,options);}
const call=(data=input,bearer=token)=>importHandler(new Request('https://test/functions/v1/np-reference-import',{method:'POST',headers:{Authorization:'Bearer '+bearer},body:JSON.stringify(data)}),env,fetcher);
test('import denies missing/invalid/expired grant without writing images',async()=>{
 assert.equal((await call()).status,403);
 await b.rpc('config_set',{referenceImport:{tokenHash:await hash(token),expiresAt:new Date(Date.now()-1e3).toISOString()}});assert.equal((await call()).status,403);
 await b.rpc('config_set',{referenceImport:{tokenHash:await hash(token),expiresAt:new Date(Date.now()+3600e3).toISOString()}});assert.equal((await call(input,'b'.repeat(64))).status,403);assert.equal(b.objects.size,0);
});
test('invalid image is rejected before metadata creation',async()=>{assert.equal((await call({...input,image:'YWJj'})).status,400);assert.equal((await b.db.query('select count(*)::integer n from np_reference_photos')).rows[0].n,0);});
test('private masked reference import is idempotent and never marks OCR reviewed',async()=>{
 let r=await call();assert.equal(r.status,200,await r.clone().text());const id=(await r.json()).id;
 let ref=(await b.aiRpc('reference_get',{id}));assert.equal(ref.reviewed,false);assert.equal(ref.image_ready,true);assert.ok(ref.ocr_raw.reviewPlatePath.startsWith(id+'/'));assert.equal(b.objects.size,2);
 const worker=b.client(),admin=b.client();await worker.login();await admin.login('admin');assert.equal((await worker.request(`/api/references/${id}/plate`)).status,403);assert.equal((await admin.request(`/api/references/${id}/plate`)).status,200);
 r=await call({...input,label:{...input.label,work:'다른 내용'}});assert.equal((await r.json()).alreadyConnected,true);ref=await b.aiRpc('reference_get',{id});assert.equal(ref.label.work,'점검');assert.equal(b.objects.size,2);
 r=await call({hash:input.hash,verify:true});assert.equal((await r.json()).imageHash,await hash(image));
});
test('revoking one-time grant stops future imports and reads',async()=>{await b.rpc('config_set',{referenceImport:null});assert.equal((await call({hash:input.hash,verify:true})).status,403);assert.equal(b.objects.size,2);});
