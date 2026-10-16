import unittest, tempfile, os, io, time, zipfile
from pathlib import Path
os.environ['DATA_DIR']=tempfile.mkdtemp()
import server
from PIL import Image
class Core(unittest.TestCase):
 def setUp(self): server.init()
 def test_paths(self):
  for p in ['../a.jpg','/a.jpg','x/../../a','C:\\a.jpg','x\\..\\a']:
   with self.assertRaises(ValueError): server.safe_path(p)
  self.assertEqual(server.safe_path('날짜/기기/사진.jpg'),'날짜/기기/사진.jpg')
 def test_infer(self):
  p=server.infer('2026-10-16/남시화_154kV GIS/사진.jpg')
  self.assertEqual((p['date'],p['location'],p['equipment']),('2026-10-16','남시화','154kV GIS'))
 def test_real_folder_names(self):
  for folder,expected in [('20260710_도림',('2026-07-10','도림','')),('20260624_신시흥_6179',('2026-06-24','신시흥','6179')),('20260709_동송도_#2StrSIS',('2026-07-09','동송도','#2StrSIS'))]:
   p=server.infer(folder+'/사진.jpg')
   self.assertEqual((p['date'],p['location'],p['equipment']),expected)
 def test_device_isolation(self):
  j={'id':'test','state':'uploaded','photos':[]};server.save_job(j,'deviceA')
  self.assertEqual(server.load_job('test','deviceA'),j)
  with self.assertRaises(ValueError): server.load_job('test','deviceB')
 def test_render(self):
  f=Path(server.DATA)/'photo.png';Image.new('RGB',(1600,1200),'blue').save(f)
  p=dict(location='남시화',equipment='154kV GIS',work='코일 저항 측정',date='2026-10-16')
  out=server.render(f,p,'전력설비 점검공사')
  self.assertEqual(out.size,(1280,960));self.assertEqual(out.getpixel((1279,959)),(34,34,34))
  b=io.BytesIO();out.save(b,'JPEG',quality=85);b.seek(0)
  with Image.open(b) as result:self.assertFalse(result.getexif());self.assertEqual(result.size,(1280,960))
 def test_rotation_preserves_content(self):
  f=Path(server.DATA)/'rotation.png'
  im=Image.new('RGB',(400,300),'blue')
  im.paste('red',(0,0,200,150));im.save(f)
  normal=server.prepare_photo(f,{'rotation':0})
  rotated=server.prepare_photo(f,{'rotation':2})
  self.assertEqual(normal.getpixel((20,20)),(255,0,0))
  self.assertEqual(rotated.getpixel((380,280)),(255,0,0))
  self.assertEqual(rotated.size,(400,300))
 def test_small_portrait(self):
  f=Path(server.DATA)/'portrait.png';Image.new('RGB',(300,400),'blue').save(f)
  out=server.render(f,dict(location='위치',equipment='기기',work='점검',date='2026-10-16'),'공사')
  self.assertEqual(out.size,(400,300))
 def test_cleanup(self):
  j={'id':'expired','state':'uploaded'};server.save_job(j,'a');folder=server.DATA/'expired';folder.mkdir(exist_ok=True);(folder/'original').write_bytes(b'test')
  with server.db() as c:c.execute('UPDATE jobs SET updated=? WHERE id=?',(time.time()-86401,'expired'))
  server.cleanup();self.assertFalse(folder.exists())


 def test_ambiguity_rule(self):
  p=dict(equipmentType='PMA GIS',work='코일저항 측정')
  group=server.ambiguity_group(p);self.assertIsNotNone(group);self.assertFalse(server.ambiguity_resolved(p,group))
  p.update(ambiguityGroupId=group['id'],ambiguityChoice='코일 저항 측정')
  self.assertTrue(server.ambiguity_resolved(p,group))
  p.update(ambiguityChoice='__other__',work='별도 측정')
  self.assertTrue(server.ambiguity_resolved(p,group))
  self.assertIsNone(server.ambiguity_group(dict(equipmentType='PMA GIS',work='대상 기기')))
  self.assertIsNotNone(server.ambiguity_group(dict(equipmentType='PMA GIS',work='점검',measurementScene=True)))
 def test_queue_recovery(self):
  job=dict(id='recover-test',state='generating',photos=[])
  server.save_job(job,'device');server.recover_queue()
  self.assertEqual(server.load_job(job['id'],'device')['state'],'queued')
  with server.db() as c:c.execute('DELETE FROM jobs WHERE id=?',(job['id'],))
 def test_retry_reuses_successful_photo(self):
  from unittest.mock import patch
  folder=server.DATA/'retry-test';folder.mkdir(exist_ok=True)
  photos=[]
  for pid in ['a','b']:
   Image.new('RGB',(800,600),'blue').save(folder/pid,'JPEG')
   photos.append(dict(id=pid,path=pid+'.jpg',location='위치',equipment='기기',work='점검',date='2026-10-16',rotation=0,excluded=False,confirmed=True))
  job=dict(id='retry-test',state='generating',photos=photos);server.save_job(job,'device')
  actual=server.render
  def fail_second(src,photo,project):
   if photo['id']=='b':raise ValueError('일시적 합성 실패')
   return actual(src,photo,project)
  with patch.object(server,'render',side_effect=fail_second) as mocked:
   server.generate(job,server.digest('device'));self.assertEqual(mocked.call_count,2)
  self.assertEqual(job['state'],'failed');self.assertIn('generationError',job['photos'][1])
  with patch.object(server,'render',wraps=actual) as mocked:
   server.generate(job,server.digest('device'));self.assertEqual(mocked.call_count,1)
  self.assertEqual(job['state'],'ready')
  with zipfile.ZipFile(folder/'result.zip') as archive:self.assertEqual(len(archive.namelist()),2)

 def test_expired_generation_not_revived_by_restart(self):
  job=dict(id='expired-generation',state='generating',photos=[]);server.save_job(job,'device')
  folder=server.DATA/job['id'];folder.mkdir(exist_ok=True)
  with server.db() as c:c.execute('UPDATE jobs SET updated=? WHERE id=?',(time.time()-86401,job['id']))
  server.recover_queue()
  with self.assertRaises(ValueError):server.load_job(job['id'],'device')
  server.cleanup();self.assertFalse(folder.exists())

 def test_interrupted_ai_not_automatically_recalled(self):
  from unittest.mock import patch
  import vision
  folder=server.DATA/'interrupted-ai';folder.mkdir(exist_ok=True);Image.new('RGB',(800,600),'blue').save(folder/'a','JPEG')
  photo=dict(id='a',path='a.jpg',equipmentType='',analysisStatus='running',excluded=False,rotation=0)
  job=dict(id='interrupted-ai',state='analysing',photos=[photo]);server.save_job(job,'device')
  with patch.object(vision,'recommend') as provider:
   server.analyse_job(job,server.digest('device'));provider.assert_not_called()
  self.assertEqual(photo['analysisStatus'],'interrupted');self.assertIn('자동 재요청하지',photo['analysisError'])

 def test_orphan_upload_cleanup(self):
  old=server.DATA/'orphan-old';fresh=server.DATA/'orphan-new'
  for folder in [old,fresh]:folder.mkdir(exist_ok=True);(folder/'photo').write_bytes(b'private photo')
  os.utime(old,(time.time()-86401,time.time()-86401))
  server.cleanup();self.assertFalse(old.exists());self.assertTrue(fresh.exists())
