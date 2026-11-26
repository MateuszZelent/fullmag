"""Public authoring checks; no mesh generation or solver execution."""
from pathlib import Path
import unittest

import fullmag as fm
import fullmag.world as world
from fullmag.runtime.loader import load_problem_from_script
from fullmag.runtime.script_builder import render_loaded_problem_as_script


EXAMPLE = Path(__file__).resolve().parents[3] / "examples/fem_antenna_sushruth_2020_gsg.py"


class SushruthCoNiSamplingTests(unittest.TestCase):
    def setUp(self):
        fm.reset()

    def tearDown(self):
        fm.reset()

    def test_sampling_spans_magnetic_stack_below_cap_without_activating_llg(self):
        loaded = load_problem_from_script(EXAMPLE, lightweight_assets=True)
        ir = loaded.problem.to_ir(include_geometry_assets=False)
        sample = next(g for g in ir["geometry"]["entries"]
                      if g["name"] == "Co/Ni field sampling")
        self.assertEqual(sample["kind"], "translate")
        self.assertEqual(sample["base"]["kind"], "box")
        thickness = sample["base"]["size"][2]
        center = sample["by"][2]
        # Independently derive dimensions from the reported layer sequence, in SI.
        self.assertAlmostEqual(thickness, (21 * (0.6 + 0.2) + 0.6) * 1e-9, delta=1e-20)
        self.assertAlmostEqual(center + thickness / 2, -(2.5 + 2.5) * 1e-9, delta=1e-20)
        self.assertAlmostEqual(center - thickness / 2, -22.4e-9, delta=1e-20)
        self.assertEqual(ir["magnets"], [])
        stages = loaded.study_pipeline_document()["nodes"]
        self.assertEqual([s["stage_kind"] for s in stages], ["antenna_field_solve"])
        target = ir["antenna_field_solve_stages"][0]["field_sampling_domain"]
        self.assertEqual(target, {"kind": "object", "object_id": "sampling"})

    def test_public_script_round_trip_preserves_source_target_and_stage(self):
        loaded = load_problem_from_script(EXAMPLE, lightweight_assets=True)
        before = loaded.problem.to_ir(include_geometry_assets=False)
        rendered = render_loaded_problem_as_script(loaded)
        fm.reset()
        exec(rendered, {})
        after = world._build_problem().to_ir(include_geometry_assets=False)
        for key in ("geometry", "current_modules", "antenna_field_solve_stages", "magnets"):
            self.assertEqual(after[key], before[key], key)


if __name__ == "__main__":
    unittest.main()
