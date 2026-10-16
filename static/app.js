const $ = s => document.querySelector(s);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const normalized = value => String(value || '').replace(/\s+/g, '').toLowerCase();
const stateNames = {uploaded:'확인 중', analysis_queued:'AI 분석 대기', analysing:'AI 분석 중', queued:'생성 대기 중', generating:'명판 생성 중', ready:'다운로드 가능', failed:'생성 실패', deleting:'사진 삭제 중'};
let job, settings, poll, autosave, browserEngine, stopRequested = false, busy = false, blocked = false;
let editEpoch = 0, savedEpoch = 0, queue = Promise.resolve();
function notice(message) { $('#notice').textContent = message; }
async function api(path, data) {
  const r = await fetch(path, {method:data === undefined ? 'GET' : 'POST', headers:data === undefined ? {} : {'Content-Type':'application/json'}, body:data === undefined ? undefined : JSON.stringify(data)});
  const value = await r.json();
  if (!r.ok) { const error = Error(value.error); error.status = r.status; throw error; }
  return value;
}
function run(fn) { return async () => { try { await fn(); } catch (error) { notice(error.message); } }; }
function groupFor(photo) {
  const obvious = ['대상기기', '작업전', '작업후', '분리', '조립', '청소', '점검', '교체'];
  return settings.ambiguityGroups.find(g => g.required && (
    (normalized(photo.equipmentType).includes(normalized(g.equipmentMatch)) && (g.id !== 'pma-measurement' || photo.measurementScene || !obvious.includes(normalized(photo.work)))) ||
    (photo.recommendation?.result.ambiguityGroupId === g.id && photo.equipmentType === photo.analysisEquipmentType)
  ));
}
function resolved(photo, group = groupFor(photo)) {
  if (!group) return true;
  if (photo.ambiguityGroupId !== group.id) return false;
  return photo.ambiguityChoice === '__other__' ? !!photo.work.trim() : group.options.includes(photo.ambiguityChoice) && normalized(photo.ambiguityChoice) === normalized(photo.work);
}
function statusFor(photo) {
  if (photo.excluded) return '제외';
  if (photo.generationError) return '생성 실패';
  if (['date','location','equipment','work'].some(k => !photo[k]?.trim())) return '정보 누락';
  if (!resolved(photo)) return '사용자 선택 필요';
  return photo.confirmed ? '확인 완료' : '확인 대기';
}
async function boot() {
  settings = await api('/api/settings');
  if (settings.processingMode === 'browser' && !browserEngine) browserEngine = await import('./browser-engine.mjs');
  $('#freeModeInfo').hidden = !browserEngine;
  $('#modeLabel').textContent = browserEngine ? '무료 · 하루 작업 MVP' : '수동 작업 MVP';
  $('#uploadLimit').textContent = browserEngine ? 'JPG · PNG · ZIP / 작업당 최대 50장 · ZIP 90MiB' : 'JPG · PNG · ZIP / 최대 200MB';
  $('#project').value = settings.project;
  $('#workTypes').value = settings.workTypes.join('\n');
  $('#works').innerHTML = settings.workTypes.map(name => `<option>${esc(name)}</option>`).join('');
  $('#aiInfo').textContent = browserEngine ? '무료 MVP · AI 분석은 아직 연결되지 않았습니다. 작업 내용을 직접 입력하세요.' : settings.aiConfigured ? `AI 연결 설정됨 · ${settings.aiModel} · 최근 24시간 최대 ${settings.aiDailyLimit}회. 추천은 반드시 직접 확인하세요.` : 'AI 미연결 · 현재는 직접 입력할 수 있습니다. 서버에 API 키를 설정하면 추천을 요청할 수 있습니다.';
  $('#login').hidden = true;
  $('#workspace').hidden = false;
  $('#admin').hidden = settings.role !== 'admin';
  renderGroups();
  await list();
}
async function list() {
  const jobs = await api('/api/jobs');
  $('#jobs').replaceChildren();
  for (const saved of jobs) {
    const button = document.createElement('button'); button.className = 'secondary';
    button.textContent = `${saved.photos.length}장 · ${saved.photos[0]?.group} · ${stateNames[saved.state] || saved.state}`;
    button.onclick = run(async () => { if (!blocked) await flush(); open(await api('/api/jobs/' + saved.id)); });
    $('#jobs').append(button);
  }
}
$('#loginForm').onsubmit = async event => {
  event.preventDefault();
  try { await api('/api/login', {role:$('#role').value, password:$('#password').value}); $('#password').value = ''; await boot(); notice('로그인되었습니다.'); }
  catch (error) { notice(error.message); }
};
$('#restore').onclick = run(async () => { if (!blocked) await flush(); await list(); notice('저장된 작업을 선택하세요. 충돌이 있었다면 다시 불러온 내용이 적용됩니다.'); });
$('#saveSettings').onclick = run(async () => { await api('/api/settings', {project:$('#project').value}); notice('공사명을 저장했습니다. 다음 생성부터 적용됩니다.'); });
$('#revoke').onclick = run(async () => { if (confirm('모든 기기의 로그인 세션을 종료할까요?')) { await flush(); await api('/api/revoke', {}); location.reload(); } });
$('#upload').onchange = async event => {
  try {
    await flush();
    if (browserEngine) { busy = true; update(); try { open(await browserEngine.uploadFiles([...event.target.files],api,notice)); await list(); notice('업로드 완료. 서버에 작업용 사본과 진행 상태를 저장했습니다.'); } finally { busy = false; update(); } return; }
    for (const file of event.target.files) {
      notice(`${file.name} 업로드 및 폴더 분석 중…`);
      const r = await fetch('/api/upload', {method:'POST', headers:{'X-Filename':encodeURIComponent(file.name)}, body:file});
      const value = await r.json(); if (!r.ok) throw Error(value.error); open(value);
    }
    await list(); notice('업로드 완료. 사진별 정보를 검토하세요.');
  } catch (error) { notice(error.message); }
  finally { event.target.value = ''; }
};
function open(value) {
  clearTimeout(autosave); clearTimeout(poll); browserEngine?.clearPreviews();
  job = value; editEpoch = savedEpoch = 0; blocked = false;
  $('#editor').hidden = false;
  $('#jobTitle').textContent = `${job.photos.length}장의 작업 사진`;
  $('#warnings').textContent = job.warnings.join(' / ');
  $('#group').innerHTML = [...new Set(job.photos.map(p => p.group))].map(group => `<option>${esc(group)}</option>`).join('');
  $('#photos').innerHTML = job.photos.map(p => `<article class="panel photo" data-id="${p.id}">
    <div><img data-preview loading="lazy" src="${browserEngine ? 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' : `/api/jobs/${job.id}/image/${p.id}?rotation=${p.rotation}`}" alt="${esc(p.path)}">
    <h3>${esc(p.path)}</h3><span data-status class="tag"></span>
    <a data-result class="button secondary" hidden>완성 사진 다운로드 ↓</a>
    <p data-preview-label class="muted">방향 보정 미리보기</p>
    ${p.duplicate ? '<span class="tag">중복 사진 · 유지됨</span>' : ''}
    <label>방향 보정<select data-key="rotation">${[0,1,2,3].map(n => `<option value="${n}" ${p.rotation === n ? 'selected' : ''}>${n * 90}° 회전</option>`).join('')}</select></label></div>
    <div><div class="grid">${[['date','일자','date'], ['location','위치','text'], ['equipment','기기명','text'], ['equipmentType','설비 타입','text']].map(([key,label,type]) => `<label>${label}<input data-key="${key}" type="${type}" value="${esc(p[key])}"></label>`).join('')}</div>
    <label>작업 내용 · 직접 확정<input data-key="work" value="${esc(p.work)}" list="works" placeholder="사진에 해당하는 작업 하나를 입력"></label>
    <label class="check"><input data-key="measurementScene" type="checkbox" ${p.measurementScene ? 'checked' : ''}>측정 장면입니다 · 구분 필요 규칙 적용</label>
    <div data-ambiguity class="alert" hidden><strong>작업 내용 확인 필요</strong><p data-reason></p><label>직접 선택<select data-choice></select></label><p class="muted">기타를 선택하면 위 작업 내용란에 직접 입력하세요.</p></div>
    <label class="check"><input data-key="hasExistingPlate" type="checkbox" ${p.hasExistingPlate ? 'checked' : ''}>기존 명판이 있는 사진 · AI 분석 사본에서 명판 가리기</label><div data-recommendations></div>
    <label class="check"><input data-key="confirmed" type="checkbox" ${p.confirmed ? 'checked' : ''}>정보와 작업 내용을 확인했습니다</label>
    <label class="check"><input data-key="excluded" type="checkbox" ${p.excluded ? 'checked' : ''}>이번 결과물에서 제외</label></div></article>`).join('');
  $('#photos').oninput = onPhotoInput;
  $('#photos').onclick = event => { const button = event.target.closest('[data-candidate]'); if (!button) return; const input = button.closest('[data-id]').querySelector('[data-key="work"]'); input.value = button.dataset.candidate; onPhotoInput({target:input}); };
  update();
  if (!browserEngine && ['analysis_queued','analysing','queued','generating'].includes(job.state)) schedulePoll();
}
function onPhotoInput(event) {
  const card = event.target.closest('[data-id]'); if (!card) return;
  const photo = job.photos.find(p => p.id === card.dataset.id);
  const field = event.target, key = field.dataset.key;
  if (field.hasAttribute('data-choice')) {
    const group = groupFor(photo); photo.ambiguityGroupId = group?.id || ''; photo.ambiguityChoice = field.value;
    photo.work = field.value === '__other__' ? '' : field.value;
    card.querySelector('[data-key="work"]').value = photo.work;
  } else if (key) {
    if (['rotation','equipmentType','hasExistingPlate'].includes(key) && photo.recommendation) photo.analysisStatus = 'stale';
    delete photo.generationError;
    photo[key] = field.type === 'checkbox' ? field.checked : key === 'rotation' ? Number(field.value) : field.value;
    if (['equipmentType','measurementScene'].includes(key) || (key === 'work' && photo.ambiguityChoice !== '__other__')) {
      photo.ambiguityChoice = ''; photo.ambiguityGroupId = '';
    }
  }
  if (key !== 'confirmed' && key !== 'excluded') { photo.confirmed = false; card.querySelector('[data-key="confirmed"]').checked = false; }
  markDirty(); update();
}
function markDirty() {
  editEpoch++; job.state = 'uploaded'; job.error = '';
  clearTimeout(autosave);
  autosave = setTimeout(() => persist().catch(error => notice(error.message)), 900);
}
function update() {
  if (!job) return;
  const counts = {};
  for (const photo of job.photos) { const status = statusFor(photo); counts[status] = (counts[status] || 0) + 1; }
  const selected = job.photos.filter(p => !p.excluded);
  $('#count').textContent = `확인 ${counts['확인 완료'] || 0} / ${selected.length}`;
  $('#reviewSummary').textContent = Object.entries(counts).map(([name,count]) => `${name} ${count}장`).join(' · ');
  const locked = busy || ['analysis_queued','analysing','queued','generating'].includes(job.state);
  $('#analyse').disabled = locked || blocked || !settings.aiConfigured || !selected.length;
  $('#generate').disabled = job.state === 'deleting' || locked || blocked || !selected.length || selected.some(p => !p.confirmed || !resolved(p) || ['date','location','equipment','work'].some(k => !p[k]?.trim()));
  $('#save').disabled = locked || blocked;
  $('#applyBatch').disabled = locked || blocked;
  $('#download').hidden = job.state !== 'ready' || editEpoch !== savedEpoch;
  $('#finish').hidden = !['ready','deleting'].includes(job.state); $('#finish').disabled = locked;
  $('#resume').hidden = !browserEngine || job.state !== 'generating'; $('#resume').disabled = busy;
  $('#pause').hidden = !browserEngine || job.state !== 'generating';
  $('#discard').hidden = !job || ['generating','queued','analysing','analysis_queued'].includes(job.state); $('#discard').disabled = busy;
  if (browserEngine) $('#download').hidden = true;
  $('#download').href = `/api/jobs/${job.id}/download`;
  $('#download').download = '작업사진_명판.zip';
  const dates = !browserEngine && job.state === 'ready' ? [...new Set(selected.map(p => p.date))].sort() : [];
  $('#dateDownloads').innerHTML = dates.map(date => `<a class="button secondary" href="/api/jobs/${job.id}/download?date=${encodeURIComponent(date)}" download="${esc(date)}_작업사진.zip">${esc(date)} ZIP ↓</a>`).join('');
  for (const card of document.querySelectorAll('[data-id]')) {
    const photo = job.photos.find(p => p.id === card.dataset.id);
    const ready = job.state === 'ready' && !photo.excluded;
    const src = ready ? `/api/jobs/${job.id}/result/${photo.id}?v=${job.revision}` : `/api/jobs/${job.id}/image/${photo.id}?rotation=${photo.rotation}`;
    const img = card.querySelector('[data-preview]'); if (browserEngine) browserEngine.setPreview(img,job,photo,ready); else if (img.getAttribute('src') !== src) img.src = src;
    const link = card.querySelector('[data-result]'); link.hidden = !ready;
    link.href = `/api/jobs/${job.id}/result/${photo.id}?download=1`;
    card.querySelector('[data-preview-label]').textContent = ready ? '명판 합성 결과' : '방향 보정 미리보기';
    const result = photo.analysisStatus === 'complete' ? photo.recommendation?.result : null;
    card.querySelector('[data-recommendations]').innerHTML = result ? `<strong>AI 추천 · 직접 확인 필요</strong><p class="muted">${result.observations.map(esc).join(' · ')}</p>${result.candidates.map(candidate => `<button type="button" class="secondary" data-candidate="${esc(candidate.work)}" ${locked || blocked ? 'disabled' : ''}>${esc(candidate.work)}</button><p class="muted">${esc(candidate.reason)}</p>`).join('')}${result.candidates.length ? '' : '<p>사진만으로 추천할 수 없습니다. 직접 입력하세요.</p>'}` : `<p class="muted">${esc(photo.analysisError || (photo.analysisStatus === 'stale' ? '방향 또는 설비 정보가 바뀌어 AI 추천을 다시 요청해야 합니다.' : '사진별 AI 추천을 요청하거나 직접 입력하세요.'))}</p>`;
    card.querySelector('[data-status]').textContent = statusFor(photo) + (photo.generationError ? ': ' + photo.generationError : '');
    const group = groupFor(photo), panel = card.querySelector('[data-ambiguity]'), choice = card.querySelector('[data-choice]');
    panel.hidden = !group || photo.excluded;
    if (group) {
      card.querySelector('[data-reason]').textContent = `${group.name}: ${group.reason}. AI 점수와 관계없이 직접 선택해야 합니다.`;
      const signature = JSON.stringify(group);
      if (choice.dataset.signature !== signature) {
        choice.innerHTML = '<option value="">작업을 선택하세요</option>' + group.options.map(option => `<option value="${esc(option)}">${esc(option)}</option>`).join('') + '<option value="__other__">기타 — 직접 입력</option>';
        choice.dataset.signature = signature;
      }
      choice.value = photo.ambiguityGroupId === group.id ? photo.ambiguityChoice || '' : '';
    }
    for (const input of card.querySelectorAll('input,select')) input.disabled = locked || blocked || job.state === 'deleting';
  }
  renderFreeDownloads();
  $('#progress').textContent = job.state === 'deleting' ? '서버 사진을 정리 중입니다. 저장 완료를 누르면 삭제를 다시 시도합니다.' : browserEngine && job.state === 'generating' ? `이 기기에서 명판 생성 중 ${job.progress || 0}장 완료 · 화면을 닫으면 중지되며 다시 불러와 이어갈 수 있습니다.` : blocked ? '저장 충돌: 작업을 다시 불러오세요.' : job.state === 'analysis_queued' ? 'AI 분석 대기 중 · 서버에서 계속 처리합니다.' : job.state === 'analysing' ? `AI 분석 중 ${job.analysisProgress || 0}장 완료` : job.state === 'queued' ? '생성 대기 중 · 브라우저를 닫아도 이어집니다.' : job.state === 'generating' ? `명판 생성 중 ${job.progress || 0}장 완료` : job.state === 'ready' ? '생성 완료. 다운로드 후 저장 완료를 눌러 주세요.' : job.error || (editEpoch !== savedEpoch ? '저장 중 · 이 화면을 유지해 주세요.' : '진행 상태가 서버에 저장되어 있습니다.');
}
function persist() {
  clearTimeout(autosave);
  const target = job;
  const task = queue.catch(() => {}).then(async () => {
    if (!target || job !== target || editEpoch === savedEpoch) return;
    if (blocked) throw Error('저장 충돌이 있어 자동 저장을 중단했습니다. 작업을 다시 불러오세요.');
    const epoch = editEpoch;
    const photos = JSON.parse(JSON.stringify(target.photos));
    try {
      const saved = await api(`/api/jobs/${target.id}/save`, {photos, revision:target.revision || 0});
      if (job !== target) return;
      target.revision = saved.revision; savedEpoch = epoch;
      if (editEpoch === epoch) { target.state = saved.state; target.photos = saved.photos; }
      update();
    } catch (error) {
      if (error.status === 409) { blocked = true; update(); }
      throw error;
    }
  });
  queue = task; return task;
}
async function flush() {
  clearTimeout(autosave);
  await queue.catch(error => { if (blocked) throw error; });
  while (job && editEpoch !== savedEpoch) await persist();
}
function schedulePoll() { clearTimeout(poll); poll = setTimeout(refresh, 1200); }
async function refresh() {
  const id = job?.id;
  try { const value = await api('/api/jobs/' + id); if (job?.id !== id) return; if (['analysis_queued','analysing'].includes(job.state) && !['analysis_queued','analysing'].includes(value.state)) { open(value); return; } job = value; update(); if (!browserEngine && ['analysis_queued','analysing','queued','generating'].includes(job.state)) schedulePoll(); }
  catch (error) { notice(error.message + ' · 진행 중인 작업을 다시 불러올 수 있습니다.'); }
}
async function exclusive(fn) {
  if (busy) return;
  busy = true; update();
  try { await flush(); await fn(); } finally { busy = false; update(); }
}
$('#save').onclick = run(async () => { await flush(); notice('서버에 진행 상태를 저장했습니다.'); });
$('#applyBatch').onclick = run(async () => exclusive(async () => {
  for (const photo of job.photos.filter(p => p.group === $('#group').value)) {
    for (const [key,id] of [['date','batchDate'], ['location','batchLocation'], ['equipment','batchEquipment'], ['equipmentType','batchType']]) if ($('#' + id).value) photo[key] = $('#' + id).value;
    if ($('#batchPlate').value) photo.hasExistingPlate = $('#batchPlate').value === 'yes';
    photo.confirmed = false; photo.ambiguityChoice = ''; photo.ambiguityGroupId = '';
  }
  markDirty(); await flush(); open(job);
}));
$('#analyse').onclick = run(async () => exclusive(async () => { job = await api(`/api/jobs/${job.id}/analyse`, {}); update(); if (['analysis_queued','analysing'].includes(job.state)) schedulePoll(); }));
$('#generate').onclick = run(async () => exclusive(async () => { job = await api(`/api/jobs/${job.id}/generate`, {}); update(); if (browserEngine) await browserGenerate(); else if (['analysis_queued','analysing','queued','generating'].includes(job.state)) schedulePoll(); }));
$('#finish').onclick = run(async () => {
  if (!confirm('ZIP을 휴대폰 또는 PC에 저장했나요? 서버 사진과 결과물을 영구 삭제합니다.')) return;
  await exclusive(async () => { await api(`/api/jobs/${job.id}/finish`, {}); browserEngine?.clearPreviews(); job = null; $('#editor').hidden = true; await list(); notice('임시 사진과 결과물을 삭제했습니다.'); });
});
window.addEventListener('beforeunload', event => { if (editEpoch !== savedEpoch && job) { event.preventDefault(); event.returnValue = ''; } });
function renderGroups() {
  $('#ambiguityGroups').innerHTML = settings.ambiguityGroups.map(g => `<fieldset data-group="${esc(g.id)}"><legend>${esc(g.name)}</legend><label>그룹 이름<input data-field="name" value="${esc(g.name)}"></label><label>설비 타입에 포함되는 문구<input data-field="equipmentMatch" value="${esc(g.equipmentMatch)}"></label><label>구분할 작업 · 한 줄에 하나<textarea data-field="options" rows="3">${esc(g.options.join('\n'))}</textarea></label><label>혼동 이유<input data-field="reason" value="${esc(g.reason)}"></label><label class="check"><input data-field="required" type="checkbox" ${g.required ? 'checked' : ''}>사용자 직접 선택 필수</label></fieldset>`).join('');
}
$('#addGroup').onclick = () => { settings.ambiguityGroups.push({id:'group-' + crypto.randomUUID(), name:'새 구분 그룹', equipmentMatch:'', options:['',''], reason:'', required:true}); renderGroups(); };
$('#saveGroups').onclick = run(async () => {
  await flush();
  const groups = [...document.querySelectorAll('[data-group]')].map(fieldset => {
    const group = {id:fieldset.dataset.group};
    for (const input of fieldset.querySelectorAll('[data-field]')) group[input.dataset.field] = input.type === 'checkbox' ? input.checked : input.dataset.field === 'options' ? input.value.split('\n').map(s => s.trim()).filter(Boolean) : input.value.trim();
    return group;
  });
  const saved = await api('/api/ambiguity-groups', {groups}); settings.ambiguityGroups = saved.groups; renderGroups(); update(); notice('구분 필요 그룹을 저장했습니다. 현재 사진에도 새 규칙이 적용됩니다.');
});


$('#changeWorkerPassword').onclick = run(async () => { await api('/api/worker-password', {password:$('#newWorkerPassword').value}); $('#newWorkerPassword').value = ''; notice('공용 비밀번호를 변경하고 기존 작업자 세션을 종료했습니다.'); });

$('#saveWorkTypes').onclick = run(async () => { const workTypes = $('#workTypes').value.split('\n').map(s => s.trim()).filter(Boolean); await api('/api/work-types', {workTypes}); settings.workTypes = workTypes; $('#works').innerHTML = workTypes.map(name => `<option>${esc(name)}</option>`).join(''); notice('표준 작업 목록을 저장했습니다. 다음 AI 분석부터 적용됩니다.'); });

async function browserGenerate() {
  stopRequested = false;
  job = await browserEngine.generate(job,api,current => { job = current; update(); },() => stopRequested);
  update();
}
$('#resume').onclick = run(async () => exclusive(browserGenerate));
$('#pause').onclick = run(async () => {
  if (busy) { stopRequested = true; notice('현재 사진 처리가 끝나면 중지합니다.'); }
  else await exclusive(async () => { job = await api(`/api/jobs/${job.id}/pause`,{}); update(); });
});
$('#discard').onclick = run(async () => {
  if (!confirm('이 작업과 서버의 모든 임시 사진을 삭제할까요? 삭제 후 복구할 수 없습니다.')) return;
  await exclusive(async () => { await api(`/api/jobs/${job.id}/finish`,{}); browserEngine?.clearPreviews(); job = null; editEpoch = savedEpoch = 0; $('#editor').hidden = true; await list(); notice('작업을 종료하고 서버 파일을 삭제했습니다.'); });
});
let freeDownloadKey = '';
function renderFreeDownloads() {
  const container = $('#freeDownloads');
  if (!browserEngine || job.state !== 'ready') { container.replaceChildren(); freeDownloadKey = ''; return; }
  const key = job.id + ':' + job.revision + ':' + busy;
  if (freeDownloadKey === key) return;
  freeDownloadKey = key; container.replaceChildren();
  for (const date of ['', ...new Set(job.photos.filter(p => !p.excluded).map(p => p.date))]) {
    const plans = browserEngine.downloadPlans(job,date);
    plans.forEach((entries,index) => {
      const button = document.createElement('button'); button.className = 'secondary'; button.disabled = busy;
      button.textContent = `${date || '전체'} ZIP ${plans.length > 1 ? `${index+1}/${plans.length}` : ''} 다운로드 ↓`;
      button.onclick = run(async () => exclusive(async () => {
        const blob = await browserEngine.downloadZip(job,entries,notice);
        browserEngine.saveBlob(blob,`${date || '전체'}_작업사진${plans.length>1?'_'+(index+1):''}.zip`);
        notice('다운로드를 요청했습니다. 모든 ZIP의 실제 저장을 확인한 후 저장 완료를 눌러 주세요.');
      })); container.append(button);
    });
  }
}

boot().catch(error => { if (error.status !== 401) notice(error.message); });
