#!/usr/bin/env bash
set -euo pipefail

echo '=== build fem-gpu image ==='
docker compose build fem-gpu

echo '=== visible NVIDIA devices ==='
docker compose run --rm --no-deps fem-gpu bash -lc 'nvidia-smi'

echo '=== required runtime libraries ==='
docker compose run --rm --no-deps fem-gpu bash -lc 'ldconfig -p | grep -E "libmfem|libceed|libHYPRE" || true'

echo '=== FEM GPU smoke: create backend and inspect fields ==='
docker compose run --rm --no-deps fem-gpu bash -lc 'cargo test -p fullmag-runner native_fem::tests::native_fem_scaffold_exposes_initial_state_fields --features fem-gpu -- --nocapture'

echo '=== FEM GPU smoke: exchange-only parity against CPU reference ==='
docker compose run --rm --no-deps fem-gpu bash -lc 'cargo test -p fullmag-runner native_fem::tests::native_fem_exchange_only_matches_cpu_reference_when_mfem_stack_is_available --features fem-gpu -- --nocapture'

echo '=== FEM GPU smoke: DMI fields and energy ==='
docker compose run --rm --no-deps fem-gpu bash -lc 'cargo test -p fullmag-runner native_fem::tests::native_fem_gpu_dmi_step_exposes_fields_and_energy_when_cuda_is_available --features fem-gpu -- --test-threads=1 --nocapture'
