import {WORK_ALIASES,uniqueWorks,effectiveWorkTypes} from '../shared/work-types.mjs';
import {learningRoute} from './worker-learning.mjs';
import {visionModel,PROMPT_VERSION} from './vision.mjs';
import {referenceRoute,analysePhoto,aiConfigured,dailyLimit,totalLimit} from './reference-api.mjs';
import {SupabaseClient,AppError} from './supabase-client.mjs';
import {BUCKET,storageDelete} from '../supabase/functions/_shared/cleanup.mjs';
import {DEFAULT_PROJECT,ValidationError,LIMITS,PROFILE,hash,fingerprint,safePath,infer,safePhotoUpdate,validateImage,validateConfirmed,normalized} from '../shared/free-model.mjs';
const enc=new TextEncoder();let activeUploads=0;
function json(value,status=200,extra={}){return Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...extra}});}
function cookies(request){const out={};for(const item of (request.headers.get('Cookie')||'').split(';')){const i=item.indexOf('=');if(i>0)out[item.slice(0,i).trim()]=item.slice(i+1).trim();}return out;}
function random(){return [...crypto.getRandomValues(new Uint8Array(32))].map(v=>v.toString(16).padStart(2,'0')).join('');}
function cookie(name,value,age){return `${name}=${value}; Path=/; Max-Age=${age}; Secure; HttpOnly; SameSite=Strict`;}
async function body(request,limit){const length=request.headers.get('Content-Length');if(length&&(!/^\d+$/.test(length)||Number(length)>limit))throw new AppError('파일 용량 제한을 초과했습니다.',413);if(!request.body)return new Uint8Array();const reader=request.body.getReader();const chunks=[];let total=0;try{while(true){const {value,done}=await reader.read();if(done)break;total+=value.length;if(total>limit){await reader.cancel();throw new AppError('파일 용량 제한을 초과했습니다.',413);}chunks.push(value);}}finally{reader.releaseLock();}const output=new Uint8Array(total);let position=0;for(const chunk of chunks){output.set(chunk,position);position+=chunk.length;}return output;}
async function readJson(request,limit=524288){try{return JSON.parse(new TextDecoder().decode(await body(request,limit)));}catch(error){if(error instanceof AppError)throw error;throw new AppError('요청 내용을 확인하세요.');}}
async function access(device,id){if(!/^[a-f0-9-]{36}$/.test(id))throw new AppError('작업 ID를 확인하세요.');const key=await crypto.subtle.importKey('raw',enc.encode(device),{name:'HMAC',hash:'SHA-256'},false,['sign']);return {id,deviceHash:await hash(device),capabilityHash:await hash(await crypto.subtle.sign('HMAC',key,enc.encode(id)))};}
function clientJob(job){const files=job.files||[];const result={...job,photos:job.photos.map(photo=>({...photo,resultBytes:files.find(f=>f.kind==='result'&&f.photo_id===photo.id&&f.status==='ready'&&f.signature===job.generation?.signatures?.[photo.id])?.bytes||0,hasResult:files.some(f=>f.kind==='result'&&f.photo_id===photo.id&&f.status==='ready'&&f.signature===job.generation?.signatures?.[photo.id])})),progress:0};result.progress=result.photos.filter(p=>!p.excluded&&p.hasResult).length;delete result.files;return result;}
function validateGroups(groups){if(!Array.isArray(groups)||groups.length>30)throw new AppError('구분 그룹은 최대 30개입니다.');const used=new Set();for(const g of groups){if(!/^[a-zA-Z0-9-]{1,60}$/.test(g.id)||used.has(g.id))throw new AppError('그룹 ID가 올바르지 않습니다.');used.add(g.id);for(const k of ['name','equipmentMatch','reason'])if(typeof g[k]!=='string'||!g[k].trim()||g[k].length>150)throw new AppError('그룹 이름·설비 조건·이유를 확인하세요.');if(!Array.isArray(g.options)||g.options.length<2||g.options.length>10||g.options.some(v=>typeof v!=='string'||!v.trim()||v.length>100)||new Set(g.options.map(normalized)).size!==g.options.length)throw new AppError('서로 다른 작업을 2~10개 입력하세요.');g.required=g.required===true;}return groups;}
async function upload(request,client,args,job,photoId,result){
 if(activeUploads>=2)throw new AppError('사진 업로드가 많습니다. 잠시 후 다시 시도하세요.',429);activeUploads++;
 let reservation;
 try{
  const bytes=await body(request,result?LIMITS.result:LIMITS.source);const info=validateImage(bytes,result);
  if(!/^[a-f0-9]{24}$/.test(photoId))throw new AppError('사진 ID를 확인하세요.');
  let meta,signature=null;
  if(result){if(job.state!=='generating')throw new AppError('생성을 다시 시작하세요.',409);signature=job.generation.signatures[photoId];if(!signature)throw new AppError('생성 대상이 아닙니다.');meta={generationId:job.generation.id};}
  else{
   let value;try{value=JSON.parse(decodeURIComponent(request.headers.get('X-Photo-Meta')||''));}catch{throw new AppError('사진 파일 정보를 확인하세요.');}
   const path=safePath(value.path);if(!/\.(jpe?g|png)$/i.test(path)||!path||!/^[a-f0-9]{64}$/.test(value.hash))throw new AppError('사진 파일 정보를 확인하세요.');
   const photo={id:photoId,path,ext:path.slice(path.lastIndexOf('.')).toLowerCase(),hash:value.hash,...infer(path),work:'',equipmentType:'',confirmed:false,excluded:false,rotation:0,measurementScene:false,hasExistingPlate:false,ambiguityChoice:'',ambiguityGroupId:'',duplicate:job.photos.some(p=>p.hash===value.hash)};
   meta={photo};
  }
  const fileId=crypto.randomUUID(),path=`${job.id}/${photoId}/${fileId}${info.mime==='image/png'?'.png':'.jpg'}`;
  const data={...args,fileId,photoId,kind:result?'result':'source',path,bytes:bytes.length,signature,meta,revision:Number(request.headers.get('X-Revision'))};
  await client.rpc('file_reserve',data);reservation=data;
  await client.request(`/storage/v1/object/${BUCKET}/${path}`,{method:'POST',headers:{'Content-Type':info.mime,'x-upsert':'false'},body:bytes});
  const saved=await client.rpc('file_finalize',{...args,fileId});return json(clientJob(saved));
 }catch(error){
  if(reservation){try{const abandoned=await client.rpc('file_abandon',{...args,fileId:reservation.fileId});await storageDelete(client,abandoned);}catch{/* Keep the reservation: scheduled cleanup retries, quota stays charged. */}}
  throw error;
 }finally{activeUploads--;}
}
export async function freeGateway(request,env,fetcher=fetch){
 try{
  const url=new URL(request.url),path=url.pathname;
  if(!['GET','POST'].includes(request.method))throw new AppError('허용되지 않은 요청 방식입니다.',405);
  if(!env.PUBLIC_ORIGIN)throw new AppError('웹 주소 설정이 아직 완료되지 않았습니다.',503);
  if(new URL(env.PUBLIC_ORIGIN).origin!==url.origin)throw new AppError('이 주소에서는 업무 서버를 사용할 수 없습니다.',403);
  if(request.method==='POST'&&request.headers.get('Origin')!==url.origin)throw new AppError('다른 사이트의 요청은 허용하지 않습니다.',403);
  const client=new SupabaseClient(env,fetcher),jar=cookies(request);
  if(path==='/api/logout'&&request.method==='POST'){if(/^[a-f0-9]{64}$/.test(jar.np_session||''))await client.rpc('session_delete',{tokenHash:await hash(jar.np_session)});return json({ok:true},200,{'Set-Cookie':cookie('np_session','',0)});}
  if(path==='/api/login'&&request.method==='POST'){
   const input=await readJson(request),role=input.role;
   if(!['worker','admin'].includes(role)||typeof input.password!=='string'||input.password.length>128)throw new AppError('비밀번호를 확인하세요.',401);
   const email=env[role==='admin'?'ADMIN_EMAIL':'WORKER_EMAIL']?.trim(),userId=env[role==='admin'?'ADMIN_USER_ID':'WORKER_USER_ID']?.trim();
   if(!email||!userId||!env.SUPABASE_ANON_KEY)throw new AppError('로그인 계정 설정이 아직 완료되지 않았습니다.',503);
   const identity=await hash((request.headers.get('CF-Connecting-IP')||'unknown')+':'+role);await client.rpc('login_check',{identity});
   const auth=await fetcher.call(globalThis,new URL('/auth/v1/token?grant_type=password',client.url).toString(),{method:'POST',headers:{apikey:env.SUPABASE_ANON_KEY,'Content-Type':'application/json'},body:JSON.stringify({email,password:input.password}),redirect:'manual'});
   const credentials=await auth.json();if(auth.ok&&credentials.user?.id!==userId)throw new AppError('로그인 인증은 성공했지만 사용자 ID 설정이 일치하지 않습니다. 관리자에게 Cloudflare 계정 설정 확인을 요청하세요.',503);if(!auth.ok){if(auth.status===429)throw new AppError('인증 서버의 로그인 요청 한도에 도달했습니다. 잠시 후 다시 시도하세요.',429);if(auth.status>=500)throw new AppError('인증 서버가 일시적으로 응답하지 않습니다.',503);if(credentials.error_code==='email_not_confirmed')throw new AppError('로그인 계정의 이메일 확인을 완료하세요.',403);if(auth.status===401||auth.status===403)throw new AppError('인증 API 키 또는 이메일 로그인 허용 설정을 확인하세요.',503);await client.rpc('login_failed',{identity});throw new AppError('비밀번호를 확인하세요.',401);}
   const session=random(),device=/^[a-f0-9]{64}$/.test(jar.np_device||'')?jar.np_device:random();
   await client.rpc('session_create',{tokenHash:await hash(session),role,userId,identity});
   const response=json({role});response.headers.append('Set-Cookie',cookie('np_session',session,43200));response.headers.append('Set-Cookie',cookie('np_device',device,31536000));return response;
  }
  if(!/^[a-f0-9]{64}$/.test(jar.np_session||'')||!/^[a-f0-9]{64}$/.test(jar.np_device||''))throw new AppError('로그인이 필요합니다.',401);
  const session=await client.rpc('session_get',{tokenHash:await hash(jar.np_session)});
  if(session.userId!==env[session.role==='admin'?'ADMIN_USER_ID':'WORKER_USER_ID']?.trim())throw new AppError('로그인이 필요합니다.',401);
  const admin=()=>{if(session.role!=='admin')throw new AppError('관리자 권한이 필요합니다.',403);};
  const cfg=await client.rpc('config_get');
  if(['/api/work-types','/api/ambiguity-groups','/api/revoke','/api/worker-password'].includes(path)&&request.method!=='POST')throw new AppError('POST 요청만 허용됩니다.',405);
  if(path==='/api/settings'){
   if(request.method==='GET')return json({project:DEFAULT_PROJECT,projects:[DEFAULT_PROJECT,...(cfg.extraProjects||[])],workTypes:effectiveWorkTypes(cfg,await client.learningRpc('candidates')),workAliases:WORK_ALIASES,ambiguityGroups:cfg.ambiguityGroups,role:session.role,processingMode:'browser',aiConfigured:aiConfigured(env),aiModel:visionModel(env),aiPromptVersion:PROMPT_VERSION,learningEnabled:cfg.autoLearnConfirmed!==false,aiTrialUnlimited:cfg.aiTrialUnlimited===true,aiDailyLimit:cfg.aiTrialUnlimited===true?null:dailyLimit(env,cfg),aiTotalLimit:cfg.aiTrialUnlimited===true?null:totalLimit(env,cfg),aiBudgetKrw:cfg.aiTrialUnlimited===true?null:30000,storageBytes:cfg.storageBytes,storageLimit:cfg.storageLimit,limits:LIMITS});
   admin();const value=await readJson(request);const aiDailyLimit=value.aiDailyLimit??dailyLimit(env,cfg);if(!Number.isInteger(aiDailyLimit)||aiDailyLimit<1||aiDailyLimit>200)throw new AppError('하루 AI 호출 한도는 1~200회입니다.');const projects=value.extraProjects??cfg.extraProjects??[];if(!Array.isArray(projects)||projects.length>30||projects.some(v=>typeof v!=='string'||!v.trim()||v.length>150||/[\x00-\x1f]/.test(v)))throw new AppError('추가 공사명은 한 줄에 하나씩, 최대 30개를 입력하세요.');const extraProjects=[...new Set(projects.map(v=>v.trim()).filter(v=>v!==DEFAULT_PROJECT))];await client.rpc('config_set',{project:DEFAULT_PROJECT,extraProjects,aiDailyLimit});return json({project:DEFAULT_PROJECT,projects:[DEFAULT_PROJECT,...extraProjects],aiDailyLimit});
  }
  if(path==='/api/work-types'){admin();const {workTypes}=await readJson(request);if(!Array.isArray(workTypes)||!workTypes.length||workTypes.length>500||workTypes.some(v=>typeof v!=='string'||!v.trim()||v.length>100||/[\x00-\x1f]/.test(v))||new Set(workTypes.map(normalized)).size!==workTypes.length)throw new AppError('중복 없이 작업명을 1~500개 입력하세요.');const canonical=uniqueWorks(workTypes);if(!canonical.length)throw new AppError('구체적인 작업명을 하나 이상 입력하세요.');await client.rpc('config_set',{workTypes:canonical});return json({workTypes:canonical});}
  if(path==='/api/ambiguity-groups'){admin();const groups=validateGroups((await readJson(request)).groups);await client.rpc('config_set',{ambiguityGroups:groups});return json({groups});}
  if(path==='/api/revoke'){admin();await client.rpc('sessions_revoke',{all:true});return json({ok:true});}
  if(path==='/api/worker-password'){admin();const {password}=await readJson(request);if(typeof password!=='string'||password.length<12||password.length>128)throw new AppError('비밀번호는 12~128자로 입력하세요.');await client.request(`/auth/v1/admin/users/${env.WORKER_USER_ID}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});await client.rpc('sessions_revoke',{all:false});return json({ok:true});}
  if(path==='/api/maintenance'&&request.method==='GET'){admin();return json(await client.maintenanceRpc('status'));}
  if(path.startsWith('/api/references')||path==='/api/ai-usage'||path==='/api/ai-status'||path==='/api/learning-summary')return await referenceRoute({path,request,client,admin,readJson,body,json,env,fetcher});
  if(path==='/api/jobs'){
   if(request.method==='GET')return json(await client.rpc('jobs_list',{deviceHash:await hash(jar.np_device)}));
   const id=crypto.randomUUID(),args=await access(jar.np_device,id);return json(clientJob(await client.rpc('job_create',args)));
  }
  const match=path.match(/^\/api\/jobs\/([a-f0-9-]{36})(?:\/([a-z-]+)(?:\/([a-f0-9]{24}))?)?$/);if(!match)throw new AppError('요청 경로를 확인하세요.',404);
  const [,id,action,photoId]=match,args=await access(jar.np_device,id);
  if(action==='finish'&&request.method==='POST'){
   const files=await client.rpc('job_delete',args);try{await storageDelete(client,files);await client.rpc('cleanup_list');}catch{throw new AppError('삭제가 지연되고 있습니다. 저장 완료를 다시 누르면 재시도합니다. 정기 정리에서도 다시 처리합니다.',503);}return json({ok:true});
  }
  const job=await client.rpc('job_get',args);
  if(action==='learn')return await learningRoute({request,client,job,photoId,cfg,body,json});
  if(!action)return json(clientJob(url.searchParams.get('touch')==='1'?await client.rpc('job_touch',args):job));
  if(action==='source'&&request.method==='POST')return await upload(request,client,args,job,photoId,false);
  if(action==='result-upload'&&request.method==='POST')return await upload(request,client,args,job,photoId,true);
  if(['image','result'].includes(action)&&request.method==='GET'){
   const kind=action==='image'?'source':'result';if(kind==='result'&&!['ready','generating'].includes(job.state))throw new AppError('명판을 먼저 생성하세요.',409);
   const file=job.files.find(f=>f.photo_id===photoId&&f.kind===kind&&(kind==='source'||f.signature===job.generation?.signatures?.[photoId]));if(!file)throw new AppError('해당 사진이 없거나 아직 생성되지 않았습니다.',404);
   if(kind==='result'&&(url.searchParams.has('download')||request.headers.get('X-User-Activity')==='download'))await client.rpc('job_touch',args);
   const upstream=await client.request(`/storage/v1/object/${BUCKET}/${file.object_path}`);const response=new Response(upstream.body,{headers:{'Content-Type':file.object_path.endsWith('.png')?'image/png':'image/jpeg','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
   if(kind==='result'&&url.searchParams.has('download')){const p=job.photos.find(p=>p.id===photoId);response.headers.set('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(p.path.split('/').at(-1).replace(/\.[^.]+$/,'.jpg')));}return response;
  }
  if(action==='save'&&request.method==='POST'){
   const input=await readJson(request);if(!Array.isArray(input.photos))throw new AppError('사진 정보를 확인하세요.');const incoming=new Map(input.photos.map(p=>[p.id,p]));const photos=job.photos.map(p=>safePhotoUpdate(p,incoming.get(p.id)||p));const project=input.project??job.project??DEFAULT_PROJECT;if(typeof project!=='string'||!project.trim()||project.length>150||/[\x00-\x1f]/.test(project))throw new AppError('공사명을 확인하세요.');const payload={...job,photos,project:project.trim()};for(const key of ['id','revision','state','expiresAt','files'])delete payload[key];
   return json(clientJob(await client.rpc('job_save',{...args,revision:input.revision,payload})));
  }
  if(action==='warnings'&&request.method==='POST'){const {warnings}=await readJson(request,1500000);if(!Array.isArray(warnings)||warnings.length>2000||warnings.some(v=>typeof v!=='string'||v.length>700))throw new AppError('업로드 결과 정보를 확인하세요.');return json(clientJob(await client.rpc('job_warnings',{...args,warnings})));}
  if(action==='generate'&&request.method==='POST'){
   if(job.state==='generating')return json(clientJob(job));validateConfirmed(job.photos,cfg.ambiguityGroups);
   const project=job.project||DEFAULT_PROJECT;const signatures={};for(const photo of job.photos.filter(p=>!p.excluded))signatures[photo.id]=await fingerprint(photo,project);
   return json(clientJob(await client.rpc('generation_begin',{...args,revision:job.revision,generation:{id:crypto.randomUUID(),project,profile:PROFILE,signatures}})));
  }
  if(action==='pause'&&request.method==='POST')return json(clientJob(await client.rpc('generation_pause',args)));
  if(action==='complete'&&request.method==='POST')return json(clientJob(await client.rpc('generation_complete',args)));
  if(action==='analyse'&&photoId&&request.method==='POST')return json(clientJob(await analysePhoto({request,env,client,job,photoId,args,body,fetcher})));
  if(action==='analyse')throw new AppError('무료 MVP의 AI 연결은 아직 설정되지 않았습니다. 작업 내용을 직접 입력하세요.',503);
  throw new AppError('요청 경로를 확인하세요.',404);
 }catch(error){return json({error:error instanceof AppError||error instanceof ValidationError?error.message:'요청을 처리하지 못했습니다. 입력값과 서버 연결 상태를 확인하세요.'},error instanceof AppError?error.status:400);}
}
