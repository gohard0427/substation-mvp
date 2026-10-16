import io,json,os,unittest,urllib.error
from unittest.mock import patch
from PIL import Image
import vision,server
class Vision(unittest.TestCase):
 def sample(self):return dict(equipmentType='PMA GIS',candidates=[dict(work='코일 저항 측정',reason='계측기 접속 장면')],observations=['단자와 계측기가 보임'],measurementScene=True,ambiguityGroupId='pma-measurement',needsUserReview=True)
 def envelope(self,result):return dict(status='completed',output=[dict(type='message',content=[dict(type='output_text',text=json.dumps(result))])],usage={'input_tokens':100,'output_tokens':40})
 def test_request_and_strict_result(self):
  request=[]
  def provider(req,timeout):
   request.append(req);return io.BytesIO(json.dumps(self.envelope(self.sample())).encode())
  with patch.dict(os.environ,{'OPENAI_API_KEY':'test-only-not-real'}),patch('urllib.request.urlopen',side_effect=provider):
   output=vision.recommend(Image.new('RGB',(400,300),'blue'),{},['코일 저항 측정'],server.ambiguity_groups())
  body=json.loads(request[0].data);self.assertFalse(body['store']);self.assertTrue(output['result']['needsUserReview'])
  self.assertTrue(body['input'][0]['content'][1]['image_url'].startswith('data:image/jpeg;base64,'))
  self.assertNotIn('test-only-not-real',json.dumps(output))
  self.assertEqual(body['text']['format']['type'],'json_schema')
 def test_no_key_no_call(self):
  with patch.dict(os.environ,{'OPENAI_API_KEY':''}),patch('urllib.request.urlopen') as provider:
   with self.assertRaises(vision.VisionError):vision.recommend(Image.new('RGB',(400,300)),{},['점검'],[])
   provider.assert_not_called()
 def test_invalid_or_duplicate_candidates_rejected(self):
  for candidates in [[dict(work='없는 작업',reason='근거')],[dict(work='코일 저항 측정',reason='근거')]*2]:
   result=self.sample();result['candidates']=candidates
   with self.assertRaises(ValueError):vision.validate_result(result,['코일 저항 측정'],server.ambiguity_groups())
 def test_provider_error_hides_response_and_key(self):
  with patch.dict(os.environ,{'OPENAI_API_KEY':'test-only-not-real'}),patch('urllib.request.urlopen',side_effect=urllib.error.HTTPError('https://api.openai.com/v1/responses',429,'provider body',{},None)):
   with self.assertRaises(vision.VisionError) as error:vision.recommend(Image.new('RGB',(400,300)),{},['점검'],[])
  self.assertIn('429',str(error.exception));self.assertNotIn('test-only-not-real',str(error.exception));self.assertNotIn('provider body',str(error.exception))
 def test_mask_moves_with_rotation_without_changing_original(self):
  source=io.BytesIO();Image.new('RGB',(400,300),'blue').save(source,'PNG');original=source.getvalue()
  masked=server.prepare_photo(io.BytesIO(original),{'rotation':2},mask_plate=True)
  self.assertEqual(masked.getpixel((20,20)),(128,128,128))
  unmasked=server.prepare_photo(io.BytesIO(original),{'rotation':2})
  self.assertEqual(unmasked.getpixel((20,20)),(0,0,255));self.assertEqual(source.getvalue(),original)
