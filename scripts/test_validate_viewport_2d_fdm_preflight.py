import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.analysis.validate_viewport_2d_fdm_preflight import (
    PreflightError,
    main,
    materialize_fixture_ir,
    run_execution_planner,
    validate_execution_plan,
)


ROOT = Path(__file__).resolve().parents[1]

PROFILE_GEOMETRY = {
    "base": {
        "planar_film": {
            "grid": [16, 12, 4],
            "origin": [-40e-9, -30e-9, -10e-9],
            "cell": [5e-9, 5e-9, 5e-9],
        },
        "isolation_neighbor": {
            "grid": [4, 12, 4],
            "origin": [45e-9, -30e-9, -10e-9],
            "cell": [5e-9, 5e-9, 5e-9],
        },
    },
    "mesh-refined": {
        "planar_film": {
            "grid": [32, 24, 8],
            "origin": [-40e-9, -30e-9, -10e-9],
            "cell": [2.5e-9, 2.5e-9, 2.5e-9],
        },
        "isolation_neighbor": {
            "grid": [8, 24, 8],
            "origin": [45e-9, -30e-9, -10e-9],
            "cell": [2.5e-9, 2.5e-9, 2.5e-9],
        },
    },
}


def _linear_ms_values(counts: list[int], origin: list[float], cell: list[float]) -> list[float]:
    values: list[float] = []
    for z in range(counts[2]):
        for _y in range(counts[1]):
            for x in range(counts[0]):
                object_x = origin[0] + (x + 0.5) * cell[0]
                object_z = origin[2] + (z + 0.5) * cell[2]
                values.append(800e3 + 1e12 * object_x + 2e12 * object_z)
    return values


def _qualification_core_mask(counts: list[int]) -> list[int]:
    x_start = counts[0] // 4
    x_end = 3 * counts[0] // 4
    y_start = counts[1] // 4
    y_end = 3 * counts[1] // 4
    return [
        int(x_start <= x < x_end and y_start <= y < y_end)
        for z in range(counts[2])
        for y in range(counts[1])
        for x in range(counts[0])
    ]


def _valid_plan(profile: str = "base") -> dict[str, object]:
    geometry = PROFILE_GEOMETRY[profile]
    film_counts = geometry["planar_film"]["grid"]
    film_origin = geometry["planar_film"]["origin"]
    film_cell = geometry["planar_film"]["cell"]
    neighbor_counts = geometry["isolation_neighbor"]["grid"]
    neighbor_origin = geometry["isolation_neighbor"]["origin"]
    neighbor_cell = geometry["isolation_neighbor"]["cell"]
    film_count = film_counts[0] * film_counts[1] * film_counts[2]
    neighbor_count = neighbor_counts[0] * neighbor_counts[1] * neighbor_counts[2]
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
                    "native_cell_size": film_cell,
                    "native_region_mask": _qualification_core_mask(film_counts),
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
                        "ms_field": _linear_ms_values(film_counts, film_origin, film_cell),
                    },
                },
                {
                    "layer_id": "layer:isolation_neighbor",
                    "object_id": "isolation_neighbor",
                    "magnet_name": "isolation_neighbor",
                    "native_grid": neighbor_counts,
                    "native_origin": neighbor_origin,
                    "native_cell_size": neighbor_cell,
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
        for profile, expected_counts in (
            ("base", {"isolation_neighbor": 192, "planar_film": 768}),
            ("mesh-refined", {"isolation_neighbor": 1536, "planar_film": 6144}),
        ):
            with self.subTest(profile=profile):
                report = validate_execution_plan(
                    _valid_plan(profile), qualification_profile=profile
                )

                self.assertTrue(report["pass"])
                self.assertEqual(report["native_cell_counts"], expected_counts)
                self.assertEqual(
                    report["material_array_owners"], {"ms_field": ["planar_film"]}
                )
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

    def test_rejects_all_film_shifted_or_wrong_qualification_core_mask(self) -> None:
        valid_mask = _qualification_core_mask([16, 12, 4])
        shifted_mask = valid_mask[-1:] + valid_mask[:-1]
        wrong_numeric_id = [2 if value == 1 else value for value in valid_mask]
        for label, mask in (
            ("all-film", [1] * 768),
            ("shifted", shifted_mask),
            ("wrong-numeric-id", wrong_numeric_id),
        ):
            with self.subTest(label=label):
                plan = _valid_plan()
                plan["backend_plan"]["layers"][0]["native_region_mask"] = mask  # type: ignore[index]

                with self.assertRaisesRegex(
                    PreflightError, "qualification_core native_region_mask"
                ):
                    validate_execution_plan(plan, qualification_profile="base")

    def test_rejects_non_fixture_layer_identity_and_scalar_fallbacks(self) -> None:
        mutations = (
            ("layer id", 0, "layer_id", "layer:wrong"),
            ("magnet name", 1, "magnet_name", "wrong"),
            ("film Ms none", 0, "saturation_magnetisation", None),
            ("film Ms negative", 0, "saturation_magnetisation", -800e3),
            ("neighbor Ms wrong", 1, "saturation_magnetisation", 800e3),
            ("film Aex wrong", 0, "exchange_stiffness", 12e-12),
            ("neighbor Aex none", 1, "exchange_stiffness", None),
            ("film alpha wrong", 0, "damping", 0.2),
            ("neighbor alpha negative", 1, "damping", -0.1),
        )
        for label, layer_index, key, value in mutations:
            with self.subTest(label=label):
                plan = _valid_plan()
                layer = plan["backend_plan"]["layers"][layer_index]  # type: ignore[index]
                if key in {"layer_id", "magnet_name"}:
                    layer[key] = value
                else:
                    layer["material"][key] = value

                with self.assertRaises(PreflightError):
                    validate_execution_plan(plan, qualification_profile="base")

    def test_rejects_native_geometry_that_only_matches_cell_product(self) -> None:
        mutations = (
            ("grid identity", "native_grid", [12, 16, 4]),
            ("origin", "native_origin", [-35e-9, -30e-9, -10e-9]),
            ("cell", "native_cell_size", [4e-9, 5e-9, 5e-9]),
        )
        for label, key, value in mutations:
            with self.subTest(label=label):
                plan = _valid_plan()
                plan["backend_plan"]["layers"][0][key] = value  # type: ignore[index]

                with self.assertRaisesRegex(PreflightError, "planar_film native"):
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

    def test_current_cli_executes_plan_json_execution_plan_end_to_end(self) -> None:
        raw_binary = os.environ.get("FULLMAG_CURRENT_CLI_BIN")
        if not raw_binary:
            self.skipTest(
                "BLOCKED: set FULLMAG_CURRENT_CLI_BIN to a binary built from the current worktree"
            )
        binary = Path(raw_binary).resolve()
        if not binary.is_file():
            self.skipTest(f"BLOCKED: current CLI binary does not exist: {binary}")

        problem_ir = materialize_fixture_ir(
            ROOT / "examples/viewport_2d_planar_monitor_fdm_smoke.py",
            qualification_profile="base",
            device="cpu",
        )
        with tempfile.TemporaryDirectory(prefix="fullmag-preflight-cli-e2e-") as temp_dir:
            problem_path = Path(temp_dir) / "problem-ir.json"
            problem_path.write_text(json.dumps(problem_ir), encoding="utf-8")
            plan = run_execution_planner(binary, problem_path)

        report = validate_execution_plan(plan, qualification_profile="base")
        self.assertTrue(report["pass"])

    def test_failure_atomically_replaces_stale_pass_report(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fullmag-preflight-output-") as temp_dir:
            output = Path(temp_dir) / "preflight.json"
            output.write_text('{"pass": true}\n', encoding="utf-8")
            argv = [
                "validate_viewport_2d_fdm_preflight.py",
                "--fixture",
                str(ROOT / "examples/viewport_2d_planar_monitor_fdm_smoke.py"),
                "--fullmag-bin",
                "/missing/fullmag",
                "--output",
                str(output),
            ]
            with patch("sys.argv", argv), patch(
                "scripts.analysis.validate_viewport_2d_fdm_preflight.materialize_fixture_ir",
                side_effect=PreflightError("fixture rejected"),
            ):
                self.assertEqual(main(), 1)

            report = json.loads(output.read_text(encoding="utf-8"))
            self.assertFalse(report["pass"])
            self.assertIn("fixture rejected", report["error"])


if __name__ == "__main__":
    unittest.main()
