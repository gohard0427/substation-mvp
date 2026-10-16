import io,json,os,tempfile,time,unittest,zipfile
from unittest.mock import patch
from PIL import Image
# The first imported test module must never open the developer's real data.
os.environ['DATA_DIR']=tempfile.mkdtemp(prefix='substation-asgi-tests-')
import server,asgi
from starlette.testclient import TestClient

SECRET='test-only-private-proxy-secret-32-characters'
class ASGI(unittest.TestCase):
 def setUp(self):
  self.config=patch.dict(os.environ,{'EDGE_PROXY_SECRET':SECRET,'WORKER_PASSWORD':'worker-test-password','ADMIN_PASSWORD':'admin-test-password','COOKIE_SECURE':'1','DEPLOYMENT_MODE':'1'})
  self.config.start()
  self.context=TestClient(asgi.app,base_url='https://backend.example.com');self.client=self.context.__enter__()
  self.headers={'X-Edge-Proxy-Secret':SECRET,'Origin':'https://backend.example.com','X-Edge-Client-IP':'test-asgi'}
 def tearDown(self):self.context.__exit__(None,None,None);self.config.stop()
 def login(self):
  response=self.client.post('/api/login',json={'role':'worker','password':'worker-test-password'},headers=self.headers)
  self.assertEqual(response.status_code,200,response.text);self.assertEqual(len(response.headers.get_list('set-cookie')),2)
  self.assertTrue(all('Secure' in v and 'HttpOnly' in v for v in response.headers.get_list('set-cookie')))
  return response
 def test_private_api_and_health(self):
  self.assertEqual(self.client.get('/healthz').status_code,200)
  self.assertEqual(self.client.get('/api/settings').status_code,401)
  bad=dict(self.headers,**{'X-Edge-Proxy-Secret':'forged'})
  self.assertEqual(self.client.post('/api/login',json={'role':'worker','password':'worker-test-password'},headers=bad).status_code,401)
  self.login();self.assertEqual(self.client.get('/api/settings',headers=self.headers).status_code,200)
 def test_chunked_upload_generate_download_and_delete(self):
  self.login();image=io.BytesIO();Image.new('RGB',(800,600),'blue').save(image,'JPEG');zipped=io.BytesIO()
  with zipfile.ZipFile(zipped,'w') as z:z.writestr('20261016_위치_GIS/사진.jpg',image.getvalue())
  raw=zipped.getvalue()
  def chunks():
   for i in range(0,len(raw),1024):yield raw[i:i+1024]
  response=self.client.post('/api/upload',content=chunks(),headers=self.headers)
  self.assertEqual(response.status_code,200,response.text);job=response.json();job['photos'][0].update(work='점검',confirmed=True)
  saved=self.client.post(f'/api/jobs/{job["id"]}/save',json={'photos':job['photos'],'revision':job['revision']},headers=self.headers);self.assertEqual(saved.status_code,200,saved.text)
  response=self.client.post(f'/api/jobs/{job["id"]}/generate',json={},headers=self.headers);self.assertEqual(response.status_code,200,response.text)
  for _ in range(150):
   job=self.client.get(f'/api/jobs/{job["id"]}',headers=self.headers).json()
   if job['state'] not in ['queued','generating']:break
   time.sleep(.02)
  self.assertEqual(job['state'],'ready')
  response=self.client.get(f'/api/jobs/{job["id"]}/download?date=2026-10-16',headers=self.headers)
  self.assertEqual(response.status_code,200);self.assertIn('attachment',response.headers['content-disposition'])
  with zipfile.ZipFile(io.BytesIO(response.content)) as z:self.assertEqual(z.namelist(),['20261016_위치_GIS/사진.jpg'])
  response=self.client.post(f'/api/jobs/{job["id"]}/finish',json={},headers=self.headers);self.assertEqual(response.status_code,200)
  self.assertFalse((server.DATA/job['id']).exists())
 def test_actual_size_limit_for_chunked_requests(self):
  self.login()
  with patch.object(server,'MAX_UPLOAD',64):
   response=self.client.post('/api/upload',content=iter([b'x'*40,b'y'*40]),headers=self.headers)
  self.assertEqual(response.status_code,413)
 def test_login_rate_limit(self):
  headers=dict(self.headers,**{'X-Edge-Client-IP':'test-rate-limit'})
  with patch.dict(os.environ,{'LOGIN_MAX_ATTEMPTS':'2'}):
   for _ in range(2):self.assertEqual(self.client.post('/api/login',json={'role':'worker','password':'wrong'},headers=headers).status_code,401)
   response=self.client.post('/api/login',json={'role':'worker','password':'worker-test-password'},headers=headers)
  self.assertEqual(response.status_code,429)
 def test_production_refuses_missing_secret(self):
  with patch.dict(os.environ,{'EDGE_PROXY_SECRET':''}):
   with self.assertRaisesRegex(RuntimeError,'EDGE_PROXY_SECRET'):
    with TestClient(asgi.app):pass

 def test_unauthorized_upload_rejected_before_reading_body(self):
  consumed=[]
  def content():consumed.append(True);yield b'private bytes'
  response=self.client.post('/api/upload',content=content())
  self.assertEqual(response.status_code,401);self.assertFalse(consumed)
