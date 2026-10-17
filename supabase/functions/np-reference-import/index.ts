import {SupabaseClient} from '../../../cloudflare/supabase-client.mjs';
import {hash,safePath,validateImage} from '../../../shared/free-model.mjs';
const bucket='np-reference-private';
export async function importHandler(request,env,fetcher=fetch){
 const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
 const reply=(value,status=200)=>Response.json(value,{status,headers});
 if(request.method!=='POST')return reply({error:'Forbidden'},403);
 const token=request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
 if(!token)return reply({error:'Forbidden'},403);
 try{
  const client=new SupabaseClient(env,fetcher),cfg=await client.rpc('config_get'),grant=cfg.referenceImport;
  if(!grant||grant.tokenHash!==await hash(token)||!Number.isFinite(Date.parse(grant.expiresAt))||Date.parse(grant.expiresAt)<=Date.now())return reply({error:'Forbidden'},403);
  const reader=request.body?.getReader();if(!reader)return reply({error:'Empty body'},400);
  const parts=[];let length=0;try{while(true){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>524288){await reader.cancel();return reply({error:'Body too large'},413);}parts.push(value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let pos=0;for(const part of parts){bytes.set(part,pos);pos+=part.length;}
  const input=JSON.parse(new TextDecoder().decode(bytes));
  if(!/^[a-f0-9]{64}$/.test(input.hash||''))return reply({error:'Invalid hash'},400);
  let response=await client.request('/rest/v1/np_reference_photos?select=*&original_hash=eq.'+input.hash);let ref=(await response.json())[0];
  if(input.verify===true){
   if(!ref?.image_ready)return reply({ready:false},404);
   const image=new Uint8Array(await(await client.request('/storage/v1/object/'+bucket+'/'+ref.object_path)).arrayBuffer());return reply({ready:true,id:ref.id,imageHash:await hash(image),bytes:image.length});
  }
  const label={};for(const key of ['project','location','equipment','work','date','equipmentType']){const value=input.label?.[key];if(typeof value!=='string'||value.length>150||/[\x00-\x1f]/.test(value))return reply({error:'Invalid label'},400);label[key]=value;}
  const path=safePath(input.path);if(!/\.(jpe?g|png)$/i.test(path)||typeof input.archive!=='string'||input.archive.length>100)return reply({error:'Invalid source'},400);
  if(!['train','evaluation'].includes(input.split))return reply({error:'Invalid split'},400);
  const mask=input.mask;if(!mask||![mask.x,mask.y].every(v=>Number.isFinite(v)&&v>0&&v<1))return reply({error:'Invalid mask'},400);
  const values=input.visualSignature?.values;if(!Array.isArray(values)||values.length!==64||values.some(v=>!Number.isFinite(v)||v<0||v>1)||input.visualSignature.version!=='color-spatial-v1')return reply({error:'Invalid signature'},400);
  if(typeof input.image!=='string'||input.image.length>350000||JSON.stringify(input.ocr||{}).length>12000)return reply({error:'Invalid image'},400);
  const image=Uint8Array.from(atob(input.image),c=>c.charCodeAt(0)),info=validateImage(image,true);if(info.width>960||info.height>720)return reply({error:'Invalid reference dimensions'},400);
  const plate=typeof input.plate==='string'&&input.plate.length<150000?Uint8Array.from(atob(input.plate),c=>c.charCodeAt(0)):null;
  if(plate){const info=validateImage(plate);if(info.mime!=='image/jpeg'||info.width>960||info.height>720)throw Error('Invalid plate');}
  if(!ref){
   response=await client.request('/rest/v1/np_reference_photos',{method:'POST',headers:{'Content-Type':'application/json',Prefer:'return=representation'},body:JSON.stringify({original_hash:input.hash,path,archive:input.archive,ocr_raw:input.ocr||{},label,mask,reviewed:false,split:input.split})});ref=(await response.json())[0];
  }
  if(ref.image_ready)return reply({id:ref.id,alreadyConnected:true});
  const objectPath=ref.id+'/'+crypto.randomUUID()+'.jpg',platePath=plate?objectPath.replace('.jpg','-plate.jpg'):null;await client.aiRpc('reference_reserve',{id:ref.id,objectPath,bytes:image.length+(plate?.length||0),visualSignature:input.visualSignature});
  try{
   await client.request('/storage/v1/object/'+bucket+'/'+objectPath,{method:'POST',headers:{'Content-Type':'image/jpeg','x-upsert':'false'},body:image});if(plate){await client.request('/storage/v1/object/'+bucket+'/'+platePath,{method:'POST',headers:{'Content-Type':'image/jpeg','x-upsert':'false'},body:plate});await client.request('/rest/v1/np_reference_photos?id=eq.'+ref.id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({ocr_raw:{...ref.ocr_raw,reviewPlatePath:platePath}})});}await client.aiRpc('reference_finalize',{id:ref.id,objectPath});
  }catch(error){try{await client.request('/storage/v1/object/'+bucket,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({prefixes:[objectPath,...(platePath?[platePath]:[])]})});await client.aiRpc('reference_abandon',{id:ref.id,objectPath});}catch{}throw error;}
  return reply({id:ref.id,connected:true,reviewed:false});
 }catch{return reply({error:'Import failed; inspect reservation before retry'},400);}
}
if(globalThis.Deno?.serve)Deno.serve(request=>importHandler(request,{SUPABASE_URL:Deno.env.get('SUPABASE_URL'),SUPABASE_SERVICE_ROLE_KEY:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}));
