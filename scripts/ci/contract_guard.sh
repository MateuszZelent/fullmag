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

# The root workspace is owned by pnpm.  Keep npm lockfiles available for
# nested projects (for example external_solvers/amumax/frontend), but fail
# closed if an npm lockfile is accidentally reintroduced at the workspace root.
if [[ -e "$REPO_ROOT/package-lock.json" ]]; then
  echo "root package-lock.json is forbidden; use the canonical pnpm-lock.yaml" >&2
  exit 1
fi
if ! grep -Fq '"packageManager": "pnpm@10.8.1"' "$REPO_ROOT/package.json"; then
  echo "root package.json must declare packageManager pnpm@10.8.1" >&2
  exit 1
fi
if [[ ! -f "$REPO_ROOT/pnpm-lock.yaml" ]]; then
  echo "root pnpm-lock.yaml is missing" >&2
  exit 1
fi

./scripts/ci-resource-first-gates.sh "$MODE"
./scripts/ci/deny_direct_fetch_in_react.sh "$MODE"
./scripts/ci/deny_legacy_viewports.sh "$MODE"
./scripts/ci/deny_capability_from_discretization.sh "$MODE"
python3 scripts/update_readme_version_dashboard.py --check

echo "Contract guard checks passed."
