import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';

export function args(argv, valueNames = ['repo'], flagNames = ['dry-run','help']) {
  const out = {};
  for (let i=0;i<argv.length;i++) {
    let a=argv[i]; if(a==='-h')a='--help';
    if(!a.startsWith('--'))throw new Error(`Unexpected argument: ${a}`);
    const k=a.slice(2); if(Object.hasOwn(out,k))throw new Error(`Repeated option: ${a}`);
    if(valueNames.includes(k)) {
      if(i+1>=argv.length||argv[i+1].startsWith('--'))throw new Error(`Missing value for ${a}`);
      out[k]=argv[++i];
    } else if(flagNames.includes(k))out[k]=true;
    else throw new Error(`Unknown option: ${a}`);
  }
  return out;
}
export const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
export function lexists(p) { try{fs.lstatSync(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;} }
export function safePath(p, within = null) {
  const abs=path.resolve(p);
  if(within!==null) {
    const rel=path.relative(path.resolve(within),abs);
    if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw new Error('Path escapes selected root.');
  }
  const root=path.parse(abs).root; let cur=root;
  for(const part of abs.slice(root.length).split(path.sep).filter(Boolean)){
    cur=path.join(cur,part);
    if(lexists(cur)&&fs.lstatSync(cur).isSymbolicLink())throw new Error('Refusing symlink/reparse path: '+cur);
  }
  return abs;
}
export function repoRoot(p) {
  const root=safePath(p||process.cwd());
  if(!fs.existsSync(root)||!fs.statSync(root).isDirectory())throw new Error('Repository directory not found: '+root);
  return root;
}
export function localPath(root,rel) {
  if(typeof rel!=='string'||!rel||path.isAbsolute(rel)||/^[A-Za-z]:|^\\\\|^\//.test(rel)||rel.includes('\\'))throw new Error('Expected a repository-relative slash path.');
  return safePath(path.resolve(root,rel),root);
}
export function readBounded(p,max=262144) {
  safePath(p);
  const s=fs.statSync(p);if(!s.isFile()||s.size>max)throw new Error('Not a bounded regular file: '+p);
  const b=fs.readFileSync(p);if(b.length>max)throw new Error('File exceeded limit during read.');return b;
}
export function atomicWrite(p,data) {
  safePath(p);fs.mkdirSync(path.dirname(p),{recursive:true});safePath(p);
  const temp=p+'.tmp-'+process.pid+'-'+crypto.randomBytes(5).toString('hex');
  try{fs.writeFileSync(temp,data,{flag:'wx',mode:0o600});fs.renameSync(temp,p);}finally{if(lexists(temp))fs.unlinkSync(temp);}
}
export function createMissing(p,data,dryRun=false) {
  safePath(p);
  if(lexists(p)){if(!fs.statSync(p).isFile())throw new Error('Expected file: '+p);console.log('SKIP existing '+p);return false;}
  console.log((dryRun?'WOULD CREATE ':'CREATE ')+p);
  if(!dryRun){fs.mkdirSync(path.dirname(p),{recursive:true});safePath(p);try{fs.writeFileSync(p,data,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;console.log('SKIP concurrent creation '+p);}}
  return true;
}
export function git(root,params) {
  const r=spawnSync('git',['-c','core.fsmonitor=false','-C',root,...params],{encoding:'utf8',timeout:3000,maxBuffer:262144,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}});
  return !r.error&&r.status===0?r.stdout.trim():null;
}
export function originIdentity(root) {
  const raw=git(root,['config','--get','remote.origin.url']);if(!raw)return null;
  // Never echo a raw origin: URLs can contain credentials. Only return a recognized GitHub owner/repo.
  let pair=null;
  const ssh=raw.match(/^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i);
  if(ssh)pair=ssh[1];
  else try {const u=new URL(raw);if(u.hostname.toLowerCase()==='github.com'&&['https:','ssh:'].includes(u.protocol)&&!u.search&&!u.hash){const m=u.pathname.match(/^\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);if(m)pair=m[1];}}catch{}
  return pair;
}
/** Fingerprint a Git origin without printing/storing embedded credentials. No network access. */
export function originFingerprint(root) {
  const raw=git(root,['config','--get','remote.origin.url']);if(!raw)return null;
  let key;
  try {
    const u=new URL(raw);
    if(!['https:','http:','ssh:','git:','file:'].includes(u.protocol))return null;
    // Auth, query and fragment are intentionally excluded. Paths remain case sensitive.
    key=(u.hostname.toLowerCase()+(u.port?':'+u.port:''))+'/'+u.pathname.replace(/^\/+|\/+$/g,'').replace(/\.git$/,'');
  } catch {
    const scp=raw.match(/^(?:[^@/:]+@)?([^/:]+):(.+)$/);
    if(scp&&!/^[A-Za-z]:[\\/]/.test(raw))key=scp[1].toLowerCase()+'/'+scp[2].replace(/\.git$/,'');
    else key='local:'+path.resolve(root,raw);
  }
  return sha256(key);
}
export function frontmatter(text) {
  const out={}; const m=text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);if(!m)return out;
  for(const line of m[1].split(/\r?\n/)){
    const x=line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);if(!x)continue;
    const v=x[2].trim();try{out[x[1]]=v.startsWith('"')?JSON.parse(v):v.replace(/^'|'$/g,'');}catch{out[x[1]]='UNKNOWN';}
  }return out;
}
export function cli(fn) {try{fn();}catch(e){console.error('ERROR: '+e.message);process.exitCode=1;}}
