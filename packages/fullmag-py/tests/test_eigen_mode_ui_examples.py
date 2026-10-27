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
