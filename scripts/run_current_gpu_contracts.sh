#!/usr/bin/env bash
set -euo pipefail

[[ "${1:-}" == gpu-current ]] || { echo 'expected gpu-current scenario' >&2; exit 2; }
: "${FULLMAG_CURRENT_GPU_BUILD_ROOT:?managed private build root required}"
: "${FULLMAG_CURRENT_GPU_REPORT_ROOT:?managed report root required}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
build_dir="$FULLMAG_CURRENT_GPU_BUILD_ROOT"
report_dir="$FULLMAG_CURRENT_GPU_REPORT_ROOT/gpu-current"
mkdir -p "$report_dir"
status=fail
write_result() {
  RESULT_PATH="$report_dir/result.json" STATUS="$status" python3 -c \
    'import json,os,pathlib; pathlib.Path(os.environ["RESULT_PATH"]).write_text(json.dumps({"schema":"fullmag.current.gpu_contract_result.v1","scenario":"gpu-current","status":os.environ["STATUS"],"scope":"native_current_contracts"},sort_keys=True)+"\n")'
}
trap write_result EXIT

cmake -S native -B "$build_dir" \
  -DFULLMAG_ENABLE_CUDA=ON -DFULLMAG_ENABLE_FEM_GPU=ON \
  -DFULLMAG_USE_MFEM_STACK=ON -DFULLMAG_FEM_WITH_SLEPC=OFF \
  2>&1 | tee "$report_dir/configure.log"
targets=(
  fdm_gpu_m1_spin_memory_policy_contract
  fdm_gpu_m1_spin_operator_parity_v1_contract
  fdm_gpu_m1_transport_llg_stage_v1_contract
  fem_gpu_rk_plan
  fem_cuda_tetra_gradient_contract
)
cmake --build "$build_dir" --target "${targets[@]}" \
  2>&1 | tee "$report_dir/build.log"
export LD_LIBRARY_PATH="$build_dir/backends/fdm:$build_dir/backends/fem:${LD_LIBRARY_PATH:-}"
for target in "${targets[@]}"; do
  backend=fdm
  [[ "$target" == fem_* ]] && backend=fem
  # Execute directly: SKIP (77) is a failed qualification, never CTest success.
  "$build_dir/backends/$backend/$target" 2>&1 | tee "$report_dir/$target.log"
done
status=pass
