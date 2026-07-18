import json
import tempfile
import unittest
from pathlib import Path

from scripts.analysis.validate_planar_monitor_sampling import (
    is_terminal_stop_conflict,
    is_transitional_stop_conflict,
    occupied_probe_coordinates,
    linear_ms_validation,
    run_execution,
    synchronize_cross_backend_reports,
)


class PlanarMonitorSamplingValidationTests(unittest.TestCase):
    def test_run_execution_requires_expected_backend_and_device(self) -> None:
        execution, matches = run_execution(
            {
                "requested_backend": "fem",
                "requested_device": "gpu",
                "resolved_backend": "fem",
                "resolved_device": "gpu",
                "resolved_runtime_family": "native_fem_gpu",
            },
            "fem",
            "gpu",
        )

        self.assertTrue(matches)
        self.assertEqual(execution["resolved_runtime_family"], "native_fem_gpu")
        self.assertTrue(
            run_execution(
                {
                    "requested_backend": "fem",
                    "requested_device": "cuda",
                    "resolved_backend": "fem",
                    "resolved_device": "gpu",
                    "resolved_runtime_family": "fem-gpu",
                },
                "fem",
                "gpu",
            )[1]
        )
        self.assertFalse(run_execution({}, "fem", "gpu")[1])

    def test_stop_cleanup_accepts_only_terminal_runtime_conflicts(self) -> None:
        self.assertTrue(
            is_terminal_stop_conflict(
                409,
                '{"error":"stop command requires a compatible runtime state; got completed"}',
            )
        )
        self.assertTrue(
            is_terminal_stop_conflict(
                409,
                '{"error":"stage control command requires an active stage"}',
            )
        )
        self.assertFalse(
            is_terminal_stop_conflict(
                409,
                '{"error":"another command is already in progress"}',
            )
        )
        self.assertTrue(
            is_transitional_stop_conflict(
                409,
                '{"error":"stop command requires a compatible runtime state; got waiting_for_compute"}',
            )
        )
        self.assertFalse(
            is_transitional_stop_conflict(
                409,
                '{"error":"another command is already in progress"}',
            )
        )
        self.assertFalse(
            is_terminal_stop_conflict(
                500,
                '{"error":"stop command requires a compatible runtime state; got completed"}',
            )
        )

    def test_probe_uses_nearest_occupied_pixel_to_frame_center(self) -> None:
        meta = {
            "frame": {"bounds_uv_m": [-2.0, 2.0, -2.0, 2.0]},
            "resolution": [4, 4],
        }
        values = [float("nan")] * 16
        values[6] = 1.0
        values[15] = 2.0

        occupancy = bytes([1] * 16)
        occupancy = occupancy[:6] + bytes([0]) + occupancy[7:15] + bytes([2])

        self.assertEqual(
            occupied_probe_coordinates(meta, values, occupancy), (0.5, -0.5)
        )

    def test_probe_accepts_overlap_ambiguous_surface_support(self) -> None:
        meta = {
            "frame": {"bounds_uv_m": [-1.0, 1.0, -1.0, 1.0]},
            "resolution": [2, 2],
        }

        self.assertEqual(
            occupied_probe_coordinates(
                meta,
                [float("nan"), 2.0, 3.0, float("nan")],
                bytes([1, 4, 3, 1]),
            ),
            (0.5, -0.5),
        )

    def test_linear_ms_uses_resolved_monitor_basis_and_pixel_centers(self) -> None:
        meta = {
            "frame": {
                "bounds_uv_m": [-2e-9, 2e-9, -1e-9, 1e-9],
                "origin_m": [0.0, 0.0, 0.0],
                "u_axis": [1.0, 0.0, 0.0],
                "v_axis": [0.0, 1.0, 0.0],
            },
            "resolution": [2, 1],
        }
        result = linear_ms_validation(
            meta,
            [799_000.0, 801_000.0],
            {"scalar": 800_000.0, "world_m": [0.0, 0.0, 0.0]},
        )

        self.assertEqual(result["rms_error_A_per_m"], 0.0)
        self.assertEqual(result["max_abs_error_A_per_m"], 0.0)
        self.assertEqual(result["probe_abs_error_A_per_m"], 0.0)

    def test_cross_backend_report_updates_both_lanes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fdm_path = root / "fdm-cpu" / "science-report.json"
            fem_path = root / "fem-cpu" / "science-report.json"
            for path, values in (
                (fdm_path, [799_000.0, 801_000.0]),
                (fem_path, [799_001.0, 800_999.0]),
            ):
                path.parent.mkdir(parents=True)
                path.write_text(
                    json.dumps(
                        {
                            "gates": {"local": True},
                            "linear_material_monitors": {
                                "xy-plane": {
                                    "linear_validation": {
                                        "raster_values_A_per_m": values,
                                        "rms_error_A_per_m": 1.0,
                                    },
                                    "stats": {
                                        "count": len(values),
                                        "mean": sum(values) / len(values),
                                    },
                                }
                            },
                            "metrics": {},
                            "pass": True,
                        }
                    )
                )

            synchronize_cross_backend_reports(fem_path)

            fdm = json.loads(fdm_path.read_text())
            fem = json.loads(fem_path.read_text())
            gate_id = "cross_backend_linear_scalar_fem_cpu"
            self.assertIn(gate_id, fdm["gates"])
            self.assertIn(gate_id, fem["gates"])
            self.assertTrue(fdm["gates"][gate_id])
            self.assertTrue(fem["gates"][gate_id])
            comparison = json.loads(
                (root / "cross-backend-fdm-cpu-fem-cpu.json").read_text()
            )
            self.assertEqual(
                comparison["schema_version"],
                "viewport-2d-cross-backend-report-v2",
            )
            self.assertEqual(
                comparison["metrics"]["comparison_method"],
                "shared_manufactured_field_error",
            )


if __name__ == "__main__":
    unittest.main()
