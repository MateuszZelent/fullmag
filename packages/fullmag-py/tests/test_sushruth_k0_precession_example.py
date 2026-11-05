"""Public authoring checks for the k=0 control; not runtime qualification."""
import math
from pathlib import Path
import unittest

from fullmag.runtime.loader import load_problem_from_script
from fullmag.runtime.script_builder import export_builder_draft, render_loaded_problem_as_script

EXAMPLE = Path(__file__).resolve().parents[3] / "examples" / "fdm_sushruth_2020_k0_free_precession.py"


class SushruthK0PrecessionExampleTests(unittest.TestCase):
    def test_table_i_gamma_alpha_and_sole_constant_effective_field(self):
        loaded = load_problem_from_script(EXAMPLE, lightweight_assets=True)
        problem = loaded.problem
        stage = loaded.stages[0]
        ir = stage.problem.to_ir(include_geometry_assets=False)
        dynamics = ir["study"]["dynamics"]
        self.assertAlmostEqual(dynamics["gyromagnetic_ratio"], 4e-7*math.pi*2*math.pi*30e9, delta=1e-9)
        self.assertEqual(dynamics["integrator"], "rk4")
        self.assertEqual(dynamics["fixed_timestep"], 1e-13)
        self.assertEqual(stage.default_until_seconds, 2e-9)
        self.assertEqual(len(problem.magnets), 1)
        material = problem.magnets[0].material
        self.assertEqual(material.alpha, .01)
        self.assertAlmostEqual(material.Ms*4e-7*math.pi, .89, delta=1e-14)
        ir = problem.to_ir(include_geometry_assets=False)
        self.assertEqual(len(ir["energy_terms"]), 1)
        self.assertNotIn("demag", [term["kind"] for term in ir["energy_terms"]])
        self.assertNotIn("exchange", [term["kind"] for term in ir["energy_terms"]])
        self.assertEqual(len(loaded.stages), 1)
        self.assertEqual(stage.entrypoint_kind, "flat_run")

    def test_explicit_fdm_cpu_and_no_antenna_or_relax_stage(self):
        loaded = load_problem_from_script(EXAMPLE, lightweight_assets=True)
        draft = export_builder_draft(loaded)
        for key, expected in (("requested_backend", "fdm"), ("requested_device", "cpu"), ("requested_precision", "double")):
            self.assertEqual(draft[key], expected)
        self.assertEqual(draft["current_modules"], [])
        self.assertEqual(draft["solved_antenna_drives"], [])
        self.assertEqual(draft["antenna_field_solve_stages"], [])
        self.assertEqual(len(draft["geometries"]), 1)

    def test_round_trip_preserves_full_physical_ir(self):
        loaded = load_problem_from_script(EXAMPLE, lightweight_assets=True)
        rendered = render_loaded_problem_as_script(loaded)
        restored = load_problem_from_script(EXAMPLE, source_bytes=rendered.encode(), lightweight_assets=True)
        original_ir = loaded.problem.to_ir(include_geometry_assets=False)
        restored_ir = restored.problem.to_ir(include_geometry_assets=False)
        # The canonical renderer uses 12 significant digits for numeric literals.
        def compare(left, right, path):
            if isinstance(left, float):
                self.assertIsInstance(right, (int, float), path)
                self.assertTrue(math.isclose(left, right, rel_tol=5e-12, abs_tol=0), path)
            elif isinstance(left, dict):
                self.assertEqual(left.keys(), right.keys(), path)
                for key in left: compare(left[key], right[key], path+"/"+key)
            elif isinstance(left, list):
                self.assertEqual(len(left), len(right), path)
                for i, (a, b) in enumerate(zip(left, right)): compare(a, b, path+"/"+str(i))
            else:
                self.assertEqual(left, right, path)
        for key in original_ir:
            if key != "problem_meta": compare(original_ir[key], restored_ir[key], key)
        for before, after in zip(loaded.stages, restored.stages):
            before_ir = before.problem.to_ir(include_geometry_assets=False)
            after_ir = after.problem.to_ir(include_geometry_assets=False)
            for key in before_ir:
                if key != "problem_meta": compare(before_ir[key], after_ir[key], "stage/"+key)
            self.assertEqual(after.default_until_seconds, before.default_until_seconds)


if __name__ == "__main__":
    unittest.main()
