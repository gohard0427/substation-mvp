import {sweep,BUCKET} from './cleanup.mjs';
import {hash} from '../../../shared/free-model.mjs';
export async function maintenanceHandler(request,client,probeBytes){
 const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
 if(request.method!=='POST')return Response.json({error:'Forbidden'},{status:403,headers});
 const token=request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
 if(!token)return Response.json({error:'Forbidden'},{status:403,headers});
 try{
  const auth=await client.maintenanceRpc('authorize',{tokenHash:await hash(token)});if(!auth.authorized)return Response.json({error:'Forbidden'},{status:403,headers});
  let options={};const raw=await request.text();if(raw.length>1024)return Response.json({error:'Body too large'},{status:413,headers});if(raw)options=JSON.parse(raw);
  let probe;if(options.selfTest===true){
   probe=await client.maintenanceRpc('probe_prepare',{bytes:probeBytes.length});
   await client.request(`/storage/v1/object/${BUCKET}/${probe.path}`,{method:'POST',headers:{'Content-Type':'image/jpeg','x-upsert':'false'},body:probeBytes});
   await client.request(`/storage/v1/object/${BUCKET}/${probe.path}`);
  }
  const result=await sweep(client);
  if(probe){
   const status=await client.maintenanceRpc('probe_status',probe);let objectGone=false;
   try{await client.request(`/storage/v1/object/${BUCKET}/${probe.path}`);}catch(error){objectGone=error.upstreamStatus===404||error.upstreamStatus===400;}
   result.selfTest={...status,objectGone};if(!status.jobGone||!status.fileGone||!objectGone)throw Error('Cleanup probe failed');
  }
  await client.maintenanceRpc('complete',result);return Response.json(result,{headers});
 }catch{return Response.json({error:'Cleanup failed; reservations retained for retry.'},{status:503,headers});}
}
