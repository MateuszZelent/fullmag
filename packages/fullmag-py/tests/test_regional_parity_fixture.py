"""The sharp-interface qualification must not inherit smooth DSL defaults."""

import os
from pathlib import Path
import unittest
from unittest.mock import patch

import fullmag as fm


class RegionalParityFixtureTests(unittest.TestCase):
    def test_heterogeneous_parity_cases_author_sharp_coefficients(self):
        source = (Path(__file__).resolve().parents[3]
                  / "scripts/benchmarks/fdm_regions_parity_case.py")
        cases = [("two_materials", 1), ("two_materials_scaled", 1), ("grains", 4)]
        for case, count in cases:
            with self.subTest(case=case), patch.dict(os.environ, {
                "FDM_REGIONS_CASE": case,
                "FDM_REGIONS_DEVICE": "cpu",
                "FDM_REGIONS_PRECISION": "double",
                "FDM_REGIONS_STEPS": "1",
                "FDM_REGIONS_GRAINS": "2,2",
                "FDM_REGIONS_DEMAG": "0",
                "FDM_REGIONS_SAVE_FIELDS": "0",
            }):
                loaded = fm.load_problem_from_script(source, lightweight_assets=True)
                problem = loaded.stages[0].problem if loaded.stages else loaded.problem
                ir = problem.to_ir(include_geometry_assets=False)
                overridden = [region for region in ir["object_regions"]
                              if region.get("material_overrides")]
                self.assertEqual(len(overridden), count)
                for region in overridden:
                    self.assertEqual(region.get("material_transition"), {"kind": "sharp"},
                                     "grain/interface oracle requires discontinuous coefficients")


if __name__ == "__main__":
    unittest.main()
