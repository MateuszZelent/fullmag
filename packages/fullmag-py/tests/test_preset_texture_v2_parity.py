from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from fullmag.init.preset_eval_v2 import evaluate_preset_texture_v2
from fullmag.runtime.initial_state import prepare_initial_magnetization

EXPECTED_ALL_20_PRESETS = {
    "uniform",
    "random",
    "vortex",
    "antivortex",
    "vortex_wall",
    "bloch_skyrmion",
    "neel_skyrmion",
    "antiskyrmion",
    "skyrmionium",
    "hopfion",
    "hopfion_compact_support",
    "bimeron",
    "domain_wall",
    "two_domain",
    "helical",
    "conical",
    "skyrmion_lattice",
    "spiral",
    "bloch_point",
    "artificial_spin_ice",
}


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
    assert len(cases) == 35
    covered_presets = {case["preset_kind"] for case in cases}
    assert EXPECTED_ALL_20_PRESETS.issubset(covered_presets)

    for case in cases:
        label = case.get("case_id") or case["preset_kind"]
        if case.get("apply_point_transform"):
            mapping: dict[str, object] = {
                "space": case.get("space", "object"),
                "projection": case["projection"],
                "clamp_mode": case.get("clamp_mode", "none"),
            }
            if case.get("tile_period") is not None:
                mapping["tile_period"] = case["tile_period"]
            if case.get("background_vector") is not None:
                mapping["background_vector"] = case["background_vector"]
            if case.get("axis_extent_mode") is not None:
                mapping["axis_extent_mode"] = case["axis_extent_mode"]
            if case.get("axis_thickness_m") is not None:
                mapping["axis_thickness_m"] = case["axis_thickness_m"]
            transform: dict[str, object] = {
                "translation": case.get("translation") or [0.0, 0.0, 0.0],
                "rotation_quat": case.get("rotation_quat") or [0.0, 0.0, 0.0, 1.0],
                "scale": case.get("scale") or [1.0, 1.0, 1.0],
                "pivot": case.get("pivot") or [0.0, 0.0, 0.0],
                "rotate_vectors": case.get("rotate_vectors", True),
            }
            spec = {
                "kind": "preset_texture",
                "preset_kind": case["preset_kind"],
                "preset_version": case["preset_version"],
                "preset_params": case["params"],
                "mapping": mapping,
                "texture_transform": transform,
            }
            actual_values = prepare_initial_magnetization(
                spec,
                np.asarray(case["points"], dtype=np.float64),
                region_center=case.get("region_center"),
                target_bounds_extent=case.get("target_bounds_extent"),
            ).tolist()
        else:
            result = evaluate_preset_texture_v2(
                case["preset_kind"],
                case["params"],
                case["points"],
                projection=case["projection"],
                rotation_quat=case["rotation_quat"],
                rotate_vectors=case.get("rotate_vectors", True),
                clamp_mode=case.get("clamp_mode", "none"),
                tile_period=case.get("tile_period"),
                background_vector=case.get("background_vector"),
                axis_extent_mode=case.get("axis_extent_mode") or "uniform",
                axis_thickness_m=case.get("axis_thickness_m"),
                pivot=case.get("pivot") or (0.0, 0.0, 0.0),
                target_bounds_extent=case.get("target_bounds_extent"),
            )
            actual_values = result.values

        assert len(actual_values) == len(case["expected"]), label
        for point_index, (actual, expected) in enumerate(
            zip(actual_values, case["expected"])
        ):
            for component_index, (actual_component, expected_component) in enumerate(
                zip(actual, expected)
            ):
                assert abs(actual_component - expected_component) < 1.0e-12, (
                    f"{label} mismatch at "
                    f"{point_index}:{component_index}: "
                    f"{actual_component} != {expected_component}"
                )
