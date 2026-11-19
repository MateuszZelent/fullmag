"""The air policy must never coarsen magnetic bodies (docs/physics/0102).

Regression for the UI scenario of two spheres in a declared universe: a
study-default body target finer than ``airbox_hmax`` was reported in the
build report but not realized, so the spheres were meshed at the air size.
"""

from __future__ import annotations

import math
import unittest

import numpy as np

import fullmag as fm
from fullmag.meshing.asset_pipeline import (
    realize_fem_domain_mesh_asset_from_components_with_report,
)

RADIUS = 50e-9
AIRBOX_HMAX = 30e-9


def _realize(body_hmax: float):
    left = fm.Sphere(RADIUS, name="sphere-left").translate((-60e-9, 0.0, 0.0))
    right = fm.Sphere(RADIUS, name="sphere-right").translate((60e-9, 0.0, 0.0))
    mesh, region_markers, report = realize_fem_domain_mesh_asset_from_components_with_report(
        [left, right],
        fm.FEM(order=1, maximum_element_size=body_hmax),
        study_universe={
            "mode": "manual",
            "size": [400e-9, 240e-9, 240e-9],
            "center": [0.0, 0.0, 0.0],
            "airbox_hmax": AIRBOX_HMAX,
        },
        mesh_workflow={
            "mesh_options": {"compute_quality": False, "per_element_quality": False},
            "per_geometry": [],
        },
    )
    return mesh, region_markers, report


def _body_edge_estimates(mesh, region_markers) -> dict[str, float]:
    """Volume-equivalent regular-tetrahedron edge per magnetic body."""
    nodes = np.asarray(mesh.nodes, dtype=np.float64)
    elements = np.asarray(mesh.elements, dtype=np.int64)
    markers = np.asarray(mesh.element_markers)
    a, b, c, d = (nodes[elements[:, index]] for index in range(4))
    volumes = np.abs(np.einsum("ij,ij->i", b - a, np.cross(c - a, d - a))) / 6.0
    estimates = {}
    for entry in region_markers:
        mask = markers == int(entry["marker"])
        mean_volume = float(volumes[mask].mean())
        estimates[str(entry["geometry_name"])] = (6.0 * math.sqrt(2.0) * mean_volume) ** (1.0 / 3.0)
    return estimates


class SharedDomainBodyHmaxTests(unittest.TestCase):
    def test_body_target_finer_than_airbox_is_realized(self) -> None:
        mesh, region_markers, _report = _realize(10e-9)

        estimates = _body_edge_estimates(mesh, region_markers)

        self.assertEqual(len(estimates), 2)
        for name, edge in estimates.items():
            # Unstructured tetrahedra average below the requested maximum;
            # the air size (30 nm) must not leak into the bodies.
            self.assertLess(edge, 1.5 * 10e-9, name)

    def test_body_resolution_follows_the_body_target(self) -> None:
        fine, fine_markers, _ = _realize(10e-9)
        coarse, coarse_markers, _ = _realize(20e-9)

        def body_cells(mesh, region_markers) -> int:
            body = {int(entry["marker"]) for entry in region_markers}
            return int(np.isin(np.asarray(mesh.element_markers), list(body)).sum())

        self.assertGreater(
            body_cells(fine, fine_markers),
            3 * body_cells(coarse, coarse_markers),
        )


if __name__ == "__main__":
    unittest.main()
