"""ASGI adapter for the existing tested MVP API; one process per data directory."""
import os, tempfile, threading
from contextlib import asynccontextmanager
from email.message import Message
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Route
import anyio
import server

class BridgeHandler(server.Handler):
 def __init__(self,method,path,headers,body,output,client):
  self.command=method;self.path=path;self.headers=headers;self.rfile=body;self.wfile=output
  self.client_address=client;self.request_version='HTTP/1.1';self.status=200;self.response_headers=[]
 def send_response(self,code,message=None): self.status=code
 def send_header(self,name,value): self.response_headers.append((name.lower().encode('latin-1'),str(value).encode('latin-1')))
 def end_headers(self): pass

def invoke(method,path,headers,body,client):
 output=tempfile.SpooledTemporaryFile(max_size=2*1024*1024)
 try:
  handler=BridgeHandler(method,path,headers,body,output,client)
  (handler.do_GET if method=='GET' else handler.do_POST)()
  length=output.tell();output.seek(0)
  return handler.status,handler.response_headers,length,output
 except BaseException:
  output.close();raise

def stream_file(output):
 try:
  while chunk:=output.read(64*1024):yield chunk
 finally:output.close()

async def endpoint(request:Request):
 if request.method not in ['GET','POST']:return JSONResponse({'error':'허용되지 않은 요청 방식입니다.'},status_code=405)
 headers=Message()
 for key,value in request.headers.items():
  if key.lower() not in ['content-length','transfer-encoding']:headers[key]=value
 if request.url.path.startswith('/api/'):
  def preauthorize():
   handler=object.__new__(server.Handler);handler.headers=headers;handler.require_proxy()
   if request.method=='POST' and request.url.path!='/api/login':handler.auth()
  try:await anyio.to_thread.run_sync(preauthorize)
  except PermissionError:return JSONResponse({'error':'로그인 또는 서버 접근 권한을 확인하세요.'},status_code=401,headers={'Cache-Control':'no-store'})
 body=tempfile.SpooledTemporaryFile(max_size=2*1024*1024)
 try:
  supplied=request.headers.get('content-length')
  if supplied and (not supplied.isdigit() or int(supplied)>server.MAX_UPLOAD):return JSONResponse({'error':'업로드 용량 제한을 초과했습니다.'},status_code=413)
  count=0
  async for chunk in request.stream():
   count+=len(chunk)
   if count>server.MAX_UPLOAD:return JSONResponse({'error':'업로드 용량 제한을 초과했습니다.'},status_code=413)
   body.write(chunk)
  body.seek(0)
  # The existing handler expects a length; chunked input has now been bounded
  # and spooled to disk instead of being buffered by the edge function.
  headers['Content-Length']=str(count)
  path=request.url.path+('?' + request.url.query if request.url.query else '')
  client=(request.client.host,request.client.port) if request.client else ('unknown',0)
  status,response_headers,length,output=await anyio.to_thread.run_sync(invoke,request.method,path,headers,body,client)
 finally:body.close()
 response=StreamingResponse(stream_file(output),status_code=status)
 response.raw_headers=response_headers+[(b'content-length',str(length).encode())]
 return response

async def health(request):return JSONResponse({'status':'ok'},headers={'Cache-Control':'no-store'})

@asynccontextmanager
async def lifespan(app):
 if os.environ.get('DEPLOYMENT_MODE')=='1':
  for key,minimum in [('ADMIN_PASSWORD',12),('WORKER_PASSWORD',12),('EDGE_PROXY_SECRET',32)]:
   if len(os.environ.get(key,''))<minimum:raise RuntimeError(f'{key} 설정이 필요합니다. 비밀 값은 서버 환경변수에만 입력하세요.')
  if os.environ.get('COOKIE_SECURE')!='1':raise RuntimeError('HTTPS 배포는 COOKIE_SECURE=1이 필요합니다.')
 server.init();server.cleanup();worker_stop,worker=server.start_worker()
 janitor_stop=threading.Event();janitor=threading.Thread(target=server.janitor,args=(janitor_stop,),daemon=True);janitor.start()
 try:yield
 finally:
  worker_stop.set();janitor_stop.set()
  await anyio.to_thread.run_sync(worker.join,100)
  await anyio.to_thread.run_sync(janitor.join,2)

app=Starlette(routes=[Route('/healthz',health),Route('/{path:path}',endpoint,methods=['GET','POST','HEAD','PUT','DELETE','PATCH','OPTIONS'])],lifespan=lifespan)
