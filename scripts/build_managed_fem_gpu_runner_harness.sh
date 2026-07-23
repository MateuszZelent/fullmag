#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
candidate_variant="${1:?usage: build_managed_fem_gpu_runner_harness.sh CANDIDATE_VARIANT}"
candidate_root="${REPO_ROOT}/.fullmag/runtimes/fem-gpu-variants/${candidate_variant}"
output_parent="${REPO_ROOT}/.fullmag/runners/fem-gpu-task6"
staging_root="${output_parent}/.build.$$"
staging_relative=".fullmag/runners/fem-gpu-task6/.build.$$"

if [[ ! -f "${candidate_root}/manifest.json" ]]; then
  echo "candidate runtime manifest is missing: ${candidate_root}/manifest.json" >&2
  exit 2
fi

mkdir -p "${staging_root}"
cleanup() {
  rm -rf -- "${staging_root}"
}
trap cleanup EXIT

cd "${REPO_ROOT}"
docker compose --profile fem-gpu run --rm -T --no-deps \
  -e FULLMAG_CUDA_ARCHITECTURES="${FULLMAG_CUDA_ARCHITECTURES:-80-real;89-real;90-real;90-virtual}" \
  -e FULLMAG_RUNNER_STAGING="${staging_relative}" \
  -e FULLMAG_HOST_UID="$(id -u)" \
  -e FULLMAG_HOST_GID="$(id -g)" \
  fem-gpu bash -lc '
set -euo pipefail
FULLMAG_USE_MFEM_STACK=ON cargo +nightly build -p fullmag-cli --features "cuda fem-gpu" --release
install -m 755 target/release/fullmag "${FULLMAG_RUNNER_STAGING}/fullmag-fem-gpu-bin"
chown "${FULLMAG_HOST_UID}:${FULLMAG_HOST_GID}" "${FULLMAG_RUNNER_STAGING}/fullmag-fem-gpu-bin"
'

python3 scripts/publish_fem_gpu_runner_harness.py \
  --worker "${staging_root}/fullmag-fem-gpu-bin" \
  --candidate-root "${candidate_root}" \
  --output-parent "${output_parent}"
