#!/bin/sh
# zodchi installer for macOS and Linux. Usage: ./install/install.sh [--domains web-apps,gamedev-unity|all] [--project <repo>]
#   [--no-build] [--no-plugins] [--gateway-cli <cli.mjs>] [--force] [--dry-run] [--uninstall]
set -e
command -v node >/dev/null 2>&1 || { echo "Node.js 20+ is required: https://nodejs.org" >&2; exit 1; }
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$here/install.mjs" "$@"
