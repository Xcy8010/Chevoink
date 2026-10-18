#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {args,repoRoot,localPath,safePath,readBounded,sha256,createMissing,cli} from './lib.mjs';
cli(()=>{
 const a=args(process.argv.slice(2),['repo','label']);if(a.help){console.log('Usage: node archive-current.mjs --repo <repo> [--label text] [--dry-run]\nCopies bounded current/debug/validation snapshots; never deletes or resets current state.');return;}
 const root=repoRoot(a.repo),ctx=localPath(root,'.codex/context');readBounded(path.join(ctx,'CURRENT.md'));
 const label=(a.label||'handoff').replace(/[^a-zA-Z0-9_-]/g,'-').slice(0,48)||'handoff';
 const dst=safePath(path.join(ctx,'archive',new Date().toISOString().replace(/[:.]/g,'-')+'-'+label+'-'+crypto.randomBytes(3).toString('hex')),root);
 const snaps=['CURRENT.md','DEBUG.md','VALIDATION.md'].filter(n=>fs.existsSync(path.join(ctx,n))).map(n=>({name:n,data:readBounded(path.join(ctx,n))}));
 for(const s of snaps)createMissing(path.join(dst,s.name),s.data,Boolean(a['dry-run']));
 console.log('Original checkpoint preserved. Review snapshot privacy before staging.');
});
