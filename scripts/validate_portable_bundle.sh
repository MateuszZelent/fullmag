#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <bundle-root>" >&2
  exit 2
fi

BUNDLE_ROOT="$(cd "$1" && pwd)"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

require_file() {
  local path="$1"
  [[ -e "$path" ]] || fail "missing required path: $path"
}

check_no_missing_ldd() {
  local path="$1"
  echo "== ldd: ${path#$BUNDLE_ROOT/}"
  local output
  output="$(ldd "$path" 2>&1 || true)"
  echo "$output"
  if grep -Fq "not found" <<<"$output"; then
    fail "ldd reported missing dependencies for ${path#$BUNDLE_ROOT/}"
  fi
}

check_runpath_contains() {
  local path="$1"
  local fragment="$2"
  echo "== readelf: ${path#$BUNDLE_ROOT/}"
  local output
  output="$(readelf -d "$path" 2>&1 || true)"
  echo "$output" | rg "RPATH|RUNPATH" || true
  if ! grep -Eq 'RPATH|RUNPATH' <<<"$output"; then
    fail "missing RUNPATH/RPATH for ${path#$BUNDLE_ROOT/}"
  fi
  if ! grep -Fq "$fragment" <<<"$output"; then
    fail "RUNPATH/RPATH for ${path#$BUNDLE_ROOT/} does not include ${fragment}"
  fi
}

require_file "$BUNDLE_ROOT/bin/fullmag"
require_file "$BUNDLE_ROOT/bin/fullmag-bin"
require_file "$BUNDLE_ROOT/bin/fullmag-api"
require_file "$BUNDLE_ROOT/lib/libfullmag_fdm.so.0"
require_file "$BUNDLE_ROOT/web/index.html"
require_file "$BUNDLE_ROOT/python/bin/python"
require_file "$BUNDLE_ROOT/python/bin/python3"
require_file "$BUNDLE_ROOT/packages/fullmag-py/src/fullmag/__init__.py"
require_file "$BUNDLE_ROOT/share/smoke_quick.py"
require_file "$BUNDLE_ROOT/share/version.json"

check_no_missing_ldd "$BUNDLE_ROOT/bin/fullmag-bin"
check_no_missing_ldd "$BUNDLE_ROOT/bin/fullmag-api"
check_no_missing_ldd "$BUNDLE_ROOT/lib/libfullmag_fdm.so.0"
check_no_missing_ldd "$BUNDLE_ROOT/python/bin/python"

check_runpath_contains "$BUNDLE_ROOT/bin/fullmag-bin" '$ORIGIN/../lib'
check_runpath_contains "$BUNDLE_ROOT/bin/fullmag-api" '$ORIGIN/../lib'
check_runpath_contains "$BUNDLE_ROOT/lib/libfullmag_fdm.so.0" '$ORIGIN'

if [[ -x "$BUNDLE_ROOT/runtimes/fdm-cuda/bin/fullmag-fdm-cuda-bin" ]]; then
  check_no_missing_ldd "$BUNDLE_ROOT/runtimes/fdm-cuda/bin/fullmag-fdm-cuda-bin"
  check_runpath_contains "$BUNDLE_ROOT/runtimes/fdm-cuda/bin/fullmag-fdm-cuda-bin" '$ORIGIN/../lib'
fi

if [[ -x "$BUNDLE_ROOT/runtimes/fem-gpu/bin/fullmag-fem-gpu-bin" ]]; then
  check_no_missing_ldd "$BUNDLE_ROOT/runtimes/fem-gpu/bin/fullmag-fem-gpu-bin"
  check_runpath_contains "$BUNDLE_ROOT/runtimes/fem-gpu/bin/fullmag-fem-gpu-bin" '$ORIGIN/../lib'
fi

python_real="$(readlink -f "$BUNDLE_ROOT/python/bin/python3" 2>/dev/null || true)"
if [[ -z "$python_real" || "$python_real" != "$BUNDLE_ROOT"* ]]; then
  fail "bundled python resolves outside the bundle: ${python_real:-<unresolved>}"
fi

python_version_dir="$(find "$BUNDLE_ROOT/python/lib" -maxdepth 1 -mindepth 1 -type d -name 'python3.*' | head -n 1)"
if [[ -z "$python_version_dir" ]]; then
  fail "could not locate bundled python stdlib directory"
fi

echo "== smoke: bundled python imports"
PYTHONHOME="$BUNDLE_ROOT/python" \
LD_LIBRARY_PATH="$BUNDLE_ROOT/python/lib:$python_version_dir:$python_version_dir/site-packages/numpy.libs:$python_version_dir/site-packages/scipy.libs:$python_version_dir/site-packages/scipy/.libs" \
"$BUNDLE_ROOT/python/bin/python" - <<'PY' >/dev/null
import gmsh
import meshio
import numpy
import scipy
import trimesh
PY

echo "== smoke: headless smoke_quick"
smoke_output="$BUNDLE_ROOT/share/smoke-quick.json"
rm -f "$smoke_output"
if command -v timeout >/dev/null 2>&1; then
  (
    cd "$BUNDLE_ROOT"
    timeout 120s ./bin/fullmag share/smoke_quick.py --headless --json
  ) >"$smoke_output"
else
  (
    cd "$BUNDLE_ROOT"
    ./bin/fullmag share/smoke_quick.py --headless --json
  ) >"$smoke_output"
fi

if [[ ! -s "$smoke_output" ]]; then
  fail "smoke run did not produce output"
fi

echo "Portable bundle validation passed."
