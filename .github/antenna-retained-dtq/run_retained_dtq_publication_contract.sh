#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
build_dir="${FULLMAG_FEM_CPU_BUILD_ROOT:?missing managed FEM CPU build root}/oersted-oef1"
[[ -f "$build_dir/CMakeCache.txt" && -f "$build_dir/backends/fem/libfullmag_fem.so" ]]
grep -Fxq 'FULLMAG_ENABLE_CUDA:BOOL=OFF' "$build_dir/CMakeCache.txt"
grep -Fxq 'FULLMAG_ENABLE_FEM_GPU:BOOL=OFF' "$build_dir/CMakeCache.txt"
grep -Fxq 'FULLMAG_USE_MFEM_STACK:BOOL=ON' "$build_dir/CMakeCache.txt"
export FULLMAG_FEM_LIB_DIR="$build_dir/backends/fem"
export LD_LIBRARY_PATH="$FULLMAG_FEM_LIB_DIR:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-}"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-1}"
export RUST_MIN_STACK="${RUST_MIN_STACK:-8388608}"
# Compilation includes the registered authenticated harness; its positive test is not executed.
cargo test --locked -p fullmag-runtime-control --lib --no-default-features --no-run
cargo test --locked -p fullmag-runtime-control --lib --no-default-features dtq_v2_publication_identity_requires_exact_artifact_contract -- --nocapture
cargo test --locked -p fullmag-runtime-control --lib --no-default-features dtq_v2_tensor_ -- --nocapture
cargo test --locked -p fullmag-session --lib dtq_v2_ -- --nocapture
cargo test --locked -p fullmag-runtime-control --lib --no-default-features task4_authenticated_acceptance::dtq_v2_temp_root_nested_in_source_is_rejected_before_copy -- --exact --nocapture
cargo test --locked -p fullmag-runtime-control --lib --features fullmag-runner/fem-native --no-run
cargo check --locked -p fullmag-cli -p fullmag-api --all-targets --features fullmag-api/fem-native
printf '%s\n' 'TASK4_AUTHENTICATED_POSITIVE_ACCEPTANCE=NOT_RUN_MISSING_LEGAL_FIXTURE'
