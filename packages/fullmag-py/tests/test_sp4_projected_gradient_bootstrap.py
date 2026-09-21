"""Regression coverage for the public SP4 interactive scene bootstrap."""

from pathlib import Path

from fullmag.runtime.loader import load_problem_from_script


def test_sp4_projected_gradient_scene_bootstraps_with_current_reader():
    root = Path(__file__).resolve().parents[3]
    scenario = root / (
        "tests/standard_problems/mumag/sp4/fem/scenarios/"
        "relax_projected_gradient_bb.py"
    )
    # Exercise the same public loader mode used by the API scene helper.
    # The regenerated tracked sibling mesh must remain readable by the API.
    loaded = load_problem_from_script(scenario, lightweight_assets=True)
    assert len(loaded.stages) == 2
    assert loaded.stages[0].stage_id == "relax"
