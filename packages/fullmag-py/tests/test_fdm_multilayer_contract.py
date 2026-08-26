from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

import fullmag as fm
from fullmag import world as flat_world
from fullmag.init.preset_eval import evaluate_preset_texture
from fullmag.meshing import realize_fdm_grid_asset
from fullmag.runtime.script_builder import rewrite_loaded_problem_script


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


def test_uniform_texture_with_fdm_asset_remains_normalized_uniform_ir() -> None:
    geometry = fm.Cylinder(radius=4e-9, height=2e-9, name="body")
    material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.01)
    problem = fm.Problem(
        name="uniform_texture_asset",
        magnets=[
            fm.Ferromagnet(
                name="body",
                geometry=geometry,
                material=material,
                m0=fm.texture.uniform(3.0, 4.0, 0.0),
            )
        ],
        energy=[fm.Exchange()],
        study=fm.TimeEvolution(dynamics=fm.LLG(), outputs=[]),
        discretization=fm.DiscretizationHints(fdm=fm.FDM(cell=(2e-9, 2e-9, 2e-9))),
    )

    ir = problem.to_ir(
        requested_backend=fm.BackendTarget.FDM
    )
    assert ir["geometry_assets"] is not None
    initial = ir["magnets"][0]["initial_magnetization"]

    expected = evaluate_preset_texture(
        "uniform", {"direction": [3.0, 4.0, 0.0]}, [(0.0, 0.0, 0.0)]
    ).values[0]
    assert initial == {"kind": "uniform", "value": list(expected)}


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


def test_stage_first_multilayer_material_and_region_authoring_round_trips_stages(
    tmp_path: Path,
) -> None:
    source = tmp_path / "multilayer_material_intent.py"
    source.write_text(
        textwrap.dedent(
            """
            import fullmag as fm

            study = fm.study("multilayer_material_intent")
            study.engine("fdm")
            study.mode("strict")

            free = study.geometry(
                fm.Box(size=(40e-9, 20e-9, 2e-9)).translate((0.0, 0.0, -2e-9)),
                name="free",
            )
            reference = study.geometry(
                fm.Box(size=(40e-9, 20e-9, 2e-9)).translate((0.0, 0.0, 2e-9)),
                name="reference",
            )
            free.Ms = 800e3
            free.Aex = 13e-12
            free.alpha = 0.02
            reference.Ms = 760e3
            reference.Aex = 11e-12
            reference.alpha = 0.04

            free.mesh(cell_size=(2e-9, 2e-9, 2e-9))
            reference.mesh(cell_size=(4e-9, 4e-9, 2e-9))
            study.universe.mesh(cell_size=(2e-9, 2e-9, 2e-9))

            free_core = free.add_region(
                "core",
                fm.Box(size=(20e-9, 10e-9, 2e-9)),
                region_id="free:core",
                priority=7,
            )
            reference_core = reference.add_region(
                "core",
                fm.Box(size=(20e-9, 10e-9, 2e-9)),
                region_id="reference:core",
                priority=9,
            )
            free.set_material_field(
                "Ms",
                fm.fields.linear(base=800e3, gradient=(1e12, 0.0, 0.0), unit="A/m"),
                assignment_id="free_ms",
            )
            free.set_material_field(
                "Aex",
                fm.fields.constant(12e-12, unit="J/m"),
                assignment_id="free_aex",
                region=free_core,
            )
            free.set_material_field(
                "alpha",
                fm.fields.linear(base=0.02, gradient=(1e5, 0.0, 0.0), unit="1"),
                assignment_id="free_alpha",
                region=free_core,
            )
            reference.set_material_field(
                "Ms",
                fm.fields.linear(base=760e3, gradient=(-2e12, 0.0, 0.0), unit="A/m"),
                assignment_id="reference_ms",
            )
            reference.set_material_field(
                "Aex",
                fm.fields.constant(10e-12, unit="J/m"),
                assignment_id="reference_aex",
                region=reference_core,
            )
            reference.set_material_field(
                "alpha",
                fm.fields.linear(base=0.04, gradient=(-1e5, 0.0, 0.0), unit="1"),
                assignment_id="reference_alpha",
                region=reference_core,
            )

            study.demag()
            study.stages.add_relax(
                stage_id="relax",
                algorithm="llg_overdamped",
                max_steps=10,
                dt=1e-13,
            )
            """
        ).strip()
        + "\n",
        encoding="utf-8",
    )

    loaded = fm.load_problem_from_script(source, lightweight_assets=True)
    rendered = rewrite_loaded_problem_script(loaded)["rendered_source"]
    assert isinstance(rendered, str)
    exported = tmp_path / "multilayer_material_intent_exported.py"
    exported.write_text(rendered, encoding="utf-8")
    reloaded = fm.load_problem_from_script(exported, lightweight_assets=True)

    lowering_kwargs = {
        "requested_backend": "fdm",
        "execution_mode": "strict",
        "execution_precision": "double",
        "include_geometry_assets": False,
    }
    original_ir = loaded.to_ir(**lowering_kwargs)
    reloaded_ir = reloaded.to_ir(**lowering_kwargs)
    original_pipeline = loaded.study_pipeline_document()
    reloaded_pipeline = reloaded.study_pipeline_document()

    planner_keys = (
        "backend_policy",
        "geometry",
        "materials",
        "object_regions",
        "material_parameter_fields",
        "study",
    )
    assert {key: reloaded_ir[key] for key in planner_keys} == {
        key: original_ir[key] for key in planner_keys
    }
    assert [
        (magnet["name"], magnet["material"], magnet["region"])
        for magnet in reloaded_ir["magnets"]
    ] == [
        (magnet["name"], magnet["material"], magnet["region"])
        for magnet in original_ir["magnets"]
    ]
    assert original_pipeline == reloaded_pipeline
    assert original_pipeline is not None
    assert [node["stage_kind"] for node in original_pipeline["nodes"]] == ["relax"]
    assert len(loaded.stages) == len(reloaded.stages) == 1

    original_stage_ir = loaded.stages[0].to_ir(
        **lowering_kwargs,
        script_source=loaded.script_source,
        source_root=loaded.source_path.parent,
        study_pipeline=original_pipeline,
    )
    reloaded_stage_ir = reloaded.stages[0].to_ir(
        **lowering_kwargs,
        script_source=reloaded.script_source,
        source_root=reloaded.source_path.parent,
        study_pipeline=reloaded_pipeline,
    )
    assert {key: reloaded_stage_ir[key] for key in planner_keys} == {
        key: original_stage_ir[key] for key in planner_keys
    }
    assert original_stage_ir["study"]["kind"] == "relaxation"
    assert original_stage_ir["study"]["algorithm"] == "llg_overdamped"
    assert original_stage_ir["study"]["stop"]["max_steps"] == 10
    assert (
        original_stage_ir["problem_meta"]["runtime_metadata"]["active_stage_id"]
        == "relax"
    )
    assert (
        reloaded_stage_ir["problem_meta"]["runtime_metadata"]["active_stage_id"]
        == "relax"
    )
    assert set(
        original_ir["backend_policy"]["discretization_hints"]["fdm"]["per_magnet"]
    ) == {"free", "reference"}
    assert [entry["name"] for entry in original_ir["geometry"]["entries"]] == [
        "free_geom",
        "reference_geom",
    ]
    assert {
        (region["owner_object"], region["region_id"])
        for region in original_ir["object_regions"]
    } == {("free", "free:core"), ("reference", "reference:core")}

    assignments = original_ir["material_parameter_fields"]
    assert {
        assignment["assignment_id"]: (
            assignment["owner_object"],
            assignment["parameter"],
            assignment.get("region_id"),
            assignment["value"]["kind"],
            assignment["value"]["unit"],
        )
        for assignment in assignments
    } == {
        "free_ms": ("free", "ms", None, "linear", "A/m"),
        "free_aex": ("free", "aex", "free:core", "constant", "J/m"),
        "free_alpha": ("free", "alpha", "free:core", "linear", "1"),
        "reference_ms": ("reference", "ms", None, "linear", "A/m"),
        "reference_aex": (
            "reference",
            "aex",
            "reference:core",
            "constant",
            "J/m",
        ),
        "reference_alpha": (
            "reference",
            "alpha",
            "reference:core",
            "linear",
            "1",
        ),
    }
    assert {assignment["value"]["kind"] for assignment in assignments} == {
        "constant",
        "linear",
    }
    assert all(
        material[field] is None
        for material in original_ir["materials"]
        for field in ("ms_field", "a_field", "alpha_field")
    )
    assert 'free.set_material_field("Ms", fm.fields.linear' in rendered
    assert 'reference.set_material_field("alpha", fm.fields.linear' in rendered
    assert 'region_id="free:core"' in rendered
    assert 'region_id="reference:core"' in rendered


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
