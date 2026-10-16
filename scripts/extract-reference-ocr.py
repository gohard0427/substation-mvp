"""Offline draft OCR. Outputs private JSON; never automatically marks labels reviewed."""
import argparse,concurrent.futures,hashlib,io,json,pathlib,re,subprocess,tempfile,zipfile
from PIL import Image,ImageOps
p=argparse.ArgumentParser();p.add_argument('zips',nargs='+');p.add_argument('--output',required=True);p.add_argument('--tessdata');args=p.parse_args()
fields=['project','location','equipment','work','date'];aliases={'대상기기':'대상 기기','코일저항측정':'코일 저항 측정','PMA전압측정':'PMA 전압 측정','동작특성시험':'동작특성 시험'}
def one(entry):
 archive,path,raw=entry
 with Image.open(io.BytesIO(raw)) as im:
  im=ImageOps.exif_transpose(im).convert('RGB');w,h=im.size
  box=(1137/2048,1200/1536,1269/2048) if w/h>1.32 and w>=1800 else (676/1440,878/1080,812/1440)
  vals={}
  with tempfile.TemporaryDirectory() as folder:
   for i,key in enumerate(fields):
    crop=im.crop((round(w*box[2])+3,round(h*(box[1]+(1-box[1])*i/5))+3,w-2,round(h*(box[1]+(1-box[1])*(i+1)/5))-2));crop=ImageOps.expand(crop.resize((crop.width*2,crop.height*2)),border=12,fill='white');file=pathlib.Path(folder)/f'{i}.png';crop.save(file)
    cmd=['tesseract',str(file),'stdout','-l','kor','--psm','7']
    if args.tessdata:cmd+=['--tessdata-dir',args.tessdata]
    vals[key]=subprocess.run(cmd,capture_output=True,text=True,check=True).stdout.strip()
  clean={k:re.sub(r'\s+',' ',v).strip() for k,v in vals.items()};clean['work']=aliases.get(re.sub(r'\s+','',clean['work']),clean['work'])
  date=re.search(r'(20\d{2})\D*(\d{1,2})\D*(\d{1,2})',clean['date'])
  if date:clean['date']=f'{date[1]}-{int(date[2]):02}-{int(date[3]):02}'
  return {'hash':hashlib.sha256(raw).hexdigest(),'path':path,'archive':archive,'ocr':vals,'label':{**clean,'equipmentType':''},'mask':{'x':box[0],'y':box[1]},'reviewed':False}
entries=[]
for archive in args.zips:
 with zipfile.ZipFile(archive) as z:
  for info in z.infolist():
   if info.is_dir() or not info.filename.lower().endswith(('.jpg','.jpeg','.png')):continue
   path=info.filename
   if not info.flag_bits&0x800:
    try:path=path.encode('cp437').decode('cp949')
    except (UnicodeError,LookupError):pass
   if path.startswith('/') or '..' in path.replace('\\','/').split('/') or info.file_size>8*1024*1024:raise ValueError('Unsafe ZIP entry')
   entries.append((pathlib.Path(archive).name,path,z.read(info)))
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:result=list(pool.map(one,entries))
pathlib.Path(args.output).write_text(json.dumps({'version':1,'references':result},ensure_ascii=False,indent=2));print(f'{len(result)} OCR drafts; all require review. Private output: {args.output}')
