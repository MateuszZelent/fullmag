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
