#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
build_dir="${FULLMAG_FEM_CPU_BUILD_ROOT:?missing managed FEM CPU build root}/oersted-oef1"
[[ -f "$build_dir/CMakeCache.txt" && -f "$build_dir/backends/fem/libfullmag_fem.so" ]]
grep -Fxq 'FULLMAG_ENABLE_CUDA:BOOL=OFF' "$build_dir/CMakeCache.txt"
grep -Fxq 'FULLMAG_ENABLE_FEM_GPU:BOOL=OFF' "$build_dir/CMakeCache.txt"
grep -Fxq 'FULLMAG_USE_MFEM_STACK:BOOL=ON' "$build_dir/CMakeCache.txt"
[[ "${FULLMAG_MANAGED_FEM_DEVICE:?missing managed FEM device}" == cpu ]]
[[ -d "${CARGO_TARGET_DIR:?missing existing shared Cargo target}" ]]
[[ -d "${CARGO_HOME:?missing existing shared Cargo cache}" ]]
export FULLMAG_FEM_LIB_DIR="$build_dir/backends/fem"
export LD_LIBRARY_PATH="$FULLMAG_FEM_LIB_DIR:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-}"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-1}"
export RUST_MIN_STACK="${RUST_MIN_STACK:-8388608}"
export FULLMAG_DTQ_MANAGED_CI=1
"${FULLMAG_PYTHON:?missing managed Python}" -B \
    .github/antenna-retained-dtq/task-4-fixture/materialize-task4-fixture-ci.py run \
    --source-root "$repo_root" --temporary-root "${FULLMAG_BUILD_ROOT:?missing managed build root}"
