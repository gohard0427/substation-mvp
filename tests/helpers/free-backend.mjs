import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {freeGateway} from '../../cloudflare/free-api.mjs';
export async function backend({visionResult}={}){
 const db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');await db.exec(await readFile('supabase/migrations/001_free_mvp.sql','utf8'));
 await db.exec(await readFile('supabase/schema/ai-reference.sql','utf8'));await db.exec(await readFile('supabase/schema/ai-trial-limit.sql','utf8'));await db.exec(await readFile('supabase/schema/maintenance.sql','utf8'));
 const maintenanceRpc=async(action,data={})=>(await db.query('select public.np_maintenance_rpc($1,$2::jsonb) as data',[action,JSON.stringify(data)])).rows[0].data;
 const aiRpc=async(action,data={})=>(await db.query('select public.np_ai_rpc($1,$2::jsonb) as data',[action,JSON.stringify(data)])).rows[0].data;
 const externalCalls=[];
 const objects=new Map(),env={SUPABASE_URL:'https://test-project.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test-only-server-key',SUPABASE_ANON_KEY:'test-only-anon-key',WORKER_EMAIL:'worker@example.com',ADMIN_EMAIL:'admin@example.com',WORKER_USER_ID:'00000000-0000-4000-8000-000000000001',ADMIN_USER_ID:'00000000-0000-4000-8000-000000000002',PUBLIC_ORIGIN:'https://photos.example.com'};
 const rpc=async(action,data={})=>(await db.query('select public.np_rpc($1,$2::jsonb) as data',[action,JSON.stringify(data)])).rows[0].data;
 async function fetcher(url,options={}){
  const path=new URL(url).pathname,headers=new Headers(options.headers);
  if(new URL(url).hostname==='api.openai.com'){externalCalls.push(JSON.parse(options.body));return Response.json({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(visionResult)}]}],usage:{input_tokens:100,output_tokens:30}});}
  if(path==='/auth/v1/token'){
   const input=JSON.parse(options.body),role=input.email.startsWith('admin')?'ADMIN':'WORKER';
   if(input.password!=='test-only-password')return Response.json({error:'invalid credentials'},{status:400});return Response.json({user:{id:env[role+'_USER_ID']},access_token:'never-exposed',refresh_token:'never-exposed'});
  }
  if(headers.get('apikey')!==env.SUPABASE_SERVICE_ROLE_KEY)return Response.json({error:'not authorized'},{status:401});
  if(path==='/rest/v1/rpc/np_rpc'||path==='/rest/v1/rpc/np_ai_rpc'||path==='/rest/v1/rpc/np_maintenance_rpc'){
   try{const input=JSON.parse(options.body);return Response.json(await (path.endsWith("np_ai_rpc")?aiRpc:path.endsWith("np_maintenance_rpc")?maintenanceRpc:rpc)(input.p_action,input.p_data));}
   catch(error){return Response.json({message:error.message,code:error.code},{status:400});}
  }
  if(path.startsWith('/storage/v1/object/np-reference-private/')){const key='reference/'+decodeURIComponent(path.slice('/storage/v1/object/np-reference-private/'.length));if(options.method==='POST'){objects.set(key,new Uint8Array(options.body));return Response.json({Key:key});}if(!objects.has(key))return new Response(null,{status:404});return new Response(objects.get(key));}
  if(path==='/storage/v1/object/np-reference-private'&&options.method==='DELETE'){for(const key of JSON.parse(options.body).prefixes)objects.delete('reference/'+key);return Response.json([]);}
  if(path.startsWith('/storage/v1/object/np-work-private/')){
   const key=decodeURIComponent(path.slice('/storage/v1/object/np-work-private/'.length));
   if(options.method==='POST'){objects.set(key,new Uint8Array(options.body));return Response.json({Key:key});}
   if(!objects.has(key))return Response.json({error:'not found'},{status:404});return new Response(objects.get(key));
  }
  if(path==='/storage/v1/object/np-work-private'&&options.method==='DELETE'){for(const key of JSON.parse(options.body).prefixes)objects.delete(key);return Response.json([]);}
  if(path.startsWith('/auth/v1/admin/users/'))return Response.json({id:env.WORKER_USER_ID});
  throw Error('Unexpected backend request '+path);
 }
 function client(){let jar='';return {
  async request(path,data,headers={}){
   const raw=data instanceof Uint8Array||data instanceof Blob?data:data===undefined?undefined:JSON.stringify(data);
   const request=new Request(env.PUBLIC_ORIGIN+path,{method:data===undefined?'GET':'POST',headers:{Origin:env.PUBLIC_ORIGIN,...(jar?{Cookie:jar}:{}),...headers},body:raw});
   const response=await freeGateway(request,env,fetcher);
   for(const cookie of response.headers.getSetCookie()){const pair=cookie.split(';')[0];const key=pair.split('=')[0];jar=jar.split('; ').filter(v=>v&&!v.startsWith(key+'=')).concat(pair).join('; ');}return response;
  },get cookie(){return jar;},set cookie(value){jar=value;},
  async login(role='worker'){const r=await this.request('/api/login',{role,password:'test-only-password'});if(!r.ok)throw Error(await r.text());return r;}
 };}
 return {db,env,rpc,aiRpc,maintenanceRpc,objects,fetcher,client,externalCalls};
}
