#!/usr/bin/env bash
set -euo pipefail

skip_build=false
if [[ "${1:-}" == "--skip-build" ]]; then
  skip_build=true
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
app_source="$repo_root/release/mac-arm64/devrooms.app"
install_dir="${DEVROOMS_INSTALL_DIR:-/Applications}"
app_name="${DEVROOMS_APP_NAME:-devrooms.app}"
app_dest="$install_dir/$app_name"

cd "$repo_root"

if [[ "$skip_build" == false ]]; then
  pnpm run package:mac
fi

if [[ ! -x "$app_source/Contents/MacOS/devrooms" ]]; then
  echo "missing packaged app: $app_source" >&2
  echo "run: pnpm run package:mac" >&2
  exit 1
fi

mkdir -p "$install_dir"
rm -rf "$app_dest"
ditto "$app_source" "$app_dest"

if [[ ! -x "$app_dest/Contents/MacOS/devrooms" ]]; then
  echo "install verification failed: $app_dest" >&2
  exit 1
fi

echo "installed $app_dest"
