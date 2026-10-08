#!/usr/bin/env bash
# Build the Ichitaro viewer (EZPZ File JTD, MIT) into public/vendor/ezpzjtd/: its
# module and .wasm, its licence and notice, those of the crates compiled in,
# and the commit it was built from.
# Needs: rustup toolchain install 1.90.0 --profile minimal --target wasm32-unknown-unknown
#        cargo +1.90.0 install wasm-bindgen-cli --version 0.2.129 --locked
#        wasm-opt (binaryen), optional: the build is smaller with it
set -euo pipefail
cd "$(dirname "$0")"
out=../../public/vendor/ezpzjtd
cargo +1.90.0 build --release --locked --target wasm32-unknown-unknown
rm -rf "$out"
wasm-bindgen --target web --no-typescript --out-dir "$out" \
  target/wasm32-unknown-unknown/release/ezpzjtd_viewer.wasm
if command -v wasm-opt >/dev/null; then
  wasm-opt -Oz "$out/ezpzjtd_viewer_bg.wasm" -o "$out/ezpzjtd_viewer_bg.wasm"
fi
node notices.mjs "$out"
ls -l "$out"
