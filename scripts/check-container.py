"""Linux local-Docker smoke test; removes its own temporary container and volume."""
import subprocess,os,json,time,secrets
base=['docker','--host=unix:///var/run/docker.sock'];environment=os.environ.copy()
for key in ['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH']:environment.pop(key,None)
def docker(args,input=None,check=True):
 result=subprocess.run(base+args,input=input,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=environment)
 if check and result.returncode:raise RuntimeError(result.stderr[-2500:])
 return result
name='substation-mvp-deploy-smoke-'+secrets.token_hex(4);volume=name+'-data'
docker(['volume','create',volume])
credentials='\n'.join(['DEPLOYMENT_MODE=1','COOKIE_SECURE=1','ADMIN_PASSWORD='+secrets.token_urlsafe(24),'WORKER_PASSWORD='+secrets.token_urlsafe(24),'EDGE_PROXY_SECRET='+secrets.token_urlsafe(32)])+'\n'
container=None
try:
 container=docker(['run','--detach','--name',name,'--mount',f'type=volume,source={volume},target=/var/data','--env-file','/dev/stdin','substation-mvp:deploy-check'],credentials).stdout.strip()
 def healthy():
  code="import urllib.request;print(urllib.request.build_opener(urllib.request.ProxyHandler({})).open('http://127.0.0.1:8000/healthz',timeout=2).status)"
  for _ in range(40):
   if docker(['exec',container,'python','-c',code],check=False).returncode==0:return
   time.sleep(.25)
  raise RuntimeError('container did not become healthy: '+docker(['logs',container],check=False).stderr[-2500:])
 healthy()
 phase1=r'''
import os,io,json,time,zipfile,urllib.request,urllib.error,http.cookiejar
from PIL import Image
base='http://127.0.0.1:8000';cookies=http.cookiejar.CookieJar();client=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(cookies))
headers={'X-Edge-Proxy-Secret':os.environ['EDGE_PROXY_SECRET'],'Origin':base,'X-Edge-Client-IP':'container-smoke'}
def call(path,data=None):
 raw=data if isinstance(data,bytes) else json.dumps(data).encode() if data is not None else None
 return client.open(urllib.request.Request(base+path,data=raw,headers=headers))
with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(base+'/healthz') as r:assert r.status==200
call('/api/login',{'role':'worker','password':os.environ['WORKER_PASSWORD']}).read()
headers['Cookie']='; '.join(c.name+'='+c.value for c in cookies)
image=io.BytesIO();Image.new('RGB',(1600,1200),'blue').save(image,'JPEG');buffer=io.BytesIO()
with zipfile.ZipFile(buffer,'w') as z:z.writestr('20261016_위치_GIS/사진.jpg',image.getvalue())
job=json.load(call('/api/upload',buffer.getvalue()));job['photos'][0].update(work='점검',confirmed=True)
job=json.load(call('/api/jobs/'+job['id']+'/save',{'photos':job['photos'],'revision':job['revision']}))
call('/api/jobs/'+job['id']+'/generate',{}).read()
for _ in range(200):
 job=json.load(call('/api/jobs/'+job['id']))
 if job['state']=='ready':break
 time.sleep(.02)
assert job['state']=='ready',job
with zipfile.ZipFile(io.BytesIO(call('/api/jobs/'+job['id']+'/download').read())) as z:
 assert z.namelist()==['20261016_위치_GIS/사진.jpg']
 with Image.open(z.open(z.namelist()[0])) as image:assert image.size==(1280,960)
uid=[line for line in open('/proc/1/status') if line.startswith('Uid:')][0].split()[1]
assert uid=='10001',uid
print(json.dumps({'job_id':job['id'],'headers':headers}))
'''
 state=json.loads(docker(['exec','-i',container,'python','-'],phase1).stdout)
 docker(['restart',container]);healthy()
 phase2=r'''
import sys,json,os,urllib.request
from pathlib import Path
state=json.load(sys.stdin);base='http://127.0.0.1:8000';client=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def call(path,data=None):return client.open(urllib.request.Request(base+path,data=data,headers=state['headers']))
job=json.load(call('/api/jobs/'+state['job_id']));assert job['state']=='ready'
response=call('/api/jobs/'+job['id']+'/download?date=2026-10-16');assert response.headers['Content-Type']=='application/zip';response.read()
call('/api/jobs/'+job['id']+'/finish',b'{}').read();assert not (Path(os.environ['DATA_DIR'])/job['id']).exists()
print('Container API, JPEG output, non-root execution, volume/session recovery after restart, and deletion: PASS')
'''
 print(docker(['exec','-i',container,'python','-c',phase2],json.dumps(state)).stdout.strip())
finally:
 if container:docker(['rm','--force',container],check=False)
 docker(['volume','rm',volume],check=False)
