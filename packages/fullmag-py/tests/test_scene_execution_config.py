from __future__ import annotations

import contextlib
import copy
import io
import json
from pathlib import Path
import tempfile

import fullmag as fm
import fullmag.world as world
import fullmag.model.problem as problem_model
import pytest
from fullmag.model.constraints import FrozenSpins
from fullmag.model.selection import SelectionDefinition
from fullmag.runtime import helper as runtime_helper
from fullmag.runtime.scene_document import build_scene_document_from_builder
from fullmag.runtime.scene_document_ir import (
    scene_document_to_execution_config,
    scene_document_to_problem_ir,
)
from fullmag.runtime.script_builder import export_builder_draft
from fullmag.runtime.script_builder import render_scene_document_as_script
from fullmag.runtime.loader import load_problem_from_script


def _authored_scene(tmp_path: Path) -> dict[str, object]:
    profile = fm.ExecutionProfile(
        "execution:scene-config",
        "v7",
        defaults=fm.ExecutionOverrides(
            backend="fdm",
            device="auto",
            precision="single",
            mode="extended",
        ),
    )
    layer = fm.ExecutionRequestLayer(
        kind="step",
        location="study.stages.relax-first",
        request=fm.ExecutionOverrides(device="auto"),
    )
    script_path = tmp_path / "authoring.py"
    script_path.write_text(
        "import fullmag as fm\n"
        "study = fm.study('scene-config-test')\n"
        f"study.execution_profile(fm.ExecutionProfile.from_ir({profile.to_ir()!r}), "
        f"layers=[fm.ExecutionRequestLayer.from_ir({layer.to_ir()!r})])\n"
        "film = study.geometry(fm.Box(2e-8, 2e-8, 1e-8), name='film', object_id='film')\n"
        "film.Ms = 800000\n"
        "film.Aex = 13e-12\n"
        "film.alpha = 0.1\n"
        "film.m = fm.texture.uniform(1, 0, 0)\n"
        "study.solver(integrator='rk45', fix_dt=1e-13)\n"
        "study.stages.add_relax(stage_id='relax-first', max_steps=11, "
        "max_relaxation_time_s=1e-12, solver='heun', dt=5e-14)\n"
        "study.stages.add_save_state(artifact_name='before-run')\n"
        "study.solver(integrator='rk45', fix_dt=1e-13)\n"
        "study.stages.add_run(2e-12, stage_id='run-second')\n"
        "study.solver(integrator='heun', fix_dt=2e-13)\n"
        "study.stages.add_run(3e-12, stage_id='run-third')\n",
        encoding="utf-8",
    )
    loaded = load_problem_from_script(script_path, lightweight_assets=True)
    scene = build_scene_document_from_builder(export_builder_draft(loaded))

    for stage in scene["study"]["stages"]:
        if stage.get("kind") == "run":
            stage["until_seconds"] = (
                2e-12 if stage.get("stage_id") == "run-second" else 3e-12
            )
    for node in scene["study"]["study_pipeline"]["nodes"]:
        if node.get("stage_kind") == "run":
            node["payload"]["until_seconds"] = (
                2e-12 if node["id"] == "run-second" else 3e-12
            )

    scene["study"]["output_storage"] = {
        "output_dir": "results",
        "temp_dir": "temporary",
        "data_format": "zarr",
        "cleanup": "on_success",
        "existing_output": "timestamp",
    }
    pipeline = scene["study"]["study_pipeline"]
    pipeline["nodes"] = [
        {
            "id": "stage-group",
            "label": "Captured stages",
            "enabled": True,
            "node_kind": "group",
            "children": pipeline["nodes"],
        }
    ]
    selection = SelectionDefinition.from_ir(
        {
            "schema_version": "selection_expr.v1",
            "id": "film-selection",
            "name": "Film",
            "expression": {"kind": "in_object", "object_id": "film"},
        }
    )
    constraint = FrozenSpins.from_ir(
        {
            "kind": "frozen_spins",
            "schema_version": "frozen_spins.v1",
            "id": "frozen-film",
            "name": "Frozen film",
            "selector": {"kind": "ref", "selection_id": "film-selection"},
        }
    )
    scene["selections"] = [selection.to_ir()]
    scene["magnetization_constraints"] = [
        constraint.to_ir(selections=[selection])
    ]
    return scene


def _assert_annotations(ir: dict[str, object], scene: dict[str, object]) -> None:
    runtime_metadata = ir["problem_meta"]["runtime_metadata"]
    assert runtime_metadata["execution_profile"] == scene["study"]["execution_profile"]
    assert runtime_metadata["execution_layers"] == scene["study"]["execution_layers"]
    assert runtime_metadata["output_storage"] == scene["study"]["output_storage"]
    assert ir["selections"] == scene["selections"]
    assert ir["magnetization_constraints"] == scene["magnetization_constraints"]
    assert "execution_materialization" not in runtime_metadata


def test_scene_capture_exports_shared_stage_config_without_execution(tmp_path, monkeypatch):
    scene = _authored_scene(tmp_path)
    original_scene = copy.deepcopy(scene)
    source_root = tmp_path / "project"
    source_root.mkdir()

    def forbidden_solver(*args, **kwargs):
        pytest.fail("scene config export must not start a solver")

    monkeypatch.setattr(world, "run", forbidden_solver)
    config = scene_document_to_execution_config(
        scene,
        requested_backend="fdm",
        requested_device="auto",
        requested_precision="single",
        requested_mode="extended",
        source_root=source_root,
    )

    assert scene == original_scene
    assert set(config) == {
        "ir",
        "shared_geometry_assets",
        "default_until_seconds",
        "study_pipeline",
        "stages",
    }
    assert config["stages"] == []

    _assert_annotations(config["ir"], scene)
    nodes = config["study_pipeline"]["nodes"][0]["children"]
    assert [node["stage_kind"] for node in nodes] == ["relax", "save_state", "run", "run"]
    assert [node["payload"]["stage_id"] for node in nodes] == [
        "relax-first",
        "save_state-1",
        "run-second",
        "run-third",
    ]
    assert nodes[0]["payload"]["integrator"] == "heun"
    assert nodes[0]["payload"]["max_steps"] == "11"
    assert nodes[1]["payload"]["artifact_name"] == "before-run"
    assert nodes[2]["payload"]["until_seconds"] == 2e-12
    assert nodes[2]["payload"]["integrator"] == "rk45"
    assert nodes[2]["payload"]["fixed_timestep"] == "1e-13"
    assert nodes[3]["payload"]["until_seconds"] == 3e-12
    assert nodes[3]["payload"]["integrator"] == "heun"
    assert nodes[3]["payload"]["fixed_timestep"] == "2e-13"
    assert config["study_pipeline"]["nodes"][0]["node_kind"] == "group"
    assert config["study_pipeline"]["nodes"][0]["id"] == "stage-group"
    assert config["ir"]["problem_meta"]["runtime_metadata"]["study_pipeline"] == config["study_pipeline"]
    runtime_metadata = config["ir"]["problem_meta"]["runtime_metadata"]
    assert runtime_metadata["output_storage_source_dir"] == str(source_root.resolve())
    assert "execution_materialization" not in runtime_metadata
    assert not (source_root / "results").exists()


def test_scene_without_pipeline_captures_concrete_stage_ir_order_and_timing(tmp_path):
    scene = _authored_scene(tmp_path)
    scene["study"].pop("study_pipeline")
    original_scene = copy.deepcopy(scene)

    config = scene_document_to_execution_config(
        scene,
        requested_backend="fdm",
        requested_device="auto",
        requested_precision="single",
        requested_mode="extended",
        source_root=tmp_path,
    )
    repeated = scene_document_to_execution_config(
        scene,
        requested_backend="fdm",
        requested_device="auto",
        requested_precision="single",
        requested_mode="extended",
        source_root=tmp_path,
    )

    assert repeated == config
    assert scene == original_scene
    assert "fullmag-scene-problem-ir-" not in json.dumps(config)
    assert [node["stage_kind"] for node in config["study_pipeline"]["nodes"]] == [
        "relax",
        "save_state",
        "run",
        "run",
    ]
    stages = config["stages"]
    assert [stage["entrypoint_kind"] for stage in stages] == [
        "flat_relax",
        "flat_save_state",
        "flat_run",
        "flat_run",
    ]
    stage_metadata = [stage["ir"]["problem_meta"]["runtime_metadata"] for stage in stages]
    root_metadata = config["ir"]["problem_meta"]["runtime_metadata"]
    assert root_metadata["execution_profile"] == scene["study"]["execution_profile"]
    assert root_metadata["execution_layers"] == scene["study"]["execution_layers"]
    assert "execution_materialization" not in root_metadata
    assert [metadata["active_stage_id"] for metadata in stage_metadata] == [
        "relax-first",
        "save_state-1",
        "run-second",
        "run-third",
    ]
    assert [metadata["stage_start_time_s"] for metadata in stage_metadata] == [
        0.0,
        0.0,
        0.0,
        2e-12,
    ]
    assert stages[0]["ir"]["study"]["dynamics"]["integrator"] == "heun"
    assert stages[0]["ir"]["study"]["dynamics"]["fixed_timestep"] == 5e-14
    assert stages[1]["action"]["kind"] == "save_state"
    assert stages[1]["action"]["artifact_name"] == "before-run"
    assert stages[2]["ir"]["study"]["dynamics"]["integrator"] == "rk45"
    assert stages[2]["ir"]["study"]["dynamics"]["fixed_timestep"] == 1e-13
    assert stages[3]["ir"]["study"]["dynamics"]["integrator"] == "heun"
    assert stages[3]["ir"]["study"]["dynamics"]["fixed_timestep"] == 2e-13
    assert all(
        metadata["output_storage_source_dir"] == str(tmp_path.resolve())
        and "execution_materialization" not in metadata
        and metadata["execution_profile"] == scene["study"]["execution_profile"]
        and metadata["execution_layers"] == scene["study"]["execution_layers"]
        for metadata in stage_metadata
    )

    rendered_scene = render_scene_document_as_script(scene)
    for stage_call in (
        'stage_id="relax-first"',
        'stage_id="run-second"',
        'stage_id="run-third"',
        "fm.save_state_stage",
        "solver=\"heun\"",
    ):
        assert stage_call in rendered_scene


def test_disabled_flat_scene_stage_stays_in_document_but_is_not_captured(tmp_path):
    scene = _authored_scene(tmp_path)
    scene["study"].pop("study_pipeline")
    scene["study"]["stages"][1]["enabled"] = False
    original_scene = copy.deepcopy(scene)

    config = scene_document_to_execution_config(
        scene,
        requested_backend="fdm",
        requested_device="auto",
        requested_precision="single",
        requested_mode="extended",
        source_root=tmp_path,
    )

    assert scene == original_scene
    assert scene["study"]["stages"][1]["enabled"] is False
    assert [
        stage["ir"]["problem_meta"]["runtime_metadata"]["active_stage_id"]
        for stage in config["stages"]
    ] == ["relax-first", "run-second", "run-third"]
    assert [
        stage["ir"]["problem_meta"]["runtime_metadata"]["stage_start_time_s"]
        for stage in config["stages"]
    ] == [0.0, 0.0, 2e-12]


def test_scene_execution_config_keeps_geometry_recipes_without_building_assets(
    tmp_path, monkeypatch
):
    def forbidden_geometry_asset_builder(*args, **kwargs):
        pytest.fail("Scene execution-config capture must not build geometry assets")

    monkeypatch.setattr(
        problem_model,
        "build_geometry_assets_for_request",
        forbidden_geometry_asset_builder,
    )

    pipeline_scene = _authored_scene(tmp_path)
    pipeline_config = scene_document_to_execution_config(
        pipeline_scene,
        requested_backend="fdm",
        requested_device="auto",
        requested_precision="single",
        requested_mode="extended",
        source_root=tmp_path,
    )

    flat_scene = _authored_scene(tmp_path)
    flat_scene["study"].pop("study_pipeline")
    flat_config = scene_document_to_execution_config(
        flat_scene,
        requested_backend="fdm",
        requested_device="auto",
        requested_precision="single",
        requested_mode="extended",
        source_root=tmp_path,
    )

    for config in (pipeline_config, flat_config):
        assert config["ir"]["geometry_assets"] is None
        assert config["shared_geometry_assets"] is None
        recipe = config["ir"]["problem_meta"]["runtime_metadata"][
            "model_builder"
        ]["problem"]["geometry"][0]
        assert recipe["kind"] == "box"
        assert recipe["size"] == [2e-8, 2e-8, 1e-8]
        for stage in config["stages"]:
            assert stage["ir"]["geometry_assets"] is None


def test_scene_single_ir_keeps_geometry_assets_omitted_and_scene_unmodified(tmp_path):
    scene = _authored_scene(tmp_path)
    original_scene = copy.deepcopy(scene)

    ir = scene_document_to_problem_ir(
        scene,
        requested_backend="fdm",
        requested_device="auto",
        requested_precision="single",
        requested_mode="extended",
        source_root=tmp_path,
    )

    assert scene == original_scene
    assert ir["geometry_assets"] is None
    _assert_annotations(ir, scene)
    # The temporary capture script is not an authored output basename.
    assert "output_storage_source_stem" not in ir["problem_meta"]["runtime_metadata"]
    assert ir["problem_meta"]["name"] == scene["scene"]["name"] == "scene-config-test"


def test_scene_pipeline_macro_remains_owned_by_shared_materializer(tmp_path):
    scene = _authored_scene(tmp_path)
    macro = {
        "id": "relax-run-macro",
        "label": "Relax then run",
        "enabled": True,
        "node_kind": "macro",
        "macro_kind": "relax_run",
        "config": {
            "max_steps": 7,
            "torque_tolerance": 1e-5,
            "integrator": "heun",
            "fixed_timestep": 1e-13,
            "run_until_seconds": 4e-12,
        },
    }
    scene["study"]["study_pipeline"]["nodes"].append(macro)

    config = scene_document_to_execution_config(
        scene,
        requested_backend="fdm",
        requested_device="auto",
        requested_precision="single",
        requested_mode="extended",
        source_root=tmp_path,
    )

    assert config["stages"] == []
    assert config["study_pipeline"]["nodes"][-1] == macro
    with pytest.raises(ValueError, match="scene_document_macro_requires_shared_study_pipeline_materializer"):
        render_scene_document_as_script(scene)


def test_scene_renderer_preserves_eigen_equilibrium_artifact(tmp_path):
    source = tmp_path / "eigen_scene.py"
    source.write_text(
        "import fullmag as fm\n"
        "study = fm.study('eigen-scene-test')\n"
        "body = study.geometry(fm.Box(2e-8, 2e-8, 1e-8), name='film')\n"
        "body.Ms = 800000\n"
        "body.Aex = 13e-12\n"
        "body.alpha = 0.1\n"
        "body.m = fm.texture.uniform(1, 0, 0)\n"
        "study.stages.add_eigenmodes(count=2, equilibrium_artifact='equilibrium-1')\n",
        encoding="utf-8",
    )
    loaded = load_problem_from_script(source, lightweight_assets=True)
    scene = build_scene_document_from_builder(export_builder_draft(loaded))

    rendered = render_scene_document_as_script(scene)
    assert 'equilibrium_artifact="equilibrium-1"' in rendered
    roundtrip_path = tmp_path / "eigen_scene_roundtrip.py"
    roundtrip_path.write_text(rendered, encoding="utf-8")
    roundtrip = load_problem_from_script(roundtrip_path, lightweight_assets=True)
    assert export_builder_draft(roundtrip)["stages"][0]["eigen_equilibrium_artifact"] == "equilibrium-1"


def test_scene_renderer_preserves_table_autosave_expressions_and_id(tmp_path):
    scene = _authored_scene(tmp_path)
    scene["study"]["stages"][0]["autosave"] = fm.StageAutosave(
        table=fm.TableAutosave(
            every_steps=7,
            quantities=("E_total",),
            expressions=("mx+my",),
            table_id="trace",
        )
    ).to_ir()

    rendered = render_scene_document_as_script(scene)
    assert "table_id=\"trace\"" in rendered
    assert "expressions=[\"mx+my\"]" in rendered

    roundtrip_path = tmp_path / "autosave_scene_roundtrip.py"
    roundtrip_path.write_text(rendered, encoding="utf-8")
    roundtrip = load_problem_from_script(roundtrip_path, lightweight_assets=True)
    autosave = export_builder_draft(roundtrip)["stages"][0]["autosave"]
    assert autosave["table"]["table_id"] == "trace"
    assert autosave["table"]["expressions"] == ["mx+my"]


def test_helper_exports_scene_execution_config_with_same_capture_arguments(tmp_path, monkeypatch):
    scene = _authored_scene(tmp_path)
    scene_path = tmp_path / "scene.json"
    scene_path.write_text(json.dumps(scene), encoding="utf-8")
    source_root = tmp_path / "project"
    source_root.mkdir()
    stdout = io.StringIO()
    stderr = io.StringIO()

    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        exit_code = runtime_helper.main(
            [
                "export-scene-config",
                "--scene-json",
                str(scene_path),
                "--backend",
                "fdm",
                "--device",
                "auto",
                "--precision",
                "single",
                "--mode",
                "extended",
                "--asset-root",
                str(source_root),
            ]
        )

    assert exit_code == 0
    payload = json.loads(stdout.getvalue())
    assert payload["stages"] == []
    assert payload["study_pipeline"]["nodes"][0]["node_kind"] == "group"
    assert payload["ir"]["problem_meta"]["runtime_metadata"]["output_storage_source_dir"] == str(source_root.resolve())
