import {checkZipDirectory,zipEntryPath} from '../shared/zip-safety.mjs';
import {ZipReader,ZipWriter,BlobReader,BlobWriter} from '@zip.js/zip.js';
import {LIMITS,PROFILE,safePath,hash,outputPaths,validateImage,formatStationName} from '../shared/free-model.mjs';
const placeholder='data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="640" height="480"%3E%3Crect width="100%25" height="100%25" fill="%23e9eeea"/%3E%3C/svg%3E';
async function checked(response){
 if(response.ok)return response;
 let value={},text='';try{text=await response.text();value=JSON.parse(text);}catch{}
 const code=/\b1102\b|exceeded (?:CPU|resource)/i.test(text)?'EDGE_RESOURCE':/\b1101\b/.test(text)?'EDGE_EXCEPTION':`HTTP_${response.status}`;
 const edge=!value.error;const message=value.error||(code==='EDGE_RESOURCE'?'사진 분석 서버의 처리 한도를 초과했습니다. 완료된 결과는 유지됩니다.':code==='EDGE_EXCEPTION'?'사진 분석 서버의 실행이 중단됐습니다. 완료된 결과는 유지됩니다.':'사진 서버가 일시적으로 응답하지 않습니다. 완료된 결과는 유지됩니다.');
 const error=Error(message+(edge?` (${code})`:''));error.status=response.status;error.code=code;error.uncertain=edge&&response.status>=500;
 const ray=response.headers.get('cf-ray');if(ray)error.requestId=ray;throw error;
}
async function sourceResponse(url){
 // GET is safe to retry. Paid inference POSTs are never automatically repeated.
 for(let attempt=0;;attempt++){try{return await checked(await fetch(url));}catch(error){if(attempt>=2||error.status&&![502,503,504,520,521,522,523,524].includes(error.status)||error.code==='EDGE_RESOURCE')throw error;await new Promise(r=>setTimeout(r,350*(attempt+1)));}}
}

function canvas(width,height){const el=document.createElement('canvas');el.width=width;el.height=height;return el;}
function jpeg(canvas,quality=.85){return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(Error('JPEG 변환에 실패했습니다.')),'image/jpeg',quality));}
async function bitmap(blob){const image=await createImageBitmap(blob,{imageOrientation:'from-image'});if(image.width*image.height>LIMITS.pixels){image.close();throw Error('사진은 최대 2천만 픽셀입니다.');}return image;}
export async function prepareSource(blob){
 const image=await bitmap(blob);const scale=Math.min(1280/image.width,1280/image.height,1);const out=canvas(Math.max(1,Math.round(image.width*scale)),Math.max(1,Math.round(image.height*scale)));
 try{const ctx=out.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,out.width,out.height);ctx.drawImage(image,0,0,out.width,out.height);return {blob:await jpeg(out,.92),width:out.width,height:out.height};}
 finally{image.close();out.width=out.height=0;}
}
export async function ensureFont(text){const loaded=await document.fonts.load('700 31px "Noto Sans KR"',text||'공사명 위치 기기명 내용 일자');if(!loaded.length||!document.fonts.check('700 31px "Noto Sans KR"',text))throw Error('한글 글꼴을 불러오지 못했습니다. 연결을 확인하고 다시 생성하세요.');}
export async function renderPhoto(blob,photo,project,{plate=true,maxWidth=1280,quality=.85}={}){
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
   const rows=[['공사명',project],['위 치',formatStationName(photo.location)],['기기명',photo.equipment],['내 용',photo.work],['일 자',photo.date.replaceAll('-','.')]];
   for(let i=0;i<5;i++){
    const top=y+Math.round(ph*i/5),bottom=y+Math.round(ph*(i+1)/5);
    ctx.beginPath();ctx.moveTo(x,top+.5);ctx.lineTo(width,top+.5);ctx.stroke();
    for(const [value,left,cellWidth] of [[rows[i][0],x,col],[rows[i][1],x+col,pw-col]]){
     const text=String(value),padding=Math.max(3,Math.round(width*PROFILE.padding)),size=Math.round(width*PROFILE.font),available=cellWidth-padding*2;
     ctx.font=`700 ${size}px "Noto Sans KR"`;
     const chars=Array.from(text),natural=ctx.measureText(text).width;
     // Keep identical font size/height in all ten cells. Tighten spacing first;
     // only remaining overflow is fitted horizontally, never vertically.
     const spacing=natural>available&&chars.length>1?Math.max(-size*.12,(available-natural)/(chars.length-1)):0;
     const advances=spacing?chars.map(c=>ctx.measureText(c).width):[];
     const fitted=spacing?advances.reduce((a,b)=>a+b,0)+spacing*(chars.length-1):natural;
     const horizontal=Math.min(1,available/Math.max(1,fitted));
     if(horizontal<.45)throw Error('명판 문구가 너무 깁니다. 줄인 뒤 다시 생성하세요.');
     const metrics=ctx.measureText(text),ascent=metrics.actualBoundingBoxAscent,descent=metrics.actualBoundingBoxDescent;
     ctx.save();ctx.translate(left+padding,top+(bottom-top-ascent-descent)/2+ascent);ctx.scale(horizontal,1);ctx.fillStyle='#111';
     if(spacing){let offset=0;chars.forEach((c,j)=>{ctx.fillText(c,offset,0);offset+=advances[j]+spacing;});}else ctx.fillText(text,0,0);
     ctx.restore();
    }
   }
   ctx.fillStyle='#222';ctx.fillRect(x,y,1,ph);ctx.fillRect(x+col,y,1,ph);ctx.fillRect(width-1,y,1,ph);ctx.fillRect(x,height-1,pw,1);
  }
  return await jpeg(out,quality);
 }finally{image.close();out.width=out.height=0;}
}
async function readEntry(entry){
 const chunks=[];let bytes=0;
 await entry.getData(new WritableStream({write(chunk){bytes+=chunk.byteLength;if(bytes>LIMITS.source)throw Error('압축 해제된 사진이 8MiB를 초과했습니다.');chunks.push(chunk);}}),{useWebWorkers:false,checkSignature:true});
 return new Blob(chunks);
}
export async function inspectUpload(files,{maxPhotos=LIMITS.photos}={}){
 maxPhotos=Math.min(2000,Math.max(1,maxPhotos));
 const warnings=[],items=[],readers=[];let expanded=0;
 try{
  for(const file of files){
   if(/\.zip$/i.test(file.name)){
    if(file.size>LIMITS.zip)throw Error('ZIP은 최대 500MiB입니다. 파일을 나누어 주세요.');
    await checkZipDirectory(file);
    const reader=new ZipReader(new BlobReader(file),{useWebWorkers:false});readers.push(reader);const entries=await reader.getEntries();
    if(entries.length>2000)throw Error('ZIP 항목은 최대 2,000개입니다.');
    for(const entry of entries){
     const path=safePath(zipEntryPath(entry));if(entry.directory)continue;
     if(entry.encrypted)throw Error('암호화 ZIP은 지원하지 않습니다.');
     if(entry.uncompressedSize>LIMITS.source||entry.uncompressedSize/Math.max(entry.compressedSize,1)>200)throw Error('ZIP의 파일 크기 또는 압축 비율 제한을 초과했습니다.');
     expanded+=entry.uncompressedSize;if(expanded>LIMITS.expanded)throw Error('압축 해제 용량은 최대 1GiB입니다. ZIP을 나누어 주세요.');
     if(!/\.(jpe?g|png)$/i.test(path)){warnings.push(path+': 지원하지 않는 형식');continue;}
     const mode=entry.externalFileAttributes>>>16;if((mode&0xf000)===0xa000)throw Error('ZIP의 링크 파일은 허용하지 않습니다.');
     items.push({path,size:entry.uncompressedSize,read:()=>readEntry(entry)});
    }
   }else{
    if(!/\.(jpe?g|png)$/i.test(file.name)){warnings.push(file.name+': 지원하지 않는 형식');continue;}
    if(file.size>LIMITS.source)throw Error('사진당 최대 8MiB입니다.');items.push({path:safePath(file.name),size:file.size,read:async()=>file});
   }
  }
  if(!items.length)throw Error('처리할 사진이 없습니다.');if(items.length>maxPhotos)throw Error(`이번 업로드는 최대 ${maxPhotos}장입니다. ZIP을 나누어 주세요.`);
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
   const source=await (await sourceResponse(`/api/jobs/${job.id}/image/${photo.id}`)).blob();const result=await renderPhoto(source,photo,job.generation.project);
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
  for(let i=0;i<entries.length;i++){const {photo,path}=entries[i];progress(`ZIP 준비 중 ${i+1}/${entries.length}`);const blob=await (await checked(await fetch(`/api/jobs/${job.id}/result/${photo.id}`,{headers:{'X-User-Activity':'download'}}))).blob();if(blob.size>LIMITS.result)throw Error('출력 파일 크기 제한을 초과했습니다.');await writer.add(path,new BlobReader(blob),{level:0,useWebWorkers:false});}
  return await writer.close();
 }catch(error){try{await writer.close();}catch{}throw error;}
}
export function saveBlob(blob,name){const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}

function detectedPlateMask(image){
 const width=image.width,height=image.height,small=canvas(width,height),ctx=small.getContext('2d',{willReadFrequently:true});
 try{
  ctx.drawImage(image,0,0);const pixels=ctx.getImageData(0,0,width,height).data;
  const brightness=(x,y)=>{const i=(Math.max(0,Math.min(height-1,y))*width+Math.max(0,Math.min(width-1,x)))*4;return(pixels[i]+pixels[i+1]+pixels[i+2])/3;};
  // Only the two nameplate profiles measured from the supplied examples.
  const profiles=[{x:1137/2048,y:1200/1536},{x:676/1440,y:878/1080}];
  let best=null;
  for(const profile of profiles){
   const left=Math.ceil(profile.x*width)+3;let white=0,total=0,lines=0;
   for(let y=Math.ceil(profile.y*height)+2;y<height-2;y++)for(let x=left;x<width-3;x++){white+=brightness(x,y)>225;total++;}
   for(let row=1;row<5;row++){
    const center=Math.round((profile.y+(1-profile.y)*row/5)*height);let strongest=0;
    for(let y=center-2;y<=center+2;y++){let dark=0,count=0;for(let x=left;x<width-3;x++){dark+=brightness(x,y)<235;count++;}strongest=Math.max(strongest,dark/count);}
    if(strongest>.7)lines++;
   }
   const score=lines+white/Math.max(1,total);if(lines>=3&&white/Math.max(1,total)>.65&&(!best||score>best.score))best={...profile,score};
  }
  return best||{x:.44,y:.75};
 }finally{small.width=small.height=0;}
}
export async function prepareAnalysis(blob,photo,mask,{maxWidth=960,quality=.85}={}){
 // Mask before rotation so a manual turn cannot move an old answer outside the mask.
 const image=await bitmap(blob);mask=mask||detectedPlateMask(image);const scale=Math.min(1280/image.width,1280/image.height,1),out=canvas(Math.max(1,Math.round(image.width*scale)),Math.max(1,Math.round(image.height*scale))),ctx=out.getContext('2d');let masked;
 try{ctx.drawImage(image,0,0,out.width,out.height);ctx.fillStyle='#808080';const x=Math.max(0,Math.floor(out.width*mask.x)-5),y=Math.max(0,Math.floor(out.height*mask.y)-5);ctx.fillRect(x,y,out.width-x,out.height-y);masked=await jpeg(out,.85);}finally{image.close();out.width=out.height=0;}
 const analysis=await renderPhoto(masked,photo,'',{plate:false,maxWidth,quality});const im=await bitmap(analysis),small=canvas(64,64),s=small.getContext('2d',{willReadFrequently:true});
 try{
  s.drawImage(im,0,0,64,64);const pixels=s.getImageData(0,0,64,64).data,values=Array(64).fill(0);
  for(let i=0;i<pixels.length;i+=4){for(let channel=0;channel<3;channel++)values[channel*16+(pixels[i+channel]>>4)]+=1/4096;const pos=i/4,row=Math.floor(pos/64),col=pos%64;values[48+Math.floor(row/16)*4+Math.floor(col/16)]+=(pixels[i]+pixels[i+1]+pixels[i+2])/(3*255*256);}
  return {blob:analysis,values:values.map(v=>Math.max(0,Math.min(1,v)))};
 }finally{im.close();small.width=small.height=0;}
}
export async function analyse(job,api,progress,{analysisVersion}={}){
 previewsPaused=true;await activePreview;
 try{
  const pending=job.photos.filter(p=>!p.excluded&&!p.confirmed&&(p.analysisStatus!=='complete'||(analysisVersion&&p.recommendation?.result?.analysisVersion!==analysisVersion))).sort((a,b)=>Number(/대상[ _]?기기/.test(b.path)||b.work==='대상 기기')-Number(/대상[ _]?기기/.test(a.path)||a.work==='대상 기기'));
  let done=0;const failures=new Map();
  for(const p of pending){
   progress(job,`AI 분석 중 ${done+1}/${pending.length}`);
   try{
   const photo=job.photos.find(v=>v.id===p.id);const source=await (await sourceResponse(`/api/jobs/${job.id}/image/${photo.id}`)).blob();const analysis=await prepareAnalysis(source,photo);
   let response,received;try{response=await checked(await fetch(`/api/jobs/${job.id}/analyse/${photo.id}`,{method:'POST',headers:{'X-Visual-Signature':JSON.stringify(analysis.values)},body:analysis.blob}));received=await response.json();}catch(error){
    if(error.uncertain||error instanceof TypeError||error instanceof SyntaxError){
     progress(job,'응답 중단 · 서버에 저장된 분석 결과 확인 중');
     if(api){try{const saved=await api(`/api/jobs/${job.id}`);job=saved;const current=job.photos.find(v=>v.id===photo.id);if(current?.analysisStatus==='complete'&&(!analysisVersion||current.recommendation?.result?.analysisVersion===analysisVersion)){for(const [id,message] of failures){const failed=job.photos.find(v=>v.id===id);if(failed){failed.analysisStatus='failed';failed.analysisError=message;}}done++;progress(job);continue;}}catch{}}
     error.message+=' 이 사진의 완료 여부를 확정할 수 없어 분석을 중지합니다. 잠시 후 AI 추천 다시 요청을 누르세요. 완료된 사진은 건너뜁니다.';error.stopAnalysis=true;
    }throw error;
   }job=received;for(const [id,message] of failures){const failed=job.photos.find(v=>v.id===id);if(failed){failed.analysisStatus='failed';failed.analysisError=message;}}done++;progress(job);
   }catch(error){if(error.stopAnalysis||[401,403,409,429,503].includes(error.status))throw error;failures.set(p.id,error.message);const failed=job.photos.find(v=>v.id===p.id);failed.analysisStatus='failed';failed.analysisError=error.message;progress(job);}
  }progress(job,failures.size?`AI 분석 완료 · 실패 ${failures.size}장`:`AI 분석 완료 · ${done}장`);return job;
 }finally{previewsPaused=false;drainPreviews();}
}
export async function referencePlatePreview(blob,mask){
 const im=await bitmap(blob),x=Math.floor(im.width*mask.x),y=Math.floor(im.height*mask.y),width=im.width-x,height=im.height-y,scale=Math.min(640/width,1),out=canvas(Math.round(width*scale),Math.round(height*scale));
 try{out.getContext('2d').drawImage(im,x,y,width,height,0,0,out.width,out.height);return await jpeg(out,.9);}finally{im.close();out.width=out.height=0;}
}

// Uses the same authenticated job routes. No source leaves the application's storage.
export async function learnConfirmed(job,api,progress=()=>{}) {
 const status=await api(`/api/jobs/${job.id}/learn`);let saved=0,reused=0;
 const pending=status.photos.filter(r=>!r.ready);
 for(let i=0;i<pending.length;i++){
  const {photo,signature}=pending[i];progress(`참고 자료 저장 ${i+1}/${pending.length}장`);
  const source=await(await sourceResponse(`/api/jobs/${job.id}/image/${photo.id}`)).blob();
  let prepared=await prepareAnalysis(source,photo,undefined,{quality:.82});
  if(prepared.blob.size>262144)prepared=await prepareAnalysis(source,photo,undefined,{maxWidth:768,quality:.82});
  if(prepared.blob.size>262144){progress('일부 사진은 용량이 커서 수정 기록만 보관했습니다.');continue;}
  try{
   const response=await checked(await fetch(`/api/jobs/${job.id}/learn/${photo.id}`,{method:'POST',headers:{'X-Visual-Signature':JSON.stringify(prepared.values),'X-Learning-Signature':signature},body:prepared.blob}));
   const result=await response.json();if(result.reused)reused++;else saved++;
  }catch(e){if(e.status===409)continue;if(e.status===413){progress('참고 사진 보관 한도에 도달했습니다. 확정 기록은 유지됩니다.');return {saved,reused,quota:true};}throw e;}
 }
 progress(saved||reused?`참고 자료 저장 완료 · 새 사본 ${saved}장 · 중복 재사용 ${reused}장`:'확정 기록·참고 자료가 저장되어 있습니다.');
 return {saved,reused};
}
