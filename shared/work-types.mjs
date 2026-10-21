// Explicit semantic aliases only. Keep CT terminal, contact resistance, etc. distinct.
const compact=s=>String(s||'').replace(/\s+/g,'').toLowerCase();
export const WORK_ALIASES={'단자점검':'단자 점검','단자대점검':'단자 점검','캐패시터전압측정':'콘덴서 전압 측정','콘덴서전압측정':'콘덴서 전압 측정','스크로크측정':'스트로크 측정','스트로크측정':'스트로크 측정'};
export const canonicalWork=work=>WORK_ALIASES[compact(work)]||String(work||'').trim();
export const workKey=work=>compact(canonicalWork(work));
export function uniqueWorks(works){const seen=new Set();return works.map(canonicalWork).filter(w=>{const k=workKey(w);if(!k||k==='점검'||seen.has(k))return false;seen.add(k);return true;});}
export function effectiveWorkTypes(cfg,references=[]){return uniqueWorks([...(cfg.workTypes||[]),...references.filter(r=>r.origin==='worker'&&r.worker_confirmed&&!r.worker_blocked&&r.image_ready&&r.split==='train'&&r.work_audit?.blocked!==true).map(r=>r.label?.work).filter(w=>typeof w==='string'&&w.trim()&&w.length<=100&&!/[\x00-\x1f]/.test(w))]).slice(0,500);}
