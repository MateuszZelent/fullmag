#!/usr/bin/env bash
set -euo pipefail

# Resource-first migration gate.
#
# Goal:
# - print deterministic legacy-usage reports,
# - fail CI only when NEW findings appear outside allowlists.
#
# Usage:
#   ./scripts/ci-resource-first-gates.sh            # strict mode (CI default)
#   ./scripts/ci-resource-first-gates.sh --report   # report only

MODE="strict"
if [[ "${1:-}" == "--report" ]]; then
  MODE="report"
elif [[ -n "${1:-}" && "${1:-}" != "--strict" ]]; then
  echo "Unknown flag: ${1:-}" >&2
  echo "Use --strict (default) or --report" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND_DIR="$REPO_ROOT/apps/control-room"
ALLOWLIST_DIR="$REPO_ROOT/.github/gates"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

normalize_allowlist() {
  local src="$1"
  local dst="$2"
  if [[ ! -f "$src" ]]; then
    : > "$dst"
    return
  fi
  sed -e 's/[[:space:]]\+$//' "$src" \
    | sed '/^[[:space:]]*#/d' \
    | sed '/^[[:space:]]*$/d' \
    | sort -u > "$dst"
}

collect_signatures() {
  local pattern="$1"
  shift
  local dst="$1"
  shift
  local roots=("$@")

  local rg_out="$tmp_dir/rg.raw"
  if rg -o --no-line-number --no-heading --color never "$pattern" "${roots[@]}" \
    --glob '!**/*.mdx' \
    --glob '!**/*.test.*' \
    --glob '!**/*.spec.*' \
    --glob '!**/node_modules/**' \
    --glob '!**/.next/**' \
    --glob '!**/out/**' \
    > "$rg_out"; then
    :
  else
    # rg exits 1 when no matches; treat as empty.
    : > "$rg_out"
  fi
  sed -e "s#^${REPO_ROOT}/##" -e 's/[[:space:]]\+$//' "$rg_out" | sort -u > "$dst"
}

run_gate() {
  local gate_id="$1"
  local gate_title="$2"
  local pattern="$3"
  local allowlist_file="$4"
  shift 4
  local roots=("$@")

  local current="$tmp_dir/${gate_id}.current"
  local allow="$tmp_dir/${gate_id}.allow"
  local unexpected="$tmp_dir/${gate_id}.unexpected"
  local stale="$tmp_dir/${gate_id}.stale"

  collect_signatures "$pattern" "$current" "${roots[@]}"
  normalize_allowlist "$allowlist_file" "$allow"

  comm -23 "$current" "$allow" > "$unexpected"
  comm -13 "$current" "$allow" > "$stale"

  echo
  echo "=== ${gate_title} ==="
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
      GATE_FAILED=1
    fi
  fi

  if [[ -s "$stale" ]]; then
    echo
    echo "Allowlist entries no longer present (cleanup possible):"
    cat "$stale"
  fi
}

run_repo_hygiene_gate() {
  local findings="$tmp_dir/repo-hygiene.current"

  find "$FRONTEND_DIR" \
    \( -path '*/node_modules/*' -o -path '*/.next/*' -o -path '*/out/*' \) -prune \
    -o -type f \
    \( -name '*.rej' -o -name '*.orig' -o -name '*.bak' -o -name 'output.txt' \) \
    -print \
    | sed -e "s#^${REPO_ROOT}/##" \
    | sort -u > "$findings"

  echo
  echo "=== Repo Hygiene Gate ==="
  if [[ -s "$findings" ]]; then
    cat "$findings"
    if [[ "$MODE" == "strict" ]]; then
      GATE_FAILED=1
    fi
  else
    echo "(none)"
  fi
}

GATE_FAILED=0

run_repo_hygiene_gate

run_gate \
  "frontend-legacy-transport" \
  "Frontend Legacy Transport Gate" \
  'useCurrentLiveStream|fetchBootstrap|fetchPoll|currentLiveApiClient|/v1/live/current/bootstrap|/v1/live/current/poll|/preview/' \
  "$ALLOWLIST_DIR/frontend-legacy-transport.allowlist" \
  "$FRONTEND_DIR/app" \
  "$FRONTEND_DIR/src"

run_gate \
  "frontend-snapshot-state" \
  "Frontend Snapshot-State Gate" \
  'session\.current\(|/v1/live/current/state|useCurrentLiveSnapshot|lib/useSessionStream' \
  "$ALLOWLIST_DIR/frontend-snapshot-state.allowlist" \
  "$FRONTEND_DIR/app" \
  "$FRONTEND_DIR/src"

run_gate \
  "frontend-direct-api-client" \
  "Frontend Removed LiveApiClient Name Gate" \
  'getLiveApiClient|initLiveApiClient|LiveApiClient|@/src/api/client/LiveApiClient|(?:\.\./)+src/api/client/LiveApiClient' \
  "$ALLOWLIST_DIR/frontend-direct-api-client.allowlist" \
  "$FRONTEND_DIR/app" \
  "$FRONTEND_DIR/src"

run_gate \
  "frontend-relative-src-imports" \
  "Frontend Relative src/ Import Gate" \
  'from[[:space:]]+["'\''](?:\.\./)+src/[^"'\'']+["'\'']' \
  "$ALLOWLIST_DIR/frontend-relative-src-imports.allowlist" \
  "$FRONTEND_DIR/app" \
  "$FRONTEND_DIR/src"

run_gate \
  "backend-main-public-legacy-routes" \
  "Backend main.rs Public Legacy-Route Gate" \
  '"/v1/live/current|"/v1/health|"/v1/capabilities|"/v1/openapi.json|"/v1/docs/swagger' \
  "$ALLOWLIST_DIR/backend-main-public-legacy-routes.allowlist" \
  "$REPO_ROOT/crates/fullmag-api/src/main.rs"

run_gate \
  "backend-v1-implementation" \
  "Backend Removed V1 Implementation Gate" \
  'router_v1|build_v1_router|crate::openapi::ApiDoc' \
  "$ALLOWLIST_DIR/backend-v1-implementation.allowlist" \
  "$REPO_ROOT/crates/fullmag-api/src"

run_gate \
  "frontend-public-v1-paths" \
  "Frontend Public V1 Path Gate" \
  '/v1/live/current|/v1/health|/v1/capabilities' \
  "$ALLOWLIST_DIR/frontend-public-v1-paths.allowlist" \
  "$FRONTEND_DIR/app" \
  "$FRONTEND_DIR/src"

run_gate \
  "frontend-direct-fetch" \
  "Frontend Direct Fetch Gate" \
  '\bfetch\s*\(' \
  "$ALLOWLIST_DIR/frontend-direct-fetch.allowlist" \
  "$FRONTEND_DIR/app" \
  "$FRONTEND_DIR/src"

echo
echo "=== Generated OpenAPI V2 Transport Gate ==="
if [[ ! -f "$FRONTEND_DIR/src/kernel/api/generated/openapi-v2-types.ts" ]]; then
  echo "Missing generated OpenAPI v2 types."
  if [[ "$MODE" == "strict" ]]; then
    GATE_FAILED=1
  fi
elif rg -n --color never 'export \* from "\.\./types"' "$FRONTEND_DIR/src/kernel/api/generated/openapi-v2-types.ts"; then
  echo "Generated OpenAPI v2 types still re-export manual api/types.ts."
  if [[ "$MODE" == "strict" ]]; then
    GATE_FAILED=1
  fi
else
  echo "openapi-v2-types.ts is generated directly from OpenAPI v2."
fi

if [[ ! -f "$FRONTEND_DIR/src/kernel/api/generated/openapi-v2-client.ts" ]]; then
  echo "Missing generated OpenAPI v2 transport wrapper."
  if [[ "$MODE" == "strict" ]]; then
    GATE_FAILED=1
  fi
else
  echo "openapi-v2-client.ts transport wrapper is present."
fi

if [[ ! -f "$FRONTEND_DIR/src/kernel/api/generated/openapi-v2-paths.ts" ]]; then
  echo "Missing generated OpenAPI v2 path literals."
  if [[ "$MODE" == "strict" ]]; then
    GATE_FAILED=1
  fi
else
  echo "openapi-v2-paths.ts path literal wrapper is present."
fi

if [[ -f "$FRONTEND_DIR/src/kernel/api/generated/openapi.json" || -f "$FRONTEND_DIR/src/kernel/api/generated/openapi-types.ts" ]]; then
  echo "Legacy generated OpenAPI v1 files are present."
  if [[ "$MODE" == "strict" ]]; then
    GATE_FAILED=1
  fi
else
  echo "Legacy generated OpenAPI v1 files are absent."
fi

if node -e 'const spec=require(process.argv[1]); const bad=Object.keys(spec.paths||{}).filter((p)=>p.startsWith("/v1")); if (bad.length) { console.error(bad.join("\n")); process.exit(1); }' "$FRONTEND_DIR/src/kernel/api/generated/openapi-v2.json"; then
  echo "Generated OpenAPI v2 has no /v1 paths."
else
  echo "Generated OpenAPI v2 contains /v1 paths."
  if [[ "$MODE" == "strict" ]]; then
    GATE_FAILED=1
  fi
fi

echo
if [[ $GATE_FAILED -ne 0 ]]; then
  echo "Resource-first gate failed: unexpected legacy findings detected."
  exit 1
fi

echo "Resource-first gates passed."
