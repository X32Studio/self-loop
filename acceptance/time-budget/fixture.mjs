// D-0060
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { snapshot, loadPlan, planContext, readyPlan } from '../../scripts/lib/plan.mjs';
export const root = fileURLToPath(new URL('../../', import.meta.url));
export const h = n => new Date(Date.parse('2030-01-01T00:00:00Z') + n * 3600000).toISOString();
export const digest = b => createHash('sha256').update(b).digest('hex');
export const json = x => JSON.stringify(x, null, 2) + '\n';
export const host = { admits:true, over:[], calls:[], cores:20, load:0.1, availableGB:32 };
export function fixture(t, { deadline = 24, packages, timed = true } = {}) {
  const dir = realpathSync(mkdtempSync(fileURLToPath(new URL('./.fixture-', import.meta.url))));
  t.after(() => rmSync(dir, { recursive:true, force:true }));
  const records = join(dir, 'records'), work = join(dir, 'work'), store = join(dir, 'store');
  for (const d of [records, work, store]) mkdirSync(d, { recursive:true });
  const env = { PATH:process.env.PATH, HOME:dir, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null', GIT_ALLOW_PROTOCOL:'file', GIT_TERMINAL_PROMPT:'0', GIT_AUTHOR_NAME:'TB acceptance', GIT_AUTHOR_EMAIL:'tb@example.invalid', GIT_COMMITTER_NAME:'TB acceptance', GIT_COMMITTER_EMAIL:'tb@example.invalid', SELF_LOOP_OWNER_STORE:store, SELF_LOOP_ADAPTERS:'none' };
  const git = (...args) => execFileSync('git', ['-C', records, ...args], { env, encoding:'utf8' }).trimEnd();
  const put = (path, value) => { const p = join(records,path); mkdirSync(dirname(p), {recursive:true}); writeFileSync(p, value); return p; };
  const commit = (message, hour = 0) => { git('add','-A'); execFileSync('git',['-C',records,'commit','-qm',message],{env:{...env,GIT_AUTHOR_DATE:h(hour),GIT_COMMITTER_DATE:h(hour)}}); return git('rev-parse','HEAD'); };
  git('init','-q','-b','main');
  put('decisions/D-0001.md', '# D-0001\nid: D-0001\nby: owner\nstatus: active\nAuthorize a usable save/reopen flow with acceptance, suite, CI and judge evidence; synthetic 24-hour example budget.\n');
  put('purpose/P-0001.md', '# P-0001\nUsable save/reopen, never sacrifice quality to meet an estimate.\n');
  put('metrics/handoffs.jsonl','');
  put('metrics/trajectory.jsonl','');
  put('metrics/windows.jsonl',JSON.stringify({type:'open',id:'W-0001',phase:'tb',startRound:1,horizon:12,goal:'time-budget fixture',invariants:['acceptance passes'],openedAt:h(0),openedBy:'lead'})+'\n');
  put('records.json',json({extraKinds:[{kind:'Plan',path:'plans/PL-NNNN.md',changes:'immutable',citedAs:'PL-NNNN'},{kind:'Forecast observation',path:'forecasts/FO-<digest>.json',changes:'immutable',settlesOwnerWords:false},{kind:'Continuation delivery',path:'metrics/continuations.jsonl',changes:'append-only',settlesOwnerWords:false},{kind:'Delegation',path:'delegations/T-NNNN.md',changes:'append-only'}]}));
  put('loop.json',json({product:records,records,workDir:work,phase:'tb',briefs:{},agents:{actor:{runner:'t3',provider:'codex',model:'fixture',effort:'high'}},branch:'main',setup:[]}));
  writeFileSync(join(store,'products.json'),json({roots:[],maxLoadRatio:1e9,minAvailableMemoryGB:0,products:[{name:'tb',records}]}));
  commit('Authority');
  const ref = (path, revision = git('rev-parse','HEAD')) => ({repository:records,commit:revision,path,sha256:digest(execFileSync('git',['-C',records,'show',`${revision}:${path}`],{env}))});
  const authority = ref('decisions/D-0001.md'), criteria = ref('purpose/P-0001.md');
  const items = packages ?? [{id:'a',needs:[]},{id:'b',needs:['a']}];
  const plan = {id:'PL-0001',scope:'usable-flow',phase:'tb',packages:items.map(p => ({authority:['D-0001'],goal:`Deliver ${p.id}`,files:[`src/${p.id}/**`],interface:'saved contract',role:'actor',acceptance:'verified usable outcome',handoff:`R-0001-actor-${p.id}`,settings:'current',...p}))};
  if(timed) plan.time = {schema:'plan-time/v2',rootPlan:plan.id,baseline:{previousRoot:null,startedAt:h(0),startRefs:[authority],deadline:deadline === null ? null : {at:h(deadline),authorityRefs:[authority]},minimum:{outcome:'usable save/reopen',criteriaRefs:[criteria],authorityRefs:[authority]},promises:[{id:'usable',dueAt:h(24),criteriaRefs:[criteria],authorityRefs:[authority]}]}};
  const writePlan = p => { put(`plans/${p.id}.md`,json(p)); for(const x of p.packages){mkdirSync(join(work,'tasks'),{recursive:true});writeFileSync(join(work,'tasks',`${x.handoff}.md`),`features: F-0012\n${x.goal}\n`);} };
  writePlan(plan); const initial = commit('Root plan');
  const state = (rev = 'HEAD') => snapshot(records,rev);
  const canonical = (id = 'PL-0001', rev = 'HEAD') => {const s=state(rev),p=loadPlan(s,id); return readyPlan(s,p,{context:planContext(s,p,{live:false}),host,now:Date.parse(h(1))});};
  const estimate = (low, high, asOf = 0, delay = [0,0]) => ({asOf:h(asOf),remaining:{lowSeconds:low*3600,highSeconds:high === null ? null : high*3600},availableAfter:{lowSeconds:delay[0]*3600,highSeconds:delay[1] === null ? null : delay[1]*3600},basisRefs:[authority],assumptions:['Independent fixture capacity assumption; no guaranteed release.'],unknowns:high === null ? ['external release unbounded'] : []});
  const observation = ({asOf=0, basedOn=git('rev-parse','HEAD'), parents=[], checkpoint=10, estimates={a:estimate(5,6,asOf),b:estimate(2,3,asOf)}, reserve=[0,0], planId='PL-0001', outcome='active'}={}) => ({schema:'plan-forecast/v1',rootRef:ref('plans/PL-0001.md',basedOn),planRef:ref(`plans/${planId}.md`,basedOn),parents,outlook:{asOf:h(asOf),observation:{observedAt:h(asOf),recordedAt:h(asOf),evidenceRefs:[authority]},basedOn,inputs:[authority,criteria,...[...state(basedOn).files].filter(p=>/^rounds\//.test(p)).map(p=>ref(p,basedOn))],releasePackages:[items.at(-1).id],reserve:{remaining:{lowSeconds:reserve[0]*3600,highSeconds:reserve[1] === null ? null : reserve[1]*3600},covers:reserve[1] === 0 ? [] : ['uncovered review, CI and rework'],basisRefs:[authority],assumptions:['No duplicated graph costs']},checkpointAt:h(checkpoint),change:{reason:'Measured independent estimate',authorityRefs:[authority],deferredPackages:[]},outcome:{state:outcome,evidenceRefs:[],deliveredAt:null}},estimates,promisesAdded:[]});
  const publish = (o, hour = (Date.parse(o.outlook.asOf)-Date.parse(h(0)))/3600000) => {const bytes=json(o),path=`forecasts/FO-${digest(bytes)}.json`;put(path,bytes);commit('Publish immutable forecast',hour);return ref(path);};
  const done = (id, hour) => {const p=plan.packages.find(p=>p.id===id),step=p.handoff.replace('R-0001-',''),record=`rounds/0001-${step}.md`,log=`evidence/0001/${step}.log.gz`;put(record,`# ${p.handoff}\nphase: tb\nrole: actor\n`);put(log,gzipSync([{timestamp:h(hour-1),type:'event_msg',payload:{type:'user_message'}},{timestamp:h(hour),type:'event_msg',payload:{type:'task_complete'}}].map(JSON.stringify).join('\n')));put('metrics/handoffs.jsonl',state().read('metrics/handoffs.jsonl')+JSON.stringify({id:p.handoff,round:1,phase:'tb',role:'actor',step,time:h(hour),product:null,record,attempt:1,files:[record,log],view:git('rev-parse','HEAD'),audit:{violations:0},agent:{runner:'codex',seconds:3600}})+'\n');return commit(`Complete ${id}`,hour);};
  const cli = (script,args) => spawnSync(process.execPath,[join(root,'scripts',script),...args],{cwd:dir,env,encoding:'utf8',timeout:20000});
  return {dir,records,work,store,env,git,put,commit,ref,authority,criteria,plan,writePlan,initial,state,canonical,estimate,observation,publish,done,cli};
}
export async function api() { return import('../../scripts/lib/plan-time.mjs'); }
export async function project(f, now, { revision='HEAD', planId='PL-0001', ...extra } = {}) {
  const m=await api(),s=f.state(revision),p=loadPlan(s,planId),history=m.loadForecastHistory(f.records,s.revision,p.time.rootPlan);
  return m.projectPlanTime(s,p,{now:h(now),clockMode:'simulation',canonicalPackagesAtQ:f.canonical(planId,revision).packages,forecastHistory:history,historicalSnapshots:history.snapshots,...extra});
}
