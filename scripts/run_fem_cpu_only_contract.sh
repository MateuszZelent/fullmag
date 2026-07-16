#!/usr/bin/env bash
set -euo pipefail

scenario="${1:-}"
case "$scenario" in
  steady-transport|time-domain|oersted-oet0|oersted-oef1|oersted-oef2) ;;
  *)
    echo "usage: $0 {steady-transport|time-domain|oersted-oet0|oersted-oef1|oersted-oef2}" >&2
    exit 2
    ;;
esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

report_dir="${FULLMAG_FEM_CPU_REPORT_ROOT:-$repo_root/.fullmag/reports/fem-cpu-only}/$scenario"
build_dir="${FULLMAG_FEM_CPU_BUILD_ROOT:-/tmp/fullmag-fem-cpu-only-build}/$scenario"
mkdir -p "$report_dir"
rm -rf "$build_dir"
: > "$report_dir/configure.log"
: > "$report_dir/build.log"
: > "$report_dir/test.log"

result_path="$report_dir/result.json"
status="fail"
write_result() {
  RESULT_PATH="$result_path" SCENARIO="$scenario" STATUS="$status" python3 -c \
    'import json, os, pathlib; path=pathlib.Path(os.environ["RESULT_PATH"]); path.write_text(json.dumps({"schema":"fullmag.fem.cpu_only_contract_result.v1","scenario":os.environ["SCENARIO"],"status":os.environ["STATUS"],"scope":"managed_cpu_lane_prerequisite"}, indent=2, sort_keys=True)+"\n", encoding="utf-8")'
}
trap write_result EXIT

# Source/configuration guard runs before CMake is allowed to configure or build.
python3 scripts/audit_fem_cpu_only_runtime.py \
  --repository-root "$repo_root" \
  --report "$report_dir/repository-audit.json"

cmake -S native -B "$build_dir" \
  -DFULLMAG_ENABLE_CUDA=OFF \
  -DFULLMAG_ENABLE_FEM_GPU=OFF \
  -DFULLMAG_USE_MFEM_STACK=ON \
  -DFULLMAG_FEM_WITH_SLEPC=OFF \
  2>&1 | tee "$report_dir/configure.log"

mfem_library=/opt/fullmag-deps/lib/libmfem.so
hypre_library=/opt/fullmag-deps/lib/libHYPRE.so
python3 scripts/audit_fem_cpu_only_runtime.py \
  --repository-root "$repo_root" \
  --cmake-cache "$build_dir/CMakeCache.txt" \
  --container-image fullmag/fem-cpu:local \
  --device-runtime cpu \
  --dependency-library "$mfem_library" \
  --dependency-library "$hypre_library" \
  --report "$report_dir/configuration-audit.json"

case "$scenario" in
  steady-transport)
    targets=(fem_steady_transport_contract fem_steady_transport_abi_contract)
    executables=(fem_steady_transport_contract fem_steady_transport_abi_contract)
    ;;
  time-domain)
    targets=(
      fem_oersted_contract
      fem_state_io_contract
      fem_snapshot_contract
      fem_rk_explicit_contract
      fem_stt_contract
      fem_thermal_brown_contract
      fem_relaxation_source_contract
      fem_relaxation_energy_derivative_contract
      fem_relaxation_operator_contract
    )
    executables=("${targets[@]}")
    ;;
  oersted-oet0)
    targets=(fem_conservative_current_view_contract)
    executables=("${targets[@]}")
    ;;
  oersted-oef1)
    targets=(fem_conservative_current_view_contract fem_oersted_direct_tetra_contract)
    executables=("${targets[@]}")
    ;;
  oersted-oef2)
    targets=(fem_conservative_current_view_contract fem_oersted_direct_tetra_contract fem_oersted_vector_potential_contract)
    executables=("${targets[@]}")
    ;;
esac

CMAKE_BUILD_PARALLEL_LEVEL="${CMAKE_BUILD_PARALLEL_LEVEL:-1}" \
  cmake --build "$build_dir" --target "${targets[@]}" \
  2>&1 | tee "$report_dir/build.log"

for executable in "${executables[@]}"; do
  printf '=== %s ===\n' "$executable" | tee -a "$report_dir/test.log"
  LD_LIBRARY_PATH="$build_dir/backends/fem:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-}" \
    "$build_dir/backends/fem/$executable" \
    2>&1 | tee -a "$report_dir/test.log"
done

status="pass"
