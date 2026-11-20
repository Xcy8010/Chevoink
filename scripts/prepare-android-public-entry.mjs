import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const project = fileURLToPath(new URL('../', import.meta.url))
const publicBaseline = 'b0128236852c3689dd8fb60bdeec056641165b65'
const originalModule = 'assets/index-Dp04DR7T.js'
const originalDigest = '6d9e01b9b8603e0af3b192029368804c1969c78ec91f96aaea99a690fdc2e95e'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const normalize = text => text.replaceAll('\r\n', '\n')

export function checkedAndroidEntry(original, candidate) {
  const before = normalize(original)
  const after = before.replace('\nsetupSafeAreaFallback()\n', '\n')
    .replace('if(!await bootstrapAppRelease())return\n', 'if(!await bootstrapAppRelease())return\n  setupSafeAreaFallback()\n')
  if (after === before || after !== normalize(candidate)) {
    throw Error('Entry differs outside the Android safe-area initialization order')
  }
  return after
}

async function prepare(baseline, destination, liveIndex) {
  const git = (cwd, args) => execFileSync('git', args, {cwd, encoding:'utf8', windowsHide:true}).trim()
  if (process.version !== 'v22.23.2' || git(baseline,['rev-parse','HEAD']) !== publicBaseline ||
      git(baseline,['status','--porcelain','--untracked-files=all']) || git(project,['status','--porcelain','--untracked-files=all'])) {
    throw Error('Expected the clean candidate and original public checkout with the pinned Node version')
  }
  const input = path.join(baseline,'src/main.tsx')
  const original = await readFile(input,'utf8')
  const entry = checkedAndroidEntry(original, await readFile(path.join(project,'src/main.tsx'),'utf8'))
  await mkdir(destination)
  const envDir = path.join(destination,'empty-env')
  await mkdir(envDir)
  const require = createRequire(path.join(baseline,'package.json'))
  const vite = path.join(path.dirname(require.resolve('vite/package.json')),'dist/node/index.js')
  const { build } = await import(pathToFileURL(vite).href)
  const old = path.join(destination,'baseline')
  const next = path.join(destination,'candidate')
  process.chdir(baseline)
  const config = {root:baseline, configFile:path.join(baseline,'vite.config.ts'), envDir, logLevel:'error'}
  await build({...config, build:{outDir:old}})
  const existing = await readFile(liveIndex,'utf8')
  const originalHtml = await readFile(path.join(old,'index.html'),'utf8')
  if (normalize(existing)!==normalize(originalHtml) || sha256(await readFile(path.join(old,originalModule)))!==originalDigest) {
    throw Error('Rebuilt baseline does not match the observed public launcher')
  }
  await build({...config, build:{outDir:next}, plugins:[{
    name:'android-public-entry-order', enforce:'pre',
    transform(source,id) {
      if (path.resolve(id)!==input) return
      if (normalize(source)!==normalize(original)) throw Error('Unexpected startup module input')
      return {code:entry, map:null}
    },
  }]})
  const nextHtml = await readFile(path.join(next,'index.html'),'utf8')
  const modulePath = nextHtml.match(/<script type="module" crossorigin src="\/(assets\/index-[\w-]+\.js)"><\/script>/)?.[1]
  if (!modulePath || modulePath===originalModule || normalize(nextHtml).replace(modulePath,originalModule)!==normalize(existing)) {
    throw Error('Public entry HTML differs beyond the startup module reference')
  }
  const files=['index.html']
  const beforeAssets=new Set(await readdir(path.join(old,'assets')))
  for (const name of await readdir(path.join(next,'assets'))) {
    const relative='assets/'+name
    if (!beforeAssets.has(name)) files.push(relative)
    else if (sha256(await readFile(path.join(old,relative)))!==sha256(await readFile(path.join(next,relative)))) {
      throw Error('Hashed asset changed without a new filename: '+name)
    }
  }
  // Retain the live document bytes, including its original line endings.
  await writeFile(path.join(next,'index.html'), existing.replace(originalModule,modulePath))
  const archive=path.join(destination,'launcher.tar.gz')
  execFileSync('tar',['-czf',archive,'-C',next,...files],{windowsHide:true})
  const receipt={revision:git(project,['rev-parse','HEAD']),publicBaseline,originalModule,originalDigest,
    oldIndex:sha256(existing),newIndex:sha256(await readFile(path.join(next,'index.html'))),
    archive:sha256(await readFile(archive)),modulePath,files:files.length}
  await writeFile(path.join(destination,'launcher.json'),JSON.stringify(receipt)+'\n',{flag:'wx'})
  console.log(JSON.stringify(receipt))
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2)
  if(args.length!==3)throw Error('Expected historical checkout, new output directory and downloaded public index')
  await prepare(...args.map(arg=>path.resolve(arg)))
}
