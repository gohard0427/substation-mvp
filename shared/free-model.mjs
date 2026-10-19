export const DEFAULT_PROJECT='2026~2026년도 시흥전력지사 변전협력회사 총액공사';
export class ValidationError extends Error {}
export const LIMITS={photos:200,source:8*1024*1024,result:2*1024*1024,zip:500*1024*1024,expanded:1024*1024*1024,pixels:20_000_000,storage:700*1024*1024};
export const PROFILE={width:911/2048,height:336/1536,label:132/2048,font:50/2048,padding:12/2048,version:'sample-profile-browser-v2-station-ss'};
export const normalized=value=>String(value||'').replace(/\s+/g,'').toLowerCase();
export function safePath(value){
 if(typeof value!=='string'||value.length>512||/[\x00-\x1f:]/.test(value))throw new ValidationError('안전하지 않은 파일 경로입니다.');
 const path=value.replaceAll('\\','/');const parts=path.split('/');
 if(path.startsWith('/')||parts.includes('..'))throw new ValidationError('안전하지 않은 파일 경로입니다.');
 return parts.filter(v=>v&&v!=='.').join('/');
}
export function infer(path){
 const folder=path.includes('/')?path.slice(0,path.lastIndexOf('/')):'.';
 let leaf=folder.split('/').at(-1);const match=(folder+' '+path).match(/(20\d{2})[-년./]?\s?(\d{2})[-월./]?\s?(\d{2})/);
 let date='';if(match){const candidate=`${match[1]}-${match[2]}-${match[3]}`;if(validDate(candidate))date=candidate;}
 leaf=leaf.replace(/^20\d{6}[_ -]*/,'').replace(/^20\d{2}[-.]\d{1,2}[-.]\d{1,2}[_ -]*/,'');
 const parts=leaf.split('_');return {date,location:leaf==='.'?'':parts.shift(),equipment:parts.join('_'),group:folder};
}
export function validDate(value){return /^20\d{2}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;}
export function groupFor(photo,groups){
 const obvious=['대상기기','작업전','작업후','분리','조립','청소','점검','교체'];
 return groups.find(g=>g.required&&((normalized(photo.equipmentType).includes(normalized(g.equipmentMatch))&&(g.id!=='pma-measurement'||photo.measurementScene||!obvious.includes(normalized(photo.work))))||(photo.recommendation?.result.ambiguityGroupId===g.id&&photo.equipmentType===photo.analysisEquipmentType)));
}
export function resolved(photo,groups){const group=groupFor(photo,groups);if(!group)return true;if(photo.ambiguityGroupId!==group.id)return false;return photo.ambiguityChoice==='__other__'?!!photo.work.trim():group.options.includes(photo.ambiguityChoice)&&normalized(photo.work)===normalized(photo.ambiguityChoice);}
export function validateConfirmed(photos,groups){
 const selected=photos.filter(p=>!p.excluded);if(!selected.length)throw new ValidationError('생성할 사진을 선택하세요.');
 for(const p of selected){if(!p.confirmed||['date','location','equipment','work'].some(k=>!p[k]?.trim()))throw new ValidationError('사진별 정보와 작업 내용을 확인하세요.');if(!validDate(p.date))throw new ValidationError('작업 일자를 확인하세요.');if(!resolved(p,groups))throw new ValidationError('구분 필요 작업을 직접 선택하세요.');}
}
export async function hash(value){const bytes=typeof value==='string'?new TextEncoder().encode(value):value;return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');}
export async function fingerprint(photo,project){return hash(JSON.stringify([photo.id,photo.hash,...['date','location','equipment','work'].map(k=>photo[k]||''),photo.rotation||0,project,PROFILE.version]));}
export function safePhotoUpdate(photo,input){
 const output={...photo};
 for(const key of ['date','location','equipment','work','equipmentType','ambiguityChoice','ambiguityGroupId']){
  const value=input[key]??photo[key]??'';
  if(typeof value!=='string'||value.length>150||/[\x00-\x1f]/.test(value))throw new ValidationError('입력값을 확인하세요. 줄바꿈 없이 150자 이내로 입력합니다.');output[key]=value;
 }
 for(const key of ['confirmed','excluded','measurementScene','hasExistingPlate'])output[key]=input[key]===true;
 output.rotation=Number(input.rotation??photo.rotation??0);if(!Number.isInteger(output.rotation)||output.rotation<0||output.rotation>3)throw new ValidationError('회전 값을 확인하세요.');
 if(photo.recommendation&&(output.rotation!==photo.rotation||output.equipmentType!==photo.equipmentType)){output.analysisStatus='stale';output.confirmed=false;output.ambiguityChoice='';output.ambiguityGroupId='';}
 return output;
}
export function imageInfo(bytes){
 if(bytes.length>=24&&bytes.slice(0,8).every((v,i)=>v===[137,80,78,71,13,10,26,10][i])){const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);return {mime:'image/png',width:view.getUint32(16),height:view.getUint32(20)};}
 if(bytes[0]===255&&bytes[1]===216){
  let i=2;
  while(i+4<=Math.min(bytes.length,262144)){
   if(bytes[i++]!==255)throw new ValidationError('손상된 JPEG입니다.');while(bytes[i]===255)i++;
   const marker=bytes[i++];if(marker===217||marker===218)break;
   if(marker===1||(marker>=208&&marker<=215))continue;
   const length=(bytes[i]<<8)|bytes[i+1];if(length<2||i+length>bytes.length)break;
   if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)&&length>=8)return {mime:'image/jpeg',width:(bytes[i+5]<<8)|bytes[i+6],height:(bytes[i+3]<<8)|bytes[i+4]};
   i+=length;
  }
 }
 throw new ValidationError('JPEG/PNG 형식이나 사진 크기를 확인할 수 없습니다.');
}
export function validateImage(bytes,result=false){const info=imageInfo(bytes);if(!info.width||!info.height||info.width*info.height>LIMITS.pixels)throw new ValidationError('사진은 최대 2천만 픽셀입니다.');if(result&&(info.mime!=='image/jpeg'||info.width>1280||info.height>960||info.width*3!==info.height*4))throw new ValidationError('출력은 최대 1280×960의 가로 4:3 JPEG여야 합니다.');return info;}
export function outputPaths(photos){const used=new Set();return photos.map(p=>{const base=safePath(p.path).replace(/\.[^.\/]+$/,'.jpg');let path=base,index=1;while(used.has(path.normalize('NFC').toLowerCase()))path=base.replace(/\.jpg$/,`_${p.id}_${index++}.jpg`);used.add(path.normalize('NFC').toLowerCase());return {photo:p,path};});}

export function formatStationName(value){
 const name=String(value||'').trim();if(!name)return '';
 if(/s\s*\/\s*s/i.test(name))return name.replace(/s\s*\/\s*s/gi,'S/S').replace(/\s*변전소\s*(?=S\/S)/g,'').replace(/\s+(?=S\/S)/g,'').replace(/(?:S\/S\s*)+$/,'S/S');
 return name.replace(/\s*변전소$/,'').trim()+'S/S';
}
