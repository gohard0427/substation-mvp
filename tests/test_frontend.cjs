const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function harness() {
  const elements = new Map();
  const context = vm.createContext({
    document: {querySelector: id => { if (!elements.has(id)) elements.set(id, {replaceChildren() {},setAttribute() {}}); return elements.get(id); }, querySelectorAll: () => []},
    window: {addEventListener() {}}, setTimeout() { return 1; }, clearTimeout() {},
    fetch: async () => { throw Error('not logged in'); }, console,
  });
  vm.runInContext(fs.readFileSync('static/app.js','utf8'), context);
  vm.runInContext(`settings={ambiguityGroups:[]};job={id:'test',revision:1,state:'uploaded',photos:[{id:'photo',date:'2026-10-16',location:'위치',equipment:'기기',equipmentType:'',work:'점검',confirmed:false,excluded:false}]};`, context);
  return {context, evaluate: code => vm.runInContext(code, context)};
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('slow save response preserves newer edits and serializes the next save', async () => {
  const {context, evaluate} = harness();
  const pending = [];
  context.capture = (path, data) => new Promise(resolve => pending.push({path,data,resolve}));
  evaluate('api=capture;markDirty();');
  const first = evaluate('persist()'); await tick();
  evaluate(`job.photos[0].work='교체';markDirty();`);
  const second = evaluate('persist()');
  assert.equal(pending.length,1);
  pending[0].resolve({revision:2,state:'uploaded',photos:pending[0].data.photos});
  await first; await tick();
  assert.equal(evaluate('job.photos[0].work'),'교체');
  assert.equal(pending.length,2);
  assert.equal(pending[1].data.revision,2);
  assert.equal(pending[1].data.photos[0].work,'교체');
  pending[1].resolve({revision:3,state:'uploaded',photos:pending[1].data.photos});
  await second;
  assert.equal(evaluate('savedEpoch'),evaluate('editEpoch'));
  assert.equal(evaluate('job.revision'),3);
});
test('conflicting tab save stops autosave and surfaces conflict state', async () => {
  const {context,evaluate} = harness();
  context.fail = async () => { const error=Error('충돌');error.status=409;throw error; };
  evaluate('api=fail;markDirty();');
  await assert.rejects(evaluate('persist()'),/충돌/);
  assert.equal(evaluate('blocked'),true);
  assert.equal(evaluate('savedEpoch'),0);
  await assert.rejects(evaluate('persist()'),/자동 저장을 중단/);
});
test('older job save response cannot replace the newly opened job', async () => {
  const {context,evaluate} = harness();
  let complete;
  context.capture = () => new Promise(resolve => complete=resolve);
  evaluate('api=capture;markDirty();');const pending=evaluate('persist()');await tick();
  evaluate(`job={id:'new-job',revision:7};editEpoch=savedEpoch=0;`);
  complete({revision:2,state:'uploaded',photos:[]});await pending;
  assert.equal(evaluate('job.id'),'new-job');assert.equal(evaluate('job.revision'),7);
});
test('recommendations fill only blank ordinary work and never confirm ambiguity or overwrite edits', async () => {
 const {evaluate}=harness();
 evaluate(`settings.ambiguityGroups=[{id:'pma',equipmentMatch:'PMA',required:true,options:['코일 저항 측정','PMA 전압 측정']}];
 job.photos=[
 {id:'a',work:'',equipmentType:'GIS',analysisStatus:'complete',recommendation:{result:{candidates:[{work:'동작특성 시험'}]}}},
 {id:'b',work:'',equipmentType:'PMA GIS',analysisStatus:'complete',recommendation:{result:{candidates:[{work:'코일 저항 측정'}]}}},
 {id:'c',work:'직접 수정',equipmentType:'GIS',analysisStatus:'complete',recommendation:{result:{candidates:[{work:'점검'}]}}}];
 browserEngine={analyse:async value=>value};flush=async()=>{};update=()=>{};`);
 await evaluate('analyseCurrent()');
 assert.equal(evaluate('job.photos[0].work'),'동작특성 시험');
 assert.equal(evaluate('!!job.photos[0].confirmed'),false);
 assert.equal(evaluate('job.photos[1].work'),'');
 assert.equal(evaluate('job.photos[2].work'),'직접 수정');
});

test('pending review excludes confirmed and excluded photos but includes incomplete confirmations',()=>{
 const {evaluate}=harness();
 assert.equal(evaluate('needsConfirmation(job.photos[0])'),true);
 evaluate('job.photos[0].confirmed=true');assert.equal(evaluate('needsConfirmation(job.photos[0])'),false);
 evaluate("job.photos[0].location=''");assert.equal(evaluate('needsConfirmation(job.photos[0])'),true);
 evaluate('job.photos[0].excluded=true');assert.equal(evaluate('needsConfirmation(job.photos[0])'),false);
});
