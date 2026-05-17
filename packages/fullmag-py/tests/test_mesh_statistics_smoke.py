from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest


REPO_ROOT = Path(__file__).resolve().parents[3]
SMOKE_PATH = REPO_ROOT / "scripts" / "analysis" / "mesh_statistics_smoke.py"


def load_smoke_module():
    spec = importlib.util.spec_from_file_location("mesh_statistics_smoke", SMOKE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {SMOKE_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class MeshStatisticsSmokeTests(unittest.TestCase):
    def test_smoke_cases_cover_medium_and_large_meshes(self) -> None:
        smoke = load_smoke_module()

        self.assertIn("medium", smoke.CASE_ELEMENT_COUNTS)
        self.assertIn("large", smoke.CASE_ELEMENT_COUNTS)
        self.assertGreater(smoke.CASE_ELEMENT_COUNTS["large"], smoke.CASE_ELEMENT_COUNTS["medium"])

    def test_run_case_reports_mesh_statistics_and_timing(self) -> None:
        smoke = load_smoke_module()

        result = smoke.run_case("medium", element_count=64)

        self.assertEqual(result["case"], "medium")
        self.assertEqual(result["elements"], 64)
        self.assertEqual(result["nodes"], 256)
        self.assertGreaterEqual(result["duration_seconds"], 0.0)
        self.assertGreater(result["edge_length_mean"], 0.0)
        self.assertEqual(result["topology_artifact_kind"], "remesh_topology_json")
        self.assertEqual(result["topology_artifact_nodes"], 256)
        self.assertEqual(result["topology_artifact_elements"], 64)
        self.assertGreater(result["topology_artifact_byte_size"], 0)
        self.assertGreaterEqual(result["topology_artifact_seconds"], 0.0)
        self.assertGreaterEqual(result["worst_element_count"], 1)

    def test_release_smoke_budget_profile_detects_over_budget_case(self) -> None:
        smoke = load_smoke_module()

        budgets = smoke.resolve_case_budgets(
            ["medium", "large"],
            budget_profile="release-smoke",
            max_case_seconds=None,
        )
        failures = smoke.budget_failures(
            [
                {"case": "medium", "duration_seconds": budgets["medium"] / 2.0},
                {"case": "large", "duration_seconds": budgets["large"] + 0.1},
            ],
            budgets,
            duration_key="duration_seconds",
        )

        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0]["case"], "large")
        self.assertEqual(failures[0]["budget_seconds"], budgets["large"])

    def test_release_smoke_budget_profile_detects_topology_artifact_regression(self) -> None:
        smoke = load_smoke_module()

        budgets = smoke.resolve_case_budgets(
            ["medium", "large"],
            budget_profile="release-smoke",
            max_case_seconds=None,
        )
        failures = smoke.budget_failures(
            [
                {
                    "case": "medium",
                    "topology_artifact_seconds": budgets["medium"] / 2.0,
                },
                {
                    "case": "large",
                    "topology_artifact_seconds": budgets["large"] + 0.1,
                },
            ],
            budgets,
            duration_key="topology_artifact_seconds",
        )

        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0]["case"], "large")
        self.assertEqual(failures[0]["duration_key"], "topology_artifact_seconds")


if __name__ == "__main__":
    unittest.main()
