"""Validate the immutable, specification-only SP4-derived qualification inputs."""

from __future__ import annotations

import json
import math
from pathlib import Path

from common import (
    AIRBOX_H_EFF_REASON,
    AIRBOX_OBSERVATION,
    BILAYER,
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
        "cpu_fp64_vs_direct": {"rtol": 1e-10, "atol_a_per_m": 1e-6},
        "cuda_fp64_vs_cpu": {"rtol": 1e-8, "atol_a_per_m": 1e-4},
        "cuda_fp32_vs_cuda_fp64": {"weighted_rms_max": 2e-4, "max_max": 5e-4},
        "transfer_moment_residual": {"fp64": 1e-12, "fp32": 5e-6},
        "energy_finite_difference_residual": {"fp64": 1e-8, "fp32": 5e-4},
        "field_floor": "max(1 A/m, 1e-8*H_scale)",
    }
    for key, value in expected.items():
        _require(payload.get(key) == value, f"threshold {key}")
    return payload


def validate_scenario_constants() -> None:
    """Validate dimensions, gap geometry, checks, and Airbox availability policy."""

    _require(BILAYER.film_dimensions_m == (500e-9, 125e-9, 3e-9), "film dimensions")
    _require(BILAYER.cells == FILM_CELLS == (128, 32, 1), "bilayer cells")
    _require(BILAYER.cell_m == FILM_CELL_M == (3.90625e-9, 3.90625e-9, 3e-9), "bilayer spacing")
    _require(BILAYER.center_separation_m == 9e-9, "center separation")
    _require(BILAYER.vacuum_gap_m == 6e-9, "vacuum gap")
    _require(
        math.isclose(
            BILAYER.center_separation_m - BILAYER.film_dimensions_m[2],
            BILAYER.vacuum_gap_m,
            rel_tol=0.0,
            abs_tol=1e-21,
        ),
        "gap geometry",
    )
    _require(BILAYER.inter_object_exchange == "disabled", "inter-object exchange")
    _require(dict(BILAYER.provenance).get("inter_object_exchange") == "disabled", "exchange provenance")
    _require(GRID_ALIGNED_GAPS_M == (3e-9, 6e-9, 12e-9, 24e-9), "grid-aligned gap sweep")
    _require(AIRBOX_OBSERVATION.cells_xy == (128, 32), "Airbox XY cells")
    _require(AIRBOX_OBSERVATION.spacing_z_m == 3e-9, "Airbox Z spacing")
    _require(AIRBOX_OBSERVATION.padding_cells_above_below == (3, 6, 12), "Airbox padding")
    _require(AIRBOX_OBSERVATION.sample_offsets_cells == (1, 2, 4), "Airbox sample offsets")
    _require(AIRBOX_OBSERVATION.sample_locations == ("center", "long_edge", "short_edge"), "Airbox sample locations")
    _require(AIRBOX_OBSERVATION.scope_kind == "airbox", "Airbox scope")
    _require(AIRBOX_OBSERVATION.published_quantities == ("H_demag",), "Airbox published quantities")
    _require(dict(AIRBOX_OBSERVATION.unavailable_quantities) == {"H_eff": AIRBOX_H_EFF_REASON}, "Airbox H_eff reason")


def report() -> dict[str, object]:
    """Return validated immutable inputs, explicitly without runtime qualification."""

    thresholds = load_and_validate_thresholds()
    validate_scenario_constants()
    return {
        "schema_version": REPORT_SCHEMA_VERSION,
        "qualification_scope": QUALIFICATION_SCOPE,
        "runtime_qualification": "not_run",
        "bilayer": {
            "film_dimensions_nm": [dimension * 1e9 for dimension in BILAYER.film_dimensions_m],
            "cells": list(BILAYER.cells),
            "cell_nm": [cell * 1e9 for cell in BILAYER.cell_m],
            "center_separation_nm": BILAYER.center_separation_m * 1e9,
            "vacuum_gap_nm": BILAYER.vacuum_gap_m * 1e9,
            "inter_object_exchange": BILAYER.inter_object_exchange,
            "provenance": dict(BILAYER.provenance),
            "grid_aligned_gap_sweep_nm": [gap * 1e9 for gap in GRID_ALIGNED_GAPS_M],
            "cross_layer_checks": [
                "H_A<-B = H_A(A+B)-H_A(A)",
                "source_sign_flip",
                "zero_pair_kernel_negative_control",
            ],
        },
        "airbox": {
            "cells_xy": list(AIRBOX_OBSERVATION.cells_xy),
            "spacing_z_nm": AIRBOX_OBSERVATION.spacing_z_m * 1e9,
            "padding_cells_above_below": list(AIRBOX_OBSERVATION.padding_cells_above_below),
            "sample_offsets_cells": list(AIRBOX_OBSERVATION.sample_offsets_cells),
            "sample_locations": list(AIRBOX_OBSERVATION.sample_locations),
            "scope_kind": AIRBOX_OBSERVATION.scope_kind,
            "published_quantities": list(AIRBOX_OBSERVATION.published_quantities),
            "unavailable_quantities": dict(AIRBOX_OBSERVATION.unavailable_quantities),
        },
        "thresholds": {key: thresholds[key] for key in (
            "cpu_fp64_vs_direct",
            "cuda_fp64_vs_cpu",
            "cuda_fp32_vs_cuda_fp64",
            "transfer_moment_residual",
            "energy_finite_difference_residual",
            "field_floor",
        )},
    }


if __name__ == "__main__":
    print(json.dumps(report(), indent=2, sort_keys=True))
