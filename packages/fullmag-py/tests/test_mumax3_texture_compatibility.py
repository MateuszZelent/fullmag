from __future__ import annotations

import math

import pytest

import fullmag as fm
from fullmag.init.preset_eval_v2 import evaluate_preset_texture_v2
from fullmag.runtime.initial_state import prepare_initial_magnetization


def test_mumax_vortex_wall_factory_and_profile() -> None:
    texture = fm.texture.vortex_wall(
        wall_half_width=2.0,
        left_mx=1.0,
        right_mx=-1.0,
        circulation=1,
        core_polarity=1,
        core_radius=0.5,
    )
    assert texture.to_ir()["preset_kind"] == "vortex_wall"
    values = evaluate_preset_texture_v2(
        "vortex_wall",
        texture.params,
        [(-3.0, 0.0, 0.0), (0.0, 0.0, 0.0), (3.0, 0.0, 0.0)],
    ).values
    assert values[0] == pytest.approx((1.0, 0.0, 0.0))
    assert values[1] == pytest.approx((0.0, 0.0, 1.0))
    assert values[2] == pytest.approx((-1.0, 0.0, 0.0))


def test_mumax_compact_hopfion_factory_and_support_boundary() -> None:
    texture = fm.texture.hopfion_compact_support(major_radius=2.0, minor_radius=0.5)
    assert texture.to_ir()["preset_kind"] == "hopfion_compact_support"
    values = evaluate_preset_texture_v2(
        "hopfion_compact_support",
        texture.params,
        [(2.0, 0.0, 0.0), (2.5, 0.0, 0.0), (4.0, 0.0, 0.0)],
    ).values
    assert values[0] == pytest.approx((0.0, 0.0, -1.0))
    assert values[1] == pytest.approx((0.0, 0.0, 1.0))
    assert values[2] == pytest.approx((0.0, 0.0, 1.0))
    assert all(math.isclose(sum(component * component for component in value), 1.0) for value in values)


def test_compact_hopfion_rejects_invalid_radius_relation_and_planar_projection() -> None:
    with pytest.raises(ValueError, match="minor_radius must be <= major_radius"):
        fm.texture.hopfion_compact_support(major_radius=1.0, minor_radius=2.0)

    with pytest.raises(ValueError, match="requires object_local projection"):
        evaluate_preset_texture_v2(
            "hopfion_compact_support",
            {"major_radius": 2.0, "minor_radius": 0.5},
            [(2.0, 0.0, 0.0)],
            projection="planar_xy",
        )


@pytest.mark.parametrize(
    ("factory", "arguments"),
    [
        (fm.texture.vortex_wall, {"wall_half_width": 0.0}),
        (fm.texture.hopfion_compact_support, {"major_radius": 1.0, "minor_radius": 0.0}),
    ],
)
def test_mumax_factories_reject_nonpositive_scales(factory, arguments) -> None:
    with pytest.raises(ValueError):
        factory(**arguments)


@pytest.mark.parametrize(
    ("texture", "point"),
    [
        (
            fm.texture.vortex_wall(
                wall_half_width=2.0,
                core_radius=0.5,
            ),
            (3.0, 0.0, 0.0),
        ),
        (
            fm.texture.hopfion_compact_support(
                major_radius=2.0,
                minor_radius=0.5,
            ),
            (2.0, 0.0, 0.0),
        ),
        (fm.texture.antiskyrmion(2.0, 0.5), (3.0, 0.0, 0.0)),
        (fm.texture.skyrmionium(1.0, 2.0, 0.5), (3.0, 0.0, 0.0)),
        (fm.texture.hopfion(2.0), (3.0, 0.0, 0.0)),
    ],
)
@pytest.mark.parametrize("clamp_mode", ["clamp", "repeat", "mirror"])
def test_metric_mumax_presets_ignore_unit_box_clamp(texture, point, clamp_mode) -> None:
    spec = texture.with_mapping(clamp_mode=clamp_mode).to_ir()
    actual = prepare_initial_magnetization(spec, [point])[0]
    expected = evaluate_preset_texture_v2(
        texture.preset_kind,
        texture.params,
        [point],
    ).values[0]
    assert actual == pytest.approx(expected)
