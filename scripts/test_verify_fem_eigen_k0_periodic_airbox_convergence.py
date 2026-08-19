from __future__ import annotations

import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from verify_fem_eigen_k0_periodic_airbox_convergence import (  # noqa: E402
    CERTIFIED_SOLVER_PROFILES,
    fit_effective_magnetisation,
    sequence_metrics,
)


def test_kittel_fit_reports_observed_scaled_jacobian_conditioning() -> None:
    meff, uncertainty, condition = fit_effective_magnetisation(
        [0.005, 0.02, 0.05, 0.1],
        [1.0e9, 2.0e9, 4.0e9, 8.0e9],
        1.0e11,
        1.2566370614359173e-6,
    )
    assert meff > 0.0
    assert uncertainty >= 0.0
    assert condition > 1.0
    assert condition < 1.0e4


def test_kittel_fit_rejects_singular_field_span() -> None:
    with pytest.raises(SystemExit, match="singular or ill-conditioned"):
        fit_effective_magnetisation(
            [0.01, 0.01, 0.01],
            [1.0e9, 1.0e9, 1.0e9],
            1.0e11,
            1.2566370614359173e-6,
        )


def test_certified_profiles_keep_cpu_and_gpu_solver_lanes_distinct() -> None:
    assert set(CERTIFIED_SOLVER_PROFILES) == {"production_cpu", "production_gpu"}
    assert set(CERTIFIED_SOLVER_PROFILES["production_cpu"]["adapters"]) == {
        "k0_poisson_airbox_cpu_full_coupled_slepc",
        "k0_poisson_airbox_cpu_schur_slepc",
    }
    assert set(CERTIFIED_SOLVER_PROFILES["production_gpu"]["adapters"]) == {
        "k0_poisson_airbox_gpu_petsc_slepc",
    }


def convergence_row(index: int, h: float, frequency_error: float, meff_error: float) -> dict:
    return {
        "root": f"/run/{index}",
        "run_signature": f"sha256:{index:064x}",
        "mesh_resolution_m": h,
        "airbox_size_m": 1.0,
        "fields_t": [0.01, 0.02],
        "frequencies_hz": [
            10.0e9 + frequency_error,
            20.0e9 + 2.0 * frequency_error,
        ],
        "effective_magnetisation_A_per_m": 800_000.0 + meff_error,
    }


def test_sequence_metrics_computes_observed_order_and_richardson() -> None:
    metrics = [
        convergence_row(0, 4.0, 16.0e6, 16_000.0),
        convergence_row(1, 2.0, 4.0e6, 4_000.0),
        convergence_row(2, 1.0, 1.0e6, 1_000.0),
    ]

    result = sequence_metrics("mesh", metrics, budget=1.0e-2)

    assert result["frequency_observed_order"]["status"] == "estimated"
    assert result["frequency_observed_order"]["minimum"] == pytest.approx(2.0)
    assert result["effective_magnetisation_observed_order"]["value"] == pytest.approx(2.0)
    assert result["max_richardson_frequency_error_estimate"] == pytest.approx(
        1.0e6 / 10.001e9
    )
    assert result["richardson_effective_magnetisation_error_estimate"] == pytest.approx(
        1_000.0 / 801_000.0
    )


def test_sequence_metrics_marks_roundoff_plateau_without_fabricating_order() -> None:
    metrics = [
        convergence_row(0, 4.0, 4.0e-4, 4.0e-8),
        convergence_row(1, 2.0, -2.0e-4, -2.0e-8),
        convergence_row(2, 1.0, 1.0e-4, 1.0e-8),
    ]

    result = sequence_metrics("mesh", metrics, budget=1.0e-2)

    assert result["frequency_observed_order"]["status"] == "roundoff_plateau"
    assert result["frequency_observed_order"]["estimated_count"] == 0
    assert result["effective_magnetisation_observed_order"]["status"] == "roundoff_plateau"
    assert result["max_richardson_frequency_error_estimate"] > 0.0
