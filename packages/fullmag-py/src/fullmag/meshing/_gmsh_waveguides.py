from __future__ import annotations

import hashlib
import math
from typing import Any

from fullmag.model.geometry import (
    ArchWaveguide,
    CPWAntennaLayout,
    MicrostripAntennaLayout,
)


_ANTENNA_TERMINAL_MARKER_BASE = 1_000
_ANTENNA_TERMINAL_MARKER_SPAN = 1_000_000_000
_ANTENNA_TERMINAL_MARKER_SCHEMA = b"fullmag.antenna-terminal-marker.v1\0"


def antenna_terminal_marker(
    object_id: str,
    conductor_part_id: str,
    selector: str,
) -> int:
    """Return the stable MeshIR marker for one authored antenna terminal.

    The marker is deliberately derived from semantic identity rather than
    Gmsh entity ordering.  Rust's surface selector resolver implements the
    same byte-level digest contract.
    """
    normalized_selector = selector.strip().lower()
    if normalized_selector not in {"local_u_min", "local_u_max"}:
        raise ValueError(
            "antenna terminal selector must be local_u_min or local_u_max"
        )
    payload = (
        _ANTENNA_TERMINAL_MARKER_SCHEMA
        + object_id.encode("utf-8")
        + b"\0"
        + conductor_part_id.encode("utf-8")
        + b"\0"
        + normalized_selector.encode("ascii")
    )
    digest = hashlib.sha256(payload).digest()
    value = int.from_bytes(digest[:4], byteorder="big", signed=False)
    return _ANTENNA_TERMINAL_MARKER_BASE + value % _ANTENNA_TERMINAL_MARKER_SPAN


def add_arch_waveguide_to_occ(
    gmsh: Any,
    geometry: ArchWaveguide,
    *,
    scale: float = 1.0,
    sections: int = 65,
) -> list[tuple[int, int]]:
    """Create an ArchWaveguide OCC solid from rectangular vertical sections."""
    n_sections = max(3, int(sections))
    length = geometry.length * scale
    width = geometry.width * scale
    height = geometry.height * scale
    arch_height = geometry.arch_height * scale
    z0 = geometry.z0 * scale
    half_l = length * 0.5
    half_w = width * 0.5
    half_h = height * 0.5

    if math.isclose(arch_height, 0.0, abs_tol=max(abs(height), abs(length), 1.0) * 1e-15):
        tag = gmsh.model.occ.addBox(
            -half_l,
            -half_w,
            z0 - half_h,
            length,
            width,
            height,
        )
        return [(3, tag)]

    wires: list[int] = []
    for index in range(n_sections):
        t = index / (n_sections - 1)
        x = -half_l + t * length
        z_center = z0 + arch_height * math.sin(math.pi * t)
        z_min = z_center - half_h
        z_max = z_center + half_h
        points = [
            gmsh.model.occ.addPoint(x, -half_w, z_min),
            gmsh.model.occ.addPoint(x, half_w, z_min),
            gmsh.model.occ.addPoint(x, half_w, z_max),
            gmsh.model.occ.addPoint(x, -half_w, z_max),
        ]
        lines = [
            gmsh.model.occ.addLine(points[0], points[1]),
            gmsh.model.occ.addLine(points[1], points[2]),
            gmsh.model.occ.addLine(points[2], points[3]),
            gmsh.model.occ.addLine(points[3], points[0]),
        ]
        wires.append(gmsh.model.occ.addWire(lines))

    return list(gmsh.model.occ.addThruSections(wires, makeSolid=True, makeRuled=True))


def add_antenna_layout_to_occ(
    gmsh: Any,
    geometry: MicrostripAntennaLayout | CPWAntennaLayout,
    *,
    scale: float = 1.0,
) -> list[tuple[int, int]]:
    """Create one finite OCC loft solid for each authored conductor part."""
    return [
        dimtag
        for part_tags in add_antenna_layout_parts_to_occ(
            gmsh,
            geometry,
            scale=scale,
        ).values()
        for dimtag in part_tags
    ]


def add_antenna_layout_parts_to_occ(
    gmsh: Any,
    geometry: MicrostripAntennaLayout | CPWAntennaLayout,
    *,
    scale: float = 1.0,
) -> dict[str, list[tuple[int, int]]]:
    """Create OCC loft solids while preserving conductor-part ownership."""
    sections = geometry._sections()
    result: dict[str, list[tuple[int, int]]] = {}
    for part_id in geometry.conductor_part_ids:
        wires: list[int] = []
        for section in sections:
            vertices = section["conductors"][part_id]  # type: ignore[index]
            points = [
                gmsh.model.occ.addPoint(
                    float(vertex[0]) * scale,
                    float(vertex[1]) * scale,
                    float(vertex[2]) * scale,
                )
                for vertex in vertices
            ]
            lines = [
                gmsh.model.occ.addLine(points[index], points[(index + 1) % 4])
                for index in range(4)
            ]
            wires.append(gmsh.model.occ.addWire(lines))
        lofts = gmsh.model.occ.addThruSections(
            wires,
            makeSolid=True,
            makeRuled=True,
        )
        part_tags = [(int(dim), int(tag)) for dim, tag in lofts]
        if not part_tags:
            raise ValueError(
                f"antenna layout '{geometry.geometry_name}' conductor '{part_id}' "
                "has no OCC solid"
            )
        result[part_id] = part_tags
    if not result:
        raise ValueError(f"antenna layout '{geometry.geometry_name}' has no conductor solids")
    return result


def _surface_center(gmsh: Any, surface_tag: int) -> tuple[float, float, float]:
    """Return a stable geometric center with a bounding-box fallback."""
    for owner in (gmsh.model.occ, gmsh.model):
        getter = getattr(owner, "getCenterOfMass", None)
        if getter is not None:
            try:
                center = getter(2, int(surface_tag))
            except Exception:
                continue
            if len(center) == 3 and all(math.isfinite(float(value)) for value in center):
                return tuple(float(value) for value in center)
    bounds = gmsh.model.getBoundingBox(2, int(surface_tag))
    return tuple(
        0.5 * (float(bounds[index]) + float(bounds[index + 3]))
        for index in range(3)
    )


def add_antenna_layout_terminal_physical_groups(
    gmsh: Any,
    geometry: MicrostripAntennaLayout | CPWAntennaLayout,
    part_tags_by_id: dict[str, list[tuple[int, int]]],
    *,
    scale: float = 1.0,
    object_id: str | None = None,
) -> dict[tuple[str, str], int]:
    """Publish volume and inlet/outlet physical groups for a conductor mesh.

    This helper is intended for the independent conductor mesh (without an
    airbox fragment).  Every boundary surface is assigned exactly one group:
    marker ``1`` for ordinary conductor surfaces, or a stable high marker for
    one terminal face.  Overlapping part ownership or missing terminal caps is
    rejected before mesh generation.
    """
    all_volume_tags = [
        int(tag)
        for part_tags in part_tags_by_id.values()
        for dim, tag in part_tags
        if int(dim) == 3
    ]
    if not all_volume_tags:
        raise ValueError(
            f"antenna layout '{geometry.geometry_name}' has no volume tags for physical groups"
        )
    gmsh.model.addPhysicalGroup(3, all_volume_tags, tag=1)
    gmsh.model.setPhysicalName(3, 1, "magnetic")

    axis = tuple(
        float(geometry.transform.rotation_matrix[row][0]) for row in range(3)
    )
    origin = tuple(float(value) * scale for value in geometry.transform.translation_m)
    length = float(geometry.length_m) * scale
    tolerance = max(abs(length) * 1.0e-8, abs(scale) * 1.0e-10, 1.0e-10)

    surfaces_by_part: dict[str, list[int]] = {}
    surface_owner: dict[int, str] = {}
    for part_id in geometry.conductor_part_ids:
        volume_tags = [
            (3, int(tag))
            for dim, tag in part_tags_by_id.get(part_id, [])
            if int(dim) == 3
        ]
        surfaces = sorted(
            {
                abs(int(tag))
                for dim, tag in gmsh.model.getBoundary(volume_tags, oriented=False)
                if int(dim) == 2
            }
        )
        if not surfaces:
            raise ValueError(
                f"antenna layout '{geometry.geometry_name}' conductor '{part_id}' "
                "has no boundary surfaces"
            )
        surfaces_by_part[part_id] = surfaces
        for surface_tag in surfaces:
            previous = surface_owner.setdefault(surface_tag, part_id)
            if previous != part_id:
                raise ValueError(
                    f"antenna layout '{geometry.geometry_name}' shares OCC surface "
                    f"{surface_tag} between conductors '{previous}' and '{part_id}'"
                )

    terminal_tags: dict[tuple[str, str], list[int]] = {}
    for part_id, surfaces in surfaces_by_part.items():
        for selector, target in (("local_u_min", 0.0), ("local_u_max", length)):
            selected = []
            for surface_tag in surfaces:
                center = _surface_center(gmsh, surface_tag)
                projection = sum(
                    (center[index] - origin[index]) * axis[index]
                    for index in range(3)
                )
                if abs(projection - target) <= tolerance:
                    selected.append(surface_tag)
            if not selected:
                raise ValueError(
                    f"antenna layout '{geometry.geometry_name}' conductor '{part_id}' "
                    f"has no OCC surface for terminal selector '{selector}'"
                )
            terminal_tags[(part_id, selector)] = sorted(set(selected))

    terminal_surface_set = {
        surface_tag
        for selected in terminal_tags.values()
        for surface_tag in selected
    }
    ordinary_surfaces = sorted(
        surface_tag
        for surface_tag in surface_owner
        if surface_tag not in terminal_surface_set
    )
    if ordinary_surfaces:
        gmsh.model.addPhysicalGroup(2, ordinary_surfaces, tag=1)
        gmsh.model.setPhysicalName(2, 1, "magnetic_surface")

    markers: dict[tuple[str, str], int] = {}
    seen_markers: dict[int, tuple[str, str]] = {}
    for (part_id, selector), surfaces in sorted(terminal_tags.items()):
        marker = antenna_terminal_marker(
            geometry.geometry_name if object_id is None else object_id,
            part_id,
            selector,
        )
        previous = seen_markers.get(marker)
        if previous is not None and previous != (part_id, selector):
            raise ValueError(
                f"antenna terminal marker collision {marker} between {previous} "
                f"and {(part_id, selector)}"
            )
        seen_markers[marker] = (part_id, selector)
        gmsh.model.addPhysicalGroup(2, surfaces, tag=marker)
        gmsh.model.setPhysicalName(
            2,
            marker,
            f"antenna_terminal:{part_id}:{selector}",
        )
        markers[(part_id, selector)] = marker
    return markers
