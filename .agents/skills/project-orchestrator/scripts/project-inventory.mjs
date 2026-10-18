import fs from 'node:fs';
import path from 'node:path';
import {git,originIdentity,originFingerprint,readBounded,sha256} from './lib.mjs';

const manifests=new Map(Object.entries({
 'package.json':'js-ts','pyproject.toml':'python','requirements.txt':'python','setup.cfg':'python','Pipfile':'python',
 'Cargo.toml':'rust','go.mod':'go','pom.xml':'jvm','build.gradle':'jvm','build.gradle.kts':'jvm',
 'Gemfile':'ruby','composer.json':'php','mix.exs':'elixir','Package.swift':'swift','pubspec.yaml':'dart',
 'CMakeLists.txt':'c-cpp','meson.build':'c-cpp','DESCRIPTION':'r', 'global.json':'dotnet','build.zig':'zig','Project.toml':'julia','MODULE.bazel':'bazel','WORKSPACE':'bazel'}));
const locks=new Set(['package-lock.json','npm-shrinkwrap.json','pnpm-lock.yaml','pnpm-workspace.yaml','yarn.lock','bun.lock','bun.lockb','uv.lock','poetry.lock','Pipfile.lock','Cargo.lock','go.sum','Gemfile.lock','composer.lock','mix.lock','pubspec.lock','renv.lock','packages.lock.json']);
const pins=new Set(['.nvmrc','.node-version','.python-version','.ruby-version','rust-toolchain.toml','.tool-versions','global.json','gradle.properties','Directory.Build.props','Directory.Packages.props']);
const docs=/^(AGENTS(?:\.[A-Za-z-]+)?|CONTRIBUTING(?:\.[A-Za-z-]+)?|(?:DEVELOPMENT|ENGINEERING|ARCHITECTURE|TESTING|SECURITY|STANDARDS)(?:[-.][A-Za-z0-9_-]+)*)\.md$/i;
const excluded=new Set(['.git','.codex','.agents','node_modules','vendor','dist','build','target','.venv','venv','__pycache__','coverage','.next','.nuxt','.gradle','bin','obj','.idea']);
function kind(rel,name){
 if(manifests.has(name))return ['manifest',manifests.get(name)];
 if(/\.tf$/.test(name))return ['manifest','infrastructure'];
 if(/\.(csproj|fsproj|vbproj|sln|slnx)$/.test(name))return ['manifest','dotnet'];
 if(locks.has(name))return ['lockfile',null];if(pins.has(name))return ['toolchain',null];if(docs.test(name))return ['instructions',null];
 if(rel.startsWith('.github/workflows/')&&/\.ya?ml$/.test(name))return ['ci',null];
 if(['.gitlab-ci.yml','Jenkinsfile','Makefile','justfile','Taskfile.yml','pytest.ini','tox.ini','.golangci.yml'].includes(name)||/^(vitest|jest|tsconfig|eslint|playwright)\.(config\.)?.+/.test(name))return ['gate-config',null];
 return null;
}
export function inventory(root,{maxDepth=3,maxEntries=1800,maxFiles=120}={}){
 const evidence=[];let entries=0,truncated=false;const skipped=[];
 function walk(dir,depth){
  let items;try{items=fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name));}catch{skipped.push(path.relative(root,dir)||'.');return;}
  for(const item of items){
   if(++entries>maxEntries||evidence.length>=maxFiles){truncated=true;return;}
   if(item.isSymbolicLink())continue;
   const absolute=path.join(dir,item.name),relative=path.relative(root,absolute).split(path.sep).join('/');
   if(item.isDirectory()){if(!excluded.has(item.name)&&depth<maxDepth)walk(absolute,depth+1);else if(!excluded.has(item.name)&&depth>=maxDepth)truncated=true;continue;}
   if(!item.isFile())continue;const k=kind(relative,item.name);if(!k)continue;
   const rec={path:relative,kind:k[0],ecosystem:k[1],sha256:null};
   try{const b=readBounded(absolute,1048576);rec.sha256=sha256(b);rec.bytes=b.length;
     if(item.name==='package.json'){
       try{const pkg=JSON.parse(b.toString('utf8'));rec.candidate_gate_names=Object.keys(pkg.scripts||{}).filter(s=>/check|test|lint|build|audit|eval/.test(s)).slice(0,25);}
       catch{rec.parse_status='invalid-json';}
     }
   }catch{rec.read_status='unavailable-or-over-limit';}
   evidence.push(rec);
  }
 }
 walk(root,0);
 const status=git(root,['status','--short','--untracked-files=normal']);
 const identity=originIdentity(root);
 return {schema_version:1,root,git:{branch:git(root,['branch','--show-current']),head:git(root,['rev-parse','HEAD']),dirty:status===null?null:Boolean(status),status_lines:status?.split(/\r?\n/).filter(Boolean).slice(0,60)||[],status_truncated:status?status.split(/\r?\n/).length>60:false},identity:{github_repository:identity,repository_origin_sha256:originFingerprint(root)},evidence,scan:{max_depth:maxDepth,max_entries:maxEntries,max_files:maxFiles,entries_observed:entries,truncated,unreadable_directories:skipped.slice(0,12)},note:'Read-only bounded inventory; no gate was run, no architecture/capability was inferred, no project preset exists or is selected. A partial scan cannot prove absence. Candidate script names are not reviewed or authorized commands.'};
}
export const capabilityNames=['data_contracts','stateful_ui','async_execution','ai_tooling','research_security','accounting','verification_release','systems_artifacts','data_pipelines','infrastructure'];
export function draftProfile(root,scan){
 return {schema_version:1,profile:'generic',status:'draft',reviewed_at:null,identity:{github_repository:scan.identity.github_repository,repository_origin_sha256:scan.identity.repository_origin_sha256,selection_source:'generic; identity is evidence only, never a rule selector'},architecture:{kind:'unknown',evidence:[]},components:scan.evidence.filter(e=>e.kind==='manifest').map(e=>({path:path.posix.dirname(e.path),ecosystem:e.ecosystem,manifest:e.path,architecture:'unknown'})),capabilities:Object.fromEntries(capabilityNames.map(n=>[n,{status:'unknown',evidence:[]}])),source_evidence:scan.evidence.filter(e=>e.sha256).map(e=>({path:e.path,sha256:e.sha256,purpose:e.kind})),gates:[],no_gates_reason:null,conflicts:[],note:'Draft inventory, not proven architecture/capabilities, test results or authorization. Local standards are read in place, never bundled into the skill. Identity and labels cannot select product rules. Review relevant source, rules and gate commands before action. Do not paste secrets here.'};
}
