from __future__ import annotations

from copy import deepcopy

import numpy as np
import pytest

from fullmag.meshing._gmsh_layered_periodic import periodic_patch_z_bounds_from_gmsh


_PLANES = (-2.0, 0.0, 2.0)
_GMSH_UNITS_PER_M = 4.0


class _FakeMesh:
    def __init__(self, surfaces: dict[int, list[tuple[float, float, float]]]) -> None:
        self.surfaces = surfaces
        self.calls: list[tuple[int, int, bool, bool]] = []

    def getNodes(
        self,
        dim: int,
        tag: int,
        includeBoundary: bool = False,
        returnParametricCoord: bool = False,
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        self.calls.append((dim, tag, includeBoundary, returnParametricCoord))
        coords = self.surfaces.get(tag)
        if coords is None:
            raise ValueError(f"unknown surface {tag}")
        tags = np.arange(tag * 10, tag * 10 + len(coords), dtype=np.int64)
        return tags, np.asarray(coords).reshape(-1), np.empty(0)


class _FakeModel:
    def __init__(self, surfaces: dict[int, list[tuple[float, float, float]]]) -> None:
        self.mesh = _FakeMesh(surfaces)


class _FakeGmsh:
    def __init__(self, surfaces: dict[int, list[tuple[float, float, float]]]) -> None:
        self.model = _FakeModel(surfaces)


def _z_surface(
    z_low_si: float,
    z_high_si: float,
    *interior_z_si: float,
) -> list[tuple[float, float, float]]:
    # Coordinates are represented in Gmsh units; the helper converts them to SI.
    return [
        (0.0, 0.0, z * _GMSH_UNITS_PER_M)
        for z in (z_low_si, *interior_z_si, z_high_si)
    ]


def _spec(
    pair_id: str,
    marker_a: int,
    marker_b: int,
    master_tag: int,
    slave_tag: int,
    *,
    axis_hint: str = "x",
    translation: tuple[float, float, float] = (8.0, 0.0, 0.0),
    tolerance_m: float = 0.01,
) -> dict[str, object]:
    return {
        "pair_id": pair_id,
        "marker_a": marker_a,
        "marker_b": marker_b,
        "master_tag": master_tag,
        "slave_tag": slave_tag,
        "axis_hint": axis_hint,
        "translation": list(translation),
        "tolerance_m": tolerance_m,
    }


def _fixture() -> tuple[_FakeGmsh, list[dict[str, object]]]:
    surfaces = {
        1: _z_surface(-2.0, 0.0, -0.75),
        2: _z_surface(-2.0, 0.0, -1.25),
        3: _z_surface(0.0, 2.0, 1.25),
        4: _z_surface(0.0, 2.0, 0.5),
        5: _z_surface(-2.0, 2.0, -1.0, 1.0),
        6: _z_surface(-2.0, 2.0, -0.5, 0.75),
    }
    # Deliberately scramble rows: markers and surface tags are joined by fields,
    # never by list position.
    specs = [
        _spec("x_faces", 33, 34, 3, 4),
        _spec("y_faces", 35, 36, 5, 6, axis_hint="y", translation=(0.0, 8.0, 0.0)),
        _spec("x_faces", 31, 32, 1, 2),
    ]
    return _FakeGmsh(surfaces), specs


def test_derives_marker_keyed_ranges_from_explicit_surfaces_and_covers_axes() -> None:
    gmsh, specs = _fixture()
    source_before = deepcopy(specs)

    scopes = periodic_patch_z_bounds_from_gmsh(
        gmsh,
        specs,
        gmsh_units_per_m=_GMSH_UNITS_PER_M,
        layer_planes_si_m=_PLANES,
    )

    assert scopes == {
        ("x_faces", 31, 32): (-2.0, 0.0),
        ("x_faces", 33, 34): (0.0, 2.0),
        ("y_faces", 35, 36): (-2.0, 2.0),
    }
    assert specs == source_before
    assert gmsh.model.mesh.calls == [
        (2, 3, True, False),
        (2, 4, True, False),
        (2, 5, True, False),
        (2, 6, True, False),
        (2, 1, True, False),
        (2, 2, True, False),
    ]


def test_accepts_off_plane_surface_nodes_and_a_patch_spanning_multiple_slabs() -> None:
    gmsh, specs = _fixture()
    scopes = periodic_patch_z_bounds_from_gmsh(
        gmsh,
        specs,
        gmsh_units_per_m=_GMSH_UNITS_PER_M,
        layer_planes_si_m=_PLANES,
    )

    assert scopes[("y_faces", 35, 36)] == (_PLANES[0], _PLANES[-1])
    # The saved point at z=-1.0 is intentionally not an authored layer plane.
    assert -1.0 not in _PLANES


def test_nonbinary_scale_uses_production_style_division_for_exact_planes() -> None:
    scale = 3.0
    low_gmsh = -0.2 * scale
    high_gmsh = 0.3 * scale
    planes = (low_gmsh / scale, high_gmsh / scale)
    surfaces = {
        1: [(0.0, 0.0, low_gmsh), (0.0, 0.0, -0.1 * scale), (0.0, 0.0, high_gmsh)],
        2: [(1.0, 0.0, low_gmsh), (1.0, 0.0, 0.15 * scale), (1.0, 0.0, high_gmsh)],
    }
    gmsh = _FakeGmsh(surfaces)
    specs = [_spec("x_faces", 31, 32, 1, 2)]

    assert periodic_patch_z_bounds_from_gmsh(
        gmsh,
        specs,
        gmsh_units_per_m=scale,
        layer_planes_si_m=planes,
    ) == {("x_faces", 31, 32): planes}


def test_rejects_complex_surface_coordinates_before_float_conversion() -> None:
    gmsh, specs = _fixture()
    gmsh.model.mesh.surfaces[1] = [
        (0.0, 0.0, complex(-8.0, 0.25)),
        (0.0, 0.0, complex(0.0, 0.0)),
    ]

    with pytest.raises(TypeError, match="complex node coordinates"):
        periodic_patch_z_bounds_from_gmsh(
            gmsh,
            specs,
            gmsh_units_per_m=_GMSH_UNITS_PER_M,
            layer_planes_si_m=_PLANES,
        )


def test_rejects_wrong_scale_by_exact_endpoint_membership() -> None:
    gmsh, specs = _fixture()

    with pytest.raises(ValueError, match="exact authored layer plane"):
        periodic_patch_z_bounds_from_gmsh(
            gmsh,
            specs,
            gmsh_units_per_m=2.0,
            layer_planes_si_m=_PLANES,
        )


@pytest.mark.parametrize("scale", [0.0, -4.0, float("inf"), float("nan"), True])
def test_rejects_invalid_gmsh_units_per_m(scale: object) -> None:
    gmsh, specs = _fixture()

    with pytest.raises((TypeError, ValueError), match="gmsh_units_per_m"):
        periodic_patch_z_bounds_from_gmsh(
            gmsh,
            specs,
            gmsh_units_per_m=scale,  # type: ignore[arg-type]
            layer_planes_si_m=_PLANES,
        )


def test_rejects_invalid_or_nonincreasing_authored_planes() -> None:
    gmsh, specs = _fixture()

    with pytest.raises(ValueError, match="strictly increasing"):
        periodic_patch_z_bounds_from_gmsh(
            gmsh,
            specs,
            gmsh_units_per_m=_GMSH_UNITS_PER_M,
            layer_planes_si_m=(-2.0, 0.0, 0.0),
        )

    with pytest.raises((TypeError, ValueError), match="layer_planes_si_m"):
        periodic_patch_z_bounds_from_gmsh(
            gmsh,
            specs,
            gmsh_units_per_m=_GMSH_UNITS_PER_M,
            layer_planes_si_m=(-2.0, float("nan"), 2.0),
        )


def test_rejects_missing_surface_and_empty_surface_nodes() -> None:
    gmsh, specs = _fixture()
    specs[0]["master_tag"] = 99
    with pytest.raises(ValueError, match="surface 99"):
        periodic_patch_z_bounds_from_gmsh(
            gmsh,
            specs,
            gmsh_units_per_m=_GMSH_UNITS_PER_M,
            layer_planes_si_m=_PLANES,
        )

    gmsh, specs = _fixture()
    gmsh.model.mesh.surfaces[3] = []
    with pytest.raises(ValueError, match="empty node set"):
        periodic_patch_z_bounds_from_gmsh(
            gmsh,
            specs,
            gmsh_units_per_m=_GMSH_UNITS_PER_M,
            layer_planes_si_m=_PLANES,
        )


def test_rejects_master_slave_endpoint_mismatch() -> None:
    gmsh, specs = _fixture()
    gmsh.model.mesh.surfaces[2] = _z_surface(0.0, 2.0, 0.75)

    with pytest.raises(ValueError, match="master/slave.*bounds"):
        periodic_patch_z_bounds_from_gmsh(
            gmsh,
            specs,
            gmsh_units_per_m=_GMSH_UNITS_PER_M,
            layer_planes_si_m=_PLANES,
        )


def test_rejects_endpoint_drift_even_when_it_is_small() -> None:
    gmsh, specs = _fixture()
    gmsh.model.mesh.surfaces[1] = _z_surface(-2.0 + 1.0e-12, 0.0, -0.5)
    gmsh.model.mesh.surfaces[2] = _z_surface(-2.0 + 1.0e-12, 0.0, -1.5)

    with pytest.raises(ValueError, match="exact authored layer plane"):
        periodic_patch_z_bounds_from_gmsh(
            gmsh,
            specs,
            gmsh_units_per_m=_GMSH_UNITS_PER_M,
            layer_planes_si_m=_PLANES,
        )


def test_rejects_axis_gap_and_positive_overlap() -> None:
    gmsh, specs = _fixture()
    specs = [_spec("x_faces", 31, 32, 1, 2)]
    gmsh.model.mesh.surfaces = {1: _z_surface(-2.0, 0.0), 2: _z_surface(-2.0, 0.0)}
    with pytest.raises(ValueError, match="cover the exact z domain"):
        periodic_patch_z_bounds_from_gmsh(
            gmsh,
            specs,
            gmsh_units_per_m=_GMSH_UNITS_PER_M,
            layer_planes_si_m=_PLANES,
        )

    gmsh = _FakeGmsh({
        1: _z_surface(-2.0, 2.0),
        2: _z_surface(-2.0, 2.0),
        3: _z_surface(0.0, 2.0),
        4: _z_surface(0.0, 2.0),
    })
    specs = [
        _spec("x_faces", 31, 32, 1, 2),
        _spec("x_faces", 33, 34, 3, 4),
    ]
    with pytest.raises(ValueError, match="gap or overlap"):
        periodic_patch_z_bounds_from_gmsh(
            gmsh,
            specs,
            gmsh_units_per_m=_GMSH_UNITS_PER_M,
            layer_planes_si_m=_PLANES,
        )


def test_rejects_duplicate_or_ambiguous_surface_spec_keys() -> None:
    gmsh, specs = _fixture()
    specs.append(deepcopy(specs[-1]))

    with pytest.raises(ValueError, match="duplicate periodic surface spec key"):
        periodic_patch_z_bounds_from_gmsh(
            gmsh,
            specs,
            gmsh_units_per_m=_GMSH_UNITS_PER_M,
            layer_planes_si_m=_PLANES,
        )

    gmsh, specs = _fixture()
    specs[1]["master_tag"] = 1
    specs[1]["slave_tag"] = 2
    with pytest.raises(ValueError, match="surface tag.*used by more than one"):
        periodic_patch_z_bounds_from_gmsh(
            gmsh,
            specs,
            gmsh_units_per_m=_GMSH_UNITS_PER_M,
            layer_planes_si_m=_PLANES,
        )


def test_rejects_inconsistent_authored_axis_translation_or_tolerance() -> None:
    gmsh, _specs = _fixture()
    specs = [
        _spec("x_faces", 31, 32, 1, 2),
        _spec("x_faces", 33, 34, 3, 4, axis_hint="y", translation=(0.0, 8.0, 0.0)),
    ]
    with pytest.raises(ValueError, match="inconsistent authored periodic records"):
        periodic_patch_z_bounds_from_gmsh(
            gmsh,
            specs,
            gmsh_units_per_m=_GMSH_UNITS_PER_M,
            layer_planes_si_m=_PLANES,
        )

    for field, value in (
        ("translation", [-8.0, 0.0, 0.0]),
        ("tolerance_m", 0.02),
    ):
        gmsh, specs = _fixture()
        specs[0][field] = value
        with pytest.raises(ValueError, match="inconsistent authored periodic records"):
            periodic_patch_z_bounds_from_gmsh(
                gmsh,
                specs,
                gmsh_units_per_m=_GMSH_UNITS_PER_M,
                layer_planes_si_m=_PLANES,
            )


def test_rejects_z_normal_periodic_surfaces_for_positive_z_patch_scopes() -> None:
    gmsh = _FakeGmsh({1: _z_surface(-2.0, -2.0), 2: _z_surface(2.0, 2.0)})
    specs = [_spec("z_faces", 41, 42, 1, 2, axis_hint="z", translation=(0.0, 0.0, 16.0))]

    with pytest.raises(ValueError, match="only lateral x/y periodic surfaces"):
        periodic_patch_z_bounds_from_gmsh(
            gmsh,
            specs,
            gmsh_units_per_m=_GMSH_UNITS_PER_M,
            layer_planes_si_m=_PLANES,
        )


def test_empty_specs_return_no_scopes_without_gmsh_surface_calls() -> None:
    gmsh = _FakeGmsh({})

    assert periodic_patch_z_bounds_from_gmsh(
        gmsh,
        [],
        gmsh_units_per_m=_GMSH_UNITS_PER_M,
        layer_planes_si_m=_PLANES,
    ) == {}
    assert gmsh.model.mesh.calls == []
