"""Specification-only Airbox observation inputs for the derived SP4 study."""

from __future__ import annotations

from .common import AIRBOX_OBSERVATION


def configuration() -> dict[str, object]:
    """Return the target-only Airbox configuration without materializing a field."""

    return {
        "cells_xy": AIRBOX_OBSERVATION.cells_xy,
        "spacing_z_m": AIRBOX_OBSERVATION.spacing_z_m,
        "padding_cells_above_below": AIRBOX_OBSERVATION.padding_cells_above_below,
        "sample_offsets_cells": AIRBOX_OBSERVATION.sample_offsets_cells,
        "sample_locations": AIRBOX_OBSERVATION.sample_locations,
        "scope_kind": AIRBOX_OBSERVATION.scope_kind,
        "published_quantities": AIRBOX_OBSERVATION.published_quantities,
        "unavailable_quantities": dict(AIRBOX_OBSERVATION.unavailable_quantities),
    }
