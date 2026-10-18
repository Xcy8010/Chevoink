#!/usr/bin/env node
import {args,repoRoot,cli} from './lib.mjs';
import {inventory} from './project-inventory.mjs';
cli(()=>{
 const a=args(process.argv.slice(2),['root','max-depth'],['help']);
 if(a.help){console.log('Usage: node inspect-project.mjs --root <repo> [--max-depth 0..5]');return;}
 const depth=a['max-depth']===undefined?3:Number(a['max-depth']);if(!Number.isInteger(depth)||depth<0||depth>5)throw new Error('max-depth must be 0..5.');
 console.log(JSON.stringify(inventory(repoRoot(a.root),{maxDepth:depth}),null,2));
});
