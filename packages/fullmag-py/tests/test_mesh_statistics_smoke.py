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
        self.assertGreaterEqual(result["worst_element_count"], 1)


if __name__ == "__main__":
    unittest.main()
