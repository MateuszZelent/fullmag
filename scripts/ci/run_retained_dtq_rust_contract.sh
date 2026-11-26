#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
build_dir="${FULLMAG_FEM_CPU_BUILD_ROOT:?missing managed FEM CPU build root}/oersted-oef1"
report_dir="${FULLMAG_FEM_CPU_REPORT_ROOT:-${FULLMAG_RUNTIME_ROOT:?missing managed runtime root}/reports/fem-cpu-only}/retained-dtq-rust"
# The preceding OE-F1 recipe owns configuration and the CPU-only dependency audit.
[[ -f "$build_dir/CMakeCache.txt" ]]
grep -Fxq 'FULLMAG_ENABLE_CUDA:BOOL=OFF' "$build_dir/CMakeCache.txt"
grep -Fxq 'FULLMAG_ENABLE_FEM_GPU:BOOL=OFF' "$build_dir/CMakeCache.txt"
grep -Fxq 'FULLMAG_USE_MFEM_STACK:BOOL=ON' "$build_dir/CMakeCache.txt"
mkdir -p "$report_dir"
CMAKE_BUILD_PARALLEL_LEVEL="${CMAKE_BUILD_PARALLEL_LEVEL:-1}" \
    cmake --build "$build_dir" --target fullmag_fem \
    2>&1 | tee "$report_dir/build.log"

export FULLMAG_FEM_LIB_DIR="$build_dir/backends/fem"
export LD_LIBRARY_PATH="$FULLMAG_FEM_LIB_DIR:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-}"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-1}"
export RUST_MIN_STACK="${RUST_MIN_STACK:-8388608}"
cargo test --locked -p fullmag-runner --lib --features fem-native \
    native_fem::steady_transport::retained_ -- --nocapture \
    2>&1 | tee "$report_dir/test.log"
