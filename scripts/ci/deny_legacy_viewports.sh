#!/usr/bin/env bash
set -euo pipefail

MODE="strict"
if [[ "${1:-}" == "--report" ]]; then
  MODE="report"
elif [[ -n "${1:-}" && "${1:-}" != "--strict" ]]; then
  echo "Unknown flag: ${1:-}" >&2
  echo "Use --strict (default) or --report" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ALLOWLIST="$REPO_ROOT/.github/gates/frontend-legacy-viewports.allowlist"

cd "$REPO_ROOT"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

current="$tmp_dir/current"
allow="$tmp_dir/allow"
unexpected="$tmp_dir/unexpected"
stale="$tmp_dir/stale"
raw="$tmp_dir/raw"

if rg -n --no-heading -o 'VectorFieldView3D|FdmViewportHost|FallbackBoundsPreview' apps/web \
  --glob '!**/*.test.*' \
  --glob '!**/*.spec.*' \
  --glob '!**/*.stories.*' \
  --glob '!**/node_modules/**' > "$raw"; then
  :
else
  : > "$raw"
fi

awk -F: '{print $1":"$NF}' "$raw" | sed -e 's/[[:space:]]\+$//' | sort -u > "$current"

if [[ -f "$ALLOWLIST" ]]; then
  sed -e 's/[[:space:]]\+$//' "$ALLOWLIST" | sed '/^[[:space:]]*#/d' | sed '/^[[:space:]]*$/d' | sort -u > "$allow"
else
  : > "$allow"
fi

comm -23 "$current" "$allow" > "$unexpected"
comm -13 "$current" "$allow" > "$stale"

echo "=== Frontend Legacy Viewports Gate ==="
if [[ -s "$current" ]]; then
  cat "$current"
else
  echo "(none)"
fi

if [[ -s "$unexpected" ]]; then
  echo
  echo "Unexpected findings (not in allowlist):"
  cat "$unexpected"
  if [[ "$MODE" == "strict" ]]; then
    exit 1
  fi
fi

if [[ -s "$stale" ]]; then
  echo
  echo "Allowlist entries no longer present (cleanup possible):"
  cat "$stale"
fi
