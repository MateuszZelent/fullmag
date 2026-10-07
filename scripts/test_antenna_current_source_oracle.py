"""Interpreted checks of the oracle, never a native execution receipt."""
import copy
import math
from pathlib import Path
import unittest
from unittest.mock import patch

import fullmag as fm
from fullmag.runtime.loader import load_problem_from_script
import antenna_current_source_oracle as oracle


class CurrentSourceOracleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fm.reset()
        path = Path(__file__).resolve().parents[1] / "examples/fem_antenna_current_source_inspection.py"
        loaded = load_problem_from_script(path, lightweight_assets=True)
        ir = loaded.problem.to_ir(source_root=path.parent)
        assets = {a["geometry_name"]: a["mesh"] for a in ir["geometry_assets"]["fem_mesh_assets"]}
        cls.inputs = {"device_mesh": assets["antenna"], "probe_mesh": assets["probe_geom"],
                      "current_definition": ir["current_modules"][0], "port_mode": ir["antenna_port_modes"][0]}
        cls.positions = sorted(oracle.PROBE_POSITIONS)
        cls.fields = [oracle.fixture_field(p) for p in cls.positions]
        fm.reset()

    def compare(self, **changes):
        values = [7.0 if i in (1, 4, 5, 8) else 6.75 for i in range(1, 9)]
        values += [-11.0 if i in (1, 4, 5, 8) else -10.75 for i in range(1, 9)]
        args = {"inputs": self.inputs, "device_ids": list(range(1, 17)), "potential_v": values,
                "positions_m": self.positions, "field_apm": self.fields,
                "voltage_tolerance_v": 1e-8, "field_absolute_tolerance_apm": 1e-8,
                "field_relative_tolerance": 1e-6}
        args.update(changes)
        return oracle.compare_fixture(**args)

    def test_actual_public_lowering_matches_fixed_input_pin(self):
        self.assertEqual(oracle.fixture_input_digest(self.inputs), oracle.FIXTURE_INPUT_SHA256)

    def test_compares_all_samples_with_separate_gauges_and_no_promotion(self):
        result = self.compare()
        self.assertEqual(result["max_voltage_error_v"], 0.0)
        self.assertEqual(result["max_field_vector_error_apm"], 0.0)
        self.assertFalse(result["physics_qualified"])
        self.assertEqual(result["qualification"], "NOT VERIFIED")
        # Stable-ID and point ordering may change, but each value stays paired.
        self.compare(device_ids=list(reversed(range(1, 17))),
                     potential_v=list(reversed([7, 6.75, 6.75, 7, 7, 6.75, 6.75, 7,
                                                -11, -10.75, -10.75, -11, -11, -10.75, -10.75, -11])),
                     positions_m=list(reversed(self.positions)), field_apm=list(reversed(self.fields)))

    def test_refuses_changed_physical_input_before_field_integration(self):
        for document in self.inputs:
            changed = copy.deepcopy(self.inputs)
            changed[document]["oracle_tamper"] = True
            with self.subTest(document=document), patch.object(oracle, "fixture_field", side_effect=AssertionError("too late")):
                with self.assertRaisesRegex(ValueError, "geometry/material/current/port"):
                    self.compare(inputs=changed)

    def test_refuses_wrong_sign_units_or_field_vector_order(self):
        for fields in ([tuple(-v for v in h) for h in self.fields],
                       [tuple(4e-7 * math.pi * v for v in h) for h in self.fields],
                       list(reversed(self.fields))):
            with self.assertRaisesRegex(ValueError, "field vector mismatch"):
                self.compare(field_apm=fields)
        with self.assertRaisesRegex(ValueError, "potential mismatch"):
            self.compare(potential_v=[0.0] * 16)

    def test_refuses_empty_duplicate_nonfinite_samples_and_invalid_tolerances(self):
        for changes in ({"device_ids": []}, {"device_ids": [1] * 16},
                        {"positions_m": self.positions[:3]}, {"field_apm": [(0, 0, float("nan"))] * 4},
                        {"potential_v": [float("inf")] * 16}, {"voltage_tolerance_v": 0},
                        {"field_absolute_tolerance_apm": -1}, {"field_relative_tolerance": True}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.compare(**changes)

    def test_prism_sign_symmetry_far_field_and_target_domain(self):
        p = (0.5, 0.5, 2.0)
        h = oracle.prism_field(p, y_min_m=0, current_density_apm2=1, subdivisions=64)
        self.assertEqual(h[0], 0.0)
        self.assertLess(h[1], 0.0)
        self.assertAlmostEqual(h[2], 0.0, delta=1e-15)
        opposite = oracle.prism_field(p, y_min_m=0, current_density_apm2=-1, subdivisions=64)
        self.assertEqual(opposite, tuple(-v for v in h))
        far = oracle.prism_field((0.5, 0.5, 100.5), y_min_m=0, current_density_apm2=1, subdivisions=32)
        expected = -3.0 / (4 * math.pi * 100.0**2)
        self.assertAlmostEqual(far[1] / expected, 1.0, delta=2e-4)
        with self.assertRaisesRegex(ValueError, "outside"):
            oracle.fixture_field((0, 0, 0.5))

    def test_reduced_integral_matches_independent_three_dimensional_cubature(self):
        # Direct midpoint integration of J cross R / |R|^3, no x primitive.
        position = (0.2, -0.3, 2.0)
        def volume_midpoint(n):
            terms = [[], []]
            for i in range(n):
                dx = position[0] - (-1 + 3 * (i + 0.5) / n)
                for k in range(n):
                    dy = position[1] - (k + 0.5) / n
                    for l in range(n):
                        dz = position[2] - (l + 0.5) / n
                        denominator = (dx * dx + dy * dy + dz * dz)**1.5
                        terms[0].append(-dz / denominator)
                        terms[1].append(dy / denominator)
            return (0.0, *(3 * math.fsum(v) / (4 * math.pi * n**3) for v in terms))
        reduced = oracle.prism_field(position, y_min_m=0, current_density_apm2=1, subdivisions=64)
        coarse_error = math.dist(volume_midpoint(32), reduced)
        fine_error = math.dist(volume_midpoint(64), reduced)
        self.assertLess(fine_error, 3e-6)
        self.assertGreater(coarse_error / fine_error, 3.8)
        self.assertLess(coarse_error / fine_error, 4.2)

    def test_refinement_exhaustion_is_not_accepted(self):
        def unconverged(position, *, y_min_m, current_density_apm2, subdivisions):
            return (0.0, float(subdivisions), 0.0)
        with patch.object(oracle, "prism_field", side_effect=unconverged):
            with self.assertRaisesRegex(ValueError, "did not converge"):
                oracle.fixture_field((0, 0, 2))


if __name__ == "__main__":
    unittest.main()
