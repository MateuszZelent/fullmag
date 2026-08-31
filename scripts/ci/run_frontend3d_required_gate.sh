#!/usr/bin/env bash
#
# CI qualification entry point.  The managed-fem gate is deliberately bound
# to the dedicated Linux runner label; it is not an interactive WSL step and
# must not be satisfied by the Windows-local Docker Desktop route without a
# separately verified storage/receipt adapter.
set -euo pipefail

gate="${1:-}"

if [[ -z "$gate" ]]; then
  echo "usage: $0 <gate>" >&2
  exit 64
fi

run_gate() {
  local current_gate="$1"

  if [[ "${FULLMAG_CI_INJECT_FAILURE:-}" == "$current_gate" ]]; then
    echo "INTENTIONAL_FAILURE $current_gate" >&2
    return 1
  fi

  case "$current_gate" in
    rust-quantity-api-cli-contracts)
      cargo test -p fullmag-quantities --no-fail-fast
      cargo test -p fullmag-plan --test magnetization_textures_v2_parity --test mumax3_texture_compatibility --no-fail-fast
      cargo test -p fullmag-runner quantities --no-fail-fast
      cargo test -p fullmag-api router_v2 --no-fail-fast
      cargo test -p fullmag-cli interactive_runtime_host --no-fail-fast
      ;;
    generated-api-determinism)
      pnpm --dir apps/control-room run generate:api
      git diff --exit-code -- \
        apps/control-room/src/kernel/api/generated/openapi-v2.json \
        apps/control-room/src/kernel/api/generated/openapi-v2-types.ts \
        apps/control-room/src/kernel/api/generated/openapi-v2-client.ts
      ;;
    architecture-api-hygiene)
      ./scripts/ci-resource-first-gates.sh --strict
      pnpm --dir apps/control-room run check:architecture-hygiene
      pnpm --dir apps/control-room run check:api-hygiene
      ;;
    control-room-typecheck-lint-test)
      pnpm --dir apps/control-room run typecheck
      pnpm --dir apps/control-room run lint
      pnpm --dir apps/control-room run test
      ;;
    proof-manifest-fixture-self-test)
      pnpm --dir apps/control-room run validate:viewport-proof --self-test
      ;;
    browser-fixture-proof-identity)
      node apps/control-room/scripts/write-browser-fixture-proof-manifest.mjs --check-identity
      ;;
    browser-fixture-source-snapshot)
      artifact_root="${CONTROL_ROOM_AUDIT_ARTIFACTS_DIR:-apps/control-room/.artifacts/viewport-3d-browser-audit}"
      mkdir -p "$artifact_root"
      python3 scripts/capture_source_snapshot_identity.py \
        --repo-root . \
        --output "$artifact_root/source-snapshot.v2.json"
      ;;
    browser-fixture-source-verify)
      artifact_root="${CONTROL_ROOM_AUDIT_ARTIFACTS_DIR:-apps/control-room/.artifacts/viewport-3d-browser-audit}"
      git status --short
      python3 scripts/capture_source_snapshot_identity.py \
        --repo-root . \
        --compare "$artifact_root/source-snapshot.v2.json"
      ;;
    browser-fixture-source-verify-post-write)
      artifact_root="${CONTROL_ROOM_AUDIT_ARTIFACTS_DIR:-apps/control-room/.artifacts/viewport-3d-browser-audit}"
      python3 scripts/capture_source_snapshot_identity.py \
        --repo-root . \
        --compare "$artifact_root/source-snapshot.v2.json"
      ;;
    browser-fixture-proof-manifest)
      node apps/control-room/scripts/write-browser-fixture-proof-manifest.mjs
      ;;
    browser-fixture-smoke)
      run_gate browser-fixture-proof-identity
      run_gate browser-fixture-source-snapshot
      pnpm --dir apps/control-room run audit:viewport-3d-memory-churn
      pnpm --dir apps/control-room run audit:viewport-3d-fem-topology-uploads
      run_gate browser-fixture-source-verify
      run_gate browser-fixture-proof-manifest
      run_gate browser-fixture-source-verify-post-write
      ;;
    managed-fem-qualification)
      if [[ "${FULLMAG_MANAGED_FEM_RUNNER:-}" != "1" ]]; then
        echo "BLOCKED managed-fem-runner-unavailable: requires a self-hosted managed FEM runner" >&2
        return 2
      fi
      just verify-fem-mixed-prism-airbox-runtime
      ;;
    *)
      echo "unknown frontend 3D required gate: $current_gate" >&2
      return 64
      ;;
  esac
}

run_gate "$gate"
