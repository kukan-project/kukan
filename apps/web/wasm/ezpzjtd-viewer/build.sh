#!/usr/bin/env bash
# Build the Ichitaro viewer (EZPZ File JTD, MIT) into public/vendor/ezpzjtd/: its
# module and .wasm, its licence and notice, those of the crates compiled in,
# and the commit it was built from.
# Needs: rustup toolchain install 1.90.0 --profile minimal --target wasm32-unknown-unknown
#        cargo +1.90.0 install wasm-bindgen-cli --version 0.2.129 --locked
set -euo pipefail
cd "$(dirname "$0")"
out=../../public/vendor/ezpzjtd
# Panic messages name the sources: keep the builder's home directory out of them
RUSTFLAGS="--remap-path-prefix=$HOME/.cargo=/cargo" \
  cargo +1.90.0 build --release --locked --target wasm32-unknown-unknown
rm -rf "$out"
wasm-bindgen --target web --no-typescript --out-dir "$out" \
  target/wasm32-unknown-unknown/release/ezpzjtd_viewer.wasm
node notices.mjs "$out"
# What ichitaro-vendor.test.ts holds the committed files to
(cd "$out" && sha256sum LICENSE NOTICE SOURCE THIRD_PARTY_NOTICES ezpzjtd_viewer.js ezpzjtd_viewer_bg.wasm >SHA256SUMS)
ls -l "$out"
