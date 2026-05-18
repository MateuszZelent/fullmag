from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest


REPO_ROOT = Path(__file__).resolve().parents[3]
SMOKE_PATH = REPO_ROOT / "scripts" / "analysis" / "gmsh_generation_smoke.py"


def load_smoke_module():
    spec = importlib.util.spec_from_file_location("gmsh_generation_smoke", SMOKE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {SMOKE_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class GmshGenerationSmokeTests(unittest.TestCase):
    def test_smoke_cases_cover_medium_and_large_generation_profiles(self) -> None:
        smoke = load_smoke_module()

        self.assertIn("medium_box", smoke.CASE_CONFIGS)
        self.assertIn("large_box", smoke.CASE_CONFIGS)
        self.assertEqual(smoke.CASE_CONFIGS["medium_box"].scale, "medium")
        self.assertEqual(smoke.CASE_CONFIGS["large_box"].scale, "large")
        self.assertGreater(
            smoke.CASE_CONFIGS["medium_box"].hmax,
            smoke.CASE_CONFIGS["large_box"].hmax,
        )

    def test_run_case_reports_real_gmsh_generation_timing(self) -> None:
        smoke = load_smoke_module()
        if not smoke.gmsh_available():
            self.skipTest("gmsh is not installed")

        result = smoke.run_case(
            "medium_box",
            hmax=70e-9,
            compute_quality=False,
        )

        self.assertEqual(result["case"], "medium_box")
        self.assertEqual(result["geometry_kind"], "box")
        self.assertGreater(result["nodes"], 0)
        self.assertGreater(result["elements"], 0)
        self.assertGreater(result["boundary_faces"], 0)
        self.assertGreaterEqual(result["generation_seconds"], 0.0)
        self.assertGreaterEqual(result["statistics_seconds"], 0.0)
        self.assertGreater(result["edge_length_mean"], 0.0)

    def test_release_smoke_budget_profile_detects_generation_regression(self) -> None:
        smoke = load_smoke_module()

        budgets = smoke.resolve_case_budgets(
            ["medium_box", "large_box"],
            budget_profile="release-smoke",
            max_case_seconds=None,
        )
        failures = smoke.budget_failures(
            [
                {"case": "medium_box", "generation_seconds": budgets["medium_box"] / 2.0},
                {"case": "large_box", "generation_seconds": budgets["large_box"] + 0.1},
            ],
            budgets,
            duration_key="generation_seconds",
        )

        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0]["case"], "large_box")
        self.assertEqual(failures[0]["budget_seconds"], budgets["large_box"])


if __name__ == "__main__":
    unittest.main()
