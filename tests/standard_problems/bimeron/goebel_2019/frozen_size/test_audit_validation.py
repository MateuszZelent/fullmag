from pathlib import Path

from tests.standard_problems.bimeron.goebel_2019.frozen_size.audit_validation import (
    command_for,
    validation_matrix,
)


def test_matrix_has_one_free_baseline_and_explicit_ui_for_every_run() -> None:
    cases = validation_matrix()
    assert len(cases) == 16
    assert sum(c["kind"] == "paired" for c in cases) == 1
    assert len({c["name"] for c in cases}) == len(cases)
    for case in cases:
        command = command_for(case, Path("results"), 3114)
        assert command[command.index("--run-mode") + 1] == "interactive"
        assert command[command.index("--device") + 1] == "gpu"
        assert command[command.index("--cell-nm") + 1] == "0.5"
    profile = command_for(cases[-1], Path("results"), 3114)
    assert profile[profile.index("--radius-start-nm") + 1] == "1.5"
    assert profile[profile.index("--radius-stop-nm") + 1] == "10.0"
    assert "--free-reference" in profile


def test_sensitivity_preserves_seed_radius_and_varies_one_mask_parameter() -> None:
    for case in validation_matrix():
        if case["name"].startswith("wide"):
            assert case["ring_width_nm"] == 0.75
            assert case["ring_offset_nm"] == 0.0
        elif case["name"].startswith(("inner", "outer")):
            assert case["ring_width_nm"] == 0.5
            assert abs(case["ring_offset_nm"]) == 0.125
