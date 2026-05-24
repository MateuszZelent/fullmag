from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import shutil
from typing import Any

import numpy as np

from fullmag.model.geometry import (
    ArchWaveguide,
    Box,
    Cylinder,
    Difference,
    Ellipse,
    Ellipsoid,
    Geometry,
    ImportedGeometry,
    Intersection,
    Translate,
    Union,
)


def _import_trimesh() -> Any:
    try:
        import trimesh  # type: ignore
    except ImportError as exc:  # pragma: no cover - depends on optional extra
        raise ImportError(
            "trimesh is required for STL import/export helpers. "
            "Install with: python -m pip install 'trimesh>=4.12,<5'"
        ) from exc
    return trimesh


@dataclass(frozen=True, slots=True)
class SurfaceAsset:
    path: Path
    format: str
    watertight: bool | None
    bounds_min: tuple[float, float, float] | None
    bounds_max: tuple[float, float, float] | None


def _resolve_surface_asset_path(
    source: str | Path,
    *,
    source_root: str | Path | None = None,
) -> Path:
    path = Path(source)
    if not path.is_absolute() and source_root is not None:
        path = Path(source_root) / path
    return path.resolve()


def _load_stl_triangles(path: Path) -> np.ndarray:
    data = path.read_bytes()
    if len(data) >= 84:
        triangle_count = int.from_bytes(data[80:84], byteorder="little", signed=False)
        expected_size = 84 + triangle_count * 50
        if expected_size == len(data):
            return _load_binary_stl_triangles(data, triangle_count)
    return _load_ascii_stl_triangles(data.decode("utf-8", errors="ignore"))


def _load_binary_stl_triangles(data: bytes, triangle_count: int) -> np.ndarray:
    triangles = np.empty((triangle_count, 3, 3), dtype=np.float64)
    offset = 84
    for index in range(triangle_count):
        record = data[offset : offset + 50]
        floats = np.frombuffer(record, dtype="<f4", count=12)
        triangles[index] = floats[3:].reshape(3, 3)
        offset += 50
    return triangles


def _load_ascii_stl_triangles(text: str) -> np.ndarray:
    vertices: list[tuple[float, float, float]] = []
    for raw_line in text.splitlines():
        stripped = raw_line.strip()
        if not stripped:
            continue
        parts = stripped.split()
        if len(parts) == 4 and parts[0].lower() == "vertex":
            vertices.append((float(parts[1]), float(parts[2]), float(parts[3])))
    if not vertices or len(vertices) % 3 != 0:
        raise ValueError("could not parse STL triangles from imported geometry")
    return np.asarray(vertices, dtype=np.float64).reshape(-1, 3, 3)


def load_surface_asset(
    source: str | Path,
    *,
    source_root: str | Path | None = None,
) -> SurfaceAsset:
    path = _resolve_surface_asset_path(source, source_root=source_root)
    fmt = path.suffix.lower().lstrip(".")
    if fmt not in {"stl", "step", "stp", "iges", "igs"}:
        raise ValueError(f"unsupported geometry asset format: {path.suffix}")

    if fmt != "stl":
        return SurfaceAsset(
            path=path,
            format=fmt,
            watertight=None,
            bounds_min=None,
            bounds_max=None,
        )

    try:
        trimesh = _import_trimesh()
    except ImportError:
        triangles = _load_stl_triangles(path)
        mins = triangles.min(axis=(0, 1))
        maxs = triangles.max(axis=(0, 1))
        return SurfaceAsset(
            path=path,
            format=fmt,
            watertight=None,
            bounds_min=tuple(float(value) for value in mins),
            bounds_max=tuple(float(value) for value in maxs),
        )

    mesh = trimesh.load_mesh(path, force="mesh")
    bounds = mesh.bounds
    return SurfaceAsset(
        path=path,
        format=fmt,
        watertight=bool(mesh.is_watertight),
        bounds_min=tuple(float(value) for value in bounds[0]),
        bounds_max=tuple(float(value) for value in bounds[1]),
    )


def build_surface_preview_payload(geometry: Geometry) -> dict[str, object] | None:
    try:
        trimesh = _import_trimesh()
        mesh = _geometry_to_trimesh(geometry, trimesh)
    except Exception:
        return None

    if mesh is None:
        return None

    mesh = mesh.copy()
    if hasattr(mesh, "remove_unreferenced_vertices"):
        mesh.remove_unreferenced_vertices()
    if hasattr(mesh, "merge_vertices"):
        mesh.merge_vertices()

    vertices = getattr(mesh, "vertices", None)
    faces = getattr(mesh, "faces", None)
    if vertices is None or faces is None or len(vertices) == 0 or len(faces) == 0:
        return None

    return {
        "nodes": [[float(x), float(y), float(z)] for x, y, z in vertices.tolist()],
        "elements": [],
        "boundary_faces": [
            [int(face[0]), int(face[1]), int(face[2])] for face in faces.tolist()
        ],
    }


def export_geometry_to_stl(
    geometry: Geometry,
    destination: str | Path,
    *,
    cylinder_sections: int = 48,
) -> Path:
    target = Path(destination)
    target.parent.mkdir(parents=True, exist_ok=True)

    if isinstance(geometry, ImportedGeometry):
        source = Path(geometry.source)
        if source.suffix.lower() != ".stl":
            raise ValueError(
                "exporting ImportedGeometry to STL is only passthrough-supported when the source is already .stl"
            )
        if source.resolve() != target.resolve():
            shutil.copyfile(source, target)
        return target

    trimesh = _import_trimesh()
    if isinstance(geometry, Box):
        mesh = trimesh.creation.box(extents=geometry.size)
    elif isinstance(geometry, Cylinder):
        mesh = trimesh.creation.cylinder(
            radius=geometry.radius,
            height=geometry.height,
            sections=cylinder_sections,
        )
    elif isinstance(geometry, Difference):
        base_mesh = _geometry_to_trimesh(geometry.base, trimesh, cylinder_sections)
        tool_mesh = _geometry_to_trimesh(geometry.tool, trimesh, cylinder_sections)
        try:
            mesh = base_mesh.difference(tool_mesh)
        except Exception:
            # Fallback: generate via Gmsh and export boundary faces
            from .gmsh_bridge import generate_difference_mesh
            mesh_data = generate_difference_mesh(geometry, hmax=min(geometry.base.size) / 20.0 if isinstance(geometry.base, Box) else 5e-9)
            return mesh_data.export_stl(target)
    else:
        raise TypeError(f"unsupported geometry type: {type(geometry)!r}")

    mesh.export(target)
    return target


def _geometry_to_trimesh(
    geometry: Geometry,
    trimesh: Any,
    cylinder_sections: int = 48,
    *,
    through_thickness_elements: int | None = None,
    through_thickness_distribution: str | None = None,
    through_thickness_element_ratio: float | None = None,
    through_thickness_symmetric: bool = False,
) -> Any:
    """Convert a geometry primitive to a trimesh Trimesh object."""
    if isinstance(geometry, ImportedGeometry):
        return _imported_geometry_to_trimesh(geometry, trimesh)
    if isinstance(geometry, Box):
        return trimesh.creation.box(extents=geometry.size)
    if isinstance(geometry, Cylinder):
        # Build at unit scale first and then scale vertices to SI units.
        # This avoids numerical degeneration for nano-scale dimensions where
        # direct creation can collapse faces to zero in newer trimesh builds.
        mesh = trimesh.creation.cylinder(
            radius=1.0,
            height=1.0,
            sections=cylinder_sections,
        )
        mesh = mesh.copy()
        mesh.vertices[:, 0] *= geometry.radius
        mesh.vertices[:, 1] *= geometry.radius
        mesh.vertices[:, 2] *= geometry.height
        return mesh
    if isinstance(geometry, Ellipsoid):
        mesh = trimesh.creation.icosphere(subdivisions=3, radius=1.0)
        mesh.vertices[:, 0] *= geometry.rx
        mesh.vertices[:, 1] *= geometry.ry
        mesh.vertices[:, 2] *= geometry.rz
        return mesh
    if isinstance(geometry, Ellipse):
        mesh = trimesh.creation.cylinder(radius=1.0, height=1.0, sections=cylinder_sections)
        mesh.vertices[:, 0] *= geometry.rx
        mesh.vertices[:, 1] *= geometry.ry
        mesh.vertices[:, 2] *= geometry.height
        return mesh
    if isinstance(geometry, ArchWaveguide):
        return _arch_waveguide_to_trimesh(
            geometry,
            trimesh,
            sections=cylinder_sections,
            through_thickness_elements=through_thickness_elements,
            through_thickness_distribution=through_thickness_distribution,
            through_thickness_element_ratio=through_thickness_element_ratio,
            through_thickness_symmetric=through_thickness_symmetric,
        )
    if isinstance(geometry, Difference):
        base = _geometry_to_trimesh(
            geometry.base,
            trimesh,
            cylinder_sections,
            through_thickness_elements=through_thickness_elements,
            through_thickness_distribution=through_thickness_distribution,
            through_thickness_element_ratio=through_thickness_element_ratio,
            through_thickness_symmetric=through_thickness_symmetric,
        )
        tool = _geometry_to_trimesh(
            geometry.tool,
            trimesh,
            cylinder_sections,
            through_thickness_elements=through_thickness_elements,
            through_thickness_distribution=through_thickness_distribution,
            through_thickness_element_ratio=through_thickness_element_ratio,
            through_thickness_symmetric=through_thickness_symmetric,
        )
        return base.difference(tool)
    if isinstance(geometry, Union):
        a = _geometry_to_trimesh(
            geometry.a,
            trimesh,
            cylinder_sections,
            through_thickness_elements=through_thickness_elements,
            through_thickness_distribution=through_thickness_distribution,
            through_thickness_element_ratio=through_thickness_element_ratio,
            through_thickness_symmetric=through_thickness_symmetric,
        )
        b = _geometry_to_trimesh(
            geometry.b,
            trimesh,
            cylinder_sections,
            through_thickness_elements=through_thickness_elements,
            through_thickness_distribution=through_thickness_distribution,
            through_thickness_element_ratio=through_thickness_element_ratio,
            through_thickness_symmetric=through_thickness_symmetric,
        )
        return a.union(b)
    if isinstance(geometry, Intersection):
        a = _geometry_to_trimesh(
            geometry.a,
            trimesh,
            cylinder_sections,
            through_thickness_elements=through_thickness_elements,
            through_thickness_distribution=through_thickness_distribution,
            through_thickness_element_ratio=through_thickness_element_ratio,
            through_thickness_symmetric=through_thickness_symmetric,
        )
        b = _geometry_to_trimesh(
            geometry.b,
            trimesh,
            cylinder_sections,
            through_thickness_elements=through_thickness_elements,
            through_thickness_distribution=through_thickness_distribution,
            through_thickness_element_ratio=through_thickness_element_ratio,
            through_thickness_symmetric=through_thickness_symmetric,
        )
        return a.intersection(b)
    if isinstance(geometry, Translate):
        mesh = _geometry_to_trimesh(
            geometry.geometry,
            trimesh,
            cylinder_sections,
            through_thickness_elements=through_thickness_elements,
            through_thickness_distribution=through_thickness_distribution,
            through_thickness_element_ratio=through_thickness_element_ratio,
            through_thickness_symmetric=through_thickness_symmetric,
        )
        mesh = mesh.copy()
        mesh.apply_translation(geometry.offset)
        return mesh
    raise TypeError(f"unsupported geometry for trimesh conversion: {type(geometry)!r}")


def _arch_waveguide_to_trimesh(
    geometry: ArchWaveguide,
    trimesh: Any,
    *,
    sections: int,
    through_thickness_elements: int | None = None,
    through_thickness_distribution: str | None = None,
    through_thickness_element_ratio: float | None = None,
    through_thickness_symmetric: bool = False,
) -> Any:
    n_sections = max(3, int(sections))
    n_layers = max(1, int(through_thickness_elements or 1))
    scale = max(
        geometry.length,
        geometry.width,
        geometry.height,
        abs(geometry.arch_height),
        abs(geometry.z0) + geometry.height,
    )
    length = geometry.length / scale
    width = geometry.width / scale
    height = geometry.height / scale
    arch_height = geometry.arch_height / scale
    z0 = geometry.z0 / scale
    half_l = length * 0.5
    half_w = width * 0.5
    half_h = height * 0.5
    layer_fractions = _through_thickness_layer_fractions(
        n_layers,
        distribution=through_thickness_distribution,
        element_ratio=through_thickness_element_ratio,
        symmetric=through_thickness_symmetric,
    )

    def vid(section_index: int, layer_index: int, side_index: int) -> int:
        return section_index * (n_layers + 1) * 2 + layer_index * 2 + side_index

    vertices: list[tuple[float, float, float]] = []
    for index in range(n_sections):
        t = index / (n_sections - 1)
        x = -half_l + t * length
        z_center = z0 + arch_height * np.sin(np.pi * t)
        for fraction in layer_fractions:
            z = z_center - half_h + height * fraction
            vertices.append((x, -half_w, z))
            vertices.append((x, half_w, z))

    faces: list[tuple[int, int, int]] = []
    for index in range(n_sections - 1):
        a0 = vid(index, 0, 0)
        a1 = vid(index, 0, 1)
        b0 = vid(index + 1, 0, 0)
        b1 = vid(index + 1, 0, 1)
        faces.extend(
            [
                (a0, a1, b1),
                (a0, b1, b0),
            ]
        )
        for layer_index in range(n_layers):
            a_low_y_plus = vid(index, layer_index, 1)
            a_high_y_plus = vid(index, layer_index + 1, 1)
            b_low_y_plus = vid(index + 1, layer_index, 1)
            b_high_y_plus = vid(index + 1, layer_index + 1, 1)
            faces.extend(
                [
                    (a_low_y_plus, a_high_y_plus, b_high_y_plus),
                    (a_low_y_plus, b_high_y_plus, b_low_y_plus),
                ]
            )

            a_low_y_minus = vid(index, layer_index, 0)
            a_high_y_minus = vid(index, layer_index + 1, 0)
            b_low_y_minus = vid(index + 1, layer_index, 0)
            b_high_y_minus = vid(index + 1, layer_index + 1, 0)
            faces.extend(
                [
                    (a_high_y_minus, a_low_y_minus, b_low_y_minus),
                    (a_high_y_minus, b_low_y_minus, b_high_y_minus),
                ]
            )

        top = n_layers
        a_top_y_plus = vid(index, top, 1)
        a_top_y_minus = vid(index, top, 0)
        b_top_y_plus = vid(index + 1, top, 1)
        b_top_y_minus = vid(index + 1, top, 0)
        faces.extend(
            [
                (a_top_y_plus, a_top_y_minus, b_top_y_minus),
                (a_top_y_plus, b_top_y_minus, b_top_y_plus),
            ]
        )

    last_section = n_sections - 1
    for layer_index in range(n_layers):
        first_low_y_minus = vid(0, layer_index, 0)
        first_low_y_plus = vid(0, layer_index, 1)
        first_high_y_minus = vid(0, layer_index + 1, 0)
        first_high_y_plus = vid(0, layer_index + 1, 1)
        faces.extend(
            [
                (first_low_y_minus, first_high_y_plus, first_low_y_plus),
                (first_low_y_minus, first_high_y_minus, first_high_y_plus),
            ]
        )

        last_low_y_minus = vid(last_section, layer_index, 0)
        last_low_y_plus = vid(last_section, layer_index, 1)
        last_high_y_minus = vid(last_section, layer_index + 1, 0)
        last_high_y_plus = vid(last_section, layer_index + 1, 1)
        faces.extend(
            [
                (last_low_y_minus, last_low_y_plus, last_high_y_plus),
                (last_low_y_minus, last_high_y_plus, last_high_y_minus),
            ]
        )

    mesh = trimesh.Trimesh(
        vertices=np.asarray(vertices, dtype=np.float64),
        faces=np.asarray(faces, dtype=np.int64),
        process=True,
    )
    mesh.vertices *= scale
    return mesh


def _through_thickness_layer_fractions(
    n_layers: int,
    *,
    distribution: str | None,
    element_ratio: float | None,
    symmetric: bool,
) -> list[float]:
    if n_layers <= 1:
        return [0.0, 1.0]
    ratio = float(element_ratio) if element_ratio is not None else 1.0
    if distribution not in {"linear", "exponential"} or ratio == 1.0:
        heights = [1.0 / n_layers] * n_layers
    elif symmetric:
        half = n_layers // 2
        middle = n_layers - 2 * half
        half_heights = _through_thickness_layer_heights(
            half,
            distribution=distribution,
            element_ratio=ratio,
        )
        heights = half_heights + ([1.0] if middle else []) + list(reversed(half_heights))
        total = sum(heights)
        heights = [height / total for height in heights]
    else:
        heights = _through_thickness_layer_heights(
            n_layers,
            distribution=distribution,
            element_ratio=ratio,
        )

    fractions = [0.0]
    acc = 0.0
    for height in heights:
        acc += height
        fractions.append(acc)
    fractions[-1] = 1.0
    return fractions


def _through_thickness_layer_heights(
    n_layers: int,
    *,
    distribution: str,
    element_ratio: float,
) -> list[float]:
    if n_layers <= 0:
        return []
    if n_layers == 1:
        return [1.0]
    if distribution == "linear":
        raw = [
            1.0 + (element_ratio - 1.0) * index / (n_layers - 1)
            for index in range(n_layers)
        ]
    elif distribution == "exponential":
        raw = [element_ratio**index for index in range(n_layers)]
    else:
        raw = [1.0] * n_layers
    total = sum(raw)
    return [value / total for value in raw]


def _imported_geometry_to_trimesh(geometry: ImportedGeometry, trimesh: Any) -> Any:
    source = Path(geometry.source)
    if source.suffix.lower() != ".stl":
        raise ValueError(
            "surface preview currently supports ImportedGeometry when the source is STL"
        )

    mesh = trimesh.load_mesh(source, force="mesh")
    mesh = mesh.copy()
    scale = geometry.scale
    if isinstance(scale, (int, float)):
        mesh.apply_scale(float(scale))
    else:
        mesh.vertices *= scale
    return mesh
