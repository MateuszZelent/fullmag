from __future__ import annotations

import copy
from pathlib import Path
import re

import fullmag as fm
import fullmag.world as world
import pytest
from fullmag.model import BackendTarget, ExecutionMode, ExecutionPrecision
from fullmag.runtime.loader import load_problem_from_script
from fullmag.runtime.scene_document import (
    build_builder_from_scene_document,
    build_scene_document_from_builder,
    builder_overrides_from_scene_document,
)
from fullmag.runtime.scene_document_ir import scene_document_to_problem_ir
from fullmag.runtime.script_builder import (
    export_builder_draft,
    render_loaded_problem_as_script,
    render_scene_document_as_script,
)


@pytest.fixture(autouse=True)
def _reset_world() -> None:
    fm.reset()
    yield
    fm.reset()


def _profile() -> fm.ExecutionProfile:
    return fm.ExecutionProfile(
        "exec:portable",
        "v3",
        description="portable authoring profile",
        defaults=fm.ExecutionOverrides(
            backend="fem",
            device="cpu",
            precision="single",
            mode="extended",
            resources=fm.ComputeResourceOverrides(
                cpu=fm.CpuResourceOverrides(threads="auto", core_policy=None),
                gpu=None,
                ram=fm.MemoryResourceOverrides(reservation_bytes=None),
            ),
        ),
    )


def _layer() -> fm.ExecutionRequestLayer:
    return fm.ExecutionRequestLayer(
        kind="step",
        location="study.steps.relax",
        request=fm.ExecutionOverrides(
            device="auto",
            resources=fm.ComputeResourceOverrides(
                cpu=fm.CpuResourceOverrides(threads="auto", numa_node=None),
                ram=fm.MemoryResourceOverrides(reservation_bytes=None),
                gpu=None,
            ),
        ),
    )


def _profile_call() -> str:
    return (
        "study.execution_profile("
        f"fm.ExecutionProfile.from_ir({_profile().to_ir()!r}), "
        f"layers=[fm.ExecutionRequestLayer.from_ir({_layer().to_ir()!r})])"
    )


def _write_study_script(path: Path, *, include_run: bool = True) -> Path:
    run_line = "study.run(1e-9)\n" if include_run else ""
    path.write_text(
        "import fullmag as fm\n"
        "study = fm.study('profile-scene')\n"
        f"{_profile_call()}\n"
        "film = study.geometry(fm.Box(200e-9, 20e-9, 6e-9), name='film')\n"
        "film.Ms = 800000\n"
        "film.Aex = 13e-12\n"
        "film.m = fm.texture.uniform(1, 0, 0)\n"
        + run_line,
        encoding="utf-8",
    )
    return path


def _assert_profile_metadata(metadata: dict[str, object]) -> None:
    assert metadata["execution_profile"] == _profile().to_ir()
    assert metadata["execution_layers"] == [_layer().to_ir()]


def test_execution_request_layer_roundtrips_sparse_auto_and_null() -> None:
    wire = _layer().to_ir()

    assert fm.ExecutionRequestLayer.from_ir(wire).to_ir() == wire
    request = wire["request"]
    assert "backend" not in request
    assert request["device"] == "auto"
    assert request["resources"]["cpu"]["threads"] == "auto"
    assert request["resources"]["cpu"]["numa_node"] is None
    assert request["resources"]["ram"]["reservation_bytes"] is None
    assert request["resources"]["gpu"] is None


def test_execution_request_layer_omitted_request_matches_rust_default() -> None:
    origin = {"kind": "study", "location": "scene.study"}
    assert fm.ExecutionRequestLayer.from_ir({"origin": origin}).to_ir() == {
        "origin": origin,
        "request": {},
    }
    with pytest.raises((TypeError, ValueError)):
        fm.ExecutionRequestLayer.from_ir({"origin": origin, "request": None})


@pytest.mark.parametrize(
    "wire",
    [
        {"origin": {"kind": "study", "location": "source"}, "request": {}, "extra": 1},
        {
            "origin": {"kind": "study", "location": "source", "extra": 1},
            "request": {},
        },
        {"origin": {"kind": "study", "location": "source"}, "request": []},
    ],
    ids=["unknown-layer-field", "unknown-origin-field", "wrong-request-shape"],
)
def test_execution_request_layer_from_ir_rejects_invalid_shape(wire) -> None:
    with pytest.raises((TypeError, ValueError)):
        fm.ExecutionRequestLayer.from_ir(wire)


@pytest.mark.parametrize(
    "kind,location",
    [
        ("unknown", "script.py"),
        ("study", ""),
        ("study", "  "),
        ("study", "line\nfeed"),
        ("study", "é" * 2049),
    ],
    ids=["unknown-kind", "empty-location", "blank-location", "control", "byte-limit"],
)
def test_execution_request_layer_rejects_invalid_origin(kind: str, location: str) -> None:
    with pytest.raises((TypeError, ValueError)):
        fm.ExecutionRequestLayer(kind=kind, location=location)


def test_execution_request_layer_location_uses_utf8_byte_limit() -> None:
    layer = fm.ExecutionRequestLayer(kind="study", location="é" * 2048)
    assert len(layer.location.encode("utf-8")) == 4096


@pytest.mark.parametrize(
    "select",
    [
        pytest.param(lambda study: study.engine("auto"), id="explicit-auto-backend"),
        pytest.param(lambda study: study.device("auto"), id="explicit-auto-device"),
        pytest.param(lambda study: study.device("cpu", precision="double"), id="precision"),
        pytest.param(lambda study: study.mode("strict"), id="mode"),
        pytest.param(lambda study: study.threads(1), id="threads"),
        pytest.param(lambda study: study.resources(fm.ComputeResources()), id="resources"),
    ],
)
def test_profile_rejects_prior_legacy_execution_selection(select) -> None:
    study = fm.study("profile-selection-conflict")
    select(study)

    with pytest.raises(ValueError, match="execution_profile_selection_conflict"):
        study.execution_profile(_profile())


def test_profile_rejects_later_legacy_selection_and_reset_clears_guard() -> None:
    study = fm.study("profile-selection-conflict")
    study.execution_profile(_profile())
    with pytest.raises(ValueError, match="execution_profile_selection_conflict"):
        study.engine("auto")

    fm.reset()
    reset_study = fm.study("profile-selection-reset")
    reset_study.execution_profile(_profile())
    assert world._state._extra_runtime_metadata["execution_profile"] == _profile().to_ir()
    assert "execution_layers" not in world._state._extra_runtime_metadata


def test_empty_layers_are_omitted_when_a_profile_is_replaced() -> None:
    study = fm.study("profile-layers-omission")
    study.execution_profile(_profile(), layers=[_layer()])
    assert world._state._extra_runtime_metadata["execution_layers"] == [_layer().to_ir()]

    study.execution_profile(_profile())
    assert "execution_layers" not in world._state._extra_runtime_metadata


def test_profile_and_change_device_stage_are_rejected_in_both_orders() -> None:
    study = fm.study("profile-stage-conflict")
    study.execution_profile(_profile())
    with pytest.raises(ValueError, match="execution_profile_change_device_stage_conflict"):
        study.stages.change_device("cpu")

    fm.reset()
    study = fm.study("profile-stage-conflict")
    film = study.geometry(fm.Box(20e-9, 10e-9, 5e-9), name="film")
    film.Ms = 800000
    film.Aex = 13e-12
    film.m = fm.texture.uniform(1, 0, 0)
    study.stages.change_device("auto")
    with pytest.raises(ValueError, match="execution_profile_change_device_stage_conflict"):
        study.execution_profile(_profile())


def test_profile_roundtrips_through_deferred_ir_scene_and_script(tmp_path: Path) -> None:
    source = _write_study_script(tmp_path / "profile_source.py")
    loaded = load_problem_from_script(source, lightweight_assets=True)

    assert loaded.stages
    assert loaded.problem.runtime.backend_target.value == "auto"
    assert loaded.problem.runtime.device_target.value == "auto"
    _assert_profile_metadata(loaded.problem.runtime_metadata)

    problem_ir = loaded.to_ir(
        requested_backend=BackendTarget.FEM,
        execution_mode=ExecutionMode.EXTENDED,
        execution_precision=ExecutionPrecision.SINGLE,
        include_geometry_assets=False,
        source_root=tmp_path,
        runtime_device_override="cpu",
    )
    _assert_profile_metadata(problem_ir["problem_meta"]["runtime_metadata"])
    assert problem_ir["backend_policy"]["requested_backend"] == "fem"
    assert problem_ir["backend_policy"]["execution_precision"] == "single"
    assert problem_ir["validation_profile"]["execution_mode"] == "extended"
    runtime_metadata = problem_ir["problem_meta"]["runtime_metadata"]
    assert runtime_metadata["runtime_selection"]["device"] == "auto"
    assert runtime_metadata["runtime_device_override"] == {
        "device": "cpu",
        "source": "managed_launcher",
    }

    builder = export_builder_draft(loaded)
    assert builder["execution_profile"] == _profile().to_ir()
    assert builder["execution_layers"] == [_layer().to_ir()]
    scene = build_scene_document_from_builder(builder)
    assert scene["study"]["execution_profile"] == _profile().to_ir()
    assert scene["study"]["execution_layers"] == [_layer().to_ir()]
    projected_builder = build_builder_from_scene_document(scene)
    assert projected_builder["execution_profile"] == _profile().to_ir()
    assert projected_builder["execution_layers"] == [_layer().to_ir()]
    assert builder_overrides_from_scene_document(scene)["execution_profile"] == _profile().to_ir()

    script = render_loaded_problem_as_script(loaded)
    assert "study.execution_profile(fm.ExecutionProfile.from_ir(" in script
    assert not re.search(r"^\s*study\.(engine|device|mode|threads)\(", script, re.MULTILINE)
    assert "study.geometry(" in script
    rendered_path = tmp_path / "profile_rendered.py"
    rendered_path.write_text(script, encoding="utf-8")
    rendered_loaded = load_problem_from_script(rendered_path, lightweight_assets=True)
    _assert_profile_metadata(rendered_loaded.problem.runtime_metadata)

    scene_script = render_scene_document_as_script(scene)
    assert "study.execution_profile(fm.ExecutionProfile.from_ir(" in scene_script
    assert not re.search(
        r"^\s*study\.(engine|device|mode|threads)\(", scene_script, re.MULTILINE
    )
    captured_scene = copy.deepcopy(scene)
    scene_ir = scene_document_to_problem_ir(
        scene,
        requested_backend="fdm",
        requested_device="cpu",
        requested_precision="double",
        requested_mode="strict",
        source_root=tmp_path,
    )
    _assert_profile_metadata(scene_ir["problem_meta"]["runtime_metadata"])
    assert "execution_materialization" not in scene_ir["problem_meta"]["runtime_metadata"]
    assert scene == captured_scene


def test_direct_solver_execution_with_profile_requires_shared_materialization() -> None:
    study = fm.study("profile-direct-execution")
    film = study.geometry(fm.Box(20e-9, 10e-9, 5e-9), name="film")
    film.Ms = 800000
    film.Aex = 13e-12
    film.m = fm.texture.uniform(1, 0, 0)
    study.execution_profile(_profile())

    with pytest.raises(RuntimeError, match="execution_profile_requires_shared_materialization"):
        study.run(1e-9)


def test_profile_cannot_be_declared_after_script_solver_stage_capture(tmp_path: Path) -> None:
    source = tmp_path / "profile_after_stage.py"
    source.write_text(
        "import fullmag as fm\n"
        "study = fm.study('profile-after-stage')\n"
        "film = study.geometry(fm.Box(20e-9, 10e-9, 5e-9), name='film')\n"
        "film.Ms = 800000\n"
        "film.Aex = 13e-12\n"
        "film.m = fm.texture.uniform(1, 0, 0)\n"
        "study.run(1e-9)\n"
        f"{_profile_call()}\n",
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="execution_profile_order_conflict"):
        load_problem_from_script(source, lightweight_assets=True)


def test_legacy_no_profile_scene_fields_remain_omitted(tmp_path: Path) -> None:
    source = tmp_path / "legacy_profile_free.py"
    source.write_text(
        "import fullmag as fm\n"
        "study = fm.study('legacy-profile-free')\n"
        "study.engine('fdm')\n"
        "film = study.geometry(fm.Box(20e-9, 10e-9, 5e-9), name='film')\n"
        "film.Ms = 800000\n"
        "film.Aex = 13e-12\n"
        "film.m = fm.texture.uniform(1, 0, 0)\n",
        encoding="utf-8",
    )
    loaded = load_problem_from_script(source, lightweight_assets=True)
    scene = build_scene_document_from_builder(export_builder_draft(loaded))

    assert "execution_profile" not in scene["study"]
    assert "execution_layers" not in scene["study"]
    assert re.search(
        r"^\s*study\.engine\(",
        render_loaded_problem_as_script(loaded),
        re.MULTILINE,
    )
