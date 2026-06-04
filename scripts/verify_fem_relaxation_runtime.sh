#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

script="${FULLMAG_FEM_RELAXATION_SMOKE_SCRIPT:-examples/fem_relax_gpu_smoke.py}"
algorithms="${FULLMAG_FEM_RELAXATION_ALGORITHMS:-llg_overdamped projected_gradient_bb nonlinear_cg tangent_plane_implicit}"
engines="${FULLMAG_FEM_RELAXATION_ENGINES:-gpu cpu}"
min_steps="${FULLMAG_FEM_RELAXATION_MIN_STEPS:-4}"
min_relative_energy_decrease="${FULLMAG_FEM_RELAXATION_MIN_RELATIVE_ENERGY_DECREASE:-1e-3}"
max_torque_growth="${FULLMAG_FEM_RELAXATION_MAX_FINAL_TORQUE_GROWTH_FACTOR:-2.0}"
log_dir="$(mktemp -d "${TMPDIR:-/tmp}/fullmag-fem-relaxation-runtime.XXXXXX")"
keep_logs="${FULLMAG_FEM_RELAXATION_KEEP_LOGS:-0}"
if [ "$keep_logs" = "1" ]; then
    echo "[verify_fem_relaxation_runtime] preserving runtime logs: $log_dir"
else
    trap 'rm -rf "$log_dir"' EXIT
fi

for engine in $engines; do
    case "$engine" in
        gpu|cpu)
            ;;
        *)
            echo "[verify_fem_relaxation_runtime] unsupported engine: $engine" >&2
            echo "[verify_fem_relaxation_runtime] supported engines: gpu cpu" >&2
            exit 2
            ;;
    esac
done

for algorithm in $algorithms; do
    case "$algorithm" in
        llg_overdamped|projected_gradient_bb|nonlinear_cg|tangent_plane_implicit)
            ;;
        *)
            echo "[verify_fem_relaxation_runtime] unsupported algorithm: $algorithm" >&2
            echo "[verify_fem_relaxation_runtime] supported: llg_overdamped projected_gradient_bb nonlinear_cg tangent_plane_implicit" >&2
            exit 2
            ;;
    esac
done

echo "[verify_fem_relaxation_runtime] checking native FEM relaxation source contract"
just verify-fem-relaxation-source-contract

echo "[verify_fem_relaxation_runtime] ensuring managed FEM runtime bundle is fresh"
just ensure-managed-fem-runtime

for engine in $engines; do
    for algorithm in $algorithms; do
        if [ "$engine" = "gpu" ] && [ "$algorithm" = "tangent_plane_implicit" ]; then
            echo "[verify_fem_relaxation_runtime] skip unsupported FEM gpu smoke: tangent_plane_implicit"
            continue
        fi
        echo "[verify_fem_relaxation_runtime] running FEM $engine smoke: $algorithm"
        log_path="$log_dir/${engine}_${algorithm}.log"
        FULLMAG_RELAX_ALGORITHM="$algorithm" FULLMAG_RELAX_DEVICE="$engine" \
            just fem-managed-container-headless "$engine" "$script" 2>&1 | tee "$log_path"
        python3 scripts/validate_fem_relaxation_runtime_log.py \
            --engine "$engine" \
            --algorithm "$algorithm" \
            --min-steps "$min_steps" \
            --min-relative-energy-decrease "$min_relative_energy_decrease" \
            --max-final-torque-growth-factor "$max_torque_growth" \
            "$log_path"
    done
done

echo "[verify_fem_relaxation_runtime] FEM relaxation runtime smoke completed"
