#!/usr/bin/env bash
set -euo pipefail

# Routine, compatible-schema release. Prepare off the live path. No idle wait,
# task cancellation, database writes or automatic whole-script retry.
REVISION="${1:?candidate SHA}"
ARCHIVE_HASH="${2:?archive digest}"
BASELINE="${3:?expected active SHA}"
ARCHIVE="${4:?archive path}"
MANIFEST="${5:?baseline manifest}"
[[ "$REVISION" =~ ^[a-f0-9]{40}$ && "$BASELINE" =~ ^[a-f0-9]{40}$ && "$ARCHIVE_HASH" =~ ^[a-f0-9]{64}$ ]]
[[ "$ARCHIVE" == "/tmp/chevoink-$REVISION.tar.gz" && "$MANIFEST" == "/tmp/chevoink-$REVISION-baseline.json" ]]
APP_ROOT=/opt/chevoink
CURRENT="$APP_ROOT/app/current"
STAGE="$APP_ROOT/app/release-$REVISION"
PREVIOUS="$APP_ROOT/app/previous-$BASELINE-for-$REVISION"
WEB_ROOT=/var/www/chevoink/current
JOURNAL="$APP_ROOT/app/.release-$REVISION.jsonl"
[[ "$(pwd -P)" == "$STAGE" && ! -L "$CURRENT" && -d "$CURRENT" && ! -e "$PREVIOUS" && ! -e "$JOURNAL" ]]
[[ "$(id -un)" == ubuntu && -f "$APP_ROOT/shared/app.env" && -S "$HOME/.pm2/rpc.sock" ]]
[[ "$(sha256sum "$ARCHIVE" | cut -d' ' -f1)" == "$ARCHIVE_HASH" ]]
exec 9>"$APP_ROOT/app/.release.lock"
flock -n 9
umask 077
phase() { printf '{"revision":"%s","phase":"%s","at":"%s"}\n' "$REVISION" "$1" "$(date -u +%FT%TZ)" >> "$JOURNAL"; }
trap 'echo "[chevoink] release stopped; inspect $JOURNAL and actual paths/process before retrying" >&2' ERR
PINNED_NODE=$(tr -d '\r\n' < .node-version)
[[ "$PINNED_NODE" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
export PATH="$APP_ROOT/runtime/node-v${PINNED_NODE}-linux-x64/bin:$PATH"
export CHEVOINK_NODE_BINARY="$APP_ROOT/runtime/node-v${PINNED_NODE}-linux-x64/bin/node"
[[ -x "$CHEVOINK_NODE_BINARY" && "$(node --version)" == "v$PINNED_NODE" ]]

verify_baseline() {
  node --input-type=module - "$CURRENT" "$MANIFEST" "$BASELINE" <<'JS'
import {readFileSync,lstatSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const [root,manifestPath,revision]=process.argv.slice(2);
const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
if(manifest.revision!==revision || !manifest.files.length) throw Error('baseline identity mismatch');
for(const file of manifest.files){
  if(!/^(api|shared|prisma)\//.test(file.path) && !['.node-version','package.json','package-lock.json','ecosystem.config.cjs'].includes(file.path)) throw Error('invalid manifest path');
  const full=resolve(root,file.path);
  if(!full.startsWith(root+'/') || !lstatSync(full).isFile() || createHash('sha256').update(readFileSync(full)).digest('hex')!==file.sha256) throw Error('active source mismatch: '+file.path);
}
if(existsSync(root+'/.chevoink-release.json') && JSON.parse(readFileSync(root+'/.chevoink-release.json','utf8')).revision!==revision) throw Error('active release marker mismatch');
console.log('[chevoink] expected active source verified');
JS
}
snapshot_process() {
  pm2 jlist | node --input-type=module -e '
import {readFileSync,realpathSync} from "node:fs";
const matches=JSON.parse(readFileSync(0,"utf8")).filter(a=>a.name==="chevoink-api");
const a=matches[0], e=a?.pm2_env;
if(matches.length!==1 || a.pm_id!==0 || e.status!=="online" || e.pm_cwd!=="/opt/chevoink/app/current" || e.pm_exec_path!=="/opt/chevoink/app/current/api/server.ts" || realpathSync(`/proc/${a.pid}/exe`)!==realpathSync(process.env.CHEVOINK_NODE_BINARY)) throw Error("API identity mismatch");
process.stdout.write(JSON.stringify({pid:a.pid,start:e.pm_uptime}));'
}
verify_baseline
PROCESS_BEFORE=$(snapshot_process)
# Schema/migration changes require their separately reviewed migration path.
# Routine deployment performs no migration or writes to the database.
cmp -s prisma/schema.prisma "$CURRENT/prisma/schema.prisma"
diff -qr prisma/migrations "$CURRENT/prisma/migrations" >/dev/null
node --input-type=module -e '
import {readFileSync} from "node:fs";import {execFileSync} from "node:child_process";
const p=JSON.parse(readFileSync("package.json","utf8"));
if(process.versions.node!==p.engines.node || execFileSync("npm",["--version"],{encoding:"utf8"}).trim()!==p.engines.npm) throw Error("runtime mismatch");'
phase preparing
ln -s "$APP_ROOT/shared/app.env" "$STAGE/.env"
npm ci
npm run runtime:verify
npx prisma generate
npm run build:client
[[ -f dist/index.html && "$(readlink "$STAGE/.env")" == "$APP_ROOT/shared/app.env" ]]
verify_baseline
[[ "$(snapshot_process)" == "$PROCESS_BEFORE" ]]
printf '{"revision":"%s","archiveSha256":"%s"}\n' "$REVISION" "$ARCHIVE_HASH" > "$STAGE/.chevoink-release.json"
phase prepared

# Normal authorized restart with native recovery; no task/accounting edits.
phase stopping
pm2 stop 0
node --input-type=module - "$PROCESS_BEFORE" <<'JS'
import {existsSync} from 'node:fs';
if(existsSync('/proc/'+JSON.parse(process.argv[2]).pid)) throw Error('old API process still exists');
JS
phase stopped
mv -T "$CURRENT" "$PREVIOUS"
mv -T "$STAGE" "$CURRENT"
phase switched
cd "$CURRENT"
pm2 restart ecosystem.config.cjs --only chevoink-api --update-env
snapshot_process >/dev/null
# Only read-only health retries accommodate startup.
for attempt in {1..20}; do
  if curl -fsS --max-time 2 http://127.0.0.1:3001/api/health > "$CURRENT/.release-health.json"; then break; fi
  sleep 1
done
node --input-type=module -e '
import {readFileSync} from "node:fs";
const h=JSON.parse(readFileSync(".release-health.json","utf8"));
if(!h.success || h.data?.appEnv!=="production") throw Error("production health failed");'
phase healthy
# Preserve old hashed assets/native downloads; publish the entry page last.
while IFS= read -r -d '' entry; do
  install -D -m 644 "$entry" "$WEB_ROOT/${entry#dist/}"
done < <(find dist -type f ! -path dist/index.html -print0)
install -m 644 dist/index.html "$WEB_ROOT/.index.html.next"
mv -f "$WEB_ROOT/.index.html.next" "$WEB_ROOT/index.html"
cmp -s dist/index.html "$WEB_ROOT/index.html"
pm2 save
# Existing Nginx configuration is unchanged: no reload/fence.
phase completed
echo "[chevoink] deployed $REVISION; previous release retained at $PREVIOUS"
