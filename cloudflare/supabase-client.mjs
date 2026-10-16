export class AppError extends Error{constructor(message,status=400){super(message);this.status=status;}}
const messages={REFERENCE_NOT_READY:['참고 사본을 연결하고 기기명·작업을 검수하세요.',409],REFERENCE_EXISTS:['이미 연결한 참고 사진입니다.',409],REFERENCE_STORAGE_LIMIT:['참고 사진 저장 한도 100MiB에 도달했습니다.',413],AI_BUSY:['이 작업의 AI 분석이 진행 중입니다. 잠시 후 다시 불러오세요.',409],AI_DAILY_LIMIT:['최근 24시간 AI 호출 한도에 도달했습니다.',429],AUTH_REQUIRED:['로그인이 필요합니다.',401],JOB_ACCESS:['이 기기의 작업 접근 권한이 없습니다.',403],JOB_EXPIRED:['작업이 만료되었거나 삭제 중입니다.',410],REVISION_CONFLICT:['다른 탭에서 작업이 변경되었습니다. 작업을 다시 불러오세요.',409],LOGIN_LIMIT:['로그인 시도가 많습니다. 10분 후 다시 시도하세요.',429],STORAGE_LIMIT:['무료 사진 저장 한도에 도달했습니다. 저장이 끝난 작업을 종료하세요.',413],DEVICE_JOB_LIMIT:['이 기기에서는 최대 3개 작업을 진행할 수 있습니다.',429],PHOTO_LIMIT:['무료 MVP는 작업당 최대 50장입니다.',413],GENERATION_ACTIVE:['사진을 수정하려면 생성 중지를 눌러 주세요.',409],GENERATION_INACTIVE:['생성 상태가 바뀌었습니다. 작업을 다시 불러오세요.',409],RESULT_MISSING:['아직 생성하지 못한 사진이 있습니다.',409],JOB_LIMIT:['진행 중인 작업이 많습니다. 잠시 후 다시 시도하세요.',429]};
export class SupabaseClient{
 constructor(env,fetcher=fetch){
  try{this.url=new URL(env.SUPABASE_URL);if(this.url.protocol!=='https:'||this.url.pathname!=='/'||this.url.username||this.url.password)throw Error();}catch{throw new AppError('무료 서버 연결 설정이 아직 완료되지 않았습니다.',503);}
  if(!env.SUPABASE_SERVICE_ROLE_KEY)throw new AppError('무료 서버 연결 설정이 아직 완료되지 않았습니다.',503);
  this.key=env.SUPABASE_SERVICE_ROLE_KEY;this.fetcher=(input,options)=>fetcher.call(globalThis,input,options);
 }
 async request(path,options={}){
  const headers=new Headers(options.headers);headers.set('apikey',this.key);headers.set('Authorization','Bearer '+this.key);
  let response;try{response=await this.fetcher(new URL(path,this.url).toString(),{...options,headers,redirect:'manual'});}catch(error){const code=/illegal invocation|incorrect.*this/i.test(error.message||'')?'FETCH_RECEIVER':/resolve|dns/i.test(error.message||'')?'DNS':/header/i.test(error.message||'')?'HEADER':/receiver|Illegal invocation|requires.*this/i.test(error.message||'')?'FETCH_RECEIVER':/network connection lost/i.test(error.message||'')?'CONNECTION_LOST':/not a function/i.test(error.message||'')?'FETCH_TYPE':/fetch failed/i.test(error.message||'')?'FETCH_FAILED':/Invalid URL/i.test(error.message||'')?'URL':/redirect/i.test(error.message||'')?'REDIRECT':'NETWORK';throw new AppError('서버 연결에 실패했습니다. 오류 코드: '+code,503);}
  if(!response.ok){let detail={};try{detail=await response.json();}catch{}const entry=messages[detail.message];throw new AppError(entry?.[0]||'서버 요청을 처리하지 못했습니다. 연결 설정 또는 저장 한도를 확인하세요.',entry?.[1]||503);}
  return response;
 }
 async aiRpc(action,data={}){const response=await this.request('/rest/v1/rpc/np_ai_rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p_action:action,p_data:data})});return response.json();}
 async rpc(action,data={}){const response=await this.request('/rest/v1/rpc/np_rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p_action:action,p_data:data})});return response.json();}
}
