"""Regression coverage for scoped owners at the concatenated-STL fallback boundary."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

import fullmag as fm
import fullmag.meshing._gmsh_occ as gmsh_occ
import fullmag.meshing.asset_pipeline as asset_pipeline
import fullmag.meshing.gmsh_bridge as gmsh_bridge
from fullmag.model.discretization import PerObjectMeshRecipe
from fullmag.model.geometry import Geometry


class _FallbackGeneratorReached(RuntimeError):
    pass


class _Surface:
    def __init__(self, vertices: object) -> None:
        self.vertices = np.asarray(vertices, dtype=np.float64)

    def export(self, path: str | Path) -> None:
        Path(path).write_text("solid fallback-regression\nendsolid fallback-regression\n")


def _named_difference(name: str, offset_x: float = 0.0) -> fm.Difference:
    base = fm.Box(size=(200e-9, 200e-9, 10e-9), name=f"{name}_base").translate(
        (offset_x, 0.0, 0.0)
    )
    hole = fm.Cylinder(radius=25e-9, height=10e-9, name=f"{name}_hole").translate(
        (offset_x, 0.0, 0.0)
    )
    return fm.Difference(base=base, tool=hole, name=name)


def _invoke_concatenated_fallback(
    monkeypatch: pytest.MonkeyPatch,
    geometries: list[Geometry],
) -> tuple[Path, dict[str, object], dict[str, object]]:
    fallback_calls: list[tuple[Path, dict[str, object]]] = []
    primary_calls: list[dict[str, object]] = []
    component_calls: list[dict[str, object]] = []

    def force_occ_failure(*_args: object, **kwargs: object) -> None:
        primary_calls.append(dict(kwargs))
        raise RuntimeError("forced OCC failure for fallback caller regression")

    def force_component_import_failure(*_args: object, **kwargs: object) -> None:
        component_calls.append(dict(kwargs))
        raise RuntimeError("forced component-aware import failure")

    def surface_for_geometry(geometry: Geometry, _trimesh: object, **_kwargs: object) -> _Surface:
        bounds_min, bounds_max = asset_pipeline.geometry_bounds(geometry)
        return _Surface([bounds_min, bounds_max])

    def concatenate_surfaces(meshes: list[_Surface]) -> _Surface:
        return _Surface(np.concatenate([mesh.vertices for mesh in meshes], axis=0))

    fake_trimesh = SimpleNamespace(
        util=SimpleNamespace(concatenate=concatenate_surfaces),
    )

    def stop_at_fallback_generator(source: str | Path, **kwargs: object) -> None:
        fallback_calls.append((Path(source), dict(kwargs)))
        raise _FallbackGeneratorReached("reached concatenated STL generator")

    monkeypatch.setattr(gmsh_occ, "is_occ_compatible", lambda _geometries: True)
    monkeypatch.setattr(gmsh_occ, "generate_shared_domain_mesh_via_occ", force_occ_failure)
    monkeypatch.setattr(
        asset_pipeline,
        "generate_shared_domain_mesh_from_components",
        force_component_import_failure,
    )
    monkeypatch.setattr(asset_pipeline, "_import_trimesh", lambda: fake_trimesh)
    monkeypatch.setattr(asset_pipeline, "_geometry_to_trimesh", surface_for_geometry)
    monkeypatch.setattr(asset_pipeline, "_sanitize_surface_mesh_for_stl_export", lambda mesh: mesh)
    monkeypatch.setattr(gmsh_bridge, "generate_mesh_from_file", stop_at_fallback_generator)
    monkeypatch.setattr(asset_pipeline, "emit_progress", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(asset_pipeline, "emit_progress_event", lambda *_args, **_kwargs: None)

    recipes = {
        geometry.geometry_name: PerObjectMeshRecipe(hmax=30e-9, hmin=6e-9)
        for geometry in geometries
    }
    study_universe = {
        "mode": "manual",
        "size": [1.0e-6, 700e-9, 400e-9],
        "center": [0.0, 0.0, 0.0],
        "airbox_hmax": 160e-9,
        "airbox_hmin": 18e-9,
    }

    with pytest.raises(_FallbackGeneratorReached, match="reached concatenated STL"):
        asset_pipeline.realize_fem_domain_mesh_asset_from_components(
            geometries,
            fm.FEM(order=1, hmax=80e-9),
            study_universe=study_universe,
            per_object_recipes=recipes,
        )

    assert len(primary_calls) == 1
    assert len(component_calls) == 1
    assert len(fallback_calls) == 1
    surface_path, fallback_kwargs = fallback_calls[0]
    return surface_path, fallback_kwargs, primary_calls[0]


def _assert_fallback_options_remain_scoped(
    surface_path: Path,
    fallback_kwargs: dict[str, object],
    primary_kwargs: dict[str, object],
    expected_geometry_names: set[str],
) -> None:
    assert surface_path.name == "shared_domain_surface.stl"

    airbox = fallback_kwargs["airbox"]
    assert airbox is primary_kwargs["airbox"]
    assert airbox.maximum_element_size == 160e-9
    assert airbox.minimum_element_size == 18e-9

    options = fallback_kwargs["options"]
    lower_bounds = [
        field
        for field in options.lower_bound_fields
        if field.get("kind") == "ComponentVolumeLowerBound"
    ]
    assert {
        field["params"]["GeometryName"]: field["params"]["MinimumElementSize"]
        for field in lower_bounds
    } == {name: 6e-9 for name in expected_geometry_names}
    assert all(field["params"]["GeometryName"] != "airbox" for field in lower_bounds)

    upper_targets = [
        field["params"]["VIn"]
        for field in options.size_fields
        if field.get("kind") == "Box" and isinstance(field.get("params"), dict)
    ]
    assert upper_targets == [30e-9] * len(expected_geometry_names)


def test_single_difference_fallback_binds_exact_geometry_owner(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    geometry = _named_difference("periodic_film_geom")
    surface_path, fallback_kwargs, primary_kwargs = _invoke_concatenated_fallback(
        monkeypatch, [geometry]
    )

    assert fallback_kwargs["geometry_name"] == geometry.geometry_name
    _assert_fallback_options_remain_scoped(
        surface_path,
        fallback_kwargs,
        primary_kwargs,
        {geometry.geometry_name},
    )


def test_multi_geometry_fallback_does_not_guess_a_single_owner(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    geometries = [
        _named_difference("film_left", offset_x=-150e-9),
        _named_difference("film_right", offset_x=150e-9),
    ]
    surface_path, fallback_kwargs, primary_kwargs = _invoke_concatenated_fallback(
        monkeypatch, geometries
    )

    assert "geometry_name" not in fallback_kwargs
    _assert_fallback_options_remain_scoped(
        surface_path,
        fallback_kwargs,
        primary_kwargs,
        {geometry.geometry_name for geometry in geometries},
    )
