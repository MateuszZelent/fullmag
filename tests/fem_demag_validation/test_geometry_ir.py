"""Geometry IR checks needed by FEM demag validation scripts."""

from __future__ import annotations

import unittest

import fullmag as fm


class DemagValidationGeometryIrTests(unittest.TestCase):
    def test_sphere_lowers_to_ellipsoid_radii_for_rust_ir(self) -> None:
        ir = fm.Sphere(50e-9, name="sphere").to_ir()

        self.assertEqual(ir["kind"], "ellipsoid")
        self.assertEqual(ir["radii"], [50e-9, 50e-9, 50e-9])
        self.assertNotIn("rx", ir)
        self.assertNotIn("ry", ir)
        self.assertNotIn("rz", ir)


if __name__ == "__main__":
    unittest.main()
