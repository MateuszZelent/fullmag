"""Helpers of the FDM mask plan probe (no fullmag build needed)."""

import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import fdm_mask_plan_checks as probe  # noqa: E402


class ProbeHelperTests(unittest.TestCase):
    def test_cell_centres_are_x_fastest_from_the_lower_corner(self):
        plan = {"grid": {"cells": [2, 2, 1]}, "origin_m": [-1.0, 0.0, 10.0], "cell_size": [1.0, 2.0, 4.0]}
        self.assertEqual(
            probe.cell_centres(plan),
            [(-0.5, 1.0, 12.0), (0.5, 1.0, 12.0), (-0.5, 3.0, 12.0), (0.5, 3.0, 12.0)],
        )

    def test_inside_box_is_inclusive(self):
        self.assertTrue(probe.inside_box((0, 0, 0), (2, 2, 2), (1, -1, 0)))
        self.assertFalse(probe.inside_box((0, 0, 0), (2, 2, 2), (1.0000001, 0, 0)))

    def test_field_error_is_relative_to_the_largest_value(self):
        self.assertEqual(probe.field_error([[0, 0, 2.0]], [[0, 0, 2.0]]), 0.0)
        self.assertAlmostEqual(probe.field_error([[0, 0, 2.2], [1, 0, 0]], [[0, 0, 2.0], [1, 0, 0]]), 0.1)
        self.assertEqual(probe.field_error([[1e-30, 0, 0]], [[0, 0, 0]]), 1e-30)

    def test_same_program_tolerates_last_bit_of_literals_only(self):
        self.assertTrue(probe.same_program([1, 0.1, 0], [1, 0.1 + 1e-17, 0]))
        self.assertFalse(probe.same_program([1, 0.1, 0], [1, 0.1000001, 0]))
        self.assertFalse(probe.same_program([1, 1.0, 0], [1, 1.0, 9, 0]))

    def test_oracle_program_of_a_time_function_ir(self):
        oracle = probe.load_oracle()
        ir = {
            "parameters": [{"name": "frequency", "value": 3.6e9}, {"name": "t0", "value": 1e-10}],
            "locals": [{"name": "t_2", "expression": "t - t0"}],
            "outputs": ["sin(2 * pi * frequency * t_2)"],
        }
        program, tree = probe.oracle_program(oracle, ir)
        self.assertEqual(program[-1], oracle.OPCODES["RETURN"])
        self.assertTrue(oracle.depends_on_t(tree))
        t = 3e-10
        self.assertAlmostEqual(oracle.evaluate(tree, t), math.sin(2 * math.pi * 3.6e9 * (t - 1e-10)), delta=1e-12)

    def test_first_json_object_ignores_logs_around_it(self):
        text = '[fullmag] version 1\n{"a": {"b": [1, 2]}}\n{"other": 1}\nwarning: x'
        self.assertEqual(probe.first_json_object(text), {"a": {"b": [1, 2]}})

    def test_scripts_compile_and_cases_are_consistent(self):
        names = set()
        for case in probe.cases():
            self.assertNotIn(case.name, names)
            names.add(case.name)
            compile(probe.script_of(case), f"{case.name}.py", "exec")
            if case.error is not None or case.regional_only:
                self.assertEqual(case.terms, ())
            else:
                self.assertTrue(case.terms)
                self.assertIsNotNone(case.support)
        self.assertEqual(len(names), 17)

    def test_probe_functions_match_their_closed_forms(self):
        functions = {name: getattr(math, name) for name in ("sin", "cos", "exp", "floor", "log", "sqrt")}
        functions["pi"] = math.pi
        exec(probe.FUNCTIONS, functions)
        x, y = 3e-9, -4e-9
        g = math.exp(-(x + 10e-9) ** 2 / (2 * 40e-9**2))
        sigma_y = 30e-9 / (2 * math.sqrt(2 * math.log(2)))
        g *= math.exp(-y**2 / (2 * sigma_y**2)) * 0.2e-3
        k = 2 * math.pi / 40e-9
        got = functions["reassigned"](x, y, 0.0, B01=0.2e-3, wavelength=40e-9, fwhm_y=30e-9, xs=10e-9)
        for a, b in zip(got, (g * math.sin(k * x - math.pi / 2), 0.0, g * math.sin(k * x))):
            self.assertAlmostEqual(a, b, delta=1e-18)


if __name__ == "__main__":
    unittest.main()
