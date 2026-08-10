"""Specification-only bilayer coupling inputs for the derived SP4 study."""

from __future__ import annotations

from .common import (
    BILAYER,
    GRID_ALIGNED_GAPS_M,
    OFF_GRID_GAP_LABEL,
    QUALIFICATION_SCOPE,
)


def configuration() -> dict[str, object]:
    """Return the immutable bilayer configuration without launching a runtime."""

    return {
        "scope": "bilayer_coupling",
        "qualification_scope": QUALIFICATION_SCOPE,
        "runtime_qualification": "not_run",
        "film_dimensions_m": BILAYER.film_dimensions_m,
        "cells": BILAYER.cells,
        "cell_m": BILAYER.cell_m,
        "center_separation_m": BILAYER.center_separation_m,
        "vacuum_gap_m": BILAYER.vacuum_gap_m,
        "inter_object_exchange": BILAYER.inter_object_exchange,
        "provenance": dict(BILAYER.provenance),
        "grid_aligned_gap_sweep_m": GRID_ALIGNED_GAPS_M,
        "off_grid_gap_label": OFF_GRID_GAP_LABEL,
        "cross_layer_checks": (
            "H_A<-B = H_A(A+B)-H_A(A)",
            "source_sign_flip",
            "zero_pair_kernel_negative_control",
        ),
    }
