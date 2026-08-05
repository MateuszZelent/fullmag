#!/usr/bin/env bash
set -euo pipefail

scenario="${1:-}"
case "$scenario" in
  steady-transport|time-domain|oersted-oet0|oersted-oet0-tsan|oersted-oef1|oersted-oef2) ;;
  *)
    echo "usage: $0 {steady-transport|time-domain|oersted-oet0|oersted-oet0-tsan|oersted-oef1|oersted-oef2}" >&2
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

cmake_options=()
if [[ "$scenario" == "oersted-oet0-tsan" ]]; then
  cmake_options+=( -DFULLMAG_OET0_TSAN=ON )
fi

cmake -S native -B "$build_dir" \
  -DFULLMAG_ENABLE_CUDA=OFF \
  -DFULLMAG_ENABLE_FEM_GPU=OFF \
  -DFULLMAG_USE_MFEM_STACK=ON \
  -DFULLMAG_FEM_WITH_SLEPC=OFF \
  "${cmake_options[@]}" \
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

if [[ "$scenario" == "oersted-oet0-tsan" ]]; then
  grep -Fq 'FULLMAG_OET0_TSAN:BOOL=ON' "$build_dir/CMakeCache.txt"
  if grep -Fq 'FULLMAG_MFEM_MPI_QUALIFICATION' "$report_dir/configure.log"; then
    echo 'TSan configure unexpectedly ran the MFEM MPI qualification probe' >&2
    exit 1
  fi
  grep -Fq -- '-DFULLMAG_OET0_DISABLE_MPI=1' \
    "$build_dir/backends/fem/CMakeFiles/fem_conservative_current_view_contract.dir/flags.make"
  grep -Fq -- '-fsanitize=thread' \
    "$build_dir/backends/fem/CMakeFiles/fem_conservative_current_view_contract.dir/flags.make"
  grep -Fq -- '-fno-omit-frame-pointer' \
    "$build_dir/backends/fem/CMakeFiles/fem_conservative_current_view_contract.dir/flags.make"
  grep -Fq -- '-fsanitize=thread' \
    "$build_dir/backends/fem/CMakeFiles/fem_conservative_current_view_contract.dir/link.txt"
  tsan_ctest_list="$report_dir/tsan-ctest-list.log"
  ctest --test-dir "$build_dir/backends/fem" --show-only=human \
    --tests-regex '^fem_conservative_current_view_' \
    2>&1 | tee "$tsan_ctest_list" | tee -a "$report_dir/test.log"
  grep -Fq 'fem_conservative_current_view_contract' "$tsan_ctest_list"
  if grep -Eq 'mpi_n1|mpi_n2|mpi_byte_identity' "$tsan_ctest_list"; then
    echo 'TSan CTest registration unexpectedly contains an MPI launcher/test' >&2
    exit 1
  fi
  oet0_production_sources=(
    conservative_constraint_rank.cpp
    periodic_charge_potential.cpp
    conservative_current_view.cpp
  )
  existing_oet0_sources=0
  for source in "${oet0_production_sources[@]}"; do
    if [[ -f "backends/fem/cpu/mfem/transport/$source" ]]; then
      existing_oet0_sources=$((existing_oet0_sources + 1))
    fi
  done
  if [[ "$existing_oet0_sources" -eq 3 ]]; then
    for source in "${oet0_production_sources[@]}"; do
      grep -Fq "$source" \
        "$build_dir/backends/fem/CMakeFiles/fem_conservative_current_view_contract.dir/build.make"
    done
  elif [[ "$existing_oet0_sources" -ne 0 ]]; then
    echo 'partial OE-T0 production source set escaped the CMake fatal gate' >&2
    exit 1
  fi
  echo 'OE-T0 TSan generated instrumentation rules audit: PASS (test+production TU compile/link rules; MPI code/CLI/CTest disabled)' \
    | tee -a "$report_dir/configure.log"
fi

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
  oersted-oet0|oersted-oet0-tsan)
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

if [[ "$scenario" == "oersted-oet0-tsan" ]]; then
  command -v setarch >/dev/null 2>&1 || {
    echo 'TSan requires setarch to disable ASLR before the instrumented process starts' >&2
    exit 1
  }
  TSAN_OPTIONS="halt_on_error=1:exitcode=66" \
  LD_LIBRARY_PATH="$build_dir/backends/fem:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-}" \
    setarch x86_64 -R ctest --test-dir "$build_dir/backends/fem" --output-on-failure \
      --tests-regex '^fem_conservative_current_view_contract$' \
      2>&1 | tee -a "$report_dir/test.log"
elif [[ "$scenario" == oersted-oe* ]]; then
  oet0_ctest_filter='^fem_conservative_current_view_(contract|mpi_n1|mpi_n2|mpi_byte_identity)$'
  oet0_ctest_list="$report_dir/oet0-ctest-list.log"
  ctest --test-dir "$build_dir/backends/fem" --show-only=human \
    --tests-regex "$oet0_ctest_filter" \
    2>&1 | tee "$oet0_ctest_list" | tee -a "$report_dir/test.log"
  required_oet0_tests=(
    fem_conservative_current_view_contract
    fem_conservative_current_view_mpi_n1
    fem_conservative_current_view_mpi_n2
    fem_conservative_current_view_mpi_byte_identity
  )
  for required_test in "${required_oet0_tests[@]}"; do
    if ! grep -Fq "${required_test}" "$oet0_ctest_list"; then
      echo "missing required OE-T0 CTest qualification: ${required_test}" \
        | tee -a "$report_dir/test.log" >&2
      exit 1
    fi
  done
  LD_LIBRARY_PATH="$build_dir/backends/fem:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-}" \
    ctest --test-dir "$build_dir/backends/fem" --output-on-failure \
      --tests-regex "$oet0_ctest_filter" \
      2>&1 | tee -a "$report_dir/test.log"
fi

for executable in "${executables[@]}"; do
  if [[ ( "$scenario" == oersted-oe* || "$scenario" == "oersted-oet0-tsan" ) &&
        "$executable" == fem_conservative_current_view_contract ]]; then
    continue
  fi
  printf '=== %s ===\n' "$executable" | tee -a "$report_dir/test.log"
  LD_LIBRARY_PATH="$build_dir/backends/fem:/opt/fullmag-deps/lib:${LD_LIBRARY_PATH:-}" \
    "$build_dir/backends/fem/$executable" \
    2>&1 | tee -a "$report_dir/test.log"
done

status="pass"
