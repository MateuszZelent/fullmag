from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest

import fullmag as fm
from fullmag.model import geometry as geometry_model


def test_disk_lowers_to_finite_cylinder() -> None:
    shape = fm.shapes.disk(radius=25e-9, thickness=3e-9)

    assert shape.to_ir() == {
        "kind": "cylinder",
        "center_m": [0.0, 0.0, 0.0],
        "axis": [0.0, 0.0, 1.0],
        "radius_m": 25e-9,
        "height_m": 3e-9,
    }


def test_disk_normalizes_normal_and_preserves_center() -> None:
    shape = fm.shapes.disk(
        radius=25e-9,
        thickness=3e-9,
        center=(1e-9, -2e-9, 3e-9),
        normal=(0.0, 0.0, 4.0),
    )

    assert shape.to_ir() == {
        "kind": "cylinder",
        "center_m": [1e-9, -2e-9, 3e-9],
        "axis": [0.0, 0.0, 1.0],
        "radius_m": 25e-9,
        "height_m": 3e-9,
    }


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"radius": 0.0, "thickness": 3e-9}, "radius"),
        ({"radius": -25e-9, "thickness": 3e-9}, "radius"),
        ({"radius": float("nan"), "thickness": 3e-9}, "radius"),
        ({"radius": float("inf"), "thickness": 3e-9}, "radius"),
        ({"radius": 25e-9, "thickness": 0.0}, "thickness"),
        ({"radius": 25e-9, "thickness": -3e-9}, "thickness"),
        ({"radius": 25e-9, "thickness": float("nan")}, "thickness"),
        ({"radius": 25e-9, "thickness": float("inf")}, "thickness"),
        ({"radius": 25e-9, "thickness": 3e-9, "normal": (0.0, 0.0, 0.0)}, "normal"),
        (
            {"radius": 25e-9, "thickness": 3e-9, "normal": (0.0, 0.0, float("nan"))},
            "normal",
        ),
    ],
)
def test_disk_rejects_invalid_finite_cylinder_parameters(
    kwargs: dict[str, object],
    message: str,
) -> None:
    with pytest.raises(ValueError, match=message):
        fm.shapes.disk(**kwargs)


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"radius": True, "thickness": 3e-9}, "radius"),
        ({"radius": "25e-9", "thickness": 3e-9}, "radius"),
        ({"radius": 25e-9, "thickness": True}, "thickness"),
        ({"radius": 25e-9, "thickness": "3e-9"}, "thickness"),
        ({"radius": 25e-9, "thickness": 3e-9, "center": (0.0, False, 0.0)}, "center"),
        ({"radius": 25e-9, "thickness": 3e-9, "normal": (0.0, "0", 1.0)}, "normal"),
    ],
)
def test_disk_rejects_non_numeric_si_values(
    kwargs: dict[str, object],
    message: str,
) -> None:
    with pytest.raises((TypeError, ValueError), match=message):
        fm.shapes.disk(**kwargs)


def test_disk_through_object_requires_explicit_object_id() -> None:
    with pytest.raises(ValueError, match="object_id"):
        fm.shapes.disk(radius=25e-9, extrusion="through_object")


def test_disk_through_object_has_distinct_authored_serialization() -> None:
    shape = fm.shapes.disk(
        radius=25e-9,
        center=(1e-9, 0.0, 0.0),
        extrusion="through_object",
        object_id="free_layer",
    )

    assert not isinstance(shape, geometry_model.SelectionGeometry)
    assert not hasattr(shape, "to_ir")
    assert shape.to_authored_ir() == {
        "kind": "disk",
        "center_m": [1e-9, 0.0, 0.0],
        "normal": [0.0, 0.0, 1.0],
        "radius_m": 25e-9,
        "extrusion": {
            "kind": "through_object",
            "object_id": "free_layer",
        },
    }


def test_affine_builders_typed_canonical_round_trip() -> None:
    shape = fm.shapes.rotate(
        fm.shapes.scale(
            fm.shapes.disk(radius=25e-9, thickness=3e-9),
            factors=(2.0, -3.0, 0.5),
            pivot=(1e-9, 0.0, 0.0),
        ),
        quaternion=(0.0, 0.0, 2.0, 2.0),
        pivot=(0.0, 1e-9, 0.0),
    )

    expected = {
        "kind": "affine",
        "geometry": {
            "kind": "affine",
            "geometry": {
                "kind": "cylinder",
                "center_m": [0.0, 0.0, 0.0],
                "axis": [0.0, 0.0, 1.0],
                "radius_m": 25e-9,
                "height_m": 3e-9,
            },
            "translation_m": [0.0, 0.0, 0.0],
            "rotation_xyzw": [0.0, 0.0, 0.0, 1.0],
            "scale": [2.0, -3.0, 0.5],
            "pivot_m": [1e-9, 0.0, 0.0],
        },
        "translation_m": [0.0, 0.0, 0.0],
        "rotation_xyzw": [0.0, 0.0, 0.7071067811865475, 0.7071067811865475],
        "scale": [1.0, 1.0, 1.0],
        "pivot_m": [0.0, 1e-9, 0.0],
    }
    assert shape.to_ir() == expected
    restored = geometry_model.SelectionGeometry.from_ir(expected)
    assert restored == shape
    assert restored.to_ir() == expected


def test_through_object_typed_authored_round_trip() -> None:
    shape = fm.shapes.rotate(
        fm.shapes.disk(
            radius=25e-9,
            extrusion="through_object",
            object_id="free_layer",
        ),
        quaternion=(0.0, 0.0, 1.0, 1.0),
    )
    authored_ir: dict[str, Any] = shape.to_authored_ir()
    expected = shape.to_authored_ir()

    restored = geometry_model.AuthoredSelectionGeometry.from_authored_ir(authored_ir)
    authored_ir["geometry"]["radius_m"] = 999.0

    assert restored == shape
    assert restored.to_authored_ir() == expected
    assert not isinstance(restored, geometry_model.SelectionGeometry)


def test_affine_rejects_noninvertible_scale() -> None:
    with pytest.raises(ValueError, match="scale"):
        fm.shapes.affine(
            fm.shapes.disk(radius=25e-9, thickness=3e-9),
            scale=(1.0, 0.0, 1.0),
        )


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"translation": (0.0, float("inf"), 0.0)}, "translation"),
        ({"translation": (0.0, "1e-9", 0.0)}, "translation"),
        ({"quaternion": (0.0, 0.0, 0.0, 0.0)}, "quaternion"),
        ({"quaternion": (0.0, 0.0, float("nan"), 1.0)}, "quaternion"),
        ({"quaternion": (0.0, 0.0, True, 1.0)}, "quaternion"),
        ({"scale": (1.0, float("inf"), 1.0)}, "scale"),
        ({"scale": (1.0, "2", 1.0)}, "scale"),
        ({"pivot": (0.0, float("nan"), 0.0)}, "pivot"),
        ({"pivot": (0.0, False, 0.0)}, "pivot"),
    ],
)
def test_affine_rejects_invalid_transform_values(
    kwargs: dict[str, object],
    message: str,
) -> None:
    with pytest.raises((TypeError, ValueError), match=message):
        fm.shapes.affine(
            fm.shapes.disk(radius=25e-9, thickness=3e-9),
            **kwargs,
        )


@dataclass
class _MutableForeignGeometry:
    payload: dict[str, object]

    def to_ir(self) -> dict[str, object]:
        return self.payload


@pytest.mark.parametrize(
    "foreign",
    [
        "cylinder",
        {"kind": "cylinder"},
        object(),
        _MutableForeignGeometry({"kind": "cylinder"}),
    ],
)
def test_affine_rejects_foreign_or_mutable_geometry_children(foreign: object) -> None:
    with pytest.raises(TypeError, match="geometry"):
        fm.shapes.affine(foreign)

    with pytest.raises(TypeError, match="geometry"):
        geometry_model.SelectionAffine(geometry=foreign)


def test_through_object_node_rejects_foreign_extrusion_policy() -> None:
    with pytest.raises(TypeError, match="extrusion"):
        geometry_model.SelectionThroughObjectDisk(
            radius_m=25e-9,
            center_m=(0.0, 0.0, 0.0),
            normal=(0.0, 0.0, 1.0),
            extrusion={"kind": "through_object", "object_id": "free_layer"},
        )


def test_from_ir_rejects_authored_or_unknown_nodes() -> None:
    authored = fm.shapes.disk(
        radius=25e-9,
        extrusion="through_object",
        object_id="free_layer",
    ).to_authored_ir()

    with pytest.raises(ValueError, match="canonical"):
        geometry_model.SelectionGeometry.from_ir(authored)

    with pytest.raises(ValueError, match="unknown"):
        geometry_model.SelectionGeometry.from_ir(
            {
                "kind": "cylinder",
                "center_m": [0.0, 0.0, 0.0],
                "axis": [0.0, 0.0, 1.0],
                "radius_m": 25e-9,
                "height_m": 3e-9,
                "extra": True,
            }
        )


def test_typed_deserialization_is_copy_safe() -> None:
    canonical_ir: dict[str, Any] = {
        "kind": "affine",
        "geometry": {
            "kind": "cylinder",
            "center_m": [1e-9, 0.0, 0.0],
            "axis": [0.0, 0.0, 1.0],
            "radius_m": 25e-9,
            "height_m": 3e-9,
        },
        "translation_m": [2e-9, 0.0, 0.0],
        "rotation_xyzw": [0.0, 0.0, 0.0, 1.0],
        "scale": [1.0, 2.0, 1.0],
        "pivot_m": [0.0, 0.0, 0.0],
    }
    shape = geometry_model.SelectionGeometry.from_ir(canonical_ir)
    expected = shape.to_ir()

    canonical_ir["translation_m"][0] = 999.0
    canonical_ir["geometry"]["center_m"][0] = 999.0
    serialized = shape.to_ir()
    serialized["translation_m"][0] = 888.0
    serialized["geometry"]["center_m"][0] = 888.0

    assert shape.to_ir() == expected


def test_top_level_exports_are_exact_builder_aliases() -> None:
    expected = {
        "affine": fm.shapes.affine,
        "disk": fm.shapes.disk,
        "rotate": fm.shapes.rotate,
        "scale": fm.shapes.scale,
    }

    for name, builder in expected.items():
        assert getattr(fm, name) is builder
        assert fm.__all__.count(name) == 1

    assert "SelectionGeometry" not in fm.__all__
    assert "AuthoredSelectionGeometry" not in fm.__all__
