import {test} from 'node:test';import assert from 'node:assert/strict';import {checkZipDirectory,zipEntryPath} from '../shared/zip-safety.mjs';
function end(count,disk=0){const bytes=new Uint8Array(22),v=new DataView(bytes.buffer);v.setUint32(0,0x06054b50,true);v.setUint16(4,disk,true);v.setUint16(8,count,true);v.setUint16(10,count,true);return new Blob([bytes]);}
test('ZIP excessive directory count is rejected before allocating entries',async()=>{await assert.rejects(checkZipDirectory(end(2001)),/2,000/);});
test('ZIP64, split ZIP and missing end records are rejected',async()=>{await assert.rejects(checkZipDirectory(end(65535)),/ZIP64/);await assert.rejects(checkZipDirectory(end(1,1)),/디스크/);await assert.rejects(checkZipDirectory(new Blob(['corrupted'])),/끝 정보/);});
test('legacy CP949 and unflagged UTF-8 preserve Korean filenames',()=>{assert.equal(zipEntryPath({filenameUTF8:false,filename:'bad',rawFilename:new Uint8Array([199,209,177,219,46,106,112,103])}),'한글.jpg');assert.equal(zipEntryPath({filenameUTF8:false,filename:'bad',rawFilename:new TextEncoder().encode('한글.jpg')}),'한글.jpg');});

import {outputPaths} from '../shared/free-model.mjs';
test('case-insensitive output filenames remain distinct for Windows extraction',()=>{const result=outputPaths([{id:'a',path:'작업/PHOTO.JPG'},{id:'b',path:'작업/photo.jpg'}]);assert.notEqual(result[0].path.toLowerCase(),result[1].path.toLowerCase());});
