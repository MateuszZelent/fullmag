"""Validate the immutable, specification-only SP4-derived qualification inputs."""

from __future__ import annotations

import json
import math
from pathlib import Path
import sys

REPOSITORY_ROOT = Path(__file__).resolve().parents[6]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from tests.standard_problems.mumag.sp4.common.contract import CONTRACT
from tests.standard_problems.mumag.sp4.fdm.multilayer_convolution.airbox_observation import (
    configuration as airbox_configuration,
)
from tests.standard_problems.mumag.sp4.fdm.multilayer_convolution.bilayer_coupling import (
    configuration as bilayer_configuration,
)
from tests.standard_problems.mumag.sp4.fdm.multilayer_convolution.common import (
    CANONICAL_SP4,
    FILM_CELLS,
    FILM_CELL_M,
    GRID_ALIGNED_GAPS_M,
    QUALIFICATION_SCOPE,
)


THRESHOLDS_PATH = Path(__file__).with_name("thresholds.v1.json")
REPORT_SCHEMA_VERSION = "sp4_fdm_multilayer_qualification.v1"


class QualificationConfigurationError(ValueError):
    """Raised when a frozen input diverges from the approved study contract."""


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise QualificationConfigurationError(message)


def load_and_validate_thresholds() -> dict[str, object]:
    """Load exact starting thresholds; this validates configuration, not a run."""

    payload = json.loads(THRESHOLDS_PATH.read_text(encoding="utf-8"))
    _require(payload.get("schema_version") == "fdm_multilayer_thresholds.v1", "threshold schema version")
    _require(payload.get("qualification_scope") == QUALIFICATION_SCOPE, "threshold qualification scope")
    _require(payload.get("units") == {"field": "A/m", "dimensionless": "1"}, "threshold units")
    expected = {
        "cpu_fp64_vs_direct": {
            "metric": "H_demag field difference",
            "norm": "relative_linf_with_absolute_floor",
            "rtol": 1e-10,
            "rtol_unit": "1",
            "atol": 1e-6,
            "atol_unit": "A/m",
        },
        "cuda_fp64_vs_cpu": {
            "metric": "H_demag field difference",
            "norm": "relative_linf_with_absolute_floor",
            "rtol": 1e-8,
            "rtol_unit": "1",
            "atol": 1e-4,
            "atol_unit": "A/m",
        },
        "cuda_fp32_vs_cuda_fp64": {
            "metric": "H_demag field difference",
            "norm": "weighted_rms_and_component_linf",
            "weighted_rms_unit": "1",
            "weighted_rms_max": 2e-4,
            "max_component_normalized": 5e-4,
            "max_component_normalized_unit": "1",
        },
        "transfer_moment_residual": {
            "metric": "volume-weighted total magnetic moment residual",
            "norm": "relative_l2",
            "unit": "1",
            "fp64": 1e-12,
            "fp32": 5e-6,
        },
        "energy_finite_difference_residual": {
            "metric": "demagnetizing energy finite-difference residual",
            "norm": "relative_absolute_residual",
            "unit": "1",
            "fp64": 1e-8,
            "fp32": 5e-4,
        },
        "field_floor": {
            "metric": "relative field denominator floor",
            "norm": "max",
            "unit": "A/m",
            "expression": "max(1 A/m, 1e-8*H_scale)",
        },
    }
    for key, value in expected.items():
        _require(payload.get(key) == value, f"threshold {key}")
    return payload


def validate_scenario_constants(
    bilayer: dict[str, object],
    airbox: dict[str, object],
) -> None:
    """Validate the source-of-truth scenario configurations and canonical SP4."""

    _require(bilayer["scope"] == "bilayer_coupling", "bilayer scope")
    _require(bilayer["qualification_scope"] == QUALIFICATION_SCOPE, "bilayer qualification scope")
    _require(bilayer["runtime_qualification"] == "not_run", "bilayer runtime status")
    _require(tuple(bilayer["film_dimensions_m"]) == (500e-9, 125e-9, 3e-9), "film dimensions")
    _require(tuple(bilayer["cells"]) == FILM_CELLS == (128, 32, 1), "bilayer cells")
    _require(tuple(bilayer["cell_m"]) == FILM_CELL_M == (3.90625e-9, 3.90625e-9, 3e-9), "bilayer spacing")
    _require(bilayer["center_separation_m"] == 9e-9, "center separation")
    _require(bilayer["vacuum_gap_m"] == 6e-9, "vacuum gap")
    _require(
        math.isclose(
            bilayer["center_separation_m"] - bilayer["film_dimensions_m"][2],
            bilayer["vacuum_gap_m"],
            rel_tol=0.0,
            abs_tol=1e-21,
        ),
        "gap geometry",
    )
    _require(bilayer["inter_object_exchange"] == "disabled", "inter-object exchange")
    _require(bilayer["provenance"].get("inter_object_exchange") == "disabled", "exchange provenance")
    _require(tuple(bilayer["grid_aligned_gap_sweep_m"]) == GRID_ALIGNED_GAPS_M == (3e-9, 6e-9, 12e-9, 24e-9), "grid-aligned gap sweep")
    _require(tuple(bilayer["cross_layer_checks"]) == (
        "H_A<-B = H_A(A+B)-H_A(A)",
        "source_sign_flip",
        "zero_pair_kernel_negative_control",
    ), "cross-layer isolation checks")
    _require(bilayer["off_grid_gap_label"] == "push_pull_off_grid_only", "off-grid gap label")

    _require(airbox["scope"] == "airbox_observation", "Airbox scope")
    _require(airbox["qualification_scope"] == QUALIFICATION_SCOPE, "Airbox qualification scope")
    _require(airbox["runtime_qualification"] == "not_run", "Airbox runtime status")
    _require(tuple(airbox["cells_xy"]) == (128, 32), "Airbox XY cells")
    _require(airbox["spacing_z_m"] == 3e-9, "Airbox Z spacing")
    _require(tuple(airbox["padding_cells_above_below"]) == (3, 6, 12), "Airbox padding")
    _require(tuple(airbox["sample_offsets_cells"]) == (1, 2, 4), "Airbox sample offsets")
    _require(tuple(airbox["sample_locations"]) == ("center", "long_edge", "short_edge"), "Airbox sample locations")
    _require(airbox["scope_kind"] == "airbox", "Airbox field scope")
    _require(airbox["published_quantities"] == ("H_demag",), "Airbox published quantities")
    _require(airbox["unavailable_quantities"] == {"H_eff": "fdm_multilayer_airbox_h_eff_unavailable.v1"}, "Airbox H_eff reason")
    _require(airbox["target_only"] is True, "Airbox target-only policy")
    _require(airbox["coordinate_system"] == "cartesian_si", "Airbox coordinate system")
    for key in ("origin_rule", "cell_center_rule", "padding_rule", "sample_rule"):
        _require(isinstance(airbox[key], str) and bool(airbox[key]), f"Airbox {key}")
    _require(
        tuple(
            (value["location"], tuple(value["index_ij"]))
            for value in airbox["sample_anchor_indices"]
        )
        == (
            ("center", (64, 16)),
            ("long_edge", (64, 31)),
            ("short_edge", (127, 16)),
        ),
        "Airbox sample anchor indices",
    )
    _require(isinstance(airbox["sample_anchor_rule"], str) and bool(airbox["sample_anchor_rule"]), "Airbox sample anchor rule")

    _require(CANONICAL_SP4.dimensions_m == CONTRACT.dimensions_m, "SP4 dimensions")
    _require(CANONICAL_SP4.ms_a_per_m == CONTRACT.ms_a_per_m, "SP4 Ms")
    _require(CANONICAL_SP4.aex_j_per_m == CONTRACT.aex_j_per_m, "SP4 Aex")
    _require(CANONICAL_SP4.alpha == CONTRACT.alpha, "SP4 alpha")
    _require(CANONICAL_SP4.gamma_mu0_m_per_as == CONTRACT.gamma_mu0_m_per_as, "SP4 gamma")
    _require(CANONICAL_SP4.initial_m == CONTRACT.initial_m, "SP4 initial magnetization")
    canonical_cases = tuple((case.id, case.field_t) for case in CONTRACT.cases)
    _require(CANONICAL_SP4.cases == canonical_cases, "SP4 case fields")
    _require(CANONICAL_SP4.sample_period_s == CONTRACT.sample_period_s, "SP4 sample period")
    _require(CANONICAL_SP4.minimum_duration_s == CONTRACT.minimum_duration_s, "SP4 minimum duration")
    _require(CANONICAL_SP4.equilibrium_window_s == CONTRACT.equilibrium_window_s, "SP4 equilibrium window")
    _require(CANONICAL_SP4.maximum_duration_s == CONTRACT.maximum_duration_s, "SP4 maximum duration")
    canonical_meshes = tuple((mesh.id, mesh.hmax_m) for mesh in CONTRACT.meshes)
    _require(CANONICAL_SP4.meshes == canonical_meshes, "SP4 mesh variants")
    canonical_airboxes = tuple(
        (airbox.id, airbox.dimensions_m, airbox.hmax_m)
        for airbox in CONTRACT.airboxes
    )
    _require(CANONICAL_SP4.airboxes == canonical_airboxes, "SP4 Airbox variants")


def report() -> dict[str, object]:
    """Return validated immutable inputs, explicitly without runtime qualification."""

    thresholds = load_and_validate_thresholds()
    bilayer = bilayer_configuration()
    airbox = airbox_configuration()
    validate_scenario_constants(bilayer, airbox)
    bilayer_report = dict(bilayer)
    bilayer_report["film_dimensions_nm"] = [value * 1e9 for value in bilayer["film_dimensions_m"]]
    bilayer_report["cell_nm"] = [value * 1e9 for value in bilayer["cell_m"]]
    bilayer_report["center_separation_nm"] = bilayer["center_separation_m"] * 1e9
    bilayer_report["vacuum_gap_nm"] = bilayer["vacuum_gap_m"] * 1e9
    bilayer_report["grid_aligned_gap_sweep_nm"] = [value * 1e9 for value in bilayer["grid_aligned_gap_sweep_m"]]
    airbox_report = dict(airbox)
    airbox_report["spacing_z_nm"] = airbox["spacing_z_m"] * 1e9
    return {
        "schema_version": REPORT_SCHEMA_VERSION,
        "qualification_scope": QUALIFICATION_SCOPE,
        "runtime_qualification": "not_run",
        "bilayer": bilayer_report,
        "airbox": airbox_report,
        "canonical_sp4": {
            "dimensions_m": CANONICAL_SP4.dimensions_m,
            "ms_a_per_m": CANONICAL_SP4.ms_a_per_m,
            "aex_j_per_m": CANONICAL_SP4.aex_j_per_m,
            "alpha": CANONICAL_SP4.alpha,
            "gamma_mu0_m_per_as": CANONICAL_SP4.gamma_mu0_m_per_as,
            "initial_m": CANONICAL_SP4.initial_m,
            "cases": tuple({"id": case_id, "field_t": field} for case_id, field in CANONICAL_SP4.cases),
            "sample_period_s": CANONICAL_SP4.sample_period_s,
            "minimum_duration_s": CANONICAL_SP4.minimum_duration_s,
            "equilibrium_window_s": CANONICAL_SP4.equilibrium_window_s,
            "maximum_duration_s": CANONICAL_SP4.maximum_duration_s,
            "meshes": tuple(
                {"id": mesh_id, "hmax_m": hmax_m}
                for mesh_id, hmax_m in CANONICAL_SP4.meshes
            ),
            "airboxes": tuple(
                {
                    "id": airbox_id,
                    "dimensions_m": dimensions,
                    "hmax_m": hmax_m,
                }
                for airbox_id, dimensions, hmax_m in CANONICAL_SP4.airboxes
            ),
        },
        "thresholds": thresholds,
    }


if __name__ == "__main__":
    print(json.dumps(report(), indent=2, sort_keys=True))
