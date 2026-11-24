#!/bin/sh
# Build a portable Zodchi distribution from this checkout.
set -eu
source=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cargo build --release --locked --manifest-path "$source/rust/Cargo.toml"
exec "$source/rust/target/release/zodchi" release build --source "$source" "$@"
