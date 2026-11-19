"""Numerical/reference checks only; no Fullmag or BORIS execution."""
import ast
import math
from pathlib import Path
import unittest

import numpy as np
from scipy.integrate import quad

import antenna_current_source_oracle as prism
import reference_sushruth_2020_gsg_current as gsg


class FiniteGsgReferenceTests(unittest.TestCase):
    def test_constants_match_public_example(self):
        path = Path(__file__).resolve().parents[1] / "examples/fem_antenna_sushruth_2020_gsg.py"
        values = {}
        for node in ast.parse(path.read_text()).body:
            if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                try: values[node.targets[0].id] = ast.literal_eval(node.value)
                except (ValueError, TypeError): pass
        for key, expected in (
            ("conductor_width_m", gsg.WIDTH_M), ("metal_thickness_m", gsg.THICKNESS_M),
            ("gap_m", gsg.GAP_M), ("insulator_thickness_m", gsg.SPACING_M),
            ("source_length_m", gsg.DEVICE_LENGTH_M), ("lead_length_m", gsg.LEAD_LENGTH_M),
            ("conductivity_s_per_m", gsg.CONDUCTIVITY_SPM), ("signal_current_a", gsg.SIGNAL_CURRENT_A),
        ):
            self.assertEqual(values[key], expected, key)
        self.assertEqual(values["branch_weights"], tuple((name, weight) for name, _, weight in gsg.BRANCHES))

    def test_rectangular_integral_matches_direct_3d_cubature(self):
        lower = np.array((-0.7, 0.2, -0.1))
        upper = np.array((1.3, 0.8, 0.3))
        point = np.array((0.1, -0.2, 1.1))
        expected = prism.rectangular_prism_field(point, lower_m=lower, upper_m=upper,
                                                current_density_apm2=1.7, subdivisions=128)
        errors = []
        for n in (24, 48):
            axes = [a + (np.arange(n) + 0.5) * (b - a) / n for a, b in zip(lower, upper)]
            source = np.stack(np.meshgrid(*axes, indexing="ij"), axis=-1)
            r = point - source
            h = np.cross([1.7, 0, 0], r) / np.linalg.norm(r, axis=-1)[..., None]**3
            actual = h.mean(axis=(0, 1, 2)) * np.prod(upper - lower) / (4 * math.pi)
            errors.append(math.dist(expected, actual))
        self.assertLess(errors[1], 1e-5)
        self.assertGreater(errors[0] / errors[1], 3.8)
        self.assertLess(errors[0] / errors[1], 4.2)

    def adaptive_field(self, point):
        # World coordinates in micrometres; integrate x/z adaptively, not Simpson.
        x, y, z = np.asarray(point) / 1e-6
        fields = [[], []]
        half_length = (gsg.DEVICE_LENGTH_M / 2 + gsg.LEAD_LENGTH_M) / 1e-6
        for _, center_m, weight in gsg.BRANCHES:
            center, width = center_m / 1e-6, gsg.WIDTH_M / 1e-6
            for index in range(2):
                def outer(zs):
                    def inner(xs):
                        dx, dz = x - xs, z - zs
                        radius2 = dx * dx + dz * dz
                        a, b = y + half_length, y - half_length
                        kernel = (a / math.hypot(a, math.sqrt(radius2))
                                  - b / math.hypot(b, math.sqrt(radius2))) / radius2
                        return (dz if index == 0 else -dx) * kernel
                    return quad(inner, center - width / 2, center + width / 2,
                                epsabs=1e-10, epsrel=1e-10)[0]
                integral = quad(outer, gsg.SPACING_M / 1e-6,
                                (gsg.SPACING_M + gsg.THICKNESS_M) / 1e-6,
                                epsabs=1e-10, epsrel=1e-10)[0]
                fields[index].append(integral * weight * gsg.SIGNAL_CURRENT_A
                                     / (gsg.WIDTH_M * gsg.THICKNESS_M) * 1e-6 / (4 * math.pi))
        return (math.fsum(fields[0]), 0.0, math.fsum(fields[1]))

    def test_gsg_matches_adaptive_reference_and_refines(self):
        for point in ((0.0, 0.0, -5e-9), (100e-9, 0.0, -5e-9),
                      (450e-9, 200e-9, -5e-9), (2e-6, 12.3e-6, -5e-9)):
            with self.subTest(point=point):
                expected = self.adaptive_field(point)
                errors = [math.dist(gsg.gsg_field(point, subdivisions=n), expected) for n in (32, 64, 128)]
                self.assertLess(errors[-1], 1e-4)
                self.assertLess(errors[-1], errors[0])

    def test_world_rotation_and_gsg_symmetry(self):
        center = gsg.gsg_field((0.0, 0.0, -5e-9))
        self.assertLess(center[0], 0.0)
        self.assertEqual(center[1], 0.0)
        self.assertAlmostEqual(center[2], 0.0, delta=1e-10)
        left = gsg.gsg_field((-230e-9, 0.0, -5e-9))
        right = gsg.gsg_field((230e-9, 0.0, -5e-9))
        self.assertAlmostEqual(left[0], right[0], delta=1e-9)
        self.assertAlmostEqual(left[2], -right[2], delta=1e-9)

    def test_rejects_invalid_geometry_and_slab_points(self):
        for point in ((0, 0, 30e-9), (0, 0, 80e-9), (0, 0, float("nan")), (True, 0, -1)):
            with self.assertRaises(ValueError): gsg.gsg_field(point)
        for upper in ((0, 1, 1), (1, -1, 1), (1, 1, 0)):
            with self.assertRaises(ValueError):
                prism.rectangular_prism_field((0, 0, 2), lower_m=(0, 0, 0), upper_m=upper,
                                              current_density_apm2=1, subdivisions=32)


if __name__ == "__main__":
    unittest.main()
