#!/bin/sh
# Build a portable Zodchi distribution from this checkout.
set -eu
source=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cargo build --release --locked --manifest-path "$source/rust/Cargo.toml"
"$source/rust/target/release/zodchi" release build --source "$source" "$@"
printf '%s\n' 'other agents: zodchi release skill --print | --into <dir>' >&2
