#!/usr/bin/env bash
# Publish the public startup timing change without switching API or application channels.
set -euo pipefail
export PATH="/opt/chevoink/runtime/node-v22.23.2-linux-x64/bin:$PATH"
revision=${1:?candidate revision}
runtime=${2:?expected API revision}
archive_digest=${3:?archive SHA256}
old_index=${4:?expected public index SHA256}
new_index=${5:?new public index SHA256}
[[ "$revision" =~ ^[a-f0-9]{40}$ && "$runtime" =~ ^[a-f0-9]{40}$ ]]
for digest in "$archive_digest" "$old_index" "$new_index"; do [[ "$digest" =~ ^[a-f0-9]{64}$ ]]; done
web=/var/www/chevoink/current
stage="/var/www/chevoink/.android-launcher-$revision"
archive="/tmp/chevoink-android-launcher-$revision.tar.gz"
digest_of() { sha256sum "$1" | cut -d' ' -f1; }
exec 9>/opt/chevoink/app/.release.lock
flock -n 9
[[ "$(id -un)" == ubuntu && "$(digest_of "$archive")" == "$archive_digest" ]]
[[ "$(node -p "require('/opt/chevoink/app/current/.chevoink-release.json').revision")" == "$runtime" ]]
[[ "$(digest_of "$web/index.html")" == "$old_index" ]]
[[ "$(digest_of "$web/assets/index-Dp04DR7T.js")" == 6d9e01b9b8603e0af3b192029368804c1969c78ec91f96aaea99a690fdc2e95e ]]
mkdir -m 700 "$stage"
cp "$web/index.html" "$stage/previous-index.html"
tar -xzf "$archive" -C "$stage" --no-same-owner
[[ "$(digest_of "$stage/index.html")" == "$new_index" ]]
for asset in "$stage"/assets/*; do
  name=$(basename "$asset")
  [[ -f "$asset" && ! -L "$asset" && "$name" =~ ^[a-zA-Z0-9_.-]+$ ]]
  target="$web/assets/$name"
  if [[ -e "$target" ]]; then cmp -s "$asset" "$target"; else chmod 644 "$asset"; ln "$asset" "$target"; fi
done
[[ "$(digest_of "$web/index.html")" == "$old_index" ]]
install -m 644 "$stage/index.html" "$stage/next-index.html"
mv -T "$stage/next-index.html" "$web/index.html"
[[ "$(digest_of "$web/index.html")" == "$new_index" ]]
printf 'Published Android startup timing %s, public index %s\n' "$revision" "$new_index"
