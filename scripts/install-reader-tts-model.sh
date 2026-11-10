#!/usr/bin/env bash
set -euo pipefail

# Model published under Apache-2.0. Use the files at this immutable revision.
# https://huggingface.co/csukuangfj/icefall-tts-aishell3-vits-low-2024-04-06/tree/57345c004e13ed640e408c4c29ab56187b18f065
source_dir=${1:?Pass the directory containing the verified model files}
models_root=${2:?Pass the shared TTS model directory}
target="$models_root/vits-icefall-zh-aishell3"
files=(model.onnx lexicon.txt tokens.txt phone.fst date.fst number.fst)
hashes=(
  d6ef4d23e7fa1cffffca92ec4e18ebd127f21e90
  aef20b9e37f64bfc271a888fa10b4cb40a05cdbc
  2eba908c27ec0767281cad25d322008b16869c5b
  20ec7f4c077f9ec85ca9d01c4b4f4581f6e552ee
  66c0bd468903fc98d212cd6c3c5b2793ce8eb2c3
)

verify() {
  local directory=$1 index file
  printf '5511d651b7840c0a93a6bbfd4afd070a2c7f39ca1ec3ff2ecd73191519bbb852  %s/model.onnx\n' "$directory" | sha256sum --check --status
  for index in "${!hashes[@]}"; do
    file=${files[index + 1]}
    test "$(git hash-object --no-filters "$directory/$file")" = "${hashes[index]}"
  done
}

verify "$source_dir"
install -d -m 0755 -- "$models_root"
if [[ ! -e "$target" ]]; then
  stage=$(mktemp -d -- "$models_root/.reader-tts-model.XXXXXXXX")
  cleanup() {
    if [[ -d "$stage" ]]; then
      local file
      for file in "${files[@]}"; do rm -f -- "$stage/$file"; done
      rmdir -- "$stage"
    fi
  }
  trap cleanup EXIT
  for file in "${files[@]}"; do install -m 0644 -- "$source_dir/$file" "$stage/$file"; done
  verify "$stage"
  chmod 0755 -- "$stage"
  mv -T --no-clobber -- "$stage" "$target"
fi
verify "$target"
printf 'Verified reader TTS model: %s\n' "$target"
