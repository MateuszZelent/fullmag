from __future__ import annotations

import json
import textwrap
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

import fullmag as fm


def _problem(*, constraints=(), region_constraints=True, selections=()):
    region = fm.ObjectRegion(
        owner_object="free_layer",
        name="Pinned edge",
        region_id="pinned_edge",
        shape=fm.Box(size=(10e-9, 50e-9, 3e-9)),
    )
    if region_constraints:
        region.freeze_spins(
            id="pinned_edge_frozen",
            name="Pinned edge",
            stage_ids=["relax"],
        )
    magnet = fm.Ferromagnet(
        name="User-facing free layer",
        object_id="free_layer",
        geometry=fm.Box(size=(100e-9, 50e-9, 3e-9), name="free_layer_geometry"),
        material=fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.01),
        object_regions=(region,),
    )
    return fm.Problem(
        name="frozen-spins-contract",
        magnets=[magnet],
        energy=[fm.Exchange()],
        study=fm.Relaxation(outputs=[], max_steps=1),
        selections=selections,
        magnetization_constraints=constraints,
        runtime_metadata={
            "study_pipeline": {
                "version": "study_pipeline.v1",
                "nodes": [
                    {
                        "id": "relax",
                        "stage_kind": "relax",
                        "enabled": True,
                        "payload": {},
                    }
                ],
            }
        },
    )


def test_region_convenience_and_explicit_api_emit_identical_canonical_json() -> None:
    convenience = _problem().to_ir(include_geometry_assets=False)
    explicit = _problem(
        region_constraints=False,
        constraints=[
            fm.FrozenSpins(
                id="pinned_edge_frozen",
                name="Pinned edge",
                selector=fm.select.in_region("free_layer", "pinned_edge"),
                stage_ids=["relax"],
            )
        ],
    ).to_ir(include_geometry_assets=False)

    assert convenience["ir_version"] == "0.3.0"
    assert (
        convenience["magnetization_constraints"]
        == explicit["magnetization_constraints"]
    )
    assert convenience["magnetization_constraints"][0]["selector"] == {
        "kind": "in_region",
        "object_id": "free_layer",
        "region_id": "pinned_edge",
    }
    region_ir = convenience["object_regions"][0]
    assert "frozen" not in region_ir
    assert region_ir["material_overrides"] == []
    assert convenience["materials"][0]["damping"] == 0.01


def test_ferromagnet_convenience_uses_object_id_not_name() -> None:
    problem = _problem(region_constraints=False)
    problem.magnets[0].freeze_spins(id="whole_object_frozen", stage_ids=["relax"])
    ir = fm.Problem(
        name=problem.name,
        magnets=problem.magnets,
        energy=problem.energy,
        study=problem.study,
        runtime_metadata=problem.runtime_metadata,
    ).to_ir(include_geometry_assets=False)
    assert ir["magnetization_constraints"][0]["selector"] == {
        "kind": "in_object",
        "object_id": "free_layer",
    }

    unnamed = fm.Ferromagnet(
        name="Only a display name",
        geometry=fm.Box(size=(1, 1, 1)),
        material=fm.Material(name="Py2", Ms=1, A=1, alpha=0.1),
    )
    with pytest.raises(ValueError, match="object_id"):
        unnamed.freeze_spins(id="must_fail")


def test_defaults_and_strict_from_ir_are_canonical() -> None:
    geometric = fm.FrozenSpins(
        id="geometric", selector=fm.select.in_object("free_layer")
    )
    assert geometric.to_ir()["membership"] == {"kind": "static"}
    assert geometric.to_ir()["reference"] == {"kind": "capture_current_at_activation"}
    assert geometric.to_ir()["activation"] == {"kind": "all_stages"}
    state = fm.FrozenSpins(id="state", selector=fm.select.m.z > 0.5)
    assert state.to_ir()["membership"] == {"kind": "snapshot_at_activation"}
    with pytest.raises(ValueError, match="frozen_membership_static_state_dependent"):
        fm.FrozenSpins(id="invalid", selector=fm.select.m.z > 0.5, membership="static")
    payload = geometric.to_ir()
    payload["unknown"] = True
    with pytest.raises(ValueError, match="unknown"):
        fm.FrozenSpins.from_ir(payload)
    payload = geometric.to_ir()
    payload["membership"]["unknown"] = True
    with pytest.raises(ValueError, match="membership has unknown fields"):
        fm.FrozenSpins.from_ir(payload)


def test_stage_constraints_lower_to_one_top_level_definition_with_stage_ids() -> None:
    source = """
        import fullmag as fm
        study = fm.study("stage frozen spins")
        study.engine("fdm")
        magnet = study.geometry(
            fm.Box(size=(100e-9, 50e-9, 3e-9)),
            name="User-facing layer",
            object_id="free_layer",
        )
        magnet.Ms = 800e3
        magnet.Aex = 13e-12
        frozen = fm.FrozenSpins(
            id="whole_layer",
            selector=fm.select.in_object(magnet),
        )
        study.stages.add_relax(
            stage_id="relax", max_steps=1, dt=1e-15, constraints=[frozen]
        )
        study.stages.add_run(
            stage_id="run", until=1e-12, constraints=[frozen]
        )
    """
    with TemporaryDirectory() as temporary_directory:
        path = Path(temporary_directory) / "study.py"
        path.write_text(textwrap.dedent(source), encoding="utf-8")
        loaded = fm.load_problem_from_script(path, lightweight_assets=True)
        ir = loaded.to_ir(
            requested_backend=None,
            execution_mode=None,
            execution_precision=None,
            include_geometry_assets=False,
        )

    assert len(ir["magnetization_constraints"]) == 1
    assert ir["magnetization_constraints"][0]["activation"] == {
        "kind": "stage_ids",
        "stage_ids": ["relax", "run"],
    }


@pytest.mark.parametrize(
    ("rejected_call", "expected_exception", "expected_error"),
    [
        (
            "study.stages.add_run(stage_id='rejected', until=-1, constraints=[frozen])",
            "ValueError",
            "positive stop time",
        ),
        (
            "study.stages.add_relax(stage_id='rejected', max_steps=1, constraints=[frozen])",
            "ValueError",
            "explicit fixed or complete adaptive timestep policy",
        ),
        (
            "study.stages.add_run(until=1e-12, table_autosave=object(), constraints=[frozen])",
            "TypeError",
            "legacy table_autosave",
        ),
        (
            "study.stages.add_run(until=1e-12, table_autosave=False, outputs=[object()], constraints=[frozen])",
            "TypeError",
            "legacy Run outputs",
        ),
        (
            "study.stages.add_run(until=1e-12, table_autosave=False, constraints=[invalid_frozen])",
            "ValueError",
            "selection_unknown_object",
        ),
        (
            "reject_output_every_warning(study, frozen)",
            "DeprecationWarning",
            "legacy output_every",
        ),
    ],
)
def test_rejected_stage_does_not_register_or_mutate_constraint_activation(
    rejected_call: str, expected_exception: str, expected_error: str
) -> None:
    source = f"""
        import fullmag as fm
        import warnings

        def reject_output_every_warning(study, frozen):
            with warnings.catch_warnings():
                warnings.filterwarnings(
                    "ignore",
                    message="Run-local sampling.*",
                    category=DeprecationWarning,
                )
                warnings.filterwarnings(
                    "error",
                    message="legacy output_every.*",
                    category=DeprecationWarning,
                )
                study.stages.add_run(
                    until=1e-12,
                    table_autosave=False,
                    output_every=1e-13,
                    constraints=[frozen],
                )

        study = fm.study("rejected frozen spins stage")
        study.engine("fdm")
        magnet = study.geometry(
            fm.Box(size=(100e-9, 50e-9, 3e-9)),
            name="User-facing layer",
            object_id="free_layer",
        )
        magnet.Ms = 800e3
        magnet.Aex = 13e-12
        frozen = fm.FrozenSpins(
            id="whole_layer",
            selector=fm.select.in_object(magnet),
        )
        invalid_frozen = fm.FrozenSpins(
            id="missing_layer",
            selector=fm.select.in_object("missing"),
        )
        try:
            {rejected_call}
        except (DeprecationWarning, TypeError, ValueError) as error:
            assert type(error).__name__ == {expected_exception!r}
            assert {expected_error!r} in str(error)
        else:
            raise AssertionError("invalid stage must be rejected")
        assert frozen.activation == {{"kind": "all_stages"}}
        assert invalid_frozen.activation == {{"kind": "all_stages"}}
        study.stages.add_run(
            stage_id="accepted", until=1e-12, constraints=[frozen]
        )
    """
    with TemporaryDirectory() as temporary_directory:
        path = Path(temporary_directory) / "study.py"
        path.write_text(textwrap.dedent(source), encoding="utf-8")
        loaded = fm.load_problem_from_script(path, lightweight_assets=True)
        ir = loaded.to_ir(
            requested_backend=None,
            execution_mode=None,
            execution_precision=None,
            include_geometry_assets=False,
        )

    assert ir["magnetization_constraints"][0]["activation"] == {
        "kind": "stage_ids",
        "stage_ids": ["accepted"],
    }
    nodes = ir["problem_meta"]["runtime_metadata"]["study_pipeline"]["nodes"]
    assert [node["id"] for node in nodes] == ["accepted"]


def test_rejected_legacy_run_configuration_does_not_append_ghost_action() -> None:
    source = """
        import fullmag as fm
        study = fm.study("rejected legacy run configuration")
        study.engine("fdm")
        magnet = study.geometry(
            fm.Box(size=(100e-9, 50e-9, 3e-9)),
            name="User-facing layer",
            object_id="free_layer",
        )
        magnet.Ms = 800e3
        magnet.Aex = 13e-12
        bad = fm.FrozenSpins(
            id="bad",
            selector=fm.select.in_object("missing"),
        )
        try:
            study.stages.add_run(
                until=1e-12,
                table_autosave=False,
                constraints=[bad],
            )
        except ValueError as error:
            assert "selection_unknown_object" in str(error)
        else:
            raise AssertionError("invalid constraints must be rejected")
        assert bad.activation == {"kind": "all_stages"}
        study.stages.add_run(stage_id="accepted", until=1e-12)
    """
    with TemporaryDirectory() as temporary_directory:
        path = Path(temporary_directory) / "study.py"
        path.write_text(textwrap.dedent(source), encoding="utf-8")
        loaded = fm.load_problem_from_script(path, lightweight_assets=True)
        ir = loaded.to_ir(
            requested_backend=None,
            execution_mode=None,
            execution_precision=None,
            include_geometry_assets=False,
        )

    nodes = ir["problem_meta"]["runtime_metadata"]["study_pipeline"]["nodes"]
    assert [node["id"] for node in nodes] == ["accepted"]
    assert ir["magnetization_constraints"] == []


def test_problem_rejects_duplicate_and_missing_constraint_references() -> None:
    duplicate = fm.FrozenSpins(
        id="duplicate", selector=fm.select.in_object("free_layer")
    )
    with pytest.raises(ValueError, match="duplicate magnetization constraint id"):
        _problem(
            region_constraints=False,
            constraints=[duplicate, duplicate],
        )
    with pytest.raises(ValueError, match="selection_unknown_object"):
        _problem(
            region_constraints=False,
            constraints=[
                fm.FrozenSpins(
                    id="missing", selector=fm.select.in_object("not_an_object")
                )
            ],
        )
    with pytest.raises(
        ValueError, match="activation stage id 'missing' does not exist"
    ):
        _problem(
            region_constraints=False,
            constraints=[
                fm.FrozenSpins(
                    id="missing_stage",
                    selector=fm.select.in_object("free_layer"),
                    stage_ids=["missing"],
                )
            ],
        )


def test_problem_rejects_duplicate_named_selection_ids() -> None:
    first = fm.SelectionDefinition(
        selection_id="duplicate",
        expression=fm.select.in_object("free_layer"),
    )
    second = fm.SelectionDefinition(
        selection_id="duplicate",
        expression=fm.select.all_magnetic(),
    )

    with pytest.raises(ValueError, match="selection ids.*duplicate"):
        _problem(region_constraints=False, selections=[first, second])


def test_problem_rejects_named_selection_cycles_without_recursion_error() -> None:
    selections = [
        fm.SelectionDefinition(
            selection_id="a",
            expression=fm.Selection.from_ir({"kind": "ref", "selection_id": "b"}),
        ),
        fm.SelectionDefinition(
            selection_id="b",
            expression=fm.Selection.from_ir({"kind": "ref", "selection_id": "a"}),
        ),
    ]
    constraint = fm.FrozenSpins(
        id="cyclic",
        selector=fm.Selection.from_ir({"kind": "ref", "selection_id": "a"}),
    )

    with pytest.raises(ValueError, match="selection_reference_cycle"):
        _problem(
            region_constraints=False,
            selections=selections,
            constraints=[constraint],
        )


def test_frozen_spins_source_map_covers_implemented_authoring_and_ir_symbols() -> None:
    repository_root = Path(__file__).resolve().parents[3]
    source_map = json.loads(
        (
            repository_root
            / "docs/physics/0996-frozen-spins-constraint.source-map.json"
        ).read_text(encoding="utf-8")
    )
    sources = {(source["path"], source["symbol"]) for source in source_map["sources"]}

    assert (
        "crates/fullmag-ir/src/constraint.rs",
        "frozen_spins",
    ) in sources
    assert (
        "crates/fullmag-ir/src/constraint.rs",
        "normalize_frozen_membership_defaults_in_problem_value",
    ) in sources
    assert (
        "packages/fullmag-py/src/fullmag/model/constraints.py",
        "class FrozenSpins",
    ) in sources
    assert (
        "packages/fullmag-py/src/fullmag/world.py",
        "class StudyStagesBuilder",
    ) in sources

    physics_note = (
        repository_root / "docs/physics/0996-frozen-spins-constraint.md"
    ).read_text(encoding="utf-8")
    assert "StudyStagesBuilder._merge_constraints" in physics_note
    assert "StudyStagesBuilder._register_constraints" not in physics_note
