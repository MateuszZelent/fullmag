"""The UI reproduction examples must capture mode outputs before stage creation."""
from pathlib import Path

import fullmag as fm
import pytest


@pytest.mark.parametrize("name", ["de_k10", "de_signed15"])
def test_mode_ui_example_captures_requested_complex_mode(name: str) -> None:
    root = Path(__file__).resolve().parents[3]
    loaded = fm.load_problem_from_script(
        root / "examples" / f"fem_eigen_mode_ui_{name}.py", lightweight_assets=True
    )
    stages = [stage for stage in loaded.stages if stage.entrypoint_kind == "flat_eigenmodes"]
    assert len(stages) == 1
    outputs = stages[0].problem.to_ir(include_geometry_assets=False)["study"]["sampling"]["outputs"]
    modes = [output for output in outputs if output["kind"] == "eigen_mode"]
    assert len(modes) == 1
    assert modes[0]["field"] == "mode"
    assert modes[0]["indices"] == [0]
    assert modes[0]["sample_selector"]["sample_indices"] == (
        [0] if name == "de_k10" else list(range(15))
    )
    assert {output["kind"] for output in outputs} >= {
        "eigen_spectrum", "eigen_diagnostics", "dispersion_curve", "eigen_mode"
    }


@pytest.mark.parametrize("name", ["de_k10", "de_signed15"])
def test_mode_ui_example_scene_roundtrip_preserves_output_selection(name, tmp_path):
    from fullmag.runtime.script_builder import export_builder_draft, render_scene_document_as_script
    from fullmag.runtime.scene_document import build_scene_document_from_builder

    root = Path(__file__).resolve().parents[3]
    loaded = fm.load_problem_from_script(
        root / "examples" / f"fem_eigen_mode_ui_{name}.py", lightweight_assets=True
    )
    scene = build_scene_document_from_builder(export_builder_draft(loaded))
    path = tmp_path / "roundtrip.py"
    path.write_text(render_scene_document_as_script(scene), encoding="utf-8")
    restored = fm.load_problem_from_script(path, lightweight_assets=True)
    assert restored.stages[-1].problem.to_ir(include_geometry_assets=False)["study"]["sampling"] == loaded.stages[-1].problem.to_ir(include_geometry_assets=False)["study"]["sampling"]


@pytest.mark.parametrize("sampling", [
    False,
    {"unexpected": 1},
    {"outputs": "mode"},
    {"outputs": [{"kind": "unknown"}]},
    {"outputs": [{"kind": "eigen_mode", "indices": [True]}]},
    {"outputs": [{"kind": "eigen_mode", "all_modes": True, "indices": [0]}]},
    {"outputs": [{"kind": "eigen_mode", "indices": [0], "sample_selector": {"typo": [0]}}]},
])
def test_scene_eigen_outputs_reject_invalid_selection(sampling):
    from fullmag.runtime.script_builder import _render_scene_eigen_outputs
    with pytest.raises((ValueError, TypeError)):
        _render_scene_eigen_outputs(sampling, {})
