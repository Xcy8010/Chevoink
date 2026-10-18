#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';
import {args,repoRoot,localPath,readBounded,frontmatter,cli} from './lib.mjs';
cli(()=>{
 const a=args(process.argv.slice(2),['repo'],['help']);if(a.help){console.log('Usage: node context-status.mjs --repo <repo>');return;}
 const root=repoRoot(a.repo),ctx=localPath(root,'.codex/context');
 if(!fs.existsSync(path.join(ctx,'GUARDIAN.json'))){console.log(JSON.stringify({enabled:false,observed_compactions:'UNKNOWN',reason:'Not initialized'}));return;}
 const cfg=JSON.parse(readBounded(path.join(ctx,'GUARDIAN.json'),16384));
 let current=null;try{const b=readBounded(path.join(ctx,'CURRENT.md'));current={bytes:b.length,meta:frontmatter(b.toString('utf8'))};}catch{}
 let runtime=[];const rd=localPath(root,'.codex/context/.runtime');let partial=false;
 if(fs.existsSync(rd)){const names=fs.readdirSync(rd).filter(n=>/^[a-f0-9]{20}\.json$/.test(n));partial=names.length>200;runtime=names.slice(0,200).map(n=>{try{return JSON.parse(readBounded(path.join(rd,n),16384));}catch{return null;}}).filter(Boolean).sort((a,b)=>String(b.updated_at||'').localeCompare(String(a.updated_at||''))).slice(0,5);}
 console.log(JSON.stringify({enabled:cfg.enabled===true,current,recent_runtime:runtime,partial_runtime_listing:partial,policy:cfg.policy,telemetry_note:'Only locally observed events; missing/untrusted hooks do not imply zero real compactions.'},null,2));
});
