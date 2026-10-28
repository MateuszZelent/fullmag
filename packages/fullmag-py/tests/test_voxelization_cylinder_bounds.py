"""Regression checks for arbitrary-axis cylinder voxelization bounds."""
from __future__ import annotations

import math
import unittest

import numpy as np

import fullmag as fm
from fullmag.meshing.voxelization import _geometry_bounds, voxelize_geometry


class CylinderVoxelizationBoundsTests(unittest.TestCase):
    def test_axis_aligned_bounds_follow_each_signed_axis(self) -> None:
        for dimension in range(3):
            for sign in (-1.0, 1.0):
                axis = [0.0, 0.0, 0.0]
                axis[dimension] = sign
                with self.subTest(axis=axis):
                    cylinder = fm.Cylinder(radius=3.0, height=2.0, axis=tuple(axis))
                    lower, upper = _geometry_bounds(cylinder)
                    expected = [3.0, 3.0, 3.0]
                    expected[dimension] = 1.0
                    np.testing.assert_allclose(upper, expected, rtol=0, atol=1e-14)
                    np.testing.assert_allclose(lower, -np.asarray(expected), rtol=0, atol=1e-14)

    def test_diagonal_bounds_include_cap_and_radial_projection(self) -> None:
        cylinder = fm.Cylinder(radius=1.0, height=1.0, axis=(1.0, 1.0, 0.0))
        lower, upper = _geometry_bounds(cylinder)
        expected = (1.5 / math.sqrt(2.0), 1.5 / math.sqrt(2.0), 1.0)
        np.testing.assert_allclose(upper, expected, rtol=1e-14)
        np.testing.assert_allclose(lower, -np.asarray(expected), rtol=1e-14)
        point = np.asarray((0.9, -0.3, 0.0))
        self.assertTrue(np.all(point >= lower) and np.all(point <= upper))

    def test_bounds_enclose_sampled_caps_for_arbitrary_axes(self) -> None:
        for axis in ((1.0, 1.0, 0.0), (-2.0, 3.0, -5.0), (1e-12, -1.0, 1e-12)):
            with self.subTest(axis=axis):
                cylinder = fm.Cylinder(radius=1.3, height=0.7, axis=axis)
                direction = np.asarray(cylinder.axis)
                helper = np.eye(3)[np.argmin(np.abs(direction))]
                radial_u = np.cross(direction, helper)
                radial_u /= np.linalg.norm(radial_u)
                radial_v = np.cross(direction, radial_u)
                angles = np.linspace(0.0, 2.0 * math.pi, 361)
                circle = cylinder.radius * (
                    np.cos(angles)[:, None] * radial_u
                    + np.sin(angles)[:, None] * radial_v
                )
                points = np.concatenate((circle + 0.35 * direction, circle - 0.35 * direction))
                lower, upper = _geometry_bounds(cylinder)
                self.assertTrue(np.all(points >= np.asarray(lower) - 1e-12))
                self.assertTrue(np.all(points <= np.asarray(upper) + 1e-12))

    def test_diagonal_voxelization_keeps_material_beyond_old_clipped_box(self) -> None:
        cylinder = fm.Cylinder(radius=1.0, height=1.0, axis=(1.0, 1.0, 0.0))
        voxels = voxelize_geometry(cylinder, (0.05, 0.05, 0.05))
        indices = np.argwhere(voxels.mask)
        x = voxels.origin[0] + (indices[:, 2] + 0.5) * voxels.cell_size[0]
        self.assertGreater(float(x.max()), 0.9)
        self.assertLess(float(x.min()), -0.9)


if __name__ == "__main__":
    unittest.main()
