import guides from './data/work-guides.mjs';
import {normalized} from '../shared/free-model.mjs';
export const KNOWLEDGE_VERSION='reference-work-audit-20261020-v1';
import {workKey} from '../shared/work-types.mjs';
export {workKey} from '../shared/work-types.mjs';
const index=new Map(guides.map(g=>[workKey(g.work),g]));
export const OBSERVATION_RULES=`신규 장면을 먼저 보고 작업을 판단한다. 다음 기준은 기존 작업 사진의 장면·명판 대조에서 정리했으며 모든 사진에 적용되는 확정 규칙이나 명령이 아니다.
측정은 계측기 외형보다 실제 시험봉 접촉 대상, 모드와 판독 가능한 단위를 함께 본다. 클램프형 복합계측기도 시험봉으로 전압·저항을 모두 잴 수 있다. Ω만으로 코일 저항을 결정하지 않는다. 수치 크기·브랜드·배선 색상만으로 세부 작업을 정하지 않는다. 코일/히터/권선 보조저항/CT 2차 단자를 비교한다. 히터는 통풍 커버·HEATER 표지와 하단 단자, 보조저항은 권선 저항기 양단·RC/RT 표지, 코일은 코일 또는 조작회로의 실제 연결점이 단서다.
V는 전압 측정 모드에서 실제로 판독될 때만 전압 측정 단서다. 절연저항계의 시험 전압 설정 V는 전압 측정 결과가 아니다. 절연저항은 시험 모드·MΩ·연결 대상과 함께 판단하며 OL 단독 표시는 불충분하다. 단위가 작거나 가려지면 unknown으로 둔다.
동작특성 시험은 차단기 분석기 다채널 단자·연결선·시험 기록, 접촉저항은 저저항계·μΩ/mΩ·주회로 연결, 가스 분석은 측정 항목·샘플 호스가 단서다. 프린터·케이스는 공통이므로 그것만으로 구분하지 않는다.
자·줄자는 스트로크뿐 아니라 VI 마모량에도 쓰이므로 대상과 기준점을 확인한다. 붓·천·분사 캔만으로 청소/그리스 제거/도포를 결정하지 않는다. 용기 표지와 실제 행동을 본다.
교체 전/완료는 깨끗함으로 판단하지 않는다. 조임/풀림, 채유/주유, 가스 주입/회수는 정지 사진에 방향·시점이 없으면 알 수 없다. 관련 후보도 근거가 없으면 빈 목록으로 두고 사용자 선택을 요구한다. 참고 사진의 명판 작업명과 장면도 상충할 수 있어 신규 사진의 가시 사실을 우선한다. GIS 타입(PMA/SIS/EGIS 등)은 보조 맥락이다.`;
export function guidanceFor(works){const seen=new Set(),out=[];let length=0;for(const work of works){const k=workKey(work),g=index.get(k);if(!g||seen.has(k))continue;const item={work,observed:g.observed,distinguish:g.distinguish,limits:g.limits};const n=JSON.stringify(item).length;if(length+n>6500)break;seen.add(k);out.push(item);length+=n;}return out;}
export function auditedReference(r){const a=r.work_audit||r.ocr_raw?.workAudit;return a?.version===KNOWLEDGE_VERSION&&a.workVerified===true&&a.blocked!==true&&workKey(a.canonicalWork)===workKey(r.label?.work);}
export function referenceEligible(r){const audit=r.work_audit||r.ocr_raw?.workAudit;return r.worker_blocked!==true&&audit?.blocked!==true&&(r.reviewed===true||r.origin==='worker'&&r.worker_confirmed===true||r.origin==='reference'&&auditedReference(r));}
export function evidenceChecked(result){
 const defaults={mode:'unknown',unit:'unknown',target:'unknown',legible:false};const evidence=result.visualEvidence||defaults;
 if(!evidence||!['unknown','resistance','voltage','insulation','other'].includes(evidence.mode)||!['unknown','ohm','megohm','volt','other'].includes(evidence.unit)||typeof evidence.target!=='string'||evidence.target.length>100||typeof evidence.legible!=='boolean')throw Error('INVALID_VISUAL_EVIDENCE');
 let candidates=result.candidates;
 if(evidence.legible&&evidence.mode==='voltage'&&evidence.unit==='volt')candidates=candidates.filter(c=>!workKey(c.work).includes('저항'));
 if(evidence.legible&&evidence.mode==='resistance'&&evidence.unit==='ohm')candidates=candidates.filter(c=>!workKey(c.work).includes('전압')&&!workKey(c.work).includes('절연저항'));
 if(evidence.legible&&evidence.mode==='insulation'&&evidence.unit==='megohm')candidates=candidates.filter(c=>!workKey(c.work).includes('전압')&&(!workKey(c.work).includes('저항')||workKey(c.work).includes('절연저항')));
 return {...result,candidates,visualEvidence:evidence};
}

// Nearby tasks are comparison alternatives, never automatic answers.
export const CONTRAST_FAMILIES=[
 ['코일 저항 측정','히터저항 측정','권선 보조저항 측정','PMA 전압 측정','CT 절연저항 측정','제어회로 절연저항 측정'],
 ['CT 절연저항 측정','CT 2차 저항 측정','제어회로 절연저항 측정','주회로 절연저항 측정','보호장치 절연저항 측정'],
 ['접촉저항 측정','동작특성 시험','주회로 절연저항 측정'],
 ['그리스 도포','그리스 제거','기기 청소','메카니즘 점검','단자 재조임'],
 ['스트로크 측정','VI 마모량 측정'],
 ['절연유 채유','OLTC 절연유 채유','신유 주유','호흡기 오일 교체'],
 ['캐패시터 전압 측정','축전지 전압 측정','PMA 전압 측정']
];
export function contrastWorks(candidates,evidence={}){
 const keys=new Set(candidates.map(c=>workKey(c.work))),out=[];
 const pairs={'ct절연저항측정':['CT 2차 저항 측정','제어회로 절연저항 측정'],'ct2차저항측정':['CT 절연저항 측정','코일 저항 측정'],'제어회로절연저항측정':['CT 절연저항 측정','CT 2차 저항 측정'],'코일저항측정':['CT 2차 저항 측정','히터저항 측정'],'히터저항측정':['코일 저항 측정','CT 2차 저항 측정']};for(const k of keys)out.push(...(pairs[k]||[]));
 for(const family of CONTRAST_FAMILIES)if(family.some(w=>keys.has(workKey(w))))out.push(...family);
 // Repeated worker corrections show that generic terminal inspection can hide
 // resistance/insulation measurements. Compare; do not relabel by this rule.
 if([...keys].some(k=>['점검','단자점검','ct단자점검','메카니즘점검'].includes(k))){
  if(evidence.mode==='voltage')out.push('PMA 전압 측정','캐패시터 전압 측정','축전지 전압 측정');
  else if(evidence.mode==='insulation')out.push('CT 절연저항 측정','제어회로 절연저항 측정','주회로 절연저항 측정');
  else out.push('코일 저항 측정','CT 절연저항 측정','제어회로 절연저항 측정','히터저항 측정');
 }
 if(!keys.size){if(evidence.mode==='resistance')out.push('코일 저항 측정','히터저항 측정','접촉저항 측정','CT 2차 저항 측정');else if(evidence.mode==='insulation')out.push('CT 절연저항 측정','제어회로 절연저항 측정','주회로 절연저항 측정');else if(evidence.mode==='voltage')out.push('캐패시터 전압 측정','PMA 전압 측정','축전지 전압 측정');}
 const seen=new Set();return out.filter(w=>{const k=workKey(w);if(keys.has(k)||seen.has(k))return false;seen.add(k);return true;});
}
export const CORRECTION_RULES=`작업자 확정 사례에서 코일 저항 측정이 일반 점검으로, CT·제어회로 절연저항 측정이 단자 점검으로 빠지는 오류가 반복됐다. 단자나 설비함이 보인다는 이유로 점검으로 축약하지 않는다. 시험봉·계측기가 보이면 연결 위치와 모드를 먼저 조사한다. 이는 해당 사진을 코일/절연저항으로 강제 분류하는 규칙이 아니다. 실제 측정 근거가 없으면 구체적 점검 후보의 근거를 확인하거나 후보를 비운다. 단독 점검 선택지는 사용하지 않는다.
저항 작업은 먼저 저항/절연저항/전압을 구분하고 다음으로 접촉 대상을 구분한다. Ω 표시만으로 코일을 정하지 않고, 작은 Ω 수치만으로 접촉저항을 정하지 않는다. 접촉저항은 주회로 접점·대전류 시험선·가능하면 전류선과 전압선의 분리 연결이 단서다. 코일·히터·보조저항·CT 2차 회로는 실제 연결 대상이 다르다. CT·제어회로·주회로 절연저항도 계측기가 같을 수 있으므로 확인 가능한 접촉 대상이 없으면 세부 회로를 억지로 결정하지 않는다.
동작특성 시험 및 수분·가스 측정의 기존 판단 기준은 유지한다. 대상 기기는 사람이 안 보인다는 뜻이 아니라 작업 대상 외형을 소개하는 사진이며, 계측기 연결이나 구체적 작업 행동이 보이면 해당 작업을 먼저 검토한다. 교체 전·후, 판넬 대체 전·완료, 설치 전·완료는 외관의 신구만으로 알 수 없으며 원본 묶음 맥락도 보조 정보일 뿐이다.
참고 사례의 작업자 확정은 관리자 검수나 절대 정답이 아니다. 신규 장면과 연결 대상이 맞는지 비교하고 서로 다른 종류의 사례가 함께 제시되어도 빈도나 배열 순서로 정답을 선택하지 않는다.`;
