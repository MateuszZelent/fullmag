"""Per-run GPU BB policy stays in authoring/IR through canonical round trips."""
from pathlib import Path

import pytest
import fullmag as fm
from fullmag.runtime.script_builder import export_builder_draft, render_loaded_problem_as_script, render_scene_document_as_script
from fullmag.runtime.scene_document import build_scene_document_from_builder, build_builder_from_scene_document

SCRIPT = '''import fullmag as fm
study = fm.study("gpu_bb_policy")
study.engine("fem")
study.device("{device}", precision="double")
study.fem_bb_preconditioner({policy!r})
body = study.geometry(fm.Box(20e-9, 20e-9, 20e-9), name="body")
body.Ms = 800e3
body.Aex = 13e-12
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
body.mesh(maximum_element_size=20e-9, order=1)
study.relax(algorithm="{algorithm}", max_steps=2, tolA=1e-6)
'''


def load(tmp_path, *, policy="none", device="gpu", algorithm="projected_gradient_bb", name="input"):
    path = tmp_path / (name + ".py")
    path.write_text(SCRIPT.format(policy=policy, device=device, algorithm=algorithm))
    return fm.load_problem_from_script(path, lightweight_assets=True)


@pytest.mark.parametrize("policy", ["auto", "none", "exchange_mass"])
def test_policy_survives_ir_and_canonical_script_scene_roundtrip(tmp_path, policy):
    loaded = load(tmp_path, policy=policy)
    problem = loaded.stages[0].problem
    ir = problem.to_ir(include_geometry_assets=False)
    assert ir["backend_policy"]["discretization_hints"]["fem"]["gpu_bb_preconditioner"] == policy
    draft = export_builder_draft(loaded)
    assert draft["fem_bb_preconditioner"] == policy
    scene = build_scene_document_from_builder(draft)
    assert build_builder_from_scene_document(scene)["fem_bb_preconditioner"] == policy
    for index, rendered in enumerate((render_loaded_problem_as_script(loaded), render_scene_document_as_script(scene))):
        path = tmp_path / f"roundtrip_{index}.py"
        path.write_text(rendered)
        reloaded = fm.load_problem_from_script(path, lightweight_assets=True)
        assert reloaded.stages[0].problem.discretization.fem.gpu_bb_preconditioner == policy


def test_unknown_policy_rejected_without_hidden_default(tmp_path):
    with pytest.raises(ValueError, match="fem_bb_preconditioner"):
        load(tmp_path, policy="vendor_magic")


@pytest.mark.parametrize("device,algorithm", [("cpu", "projected_gradient_bb"), ("gpu", "nonlinear_cg"), ("gpu", "llg_overdamped")])
def test_explicit_policy_rejects_unsupported_execution(tmp_path, device, algorithm):
    with pytest.raises(ValueError, match="gpu_bb_preconditioner requires"):
        loaded = load(tmp_path, device=device, algorithm=algorithm)
        loaded.stages[0].problem.to_ir(include_geometry_assets=False)


def test_omission_preserves_legacy_fem_hint_shape():
    assert "gpu_bb_preconditioner" not in fm.FEM(order=1, hmax=1e-9).to_ir()


@pytest.mark.parametrize("policy", ["auto", "none", "exchange_mass"])
def test_scene_ir_lowering_accepts_typed_bb_authoring_field(tmp_path, policy):
    from fullmag.runtime.scene_document_ir import _reject_unlowered_scene_fields

    loaded = load(tmp_path, policy=policy)
    scene = build_scene_document_from_builder(export_builder_draft(loaded))
    # This boundary runs before Scene lowering; supported authored hints must
    # not be mistaken for unknown fields or discarded by the renderer.
    _reject_unlowered_scene_fields(scene)
    assert build_builder_from_scene_document(scene)["fem_bb_preconditioner"] == policy
    scene["study"]["unrecognized_bb_policy"] = policy
    with pytest.raises(ValueError, match="scene_document_unlowered_study_fields"):
        _reject_unlowered_scene_fields(scene)


def test_gpu_bb_pipeline_shared_structural_fixtures():
    import json
    from fullmag.model.bb_pipeline import is_gpu_bb_only_pipeline
    fixture = Path(__file__).resolve().parents[3] / "crates/fullmag-ir/tests/fixtures/gpu_bb_pipeline_cases.json"
    for case in json.loads(fixture.read_text()):
        assert is_gpu_bb_only_pipeline(case["pipeline"]) is case["valid"], case["name"]


@pytest.mark.parametrize("policy", ["auto", "none", "exchange_mass"])
def test_stage_only_policy_survives_entire_no_solve_export_path(tmp_path, policy):
    from fullmag.runtime.scene_document_ir import scene_document_to_problem_ir, scene_document_to_execution_config
    from fullmag.runtime.run_config_export import export_run_config, RunConfigExportOptions
    loaded = load(tmp_path, policy=policy)
    ir = loaded.to_ir(requested_backend=None, execution_mode=None, execution_precision=None, include_geometry_assets=False)
    config = export_run_config(loaded, ir, options=RunConfigExportOptions(requested_backend=None, execution_mode=None, execution_precision=None, runtime_device_override=None, include_geometry_assets=False))
    assert config["stages"]
    scene = build_scene_document_from_builder(export_builder_draft(loaded))
    scene_ir = scene_document_to_problem_ir(scene, requested_backend="fem", requested_device="gpu", requested_precision="double", requested_mode="strict", source_root=tmp_path)
    scene_config = scene_document_to_execution_config(scene, requested_backend="fem", requested_device="gpu", requested_precision="double", requested_mode="strict", source_root=tmp_path)
    for value in (ir, scene_ir, scene_config["ir"], *(stage["ir"] for stage in config["stages"])):
        assert value["backend_policy"]["discretization_hints"]["fem"]["gpu_bb_preconditioner"] == policy
    assert scene_config["ir"]["study"]["kind"] == "time_evolution"
    assert scene_config["study_pipeline"]


def test_nonexecuted_carrier_rejects_malformed_or_active_pipeline(tmp_path):
    import json
    from dataclasses import replace
    loaded = load(tmp_path)
    base = loaded.pipeline_base_problem(loaded.workspace_problem)
    fixture = Path(__file__).resolve().parents[3] / "crates/fullmag-ir/tests/fixtures/gpu_bb_pipeline_cases.json"
    cases = json.loads(fixture.read_text())
    for case in cases:
        if not case["valid"]:
            with pytest.raises(ValueError, match="gpu_bb_preconditioner requires"):
                base.to_ir(entrypoint_kind="flat_workspace", study_pipeline=case["pipeline"], include_geometry_assets=False)
    for active in ("bb", None):
        problem = replace(base, runtime_metadata={**base.runtime_metadata, "active_stage_id": active})
        with pytest.raises(ValueError, match="gpu_bb_preconditioner requires"):
            problem.to_ir(entrypoint_kind="flat_workspace", study_pipeline=cases[0]["pipeline"], include_geometry_assets=False)
    with pytest.raises(ValueError, match="gpu_bb_preconditioner requires"):
        base.to_ir(entrypoint_kind="flat_run", study_pipeline=cases[0]["pipeline"], include_geometry_assets=False)
