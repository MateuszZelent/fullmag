"""Geometry-only mesh build contract consumed by the Rust API (ADR 0074)."""

from __future__ import annotations

import unittest

from fullmag.meshing.geometry_mesh_build import (
    GEOMETRY_MESH_BUILD_SCHEMA,
    GeometryMeshBuildError,
    build_geometry_only_mesh,
)


def _sphere(object_id: str, x: float) -> dict[str, object]:
    # Same shape as the API lowering: geometry name == object_id.
    return {
        "kind": "translate",
        "name": object_id,
        "by": [x, 0.0, 0.0],
        "base": {"kind": "sphere", "name": f"{object_id}_base", "radius": 5e-8},
    }


def _payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "geometries": [_sphere("sphere-left", -6e-8), _sphere("sphere-right", 6e-8)],
        "geometry_object_ids": {"sphere-left": "sphere-left", "sphere-right": "sphere-right"},
        "declared_universe": {
            "mode": "manual",
            "size": [4e-7, 2.4e-7, 2.4e-7],
            "center": [0.0, 0.0, 0.0],
            "airbox_hmax": 3e-8,
        },
        "hmax": 2e-8,
        "order": 1,
        "mesh_name": "study_domain",
        "mesh_options": {"hmin": 3e-9, "optimize": "Netgen", "compute_quality": True},
    }
    payload.update(overrides)
    return payload


class GeometryMeshBuildTests(unittest.TestCase):
    def test_two_spheres_mesh_without_physics_in_mesh_ir_layout(self) -> None:
        result = build_geometry_only_mesh(_payload())

        self.assertEqual(result["schema"], GEOMETRY_MESH_BUILD_SCHEMA)
        mesh = result["mesh"]
        self.assertEqual(mesh["mesh_name"], "study_domain")
        self.assertEqual(set(mesh["cells"]), {"types", "offsets", "nodes", "global_ordinals", "mesh_parts"})
        self.assertEqual(set(mesh["facets"]), {"types", "roles", "offsets", "nodes", "global_ordinals"})
        self.assertEqual(len(mesh["cells"]["types"]), len(mesh["element_markers"]))
        self.assertEqual(len(mesh["cells"]["offsets"]), len(mesh["cells"]["types"]) + 1)
        self.assertNotIn("cell_types", result)
        names = {entry["geometry_name"] for entry in result["region_markers"]}
        self.assertEqual(names, {"sphere-left", "sphere-right"})
        markers = set(mesh["element_markers"])
        self.assertIn(0, markers)
        self.assertTrue({entry["marker"] for entry in result["region_markers"]} <= markers)
        self.assertGreater(result["quality"]["nElements"], 0)
        self.assertEqual(result["mesh_provenance"]["hmax"], 2e-8)

    def test_requires_a_surrounding_air_domain(self) -> None:
        with self.assertRaisesRegex(GeometryMeshBuildError, "Universe size"):
            build_geometry_only_mesh(_payload(declared_universe={"mode": "auto", "padding": [0, 0, 0]}))

    def test_requires_an_authored_maximum_element_size(self) -> None:
        with self.assertRaisesRegex(GeometryMeshBuildError, "h_max"):
            build_geometry_only_mesh(_payload(hmax=None))


if __name__ == "__main__":
    unittest.main()
