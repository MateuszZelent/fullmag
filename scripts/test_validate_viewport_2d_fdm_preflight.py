import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.analysis.validate_viewport_2d_fdm_preflight import (
    PreflightError,
    run_execution_planner,
    validate_execution_plan,
)


ROOT = Path(__file__).resolve().parents[1]


def _linear_ms_values(counts: list[int], origin: list[float], cell: list[float]) -> list[float]:
    values: list[float] = []
    for z in range(counts[2]):
        for _y in range(counts[1]):
            for x in range(counts[0]):
                object_x = origin[0] + (x + 0.5) * cell[0]
                object_z = origin[2] + (z + 0.5) * cell[2]
                values.append(800e3 + 1e12 * object_x + 2e12 * object_z)
    return values


def _valid_plan() -> dict[str, object]:
    film_counts = [16, 12, 4]
    film_origin = [-40e-9, -30e-9, -10e-9]
    cell = [5e-9, 5e-9, 5e-9]
    film_count = 16 * 12 * 4
    neighbor_count = 4 * 12 * 4
    return {
        "common": {"resolved_backend": "fdm"},
        "backend_plan": {
            "kind": "fdm_multilayer",
            "layers": [
                {
                    "layer_id": "layer:planar_film",
                    "object_id": "planar_film",
                    "magnet_name": "planar_film",
                    "native_grid": film_counts,
                    "native_origin": film_origin,
                    "native_cell_size": cell,
                    "native_region_mask": [1] * film_count,
                    "native_region_legend": [
                        {
                            "numeric_id": 1,
                            "object_id": "planar_film",
                            "region_id": "qualification_core",
                            "priority": 10,
                        }
                    ],
                    "material": {
                        "saturation_magnetisation": 800e3,
                        "exchange_stiffness": 13e-12,
                        "damping": 0.1,
                        "ms_field": _linear_ms_values(film_counts, film_origin, cell),
                    },
                },
                {
                    "layer_id": "layer:isolation_neighbor",
                    "object_id": "isolation_neighbor",
                    "magnet_name": "isolation_neighbor",
                    "native_grid": [4, 12, 4],
                    "native_origin": [45e-9, -30e-9, -10e-9],
                    "native_cell_size": cell,
                    "native_region_mask": [0] * neighbor_count,
                    "native_region_legend": [],
                    "material": {
                        "saturation_magnetisation": 400e3,
                        "exchange_stiffness": 13e-12,
                        "damping": 0.1,
                    },
                },
            ],
        },
    }


class Viewport2dFdmPreflightTests(unittest.TestCase):
    def test_accepts_exact_native_layers_membership_and_film_linear_ms(self) -> None:
        report = validate_execution_plan(_valid_plan(), qualification_profile="base")

        self.assertTrue(report["pass"])
        self.assertEqual(report["native_cell_counts"], {
            "isolation_neighbor": 192,
            "planar_film": 768,
        })
        self.assertEqual(report["material_array_owners"], {"ms_field": ["planar_film"]})
        self.assertTrue(report["qualification_core_membership"])
        self.assertTrue(report["coplanar_disjoint_objects"])

    def test_rejects_wrong_native_count_and_present_array_length(self) -> None:
        plan = _valid_plan()
        layers = plan["backend_plan"]["layers"]  # type: ignore[index]
        layers[1]["native_grid"] = [5, 12, 4]
        layers[1]["material"]["a_field"] = [13e-12] * 7

        with self.assertRaises(PreflightError) as raised:
            validate_execution_plan(plan, qualification_profile="base")

        message = str(raised.exception)
        self.assertIn("isolation_neighbor native cell count 240, expected 192", message)
        self.assertIn("isolation_neighbor a_field length 7, expected native length 240", message)

    def test_rejects_scalarized_film_ms_or_array_on_neighbor(self) -> None:
        plan = _valid_plan()
        layers = plan["backend_plan"]["layers"]  # type: ignore[index]
        layers[0]["material"].pop("ms_field")
        layers[1]["material"]["ms_field"] = [400e3] * 192

        with self.assertRaises(PreflightError) as raised:
            validate_execution_plan(plan, qualification_profile="base")

        message = str(raised.exception)
        self.assertIn("planar_film ms_field is required", message)
        self.assertIn("isolation_neighbor ms_field must use canonical scalar fallback", message)

    def test_rejects_missing_qualification_core_legend(self) -> None:
        plan = _valid_plan()
        plan["backend_plan"]["layers"][0]["native_region_legend"] = []  # type: ignore[index]

        with self.assertRaisesRegex(PreflightError, "qualification_core legend"):
            validate_execution_plan(plan, qualification_profile="base")

    def test_planner_failure_preserves_raw_stdout_and_stderr(self) -> None:
        completed = subprocess.CompletedProcess(
            args=["fullmag", "plan-json"],
            returncode=1,
            stdout="planner stdout reason\n",
            stderr="planner stderr reason\n",
        )
        with patch("subprocess.run", return_value=completed):
            with self.assertRaises(PreflightError) as raised:
                run_execution_planner(Path("fullmag"), Path("fixture.json"))

        message = str(raised.exception)
        self.assertIn("planner stdout reason", message)
        self.assertIn("planner stderr reason", message)

    def test_recipe_runs_preflight_before_runtime_science_and_browser(self) -> None:
        recipe = (ROOT / "justfile").read_text(encoding="utf-8")
        start = recipe.index("run-viewport-2d-planar-monitor-smoke")
        end = recipe.index("\nrun-viewport-2d-planar-monitor-refinement-peer", start)
        recipe = recipe[start:end]

        preflight = recipe.index("validate_viewport_2d_fdm_preflight.py")
        runtime = recipe.index('"{{gpu_runtime_bin}}" --dev')
        science = recipe.index("validate_planar_monitor_sampling.py")
        browser = recipe.index("smoke:viewport-2d")
        self.assertLess(preflight, runtime)
        self.assertLess(runtime, science)
        self.assertLess(science, browser)
        self.assertIn("bash -euo pipefail", recipe)
        self.assertNotIn("preflight_status=", recipe)

    def test_plan_json_exposes_opt_in_canonical_execution_plan(self) -> None:
        args_source = (ROOT / "crates/fullmag-cli/src/args.rs").read_text(encoding="utf-8")
        main_source = (ROOT / "crates/fullmag-cli/src/main.rs").read_text(encoding="utf-8")

        self.assertIn("execution_plan: bool", args_source)
        self.assertIn("Command::PlanJson {", main_source)
        self.assertIn("fullmag_plan::plan(&ir)", main_source)


if __name__ == "__main__":
    unittest.main()
