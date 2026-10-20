import guides from './data/work-guides.mjs';
import {normalized} from '../shared/free-model.mjs';
export const KNOWLEDGE_VERSION='reference-work-audit-20261020-v1';
const aliases=new Map([['캐패시터전압측정','콘덴서전압측정'],['스크로크측정','스트로크측정']]);
export const workKey=work=>aliases.get(normalized(work))||normalized(work);
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
 return {...result,candidates,visualEvidence:evidence};
}
