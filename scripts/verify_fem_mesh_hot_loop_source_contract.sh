#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

fail() {
  echo "[verify_fem_mesh_hot_loop_source_contract] $1" >&2
  exit 1
}

inventory="$(rg -n 'StepUpdate[[:space:]]*\{|\.fem_mesh\b' \
  crates/fullmag-runner/src crates/fullmag-cli/src crates/fullmag-api/src || true)"
constructor_count="$(printf '%s\n' "$inventory" | rg -c 'StepUpdate[[:space:]]*\{' || true)"
mesh_access_count="$(printf '%s\n' "$inventory" | rg -c '\.fem_mesh\b' || true)"
echo "[verify_fem_mesh_hot_loop_source_contract] inventory: ${constructor_count:-0} StepUpdate sites, ${mesh_access_count:-0} mesh accesses"

while IFS= read -r source; do
  awk '
    function braces(line, copy, opens, closes) {
      copy = line; opens = gsub(/\{/, "", copy)
      copy = line; closes = gsub(/\}/, "", copy)
      return opens - closes
    }
    /StepUpdate[[:space:]]*\{/ && $0 !~ /->[[:space:]]*([^[:space:]]*::)?StepUpdate[[:space:]]*\{/ && $0 !~ /^[[:space:]]*impl[[:space:]]+StepUpdate[[:space:]]*\{/ && $0 !~ /contains\(.*StepUpdate/ {
      active = 1; depth = braces($0); has_generation = 0; has_payload = 0; start = NR
    }
    active {
      if ($0 ~ /fem_mesh_generation_id[[:space:]]*[:,]/) has_generation = 1
      if ($0 ~ /(^|[[:space:]])fem_mesh[[:space:]]*:/) has_payload = 1
      if (NR != start) depth += braces($0)
      if (depth == 0) {
        if (!has_generation || has_payload) {
          printf "%s:%d: unclassified StepUpdate constructor (generation=%d payload=%d)\n", FILENAME, start, has_generation, has_payload > "/dev/stderr"
          failed = 1
        }
        active = 0
      }
    }
    END { exit failed }
  ' "$source" || fail "all StepUpdate constructors must be generation-only"
done < <(rg -l 'StepUpdate[[:space:]]*\{' crates/fullmag-runner/src crates/fullmag-cli/src crates/fullmag-api/src)

if rg -n '(^|[[:space:]])fem_mesh:[[:space:]]*Option<FemMeshPayload>' \
  crates/fullmag-runner/src/types.rs crates/fullmag-cli/src/types.rs; then
  fail "runtime StepUpdate/LiveStepView must not own a FEM mesh payload"
fi

if rg -n '\.fem_mesh\b|(^|[[:space:]])fem_mesh:' crates/fullmag-runner/src; then
  fail "runner step producers must carry only fem_mesh_generation_id"
fi

if rg -n 'latest_step\.fem_mesh\b|update\.fem_mesh\b' crates/fullmag-cli/src; then
  fail "CLI step state must resolve mesh data from the stage-scoped workspace resource"
fi

api_nested_hits="$(rg -n 'latest_step\.fem_mesh\b' crates/fullmag-api/src || true)"
api_unclassified_hits="$(printf '%s\n' "$api_nested_hits" | rg -v \
  'crates/fullmag-api/src/session.rs:.*latest_step\.fem_mesh\.(clone|take)\(\)|crates/fullmag-api/src/router_v2/tests.rs:' || true)"
if [[ -n "$api_unclassified_hits" ]]; then
  printf '%s\n' "$api_unclassified_hits" >&2
  fail "nested API mesh access is limited to input-only compatibility promotion and its tests"
fi

if rg -n 'fem_mesh_generation_id:[[:space:]]*FemMeshPayload::from' \
  crates/fullmag-runner/src crates/fullmag-cli/src; then
  fail "mesh payload construction is forbidden inside step callback construction"
fi

echo "[verify_fem_mesh_hot_loop_source_contract] semantic mesh ownership contract passed"
