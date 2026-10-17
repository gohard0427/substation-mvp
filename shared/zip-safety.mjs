// Read only the ZIP end record before asking a library to allocate all entries.
export async function checkZipDirectory(file){
 const bytes=new Uint8Array(await file.slice(Math.max(0,file.size-65557)).arrayBuffer());const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 for(let i=bytes.length-22;i>=0;i--){
  if(view.getUint32(i,true)!==0x06054b50||i+22+view.getUint16(i+20,true)!==bytes.length)continue;
  const count=view.getUint16(i+10,true);
  if(view.getUint16(i+4,true)!==0||view.getUint16(i+6,true)!==0||view.getUint16(i+8,true)!==count)throw Error('여러 디스크로 나뉜 ZIP은 지원하지 않습니다.');
  if(count===65535||view.getUint32(i+12,true)===0xffffffff||view.getUint32(i+16,true)===0xffffffff)throw Error('ZIP64 대용량 파일은 하루 단위의 일반 ZIP으로 나누어 주세요.');
  if(count>2000)throw Error('ZIP 항목은 최대 2,000개입니다.');return count;
 }
 throw Error('ZIP 끝 정보를 읽을 수 없습니다. 손상되거나 지원하지 않는 ZIP입니다.');
}
export function zipEntryPath(entry){
 if(!entry.filenameUTF8&&entry.rawFilename?.some(b=>b>=128)){
  try{return new TextDecoder('utf-8',{fatal:true}).decode(entry.rawFilename);}catch{}
  // Korean Windows ZIPs often omit the UTF-8 flag and use CP949.
  try{return new TextDecoder('euc-kr',{fatal:true}).decode(entry.rawFilename);}catch{}
 }
 return entry.filename;
}
