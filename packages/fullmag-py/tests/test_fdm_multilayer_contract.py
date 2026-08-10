from __future__ import annotations

import pytest

import fullmag as fm
from fullmag.meshing import realize_fdm_grid_asset


def test_two_object_two_d_policy_preserves_requested_auto_in_ir() -> None:
    hints = fm.FDM(
        per_magnet={
            "free": fm.FDMGrid(cell=(2e-9, 2e-9, 1e-9)),
            "reference": fm.FDMGrid(cell=(4e-9, 4e-9, 2e-9)),
        },
        demag=fm.FDMDemag(
            strategy="auto",
            mode="auto",
            common_cells_xy=(256, 128),
        ),
    )

    assert hints.to_ir() == {
        "per_magnet": {
            "free": {"cell": [2e-9, 2e-9, 1e-9]},
            "reference": {"cell": [4e-9, 4e-9, 2e-9]},
        },
        "demag": {
            "strategy": "auto",
            "mode": "auto",
            "common_cells_xy": [256, 128],
        },
    }


def test_auto_mode_preserves_common_cells_for_planner_resolution() -> None:
    demag = fm.FDMDemag(mode="auto", common_cells=(64, 32, 1))

    assert demag.to_ir()["common_cells"] == [64, 32, 1]


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        (
            {"common_cells": (64, 32, 1), "common_cells_xy": (64, 32)},
            "common_cells.*common_cells_xy",
        ),
        (
            {"mode": "three_d", "common_cells_xy": (64, 32)},
            "common_cells_xy.*auto.*two_d_stack",
        ),
        (
            {"mode": "two_d_stack", "common_cells": (64, 32, 1)},
            "common_cells.*two_d_stack.*three_d",
        ),
        (
            {"common_cells": (64, 32, True)},
            "common_cells values must be positive ints",
        ),
        (
            {"common_cells_xy": (64, True)},
            "common_cells_xy values must be positive ints",
        ),
    ],
)
def test_demag_rejects_incompatible_common_grid_combinations(
    kwargs: dict[str, object], message: str
) -> None:
    with pytest.raises(ValueError, match=message):
        fm.FDMDemag(**kwargs)


@pytest.mark.parametrize(
    ("per_magnet", "message"),
    [
        ({"": fm.FDMGrid(cell=(1e-9, 1e-9, 1e-9))}, "non-empty strings"),
        ({"   ": fm.FDMGrid(cell=(1e-9, 1e-9, 1e-9))}, "non-empty strings"),
        ({1: fm.FDMGrid(cell=(1e-9, 1e-9, 1e-9))}, "non-empty strings"),
        ({"free": (1e-9, 1e-9, 1e-9)}, "FDMGrid"),
    ],
)
def test_fdm_rejects_invalid_per_magnet_entries(
    per_magnet: dict[object, object], message: str
) -> None:
    with pytest.raises((TypeError, ValueError), match=message):
        fm.FDM(per_magnet=per_magnet)  # type: ignore[arg-type]


def test_translated_fdm_asset_preserves_cartesian_position_in_manual_airbox() -> None:
    asset = realize_fdm_grid_asset(
        fm.Box(size=(1.0, 1.0, 1.0)).translate((0.0, 0.0, 2.0)),
        fm.FDM(cell=(1.0, 1.0, 1.0)),
        study_universe={
            "mode": "manual",
            "size": (10.0, 10.0, 10.0),
            "center": (0.0, 0.0, 0.0),
            "padding": (0.0, 0.0, 0.0),
        },
    )

    active_z = {int(index) for index in asset.mask.nonzero()[0]}
    assert active_z == {6}
    assert asset.origin[2] + (6.5 * asset.cell_size[2]) == pytest.approx(2.0)
