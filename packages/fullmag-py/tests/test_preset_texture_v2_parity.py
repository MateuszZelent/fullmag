from __future__ import annotations

import json
from pathlib import Path

from fullmag.init.preset_eval_v2 import evaluate_preset_texture_v2


def test_v2_matches_shared_rust_fixture_for_all_presets_and_1000_points() -> None:
    fixture = (
        Path(__file__).resolve().parents[3]
        / "crates"
        / "fullmag-plan"
        / "tests"
        / "fixtures"
        / "magnetization_textures_v2_parity.json"
    )
    cases = json.loads(fixture.read_text(encoding="utf-8"))
    assert len(cases) == 14

    for case in cases:
        result = evaluate_preset_texture_v2(
            case["preset_kind"],
            case["params"],
            case["points"],
            projection=case["projection"],
            rotation_quat=case["rotation_quat"],
        )
        assert len(result.values) == 1000
        for point_index, (actual, expected) in enumerate(
            zip(result.values, case["expected"])
        ):
            for component_index, (actual_component, expected_component) in enumerate(
                zip(actual, expected)
            ):
                assert abs(actual_component - expected_component) < 1.0e-12, (
                    f"{case['preset_kind']} mismatch at "
                    f"{point_index}:{component_index}: "
                    f"{actual_component} != {expected_component}"
                )
