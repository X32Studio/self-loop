// self-loop-records@cc91f1d:evidence/0012/admitted-positive-evidence/effective-contract.json
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { join, dirname, basename } from 'node:path';
import { snapshot, loadPlan, planContext, readyPlan } from '../../scripts/lib/plan.mjs';
import { loadForecastHistory } from '../../scripts/lib/plan-time.mjs';
export const digest = x => createHash('sha256').update(x).digest('hex');
export const json = x => JSON.stringify(x, null, 2) + '\n';
export const at = x => `2026-11-22T${x}:00Z`;
export const canonical = x => x === null || typeof x !== 'object' ? JSON.stringify(x) : Array.isArray(x) ? `[${x.map(canonical).join(',')}]` : `{${Object.keys(x).sort().map(k => `${JSON.stringify(k)}:${canonical(x[k])}`).join(',')}}`;
export const specIds = ['positive-on-time','positive-late','optional-deferral','timely-forecast-publication','late-publication-earlier-delivery','wrong-candidate','wrong-repository','wrong-host','missing-check','red-gate','wrong-suite-tree','incomplete-criterion','wrong-criterion-bytes','unavailable-artifact','wrong-recipient','required-deferral','self-optional-list','backdated-publication','untrusted-time','wrong-event-subject','gate-finished-after-event','unassigned-issuer','archive-mismatch','missing-history','foreign-promise','late-historical-handoff-proof','conflicting-assessments','current-regression'];
export function positiveFixture(t, id = 'positive-on-time', { external = false, crossRepo = false } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'self-loop-positive-')));
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  const records = join(dir, 'records'), product = join(dir, 'product'), archiveRepo = crossRepo ? join(dir, 'archive') : records;
  const env = {...process.env, HOME:dir, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null', GIT_TERMINAL_PROMPT:'0', GIT_NO_REPLACE_OBJECTS:'1', GIT_AUTHOR_NAME:'Synthetic archival root', GIT_COMMITTER_NAME:'Synthetic archival root', GIT_AUTHOR_EMAIL:'fixture@example.invalid', GIT_COMMITTER_EMAIL:'fixture@example.invalid'};
  const run = (repo, ...args) => execFileSync('git', ['-C',repo,...args], {env, encoding:'utf8',stdio:['ignore','pipe','pipe']}).trimEnd();
  const putIn = (repo,p,s) => {mkdirSync(dirname(join(repo,p)),{recursive:true});writeFileSync(join(repo,p),s);};
  const commitIn = (repo,msg) => {run(repo,'add','-A');execFileSync('git',['-C',repo,'commit','--allow-empty','-qm',msg],{env:{...env,GIT_AUTHOR_DATE:at('10:00'),GIT_COMMITTER_DATE:at('10:00')}});return run(repo,'rev-parse','HEAD');};
  for (const repo of new Set([records,product,archiveRepo])) {mkdirSync(repo);run(repo,'init','-q','-b','main');}
  const put = (p,s) => putIn(records,p,s), commit = msg => commitIn(records,msg), git = (...args) => run(records,...args);
  const ref = (path, revision = git('rev-parse','HEAD')) => ({repository:records,commit:revision,path,sha256:digest(execFileSync('git',['-C',records,'show',`${revision}:${path}`],{env}))});
  putIn(product,'artifact.txt','Synthetic install/read and revise/restart artifact\n');const sha=commitIn(product,'Synthetic product');
  const candidate = {repository:product,sha,tree:run(product,'rev-parse',`${sha}^{tree}`),destination:{host:'github.com',repository:'fixture/product'}};
  put('purpose/P-0001.md','# M1\nInstall and read the delivered artifact.\n');
  put('purpose/P-0002.md','# M2\nRevise and restart without loss of original budget.\n'+(id==='ambiguous-selector'?'# M2\nConflicting criterion.\n':''));
  put('purpose/P-0003.md','# M3\nDifferent promise: export the report.\n');
  put('decisions/D-0001.md','# Authority\nSynthetic archival root stipulated by acceptance only; no physical clock or production provenance proof.\nIndependentJudge judge request-scope scope-assess request-release release-assess request-event event-attest\nR-0012-judge-scope R-0012-judge-release R-0012-judge-event\nPL-0001 minimum M1 M2; core and restart required.\n## Optional\npolish optional; omission approved by owner before assessment.\n');
  const assignment = ['scope','release','event'].map(type => `${digest(`features: F-0012\nIndependent ${type} assessment of PL-0001.\n`)} ${Array.from({length:26},(_,i)=>`R-0012-judge-${type}-${String.fromCharCode(97+i)}`).join(' ')}`).join('\n');
  const initialAuthority = '# Authority\nSynthetic archival root; no production execution or clock claim.\nIndependentJudge judge request-scope scope-assess request-release release-assess request-event event-attest\n' + assignment + '\nPL-0001 minimum M1 M2; core and restart required.\n## Optional\npolish optional; omission approved by owner before assessment.\n';
  let authorityBytes = initialAuthority;
  if(id==='duplicate-authorization') authorityBytes = '{"grant":"denied","grant":'+JSON.stringify(initialAuthority)+'}';
  if(id==='json-root-authorization') authorityBytes = json({grant:initialAuthority.replaceAll('\n',' ')});
  if(id==='json-authorization') authorityBytes = json({'grant/key':{'~assignment':initialAuthority}});
  if(id==='ambiguous-authorization') authorityBytes += '# Authority\nRepeated section\n';
  put('decisions/D-0001.md',authorityBytes);
  put('metrics/handoffs.jsonl','');put('metrics/trajectory.jsonl','');
  for(const type of ['scope','release','event'])put(`tasks/request-${type}.md`,`features: F-0012\nIndependent ${type} assessment of PL-0001.\n`);
  const policy={product,records,phase:'positive',workDir:join(dir,'work'),briefs:{},agents:{},branch:'main',gates:{require:['github-actions/linux','github-actions/macos'],suite:'node --test synthetic.test.mjs'}};
  if(id==='missing-policy-require') delete policy.gates.require;
  if(id==='explicit-empty-policy') policy.gates.require=[];
  put('loop.json',json(policy));
  commit('Synthetic policy before assigned assessment');
  const authority=ref('decisions/D-0001.md'), criteria=[ref('purpose/P-0001.md'),ref('purpose/P-0002.md')], foreign=ref('purpose/P-0003.md');
  const plan={id:'PL-0001',scope:'usable-flow',phase:'positive',packages:[['core',[]],['restart',['core']],['polish',[]]].map(([id,needs])=>({id,needs,authority:['D-0001'],goal:`Deliver ${id}`,files:[`src/${id}/**`],interface:'artifact',role:'actor',acceptance:'usable outcome',handoff:`R-0001-actor-${id}`,settings:'current'})),time:{schema:'plan-time/v2',rootPlan:'PL-0001',baseline:{previousRoot:null,startedAt:at('00:00'),startRefs:[authority],deadline:{at:at('12:00'),authorityRefs:[authority]},minimum:{outcome:'usable artifact',criteriaRefs:criteria,authorityRefs:[authority]},promises:[{id:'P1',dueAt:at('12:00'),criteriaRefs:['foreign-promise','different-promise-complete'].includes(id)?[criteria[0],foreign]:criteria,authorityRefs:[authority]}]}}};
  put('plans/PL-0001.md',json(plan));const basedOn=commit('Immutable plan');const planRef=ref('plans/PL-0001.md');
  const estimate={asOf:at('10:00'),remaining:{lowSeconds:1800,highSeconds:2400},availableAfter:{lowSeconds:0,highSeconds:0},basisRefs:[authority],assumptions:['Synthetic fixed capacity'],unknowns:[]};
  const observation=(base=basedOn,parents=[],asOf=at('10:00'))=>({schema:'plan-forecast/v1',rootRef:planRef,planRef,parents,outlook:{asOf,observation:{observedAt:asOf,recordedAt:asOf,evidenceRefs:[authority]},basedOn:base,inputs:[authority,...criteria],releasePackages:['restart'],reserve:{remaining:{lowSeconds:0,highSeconds:0},covers:[],basisRefs:[authority],assumptions:['No additional reserve']},checkpointAt:at('11:00'),change:{reason:'Synthetic observation',authorityRefs:[authority],deferredPackages:[]},outcome:{state:'active',evidenceRefs:[],deliveredAt:null}},estimates:Object.fromEntries(plan.packages.map(p=>[p.id,{...estimate,asOf}])),promisesAdded:[]});
  const publish=o=>{const raw=json(o),p=`forecasts/FO-${digest(raw)}.json`;put(p,raw);commit('Immutable synthetic forecast');return ref(p);};
  const fo=observation();if(id==='raw-deliveredAt'){fo.outlook.outcome.state='delivered';fo.outlook.outcome.deliveredAt=at('11:50');}
  let foRef=publish(fo);const beforeEvidence=git('rev-parse','HEAD');
  let serial=0;
  function binding(type,claim,{bad='',supersedes=[]}={}) {
    const envelope={schema:'plan-time-binding/v1',type,rootRef:planRef,planRef,basedOn,sourceRef:null,authorizationRef:authority,authorizationSelector:['duplicate-authorization','json-root-authorization'].includes(id)?'':id==='json-authorization'?'/grant~1key/~0assignment':'# Authority',provenanceRefs:[],supersedes,claim};
    const endorsement=digest(canonical({type,rootRef:planRef,planRef,basedOn,claim}));
    const n=++serial, role=bad==='role'?'actor':'judge', step=`${role}-${type}-${String.fromCharCode(96+n)}`, sourcePath=external?`evidence/0012/archive-${n}/source.json`:`rounds/0012-${step}.md`, view=git('rev-parse','HEAD');
    let source={author:'IndependentJudge',role:'judge',requestId:`request-${type}`,endorsesClaim:endorsement};
    if(id==='external-structured-claim'){delete source.endorsesClaim;source.claim=claim;}
    if(type==='scope'&&id==='external-wrong-role')source.role='actor';
    if(type==='scope'&&id==='external-wrong-context')source.planRef={...planRef,sha256:'f'.repeat(64)};
    if(bad==='issuer') delete source.author;
    if(bad==='request') source.requestId='unassigned-request';
    if(bad==='role') source.role='actor';
    if(bad==='claim') source.endorsesClaim='0'.repeat(64);
    let raw=json(source);if(bad==='duplicate-source') raw=raw.replace('"author":','"author":"Intruder", "author":');
    putIn(external?archiveRepo:records,sourcePath,raw);
    const row={id:`R-0012-${step}`,round:12,phase:'positive',role,step,view,task:digest(`features: F-0012\nIndependent ${type} assessment of PL-0001.\n`),files:[sourcePath],record:sourcePath,attempt:n,product:{base:sha,commit:sha},audit:{violations:0},agent:{runner:'synthetic'},time:at('11:40')};
    if(bad==='missing-task') delete row.task;
    if(bad==='request')row.task=digest('Unassigned request');
    if(bad==='unlisted-source') put(`evidence/0012/unlisted-${n}.json`,raw);
    if(bad==='wrong-view') row.view='f'.repeat(40);
    if(!external) put('metrics/handoffs.jsonl',git('show',`${view}:metrics/handoffs.jsonl`) + (git('show',`${view}:metrics/handoffs.jsonl`)?'\n':'') + JSON.stringify(row)+'\n');
    if(external) {
      const platform={status:'completed',latestTerminalStatus:'completed',hasPendingChildRuns:false,taskId:`request-${type}`,childThreadId:'IndependentJudge',childRunId:`synthetic-run-${n}`,latestTerminalRunId:`synthetic-run-${n}`};
      if(type==='scope') {
        if(id==='external-wrong-thread')platform.childThreadId='OtherJudge';
        if(id==='external-wrong-request')platform.taskId='other-request';
        if(id==='external-wrong-run')platform.latestTerminalRunId='other-run';
        if(id==='external-wrong-status')platform.status='failed';
        if(id==='external-wrong-terminal')platform.latestTerminalStatus='failed';
        if(id==='external-pending')platform.hasPendingChildRuns=true;
      }
      const platformPath=`${dirname(sourcePath)}/platform.json`, manifestPath=`${dirname(sourcePath)}/archive-hashes.json`;
      const platformRaw=json(platform), hashes={[basename(sourcePath)]:digest(raw),'platform.json':digest(platformRaw)};
      if(type==='scope'&&id==='external-wrong-hash') hashes[basename(sourcePath)]='a'.repeat(64);
      if(type==='scope'&&id==='external-traversal') hashes['../source.json']=hashes[basename(sourcePath)];
      putIn(archiveRepo,platformPath,platformRaw);putIn(archiveRepo,manifestPath,json(hashes));
      if(type==='scope'&&id==='external-wrong-directory')putIn(archiveRepo,'evidence/0012/elsewhere/platform.json',platformRaw);
      const cut=commitIn(archiveRepo,'Synthetic trusted external archive');
      const archiveRef=path=>({repository:archiveRepo,commit:cut,path,sha256:digest(execFileSync('git',['-C',archiveRepo,'show',`${cut}:${path}`],{env}))});
      envelope.sourceRef=archiveRef(sourcePath);envelope.provenanceRefs=[archiveRef(type==='scope'&&id==='external-wrong-directory'?'evidence/0012/elsewhere/platform.json':platformPath),archiveRef(manifestPath)];
    } else {
      commit('Independent synthetic assessment archive');
      envelope.sourceRef=ref(bad==='unlisted-source'?`evidence/0012/unlisted-${n}.json`:sourcePath);envelope.provenanceRefs=[ref('metrics/handoffs.jsonl')];
    }
    if(type==='scope' && id==='external-wrong-archive-commit') {
      const later=commitIn(archiveRepo,'Later archive cut');
      envelope.provenanceRefs=envelope.provenanceRefs.map(r=>({...r,commit:later}));
    }
    if(type==='scope' && id==='missing-authorization-selector') delete envelope.authorizationSelector;
    if(type==='scope' && id==='invalid-authorization-selector') envelope.authorizationSelector='## Optional';
    if(type==='scope' && id==='wrong-native-report') {
      const rows=git('show','HEAD:metrics/handoffs.jsonl').trim().split('\n').map(JSON.parse);
      const row=rows.at(-1), alternate='evidence/0012/unattributed-source.json';row.files.push(alternate);
      put(alternate,raw);put(row.record,'Unrelated report without endorsement\n');put('metrics/handoffs.jsonl',rows.map(JSON.stringify).join('\n')+'\n');commit('Wrong public report attribution');
      envelope.sourceRef=ref(alternate);envelope.provenanceRefs=[ref('metrics/handoffs.jsonl')];
    }
    if(bad==='digest') envelope.sourceRef.sha256='d'.repeat(64);
    if(bad==='missing-source') delete envelope.sourceRef;
    if(bad==='auth-path'){put('evidence/0012/arbitrary-policy.json',json(source));commit('Arbitrary policy ref');envelope.authorizationRef=ref('evidence/0012/arbitrary-policy.json');}
    if(bad==='self-auth') envelope.authorizationRef=envelope.sourceRef;
    let bytes=json(envelope);
    if(bad==='duplicate-binding') bytes=bytes.replace('"type":','"type":"event", "type":');
    if(bad==='nonfinite') bytes=bytes.replace('"supersedes": []','"untrustedNumber": 1e400, "supersedes": []');
    const path=`evidence/0012/time-binding/TB-${digest(bytes)}.json`;put(path,bytes);commit('Immutable synthetic binding');return {ref:ref(path),envelope};
  }
  const scopeClaim={criteria:criteria.map((r,i)=>({ref:r,selector:`# M${i+1}`,purpose:'minimum',promiseId:null,packages:i?['restart']:['core']})),releasePackages:['restart'],deferred:[],gatePolicyRefs:[ref('loop.json',basedOn)]};
  if(id==='optional-deferral'||id==='arbitrary-optional-authority')scopeClaim.deferred=[{package:'polish',authorityRef:id==='arbitrary-optional-authority'?criteria[0]:authority,selector:id==='arbitrary-optional-authority'?'# M1':'## Optional',reason:'Preauthorized optional omission'}];
  if(id==='required-deferral'){scopeClaim.releasePackages=['core'];scopeClaim.deferred=[{package:'restart',authorityRef:authority,selector:'## Optional',reason:'Not authorized'}];}
  if(id==='closure-omission')scopeClaim.criteria[1].packages=[];
  if(id==='wrong-criterion-bytes')scopeClaim.criteria[1].ref={...criteria[1],sha256:'d'.repeat(64)};
  if(id==='wrong-selector')scopeClaim.criteria[1].selector='# Absent';
  if(id==='different-promise-complete')scopeClaim.criteria.push({ref:foreign,selector:'# M3',purpose:'promise',promiseId:'P1',packages:['core']});
  const scopeBad=({'self-optional-list':'role','unassigned-issuer':'request','archive-mismatch':'digest','missing-issuer':'issuer','wrong-request':'request','wrong-role':'role','wrong-claim':'claim','duplicate-source':'duplicate-source','duplicate-binding':'duplicate-binding','nonfinite-number':'nonfinite','missing-task':'missing-task','unlisted-source':'unlisted-source','wrong-ancestry':'wrong-view','missing-source':'missing-source','wrong-auth-path':'auth-path','self-authorization':'self-auth'})[id]??'';
  const scope=binding('scope',scopeClaim,{bad:scopeBad});
  const ci={host:'github.com',repository:'fixture/product',sha,ci:'success',ok:true,missing:[],conclusions:{'github-actions/linux':'success','github-actions/macos':'success'},completedAt:at('11:30')};
  if(id==='wrong-candidate')ci.sha='c'.repeat(40);if(id==='wrong-repository')ci.repository='fixture/other';if(id==='wrong-host')ci.host='evil.example';if(id==='missing-check')delete ci.conclusions['github-actions/macos'];if(id==='red-gate')ci.conclusions['github-actions/macos']='failure';if(id==='gate-finished-after-event')ci.completedAt=at('12:05');
  const log='# tests 10\n# pass 10\n# fail 0\n# cancelled 0\n';put('evidence/0012/suite.log.gz',gzipSync(log));
  const suite={repository:product,sha,tree:id==='wrong-suite-tree'?'c'.repeat(40):candidate.tree,green:true,exit:0,command:policy.gates.suite,summary:{tests:10,pass:10,fail:0,cancelled:0},log:{sha256:digest(log),bytes:Buffer.byteLength(log)},completedAt:at('11:30')};
  put('evidence/0012/ci.json',json(ci));put('evidence/0012/suite.json',json(suite));put('evidence/0012/artifact.txt','Synthetic install/read and revise/restart artifact\n');commit('Pinned synthetic green receipts and artifact');
  const artifact=ref('evidence/0012/artifact.txt');
  const releaseClaim={scopeRef:scope.ref,candidate,recipient:'owner',channel:'public-records',gateRefs:[{kind:'ci',ref:ref('evidence/0012/ci.json')},{kind:'suite',ref:ref('evidence/0012/suite.json')}],criteriaResults:criteria.map((r,i)=>({criterion:{ref:r,selector:`# M${i+1}`},evidenceRefs:[artifact],availability:{artifactSha256:artifact.sha256,recipient:'owner',channel:'public-records',usable:true},result:'pass'}))};
  if(id==='different-promise-complete')releaseClaim.criteriaResults.push({criterion:{ref:foreign,selector:'# M3'},evidenceRefs:[artifact],availability:{artifactSha256:artifact.sha256,recipient:'owner',channel:'public-records',usable:true},result:'pass'});
  if(id==='incomplete-criterion'||id==='split-candidates')releaseClaim.criteriaResults.pop();
  if(id==='unavailable-artifact')releaseClaim.criteriaResults[1].availability.usable=false;
  if(id==='wrong-recipient')releaseClaim.criteriaResults[0].availability.recipient='implementer';
  if(id==='wrong-channel')releaseClaim.criteriaResults[0].availability.channel='private';
  if(id==='wrong-artifact')releaseClaim.criteriaResults[0].availability.artifactSha256='e'.repeat(64);
  if(id==='missing-destination')delete releaseClaim.candidate.destination;
  if(id==='missing-suite')releaseClaim.gateRefs.pop();
  if(id==='missing-ci')releaseClaim.gateRefs.shift();
  const release=binding('release',releaseClaim);
  const eventClaim={event:'release-available',subjectRef:id==='wrong-event-subject'?scope.ref:release.ref,at:at(id==='positive-late'?'12:10':'11:50'),basisRefs:[release.envelope.sourceRef]};
  let event=null;if(id!=='raw-deliveredAt'&&id!=='no-event')event=binding('event',eventClaim,{bad:id==='untrusted-time'?'role':''});
  let fo2Ref=null;
  if(['timely-forecast-publication','backdated-publication','late-publication-earlier-delivery'].includes(id)) {
    const update=observation(git('rev-parse','HEAD'),[foRef],at('10:50'));update.outlook.checkpointAt=at('11:30');fo2Ref=publish(update);
    binding('event',{event:'forecast-published',subjectRef:fo2Ref,at:at(id==='timely-forecast-publication'?'10:55':id==='backdated-publication'?'11:20':'12:30'),basisRefs:[authority]});
  }
  if(id==='scope-superseded')binding('scope',{...scopeClaim,releasePackages:['core'],deferred:[{package:'restart',authorityRef:authority,selector:'## Optional',reason:'Required omission invalid'}]},{supersedes:[scope.ref]});
  if(id==='conflicting-assessments')binding('scope',{...scopeClaim,releasePackages:['restart','polish']});
  if(id==='current-regression')binding('release',{...releaseClaim,criteriaResults:releaseClaim.criteriaResults.map(r=>({...r,availability:{...r.availability,usable:false},result:'fail'}))},{supersedes:[release.ref]});
  if(id.startsWith('later-gate-')) {
    const kind=id.includes('suite')?'suite':'ci', original=kind==='suite'?suite:ci;
    let receipt=structuredClone(original);
    if(kind==='ci') {receipt.ci='failure';receipt.ok=false;receipt.conclusions['github-actions/macos']='failure';}
    else {receipt.green=false;receipt.exit=1;receipt.summary={tests:10,pass:9,fail:1,cancelled:0};const laterLog='# tests 10\n# pass 9\n# fail 1\n# cancelled 0\n';receipt.log={sha256:digest(laterLog),bytes:Buffer.byteLength(laterLog)};put('evidence/0012/later-suite.log.gz',gzipSync(laterLog));}
    receipt.completedAt=at('12:30');
    if(id.endsWith('-mismatch'))receipt.sha='e'.repeat(40);
    if(id.endsWith('-unknown')) {if(kind==='ci')delete receipt.conclusions;else delete receipt.summary;}
    const path=`evidence/0012/later-${kind}.json`;put(path,json(receipt));commit('Later exact-candidate gate assessment');
    binding('release',{...releaseClaim,gateRefs:releaseClaim.gateRefs.map(g=>g.kind===kind?{kind,ref:ref(path)}:g)},{supersedes:[release.ref]});
  }
  if(id==='rewritten-binding'){put(scope.ref.path,json({...scope.envelope,claim:{...scopeClaim,releasePackages:[]}}));commit('Rewrite immutable binding');}
  if(id==='event-correction'||id==='event-conflict')binding('event',{...eventClaim,at:at('12:10')},{supersedes:id==='event-correction'?[event.ref]:[]});
  if(id==='missing-history'){rmSync(join(records,scope.ref.path));commit('Delete immutable evidence');}
  let handoffRef=null;
  if(['late-historical-handoff-proof','timely-historical-handoff','future-historical-handoff'].includes(id)) {
    const view=git('rev-parse','HEAD'), record='rounds/0001-actor-core.md';
    put(record,'# R-0001-actor-core\nphase: positive\nrole: actor\n');
    const row={id:'R-0001-actor-core',round:1,phase:'positive',role:'actor',step:'actor-core',view,task:digest('features: F-0012\nDeliver core.\n'),files:[record],record,attempt:1,product:null,audit:{violations:0},time:at('09:00'),agent:{runner:'synthetic'}};
    put('metrics/handoffs.jsonl',git('show',`${view}:metrics/handoffs.jsonl`)+'\n'+JSON.stringify(row)+'\n');commit('Synthetic canonical completion');handoffRef=ref(record);
    binding('event',{event:'handoff-completed',subjectRef:handoffRef,at:at(id==='future-historical-handoff'?'10:30':'09:00'),basisRefs:[handoffRef]});
    if(id!=='late-historical-handoff-proof')foRef=publish(observation(git('rev-parse','HEAD'),[foRef],at('10:00')));
  }
  if(id==='split-candidates') {
    const first={...releaseClaim,criteriaResults:[releaseClaim.criteriaResults[0]]};
    binding('release',first);
    binding('release',{...releaseClaim,candidate:{...candidate,sha:'b'.repeat(40)},criteriaResults:[{criterion:{ref:criteria[1],selector:'# M2'},evidenceRefs:[artifact],availability:{artifactSha256:artifact.sha256,recipient:'owner',channel:'public-records',usable:true},result:'pass'}]});
  }
  const revision=git('rev-parse','HEAD');
  function args(rev=revision){const stateAtQ=snapshot(records,rev),p=loadPlan(stateAtQ,'PL-0001'),history=loadForecastHistory(records,rev,'PL-0001');return {stateAtQ,plan:p,forecastHistory:history,historicalSnapshots:history.snapshots,now:at('13:00'),clockMode:'simulation'};}
  function ready(rev=revision){const s=snapshot(records,rev),p=loadPlan(s,'PL-0001');return readyPlan(s,p,{context:planContext(s,p,{live:false}),host:{admits:true,over:[],calls:[],cores:20,load:0.1,availableGB:32},now:Date.parse(at('13:00'))}).packages.map(p=>({id:p.id,status:p.status}));}
  return {synthetic:true,archiveRepo,run,putIn,commitIn,records,product,revision,handoffRef,beforeEvidence,args,ready,scope,release,event,foRef,fo2Ref,criteria,authority,planRef,basedOn,put,commit,git,ref,binding,scopeClaim,releaseClaim,eventClaim};
}
