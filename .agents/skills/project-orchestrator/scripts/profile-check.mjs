#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {args,repoRoot,localPath,readBounded,sha256,originIdentity,originFingerprint,cli} from './lib.mjs';
import {capabilityNames} from './project-inventory.mjs';
import {validateShape} from './schema-check.mjs';
const schema=JSON.parse(fs.readFileSync(new URL('../schemas/project-profile.schema.json',import.meta.url),'utf8'));

export function checkProfile(root){
 const p=localPath(root,'.codex/context/PROJECT-PROFILE.json');
 if(!fs.existsSync(p))return {status:'uninitialized',issues:['Missing PROJECT-PROFILE.json'],stale:[],release_approved:false};
 let d;try{d=JSON.parse(readBounded(p));}catch{return {status:'invalid',issues:['Profile is not bounded valid JSON'],stale:[],release_approved:false};}
 const issues=[],stale=[];
 if(!d||typeof d!=='object'||Array.isArray(d))return {status:'invalid',issues:['Expected object'],stale,release_approved:false};
 issues.push(...validateShape(d,schema));
 if(issues.length)return {status:'invalid',issues:issues.slice(0,80),stale,release_approved:false};
 if(d.identity?.repository_origin_sha256){
   if(d.identity.repository_origin_sha256!==originFingerprint(root))issues.push('Recorded repository identity changed or is unavailable');
 }else if(d.identity?.github_repository && d.identity.github_repository.toLowerCase()!==originIdentity(root)?.toLowerCase())issues.push('Recorded repository identity changed');
 if(d.schema_version!==1)issues.push('Unsupported schema_version');
 if(!['draft','reviewed'].includes(d.status))issues.push('Unknown review status');
 // profile is a backward-compatible label only. No label dispatch, host/repo allowlist or preset lookup.
 const evidence=Array.isArray(d.source_evidence)?d.source_evidence:[];if(!Array.isArray(d.source_evidence))issues.push('source_evidence must be an array');
 const known=new Set();
 for(const e of evidence){
  if(!e||typeof e.path!=='string'||!/^([a-f0-9]{64})$/.test(e.sha256||'')){issues.push('Invalid evidence path/hash');continue;}
  if(known.has(e.path))issues.push('Duplicate evidence: '+e.path);known.add(e.path);
  try{if(sha256(readBounded(localPath(root,e.path),1048576))!==e.sha256)stale.push(e.path);}catch{stale.push(e.path+' (unavailable/unsafe)');}
 }
 function evidenceRefs(refs,label){
  if(!Array.isArray(refs)||refs.length===0){issues.push(label+' needs evidence');return;}
  for(const r of refs)if(typeof r!=='string'||!known.has(r.split('#')[0]))issues.push(label+' uses untracked evidence');
 }
 for(const n of capabilityNames){const c=d.capabilities?.[n];if(!c)continue;if(!c||!['unknown','present','absent'].includes(c.status)){issues.push('Invalid capability: '+n);continue;}if(c.status!=='unknown')evidenceRefs(c.evidence,'Capability '+n);}
 if(!d.architecture||typeof d.architecture.kind!=='string')issues.push('Missing architecture record');
 else if(d.architecture.kind!=='unknown')evidenceRefs(d.architecture.evidence,'Architecture');
 if(!Array.isArray(d.components))issues.push('components must be an array');
 if(!Array.isArray(d.conflicts))issues.push('conflicts must be an array');
 const gates=Array.isArray(d.gates)?d.gates:[];if(!Array.isArray(d.gates))issues.push('gates must be an array');
 const ids=new Set();
 for(const g of gates){
  if(!g||typeof g!=='object'){issues.push('Invalid gate');continue;}
  for(const k of ['id','kind','command','cwd','source','environment'])if(typeof g[k]!=='string'||!g[k].trim())issues.push('Gate missing '+k);
  if(!['slice','stage','release'].includes(g.phase))issues.push('Gate phase must be slice/stage/release');
  if(typeof g.required!=='boolean')issues.push('Gate required must be boolean');
  if(ids.has(g.id))issues.push('Duplicate gate id');ids.add(g.id);
  try{localPath(root,g.cwd);}catch{issues.push('Gate cwd escapes/does not use safe relative root');}
  if(typeof g.source!=='string'||!known.has(g.source.split('#')[0]))issues.push('Gate source not fingerprinted');
 }
 if(d.status==='reviewed'){
  if(typeof d.reviewed_at!=='string'||Number.isNaN(Date.parse(d.reviewed_at)))issues.push('Reviewed profile needs review timestamp');
  if(!evidence.length)issues.push('Reviewed profile needs source evidence');
  if(!gates.length&&!(typeof d.no_gates_reason==='string'&&d.no_gates_reason.trim()))issues.push('No gates defined and no scoped reason');
  if(d.conflicts?.length)issues.push('Profile has unresolved conflicts');
 }
 const status=issues.length?'invalid':stale.length?'needs-revalidation':d.status==='reviewed'?'ready-for-agent-review':'draft';
 return {status,profile:'generic',legacy_label_inert:d.profile!=='generic',issues:issues.slice(0,80),stale:stale.slice(0,120),unknown_capabilities:capabilityNames.filter(n=>!d.capabilities?.[n]||d.capabilities[n].status==='unknown'),release_approved:false,note:'Structural/file-freshness check only. No commands executed; no semantic correctness, test success, authorization or release approval inferred.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)cli(()=>{
 const a=args(process.argv.slice(2),['repo'],['help','strict']);if(a.help){console.log('Usage: node profile-check.mjs --repo <repo> [--strict]\nStrict succeeds only at ready-for-agent-review, never grants release approval.');return;}
 const result=checkProfile(repoRoot(a.repo));console.log(JSON.stringify(result,null,2));if(a.strict&&result.status!=='ready-for-agent-review')process.exitCode=2;
});
