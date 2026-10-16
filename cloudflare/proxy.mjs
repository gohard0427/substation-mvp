// All configuration below is server-side Pages Functions configuration.
export const UPLOAD_LIMIT = 90 * 1024 * 1024;
function error(message, status) {
  return Response.json({error:message}, {status, headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}
export async function proxy(request, env, fetcher = fetch) {
  const incoming = new URL(request.url);
  if (!['GET','POST'].includes(request.method)) return error('허용되지 않은 요청 방식입니다.',405);
  let backend;
  try {
    backend = new URL(env.BACKEND_URL);
    if (backend.protocol !== 'https:' || backend.username || backend.password || backend.pathname !== '/' || backend.search || backend.hash || backend.origin === incoming.origin) throw Error();
    if (env.PUBLIC_ORIGIN && new URL(env.PUBLIC_ORIGIN).origin !== incoming.origin) return error('이 배포 주소에서는 업무 서버에 연결할 수 없습니다.',403);
  } catch { return error('서버 연결 설정이 아직 완료되지 않았습니다.',503); }
  if (!env.EDGE_PROXY_SECRET || env.EDGE_PROXY_SECRET.length < 32) return error('서버 연결 설정이 아직 완료되지 않았습니다.',503);
  if (!incoming.pathname.startsWith('/api/')) return error('잘못된 API 경로입니다.',404);
  if (request.method === 'POST' && request.headers.get('Origin') !== incoming.origin) return error('다른 사이트에서 보낸 요청은 허용하지 않습니다.',403);
  const length = request.headers.get('Content-Length');
  if (length && (!/^\d+$/.test(length) || Number(length) > UPLOAD_LIMIT)) return error('웹 업로드는 파일당 최대 90MiB입니다. ZIP을 나누어 올려 주세요.',413);
  const headers = new Headers();
  for (const name of ['Accept','Content-Type','X-Filename','Cookie']) {
    const value = request.headers.get(name); if (value) headers.set(name,value);
  }
  headers.set('Origin',backend.origin);
  headers.set('X-Edge-Proxy-Secret',env.EDGE_PROXY_SECRET);
  headers.set('X-Edge-Client-IP',request.headers.get('CF-Connecting-IP') || 'unknown');
  let exceeded = false, bytes = 0;
  let body;
  if (request.method === 'POST' && request.body) {
    body = request.body.pipeThrough(new TransformStream({transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > UPLOAD_LIMIT) { exceeded = true; throw Error('upload limit'); }
      controller.enqueue(chunk);
    }}));
  }
  const target = new URL(incoming.pathname + incoming.search,backend.origin);
  try {
    // Body is streamed; the ASGI server accepts chunked requests. Redirects must
    // never carry our private proxy secret to a different upstream origin.
    const upstream = await fetcher(target.toString(), {method:request.method,headers,body,redirect:'manual',duplex:'half'});
    if (upstream.status >= 300 && upstream.status < 400) return error('업무 서버의 응답 주소가 올바르지 않습니다.',502);
    const response = new Response(upstream.body,upstream);
    response.headers.set('Cache-Control','no-store');
    response.headers.set('X-Content-Type-Options','nosniff');
    response.headers.delete('Server');
    return response;
  } catch {
    return error(exceeded ? '웹 업로드는 파일당 최대 90MiB입니다.' : '업무 서버에 연결하지 못했습니다. 잠시 후 다시 시도하세요.',exceeded ? 413 : 502);
  }
}
