import math

import numpy as np
import pytest

from fullmag.init.preset_eval import evaluate_preset_texture
from fullmag.init.preset_eval_v2 import evaluate_preset_texture_v2
from fullmag.init.textures import PresetTexture, texture
from fullmag.runtime.initial_state import prepare_initial_magnetization


def _winding(values: list[tuple[float, float, float]]) -> float:
    phases = [math.atan2(value[1], value[0]) for value in values]
    total = 0.0
    for current, following in zip(phases, phases[1:] + phases[:1]):
        total += math.atan2(math.sin(following - current), math.cos(following - current))
    return total / math.tau


def test_public_presets_and_historical_payloads_have_explicit_versions() -> None:
    assert texture.vortex().to_ir()["preset_version"] == 2
    assert PresetTexture("uniform", preset_version=1).to_ir()["preset_version"] == 1


def test_v2_vortex_and_antivortex_have_distinct_winding_and_finite_core() -> None:
    points = [
        (math.cos(angle) * 1.0e-9, math.sin(angle) * 1.0e-9, 0.0)
        for angle in np.linspace(0.0, math.tau, 16, endpoint=False)
    ]
    vortex = evaluate_preset_texture_v2(
        "vortex", {"core_radius": 1.0e-10}, points
    ).values
    antivortex = evaluate_preset_texture_v2(
        "antivortex", {"core_radius": 1.0e-10}, points
    ).values

    assert _winding(vortex) == pytest.approx(1.0)
    assert _winding(antivortex) == pytest.approx(-1.0)
    core = evaluate_preset_texture_v2("vortex", {"core_radius": 1.0e-9}, [(0.0, 0.0, 0.0)]).values[0]
    assert core == pytest.approx((0.0, 0.0, 1.0))


def test_v2_skyrmion_core_polarity_is_the_actual_core_sign() -> None:
    positive = evaluate_preset_texture_v2(
        "neel_skyrmion",
        {"radius": 1.0, "wall_width": 0.2, "core_polarity": 1},
        [(0.0, 0.0, 0.0)],
    ).values[0]
    negative = evaluate_preset_texture_v2(
        "neel_skyrmion",
        {"radius": 1.0, "wall_width": 0.2, "core_polarity": -1},
        [(0.0, 0.0, 0.0)],
    ).values[0]

    assert positive[2] == pytest.approx(1.0)
    assert negative[2] == pytest.approx(-1.0)


def test_v2_xz_frame_is_right_handed_and_rotates_core_to_negative_y() -> None:
    value = evaluate_preset_texture_v2(
        "vortex",
        {"plane": "xz", "core_radius": 1.0e-9},
        [(0.0, 0.0, 0.0)],
    ).values[0]
    assert value == pytest.approx((0.0, -1.0, 0.0))


def test_v2_helical_wavevector_preserves_requested_period() -> None:
    q = 2.0e9
    values = evaluate_preset_texture_v2(
        "helical",
        {"wavevector": [q, 0.0, 0.0], "e1": [1.0, 0.0, 0.0], "e2": [0.0, 1.0, 0.0]},
        [(0.0, 0.0, 0.0), (math.tau / q, 0.0, 0.0)],
    ).values
    assert values[0] == pytest.approx(values[1])


def test_v2_rejects_degenerate_and_conflicting_parameters() -> None:
    with pytest.raises(ValueError):
        texture.uniform((0.0, 0.0, 0.0))
    with pytest.raises(ValueError):
        texture.helical((0.0, 0.0, 0.0))
    with pytest.raises(ValueError):
        texture.helical((1.0, 0.0, 0.0), (1.0, 0.0, 0.0), (1.0, 1.0, 0.0))
    with pytest.raises(ValueError):
        texture.domain_wall(1.0, wall_center_direction=(1.0, 0.0, 0.0))
    with pytest.raises(ValueError):
        texture.two_domain((1.0, 0.0, 0.0), (-1.0, 0.0, 0.0), (0.0, 1.0, 0.0), sharp=False)
    with pytest.raises(ValueError):
        evaluate_preset_texture_v2(
            "vortex",
            {"plane": "xy"},
            [(0.0, 0.0, 0.0)],
            projection="planar_xz",
        )


def test_v2_random_seed_zero_is_deterministic_and_spatially_distinct() -> None:
    points = [(0.0, 0.0, 0.0), (1.0e-9, 0.0, 0.0)]
    first = evaluate_preset_texture_v2("random", {"seed": 0}, points).values
    second = evaluate_preset_texture_v2("random", {"seed": 0}, points).values

    assert first == second
    assert all(abs(math.sqrt(sum(component * component for component in value)) - 1.0) < 1.0e-12 for value in first)
    assert abs(sum(left * right for left, right in zip(first[0], first[1]))) < 0.999


def test_v2_texture_transform_rotates_output_vectors() -> None:
    spec = texture.uniform((1.0, 0.0, 0.0)).rotate_z(math.pi / 2.0).to_ir()
    result = prepare_initial_magnetization(spec, [(0.0, 0.0, 0.0)])[0]
    assert result == pytest.approx((0.0, 1.0, 0.0))


def test_v1_evaluator_remains_available_for_historical_payloads() -> None:
    result = evaluate_preset_texture(
        "uniform", {"direction": [0.0, 1.0, 0.0]}, [(0.0, 0.0, 0.0)], preset_version=1
    )
    assert result.values[0] == pytest.approx((0.0, 1.0, 0.0))

def test_v2_validates_empty_inputs_transforms_and_smooth_two_domain() -> None:
    with pytest.raises(ValueError):
        evaluate_preset_texture_v2("vortex", {"core_radius": 0.0}, [])
    with pytest.raises(ValueError):
        evaluate_preset_texture_v2(
            "uniform", {"direction": [1.0, 0.0, 0.0]}, [(float("nan"), 0.0, 0.0)]
        )

    transform = texture.uniform((1.0, 0.0, 0.0)).scale(0.0, 1.0, 1.0).to_ir()
    with pytest.raises(ValueError):
        prepare_initial_magnetization(transform, [(0.0, 0.0, 0.0)])

    smooth = texture.two_domain(
        (1.0, 0.0, 0.0),
        (-1.0, 0.0, 0.0),
        (0.0, 1.0, 0.0),
        wall_width=1.0,
    )
    assert smooth.params["sharp"] is False
    assert smooth.params["wall_width"] == 1.0
    center = evaluate_preset_texture_v2(
        "two_domain", smooth.params, [(0.0, 0.0, 0.0)]
    ).values[0]
    assert center == pytest.approx((0.0, 1.0, 0.0))


def test_v2_factory_distinguishes_bloch_and_neel_wall_defaults() -> None:
    neel = texture.domain_wall(1.0, kind="neel").to_ir()["preset_params"]
    bloch = texture.domain_wall(1.0, kind="bloch").to_ir()["preset_params"]
    assert neel["wall_center_direction"] != bloch["wall_center_direction"]
    assert neel["wall_center_direction"] == pytest.approx([0.0, 1.0, 0.0])
    assert bloch["wall_center_direction"] == pytest.approx([0.0, 0.0, 1.0])

def test_v1_factories_keep_historical_serialization_and_permissive_inputs() -> None:
    uniform = texture.uniform((0.0, 0.0, 0.0), preset_version=1).to_ir()
    assert uniform["preset_version"] == 1
    assert uniform["preset_params"]["direction"] == [0.0, 0.0, 0.0]

    vortex = texture.vortex(
        circulation=2,
        core_polarity=0,
        core_radius=0.0,
        preset_version=1,
    ).to_ir()
    assert vortex["preset_params"]["circulation"] == 2
    assert vortex["preset_params"]["core_polarity"] == 0
    assert vortex["preset_params"]["core_radius"] == 0.0

    helical = texture.helical(
        (0.0, 0.0, 0.0),
        e1=(0.0, 0.0, 0.0),
        e2=(0.0, 0.0, 0.0),
        preset_version=1,
    ).to_ir()
    assert helical["preset_params"]["wavevector"] == [0.0, 0.0, 0.0]

