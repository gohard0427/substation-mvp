export const BUCKET='np-work-private';
export async function storageDelete(client,files){
 if(!files.length)return;
 // Deleting metadata before deleting bytes would orphan private photographs.
 await client.request('/storage/v1/object/'+BUCKET,{method:'DELETE',body:JSON.stringify({prefixes:files.map(f=>f.object_path)}),headers:{'Content-Type':'application/json'}});
 await client.rpc('files_forget',{ids:files.map(f=>f.id)});
}
export async function sweep(client){let removed=0;for(let batch=0;batch<5;batch++){const files=await client.rpc('cleanup_list');if(!files.length)break;await storageDelete(client,files);removed+=files.length;}return {removed};}
