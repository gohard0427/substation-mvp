import {test} from 'node:test';
import assert from 'node:assert/strict';
import {proxy,UPLOAD_LIMIT} from '../cloudflare/proxy.mjs';
const env={BACKEND_URL:'https://substation-api.example.com',EDGE_PROXY_SECRET:'test-only-proxy-secret-32-characters',PUBLIC_ORIGIN:'https://photos.example.com'};
const request=(path='/api/jobs',options={})=>new Request('https://photos.example.com'+path,options);
test('proxy configuration and preview deployment fail closed',async()=>{
  let calls=0;const fetcher=async()=>{calls++;return new Response('ok');};
  assert.equal((await proxy(request(),{},fetcher)).status,503);
  assert.equal((await proxy(request(),{...env,BACKEND_URL:'http://insecure.example.com'},fetcher)).status,503);
  assert.equal((await proxy(new Request('https://preview.example.com/api/jobs'),env,fetcher)).status,403);
  assert.equal(calls,0);
});
test('cross-site and missing-origin mutations are rejected',async()=>{
  for(const headers of [{},{Origin:'https://other.example.com'}]){
    const result=await proxy(request('/api/login',{method:'POST',headers,body:'{}'}),env,()=>{throw Error('must not call');});
    assert.equal(result.status,403);
  }
});
test('login body, cookies and original filenames survive the private relay',async()=>{
  const response=await proxy(request('/api/login',{method:'POST',headers:{Origin:env.PUBLIC_ORIGIN,Cookie:'device=old','Content-Type':'application/json','X-Edge-Proxy-Secret':'spoofed'},body:'{"password":"test-only"}'}),env,async(url,options)=>{
    assert.equal(url,env.BACKEND_URL+'/api/login');
    assert.equal(options.headers.get('Origin'),env.BACKEND_URL);
    assert.equal(options.headers.get('Cookie'),'device=old');
    assert.equal(options.headers.get('X-Edge-Proxy-Secret'),env.EDGE_PROXY_SECRET);
    assert.equal(options.redirect,'manual');
    assert.equal(await new Response(options.body).text(),'{"password":"test-only"}');
    const headers=new Headers({'Content-Type':'application/json'});
    headers.append('Set-Cookie','session=test-only; Secure; HttpOnly; SameSite=Strict; Path=/');
    headers.append('Set-Cookie','device=test-only; Secure; HttpOnly; SameSite=Strict; Path=/');
    return new Response('{"role":"worker"}',{headers});
  });
  assert.equal(response.status,200);assert.equal(response.headers.getSetCookie().length,2);
  assert.equal(response.headers.get('Cache-Control'),'no-store');
});
test('date ZIP response keeps attachment headers and streams bytes unchanged',async()=>{
  const content=new Uint8Array([80,75,3,4,1,2]);
  const result=await proxy(request('/api/jobs/test/download?date=2026-10-16'),env,async(url)=>{
    assert.equal(url,env.BACKEND_URL+'/api/jobs/test/download?date=2026-10-16');
    return new Response(content,{headers:{'Content-Type':'application/zip','Content-Disposition':"attachment; filename*=UTF-8''photos.zip"}});
  });
  assert.match(result.headers.get('Content-Disposition'),/attachment/);
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()),content);
});
test('declared and chunked uploads obey the same 90MiB cap',async()=>{
  const known=await proxy(request('/api/upload',{method:'POST',headers:{Origin:env.PUBLIC_ORIGIN,'Content-Length':String(UPLOAD_LIMIT+1)},body:'x'}),env,()=>{throw Error('must not call');});
  assert.equal(known.status,413);
  let index=0;const chunk=new Uint8Array(1024*1024);
  const stream=new ReadableStream({pull(controller){if(index++<91)controller.enqueue(chunk);else controller.close();}});
  const result=await proxy(request('/api/upload',{method:'POST',headers:{Origin:env.PUBLIC_ORIGIN},body:stream,duplex:'half'}),env,async(url,options)=>{
    const reader=options.body.getReader();while(!(await reader.read()).done){}return new Response('ok');
  });
  assert.equal(result.status,413);
});
test('redirect and upstream failure do not disclose backend details or secrets',async()=>{
  for(const fetcher of [async()=>new Response(null,{status:302,headers:{Location:'https://another.example.com'}}),async()=>{throw Error(env.EDGE_PROXY_SECRET);}]){
    const result=await proxy(request(),env,fetcher);assert.equal(result.status,502);
    const text=await result.text();assert.ok(!text.includes(env.EDGE_PROXY_SECRET));assert.ok(!text.includes('another.example.com'));
  }
});
