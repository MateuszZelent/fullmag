"""Canonical SI configuration for the COMSOL-aligned nonzero-k benchmark.

The values in this module are the shared input contract for the C0/C1/A1
controls. The executable workflow is problem.py; this module deliberately
contains no solver implementation.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
import os
from typing import Literal

import fullmag as fm


BENCHMARK_ID = "comsol-py-antidot-square-v1"
A_LAT_M = 200.0e-9
FILM_THICKNESS_M = 10.0e-9
HOLE_RADIUS_M = 50.0e-9
AIR_PADDING_M = 2.0e-6
UNIVERSE_SIZE_M = (A_LAT_M, A_LAT_M, 2.0 * AIR_PADDING_M + FILM_THICKNESS_M)
FILM_CENTER_M = (0.0, 0.0, 0.0)

MS_A_PER_M = 8.0e5
AEX_J_PER_M = 13.0e-12
MU0_H_PER_M = 4.0e-7 * math.pi
GAMMA_M_PER_A_S = 2.211e5
BIAS_FIELD_T = (0.1, 0.0, 0.0)
BIAS_FIELD_A_PER_M = BIAS_FIELD_T[0] / MU0_H_PER_M
BIAS_FIELD_A_PER_M_VECTOR = tuple(value / MU0_H_PER_M for value in BIAS_FIELD_T)
COMSOL_A_FIELD_A_M = 2.0 * AEX_J_PER_M / (MU0_H_PER_M * MS_A_PER_M)

RELAX_ALPHA = 0.5
EIGEN_ALPHA = 0.0
RELAX_DT_S = 1.0e-14
RELAX_TORQUE_TOLERANCE_A_PER_M = 1.0
RELAX_MAX_STEPS = 50_000

MODE_COUNT = 24
TARGET_BANDS = 8
MODE_FIELD_SAMPLE_INDICES = (0, 10, 20, 40, 50, 60)
INITIAL_SHIFT_HZ = 1.0e9
FREQUENCY_WINDOW_HZ = (1.0e6, 30.0e9)
# The independently certified Hypre residual can be a small factor above the
# requested stopping threshold on this airbox mesh; retain a strict explicit
# gate while matching the guide's 1e-7 relaxation tolerance.
DEMAG_SOLVER_RTOL = 1.0e-7
DEMAG_SOLVER_MAX_ITERATIONS = 1000

AIRBOX_HMAX_M = 100.0e-9
AIRBOX_GROWTH_RATE = 1.3
INTERFACE_HMAX_M = 5.0e-9
INTERFACE_THICKNESS_M = 20.0e-9
INTERFACE_TRANSITION_DISTANCE_M = 20.0e-9
THIN_FILM_LAYERS = 3
THIN_FILM_ORDER = 1

K_SIGN = 1.0
KPATH_SAMPLES_PER_SEGMENT = (20, 20, 20)
CONTROL_LABELS = ("Gamma", "X", "M", "Gamma")


@dataclass(frozen=True, slots=True)
class BenchmarkCase:
    """One of the guide's C0/C1/A1 input controls."""

    key: Literal["c0", "c1", "a1"]
    description: str
    has_hole: bool
    include_demag: bool
    use_floquet: bool
    use_path: bool

    @property
    def study_name(self) -> str:
        return f"{BENCHMARK_ID}-{self.key}"


_CASES: dict[str, BenchmarkCase] = {
    "c0": BenchmarkCase(
        key="c0",
        description="uniform full film, Gamma, exchange plus Zeeman only",
        has_hole=False,
        include_demag=False,
        use_floquet=False,
        use_path=False,
    ),
    "c1": BenchmarkCase(
        key="c1",
        description="uniform full film with finite Dirichlet airbox demag",
        has_hole=False,
        include_demag=True,
        use_floquet=True,
        use_path=True,
    ),
    "a1": BenchmarkCase(
        key="a1",
        description="square antidot with finite Dirichlet airbox demag",
        has_hole=True,
        include_demag=True,
        use_floquet=True,
        use_path=True,
    ),
}


def case_from_environment() -> BenchmarkCase:
    """Resolve FULLMAG_COMSOL_DISPERSION_CASE with an A1 default."""

    key = os.environ.get("FULLMAG_COMSOL_DISPERSION_CASE", "a1").strip().lower()
    try:
        return _CASES[key]
    except KeyError as exc:
        allowed = ", ".join(_CASES)
        raise ValueError(
            "FULLMAG_COMSOL_DISPERSION_CASE must be one of "
            f"{allowed}; got {key!r}"
        ) from exc


def available_cases() -> tuple[BenchmarkCase, ...]:
    return tuple(_CASES[key] for key in ("c0", "c1", "a1"))


def build_k_sampling(case: BenchmarkCase) -> fm.KPoint | fm.KPath:
    """Return the exact guide sampling for a control case."""

    if not case.use_path:
        return fm.KPoint("Gamma", (0.0, 0.0, 0.0))
    k_gamma = (0.0, 0.0, 0.0)
    k_x = (K_SIGN * math.pi / A_LAT_M, 0.0, 0.0)
    k_m = (K_SIGN * math.pi / A_LAT_M, K_SIGN * math.pi / A_LAT_M, 0.0)
    return fm.KPath(
        points=[
            fm.KPoint(CONTROL_LABELS[0], k_gamma),
            fm.KPoint(CONTROL_LABELS[1], k_x),
            fm.KPoint(CONTROL_LABELS[2], k_m),
            fm.KPoint(CONTROL_LABELS[3], k_gamma),
        ],
        samples_per_segment=KPATH_SAMPLES_PER_SEGMENT,
    )


def mode_field_selection(case: BenchmarkCase) -> tuple[tuple[int, ...], tuple[int, ...]]:
    """Resolve bounded mode-field exports without reducing the frequency sweep."""

    raw = os.environ.get("FULLMAG_COMSOL_DISPERSION_ALL_FIELDS", "0").strip().lower()
    if raw not in {"0", "1", "false", "true", "no", "yes"}:
        raise ValueError(
            "FULLMAG_COMSOL_DISPERSION_ALL_FIELDS must be one of "
            "0, 1, false, true, no, yes"
        )
    all_fields = raw in {"1", "true", "yes"}
    if all_fields:
        return tuple(range(MODE_COUNT)), ()
    return tuple(range(TARGET_BANDS)), (
        MODE_FIELD_SAMPLE_INDICES if case.use_path else (0,)
    )


def expected_magnetic_volume_m3(case: BenchmarkCase) -> float:
    area = A_LAT_M * A_LAT_M
    if case.has_hole:
        area -= math.pi * HOLE_RADIUS_M * HOLE_RADIUS_M
    return area * FILM_THICKNESS_M


def guide_metadata(case: BenchmarkCase) -> dict[str, object]:
    """Return auditable input/output metadata without claiming execution."""

    mode_indices, sample_indices = mode_field_selection(case)
    all_fields = len(mode_indices) == MODE_COUNT and not sample_indices
    return {
        "schema_version": "fullmag.comsol_nonzero_k_benchmark.v1",
        "benchmark_id": BENCHMARK_ID,
        "case_id": case.key,
        "case_description": case.description,
        "source_guide": "docs/guides/comsol-nonzero-k-dispersion-benchmark.md",
        "comsol_reference": {"potential_unknown": "periodic_envelope_psi"},
        "time_convention": "exp(+i*omega*t)",
        "bloch_convention": "exp(-i*k_dot_r)",
        "geometry": {
            "lattice_period_m": A_LAT_M,
            "film_size_m": [A_LAT_M, A_LAT_M, FILM_THICKNESS_M],
            "film_center_m": list(FILM_CENTER_M),
            "hole_radius_m": HOLE_RADIUS_M if case.has_hole else None,
            "air_padding_each_side_m": AIR_PADDING_M,
            "universe_size_m": list(UNIVERSE_SIZE_M),
            "air_in_hole": case.has_hole,
            "magnetic_volume_m3": expected_magnetic_volume_m3(case),
        },
        "material": {
            "Ms_A_per_m": MS_A_PER_M,
            "Aex_J_per_m": AEX_J_PER_M,
            "comsol_A_field_A_m": COMSOL_A_FIELD_A_M,
            "mu0_H_per_m": MU0_H_PER_M,
            "gamma_m_per_A_s": GAMMA_M_PER_A_S,
            "bias_field_T": list(BIAS_FIELD_T),
            "bias_field_A_per_m": list(BIAS_FIELD_A_PER_M_VECTOR),
            "K_volume_A_per_m": 0.0,
            "Ks_surface_A": 0.0,
            "dmi": "disabled",
            "stt_sot_thermal_noise": "disabled",
        },
        "mesh": {
            "airbox_hmax_m": AIRBOX_HMAX_M,
            "airbox_growth_rate": AIRBOX_GROWTH_RATE,
            "near_film_hmax_m": INTERFACE_HMAX_M,
            "near_film_thickness_m": INTERFACE_THICKNESS_M,
            "near_film_transition_distance_m": INTERFACE_TRANSITION_DISTANCE_M,
            "thin_film_layers": THIN_FILM_LAYERS,
            "finite_element_order": THIN_FILM_ORDER,
            "topology_intent": "tetrahedral",
            "periodic_pair_ids": ["x_faces", "y_faces"],
        },
        "equilibrium": {
            "workflow": "relax_then_frozen_equilibrium",
            "initial_magnetization": [1.0, 0.0, 0.0],
            "relax_alpha": RELAX_ALPHA,
            "dt_s": RELAX_DT_S,
            "max_steps": RELAX_MAX_STEPS,
            "torque_tolerance_A_per_m": RELAX_TORQUE_TOLERANCE_A_PER_M,
            "reuse_for_all_k": True,
        },
        "eigensolve": {
            "operator": "full_2x2",
            "complex_arithmetic": True,
            "damping_policy": "ignore",
            "alpha": EIGEN_ALPHA,
            "target": "frequency_window",
            "frequency_window_hz": list(FREQUENCY_WINDOW_HZ),
            "initial_shift_hz": INITIAL_SHIFT_HZ,
            "initial_shift_status": "guide reference; public DSL has no shift parameter",
            "requested_mode_count": MODE_COUNT,
            "comparison_band_count": TARGET_BANDS,
            "k_sampling": (
                "Gamma"
                if not case.use_path
                else "Gamma-X-M-Gamma, 61 samples"
            ),
            "spin_wave_bc": (
                "periodic" if not case.use_floquet else "floquet"
            ),
            "magnetostatic_bc": (
                "open" if not case.include_demag else "floquet_airbox"
            ),
            "static_demag_realization": (
                None if not case.include_demag else "poisson_dirichlet"
            ),
            "demag_solver": {
                "relative_tolerance": DEMAG_SOLVER_RTOL,
                "max_iterations": DEMAG_SOLVER_MAX_ITERATIONS,
            },
        },
        "outputs": {
            "spectrum": "eigen_spectrum",
            "dispersion": "dispersion.csv plus path metadata",
            "modes": "all requested raw modes at selected samples",
            "mode_field_export": {
                "policy": "all_61_samples_x_24_modes" if all_fields else "first_8_modes_at_control_samples",
                "mode_indices": list(mode_indices),
                "sample_indices": list(sample_indices),
                "all_fields_opt_in": "FULLMAG_COMSOL_DISPERSION_ALL_FIELDS=1",
            },
            "potential": (
                "potential_full.bin plus demag_element_full.bin for selected shared-domain modes"
                if case.include_demag
                else "not_applicable"
            ),
            "potential_representation": (
                "full_physical_phasor"
                if case.include_demag
                else None
            ),
            "potential_unknown": (
                "full_physical_phi" if case.include_demag else None
            ),
            "full_nodal_potential_map": "native_phase_reconstruction; runtime_not_verified",
        },
        "execution_status": "authoring_contract_only",
    }
