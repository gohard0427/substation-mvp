import os, json, sqlite3, secrets, hashlib, hmac, time, io, zipfile, re, threading
from pathlib import Path, PurePosixPath
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from http.cookies import SimpleCookie
from urllib.parse import unquote, parse_qs, quote
from PIL import Image, ImageOps, ImageDraw, ImageFont
import vision
ROOT=Path(__file__).parent
DATA=Path(os.environ.get('DATA_DIR',ROOT/'data')); DATA.mkdir(exist_ok=True)
FONT=os.environ.get('KOREAN_FONT','/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc')
MAX_UPLOAD=int(os.environ.get('MAX_UPLOAD_BYTES',str(200*1024*1024))); MAX_TOTAL=1024*1024*1024; MAX_FILES=2000
Image.MAX_IMAGE_PIXELS=40_000_000
LOCK=threading.RLock()
def db():
 c=sqlite3.connect(DATA/'app.db'); c.row_factory=sqlite3.Row; return c
def init():
 with db() as c:
  c.executescript('''CREATE TABLE IF NOT EXISTS login_attempts(identity_hash TEXT NOT NULL,created REAL NOT NULL);CREATE INDEX IF NOT EXISTS login_attempts_lookup ON login_attempts(identity_hash,created);CREATE TABLE IF NOT EXISTS app_config(key TEXT PRIMARY KEY,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS ai_calls(id TEXT PRIMARY KEY,created REAL NOT NULL,status TEXT NOT NULL);CREATE TABLE IF NOT EXISTS credentials(role TEXT PRIMARY KEY,salt TEXT NOT NULL,password_hash TEXT NOT NULL);CREATE TABLE IF NOT EXISTS ambiguity_groups(id TEXT PRIMARY KEY,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS logins(token TEXT PRIMARY KEY,role TEXT,expires REAL); CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,device TEXT,state TEXT,updated REAL,payload TEXT); CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY,project TEXT); INSERT OR IGNORE INTO settings VALUES(1,'전력설비 점검 및 정비공사');''')
 with db() as c:
  c.execute('INSERT OR IGNORE INTO app_config VALUES(?,?)',('workTypes',json.dumps(['대상 기기','작업 전','작업 후','분리','조립','청소','점검','교체','동작특성 시험','코일 저항 측정','PMA 전압 측정'],ensure_ascii=False)))
  initial={'id':'pma-measurement','name':'PMA 타입 GIS 측정','equipmentMatch':'PMA','options':['코일 저항 측정','PMA 전압 측정'],'reason':'측정 위치 및 계측기 동일','required':True}
  c.execute('INSERT OR IGNORE INTO ambiguity_groups VALUES(?,?)',(initial['id'],json.dumps(initial,ensure_ascii=False)))

def work_types():
 with db() as c: return json.loads(c.execute("SELECT payload FROM app_config WHERE key='workTypes'").fetchone()[0])

def ambiguity_groups():
 with db() as c: return [json.loads(row[0]) for row in c.execute('SELECT payload FROM ambiguity_groups ORDER BY CASE WHEN id="pma-measurement" THEN 0 ELSE 1 END,id')]
def normalized(value): return re.sub(r'\s+','',value).casefold()
def ambiguity_group(photo,groups=None):
 equipment=normalized(photo.get('equipmentType',''))
 work=normalized(photo.get('work',''))
 obvious={'대상기기','작업전','작업후','분리','조립','청소','점검','교체'}
 for group in groups if groups is not None else ambiguity_groups():
  if normalized(group['equipmentMatch']) in equipment and group['required']:
   if group['id']!='pma-measurement' or photo.get('measurementScene') or work not in obvious: return group
  recommendation=photo.get('recommendation',{}).get('result',{})
  if group['required'] and recommendation.get('ambiguityGroupId')==group['id'] and photo.get('equipmentType','')==photo.get('analysisEquipmentType',''): return group
 return None
def ambiguity_resolved(photo,group):
 if group is None: return True
 if photo.get('ambiguityGroupId')!=group['id']: return False
 choice=photo.get('ambiguityChoice',''); work=photo.get('work','').strip()
 return bool(work) if choice=='__other__' else choice in group['options'] and normalized(work)==normalized(choice)
def validate_photos(photos):
 import datetime
 selected=[p for p in photos if not p.get('excluded')]
 if not selected: raise ValueError('생성할 사진을 한 장 이상 선택하세요')
 groups=ambiguity_groups()
 for p in selected:
  if not p.get('confirmed') or any(not p.get(k,'').strip() for k in ['date','location','equipment','work']): raise ValueError('모든 사진의 정보와 작업 내용을 확인하세요')
  datetime.date.fromisoformat(p['date'])
  if not ambiguity_resolved(p,ambiguity_group(p,groups)): raise ValueError('구분 필요 작업을 사진별로 직접 선택하세요')
class ConflictError(ValueError): pass
class LoginLimitError(ValueError): pass

def verify_password(role,password):
 with db() as c: row=c.execute('SELECT salt,password_hash FROM credentials WHERE role=?',(role,)).fetchone()
 if row:
  calculated=hashlib.pbkdf2_hmac('sha256',password.encode(),bytes.fromhex(row['salt']),600000).hex()
  return hmac.compare_digest(calculated,row['password_hash'])
 expected=os.environ.get('ADMIN_PASSWORD' if role=='admin' else 'WORKER_PASSWORD','')
 return bool(expected) and hmac.compare_digest(password.encode(),expected.encode())
def change_worker_password(password):
 if not isinstance(password,str) or not 12<=len(password)<=128: raise ValueError('비밀번호는 12~128자로 설정하세요')
 salt=secrets.token_bytes(16); value=hashlib.pbkdf2_hmac('sha256',password.encode(),salt,600000).hex()
 with db() as c:
  c.execute('INSERT OR REPLACE INTO credentials VALUES(?,?,?)',('worker',salt.hex(),value))
  c.execute("DELETE FROM logins WHERE role='worker'")

def digest(s): return hashlib.sha256(s.encode()).hexdigest()
def safe_path(name):
 p=PurePosixPath(name.replace('\\','/'))
 if p.is_absolute() or '..' in p.parts or ':' in name or '\x00' in name: raise ValueError('안전하지 않은 ZIP 경로')
 return str(p)
def infer(path):
 folder=str(PurePosixPath(path).parent); leaf=PurePosixPath(folder).name
 # Prefer the nearest folder date; filenames are only a fallback.
 pattern=r'(20\d{2})(?:[-년./] ?)?(\d{2})(?:[-월./] ?)?(\d{2})'
 date=re.search(pattern,folder) or re.search(pattern,path)
 if not date:
  date=re.search(r'(20\d{2})[-년./] ?(\d{1,2})[-월./] ?(\d{1,2})',folder)
 date_value=''
 if date:
  import datetime
  try: date_value=datetime.date(int(date[1]),int(date[2]),int(date[3])).isoformat()
  except ValueError: pass
 leaf=re.sub(r'^20\d{6}[_ -]*','',leaf)
 leaf=re.sub(r'^20\d{2}[-.]\d{1,2}[-.]\d{1,2}[_ -]*','',leaf)
 parts=leaf.split('_',1)
 return dict(date=date_value,location=parts[0] if leaf!='.' else '',equipment=parts[1] if len(parts)>1 else '',group=folder)
def cleanup():
 with LOCK, db() as c:
  expired=c.execute('SELECT id FROM jobs WHERE updated<?',(time.time()-86400,)).fetchall()
  import shutil
  for row in expired: shutil.rmtree(DATA/row['id'],ignore_errors=True)
  c.execute('DELETE FROM jobs WHERE updated<?',(time.time()-86400,)); c.execute('DELETE FROM logins WHERE expires<?',(time.time(),)); c.execute('DELETE FROM login_attempts WHERE created<?',(time.time()-86400,))
  known={row[0] for row in c.execute('SELECT id FROM jobs')}
  for folder in DATA.iterdir():
   if folder.is_dir() and folder.name not in known and folder.stat().st_mtime<time.time()-86400: shutil.rmtree(folder,ignore_errors=True)
def load_job(jid,device):
 with db() as c: row=c.execute('SELECT * FROM jobs WHERE id=? AND device=?',(jid,digest(device))).fetchone()
 if not row or row['updated']<time.time()-86400: raise ValueError('작업 권한이 없거나 만료되었습니다')
 return json.loads(row['payload'])
def save_job(job,device): save_job_hashed(job,digest(device))
def save_job_hashed(job,device_hash):
 with LOCK, db() as c:
  job['revision']=job.get('revision',0)+1
  c.execute('INSERT OR REPLACE INTO jobs VALUES(?,?,?,?,?)',(job['id'],device_hash,job['state'],time.time(),json.dumps(job,ensure_ascii=False)))
def prepare_photo(src,photo,mask_plate=False):
 with Image.open(src) as source:
  im=ImageOps.exif_transpose(source).convert('RGB')
  if mask_plate:
   width,height=im.size;ImageDraw.Draw(im).rectangle((int(width*.46),int(height*.78),width,height),fill='#808080')
  if im.height>im.width: im=im.rotate(90,expand=True)
  im=im.rotate(-90*photo.get('rotation',0),expand=True)
  # Contain without cropping or unnecessary upscaling; pad to 4:3.
  scale=min(1280/im.width,960/im.height,1)
  w,h=round(im.width*scale),round(im.height*scale)
  im=im.resize((w,h),Image.Resampling.LANCZOS)
  ow=min(1280,max(w,round(h*4/3))); oh=round(ow*3/4)
  out=Image.new('RGB',(ow,oh),'white'); out.paste(im,((ow-w)//2,(oh-h)//2))
 return out
def render(src,photo,project):
 out=prepare_photo(src,photo); ow,oh=out.size
 d=ImageDraw.Draw(out); pw=round(ow*911/2048); ph=round(oh*336/1536); x=ow-pw; y=oh-ph; col=round(ow*132/2048)
 d.rectangle((x,y,ow-1,oh-1),fill='white',outline='#222',width=2)
 vals=[('공사명',project),('위 치',photo['location']),('기기명',photo['equipment']),('내 용',photo['work']),('일 자',photo['date'].replace('-','.'))]
 for i,(label,value) in enumerate(vals):
  top=y+round(ph*i/5); bottom=y+round(ph*(i+1)/5)
  d.line((x,top,ow-1,top),fill='#222',width=1); d.line((x+col,top,x+col,bottom),fill='#222',width=1)
  for text,left,width in [(label,x,col),(value,x+col,pw-col)]:
   size=max(8,round(ow*50/2048)); font=ImageFont.truetype(FONT,size)
   while d.textbbox((0,0),text,font=font)[2]>width-10 and size>6:
    size-=1; font=ImageFont.truetype(FONT,size)
   if d.textbbox((0,0),text,font=font)[2]>width-8: raise ValueError('명판 문구가 너무 깁니다. 줄여 주세요')
   box=d.textbbox((0,0),text,font=font); d.text((left+max(3,round(ow*12/2048)),top+(bottom-top-(box[3]-box[1]))/2-box[1]),text,font=font,fill='#111')
 return out
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def reply(self,obj,status=200):
  raw=json.dumps(obj,ensure_ascii=False).encode(); self.send_response(status); self.send_header('Content-Type','application/json; charset=utf-8'); self.send_header('Cache-Control','no-store'); self.end_headers(); self.wfile.write(raw)
 def require_proxy(self):
  secret=os.environ.get('EDGE_PROXY_SECRET','')
  if secret and not hmac.compare_digest(self.headers.get('X-Edge-Proxy-Secret','').encode(),secret.encode()): raise PermissionError('허용되지 않은 서버 접근입니다')
 def auth(self,admin=False):
  cookie=SimpleCookie(self.headers.get('Cookie','')); tok=cookie.get('session'); dev=cookie.get('device')
  with db() as c: row=c.execute('SELECT role FROM logins WHERE token=? AND expires>?',(digest(tok.value) if tok else '',time.time())).fetchone()
  if not row or not dev or (admin and row['role']!='admin'): raise PermissionError('로그인이 필요합니다')
  return dev.value
 def body(self):
  n=int(self.headers.get('Content-Length',0))
  if n<1 or n>MAX_UPLOAD: raise ValueError('업로드는 최대 200MB입니다')
  return self.rfile.read(n)
 def do_GET(self):
  try:
   path=self.path.split('?')[0]
   if path.startswith('/api/'):
    self.require_proxy()
    dev=self.auth()
    if path=='/api/jobs':
     cleanup()
     with db() as c: rows=c.execute('SELECT payload FROM jobs WHERE device=? ORDER BY updated DESC',(digest(dev),)).fetchall()
     return self.reply([json.loads(r[0]) for r in rows])
    if path=='/api/settings':
     with db() as c: project=c.execute('SELECT project FROM settings').fetchone()[0]
     cookie=SimpleCookie(self.headers.get('Cookie',''))
     with db() as c: role=c.execute('SELECT role FROM logins WHERE token=?',(digest(cookie['session'].value),)).fetchone()[0]
     return self.reply({'project':project,'aiConfigured':vision.configured(),'aiModel':os.environ.get('OPENAI_VISION_MODEL','gpt-4.1-mini'),'aiDailyLimit':int(os.environ.get('AI_DAILY_LIMIT','100')),'workTypes':work_types(),'role':role,'ambiguityGroups':ambiguity_groups()})
    parts=path.split('/'); job=load_job(parts[3],dev)
    if parts[2]=='jobs' and len(parts)==4: return self.reply(job)
    if parts[4]=='image':
     p=next(p for p in job['photos'] if p['id']==parts[5]); file=DATA/job['id']/p['id']
     rotation=parse_qs(self.path.partition('?')[2]).get('rotation',[p.get('rotation',0)])[0]
     preview=prepare_photo(file,dict(p,rotation=int(rotation)%4)); preview.thumbnail((640,480))
     buf=io.BytesIO(); preview.save(buf,'JPEG',quality=85); raw=buf.getvalue(); mime='image/jpeg'
    elif parts[4]=='result':
     if job['state']!='ready': raise ValueError('먼저 명판을 생성하세요')
     p=next(p for p in job['photos'] if p['id']==parts[5] and not p['excluded'])
     with zipfile.ZipFile(DATA/job['id']/'result.zip') as archive: raw=archive.read(p['output_name'])
     mime='image/jpeg'
    elif parts[4]=='download':
     if job['state']!='ready': raise ValueError('먼저 명판을 생성하세요')
     date=parse_qs(self.path.partition('?')[2]).get('date',[''])[0]
     if date:
      import datetime
      datetime.date.fromisoformat(date)
      selected=[p for p in job['photos'] if not p['excluded'] and p['date']==date]
      if not selected: raise ValueError('해당 날짜의 결과물이 없습니다')
      buffer=io.BytesIO()
      with zipfile.ZipFile(DATA/job['id']/'result.zip') as original, zipfile.ZipFile(buffer,'w',zipfile.ZIP_STORED) as archive:
       for p in selected: archive.writestr(p['output_name'],original.read(p['output_name']))
      raw=buffer.getvalue()
     else: raw=(DATA/job['id']/'result.zip').read_bytes()
     mime='application/zip'
    else: raise ValueError('잘못된 요청')
    self.send_response(200); self.send_header('Content-Type',mime);
    if parts[4]=='result' and 'download' in parse_qs(self.path.partition('?')[2]): self.send_header('Content-Disposition',"attachment; filename*=UTF-8''"+quote(PurePosixPath(p['output_name']).name))
    if parts[4]=='download': self.send_header('Content-Disposition',"attachment; filename*=UTF-8''"+quote((date or '전체')+'_작업사진.zip'))
    self.send_header('Cache-Control','no-store'); self.end_headers(); self.wfile.write(raw); return
   file=ROOT/'static'/('index.html' if path=='/' else path.lstrip('/'))
   if file.parent!=(ROOT/'static') or not file.exists(): return self.reply({'error':'없음'},404)
   self.send_response(200); self.send_header('Content-Type','text/html; charset=utf-8' if file.suffix=='.html' else 'text/javascript; charset=utf-8' if file.suffix=='.js' else 'text/css'); self.end_headers(); self.wfile.write(file.read_bytes())
  except PermissionError as e: self.reply({'error':str(e)},401)
  except Exception as e: self.reply({'error':str(e)},400)
 def do_POST(self):
  with LOCK: self.post_locked()
 def post_locked(self):
  try:
   # Same-origin browser mutations only.
   origin=self.headers.get('Origin')
   if origin and origin.split('://')[-1]!=self.headers.get('Host'): raise PermissionError('허용되지 않은 요청')
   path=self.path.split('?')[0]
   self.require_proxy()
   if path=='/api/login':
    data=json.loads(self.body()); role=data.get('role','worker')
    client_ip=self.headers.get('X-Edge-Client-IP','unknown') if os.environ.get('EDGE_PROXY_SECRET') else self.client_address[0]
    identity=digest(str(client_ip)+':'+str(role))
    with db() as c: attempts=c.execute('SELECT count(*) FROM login_attempts WHERE identity_hash=? AND created>?',(identity,time.time()-600)).fetchone()[0]
    if attempts>=int(os.environ.get('LOGIN_MAX_ATTEMPTS','10')): raise LoginLimitError('로그인 시도가 많습니다. 10분 후 다시 시도하세요')
    if role not in ['worker','admin'] or not isinstance(data.get('password'),str) or len(data['password'])>128 or not verify_password(role,data['password']):
     with db() as c:c.execute('INSERT INTO login_attempts VALUES(?,?)',(identity,time.time()))
     raise PermissionError('비밀번호를 확인하세요')
    with db() as c:c.execute('DELETE FROM login_attempts WHERE identity_hash=?',(identity,))
    token=secrets.token_urlsafe(32); cookie=SimpleCookie(self.headers.get('Cookie','')); device=cookie['device'].value if 'device' in cookie else secrets.token_urlsafe(32)
    with db() as c: c.execute('INSERT INTO logins VALUES(?,?,?)',(digest(token),role,time.time()+43200))
    self.send_response(200)
    secure='; Secure' if os.environ.get('COOKIE_SECURE')=='1' else ''
    for name,value,age in [('session',token,43200),('device',device,31536000)]: self.send_header('Set-Cookie',f'{name}={value}; HttpOnly; SameSite=Strict; Path=/; Max-Age={age}{secure}')
    self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(json.dumps({'role':role}).encode()); return
   dev=self.auth()
   if path=='/api/settings':
    self.auth(True); data=json.loads(self.body())
    with db() as c: c.execute('UPDATE settings SET project=?',(str(data['project'])[:150],))
    return self.reply({'ok':True})
   if path=='/api/ambiguity-groups':
    self.auth(True); data=json.loads(self.body()); groups=data['groups']
    if not isinstance(groups,list) or len(groups)>30: raise ValueError('구분 그룹은 최대 30개입니다')
    ids=set()
    for group in groups:
     if not re.fullmatch(r'[a-zA-Z0-9-]{1,60}',group.get('id','')) or group['id'] in ids: raise ValueError('그룹 ID를 확인하세요')
     ids.add(group['id'])
     if any(not isinstance(group.get(k),str) or not group[k].strip() or len(group[k])>150 for k in ['name','equipmentMatch','reason']): raise ValueError('그룹 이름·설비 조건·이유를 입력하세요')
     options=group.get('options',[])
     if not isinstance(options,list) or not 2<=len(options)<=10 or any(not isinstance(v,str) or not v.strip() or len(v)>100 for v in options) or len({normalized(v) for v in options})!=len(options): raise ValueError('서로 다른 작업을 2~10개 입력하세요')
     group['required']=bool(group.get('required',True))
    with db() as c:
     c.execute('DELETE FROM ambiguity_groups')
     c.executemany('INSERT INTO ambiguity_groups VALUES(?,?)',[(g['id'],json.dumps(g,ensure_ascii=False)) for g in groups])
    return self.reply({'groups':groups})
   if path=='/api/work-types':
    self.auth(True); values=json.loads(self.body()).get('workTypes')
    if not isinstance(values,list) or not 1<=len(values)<=500 or any(not isinstance(v,str) or not v.strip() or len(v)>100 or any(ord(ch)<32 for ch in v) for v in values) or len({normalized(v) for v in values})!=len(values): raise ValueError('중복 없이 표준 작업을 한 줄에 하나씩 1~500개 입력하세요')
    with db() as c: c.execute("UPDATE app_config SET payload=? WHERE key='workTypes'",(json.dumps(values,ensure_ascii=False),))
    return self.reply({'workTypes':values})
   if path=='/api/worker-password':
    self.auth(True); data=json.loads(self.body()); change_worker_password(data.get('password'))
    return self.reply({'ok':True})
   if path=='/api/revoke':
    self.auth(True)
    with db() as c: c.execute('DELETE FROM logins')
    return self.reply({'ok':True})
   if path=='/api/upload':
    raw=self.body(); name=unquote(self.headers.get('X-Filename','upload.zip')); jid=secrets.token_urlsafe(18); folder=DATA/jid; folder.mkdir()
    job={'id':jid,'state':'uploaded','photos':[],'warnings':[]}; total=0; seen=set()
    try:
     entries=[]
     if raw[:2]==b'PK':
      z=zipfile.ZipFile(io.BytesIO(raw)); infos=z.infolist()
      if len(infos)>MAX_FILES: raise ValueError('ZIP 항목은 최대 2,000개입니다')
      for item in infos:
       safe_path(item.filename)
       if item.file_size>30*1024*1024 or item.file_size/max(item.compress_size,1)>200: raise ValueError('ZIP 압축 비율 또는 파일 크기 제한 초과')
       total+=item.file_size
      if total>MAX_TOTAL: raise ValueError('압축 해제 용량은 최대 1GB입니다')
      entries=((i.filename,z.open(i)) for i in infos if not i.is_dir())
     else: entries=[(name,io.BytesIO(raw))]
     for path,stream in entries:
      ext=Path(path).suffix.lower()
      if ext not in ['.jpg','.jpeg','.png']:
       job['warnings'].append(path+': 지원하지 않는 형식'); stream.close(); continue
      content=stream.read(30*1024*1024+1); stream.close()
      if len(content)>30*1024*1024: raise ValueError('사진당 최대 30MB입니다')
      try:
       with Image.open(io.BytesIO(content)) as im:
        if im.format not in ['JPEG','PNG'] or im.width*im.height>Image.MAX_IMAGE_PIXELS: raise ValueError('사진 형식 또는 픽셀 수 제한 초과')
        im.verify()
      except Exception:
       job['warnings'].append(path+': 손상되었거나 지원하지 않는 이미지 / 최대 4천만 픽셀'); continue
      sha=hashlib.sha256(content).hexdigest(); pid=secrets.token_hex(12); (folder/pid).write_bytes(content)
      job['photos'].append(dict(id=pid,path=safe_path(path),ext=ext,**infer(path),work='',equipmentType='',confirmed=False,excluded=False,rotation=0,duplicate=sha in seen)); seen.add(sha)
     if not job['photos']: raise ValueError('처리 가능한 사진이 없습니다')
     save_job(job,dev); return self.reply(job)
    except Exception:
     import shutil; shutil.rmtree(folder,ignore_errors=True); raise
   parts=path.split('/'); jid=parts[3]; job=load_job(jid,dev); action=parts[4]
   if job['state'] in ['analysis_queued','analysing','queued','generating'] and action in ['save','finish']: raise ValueError('생성 중에는 수정하거나 삭제할 수 없습니다')
   if action=='save':
    data=json.loads(self.body())
    if data.get('revision')!=job.get('revision',0): raise ConflictError('다른 탭에서 작업이 변경되었습니다. 진행 중인 작업을 다시 불러오세요')
    previous=json.dumps(job['photos'],sort_keys=True)
    incoming={p['id']:p for p in data['photos']}
    for p in job['photos']:
     v=incoming.get(p['id'],{})
     old_analysis_inputs=[p.get('rotation',0),p.get('equipmentType',''),p.get('hasExistingPlate',False)]
     for key in ['date','location','equipment','work','equipmentType','ambiguityChoice','ambiguityGroupId']:
      value=str(v.get(key,p.get(key,'')))
      if len(value)>150 or any(ord(ch)<32 for ch in value): raise ValueError('입력값은 줄바꿈 없이 150자 이내로 입력하세요')
      p[key]=value
     for key in ['confirmed','excluded','measurementScene','hasExistingPlate']: p[key]=bool(v.get(key,False))
     p['rotation']=int(v.get('rotation',0))%4
     if old_analysis_inputs!=[p.get('rotation',0),p.get('equipmentType',''),p.get('hasExistingPlate',False)] and p.get('recommendation'): p['analysisStatus']='stale'
    if json.dumps(job['photos'],sort_keys=True)!=previous:
     job['state']='uploaded'; job.pop('error',None)
     save_job(job,dev)
    return self.reply(job)
   if action=='analyse':
    if not vision.configured(): raise ValueError('서버의 OPENAI_API_KEY 설정이 필요합니다')
    if job['state'] in ['analysis_queued','analysing','queued','generating']: return self.reply(job)
    if not any(not p['excluded'] for p in job['photos']): raise ValueError('분석할 사진을 선택하세요')
    job['state']='analysis_queued'; job['analysisProgress']=0; job.pop('error',None); save_job(job,dev)
    return self.reply(job)
   if action=='generate':
    if job['state'] in ['analysis_queued','analysing','queued','generating','ready']: return self.reply(job)
    validate_photos(job['photos'])
    job['state']='queued'; job['progress']=0; job.pop('error',None); save_job(job,dev)
    return self.reply(job)
   if action=='finish':
    import shutil
    shutil.rmtree(DATA/jid,ignore_errors=True)
    with db() as c: c.execute('DELETE FROM jobs WHERE id=? AND device=?',(jid,digest(dev)))
    return self.reply({'ok':True})
   raise ValueError('잘못된 요청')
  except PermissionError as e: self.reply({'error':str(e)},401)
  except LoginLimitError as e: self.reply({'error':str(e)},429)
  except ConflictError as e: self.reply({'error':str(e)},409)
  except Exception as e: self.reply({'error':str(e)},400)
def generate(job,device_hash,stop=None):
 try:
  validate_photos(job['photos'])
  with db() as c: project=c.execute('SELECT project FROM settings').fetchone()[0]
  folder=DATA/job['id']; outputs=folder/'outputs'; outputs.mkdir(exist_ok=True)
  photos=[p for p in job['photos'] if not p['excluded']]
  used=set(); failures=0
  for i,p in enumerate(photos):
   if stop is not None and stop.is_set():
    job['state']='queued';save_job_hashed(job,device_hash);return
   try:
    # Rendering cache is independent of confirmation/AI; only actual output inputs count.
    material={k:p.get(k) for k in ['date','location','equipment','work','rotation']}
    signature=digest(json.dumps([material,project,FONT,'sample-profile-v1'],sort_keys=True,ensure_ascii=False))
    output_file=outputs/(p['id']+'.jpg')
    if p.get('renderSignature')!=signature or not output_file.exists():
     output=render(folder/p['id'],p,project)
     temporary=output_file.with_suffix('.tmp'); output.save(temporary,'JPEG',quality=85); temporary.replace(output_file)
    p['renderSignature']=signature; p.pop('generationError',None)
    name=str(PurePosixPath(p['path']).with_suffix('.jpg'))
    if name in used: name=str(PurePosixPath(name).with_name(PurePosixPath(name).stem+'_'+p['id']+'.jpg'))
    used.add(name); p['output_name']=name
   except Exception as error:
    p['generationError']=str(error); failures+=1
   job['progress']=i+1; save_job_hashed(job,device_hash)
  if failures:
   job['state']='failed'; job['error']=f'{failures}장 생성 실패. 표시된 사진을 수정하거나 제외한 후 다시 생성하세요.'
  else:
   temporary=folder/'result.tmp'
   with zipfile.ZipFile(temporary,'w',zipfile.ZIP_STORED) as archive:
    for p in photos: archive.write(outputs/(p['id']+'.jpg'),p['output_name'])
   temporary.replace(folder/'result.zip'); job['state']='ready'; job.pop('error',None)
  save_job_hashed(job,device_hash)
 except Exception as error:
  job['state']='failed'; job['error']=str(error); save_job_hashed(job,device_hash)
def analyse_job(job,device_hash,stop=None):
 groups=ambiguity_groups(); works=work_types()
 failures=0; selected=[p for p in job['photos'] if not p['excluded']]
 for index,p in enumerate(selected):
  if stop is not None and stop.is_set():
   job['state']='analysis_queued';save_job_hashed(job,device_hash);return
  signature=digest(json.dumps([p['id'],p.get('rotation',0),p.get('equipmentType',''),p.get('hasExistingPlate',False),works,groups,vision.fingerprint_settings()],sort_keys=True,ensure_ascii=False))
  if p.get('analysisSignature')==signature and p.get('recommendation'):
   p['analysisStatus']='complete';p.pop('analysisError',None);job['analysisProgress']=index+1;continue
  try:
   if p.get('analysisStatus')=='running':
    p['analysisStatus']='interrupted'
    raise ValueError('중단된 AI 호출은 중복 과금 방지를 위해 자동 재요청하지 않았습니다. 필요하면 AI 추천을 다시 요청하세요')
   with db() as c:
    count=c.execute('SELECT count(*) FROM ai_calls WHERE created>?',(time.time()-86400,)).fetchone()[0]
    if count>=int(os.environ.get('AI_DAILY_LIMIT','100')): raise ValueError('최근 24시간 AI 호출 한도에 도달했습니다')
    call_id=secrets.token_hex(16); c.execute('INSERT INTO ai_calls VALUES(?,?,?)',(call_id,time.time(),'started'))
   p['analysisStatus']='running';save_job_hashed(job,device_hash)
   response=vision.recommend(prepare_photo(DATA/job['id']/p['id'],p,mask_plate=p.get('hasExistingPlate',False)),p,works,groups)
   p['recommendation']=response
   result=response['result']
   if not p.get('equipmentType'): p['equipmentType']=result['equipmentType']
   p['analysisEquipmentType']=p['equipmentType']
   p['measurementScene']=bool(p.get('measurementScene') or result['measurementScene'])
   p['confirmed']=False; p['ambiguityChoice']='';p['ambiguityGroupId']=''
   # Recompute with accepted equipment hint to keep successful recovery cache stable.
   p['analysisSignature']=digest(json.dumps([p['id'],p.get('rotation',0),p.get('equipmentType',''),p.get('hasExistingPlate',False),works,groups,vision.fingerprint_settings()],sort_keys=True,ensure_ascii=False))
   p['analysisStatus']='complete';p.pop('analysisError',None)
   with db() as c:c.execute('UPDATE ai_calls SET status=? WHERE id=?',('complete',call_id))
  except Exception as error:
   if p.get('analysisStatus')=='running':p['analysisStatus']='failed'
   p['analysisError']=str(error);failures+=1
  job['analysisProgress']=index+1; save_job_hashed(job,device_hash)
  if p.get('analysisStatus')=='complete': time.sleep(max(0,min(10,float(os.environ.get('AI_MIN_INTERVAL_SECONDS','1')))))
 job['state']='uploaded'
 if failures:job['error']=f'{failures}장 AI 추천 실패 또는 보류. 직접 입력하거나 다시 요청하세요.'
 save_job_hashed(job,device_hash)

def recover_queue():
 # A single process owns this SQLite development deployment.
 with LOCK, db() as c:
  rows=c.execute("SELECT payload,device FROM jobs WHERE state IN ('generating','analysing') AND updated>?",(time.time()-86400,)).fetchall()
  for row in rows:
   job=json.loads(row['payload']); job['state']='analysis_queued' if job['state']=='analysing' else 'queued'; save_job_hashed(job,row['device'])
def worker_loop(stop):
 while not stop.is_set():
  claimed=None
  with LOCK, db() as c:
   row=c.execute("SELECT payload,device FROM jobs WHERE state IN ('queued','analysis_queued') AND updated>? ORDER BY updated LIMIT 1",(time.time()-86400,)).fetchone()
   if row:
    job=json.loads(row['payload']); job['state']='analysing' if job['state']=='analysis_queued' else 'generating'; save_job_hashed(job,row['device']); claimed=(job,row['device'])
  if claimed:
   try:
    (analyse_job if claimed[0]['state']=='analysing' else generate)(*claimed,stop=stop)
   except Exception:
    failed,device_hash=claimed;failed['state']='failed';failed['error']='처리 중 오류가 발생했습니다. 다시 요청하세요.';save_job_hashed(failed,device_hash)
  else: stop.wait(.25)
def start_worker():
 recover_queue(); stop=threading.Event()
 thread=threading.Thread(target=worker_loop,args=(stop,),daemon=True); thread.start()
 return stop,thread
def janitor(stop=None):
 stop=stop or threading.Event()
 while not stop.is_set():
  cleanup(); stop.wait(60)
if __name__=='__main__':
 init(); start_worker(); threading.Thread(target=janitor,daemon=True).start(); ThreadingHTTPServer(('0.0.0.0',int(os.environ.get('PORT',8000))),Handler).serve_forever()
