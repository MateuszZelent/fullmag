#!/usr/bin/env bash
set -euo pipefail

MODE="${1:---strict}"
if [[ "$MODE" != "--strict" && "$MODE" != "--report" ]]; then
  echo "Unknown mode: $MODE" >&2
  echo "Use --strict (default) or --report" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$REPO_ROOT"

./scripts/ci-resource-first-gates.sh "$MODE"
./scripts/ci/deny_direct_fetch_in_react.sh "$MODE"
./scripts/ci/deny_legacy_viewports.sh "$MODE"
./scripts/ci/deny_capability_from_discretization.sh "$MODE"

echo "Contract guard checks passed."
