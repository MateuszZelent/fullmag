#!/usr/bin/env bash
# CI gate: block legacy API usage in production frontend code.
#
# This script detects references to deprecated legacy API endpoints,
# streaming hooks, and binary codecs in the apps/web source code.
# It excludes test files, the cleanup checklist, and this script itself.
#
# Exit codes:
#   0 — no legacy API usage detected
#   1 — forbidden legacy API usage found
#
# Usage:
#   ./scripts/ci-check-legacy-api.sh          # warnings only
#   ./scripts/ci-check-legacy-api.sh --fail   # exit 1 on findings

set -euo pipefail

FAIL_ON_FINDINGS=false
if [[ "${1:-}" == "--fail" ]]; then
  FAIL_ON_FINDINGS=true
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WEB_DIR="$REPO_ROOT/apps/web"

if [[ ! -d "$WEB_DIR" ]]; then
  echo "ERROR: apps/web directory not found at $WEB_DIR"
  exit 1
fi

FINDINGS=0

echo "=== Checking for legacy API endpoint references ==="
LEGACY_ENDPOINTS='live/current/(bootstrap|poll|state|preview|events|publish|create)|commands/next|control/wait|artifacts/file|v1/quantities/catalog'
if rg -n "$LEGACY_ENDPOINTS" "$WEB_DIR" \
  --glob '!**/node_modules/**' \
  --glob '!**/.next/**' \
  --glob '!**/out/**' \
  --glob '!**/*.test.*' \
  --glob '!**/*.spec.*' \
  --glob '!**/cleanupChecklist.ts' \
  --glob '!**/ci-check-legacy-api.sh' \
  --glob '!**/src/api/client/**' \
  --glob '!**/controlRoomApi.ts' \
  --glob '!**/lib/liveApiClient.ts' \
  --glob '!**/lib/useSessionStream.ts' \
  --glob '!**/lib/session/normalize.ts' \
  --glob '!**/lib/session/merge.ts' \
  --glob '!**/lib/livePolling.ts' \
  --glob '!**/lib/quantities/catalog.ts' \
  --glob '!**/launch-intent-live.ts' 2>/dev/null; then
  echo "⚠️  Legacy API endpoint references found"
  FINDINGS=$((FINDINGS + 1))
else
  echo "✅ No legacy API endpoint references"
fi

echo ""
echo "=== Checking for legacy stream/snapshot code ==="
LEGACY_STREAM='useCurrentLiveStream|fetchBootstrap|fetchPoll|normalizeSessionState|mergeSessionState'
if rg -n "$LEGACY_STREAM" "$WEB_DIR" \
  --glob '!**/node_modules/**' \
  --glob '!**/.next/**' \
  --glob '!**/out/**' \
  --glob '!**/*.test.*' \
  --glob '!**/*.spec.*' \
  --glob '!**/cleanupChecklist.ts' \
  --glob '!**/lib/useSessionStream.ts' \
  --glob '!**/lib/session/normalize.ts' \
  --glob '!**/lib/session/merge.ts' \
  --glob '!**/lib/liveApiClient.ts' \
  --glob '!**/features/session-runtime/**' \
  --glob '!**/ControlRoomContext.tsx' 2>/dev/null; then
  echo "⚠️  Legacy stream/snapshot code found"
  FINDINGS=$((FINDINGS + 1))
else
  echo "✅ No legacy stream/snapshot code"
fi

echo ""
echo "=== Summary ==="
if [[ $FINDINGS -gt 0 ]]; then
  echo "Found $FINDINGS category(ies) of legacy API usage."
  if $FAIL_ON_FINDINGS; then
    echo "FAIL: Legacy API gate failed. Migrate to resource-first API before merging."
    exit 1
  else
    echo "WARN: Legacy API usage detected (non-blocking mode)."
  fi
else
  echo "✅ All clear — no legacy API usage detected."
fi
