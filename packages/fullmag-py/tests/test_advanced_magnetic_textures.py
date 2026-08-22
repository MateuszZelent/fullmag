from __future__ import annotations

import math

import pytest

import fullmag as fm
from fullmag.init.preset_eval_v2 import evaluate_preset_texture_v2


def _norm(vector: tuple[float, float, float]) -> float:
    return math.sqrt(sum(component * component for component in vector))


def test_advanced_texture_factories_serialize_v2_contracts() -> None:
    anti = fm.texture.antiskyrmion(8e-9, 2e-9, chirality=-1)
    assert anti.to_ir()["preset_kind"] == "antiskyrmion"
    assert anti.to_ir()["preset_version"] == 2

    skyrmionium = fm.texture.skyrmionium(
        5e-9,
        12e-9,
        2e-9,
        kind="bloch",
        chirality=-1,
        background_sign=1,
    )
    assert skyrmionium.to_ir()["preset_kind"] == "skyrmionium"
    assert skyrmionium.to_ir()["preset_params"]["outer_radius"] == 12e-9

    hopfion = fm.texture.hopfion(
        10e-9,
        hopf_charge=-1,
        background_sign=1,
        axial_scale=1.5,
        phase_rad=0.2,
    )
    assert hopfion.to_ir()["preset_kind"] == "hopfion"
    assert hopfion.to_ir()["preset_params"]["hopf_charge"] == -1


@pytest.mark.parametrize(
    "factory,args",
    [
        (fm.texture.antiskyrmion, (8e-9, 2e-9)),
        (fm.texture.skyrmionium, (5e-9, 12e-9, 2e-9)),
        (fm.texture.hopfion, (10e-9,)),
    ],
)
def test_advanced_textures_reject_legacy_version(factory, args) -> None:
    with pytest.raises(ValueError, match="requires preset_version=2"):
        factory(*args, preset_version=1)


def test_neel_chirality_is_not_a_noop_in_python_reference() -> None:
    base = {
        "radius": 1.0,
        "wall_width": 0.2,
        "core_polarity": -1,
    }
    positive = evaluate_preset_texture_v2(
        "neel_skyrmion",
        {**base, "chirality": 1},
        [(1.0, 0.0, 0.0)],
    ).values[0]
    negative = evaluate_preset_texture_v2(
        "neel_skyrmion",
        {**base, "chirality": -1},
        [(1.0, 0.0, 0.0)],
    ).values[0]
    assert positive[0] > 0.99
    assert negative[0] < -0.99


def test_hopfion_and_skyrmionium_reference_profiles_are_normalized() -> None:
    hopfion = evaluate_preset_texture_v2(
        "hopfion",
        {
            "radius": 1.0,
            "hopf_charge": 1,
            "background_sign": 1,
            "axial_scale": 1.0,
            "phase_rad": 0.0,
        },
        [(0.0, 0.0, 0.0), (1.0, 0.0, 0.0), (0.4, 0.3, 0.2)],
    ).values
    assert hopfion[0][2] > 0.999999
    assert hopfion[1][2] < -0.999999
    assert all(abs(_norm(value) - 1.0) < 1e-12 for value in hopfion)

    skyrmionium = evaluate_preset_texture_v2(
        "skyrmionium",
        {
            "inner_radius": 1.0,
            "outer_radius": 2.0,
            "wall_width": 0.1,
            "kind": "neel",
            "chirality": 1,
            "background_sign": 1,
        },
        [(0.0, 0.0, 0.0), (1.5, 0.0, 0.0), (8.0, 0.0, 0.0)],
    ).values
    assert skyrmionium[0][2] > 0.999
    assert skyrmionium[1][2] < -0.999
    assert skyrmionium[2][2] > 0.999
