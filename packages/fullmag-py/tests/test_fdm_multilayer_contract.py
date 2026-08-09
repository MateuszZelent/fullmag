from __future__ import annotations

import pytest

import fullmag as fm


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


def test_two_d_stack_accepts_common_cells_only_with_one_z_cell() -> None:
    demag = fm.FDMDemag(mode="two_d_stack", common_cells=(64, 32, 1))

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
            {"mode": "two_d_stack", "common_cells": (64, 32, 2)},
            "common_cells.*two_d_stack.*one.*Z",
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
        ({1: fm.FDMGrid(cell=(1e-9, 1e-9, 1e-9))}, "non-empty strings"),
        ({"free": (1e-9, 1e-9, 1e-9)}, "FDMGrid"),
    ],
)
def test_fdm_rejects_invalid_per_magnet_entries(
    per_magnet: dict[object, object], message: str
) -> None:
    with pytest.raises((TypeError, ValueError), match=message):
        fm.FDM(per_magnet=per_magnet)  # type: ignore[arg-type]
