#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
phase="${1:?missing public retained-DTQ contract phase}"
case "$phase" in baseline-v7|red|green|historical-parser) ;; *) echo "unknown contract phase" >&2; exit 2;; esac
build_dir="${FULLMAG_FEM_CPU_BUILD_ROOT:?missing managed FEM CPU build root}/oersted-oef1"
report_dir="${FULLMAG_FEM_CPU_REPORT_ROOT:-${FULLMAG_RUNTIME_ROOT:?missing managed runtime root}/reports/fem-cpu-only}/retained-dtq-public"
[[ -f "$build_dir/CMakeCache.txt" && -f "$build_dir/backends/fem/libfullmag_fem.so" ]]
grep -Fxq 'FULLMAG_ENABLE_CUDA:BOOL=OFF' "$build_dir/CMakeCache.txt"
grep -Fxq 'FULLMAG_ENABLE_FEM_GPU:BOOL=OFF' "$build_dir/CMakeCache.txt"
grep -Fxq 'FULLMAG_USE_MFEM_STACK:BOOL=ON' "$build_dir/CMakeCache.txt"
mkdir -p "$report_dir"
export FULLMAG_FEM_LIB_DIR="$build_dir/backends/fem"
export LD_LIBRARY_PATH="$FULLMAG_FEM_LIB_DIR:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-}"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-1}"
export RUST_MIN_STACK="${RUST_MIN_STACK:-8388608}"
export FULLMAG_CI_DTQ_FIXTURE_PATH="$report_dir/backend-plan.json"
case "$phase" in
baseline-v7)
    cargo test --locked -p fullmag-application --test retained_dtq_historical_v7_contract -- --nocapture
    ;;
red)
    cargo test --locked -p fullmag-application --lib retained_dtq_ --no-run
    ;;
green)
    cargo test --locked -p fullmag-application --lib retained_ -- --nocapture
    cargo test --locked -p fullmag-application --lib source_preparation_timeout_does_not_submit_or_retry -- --nocapture
    cargo test --locked -p fullmag-application --test retained_dtq_historical_v7_contract -- --nocapture
    cargo test --locked -p fullmag-api --features fem-native --bin fullmag-api retained_dtq_ -- --nocapture
    cargo check --locked -p fullmag-cli -p fullmag-api --all-targets --features fullmag-api/fem-native
    ;;
historical-parser)
    cargo test --locked -p fullmag-ir --test retained_dtq_historical_worker_contract -- --nocapture
    ;;
esac
