import unittest, threading, urllib.request, urllib.error, http.cookiejar, json, io, os, zipfile, time
import server,vision
from unittest.mock import patch
from PIL import Image
class HTTP(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  server.init();os.environ['WORKER_PASSWORD']='test-only-password'
  cls.http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler);cls.base='http://127.0.0.1:'+str(cls.http.server_port)
  threading.Thread(target=cls.http.serve_forever,daemon=True).start()
  cls.stop,cls.worker=server.start_worker()
 @classmethod
 def tearDownClass(cls):
  cls.stop.set();cls.worker.join(5);cls.http.shutdown();cls.http.server_close()
 def client(self):return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
 def req(self,c,path,data=None,headers={}):
  raw=data if isinstance(data,bytes) else json.dumps(data).encode() if data is not None else None
  return c.open(urllib.request.Request(self.base+path,data=raw,headers=headers))
 def test_manual_flow_and_isolation(self):
  a,b=self.client(),self.client()
  for c in [a,b]:self.req(c,'/api/login',dict(role='worker',password='test-only-password')).read()
  img=io.BytesIO();Image.new('RGB',(1600,1200),'blue').save(img,'JPEG')
  z=io.BytesIO()
  with zipfile.ZipFile(z,'w') as archive:archive.writestr('2026-10-16/남시화_GIS/사진.jpg',img.getvalue())
  job=json.load(self.req(a,'/api/upload',z.getvalue()))
  self.assertEqual(json.load(self.req(b,'/api/jobs')),[])
  with self.assertRaises(urllib.error.HTTPError):self.req(b,'/api/jobs/'+job['id'])
  with self.assertRaises(urllib.error.HTTPError):self.req(a,'/api/jobs/'+job['id']+'/generate',{})
  pid=job['photos'][0]['id']
  preview=self.req(a,f'/api/jobs/{job["id"]}/image/{pid}?rotation=1').read()
  with Image.open(io.BytesIO(preview)) as im:self.assertEqual(im.size,(640,480))
  with self.assertRaises(urllib.error.HTTPError):self.req(b,f'/api/jobs/{job["id"]}/image/{pid}')
  with self.assertRaises(urllib.error.HTTPError):self.req(a,f'/api/jobs/{job["id"]}/result/{pid}')
  job['photos'][0].update(work='점검',confirmed=True)
  self.req(a,'/api/jobs/'+job['id']+'/save',{'photos':job['photos'],'revision':job['revision']}).read()
  self.req(a,'/api/jobs/'+job['id']+'/generate',{}).read()
  for _ in range(100):
   j=json.load(self.req(a,'/api/jobs/'+job['id']))
   if j['state'] not in ['queued','generating']:break
   time.sleep(.02)
  self.assertEqual(j['state'],'ready')
  raw=self.req(a,'/api/jobs/'+job['id']+'/download').read()
  with zipfile.ZipFile(io.BytesIO(raw)) as archive:
   self.assertEqual(archive.namelist(),['2026-10-16/남시화_GIS/사진.jpg'])
   with Image.open(archive.open(archive.namelist()[0])) as out:self.assertEqual(out.size,(1280,960))
   result=self.req(a,f'/api/jobs/{job["id"]}/result/{pid}?download=1')
   self.assertIn('attachment',result.headers['Content-Disposition'])
   self.assertEqual(result.read(),archive.read(archive.namelist()[0]))
  with self.assertRaises(urllib.error.HTTPError):self.req(b,f'/api/jobs/{job["id"]}/result/{pid}')
  self.req(a,'/api/jobs/'+job['id']+'/finish',{}).read()
  self.assertFalse((server.DATA/job['id']).exists())
 def login(self,role='worker'):
  c=self.client()
  if role=='admin':os.environ['ADMIN_PASSWORD']='admin-test-only'
  self.req(c,'/api/login',dict(role=role,password='admin-test-only' if role=='admin' else 'test-only-password')).read()
  return c
 def upload(self,c,paths):
  image=io.BytesIO();Image.new('RGB',(800,600),'green').save(image,'JPEG');buffer=io.BytesIO()
  with zipfile.ZipFile(buffer,'w') as z:
   for path in paths:z.writestr(path,image.getvalue())
  return json.load(self.req(c,'/api/upload',buffer.getvalue()))
 def save(self,c,job):return json.load(self.req(c,f'/api/jobs/{job["id"]}/save',dict(photos=job['photos'],revision=job['revision'])))
 def wait_job(self,c,job):
  for _ in range(150):
   current=json.load(self.req(c,f'/api/jobs/{job["id"]}'))
   if current['state'] not in ['analysis_queued','analysing','queued','generating']:return current
   time.sleep(.02)
  self.fail('worker timed out')
 def test_stale_save_and_unchanged_results(self):
  c=self.login();job=self.upload(c,['20261016_위치_GIS/사진.jpg']);old=json.loads(json.dumps(job))
  job['photos'][0].update(work='점검',confirmed=True);job=self.save(c,job)
  with self.assertRaises(urllib.error.HTTPError) as error:self.save(c,old)
  self.assertEqual(error.exception.code,409)
  self.assertEqual(json.load(self.req(c,f'/api/jobs/{job["id"]}'))['photos'][0]['work'],'점검')
  self.req(c,f'/api/jobs/{job["id"]}/generate',{}).read();job=self.wait_job(c,job)
  unchanged=self.save(c,job);self.assertEqual(unchanged['state'],'ready');self.assertEqual(unchanged['revision'],job['revision'])
  repeated=json.load(self.req(c,f'/api/jobs/{job["id"]}/generate',{}));self.assertEqual(repeated['state'],'ready')
 def test_pma_requires_explicit_selection(self):
  c=self.login();job=self.upload(c,['20261016_위치_GIS/측정.jpg'])
  job['photos'][0].update(work='코일저항 측정',equipmentType='PMA 타입 GIS',confirmed=True,measurementScene=True)
  job=self.save(c,job)
  with self.assertRaises(urllib.error.HTTPError):self.req(c,f'/api/jobs/{job["id"]}/generate',{})
  job['photos'][0].update(ambiguityGroupId='pma-measurement',ambiguityChoice='PMA 전압 측정')
  job=self.save(c,job)
  with self.assertRaises(urllib.error.HTTPError):self.req(c,f'/api/jobs/{job["id"]}/generate',{})
  job['photos'][0].update(ambiguityChoice='코일 저항 측정')
  job=self.save(c,job);self.req(c,f'/api/jobs/{job["id"]}/generate',{}).read();job=self.wait_job(c,job)
  self.assertEqual(job['state'],'ready')
 def test_date_zip_and_duplicate_names(self):
  c=self.login();job=self.upload(c,['20261015_위치_GIS/사진.jpg','20261016_위치_GIS/사진.jpg'])
  for p in job['photos']:p.update(work='점검',confirmed=True)
  job=self.save(c,job);self.req(c,f'/api/jobs/{job["id"]}/generate',{}).read();job=self.wait_job(c,job)
  response=self.req(c,f'/api/jobs/{job["id"]}/download?date=2026-10-15')
  self.assertIn('attachment',response.headers['Content-Disposition'])
  with zipfile.ZipFile(io.BytesIO(response.read())) as z:self.assertEqual(z.namelist(),['20261015_위치_GIS/사진.jpg'])
  with self.assertRaises(urllib.error.HTTPError):self.req(c,f'/api/jobs/{job["id"]}/download?date=2026-01-01')
 def test_group_admin_authorization_and_validation(self):
  c=self.login();admin=self.login('admin');original=server.ambiguity_groups()
  with self.assertRaises(urllib.error.HTTPError):self.req(c,'/api/ambiguity-groups',{'groups':original})
  invalid=[dict(original[0],options=['동작특성시험','동작특성 시험'])]
  with self.assertRaises(urllib.error.HTTPError):self.req(admin,'/api/ambiguity-groups',{'groups':invalid})
  self.assertEqual(server.ambiguity_groups(),original)
  updated=original+[dict(id='test-group',name='검증 그룹',equipmentMatch='TEST GIS',options=['분리','조립'],reason='동일 외형',required=True)]
  try:
   self.req(admin,'/api/ambiguity-groups',{'groups':updated}).read()
   self.assertEqual(len(json.load(self.req(c,'/api/settings'))['ambiguityGroups']),len(updated))
  finally:self.req(admin,'/api/ambiguity-groups',{'groups':original}).read()

 def test_z_worker_password_revokes_sessions_preserves_jobs(self):
  worker=self.login();admin=self.login('admin');job=self.upload(worker,['20261016_위치_GIS/사진.jpg'])
  with self.assertRaises(urllib.error.HTTPError):self.req(worker,'/api/worker-password',{'password':'new-test-only-password'})
  with self.assertRaises(urllib.error.HTTPError):self.req(admin,'/api/worker-password',{'password':'short'})
  try:
   self.req(admin,'/api/worker-password',{'password':'new-test-only-password'}).read()
   with self.assertRaises(urllib.error.HTTPError) as error:self.req(worker,'/api/jobs')
   self.assertEqual(error.exception.code,401)
   with self.assertRaises(urllib.error.HTTPError):self.login()
   with server.db() as c:row=c.execute("SELECT * FROM credentials WHERE role='worker'").fetchone()
   self.assertNotIn('new-test-only-password',str(tuple(row)))
   self.req(worker,'/api/login',dict(role='worker',password='new-test-only-password')).read()
   self.assertEqual(json.load(self.req(worker,f'/api/jobs/{job["id"]}'))['id'],job['id'])
   self.assertEqual(json.load(self.req(admin,'/api/settings'))['role'],'admin')
  finally:
   with server.db() as c:c.execute("DELETE FROM credentials WHERE role='worker'")

 def test_ai_queue_selection_cache_and_daily_budget(self):
  c=self.login();job=self.upload(c,['20261016_위치_GIS/측정.jpg'])
  result=dict(result=dict(equipmentType='PMA GIS',candidates=[dict(work='코일 저항 측정',reason='측정 장면')],observations=['단자와 계측기'],measurementScene=True,ambiguityGroupId='pma-measurement',needsUserReview=True),usage=dict(input_tokens=100),model='test-model',promptVersion='test')
  with patch.dict(os.environ,{'OPENAI_API_KEY':'test-only-not-real','AI_MIN_INTERVAL_SECONDS':'0','AI_DAILY_LIMIT':'999'}),patch.object(vision,'recommend',return_value=result) as provider:
   self.req(c,f'/api/jobs/{job["id"]}/analyse',{}).read();job=self.wait_job(c,job)
   self.assertEqual(job['state'],'uploaded');self.assertEqual(job['photos'][0]['equipmentType'],'PMA GIS');self.assertFalse(job['photos'][0]['confirmed'])
   self.req(c,f'/api/jobs/{job["id"]}/analyse',{}).read();job=self.wait_job(c,job);self.assertEqual(provider.call_count,1)
   job['photos'][0].update(work='코일 저항 측정',confirmed=True);job=self.save(c,job)
   with self.assertRaises(urllib.error.HTTPError):self.req(c,f'/api/jobs/{job["id"]}/generate',{})
   job['photos'][0].update(rotation=2);job=self.save(c,job);self.assertEqual(job['photos'][0]['analysisStatus'],'stale')
   with patch.dict(os.environ,{'AI_DAILY_LIMIT':'0'}):
    self.req(c,f'/api/jobs/{job["id"]}/analyse',{}).read();job=self.wait_job(c,job)
   self.assertEqual(provider.call_count,1);self.assertIn('한도',job['photos'][0]['analysisError'])
 def test_ai_missing_key_and_work_type_permissions(self):
  c=self.login();job=self.upload(c,['20261016_위치_GIS/사진.jpg'])
  with patch.dict(os.environ,{'OPENAI_API_KEY':''}):
   with self.assertRaises(urllib.error.HTTPError):self.req(c,f'/api/jobs/{job["id"]}/analyse',{})
  original=server.work_types()
  with self.assertRaises(urllib.error.HTTPError):self.req(c,'/api/work-types',{'workTypes':['점검']})
  self.assertEqual(server.work_types(),original)

 def test_zip_security_and_content_validation(self):
  c=self.login()
  for path in ['../escape.jpg','/absolute.jpg','C:/unsafe.jpg']:
   buffer=io.BytesIO()
   with zipfile.ZipFile(buffer,'w') as z:z.writestr(path,b'not an image')
   with self.assertRaises(urllib.error.HTTPError):self.req(c,'/api/upload',buffer.getvalue())
  buffer=io.BytesIO()
  with zipfile.ZipFile(buffer,'w',zipfile.ZIP_DEFLATED) as z:z.writestr('bomb.txt',b'0'*200000)
  with self.assertRaises(urllib.error.HTTPError):self.req(c,'/api/upload',buffer.getvalue())
  gif=io.BytesIO();Image.new('RGB',(100,100),'blue').save(gif,'GIF')
  with self.assertRaises(urllib.error.HTTPError):self.req(c,'/api/upload',gif.getvalue(),{'X-Filename':'disguised.jpg'})
  job=self.upload(c,['20261016_위치_GIS/a.jpg','20261016_위치_GIS/b.jpg'])
  self.assertEqual(len(job['photos']),2);self.assertTrue(job['photos'][1]['duplicate'])
