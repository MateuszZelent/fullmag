#!/usr/bin/env python3
"""Generate deterministic 1, 8, and 64 tetra affine-fixture meshes."""

from __future__ import annotations

import json
from pathlib import Path


BASE = ((-1e-8, -5e-9, -5e-9), (1e-8, -5e-9, -5e-9), (0.0, 5e-9, -5e-9), (-1e-8, -5e-9, 5e-9))


def key(point: tuple[float, float, float]) -> tuple[float, float, float]:
    return tuple(round(value, 20) for value in point)


def midpoint(a: tuple[float, float, float], b: tuple[float, float, float]) -> tuple[float, float, float]:
    return tuple((x + y) / 2 for x, y in zip(a, b, strict=True))


def refined(level: int) -> tuple[list[tuple[float, float, float]], list[tuple[int, int, int, int]]]:
    nodes = list(BASE)
    tets = [(0, 1, 2, 3)]
    for _ in range(level):
        index = {key(point): i for i, point in enumerate(nodes)}
        def node(point: tuple[float, float, float]) -> int:
            marker = key(point)
            if marker not in index:
                index[marker] = len(nodes)
                nodes.append(point)
            return index[marker]
        next_tets: list[tuple[int, int, int, int]] = []
        for a, b, c, d in tets:
            ab, ac, ad = node(midpoint(nodes[a], nodes[b])), node(midpoint(nodes[a], nodes[c])), node(midpoint(nodes[a], nodes[d]))
            bc, bd, cd = node(midpoint(nodes[b], nodes[c])), node(midpoint(nodes[b], nodes[d])), node(midpoint(nodes[c], nodes[d]))
            next_tets.extend(((a, ab, ac, ad), (ab, b, bc, bd), (ac, bc, c, cd), (ad, bd, cd, d), (ab, ac, ad, bd), (ab, ac, bc, bd), (ac, ad, bd, cd), (ac, bc, bd, cd)))
        tets = next_tets
    return nodes, tets


def boundary_faces(tets: list[tuple[int, int, int, int]]) -> list[list[int]]:
    faces: dict[tuple[int, int, int], int] = {}
    for a, b, c, d in tets:
        for face in ((a, b, c), (a, b, d), (a, c, d), (b, c, d)):
            ordered = tuple(sorted(face))
            faces[ordered] = faces.get(ordered, 0) + 1
    return [list(face) for face, count in sorted(faces.items()) if count == 1]


def main() -> None:
    output = Path(__file__).resolve().parents[1] / "examples/assets"
    for level in range(3):
        nodes, tets = refined(level)
        faces = boundary_faces(tets)
        payload = {"mesh_name": f"zhang_li_skew_tetra_r{level}", "nodes": nodes, "elements": tets, "element_markers": [1] * len(tets), "boundary_faces": faces, "boundary_markers": [1] * len(faces)}
        (output / f"zhang_li_skew_tetra_r{level}.mesh.json").write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
