import {AppError} from './supabase-client.mjs';
import {signature,FEATURE_VERSION,nearest,recommend,analysisFingerprint,analysisHint,visionModel,equipmentContext,checkVisionConnection} from './vision.mjs';
import {validateImage} from '../shared/free-model.mjs';
export const REF_BUCKET='np-reference-private';
export const aiConfigured=env=>env.AI_ENABLED==='true'&&!!env.OPENAI_API_KEY;
export const totalLimit=env=>Math.max(1,Math.min(100,Number.parseInt(env.AI_TOTAL_LIMIT||'100',10)||100));
export const dailyLimit=(env,cfg={})=>Math.max(1,Math.min(100,Number.parseInt(cfg.aiDailyLimit??env.AI_DAILY_LIMIT??'20',10)||20));
export async function referenceRoute({path,request,client,admin,readJson,body,json,env,fetcher}){
 admin();
 if(path==='/api/ai-status'&&request.method==='GET')return json(await checkVisionConnection(env,fetcher));
 if(path==='/api/references'&&request.method==='GET')return json(await client.aiRpc('references_list'));
 if(path==='/api/ai-usage'&&request.method==='GET')return json(await client.aiRpc('usage'));
 const match=path.match(/^\/api\/references\/([a-f0-9-]{36})(?:\/(image|plate))?$/);if(!match)throw new AppError('요청 경로를 확인하세요.',404);
 const [,id,imageAction]=match;const ref=await client.aiRpc('reference_get',{id});
 if(imageAction&&request.method==='GET'){
  const objectPath=imageAction==='plate'?(ref.ocr_raw?.hasExistingPlate===false?null:ref.ocr_raw?.reviewPlatePath):ref.object_path;
  if(!objectPath||!objectPath.startsWith(id+'/')||!/^[-a-f0-9/]+(?:-plate)?\.jpg$/.test(objectPath))throw new AppError('아직 참고 사진을 연결하지 않았습니다.',404);
  const response=await client.request(`/storage/v1/object/${REF_BUCKET}/${objectPath}`);return new Response(response.body,{headers:{'Content-Type':'image/jpeg','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
 }
 if(imageAction==='image'&&request.method==='POST'){
  const bytes=await body(request,1048576);const info=validateImage(bytes);if(info.mime!=='image/jpeg'||info.width>960||info.height>720||info.width*3!==info.height*4)throw new AppError('참고 사본 규격을 확인하세요.');
  let values;try{values=signature(JSON.parse(request.headers.get('X-Visual-Signature')));}catch{throw new AppError('이미지 특징 정보를 확인하세요.');}
  const objectPath=id+'/'+crypto.randomUUID()+'.jpg';await client.aiRpc('reference_reserve',{id,objectPath,bytes:bytes.length,visualSignature:{version:FEATURE_VERSION,values}});
  try{await client.request(`/storage/v1/object/${REF_BUCKET}/${objectPath}`,{method:'POST',headers:{'Content-Type':'image/jpeg','x-upsert':'false'},body:bytes});await client.aiRpc('reference_finalize',{id,objectPath});}
  catch(error){try{await client.request(`/storage/v1/object/${REF_BUCKET}`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({prefixes:[objectPath]})});await client.aiRpc('reference_abandon',{id,objectPath});}catch{}throw error;}
  return json({ok:true});
 }
 if(!imageAction&&request.method==='POST'){
  const input=await readJson(request),label={};for(const key of ['project','date','location','equipment','work','equipmentType']){const v=input.label?.[key];if(typeof v!=='string'||v.length>150||/[\x00-\x1f]/.test(v))throw new AppError('참고 사진 입력값을 확인하세요.');label[key]=v.trim();}
  if(!['train','evaluation'].includes(input.split))throw new AppError('자료 용도를 확인하세요.');
  if(input.reviewed&&(!label.work||!label.equipment))throw new AppError('작업 내용과 기기명을 검수하세요.');
  return json(await client.aiRpc('reference_review',{id,label,reviewed:input.reviewed===true,split:input.split}));
 }
 throw new AppError('POST 또는 GET 요청을 확인하세요.',405);
}
export async function analysePhoto({request,env,client,job,photoId,args,body,fetcher}){
 if(!aiConfigured(env))throw new AppError('외부 AI 연결이 꺼져 있습니다. 관리자에게 API 설정을 요청하세요.',503);
 const photo=job.photos.find(p=>p.id===photoId&&!p.excluded);if(!photo)throw new AppError('분석할 사진이 없습니다.',404);
 if(photo.confirmed)throw new AppError('이미 확정한 사진은 분석하지 않습니다.',409);
 const bytes=await body(request,524288);validateImage(bytes,true);
 let features;try{features=signature(JSON.parse(request.headers.get('X-Visual-Signature')));}catch{throw new AppError('분석 이미지 특징을 확인하세요.');}
 const references=await client.aiRpc('references_list'),selected=nearest(references,features,analysisHint(photo));
 const cfg=await client.rpc('config_get');const model=visionModel(env),context=equipmentContext(job,photo);const fingerprint=await analysisFingerprint(photo,cfg,selected,model,context);
 const claim=await client.aiRpc('analysis_claim',{...args,jobId:job.id,photoId,signature:fingerprint,revision:job.revision,limit:dailyLimit(env,cfg),totalLimit:totalLimit(env)});
 let result,usage;
 try{
  if(claim.cached){result=claim.run.result;usage=claim.run.usage;}
  else{
   const examples=[];for(const ref of selected){const response=await client.request(`/storage/v1/object/${REF_BUCKET}/${ref.object_path}`);const image=new Uint8Array(await response.arrayBuffer());if(image.length>1048576)throw new AppError('참고 사진 용량이 올바르지 않습니다.');examples.push({...ref,bytes:image});}

   ({result,usage}=await recommend({env,image:bytes,photo:{...photo,equipmentType:analysisHint(photo)},works:cfg.workTypes,groups:cfg.ambiguityGroups,references:examples,context,fetcher}));
  }
  const committed=await client.aiRpc('analysis_commit',{...args,revision:job.revision,runId:claim.run.id,result,usage});if(committed.stale)throw new AppError('분석 중 사진 정보가 변경되었습니다. 다시 불러온 뒤 요청하세요.',409);
 }catch(error){if(!claim.cached)await client.aiRpc('analysis_fail',{runId:claim.run.id});throw error;}
 return await client.rpc('job_get',args);
}
