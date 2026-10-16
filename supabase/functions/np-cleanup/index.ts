import {SupabaseClient} from '../../../cloudflare/supabase-client.mjs';
import {sweep} from '../_shared/cleanup.mjs';
Deno.serve(async (request:Request) => {
 const url=Deno.env.get('SUPABASE_URL'),key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
 if(!key || request.method!=='POST' || request.headers.get('Authorization')!=='Bearer '+key)return Response.json({error:'Forbidden'},{status:403});
 try{return Response.json(await sweep(new SupabaseClient({SUPABASE_URL:url,SUPABASE_SERVICE_ROLE_KEY:key})),{headers:{'Cache-Control':'no-store'}});}
 catch{return Response.json({error:'Cleanup failed; reservations retained for retry.'},{status:503});}
});
