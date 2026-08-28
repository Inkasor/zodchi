#!/bin/sh
set -eu
command -v node >/dev/null 2>&1 || { echo "Node.js 24 or newer is required before Zodchi can be installed." >&2; exit 64; }
command -v curl >/dev/null 2>&1 || { echo "curl is required to download the signed installer." >&2; exit 64; }
scratch="$(mktemp -d "${TMPDIR:-/tmp}/zodchi-bootstrap.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT HUP INT TERM
mkdir -p "$scratch/lib"
base="https://raw.githubusercontent.com/Inkasor/zodchi/main/tools"
curl -fsSL "$base/install-latest.mjs" -o "$scratch/install-latest.mjs"
curl -fsSL "$base/lib/zip.mjs" -o "$scratch/lib/zip.mjs"
node "$scratch/install-latest.mjs" "$@"
