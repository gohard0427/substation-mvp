import {canonicalWork} from '../shared/work-types.mjs';
import {workKey} from './work-knowledge.mjs';
import {AppError} from './supabase-client.mjs';
import {validateImage,validateConfirmed,normalized} from '../shared/free-model.mjs';
import {signature,FEATURE_VERSION} from './vision.mjs';
const BUCKET='np-reference-private';
export function eligiblePhotos(job,cfg){return job.photos.filter(p=>{if(!p.confirmed||p.excluded)return false;try{validateConfirmed([p],cfg.ambiguityGroups);return true;}catch{return false;}});}
export async function learningRoute({request,client,job,photoId,cfg,body,json}){
 const records=await client.learningRpc('status',{jobId:job.id}),photos=eligiblePhotos(job,cfg);
 if(request.method==='GET'&&!photoId)return json({photos:photos.map(photo=>({photo,...records.find(r=>r.photoId===photo.id)}))});
 if(request.method!=='POST'||!photoId)throw new AppError('POST 요청만 허용됩니다.',405);
 const photo=photos.find(p=>p.id===photoId),record=records.find(p=>p.photoId===photoId);if(!photo||!record)throw new AppError('사진 정보를 저장하고 작업 내용을 먼저 확정하세요.',409);
 if(request.headers.get('X-Learning-Signature')!==record.signature)throw new AppError('확정 정보가 변경되어 참고 사본을 다시 준비합니다.',409);
 const bytes=await body(request,262144),info=validateImage(bytes,true);if(info.width>960||info.height>720)throw new AppError('참고 사진은 최대 960×720입니다.');
 let values;try{values=signature(JSON.parse(request.headers.get('X-Visual-Signature')));}catch{throw new AppError('사진 특징을 확인하세요.');}
 const work=cfg.workTypes.find(w=>workKey(w)===workKey(photo.work));
 const args={jobId:job.id,photoId,signature:record.signature,bytes:bytes.length,path:photo.path,standardWork:canonicalWork(work||photo.work),eligible:!!work||cfg.autoLearnConfirmed===true,visualSignature:{version:FEATURE_VERSION,values}};
 const claim=await client.learningRpc('claim',args);if(claim.cached)return json({ok:true,reused:true,note:claim.note||''});
 const ref=claim.reference;
 try{
  await client.request(`/storage/v1/object/${BUCKET}/${ref.object_path}`,{method:'POST',headers:{'Content-Type':'image/jpeg','x-upsert':'true'},body:bytes});
  await client.learningRpc('commit',{...args,objectPath:ref.object_path});
 }catch(error){
  // Remove only this never-finalized temporary copy; existing references are untouched.
  try{const abandoned=await client.learningRpc('abandon',{referenceId:ref.id,objectPath:ref.object_path});if(abandoned.abandoned)await client.request(`/storage/v1/object/${BUCKET}`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({prefixes:[ref.object_path]})});}catch{}
  throw error;
 }
 return json({ok:true,reused:false,note:work||cfg.autoLearnConfirmed===true?'':'새 작업명은 관리자 검수 후 활용합니다.'});
}
