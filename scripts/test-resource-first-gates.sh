#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURE_ROOT="$SCRIPT_DIR/test-fixtures/resource-first-gates"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

prepare_fixture() {
  local name="$1"
  local target="$TMP_DIR/$name"

  cp -R "$FIXTURE_ROOT/$name/." "$target"
  mkdir -p \
    "$target/scripts" \
    "$target/apps/control-room/app" \
    "$target/apps/control-room/scripts" \
    "$target/crates/fullmag-api/src"
  cp -R "$FIXTURE_ROOT/clean/apps/control-room/src/kernel" \
    "$target/apps/control-room/src/"
  cp "$REPO_ROOT/scripts/ci-resource-first-gates.sh" "$target/scripts/"
  cp "$REPO_ROOT/apps/control-room/scripts/check-api-hygiene.mjs" \
    "$target/apps/control-room/scripts/"
  printf '%s' "$target"
}

expect_gate_result() {
  local fixture="$1"
  local expected_status="$2"
  local expected_message="$3"
  local gate="$4"
  local root
  root="$(prepare_fixture "$fixture")"
  local output="$TMP_DIR/$fixture-$gate.log"
  local status=0

  if [[ "$gate" == "api" ]]; then
    (
      cd "$root/apps/control-room"
      node scripts/check-api-hygiene.mjs
    ) >"$output" 2>&1 || status=$?
  else
    "$root/scripts/ci-resource-first-gates.sh" --strict >"$output" 2>&1 || status=$?
  fi

  [[ "$status" == "$expected_status" ]] \
    || fail "$fixture/$gate returned $status, expected $expected_status:\n$(<"$output")"
  if [[ -n "$expected_message" ]]; then
    rg -F "$expected_message" "$output" >/dev/null \
      || fail "$fixture/$gate omitted expected message '$expected_message':\n$(<"$output")"
  fi
}

for gate in api strict; do
  if [[ "$gate" == "api" ]]; then
    direct_fetch_message="direct fetch"
    legacy_message="legacy"
  else
    direct_fetch_message="Frontend Direct Fetch Gate"
    legacy_message="Frontend Legacy Transport Gate"
  fi

  expect_gate_result "clean" 0 "" "$gate"
  expect_gate_result "direct-fetch" 1 "$direct_fetch_message" "$gate"
  expect_gate_result "legacy-preview-endpoint" 1 "$legacy_message" "$gate"
  expect_gate_result "legacy-preview-import" 1 "$legacy_message" "$gate"
done

echo "Resource-first gate regression fixtures passed."
