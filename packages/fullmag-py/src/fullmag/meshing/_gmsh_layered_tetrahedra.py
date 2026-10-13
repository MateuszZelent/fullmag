"""Conforming tet4 subdivision of vertical, translational prism6 layers.

The coordinate order is shared by cells and surface quads, including periodic
copies. Gmsh's local extrusion order cannot provide that invariant by itself.
"""
from __future__ import annotations

from typing import Any
import numpy as np


def subdivide_layered_prisms(gmsh: Any) -> None:
    """Replace vertical prism6/quad4 by tet4/tri3 without adding nodes.

    Physical entities and regions stay unchanged. This internal realization is
    restricted to axis-aligned z extrusion with triangular source faces.
    """
    tags, coordinates, _ = gmsh.model.mesh.getNodes()
    xyz = np.asarray(coordinates, dtype=float).reshape(-1, 3)
    if not len(xyz) or not np.all(np.isfinite(xyz)):
        raise ValueError("layered subdivision requires finite nonempty coordinates")
    scale = float(np.max(np.abs(xyz)))
    tolerance = 64 * np.finfo(float).eps * scale
    if tolerance == 0:
        raise ValueError("layered subdivision requires a nondegenerate domain")
    indices = {int(tag): i for i, tag in enumerate(tags)}
    # Cluster numerical copies of an axis coordinate before lexicographic order.
    # This prevents tiny Gmsh jitter on a straight boundary changing diagonals.
    ranks = np.empty((len(xyz), 2), dtype=np.int64)
    for axis in (0, 1):
        rank = -1
        anchor = -np.inf
        for i in np.argsort(xyz[:, axis], kind="stable"):
            if xyz[i, axis] - anchor > tolerance:
                rank += 1
                anchor = xyz[i, axis]
            ranks[i, axis] = rank

    def columns(raw: np.ndarray, width: int) -> tuple[list[int], list[int]]:
        nodes = [int(tag) for tag in raw]
        local = sorted(nodes, key=lambda tag: xyz[indices[tag], 2])
        bottom, top = local[:width], local[width:]
        z0, z1 = xyz[indices[bottom[0]], 2], xyz[indices[top[0]], 2]
        if z1 - z0 <= tolerance or any(
            abs(xyz[indices[tag], 2] - z) > tolerance
            for side, z in ((bottom, z0), (top, z1)) for tag in side
        ):
            raise ValueError("layered subdivision requires two horizontal bases")
        key = lambda tag: tuple(ranks[indices[tag]])
        bottom.sort(key=key)
        top.sort(key=key)
        if len({key(tag) for tag in bottom}) != width or any(
            np.max(np.abs(xyz[indices[a], :2] - xyz[indices[b], :2])) > tolerance
            for a, b in zip(bottom, top)
        ):
            raise ValueError("layered subdivision requires matching vertical columns")
        return bottom, top

    replacements = []
    for dim in (3, 2):
        for _, entity in gmsh.model.getEntities(dim):
            types, element_tags, node_tags = gmsh.model.mesh.getElements(dim, entity)
            for kind, old_tags, raw in zip(types, element_tags, node_tags):
                kind = int(kind)
                if (dim, kind) in ((3, 4), (2, 2)):
                    continue
                expected = 6 if dim == 3 else 3
                if kind != expected:
                    raise ValueError("layered subdivision supports only prism6 and quad4")
                output = []
                width = 3 if dim == 3 else 2
                for cell in np.asarray(raw).reshape(-1, width * 2):
                    low, high = columns(cell, width)
                    if dim == 3:
                        a, b, c = low
                        A, B, C = high
                        children = [[a, b, c, C], [a, b, B, C], [a, A, B, C]]
                        for child in children:
                            points = xyz[[indices[tag] for tag in child]]
                            determinant = float(np.linalg.det(points[1:] - points[0]))
                            if not np.isfinite(determinant) or determinant == 0:
                                raise ValueError("layered subdivision produced a degenerate tetrahedron")
                            if determinant < 0:
                                child[0], child[1] = child[1], child[0]
                    else:
                        a, b = low
                        A, B = high
                        children = [[a, b, B], [a, B, A]]
                    output.extend(children)
                replacements.append((dim, entity, old_tags, 4 if dim == 3 else 2, output))
    # Validate the entire input before mutating any Gmsh entity.
    for dim, entity, old_tags, kind, output in replacements:
        gmsh.model.mesh.removeElements(dim, entity, old_tags)
        gmsh.model.mesh.addElementsByType(entity, kind, [], np.asarray(output).reshape(-1))
