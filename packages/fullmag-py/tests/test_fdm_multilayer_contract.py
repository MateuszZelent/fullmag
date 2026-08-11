from __future__ import annotations

import pytest

import fullmag as fm
from fullmag import world as flat_world
from fullmag.meshing import realize_fdm_grid_asset


def test_mesh_cell_size_lowers_per_object_and_common_domain() -> None:
    fm.reset()
    study = fm.study("heterogeneous_cells")
    study.engine("fdm")
    study.mode("strict")

    bottom = study.geometry(
        fm.Box(size=(100e-9, 50e-9, 10e-9)),
        name="bottom",
    )
    top = study.geometry(
        fm.Box(size=(100e-9, 50e-9, 10e-9)).translate((0.0, 0.0, 20e-9)),
        name="top",
    )
    for magnet in (bottom, top):
        magnet.Ms = 800e3
        magnet.Aex = 13e-12

    bottom.mesh(cell_size=(2e-9, 2e-9, 10e-9))
    top.mesh(cell_size=(5e-9, 5e-9, 10e-9))
    study.universe.mesh(cell_size=(2e-9, 2e-9, 2.5e-9))
    study.demag()

    fdm = flat_world._build_problem().to_ir()["backend_policy"][
        "discretization_hints"
    ]["fdm"]

    assert fdm["per_magnet"] == {
        "bottom": {"cell": [2e-9, 2e-9, 10e-9]},
        "top": {"cell": [5e-9, 5e-9, 10e-9]},
    }
    assert fdm["demag"]["common_cell_size"] == [2e-9, 2e-9, 2.5e-9]


def test_mesh_cell_size_rejects_fem_element_size_controls() -> None:
    fm.reset()
    body = fm.geometry(fm.Box(size=(10e-9, 10e-9, 10e-9)), name="body")

    with pytest.raises(ValueError, match="cell_size.*maximum_element_size"):
        body.mesh(cell_size=(1e-9, 1e-9, 1e-9), maximum_element_size=2e-9)

    study = fm.study("conflicting_universe_mesh")
    with pytest.raises(ValueError, match="cell_size.*maximum_element_size"):
        study.universe.mesh(
            cell_size=(1e-9, 1e-9, 1e-9),
            maximum_element_size=2e-9,
        )


def test_mesh_cell_size_defaults_allow_per_object_override() -> None:
    fm.reset()
    study = fm.study("cell_defaults")
    study.engine("fdm")
    left = study.geometry(fm.Box(size=(10e-9, 10e-9, 2e-9)), name="left")
    right = study.geometry(fm.Box(size=(10e-9, 10e-9, 2e-9)), name="right")
    for magnet in (left, right):
        magnet.Ms = 800e3
        magnet.Aex = 13e-12

    study.objects.mesh.defaults(cell_size=(2e-9, 2e-9, 2e-9))
    right.mesh(cell_size=(5e-9, 5e-9, 2e-9))
    study.universe.mesh(cell_size=(1e-9, 1e-9, 1e-9))

    fdm = flat_world._build_problem().to_ir()["backend_policy"][
        "discretization_hints"
    ]["fdm"]

    assert fdm["default_cell"] == [2e-9, 2e-9, 2e-9]
    assert fdm["per_magnet"] == {
        "right": {"cell": [5e-9, 5e-9, 2e-9]},
    }


def test_unequal_native_cell_sizes_require_common_domain_cell_size() -> None:
    fm.reset()
    study = fm.study("missing_common_cell")
    study.engine("fdm")
    left = study.geometry(fm.Box(size=(10e-9, 10e-9, 2e-9)), name="left")
    right = study.geometry(fm.Box(size=(10e-9, 10e-9, 2e-9)), name="right")
    for magnet in (left, right):
        magnet.Ms = 800e3
        magnet.Aex = 13e-12
    left.mesh(cell_size=(2e-9, 2e-9, 2e-9))
    right.mesh(cell_size=(5e-9, 5e-9, 2e-9))

    with pytest.raises(ValueError, match="unequal.*study.universe.mesh.*cell_size"):
        flat_world._build_problem()


def test_common_cell_size_rejects_legacy_common_counts() -> None:
    with pytest.raises(ValueError, match="common_cell_size.*common_cells"):
        fm.FDMDemag(
            common_cell_size=(2e-9, 2e-9, 2e-9),
            common_cells=(8, 8, 1),
        )


def test_legacy_study_fdm_warns_with_canonical_mesh_migration() -> None:
    fm.reset()
    study = fm.study("legacy_fdm")

    with pytest.warns(DeprecationWarning, match=r"mesh\(cell_size=.*study\.demag"):
        study.fdm(default_cell=(2e-9, 2e-9, 2e-9))


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
