"""Specification-only Airbox observation inputs for the derived SP4 study."""

from __future__ import annotations

from .common import AIRBOX_OBSERVATION, QUALIFICATION_SCOPE


def configuration() -> dict[str, object]:
    """Return the target-only Airbox configuration without materializing a field."""

    return {
        "scope": "airbox_observation",
        "qualification_scope": QUALIFICATION_SCOPE,
        "runtime_qualification": "not_run",
        "cells_xy": AIRBOX_OBSERVATION.cells_xy,
        "spacing_z_m": AIRBOX_OBSERVATION.spacing_z_m,
        "padding_cells_above_below": AIRBOX_OBSERVATION.padding_cells_above_below,
        "sample_offsets_cells": AIRBOX_OBSERVATION.sample_offsets_cells,
        "sample_locations": AIRBOX_OBSERVATION.sample_locations,
        "scope_kind": AIRBOX_OBSERVATION.scope_kind,
        "published_quantities": AIRBOX_OBSERVATION.published_quantities,
        "unavailable_quantities": dict(AIRBOX_OBSERVATION.unavailable_quantities),
        "coordinate_system": AIRBOX_OBSERVATION.coordinate_system,
        "origin_rule": AIRBOX_OBSERVATION.origin_rule,
        "cell_center_rule": AIRBOX_OBSERVATION.cell_center_rule,
        "padding_rule": AIRBOX_OBSERVATION.padding_rule,
        "sample_rule": AIRBOX_OBSERVATION.sample_rule,
        "sample_anchor_indices": tuple(
            {"location": location, "index_ij": index_ij}
            for location, index_ij in AIRBOX_OBSERVATION.sample_anchor_indices
        ),
        "sample_anchor_rule": AIRBOX_OBSERVATION.sample_anchor_rule,
        "target_only": AIRBOX_OBSERVATION.target_only,
    }
