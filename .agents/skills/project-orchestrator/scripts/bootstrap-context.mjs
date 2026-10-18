#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {args,repoRoot,safePath,readBounded,createMissing,git,cli} from './lib.mjs';
import {inventory,draftProfile} from './project-inventory.mjs';
const templates=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../templates');
cli(()=>{
 const a=args(process.argv.slice(2),['repo','profile']);
 if(a.help){console.log('Usage: node bootstrap-context.mjs --repo <repo> [--dry-run]\nExisting context and profiles are preserved, never reset.');return;}
 const root=repoRoot(a.repo),ctx=safePath(path.join(root,'.codex/context'),root),profilePath=path.join(ctx,'PROJECT-PROFILE.json');
 if(a.profile && a.profile!=='generic')throw new Error('Named project presets are not supported. Read the current repository standards separately.');
 // Build the plan without choosing project-specific behavior. Existing profile bytes are preserved.
 const scan=inventory(root);const draft=draftProfile(root,scan);
 const guardian={version:1,enabled:true,policy:{yellow_after_compactions:1,red_after_compactions:2,current_soft_max_bytes:12288,current_hard_max_bytes:24576},note:'Local advisory thresholds only; not an OpenAI model-quality guarantee.'};
 const plans=[['GUARDIAN.json',JSON.stringify(guardian,null,2)+'\n'],['PROJECT-PROFILE.json',JSON.stringify(draft,null,2)+'\n'],['.gitignore','.runtime/\n']];
 for(const name of ['CURRENT.md','PROJECT.md','DECISIONS.md','VALIDATION.md','DEBUG.md']){
  let text=fs.readFileSync(path.join(templates,name),'utf8');
  if(name==='CURRENT.md')text=text.replace('updated_at: ""',`updated_at: "${new Date().toISOString()}"`)
    .replace('- Branch:\n- SHA:\n- Dirty state:',`- Branch: ${JSON.stringify(scan.git.branch||'UNKNOWN')}\n- SHA: ${scan.git.head||'UNKNOWN'}\n- Dirty state: ${scan.git.dirty===null?'UNKNOWN':scan.git.dirty?'dirty':'clean'}`);
  plans.push([name,text]);
 }
 for(const [name]of plans)safePath(path.join(ctx,name),root);
 for(const [name,content]of plans)createMissing(path.join(ctx,name),content,Boolean(a['dry-run']));
 if(!a['dry-run'])for(const d of ['archive','.runtime']){const p=safePath(path.join(ctx,d),root);fs.mkdirSync(p,{recursive:true});}
 console.log(`Context ${a['dry-run']?'previewed':'initialized'}; existing state preserved. Fill only missing fields from the templates after reading the actual current files. Profile remains draft until agent review; no tests or releases were executed.`);
});
