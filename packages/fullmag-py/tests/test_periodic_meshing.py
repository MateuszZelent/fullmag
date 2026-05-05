from __future__ import annotations

import pytest

from fullmag.meshing import PeriodicBoundaryPair, periodic_x, periodic_y, periodic_z


def test_periodic_x_serializes_source_destination() -> None:
    pair = periodic_x("x_periodic", length_m=1e-6)

    assert pair.to_ir() == {
        "pair_id": "x_periodic",
        "source_marker": "x_min",
        "destination_marker": "x_max",
        "translation": [1e-6, 0.0, 0.0],
        "tolerance_m": 1e-12,
        "axis_hint": "x",
        "orientation": "source_to_destination",
        "pairing_policy": "node_nearest_within_tolerance",
    }


def test_periodic_axis_helpers_set_expected_translation_axis() -> None:
    assert periodic_y("y_periodic", length_m=2e-6).to_ir()["translation"] == [0.0, 2e-6, 0.0]
    assert periodic_z("z_periodic", length_m=3e-6).to_ir()["translation"] == [0.0, 0.0, 3e-6]


def test_periodic_boundary_pair_rejects_invalid_translation_shape() -> None:
    with pytest.raises(ValueError, match="translation"):
        PeriodicBoundaryPair(
            pair_id="bad",
            source_marker="a",
            destination_marker="b",
            translation=(1.0, 0.0),
        )
