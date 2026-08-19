from __future__ import annotations

import math
import json
from pathlib import Path

import pytest

from fullmag.init.preset_eval import evaluate_preset_texture
from fullmag.runtime.script_builder import _render_texture_factory_call
from fullmag.init.textures import texture


def _params(*, plane: str = "xy", vorticity: int = 1, background_sign: int = 1) -> dict[str, object]:
    return {
        "plane": plane,
        "radius": 20e-9,
        "wall_width": 2e-9,
        "vorticity": vorticity,
        "helicity_rad": 0.0,
        "background_sign": background_sign,
    }


def test_bimeron_factory_serializes_canonical_parameters() -> None:
    preset = texture.bimeron(5e-9, 2e-9, -1, 0.25, -1, "xz")
    ir = preset.to_ir()

    assert ir["preset_kind"] == "bimeron"
    assert ir["preset_params"] == {
        "plane": "xz",
        "radius": 5e-9,
        "wall_width": 2e-9,
        "vorticity": -1,
        "helicity_rad": 0.25,
        "background_sign": -1,
    }


@pytest.mark.parametrize("kwargs", [
    {"radius": 0.0, "wall_width": 2e-9},
    {"radius": 5e-9, "wall_width": 0.0},
    {"radius": 5e-9, "wall_width": 2e-9, "vorticity": 0},
    {"radius": 5e-9, "wall_width": 2e-9, "background_sign": 2},
    {"radius": 5e-9, "wall_width": 2e-9, "plane": "invalid"},
    {"radius": 5e-9, "wall_width": 2e-9, "vorticity": 1.5},
    {"radius": 5e-9, "wall_width": 2e-9, "background_sign": True},
])
def test_bimeron_factory_rejects_invalid_parameters(kwargs: dict[str, object]) -> None:
    with pytest.raises(ValueError):
        texture.bimeron(**kwargs)


def test_bimeron_profile_has_expected_background_and_opposite_cores() -> None:
    points = [
        (0.0, 0.0, 0.0),
        (60e-9, 0.0, 0.0),
        (20e-9, 0.0, 0.0),
        (-20e-9, 0.0, 0.0),
    ]
    values = evaluate_preset_texture("bimeron", _params(), points).values

    assert values[0][0] < -0.999
    assert values[1][0] > 0.999
    assert values[2][2] < -0.99
    assert values[3][2] > 0.99
    for value in values:
        assert all(math.isfinite(component) for component in value)
        assert abs(sum(component * component for component in value) - 1.0) < 1e-12


def test_bimeron_vorticity_flips_azimuthal_winding() -> None:
    point = [(0.0, 20e-9, 0.0)]
    positive = evaluate_preset_texture("bimeron", _params(vorticity=1), point).values[0]
    negative = evaluate_preset_texture("bimeron", _params(vorticity=-1), point).values[0]

    assert positive[1] < -0.99
    assert negative[1] > 0.99


def test_bimeron_is_stable_for_tiny_wall_width_and_uses_xz_normal_minus_y() -> None:
    tiny = _params() | {"wall_width": 1e-300}
    tiny_value = evaluate_preset_texture("bimeron", tiny, [(0.0, 0.0, 0.0)]).values[0]
    assert all(math.isfinite(component) for component in tiny_value)

    tiny_skyrmion = {
        "plane": "xy",
        "radius": 20e-9,
        "wall_width": 1e-300,
        "core_polarity": -1,
    }
    tiny_skyrmion_value = evaluate_preset_texture(
        "neel_skyrmion", tiny_skyrmion, [(0.0, 0.0, 0.0)]
    ).values[0]
    assert all(math.isfinite(component) for component in tiny_skyrmion_value)

    vortex = evaluate_preset_texture(
        "vortex",
        {"plane": "xz", "core_polarity": 1, "core_radius": 2e-9},
        [(0.0, 0.0, 0.0)],
    ).values[0]
    assert vortex[1] < -0.6

    skyrmion = evaluate_preset_texture(
        "bloch_skyrmion",
        {"plane": "xz", "radius": 20e-9, "wall_width": 2e-9, "core_polarity": -1},
        [(0.0, 0.0, 0.0)],
    ).values[0]
    assert skyrmion[1] < -0.99


def test_bimeron_evaluator_rejects_invalid_signs() -> None:
    for key, value in (("radius", 0.0), ("wall_width", 0.0), ("vorticity", 0), ("background_sign", 2), ("plane", "invalid")):
        invalid = _params() | {key: value}
        with pytest.raises(ValueError):
            evaluate_preset_texture("bimeron", invalid, [(0.0, 0.0, 0.0)])


def test_bimeron_evaluator_rejects_non_integer_signs() -> None:
    for key, value in (("vorticity", 1.5), ("background_sign", -1.5), ("vorticity", True)):
        invalid = _params() | {key: value}
        with pytest.raises(ValueError):
            evaluate_preset_texture("bimeron", invalid, [(0.0, 0.0, 0.0)])


def test_bimeron_script_builder_uses_public_factory() -> None:
    rendered = _render_texture_factory_call(
        "bimeron",
        {
            "radius": 5e-9,
            "wall_width": 2e-9,
            "vorticity": -1,
            "helicity_rad": 0.25,
            "background_sign": 1,
            "plane": "xz",
        },
    )
    assert rendered is not None
    assert rendered.startswith("fm.texture.bimeron(")
    assert "vorticity=-1" in rendered
    assert 'plane="xz"' in rendered


def test_bimeron_matches_shared_rust_python_parity_fixture() -> None:
    fixture = (
        Path(__file__).resolve().parents[3]
        / "crates"
        / "fullmag-plan"
        / "tests"
        / "fixtures"
        / "bimeron_parity.json"
    )
    cases = json.loads(fixture.read_text(encoding="utf-8"))
    for case in cases:
        values = evaluate_preset_texture(
            "bimeron", case["params"], case["points"]
        ).values
        for actual, expected in zip(values, case["expected"]):
            for actual_component, expected_component in zip(actual, expected):
                assert abs(actual_component - expected_component) < 1e-12

