from __future__ import annotations

from pathlib import Path

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


METADATA_KEY = "fem_gpu_pcg_control_experiment"
EXPERIMENT = {
    "schema_version": "fullmag.fem.gpu.pcg_control_experiment.v1",
    "status_batch_stride": 4,
}
SOLVER_POLICY = {
    "solver": "CG",
    "preconditioner": "AMG",
    "rtol": 3e-9,
    "atol": 7e-20,
    "max_iterations": 123,
    "print_level": 0,
}


def _load_fem_study(
    tmp_path: Path,
    *,
    device: str = "gpu",
    experiment: dict[str, object] | None = EXPERIMENT,
    extra_metadata: str = "",
):
    source = tmp_path / "fem_gpu_pcg_control_authoring.py"
    metadata_call = (
        f"fm.runtime_metadata({METADATA_KEY!r}, {experiment!r})\n"
        if experiment is not None
        else ""
    )
    source.write_text(
        f"""import fullmag as fm
study = fm.study('fem-gpu-pcg-control-roundtrip')
study.engine('fem')
study.device({device!r}, precision='double')
study.fem_demag_solver(
    solver='CG', preconditioner='AMG', rtol=3e-9, atol=7e-20,
    max_iterations=123, print_level=0,
)
film = study.geometry(fm.Box(20e-9, 10e-9, 2e-9, name='film'), name='film', object_id='film')
film.Ms = 800000
film.Aex = 13e-12
film.m = fm.texture.uniform(1, 0, 0)
"""
        + metadata_call
        + extra_metadata,
        encoding="utf-8",
    )
    return load_problem_from_script(source, lightweight_assets=True)


def _problem_ir(loaded, tmp_path: Path, *, device: str = "gpu"):
    return loaded.to_ir(
        requested_backend=BackendTarget.FEM,
        execution_mode=ExecutionMode.STRICT,
        execution_precision=ExecutionPrecision.DOUBLE,
        include_geometry_assets=False,
        runtime_device_override=device,
        source_root=tmp_path,
    )


def _runtime(ir: dict[str, object]) -> dict[str, object]:
    return ir["problem_meta"]["runtime_metadata"]


def _assert_surrounding_solver_request(loaded) -> None:
    policy = loaded.problem.discretization.fem.demag_solver_policy
    assert policy is not None
    assert policy.rtol == pytest.approx(SOLVER_POLICY["rtol"])
    assert policy.atol == pytest.approx(SOLVER_POLICY["atol"])
    assert policy.max_iterations == SOLVER_POLICY["max_iterations"]
    assert loaded.problem.runtime.device_target.value == "gpu"
    assert loaded.problem.runtime.execution_precision.value == "double"


@pytest.mark.parametrize("stride", [4, 8])
def test_fem_gpu_pcg_control_experiment_survives_python_scene_and_ir_round_trip(
    tmp_path: Path,
    stride: int,
) -> None:
    experiment = {**EXPERIMENT, "status_batch_stride": stride}
    loaded = _load_fem_study(
        tmp_path,
        experiment=experiment,
        extra_metadata="fm.runtime_metadata('unrelated_marker', {'must_not_copy': True})\n",
    )
    direct_ir = _problem_ir(loaded, tmp_path)
    assert _runtime(direct_ir)[METADATA_KEY] == experiment
    assert _runtime(direct_ir)["runtime_selection"]["device"] == "gpu"

    draft = export_builder_draft(loaded)
    assert draft[METADATA_KEY] == experiment
    assert draft["requested_device"] == "gpu"
    assert draft["requested_precision"] == "double"
    assert draft["fem_demag_solver_policy"] == SOLVER_POLICY
    assert "unrelated_marker" not in draft

    scene = build_scene_document_from_builder(draft)
    assert scene["study"][METADATA_KEY] == experiment
    assert scene["study"]["requested_device"] == "gpu"
    assert scene["study"]["requested_precision"] == "double"
    assert scene["study"]["fem_demag_solver_policy"] == SOLVER_POLICY

    rebuilt = build_builder_from_scene_document(scene)
    assert rebuilt[METADATA_KEY] == experiment
    assert rebuilt["fem_demag_solver_policy"] == SOLVER_POLICY

    scene_ir = scene_document_to_problem_ir(
        scene,
        requested_backend="fem",
        requested_device="gpu",
        requested_precision="double",
        requested_mode="strict",
        source_root=tmp_path,
    )
    scene_runtime = _runtime(scene_ir)
    assert scene_runtime[METADATA_KEY] == experiment
    assert scene_runtime["runtime_selection"]["device"] == "gpu"
    assert "unrelated_marker" not in scene_runtime

    canonical_source = render_scene_document_as_script(scene)
    assert f"fm.runtime_metadata('{METADATA_KEY}'" in canonical_source
    canonical_path = tmp_path / "fem_gpu_pcg_control_canonical.py"
    canonical_path.write_text(canonical_source, encoding="utf-8")
    canonical_loaded = load_problem_from_script(
        canonical_path,
        lightweight_assets=True,
    )
    canonical_ir = _problem_ir(canonical_loaded, tmp_path)
    assert _runtime(canonical_ir)[METADATA_KEY] == experiment
    assert _runtime(canonical_ir)["runtime_selection"]["device"] == "gpu"
    assert "unrelated_marker" not in _runtime(canonical_ir)
    _assert_surrounding_solver_request(canonical_loaded)

    direct_source = render_loaded_problem_as_script(loaded)
    direct_path = tmp_path / "fem_gpu_pcg_control_direct_canonical.py"
    direct_path.write_text(direct_source, encoding="utf-8")
    direct_loaded = load_problem_from_script(direct_path, lightweight_assets=True)
    assert _runtime(_problem_ir(direct_loaded, tmp_path))[METADATA_KEY] == experiment
    _assert_surrounding_solver_request(direct_loaded)


def test_absent_fem_gpu_pcg_control_experiment_stays_absent_in_legacy_exports(
    tmp_path: Path,
) -> None:
    loaded = _load_fem_study(tmp_path, experiment=None)
    draft = export_builder_draft(loaded)
    assert METADATA_KEY not in draft

    scene = build_scene_document_from_builder(draft)
    assert METADATA_KEY not in scene["study"]
    rebuilt = build_builder_from_scene_document(scene)
    assert METADATA_KEY not in rebuilt
    scene_ir = scene_document_to_problem_ir(
        scene,
        requested_backend="fem",
        requested_device="gpu",
        requested_precision="double",
        requested_mode="strict",
        source_root=tmp_path,
    )
    assert METADATA_KEY not in _runtime(scene_ir)

    source = render_scene_document_as_script(scene)
    assert METADATA_KEY not in source
    canonical_path = tmp_path / "fem_gpu_pcg_control_absent.py"
    canonical_path.write_text(source, encoding="utf-8")
    canonical = load_problem_from_script(canonical_path, lightweight_assets=True)
    assert METADATA_KEY not in _runtime(_problem_ir(canonical, tmp_path))


def test_authored_null_fem_gpu_pcg_control_experiment_is_rejected(
    tmp_path: Path,
) -> None:
    source = tmp_path / "fem_gpu_pcg_control_authored_null.py"
    source.write_text(
        "import fullmag as fm\n"
        "study = fm.study('fem-gpu-pcg-control-authored-null')\n"
        "study.engine('fem')\n"
        "study.device('gpu', precision='double')\n"
        "film = study.geometry(fm.Box(20e-9, 10e-9, 2e-9, name='film'), name='film', object_id='film')\n"
        "film.Ms = 800000\n"
        "film.Aex = 13e-12\n"
        "film.m = fm.texture.uniform(1, 0, 0)\n"
        "fm.runtime_metadata('fem_gpu_pcg_control_experiment', None)\n",
        encoding="utf-8",
    )
    authored_null = load_problem_from_script(source, lightweight_assets=True)

    with pytest.raises(ValueError, match=METADATA_KEY):
        export_builder_draft(authored_null)
    with pytest.raises(ValueError, match=METADATA_KEY):
        render_loaded_problem_as_script(authored_null)


def test_explicit_null_scene_override_clears_loaded_fem_gpu_pcg_control_experiment(
    tmp_path: Path,
) -> None:
    loaded = _load_fem_study(tmp_path)
    cleared_source = render_loaded_problem_as_script(
        loaded,
        overrides={"runtime_selection": {METADATA_KEY: None}},
    )
    assert METADATA_KEY not in cleared_source
    cleared_path = tmp_path / "fem_gpu_pcg_control_cleared.py"
    cleared_path.write_text(cleared_source, encoding="utf-8")
    cleared = load_problem_from_script(cleared_path, lightweight_assets=True)
    assert METADATA_KEY not in _runtime(_problem_ir(cleared, tmp_path))

    scene = build_scene_document_from_builder(export_builder_draft(loaded))
    scene["study"][METADATA_KEY] = None
    overrides = builder_overrides_from_scene_document(scene)
    assert overrides[METADATA_KEY] is None
    scene_ir = scene_document_to_problem_ir(
        scene,
        requested_backend="fem",
        requested_device="gpu",
        requested_precision="double",
        requested_mode="strict",
        source_root=tmp_path,
    )
    assert METADATA_KEY not in _runtime(scene_ir)
    scene_source = render_scene_document_as_script(scene)
    scene_path = tmp_path / "fem_gpu_pcg_control_scene_cleared.py"
    scene_path.write_text(scene_source, encoding="utf-8")
    scene_cleared = load_problem_from_script(scene_path, lightweight_assets=True)
    assert METADATA_KEY not in _runtime(_problem_ir(scene_cleared, tmp_path))


def test_nested_runtime_selection_experiment_override_takes_precedence(
    tmp_path: Path,
) -> None:
    loaded = _load_fem_study(tmp_path)
    nested = {**EXPERIMENT, "status_batch_stride": 8}
    top_level = {**EXPERIMENT, "status_batch_stride": 4}
    source = render_loaded_problem_as_script(
        loaded,
        overrides={
            "runtime_selection": {METADATA_KEY: nested},
            METADATA_KEY: top_level,
        },
    )
    canonical_path = tmp_path / "fem_gpu_pcg_control_nested_override.py"
    canonical_path.write_text(source, encoding="utf-8")
    canonical = load_problem_from_script(canonical_path, lightweight_assets=True)
    assert _runtime(_problem_ir(canonical, tmp_path))[METADATA_KEY] == nested


def test_top_level_experiment_override_takes_precedence_over_loaded_metadata(
    tmp_path: Path,
) -> None:
    loaded = _load_fem_study(tmp_path)
    top_level = {**EXPERIMENT, "status_batch_stride": 8}
    source = render_loaded_problem_as_script(
        loaded,
        overrides={METADATA_KEY: top_level},
    )
    canonical_path = tmp_path / "fem_gpu_pcg_control_top_level_override.py"
    canonical_path.write_text(source, encoding="utf-8")
    canonical = load_problem_from_script(canonical_path, lightweight_assets=True)
    assert _runtime(_problem_ir(canonical, tmp_path))[METADATA_KEY] == top_level


@pytest.mark.parametrize(
    "invalid",
    [
        pytest.param("not-an-object", id="wrong-container"),
        pytest.param({}, id="missing-fields"),
        pytest.param(
            {**EXPERIMENT, "extra": True},
            id="unknown-field",
        ),
        pytest.param(
            {**EXPERIMENT, "schema_version": "future.v2"},
            id="schema-version",
        ),
        pytest.param({**EXPERIMENT, "status_batch_stride": True}, id="boolean-stride"),
        pytest.param({**EXPERIMENT, "status_batch_stride": 4.0}, id="float-stride"),
        pytest.param({**EXPERIMENT, "status_batch_stride": "4"}, id="string-stride"),
        pytest.param({**EXPERIMENT, "status_batch_stride": None}, id="null-stride"),
        pytest.param({**EXPERIMENT, "status_batch_stride": 3}, id="too-small-stride"),
        pytest.param(
            {**EXPERIMENT, "status_batch_stride": 16}, id="unsupported-stride"
        ),
    ],
)
def test_fem_gpu_pcg_control_experiment_rejects_invalid_values(
    tmp_path: Path,
    invalid: object,
) -> None:
    with pytest.raises(ValueError, match=METADATA_KEY):
        build_scene_document_from_builder(
            {
                "geometries": [],
                METADATA_KEY: invalid,
            }
        )

    scene = build_scene_document_from_builder({"geometries": []})
    scene["study"][METADATA_KEY] = invalid
    with pytest.raises(ValueError, match=METADATA_KEY):
        scene_document_to_problem_ir(
            scene,
            requested_backend="fem",
            requested_device="gpu",
            requested_precision="double",
            requested_mode="strict",
            source_root=tmp_path,
        )
