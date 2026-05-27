from __future__ import annotations

import math
from typing import Any

from fullmag.model.geometry import ArchWaveguide


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
