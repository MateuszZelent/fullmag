import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.analysis.validate_planar_monitor_sampling import (
    build_fdm_gpu_no_go,
    build_qualification_cases,
    attempted_monitor_report,
    exact_sample_identity_matches,
    is_terminal_stop_conflict,
    is_transitional_stop_conflict,
    occupied_probe_coordinates,
    linear_ms_validation,
    run_execution,
    synchronize_cross_backend_reports,
    validate_qualification_report,
)


class PlanarMonitorSamplingValidationTests(unittest.TestCase):
    def test_validator_exits_nonzero_for_a_blocked_qualification_report(self) -> None:
        source = (
            Path(__file__).resolve().parent
            / "analysis"
            / "validate_planar_monitor_sampling.py"
        ).read_text()

        self.assertIn('if not report["pass"]:', source)
        self.assertNotIn('if not all(report["gates"].values()):', source)

    def test_exact_sample_identity_requires_meta_token_and_matching_scalar_etag(self) -> None:
        meta = {"etag": '"sample:1"', "sample_token": "token:1"}

        self.assertTrue(exact_sample_identity_matches(meta, {"etag": '"sample:1"'}))
        self.assertFalse(exact_sample_identity_matches(meta, {"etag": '"sample:old"'}))
        self.assertFalse(exact_sample_identity_matches({"etag": '"sample:1"'}, {"etag": '"sample:1"'}))

    def test_attempted_monitor_case_retains_exact_runtime_error(self) -> None:
        monitor = {
            "id": "airbox-plane",
            "operator": {"kind": "plane_sample"},
            "target": {"kind": "domain"},
        }
        with patch(
            "scripts.analysis.validate_planar_monitor_sampling.monitor_report",
            side_effect=RuntimeError("airbox carrier unavailable"),
        ):
            result = attempted_monitor_report(
                "http://127.0.0.1:1",
                monitor,
                component="magnitude",
                quantity_id="H_demag",
            )

        self.assertFalse(result["passed"])
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["blocker"], "RuntimeError: airbox carrier unavailable")

    def test_runtime_fixtures_cover_all_frame_presets_region_and_demag(self) -> None:
        root = Path(__file__).resolve().parents[1]
        for backend in ("fdm", "fem"):
            source = (
                root / f"examples/viewport_2d_planar_monitor_{backend}_smoke.py"
            ).read_text()
            for monitor_id in ("xy-plane", "xz-plane", "yz-plane", "region-plane"):
                self.assertIn(f'monitor_id="{monitor_id}"', source)
            self.assertIn("film.add_region(", source)
            self.assertIn("study.demag(", source)
            self.assertIn("study.stages.add_hysteresis_sweep(", source)
            self.assertIn('magnetization="every_n"', source)

    def test_qualification_cases_fail_closed_for_unexecuted_required_axes(self) -> None:
        cases = build_qualification_cases(
            backend="fdm",
            device="cpu",
            executed_case_ids={"live-m-xy-plane"},
        )

        by_id = {case["case_id"]: case for case in cases}
        self.assertEqual(by_id["live-m-xy-plane"]["status"], "passed")
        self.assertEqual(by_id["persisted-m-xy-plane"]["status"], "blocked")
        self.assertEqual(by_id["fdm-object-isolation"]["status"], "blocked")
        self.assertFalse(all(case["passed"] for case in cases))

    def test_fdm_gpu_is_an_explicit_no_go_not_inherited_from_cpu(self) -> None:
        no_go = build_fdm_gpu_no_go("deadbeef")

        self.assertEqual(no_go["lane"], "fdm-gpu")
        self.assertEqual(no_go["qualification_status"], "no_go")
        self.assertFalse(no_go["qualified"])
        self.assertEqual(no_go["head"], "deadbeef")
        self.assertIn("own runtime gate", no_go["reason"])

    def test_report_contract_requires_runtime_identity_revisions_probe_and_cases(self) -> None:
        monitor = {
            "carrier_revision": 4,
            "exact_sample_identity": True,
            "field_revision": 5,
            "frame": {"normal": [0.0, 0.0, 1.0]},
            "generation_id": "generation:1",
            "mesh_revision": 6,
            "monitor_hash": "sha256:monitor",
            "monitor_id": "xy-plane",
            "monitor_revision": 3,
            "oracle": {"expected_scalar": 1.0, "kind": "constant_unit_magnitude"},
            "operator": {"kind": "plane_sample"},
            "probe": {"scalar": 1.0, "world_m": [0.0, 0.0, 0.0]},
            "quantity_id": "m",
            "sample_token": "sample:1",
            "scene_revision": 2,
            "target": {"kind": "object", "object_id": "film"},
            "vector_exact_sample_identity": True,
            "vector_constant_max_error": 0.0,
            "vector_identity": '"sample:1"',
            "vector_value_count": 3_072,
        }
        report = {
            "execution": {
                "requested_backend": "fdm",
                "requested_device": "cpu",
                "resolved_backend": "fdm",
                "resolved_device": "cpu",
            },
            "head": "deadbeef",
            "monitors": {"xy-plane": monitor},
            "qualification_cases": [{"case_id": "live-m-xy-plane", "status": "passed"}],
            "runtime_bundle_identity": {
                "runtime_bundle_version": "2026-08-13",
                "resolved_runtime_family": "fdm-cpu",
            },
        }

        validate_qualification_report(report)
        del report["monitors"]["xy-plane"]["sample_token"]
        with self.assertRaisesRegex(ValueError, "sample_token"):
            validate_qualification_report(report)

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
                            "head": "deadbeef",
                            "linear_material_monitors": {
                                "xy-plane": {
                                    "exact_sample_identity": True,
                                    "frame": {"preset": "xy"},
                                    "linear_validation": {
                                        "raster_values_A_per_m": values,
                                        "rms_error_A_per_m": 1.0,
                                    },
                                    "monitor_hash": "sha256:shared-monitor",
                                    "operator": {"kind": "plane_sample"},
                                    "quantity_id": "mat_ms",
                                    "stats": {
                                        "count": len(values),
                                        "mean": sum(values) / len(values),
                                    },
                                    "target": {
                                        "kind": "object",
                                        "object_id": "planar_film",
                                    },
                                }
                            },
                            "metrics": {},
                            "qualification_complete": True,
                            "pass": True,
                            "runtime_bundle_identity": {
                                "runtime_bundle_version": "bundle:shared"
                            },
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
                "samplewise_shared_geometry_raster",
            )

    def test_cross_backend_report_fails_closed_when_linear_evidence_is_missing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fdm_path = root / "fdm-cpu" / "science-report.json"
            fem_path = root / "fem-cpu" / "science-report.json"
            for path in (fdm_path, fem_path):
                path.parent.mkdir(parents=True)
                path.write_text(json.dumps({"gates": {}, "metrics": {}, "pass": True}))

            synchronize_cross_backend_reports(fem_path)

            comparison = json.loads(
                (root / "cross-backend-fdm-cpu-fem-cpu.json").read_text()
            )
            self.assertFalse(comparison["pass"])
            self.assertEqual(comparison["status"], "blocked")
            self.assertIn("missing or blocked", comparison["metrics"]["blocker"])


if __name__ == "__main__":
    unittest.main()
