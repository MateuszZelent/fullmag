from __future__ import annotations

from dataclasses import dataclass
import math
from pathlib import Path
import shutil
from typing import Any

import numpy as np

from fullmag.model.geometry import (
    ANTENNA_LAYOUT_TYPES,
    AntennaLayout,
    ArchWaveguide,
    Box,
    CPWAntennaLayout,
    Cone,
    Cylinder,
    Difference,
    Ellipse,
    Ellipsoid,
    Geometry,
    ImportedGeometry,
    Intersection,
    MicrostripAntennaLayout,
    PolygonPrism,
    SinWaveguide,
    SlicePlane,
    Torus,
    Transform,
    Translate,
    Union,
    Xor,
    rotation_matrix_from_quaternion,
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


def _rotation_from_z_axis(axis: tuple[float, float, float]) -> np.ndarray:
    target = np.asarray(axis, dtype=np.float64)
    norm = float(np.linalg.norm(target))
    if not math.isfinite(norm) or norm <= 0.0:
        raise ValueError("axis must be a non-zero finite vector")
    target = target / norm
    source = np.asarray((0.0, 0.0, 1.0), dtype=np.float64)
    dot = float(np.clip(np.dot(source, target), -1.0, 1.0))
    if dot > 1.0 - 1e-12:
        return np.eye(4, dtype=np.float64)
    if dot < -1.0 + 1e-12:
        transform = np.eye(4, dtype=np.float64)
        transform[:3, :3] = np.diag((1.0, -1.0, -1.0))
        return transform

    v = np.cross(source, target)
    vx = np.asarray(
        (
            (0.0, -v[2], v[1]),
            (v[2], 0.0, -v[0]),
            (-v[1], v[0], 0.0),
        ),
        dtype=np.float64,
    )
    rotation = np.eye(3, dtype=np.float64) + vx + vx @ vx * (1.0 / (1.0 + dot))
    transform = np.eye(4, dtype=np.float64)
    transform[:3, :3] = rotation
    return transform


def _apply_axis_orientation(mesh: Any, axis: tuple[float, float, float]) -> Any:
    if axis == (0.0, 0.0, 1.0):
        return mesh
    mesh = mesh.copy()
    mesh.apply_transform(_rotation_from_z_axis(axis))
    return mesh


def _coaxial_cylinder_difference(geometry: Difference) -> tuple[Cylinder, Cylinder] | None:
    if not isinstance(geometry.base, Cylinder) or not isinstance(geometry.tool, Cylinder):
        return None
    outer = geometry.base
    inner = geometry.tool
    if outer.axis != inner.axis:
        return None
    if not math.isclose(outer.height, inner.height, rel_tol=1e-12, abs_tol=0.0):
        return None
    if not outer.radius > inner.radius > 0.0:
        return None
    return outer, inner


def _annular_cylinder_to_trimesh(
    trimesh: Any,
    outer: Cylinder,
    inner: Cylinder,
    *,
    sections: int,
) -> Any:
    n = max(3, int(sections))
    angles = np.linspace(0.0, 2.0 * math.pi, n, endpoint=False, dtype=np.float64)
    z_bottom = -0.5
    z_top = 0.5
    inner_radius = inner.radius / outer.radius

    vertices: list[tuple[float, float, float]] = []
    for z in (z_bottom, z_top):
        for radius in (1.0, inner_radius):
            vertices.extend(
                (float(radius * math.cos(angle)), float(radius * math.sin(angle)), float(z))
                for angle in angles
            )

    outer_bottom = 0
    inner_bottom = n
    outer_top = 2 * n
    inner_top = 3 * n
    faces: list[tuple[int, int, int]] = []
    for i in range(n):
        j = (i + 1) % n
        ob_i, ob_j = outer_bottom + i, outer_bottom + j
        ib_i, ib_j = inner_bottom + i, inner_bottom + j
        ot_i, ot_j = outer_top + i, outer_top + j
        it_i, it_j = inner_top + i, inner_top + j

        faces.extend(
            [
                (ob_i, ob_j, ot_j),
                (ob_i, ot_j, ot_i),
                (ib_i, it_j, ib_j),
                (ib_i, it_i, it_j),
                (ot_i, ot_j, it_j),
                (ot_i, it_j, it_i),
                (ob_i, ib_j, ob_j),
                (ob_i, ib_i, ib_j),
            ]
        )

    mesh = trimesh.Trimesh(
        vertices=np.asarray(vertices, dtype=np.float64),
        faces=np.asarray(faces, dtype=np.int64),
        process=True,
    )
    mesh.vertices[:, 0] *= outer.radius
    mesh.vertices[:, 1] *= outer.radius
    mesh.vertices[:, 2] *= outer.height
    return _apply_axis_orientation(mesh, outer.axis)


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

    flat_faces = [int(node) for face in faces.tolist() for node in face]
    face_count = len(faces)
    return {
        "nodes": [[float(x), float(y), float(z)] for x, y, z in vertices.tolist()],
        "cell_types": [],
        "cell_offsets": [0],
        "cell_nodes": [],
        "facet_types": ["tri3"] * face_count,
        "facet_roles": ["exterior"] * face_count,
        "facet_offsets": list(range(0, face_count * 3 + 1, 3)),
        "facet_nodes": flat_faces,
    }


def _antenna_layout_to_trimesh(
    geometry: AntennaLayout,
    trimesh: Any,
) -> Any:
    """Build a watertight preview mesh for every conductor in a layout.

    The layout owns already-transformed section vertices, so this helper only
    connects adjacent sections.  It deliberately stays a presentation mesh;
    conductor part identity remains in the typed layout/IR and is not inferred
    from triangle ordering.
    """
    sections = geometry._sections()
    vertices: list[tuple[float, float, float]] = []
    faces: list[tuple[int, int, int]] = []
    for part_id in geometry.conductor_part_ids:
        part_sections = [
            tuple(section["conductors"][part_id])  # type: ignore[index]
            for section in sections
        ]
        offset = len(vertices)
        vertices.extend(vertex for section in part_sections for vertex in section)
        section_count = len(part_sections)
        for index in range(section_count - 1):
            start = offset + index * 4
            end = start + 4
            for edge in range(4):
                a0 = start + edge
                a1 = start + (edge + 1) % 4
                b0 = end + edge
                b1 = end + (edge + 1) % 4
                faces.extend(((a0, a1, b1), (a0, b1, b0)))
        first = offset
        last = offset + (section_count - 1) * 4
        faces.extend(
            (
                (first, first + 1, first + 2),
                (first, first + 2, first + 3),
                (last, last + 2, last + 1),
                (last, last + 3, last + 2),
            )
        )
    if not vertices or not faces:
        raise ValueError("antenna layout has no conductor sections")
    return trimesh.Trimesh(
        vertices=np.asarray(vertices, dtype=np.float64),
        faces=np.asarray(faces, dtype=np.int64),
        process=False,
    )


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
    elif isinstance(geometry, ANTENNA_LAYOUT_TYPES):
        mesh = _antenna_layout_to_trimesh(geometry, trimesh)
    elif isinstance(geometry, Cylinder):
        mesh = trimesh.creation.cylinder(
            radius=geometry.radius,
            height=geometry.height,
            sections=cylinder_sections,
        )
        mesh = _apply_axis_orientation(mesh, geometry.axis)
    elif isinstance(geometry, Difference):
        coaxial = _coaxial_cylinder_difference(geometry)
        if coaxial is not None:
            mesh = _annular_cylinder_to_trimesh(
                trimesh,
                coaxial[0],
                coaxial[1],
                sections=cylinder_sections,
            )
            mesh.export(target)
            return target
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
    surface_maximum_element_size: float | None = None,
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
        return _apply_axis_orientation(mesh, geometry.axis)
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
    if isinstance(geometry, Cone):
        return _cone_to_trimesh(geometry, trimesh, sections=cylinder_sections)
    if isinstance(geometry, Torus):
        return _torus_to_trimesh(geometry, trimesh, sections=cylinder_sections)
    if isinstance(geometry, PolygonPrism):
        return _polygon_prism_to_trimesh(geometry, trimesh)
    if isinstance(geometry, ArchWaveguide):
        return _arch_waveguide_to_trimesh(
            geometry,
            trimesh,
            sections=cylinder_sections,
            surface_maximum_element_size=surface_maximum_element_size,
            through_thickness_elements=through_thickness_elements,
            through_thickness_distribution=through_thickness_distribution,
            through_thickness_element_ratio=through_thickness_element_ratio,
            through_thickness_symmetric=through_thickness_symmetric,
        )
    if isinstance(geometry, SinWaveguide):
        return _sin_waveguide_to_trimesh(
            geometry,
            trimesh,
            sections=cylinder_sections,
            surface_maximum_element_size=surface_maximum_element_size,
            through_thickness_elements=through_thickness_elements,
            through_thickness_distribution=through_thickness_distribution,
            through_thickness_element_ratio=through_thickness_element_ratio,
            through_thickness_symmetric=through_thickness_symmetric,
        )
    if isinstance(geometry, ANTENNA_LAYOUT_TYPES):
        return _antenna_layout_to_trimesh(geometry, trimesh)
    if isinstance(geometry, Difference):
        coaxial = _coaxial_cylinder_difference(geometry)
        if coaxial is not None:
            return _annular_cylinder_to_trimesh(
                trimesh,
                coaxial[0],
                coaxial[1],
                sections=cylinder_sections,
            )
        base = _geometry_to_trimesh(
            geometry.base,
            trimesh,
            cylinder_sections,
            surface_maximum_element_size=surface_maximum_element_size,
            through_thickness_elements=through_thickness_elements,
            through_thickness_distribution=through_thickness_distribution,
            through_thickness_element_ratio=through_thickness_element_ratio,
            through_thickness_symmetric=through_thickness_symmetric,
        )
        tool = _geometry_to_trimesh(
            geometry.tool,
            trimesh,
            cylinder_sections,
            surface_maximum_element_size=surface_maximum_element_size,
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
            surface_maximum_element_size=surface_maximum_element_size,
            through_thickness_elements=through_thickness_elements,
            through_thickness_distribution=through_thickness_distribution,
            through_thickness_element_ratio=through_thickness_element_ratio,
            through_thickness_symmetric=through_thickness_symmetric,
        )
        b = _geometry_to_trimesh(
            geometry.b,
            trimesh,
            cylinder_sections,
            surface_maximum_element_size=surface_maximum_element_size,
            through_thickness_elements=through_thickness_elements,
            through_thickness_distribution=through_thickness_distribution,
            through_thickness_element_ratio=through_thickness_element_ratio,
            through_thickness_symmetric=through_thickness_symmetric,
        )
        try:
            return a.union(b)
        except ImportError:
            return trimesh.util.concatenate([a, b])
    if isinstance(geometry, Intersection):
        a = _geometry_to_trimesh(
            geometry.a,
            trimesh,
            cylinder_sections,
            surface_maximum_element_size=surface_maximum_element_size,
            through_thickness_elements=through_thickness_elements,
            through_thickness_distribution=through_thickness_distribution,
            through_thickness_element_ratio=through_thickness_element_ratio,
            through_thickness_symmetric=through_thickness_symmetric,
        )
        b = _geometry_to_trimesh(
            geometry.b,
            trimesh,
            cylinder_sections,
            surface_maximum_element_size=surface_maximum_element_size,
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
            surface_maximum_element_size=surface_maximum_element_size,
            through_thickness_elements=through_thickness_elements,
            through_thickness_distribution=through_thickness_distribution,
            through_thickness_element_ratio=through_thickness_element_ratio,
            through_thickness_symmetric=through_thickness_symmetric,
        )
        mesh = mesh.copy()
        mesh.apply_translation(geometry.offset)
        return mesh
    if isinstance(geometry, Xor):
        left = _geometry_to_trimesh(
            geometry.left,
            trimesh,
            cylinder_sections,
            surface_maximum_element_size=surface_maximum_element_size,
            through_thickness_elements=through_thickness_elements,
            through_thickness_distribution=through_thickness_distribution,
            through_thickness_element_ratio=through_thickness_element_ratio,
            through_thickness_symmetric=through_thickness_symmetric,
        )
        right = _geometry_to_trimesh(
            geometry.right,
            trimesh,
            cylinder_sections,
            surface_maximum_element_size=surface_maximum_element_size,
            through_thickness_elements=through_thickness_elements,
            through_thickness_distribution=through_thickness_distribution,
            through_thickness_element_ratio=through_thickness_element_ratio,
            through_thickness_symmetric=through_thickness_symmetric,
        )
        try:
            a_only = left.difference(right)
            b_only = right.difference(left)
            return a_only.union(b_only)
        except Exception:
            return trimesh.util.concatenate([left, right])
    if isinstance(geometry, Transform):
        mesh = _geometry_to_trimesh(
            geometry.child,
            trimesh,
            cylinder_sections,
            surface_maximum_element_size=surface_maximum_element_size,
            through_thickness_elements=through_thickness_elements,
            through_thickness_distribution=through_thickness_distribution,
            through_thickness_element_ratio=through_thickness_element_ratio,
            through_thickness_symmetric=through_thickness_symmetric,
        )
        mesh = mesh.copy()
        rot = np.asarray(rotation_matrix_from_quaternion(geometry.rotation_quat), dtype=np.float64)
        s = np.asarray(geometry.scale, dtype=np.float64)
        p = np.asarray(geometry.pivot, dtype=np.float64)
        t = np.asarray(geometry.translation, dtype=np.float64)
        verts = np.asarray(mesh.vertices, dtype=np.float64)
        mesh.vertices = ((verts - p) * s) @ rot.T + p + t
        return mesh
    if isinstance(geometry, SlicePlane):
        mesh = _geometry_to_trimesh(
            geometry.child,
            trimesh,
            cylinder_sections,
            surface_maximum_element_size=surface_maximum_element_size,
            through_thickness_elements=through_thickness_elements,
            through_thickness_distribution=through_thickness_distribution,
            through_thickness_element_ratio=through_thickness_element_ratio,
            through_thickness_symmetric=through_thickness_symmetric,
        )
        normal = np.asarray(geometry.plane_normal, dtype=np.float64)
        if geometry.keep_side == "negative":
            normal = -normal
        origin = np.asarray(geometry.plane_origin, dtype=np.float64)
        return _slice_trimesh_halfspace(mesh, trimesh, plane_origin=origin, plane_normal=normal)
    raise TypeError(f"unsupported geometry for trimesh conversion: {type(geometry)!r}")


def _slice_trimesh_halfspace(
    mesh: Any,
    trimesh: Any,
    *,
    plane_origin: np.ndarray,
    plane_normal: np.ndarray,
) -> Any:
    """Clip a triangle mesh to ``(p - plane_origin) . plane_normal >= 0`` without shapely."""
    verts = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.faces, dtype=np.int64)
    if verts.size == 0 or faces.size == 0:
        return None
    norm = float(np.linalg.norm(plane_normal))
    if not math.isfinite(norm) or norm <= 0.0:
        raise ValueError("plane_normal must be non-zero and finite")
    n_vec = plane_normal / norm
    distances = (verts - plane_origin) @ n_vec

    out_vertices: list[tuple[float, float, float]] = []
    out_faces: list[tuple[int, int, int]] = []
    cut_segments: list[tuple[np.ndarray, np.ndarray]] = []

    def _add_v(pt: np.ndarray) -> int:
        idx = len(out_vertices)
        out_vertices.append((float(pt[0]), float(pt[1]), float(pt[2])))
        return idx

    def _interp(p_a: np.ndarray, d_a: float, p_b: np.ndarray, d_b: float) -> np.ndarray:
        t = d_a / (d_a - d_b)
        return p_a + t * (p_b - p_a)

    for tri in faces:
        pts = [verts[int(tri[0])], verts[int(tri[1])], verts[int(tri[2])]]
        ds = [float(distances[int(tri[0])]), float(distances[int(tri[1])]), float(distances[int(tri[2])])]
        inside = [d >= 0.0 for d in ds]
        n_in = sum(inside)
        if n_in == 0:
            continue
        if n_in == 3:
            i0, i1, i2 = _add_v(pts[0]), _add_v(pts[1]), _add_v(pts[2])
            out_faces.append((i0, i1, i2))
        elif n_in == 1:
            k = inside.index(True)
            a, b, c = k, (k + 1) % 3, (k + 2) % 3
            p_ab = _interp(pts[a], ds[a], pts[b], ds[b])
            p_ac = _interp(pts[a], ds[a], pts[c], ds[c])
            out_faces.append((_add_v(pts[a]), _add_v(p_ab), _add_v(p_ac)))
            cut_segments.append((p_ab, p_ac))
        else:
            k = inside.index(False)
            a, b, c = (k + 1) % 3, (k + 2) % 3, k
            p_ac = _interp(pts[a], ds[a], pts[c], ds[c])
            p_bc = _interp(pts[b], ds[b], pts[c], ds[c])
            ia, ib, iac, ibc = _add_v(pts[a]), _add_v(pts[b]), _add_v(p_ac), _add_v(p_bc)
            out_faces.append((ia, ib, ibc))
            out_faces.append((ia, ibc, iac))
            cut_segments.append((p_bc, p_ac))

    if not out_faces:
        return None

    # Cap cut plane with fan triangles oriented with outward normal -n_vec
    if cut_segments:
        cap_pts = np.asarray([pt for seg in cut_segments for pt in seg], dtype=np.float64)
        centroid = cap_pts.mean(axis=0)
        c_idx = _add_v(centroid)
        for p0, p1 in cut_segments:
            i0, i1 = _add_v(p0), _add_v(p1)
            tri_n = np.cross(p1 - centroid, p0 - centroid)
            if float(np.dot(tri_n, -n_vec)) >= 0.0:
                out_faces.append((c_idx, i1, i0))
            else:
                out_faces.append((c_idx, i0, i1))

    return trimesh.Trimesh(
        vertices=np.asarray(out_vertices, dtype=np.float64),
        faces=np.asarray(out_faces, dtype=np.int64),
        process=False,
    )


def _cone_to_trimesh(geometry: Cone, trimesh: Any, *, sections: int = 48) -> Any:
    n = max(12, int(sections))
    half_h = 0.5 * geometry.height
    rb = geometry.radius_bottom
    rt = geometry.radius_top
    angles = np.linspace(0.0, 2.0 * np.pi, n, endpoint=False)
    cos_a = np.cos(angles)
    sin_a = np.sin(angles)

    vertices: list[tuple[float, float, float]] = []
    faces: list[tuple[int, int, int]] = []
    if rb > 0.0 and rt > 0.0:
        for i in range(n):
            vertices.append((float(rb * cos_a[i]), float(rb * sin_a[i]), -half_h))
        for i in range(n):
            vertices.append((float(rt * cos_a[i]), float(rt * sin_a[i]), half_h))
        bot_center = len(vertices)
        vertices.append((0.0, 0.0, -half_h))
        top_center = len(vertices)
        vertices.append((0.0, 0.0, half_h))
        for i in range(n):
            nxt = (i + 1) % n
            b0, b1 = i, nxt
            t0, t1 = n + i, n + nxt
            faces.append((b0, b1, t1))
            faces.append((b0, t1, t0))
            faces.append((bot_center, b1, b0))
            faces.append((top_center, t0, t1))
    elif rb > 0.0:
        for i in range(n):
            vertices.append((float(rb * cos_a[i]), float(rb * sin_a[i]), -half_h))
        bot_center = len(vertices)
        vertices.append((0.0, 0.0, -half_h))
        apex = len(vertices)
        vertices.append((0.0, 0.0, half_h))
        for i in range(n):
            nxt = (i + 1) % n
            faces.append((i, nxt, apex))
            faces.append((bot_center, nxt, i))
    else:
        for i in range(n):
            vertices.append((float(rt * cos_a[i]), float(rt * sin_a[i]), half_h))
        top_center = len(vertices)
        vertices.append((0.0, 0.0, half_h))
        apex = len(vertices)
        vertices.append((0.0, 0.0, -half_h))
        for i in range(n):
            nxt = (i + 1) % n
            faces.append((apex, nxt, i))
            faces.append((top_center, i, nxt))
    mesh = trimesh.Trimesh(
        vertices=np.asarray(vertices, dtype=np.float64),
        faces=np.asarray(faces, dtype=np.int64),
        process=True,
    )
    return _apply_axis_orientation(mesh, geometry.axis)


def _torus_to_trimesh(geometry: Torus, trimesh: Any, *, sections: int = 48) -> Any:
    nu = max(16, int(sections))
    nv = max(12, int(sections // 2))
    r_maj = geometry.major_radius
    r_min = geometry.minor_radius
    u = np.linspace(0.0, 2.0 * np.pi, nu, endpoint=False)
    v = np.linspace(0.0, 2.0 * np.pi, nv, endpoint=False)
    vertices: list[tuple[float, float, float]] = []
    for ui in u:
        cu, su = math.cos(float(ui)), math.sin(float(ui))
        for vj in v:
            cv, sv = math.cos(float(vj)), math.sin(float(vj))
            ring_r = r_maj + r_min * cv
            vertices.append((ring_r * cu, ring_r * su, r_min * sv))
    faces: list[tuple[int, int, int]] = []
    for i in range(nu):
        ni = (i + 1) % nu
        for j in range(nv):
            nj = (j + 1) % nv
            a = i * nv + j
            b = ni * nv + j
            c = ni * nv + nj
            d = i * nv + nj
            faces.append((a, b, c))
            faces.append((a, c, d))
    mesh = trimesh.Trimesh(
        vertices=np.asarray(vertices, dtype=np.float64),
        faces=np.asarray(faces, dtype=np.int64),
        process=True,
    )
    return _apply_axis_orientation(mesh, geometry.axis)


def _triangulate_simple_polygon_2d(pts: list[tuple[float, float]]) -> list[tuple[int, int, int]]:
    """Ear-clipping triangulation for a simple 2D polygon (returned in CCW winding)."""
    n = len(pts)
    if n < 3:
        return []
    area2 = sum(pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1] for i in range(n))
    indices = list(range(n)) if area2 > 0.0 else list(reversed(range(n)))

    def _cross(a: tuple[float, float], b: tuple[float, float], c: tuple[float, float]) -> float:
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

    def _point_in_tri(p: tuple[float, float], a: tuple[float, float], b: tuple[float, float], c: tuple[float, float]) -> bool:
        c1 = _cross(a, b, p)
        c2 = _cross(b, c, p)
        c3 = _cross(c, a, p)
        return c1 >= -1e-18 and c2 >= -1e-18 and c3 >= -1e-18

    triangles: list[tuple[int, int, int]] = []
    guard = n * n + 4
    while len(indices) > 3 and guard > 0:
        guard -= 1
        ear_found = False
        m = len(indices)
        for idx in range(m):
            i_prev = indices[(idx - 1) % m]
            i_curr = indices[idx]
            i_next = indices[(idx + 1) % m]
            a, b, c = pts[i_prev], pts[i_curr], pts[i_next]
            if _cross(a, b, c) <= 0.0:
                continue
            if any(
                _point_in_tri(pts[other], a, b, c)
                for other in indices
                if other not in (i_prev, i_curr, i_next)
            ):
                continue
            triangles.append((i_prev, i_curr, i_next))
            del indices[idx]
            ear_found = True
            break
        if not ear_found:
            break
    if len(indices) == 3:
        triangles.append((indices[0], indices[1], indices[2]))
    return triangles


def _polygon_prism_to_trimesh(geometry: PolygonPrism, trimesh: Any) -> Any:
    pts = list(geometry.vertices_xy)
    n = len(pts)
    area2 = sum(pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1] for i in range(n))
    if area2 < 0.0:
        pts = list(reversed(pts))
    half_t = 0.5 * geometry.thickness
    vertices: list[tuple[float, float, float]] = [
        (x, y, -half_t) for x, y in pts
    ] + [
        (x, y, half_t) for x, y in pts
    ]
    tris_2d = _triangulate_simple_polygon_2d(pts)
    faces: list[tuple[int, int, int]] = []
    # Bottom cap (downward normal -> reverse CCW)
    for a, b, c in tris_2d:
        faces.append((a, c, b))
    # Top cap (upward normal -> CCW)
    for a, b, c in tris_2d:
        faces.append((n + a, n + b, n + c))
    # Side walls
    for i in range(n):
        nxt = (i + 1) % n
        faces.append((i, nxt, n + nxt))
        faces.append((i, n + nxt, n + i))
    return trimesh.Trimesh(
        vertices=np.asarray(vertices, dtype=np.float64),
        faces=np.asarray(faces, dtype=np.int64),
        process=True,
    )


def _sin_waveguide_to_trimesh(
    geometry: SinWaveguide,
    trimesh: Any,
    *,
    sections: int = 65,
    surface_maximum_element_size: float | None = None,
    through_thickness_elements: int | None = None,
    through_thickness_distribution: str | None = None,
    through_thickness_element_ratio: float | None = None,
    through_thickness_symmetric: bool = False,
) -> Any:
    periods = max(1.0, abs(geometry.length / geometry.period))
    n_sections = max(33, int(sections), int(math.ceil(periods * 24.0)) + 1)
    n_width = 1
    if (
        surface_maximum_element_size is not None
        and math.isfinite(float(surface_maximum_element_size))
        and float(surface_maximum_element_size) > 0.0
    ):
        h_surface = float(surface_maximum_element_size)
        n_sections = max(n_sections, int(math.ceil(float(geometry.length) / h_surface)) + 1)
        n_width = max(1, int(math.ceil(float(geometry.width) / h_surface)))
    n_layers = max(1, int(through_thickness_elements or 1))
    scale = max(
        geometry.length,
        geometry.width,
        geometry.height,
        abs(geometry.amplitude),
        abs(geometry.z0) + geometry.height,
    )
    length = geometry.length / scale
    width = geometry.width / scale
    height = geometry.height / scale
    period = geometry.period / scale
    amplitude = geometry.amplitude / scale
    phase = geometry.phase
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
    y_count = n_width + 1

    def vid(section_index: int, layer_index: int, y_index: int) -> int:
        return section_index * (n_layers + 1) * y_count + layer_index * y_count + y_index

    vertices: list[tuple[float, float, float]] = []
    for index in range(n_sections):
        t = index / (n_sections - 1)
        x = -half_l + t * length
        z_center = z0 + amplitude * math.sin((2.0 * math.pi / period) * x + phase)
        for fraction in layer_fractions:
            z = z_center - half_h + height * fraction
            for y_index in range(y_count):
                y_t = y_index / n_width
                y = -half_w + y_t * width
                vertices.append((x, y, z))

    faces: list[tuple[int, int, int]] = []
    for index in range(n_sections - 1):
        for y_index in range(n_width):
            a0 = vid(index, 0, y_index)
            a1 = vid(index, 0, y_index + 1)
            b0 = vid(index + 1, 0, y_index)
            b1 = vid(index + 1, 0, y_index + 1)
            faces.extend([(a0, a1, b1), (a0, b1, b0)])
            top = n_layers
            a_top0 = vid(index, top, y_index)
            a_top1 = vid(index, top, y_index + 1)
            b_top0 = vid(index + 1, top, y_index)
            b_top1 = vid(index + 1, top, y_index + 1)
            faces.extend([(a_top1, a_top0, b_top0), (a_top1, b_top0, b_top1)])
        for layer_index in range(n_layers):
            a_lp = vid(index, layer_index, n_width)
            a_hp = vid(index, layer_index + 1, n_width)
            b_lp = vid(index + 1, layer_index, n_width)
            b_hp = vid(index + 1, layer_index + 1, n_width)
            faces.extend([(a_lp, a_hp, b_hp), (a_lp, b_hp, b_lp)])
            a_lm = vid(index, layer_index, 0)
            a_hm = vid(index, layer_index + 1, 0)
            b_lm = vid(index + 1, layer_index, 0)
            b_hm = vid(index + 1, layer_index + 1, 0)
            faces.extend([(a_hm, a_lm, b_lm), (a_hm, b_lm, b_hm)])

    last_section = n_sections - 1
    for layer_index in range(n_layers):
        for y_index in range(n_width):
            f_l0 = vid(0, layer_index, y_index)
            f_l1 = vid(0, layer_index, y_index + 1)
            f_h0 = vid(0, layer_index + 1, y_index)
            f_h1 = vid(0, layer_index + 1, y_index + 1)
            faces.extend([(f_l0, f_h1, f_l1), (f_l0, f_h0, f_h1)])
            l_l0 = vid(last_section, layer_index, y_index)
            l_l1 = vid(last_section, layer_index, y_index + 1)
            l_h0 = vid(last_section, layer_index + 1, y_index)
            l_h1 = vid(last_section, layer_index + 1, y_index + 1)
            faces.extend([(l_l0, l_l1, l_h1), (l_l0, l_h1, l_h0)])

    mesh = trimesh.Trimesh(
        vertices=np.asarray(vertices, dtype=np.float64),
        faces=np.asarray(faces, dtype=np.int64),
        process=True,
    )
    mesh.vertices *= scale
    return mesh


def _arch_waveguide_to_trimesh(
    geometry: ArchWaveguide,
    trimesh: Any,
    *,
    sections: int,
    surface_maximum_element_size: float | None = None,
    through_thickness_elements: int | None = None,
    through_thickness_distribution: str | None = None,
    through_thickness_element_ratio: float | None = None,
    through_thickness_symmetric: bool = False,
) -> Any:
    n_sections = max(3, int(sections))
    n_width = 1
    if (
        surface_maximum_element_size is not None
        and math.isfinite(float(surface_maximum_element_size))
        and float(surface_maximum_element_size) > 0.0
    ):
        h_surface = float(surface_maximum_element_size)
        n_sections = max(n_sections, int(math.ceil(float(geometry.length) / h_surface)) + 1)
        n_width = max(1, int(math.ceil(float(geometry.width) / h_surface)))
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

    y_count = n_width + 1

    def vid(section_index: int, layer_index: int, y_index: int) -> int:
        return section_index * (n_layers + 1) * y_count + layer_index * y_count + y_index

    vertices: list[tuple[float, float, float]] = []
    for index in range(n_sections):
        t = index / (n_sections - 1)
        x = -half_l + t * length
        z_center = z0 + arch_height * np.sin(np.pi * t)
        for fraction in layer_fractions:
            z = z_center - half_h + height * fraction
            for y_index in range(y_count):
                y_t = y_index / n_width
                y = -half_w + y_t * width
                vertices.append((x, y, z))

    faces: list[tuple[int, int, int]] = []
    for index in range(n_sections - 1):
        for y_index in range(n_width):
            a0 = vid(index, 0, y_index)
            a1 = vid(index, 0, y_index + 1)
            b0 = vid(index + 1, 0, y_index)
            b1 = vid(index + 1, 0, y_index + 1)
            faces.extend(
                [
                    (a0, a1, b1),
                    (a0, b1, b0),
                ]
            )
            top = n_layers
            a_top0 = vid(index, top, y_index)
            a_top1 = vid(index, top, y_index + 1)
            b_top0 = vid(index + 1, top, y_index)
            b_top1 = vid(index + 1, top, y_index + 1)
            faces.extend(
                [
                    (a_top1, a_top0, b_top0),
                    (a_top1, b_top0, b_top1),
                ]
            )
        for layer_index in range(n_layers):
            a_low_y_plus = vid(index, layer_index, n_width)
            a_high_y_plus = vid(index, layer_index + 1, n_width)
            b_low_y_plus = vid(index + 1, layer_index, n_width)
            b_high_y_plus = vid(index + 1, layer_index + 1, n_width)
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

    last_section = n_sections - 1
    for layer_index in range(n_layers):
        for y_index in range(n_width):
            first_low0 = vid(0, layer_index, y_index)
            first_low1 = vid(0, layer_index, y_index + 1)
            first_high0 = vid(0, layer_index + 1, y_index)
            first_high1 = vid(0, layer_index + 1, y_index + 1)
            faces.extend(
                [
                    (first_low0, first_high1, first_low1),
                    (first_low0, first_high0, first_high1),
                ]
            )

            last_low0 = vid(last_section, layer_index, y_index)
            last_low1 = vid(last_section, layer_index, y_index + 1)
            last_high0 = vid(last_section, layer_index + 1, y_index)
            last_high1 = vid(last_section, layer_index + 1, y_index + 1)
            faces.extend(
                [
                    (last_low0, last_low1, last_high1),
                    (last_low0, last_high1, last_high0),
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
