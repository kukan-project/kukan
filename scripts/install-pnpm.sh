#!/bin/sh
# Installs the pnpm that package.json's `packageManager` names, checked against
# the sha512 recorded there — what `corepack prepare` did, without corepack,
# which Node 25 and later no longer ship. Used by the Dockerfile and the CDK
# Pipelines synth step; run from the repository root (or wherever package.json
# is), as a user who can write to the prefix.
#
# Usage: sh scripts/install-pnpm.sh [prefix]   (default /usr/local)
set -eu

prefix=${1:-/usr/local}
spec=$(node -p "require('./package.json').packageManager")
version=${spec#pnpm@}
version=${version%%+*}
hash=${spec##*+sha512.}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# node rather than curl or wget: it is the one fetcher every place this runs
# is sure to have (the Alpine image has no curl).
node -e '
  const [url, out] = process.argv.slice(1)
  fetch(url).then(async (res) => {
    if (!res.ok) throw new Error(`${url}: ${res.status}`)
    require("node:fs").writeFileSync(out, Buffer.from(await res.arrayBuffer()))
  })
' "https://registry.npmjs.org/pnpm/-/pnpm-$version.tgz" "$tmp/pnpm.tgz"
echo "$hash  $tmp/pnpm.tgz" | sha512sum -c -

mkdir -p "$prefix/lib/pnpm" "$prefix/bin"
tar -xzf "$tmp/pnpm.tgz" -C "$prefix/lib/pnpm" --strip-components=1
ln -sf ../lib/pnpm/bin/pnpm.cjs "$prefix/bin/pnpm"
"$prefix/bin/pnpm" --version
