import {ZipReader,ZipWriter,BlobReader,BlobWriter} from '@zip.js/zip.js';
import {LIMITS,PROFILE,safePath,hash,outputPaths,validateImage} from '../shared/free-model.mjs';
const placeholder='data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="640" height="480"%3E%3Crect width="100%25" height="100%25" fill="%23e9eeea"/%3E%3C/svg%3E';
async function checked(response){if(!response.ok){let value={};try{value=await response.json();}catch{}throw Error(value.error||'사진 처리 요청이 실패했습니다.');}return response;}
function canvas(width,height){const el=document.createElement('canvas');el.width=width;el.height=height;return el;}
function jpeg(canvas,quality=.85){return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(Error('JPEG 변환에 실패했습니다.')),'image/jpeg',quality));}
async function bitmap(blob){const image=await createImageBitmap(blob,{imageOrientation:'from-image'});if(image.width*image.height>LIMITS.pixels){image.close();throw Error('사진은 최대 2천만 픽셀입니다.');}return image;}
export async function prepareSource(blob){
 const image=await bitmap(blob);const scale=Math.min(1280/image.width,1280/image.height,1);const out=canvas(Math.max(1,Math.round(image.width*scale)),Math.max(1,Math.round(image.height*scale)));
 try{const ctx=out.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,out.width,out.height);ctx.drawImage(image,0,0,out.width,out.height);return {blob:await jpeg(out,.92),width:out.width,height:out.height};}
 finally{image.close();out.width=out.height=0;}
}
export async function ensureFont(text){const loaded=await document.fonts.load('700 31px "Noto Sans KR"',text||'공사명 위치 기기명 내용 일자');if(!loaded.length||!document.fonts.check('700 31px "Noto Sans KR"',text))throw Error('한글 글꼴을 불러오지 못했습니다. 연결을 확인하고 다시 생성하세요.');}
export async function renderPhoto(blob,photo,project,{plate=true,maxWidth=1280}={}){
 if(plate)await ensureFont('공사명 위치 기기명 내용 일자'+project+photo.location+photo.equipment+photo.work+photo.date);
 const image=await bitmap(blob);const turns=((image.height>image.width?-1:0)+(photo.rotation||0)+4)%4;
 const bw=turns%2?image.height:image.width,bh=turns%2?image.width:image.height;
 const scale=Math.min(maxWidth/bw,maxWidth*.75/bh,1);const width=Math.max(4,Math.min(maxWidth,Math.ceil(Math.max(bw*scale,bh*scale*4/3)/4)*4)),height=width*3/4;
 const out=canvas(width,height),ctx=out.getContext('2d');
 try{
  ctx.fillStyle='white';ctx.fillRect(0,0,width,height);ctx.save();ctx.translate(width/2,height/2);ctx.rotate(turns*Math.PI/2);ctx.drawImage(image,-image.width*scale/2,-image.height*scale/2,image.width*scale,image.height*scale);ctx.restore();
  if(plate){
   if(width<320)throw Error('사진 해상도가 너무 작습니다. 더 큰 원본을 선택하세요.');
   const pw=Math.round(width*PROFILE.width),ph=Math.round(height*PROFILE.height),col=Math.round(width*PROFILE.label),x=width-pw,y=height-ph;
   ctx.fillStyle='white';ctx.fillRect(x,y,pw,ph);ctx.strokeStyle='#222';ctx.lineWidth=1;
   const rows=[['공사명',project],['위 치',photo.location],['기기명',photo.equipment],['내 용',photo.work],['일 자',photo.date.replaceAll('-','.')]];
   for(let i=0;i<5;i++){
    const top=y+Math.round(ph*i/5),bottom=y+Math.round(ph*(i+1)/5);
    ctx.beginPath();ctx.moveTo(x,top+.5);ctx.lineTo(width,top+.5);ctx.stroke();
    for(const [value,left,cellWidth] of [[rows[i][0],x,col],[rows[i][1],x+col,pw-col]]){
     const text=String(value),padding=Math.max(3,Math.round(width*PROFILE.padding));let size=Math.round(width*PROFILE.font);
     ctx.font=`700 ${size}px "Noto Sans KR"`;while(ctx.measureText(text).width>cellWidth-padding*2&&size>6){size--;ctx.font=`700 ${size}px "Noto Sans KR"`;}
     if(ctx.measureText(text).width>cellWidth-padding*2)throw Error('명판 문구가 너무 깁니다. 줄인 뒤 다시 생성하세요.');
     const metrics=ctx.measureText(text);const ascent=metrics.actualBoundingBoxAscent,descent=metrics.actualBoundingBoxDescent;
     ctx.fillStyle='#111';ctx.fillText(text,left+padding,top+(bottom-top-ascent-descent)/2+ascent);
    }
   }
   ctx.fillStyle='#222';ctx.fillRect(x,y,1,ph);ctx.fillRect(x+col,y,1,ph);ctx.fillRect(width-1,y,1,ph);ctx.fillRect(x,height-1,pw,1);
  }
  return await jpeg(out,.85);
 }finally{image.close();out.width=out.height=0;}
}
async function readEntry(entry){
 const chunks=[];let bytes=0;
 await entry.getData(new WritableStream({write(chunk){bytes+=chunk.byteLength;if(bytes>LIMITS.source)throw Error('압축 해제된 사진이 8MiB를 초과했습니다.');chunks.push(chunk);}}),{useWebWorkers:false,checkSignature:true});
 return new Blob(chunks);
}
export async function inspectUpload(files){
 const warnings=[],items=[],readers=[];let expanded=0;
 try{
  for(const file of files){
   if(/\.zip$/i.test(file.name)){
    if(file.size>LIMITS.zip)throw Error('ZIP은 최대 90MiB입니다. 하루 단위로 나누어 주세요.');
    const reader=new ZipReader(new BlobReader(file),{useWebWorkers:false});readers.push(reader);const entries=await reader.getEntries();
    if(entries.length>2000)throw Error('ZIP 항목은 최대 2,000개입니다.');
    for(const entry of entries){
     const path=safePath(entry.filename);if(entry.directory)continue;
     if(entry.encrypted)throw Error('암호화 ZIP은 지원하지 않습니다.');
     if(entry.uncompressedSize>LIMITS.source||entry.uncompressedSize/Math.max(entry.compressedSize,1)>200)throw Error('ZIP의 파일 크기 또는 압축 비율 제한을 초과했습니다.');
     expanded+=entry.uncompressedSize;if(expanded>LIMITS.expanded)throw Error('압축 해제 용량은 최대 150MiB입니다. ZIP을 나누어 주세요.');
     if(!/\.(jpe?g|png)$/i.test(path)){warnings.push(path+': 지원하지 않는 형식');continue;}
     const mode=entry.externalFileAttributes>>>16;if((mode&0xf000)===0xa000)throw Error('ZIP의 링크 파일은 허용하지 않습니다.');
     items.push({path,size:entry.uncompressedSize,read:()=>readEntry(entry)});
    }
   }else{
    if(!/\.(jpe?g|png)$/i.test(file.name)){warnings.push(file.name+': 지원하지 않는 형식');continue;}
    if(file.size>LIMITS.source)throw Error('사진당 최대 8MiB입니다.');items.push({path:safePath(file.name),size:file.size,read:async()=>file});
   }
  }
  if(!items.length)throw Error('처리할 사진이 없습니다.');if(items.length>LIMITS.photos)throw Error('무료 MVP는 작업당 최대 50장입니다. ZIP을 나누어 주세요.');
  return {items,warnings,close:async()=>{for(const reader of readers)await reader.close();}};
 }catch(error){for(const reader of readers)await reader.close();throw error;}
}
export async function uploadFiles(files,api,progress){
 const plan=await inspectUpload(files);let job;
 try{
  job=await api('/api/jobs',{});
  for(let i=0;i<plan.items.length;i++){
   const entry=plan.items[i];progress(`${i+1}/${plan.items.length} · ${entry.path} 작업용 사본 업로드 중`);
   let source,working,originalHash;
   try{source=await entry.read();if(source.size>LIMITS.source||source.size!==entry.size)throw Error('파일 크기 정보가 다릅니다.');const originalBytes=await source.arrayBuffer();validateImage(new Uint8Array(originalBytes));originalHash=await hash(originalBytes);working=await prepareSource(source);}
   catch(error){plan.warnings.push(entry.path+': '+error.message);continue;}
   const photoId=[...crypto.getRandomValues(new Uint8Array(12))].map(v=>v.toString(16).padStart(2,'0')).join('');
   const response=await checked(await fetch(`/api/jobs/${job.id}/source/${photoId}`,{method:'POST',headers:{'X-Photo-Meta':encodeURIComponent(JSON.stringify({path:entry.path,hash:originalHash})),'X-Revision':String(job.revision)},body:working.blob}));
   job=await response.json();source=working=null;
  }
  job=await api(`/api/jobs/${job.id}/warnings`,{warnings:plan.warnings});return job;
 }catch(error){throw Error(error.message+(job?' · 전송이 끝난 사진은 진행 중인 작업에서 복구할 수 있습니다.':''));}
 finally{await plan.close();}
}
let observer,previewQueue=[],previewActive=false,previewsPaused=false,activePreview;
const wanted=new Map(),urls=new Map();
export function clearPreviews(){observer?.disconnect();wanted.clear();previewQueue=[];for(const value of urls.values())URL.revokeObjectURL(value);urls.clear();}
export function setPreview(img,job,photo,ready){
 const key=`${job.id}:${photo.id}:${photo.rotation}:${ready?'result':'source'}`;
 if(wanted.get(img)?.key===key)return;const old=urls.get(img);if(old){URL.revokeObjectURL(old);urls.delete(img);}
 if(ready){wanted.set(img,{key});img.src=`/api/jobs/${job.id}/result/${photo.id}?v=${job.revision}`;return;}
 img.src=placeholder;const value={key,img,jobId:job.id,photo:{...photo},queued:false};wanted.set(img,value);
 if(!observer)observer=new IntersectionObserver(entries=>{for(const entry of entries){if(entry.isIntersecting){const value=wanted.get(entry.target);if(value?.photo&&!value.queued){value.queued=true;previewQueue.push(value);drainPreviews();}}}},{rootMargin:'200px'});
 observer.observe(img);
}
async function drainPreviews(){
 if(previewActive||previewsPaused)return;previewActive=true;
 activePreview=(async()=>{while(previewQueue.length&&!previewsPaused){const value=previewQueue.shift();if(wanted.get(value.img)!==value)continue;try{const source=await (await checked(await fetch(`/api/jobs/${value.jobId}/image/${value.photo.id}`))).blob();const blob=await renderPhoto(source,value.photo,'',{plate:false,maxWidth:640});if(wanted.get(value.img)!==value)continue;const url=URL.createObjectURL(blob);urls.set(value.img,url);value.img.src=url;}catch(error){if(wanted.get(value.img)===value)value.img.alt='미리보기 실패: '+error.message;}}})();
 try{await activePreview;}finally{previewActive=false;}
}
export async function generate(job,api,progress,shouldStop=()=>false){
 previewsPaused=true;await activePreview;
 try{
  job=await api('/api/jobs/'+job.id);
  for(const photo of job.photos.filter(p=>!p.excluded)){
   if(shouldStop())return await api(`/api/jobs/${job.id}/pause`,{});
   if(photo.hasResult)continue;
   const source=await (await checked(await fetch(`/api/jobs/${job.id}/image/${photo.id}`))).blob();const result=await renderPhoto(source,photo,job.generation.project);
   if(shouldStop())return await api(`/api/jobs/${job.id}/pause`,{});
   job=await (await checked(await fetch(`/api/jobs/${job.id}/result-upload/${photo.id}`,{method:'POST',body:result}))).json();progress(job);
  }
  return await api(`/api/jobs/${job.id}/complete`,{});
 }finally{previewsPaused=false;drainPreviews();}
}
export function downloadPlans(job,date){
 const selected=job.photos.filter(p=>!p.excluded&&(!date||p.date===date));const entries=outputPaths(selected),plans=[];let batch=[],bytes=0;
 for(const entry of entries){const size=entry.photo.resultBytes||LIMITS.result;if(batch.length&&bytes+size>24*1024*1024-262144){plans.push(batch);batch=[];bytes=0;}batch.push(entry);bytes+=size;}
 if(batch.length)plans.push(batch);return plans;
}
export async function downloadZip(job,entries,progress){
 const writer=new ZipWriter(new BlobWriter('application/zip'),{level:0,useWebWorkers:false});
 try{
  for(let i=0;i<entries.length;i++){const {photo,path}=entries[i];progress(`ZIP 준비 중 ${i+1}/${entries.length}`);const blob=await (await checked(await fetch(`/api/jobs/${job.id}/result/${photo.id}`))).blob();if(blob.size>LIMITS.result)throw Error('출력 파일 크기 제한을 초과했습니다.');await writer.add(path,new BlobReader(blob),{level:0,useWebWorkers:false});}
  return await writer.close();
 }catch(error){try{await writer.close();}catch{}throw error;}
}
export function saveBlob(blob,name){const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
