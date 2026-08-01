import importlib.util
import hashlib
import io
import json
import os
import struct
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).with_name("verify_fem_preview_surface_matrix.py")
SPEC = importlib.util.spec_from_file_location("verify_fem_preview_surface_matrix", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MATRIX = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MATRIX)


def callback_profile_payload(
    *,
    persist_artifact: bool,
    artifact_refs: list[object] | None = None,
    persistence_failed: bool = False,
    overhead: object | None = None,
) -> dict[str, object]:
    return {
        "state": "active",
        "config": {
            "enabled": True,
            "persist_artifact": persist_artifact,
        },
        "latest_samples": [
            {
                "step": 1,
                "phases": [
                    {"id": "preview", "wall_time_ns": 100},
                    {"id": "preview_callback_thread_cpu", "wall_time_ns": 80},
                ],
            }
        ],
        "artifact_refs": artifact_refs if artifact_refs is not None else [],
        "persistence_failed": persistence_failed,
        "overhead": overhead
        if overhead is not None
        else {
            "last_persist_wall_time_ns": 10,
            "total_persist_wall_time_ns": 20,
            "persist_enqueued_count": 1,
            "persist_completed_count": 1,
        },
    }


class FemPreviewSurfaceMatrixContractTests(unittest.TestCase):
    def test_binary_request_preserves_http_error_body_and_url(self) -> None:
        error = urllib.error.HTTPError(
            "http://127.0.0.1:18197/field",
            500,
            "Internal Server Error",
            {},
            io.BytesIO(b'{"error":"FMVP value count mismatch"}'),
        )

        with mock.patch.object(MATRIX.urllib.request, "urlopen", side_effect=error):
            with self.assertRaisesRegex(
                RuntimeError,
                r"GET http://127\.0\.0\.1:18197/field failed: HTTP 500: .*FMVP value count mismatch",
            ):
                MATRIX.request_bytes("http://127.0.0.1:18197", "/field")

    def test_empty_energy_proof_matches_qualified_row_schema(self) -> None:
        proof = MATRIX.empty_energy_proof()

        self.assertEqual(
            set(proof),
            {
                "energy_comparisons",
                "energy_fixture_cubic",
                "energy_qualification",
                "energy_fixture_ms_location",
                "energy_fixture_regional_ms_range",
                "energy_projection_locations",
            },
        )
        self.assertNotIn("energy_projection_location", proof)

    def test_matrix_csv_schema_is_the_explicit_union_of_heterogeneous_rows(self) -> None:
        rows = [
            {"cadence": 10, "energy_projection_locations": None},
            {"cadence": 25, "energy_qualification": "cubic"},
        ]

        columns = MATRIX.matrix_csv_columns(rows)
        self.assertEqual(
            columns,
            ["cadence", "energy_projection_locations", "energy_qualification"],
        )
        self.assertEqual(
            MATRIX.matrix_csv_record(rows[0], columns),
            {
                "cadence": 10,
                "energy_projection_locations": None,
                "energy_qualification": None,
            },
        )
        self.assertEqual(
            MATRIX.matrix_csv_record(rows[1], columns),
            {
                "cadence": 25,
                "energy_projection_locations": None,
                "energy_qualification": "cubic",
            },
        )

    def test_matrix_never_retries_failed_rows(self) -> None:
        source = MODULE_PATH.read_text(encoding="utf-8")

        self.assertNotIn("clock-retry", source)
        self.assertNotIn("is_startup_clock_regression", source)

    def test_api_batches_bound_each_lifecycle_to_one_variant(self) -> None:
        batches = list(
            MATRIX.matrix_api_batches(
                modes=("disabled", "m"),
                cadences=(10, 25),
                surfaces=("headless", "control_room"),
                repeats=5,
            )
        )

        self.assertEqual(len(batches), 8)
        self.assertTrue(all(len(batch) == 6 for batch in batches))
        for batch in batches:
            variants = {(mode, cadence, surface) for mode, cadence, surface, _ in batch}
            self.assertEqual(len(variants), 1)
            self.assertEqual([repeat for *_, repeat in batch], list(range(6)))

    def test_browser_cleanup_reaps_after_forced_kill(self) -> None:
        process = mock.Mock()
        process.wait.side_effect = [subprocess.TimeoutExpired("browser", 10), 0]

        MATRIX.stop_browser_process(process)

        process.terminate.assert_called_once_with()
        process.kill.assert_called_once_with()
        self.assertEqual(process.wait.call_count, 2)

    def test_api_lifecycle_waits_for_readiness_and_reaps(self) -> None:
        process = mock.Mock()
        process.poll.return_value = None
        process.wait.return_value = 0
        with tempfile.TemporaryDirectory() as temporary_dir:
            log_path = Path(temporary_dir) / "api.log"
            with (
                mock.patch.object(MATRIX.subprocess, "Popen", return_value=process),
                mock.patch.object(MATRIX, "wait_api") as wait_api,
                MATRIX.api_lifecycle(
                    api_base="http://127.0.0.1:18197",
                    api_env={},
                    api_log_path=log_path,
                    label="m-c10-control_room",
                    timeout_seconds=30.0,
                ),
            ):
                wait_api.assert_called_once_with(
                    "http://127.0.0.1:18197", process, 30.0
                )

        process.send_signal.assert_called_once_with(MATRIX.signal.SIGTERM)
        process.wait.assert_called_once_with(timeout=10.0)

    def test_solver_profile_command_can_enable_artifact_persistence(self) -> None:
        active_profile = {
            "state": "active",
            "config": {
                "enabled": True,
                "sample_every": 1,
                "persist_artifact": True,
            },
        }
        with (
            mock.patch.object(MATRIX, "PROFILE_PERSIST_ARTIFACT", True),
            mock.patch.object(
                MATRIX, "post_json", return_value={"accepted": True}
            ) as post_json,
            mock.patch.object(MATRIX, "get_json", return_value=active_profile),
        ):
            MATRIX.enable_solver_profile("http://127.0.0.1:18197", 1.0)

        payload = post_json.call_args.args[2]
        self.assertTrue(payload["profile"]["persist_artifact"])

    def test_persist_on_callback_profile_rejects_empty_artifact_refs(self) -> None:
        profile = callback_profile_payload(persist_artifact=True, artifact_refs=[])
        with (
            mock.patch.object(MATRIX, "PROFILE_PERSIST_ARTIFACT", True),
            mock.patch.object(MATRIX, "get_json", return_value=profile),
            self.assertRaisesRegex(RuntimeError, "artifact_refs"),
        ):
            MATRIX.callback_profile_proof("http://127.0.0.1:1", "m")

    def test_persist_on_callback_profile_rejects_persistence_failure(self) -> None:
        profile = callback_profile_payload(
            persist_artifact=True,
            artifact_refs=["diagnostics/solver_profile.jsonl"],
            persistence_failed=True,
        )
        with (
            mock.patch.object(MATRIX, "PROFILE_PERSIST_ARTIFACT", True),
            mock.patch.object(MATRIX, "get_json", return_value=profile),
            self.assertRaisesRegex(RuntimeError, "persistence_failed"),
        ):
            MATRIX.callback_profile_proof("http://127.0.0.1:1", "m")

    def test_persist_on_callback_profile_rejects_invalid_overhead_telemetry(self) -> None:
        profile = callback_profile_payload(
            persist_artifact=True,
            artifact_refs=["diagnostics/solver_profile.jsonl"],
            overhead={"last_persist_wall_time_ns": "10"},
        )
        with (
            mock.patch.object(MATRIX, "PROFILE_PERSIST_ARTIFACT", True),
            mock.patch.object(MATRIX, "get_json", return_value=profile),
            self.assertRaisesRegex(RuntimeError, "overhead"),
        ):
            MATRIX.callback_profile_proof("http://127.0.0.1:1", "m", 0.0)

    def test_persist_on_callback_profile_rejects_unacknowledged_write(self) -> None:
        profile = callback_profile_payload(
            persist_artifact=True,
            artifact_refs=["diagnostics/solver_profile.jsonl"],
            overhead={
                "last_persist_wall_time_ns": 10,
                "total_persist_wall_time_ns": 20,
                "persist_enqueued_count": 1,
                "persist_completed_count": 0,
            },
        )
        with (
            mock.patch.object(MATRIX, "PROFILE_PERSIST_ARTIFACT", True),
            mock.patch.object(MATRIX, "get_json", return_value=profile),
            self.assertRaisesRegex(RuntimeError, "persist_completed_count"),
        ):
            MATRIX.callback_profile_proof("http://127.0.0.1:1", "m", 0.0)

    def test_persist_on_callback_profile_polls_until_write_is_acknowledged(self) -> None:
        pending = callback_profile_payload(
            persist_artifact=True,
            artifact_refs=["diagnostics/solver_profile.jsonl"],
            overhead={
                "last_persist_wall_time_ns": 10,
                "total_persist_wall_time_ns": 20,
                "persist_enqueued_count": 1,
                "persist_completed_count": 0,
            },
        )
        complete = callback_profile_payload(
            persist_artifact=True,
            artifact_refs=["diagnostics/solver_profile.jsonl"],
        )
        with (
            mock.patch.object(MATRIX, "PROFILE_PERSIST_ARTIFACT", True),
            mock.patch.object(MATRIX, "get_json", side_effect=[pending, complete]) as get_json,
            mock.patch.object(MATRIX.time, "sleep"),
        ):
            proof = MATRIX.callback_profile_proof("http://127.0.0.1:1", "m", 1.0)

        self.assertEqual(get_json.call_count, 2)
        self.assertEqual(proof["solver_profile_overhead"]["persist_completed_count"], 1)

    def test_persist_on_disabled_profile_rejects_unacknowledged_write(self) -> None:
        profile = callback_profile_payload(
            persist_artifact=True,
            artifact_refs=["diagnostics/solver_profile.jsonl"],
            overhead={
                "last_persist_wall_time_ns": 10,
                "total_persist_wall_time_ns": 20,
                "persist_enqueued_count": 1,
                "persist_completed_count": 0,
            },
        )
        profile["preview_3d_disabled"] = True
        with (
            mock.patch.object(MATRIX, "PROFILE_PERSIST_ARTIFACT", True),
            mock.patch.object(MATRIX, "get_json", return_value=profile),
            self.assertRaisesRegex(RuntimeError, "persist_completed_count"),
        ):
            MATRIX.callback_profile_proof("http://127.0.0.1:1", "disabled", 0.0)

    def test_persist_on_disabled_profile_carries_acknowledged_proof(self) -> None:
        profile = callback_profile_payload(
            persist_artifact=True,
            artifact_refs=["diagnostics/solver_profile.jsonl"],
        )
        profile["preview_3d_disabled"] = True
        with (
            mock.patch.object(MATRIX, "PROFILE_PERSIST_ARTIFACT", True),
            mock.patch.object(MATRIX, "get_json", return_value=profile),
        ):
            proof = MATRIX.callback_profile_proof(
                "http://127.0.0.1:1", "disabled", 0.0
            )

        self.assertEqual(proof["callback_handoff_count"], 0)
        self.assertTrue(proof["solver_profile_persist_artifact"])
        self.assertEqual(
            proof["solver_profile_overhead"]["persist_completed_count"], 1
        )

    def test_assert_equivalence_rechecks_disabled_persistence(self) -> None:
        row = {
            "mode": "disabled",
            "cadence": 10,
            "surface": "interactive_no_browser",
            "repeat": 1,
            "solver_profile_persist_artifact": True,
            "solver_profile_artifact_refs": ["diagnostics/solver_profile.jsonl"],
            "solver_profile_persistence_failed": False,
            "solver_profile_overhead": {
                "last_persist_wall_time_ns": 10,
                "total_persist_wall_time_ns": 20,
                "persist_enqueued_count": 1,
                "persist_completed_count": 0,
            },
        }

        with (
            mock.patch.object(MATRIX, "PROFILE_PERSIST_ARTIFACT", True),
            self.assertRaisesRegex(
                RuntimeError, "terminal solver-profile persistence proof"
            ),
        ):
            MATRIX.assert_equivalence([row])

    def test_persist_on_callback_profile_accepts_valid_persistence_proof(self) -> None:
        profile = callback_profile_payload(
            persist_artifact=True,
            artifact_refs=["diagnostics/solver_profile.jsonl"],
        )
        with (
            mock.patch.object(MATRIX, "PROFILE_PERSIST_ARTIFACT", True),
            mock.patch.object(MATRIX, "get_json", return_value=profile),
        ):
            proof = MATRIX.callback_profile_proof("http://127.0.0.1:1", "m")

        self.assertEqual(
            proof["solver_profile_artifact_refs"],
            ["diagnostics/solver_profile.jsonl"],
        )
        self.assertFalse(proof["solver_profile_persistence_failed"])

    def test_persist_off_callback_profile_does_not_require_artifact_refs(self) -> None:
        profile = callback_profile_payload(persist_artifact=False, artifact_refs=[])
        with (
            mock.patch.object(MATRIX, "PROFILE_PERSIST_ARTIFACT", False),
            mock.patch.object(MATRIX, "get_json", return_value=profile),
        ):
            proof = MATRIX.callback_profile_proof("http://127.0.0.1:1", "m")

        self.assertEqual(proof["solver_profile_artifact_refs"], [])

    def test_assert_equivalence_rechecks_persist_on_artifact_refs(self) -> None:
        row = {
            "mode": "m",
            "cadence": 10,
            "surface": "interactive_no_browser",
            "repeat": 1,
            "callback_handoff_max_ns": 100,
            "callback_handoff_p50_ns": 100,
            "callback_thread_cpu_max_ns": 80,
            "callback_wall_outlier_count": 0,
            "callback_wall_outlier_details": [],
            "solver_profile_persist_artifact": True,
            "solver_profile_artifact_refs": [],
            "solver_profile_persistence_failed": False,
            "solver_profile_overhead": {
                "last_persist_wall_time_ns": 10,
                "total_persist_wall_time_ns": 20,
            },
        }

        with (
            mock.patch.object(MATRIX, "PROFILE_PERSIST_ARTIFACT", True),
            self.assertRaisesRegex(
                RuntimeError, "terminal solver-profile persistence proof"
            ),
        ):
            MATRIX.assert_equivalence([row])

    def test_matrix_python_path_keeps_virtualenv_symlink_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            python_link = Path(temporary_dir) / "python"
            python_link.symlink_to(sys.executable)

            selected = MATRIX.matrix_python_path(str(python_link))

            self.assertEqual(selected, python_link.absolute())
            self.assertNotEqual(selected, python_link.resolve())

    def test_matrix_python_preflight_checks_prefix_before_required_imports(self) -> None:
        python = Path("/tmp/fullmag-python/bin/python")
        with mock.patch.object(
            MATRIX.subprocess,
            "run",
            return_value=subprocess.CompletedProcess([], 0, "", ""),
        ) as run:
            MATRIX.require_matrix_python(python)

        probe = run.call_args.args[0][2]
        self.assertIn("sys.prefix", probe)
        self.assertIn(str(python.parent.parent), probe)
        self.assertLess(probe.find("sys.prefix"), probe.find("importlib.import_module"))

    def test_passing_callback_profile_persists_worst_callback_and_submit_details(
        self,
    ) -> None:
        profile = {
            "state": "active",
            "config": {"enabled": True, "persist_artifact": False},
            "artifact_refs": [],
            "persistence_failed": False,
            "latest_samples": [
                {
                    "step": 4,
                    "phases": [
                        {"id": "preview", "wall_time_ns": 100},
                        {"id": "orchestration", "wall_time_ns": 20},
                        {"id": "preview_submit", "wall_time_ns": 80},
                        {"id": "preview_submit_stage", "wall_time_ns": 3},
                        {"id": "preview_submit_descriptor", "wall_time_ns": 5},
                        {"id": "preview_submit_channel_alloc", "wall_time_ns": 7},
                        {"id": "preview_submit_try_send", "wall_time_ns": 11},
                        {"id": "preview_submit_bookkeeping", "wall_time_ns": 13},
                        {"id": "preview_submit_thread_cpu", "wall_time_ns": 31},
                        {"id": "preview_callback_thread_cpu", "wall_time_ns": 41},
                    ],
                },
                {
                    "step": 8,
                    "phases": [
                        {"id": "preview", "wall_time_ns": 90},
                        {"id": "orchestration", "wall_time_ns": 5},
                        {"id": "preview_submit", "wall_time_ns": 85},
                        {"id": "preview_submit_thread_cpu", "wall_time_ns": 80},
                        {"id": "preview_callback_thread_cpu", "wall_time_ns": 85},
                    ],
                },
            ],
        }

        with mock.patch.object(MATRIX, "get_json", return_value=profile):
            proof = MATRIX.callback_profile_proof("http://127.0.0.1:1", "m")

        self.assertEqual(proof["worst_callback_detail"]["step"], 4)
        self.assertEqual(proof["worst_callback_detail"]["total_ns"], 120)
        self.assertEqual(proof["worst_callback_detail"]["submit_ns"], 80)
        self.assertEqual(proof["worst_callback_detail"]["submit_thread_cpu_ns"], 31)
        self.assertEqual(proof["worst_callback_detail"]["submit_descheduled_ns"], 49)
        self.assertEqual(proof["worst_callback_detail"]["submit_channel_alloc_ns"], 7)
        self.assertEqual(proof["worst_submit_detail"]["step"], 8)
        self.assertEqual(proof["worst_submit_detail"]["submit_ns"], 85)
        self.assertEqual(proof["worst_submit_detail"]["submit_thread_cpu_ns"], 80)
        self.assertEqual(proof["worst_submit_detail"]["submit_descheduled_ns"], 5)
        self.assertEqual(proof["callback_thread_cpu_max_ns"], 85)

    def test_callback_policy_accepts_classified_scheduler_deschedule(self) -> None:
        profile = {
            "state": "active",
            "config": {"enabled": True, "persist_artifact": False},
            "artifact_refs": [],
            "persistence_failed": False,
            "latest_samples": [
                {
                    "step": step,
                    "phases": [
                        {"id": "preview", "wall_time_ns": wall_ns},
                        {"id": "orchestration", "wall_time_ns": 0},
                        {"id": "preview_submit", "wall_time_ns": wall_ns},
                        {"id": "preview_submit_thread_cpu", "wall_time_ns": cpu_ns},
                        {"id": "preview_callback_thread_cpu", "wall_time_ns": cpu_ns},
                    ],
                }
                for step, wall_ns, cpu_ns in (
                    (1, 100_000, 80_000),
                    (2, 120_000, 90_000),
                    (3, 2_900_000, 100_000),
                )
            ],
        }

        with mock.patch.object(MATRIX, "get_json", return_value=profile):
            proof = MATRIX.callback_profile_proof("http://127.0.0.1:1", "m")

        self.assertEqual(proof["callback_handoff_p50_ns"], 120_000)
        self.assertEqual(proof["callback_thread_cpu_max_ns"], 100_000)
        self.assertEqual(proof["callback_wall_outlier_count"], 1)
        self.assertEqual(proof["callback_wall_outlier_max_ns"], 2_900_000)
        self.assertEqual(proof["callback_wall_outlier_details"][0]["step"], 3)
        self.assertEqual(
            proof["callback_wall_outlier_details"][0]["callback_descheduled_ns"],
            2_800_000,
        )

    def test_callback_policy_rejects_code_induced_cpu_spike(self) -> None:
        profile = {
            "state": "active",
            "config": {"enabled": True, "persist_artifact": False},
            "artifact_refs": [],
            "persistence_failed": False,
            "latest_samples": [
                {
                    "step": step,
                    "phases": [
                        {"id": "preview", "wall_time_ns": wall_ns},
                        {"id": "orchestration", "wall_time_ns": 0},
                        {"id": "preview_submit", "wall_time_ns": wall_ns},
                        {"id": "preview_submit_thread_cpu", "wall_time_ns": cpu_ns},
                        {"id": "preview_callback_thread_cpu", "wall_time_ns": cpu_ns},
                    ],
                }
                for step, wall_ns, cpu_ns in (
                    (1, 100_000, 80_000),
                    (2, 120_000, 90_000),
                    (3, 2_900_000, 2_400_000),
                )
            ],
        }

        with mock.patch.object(MATRIX, "get_json", return_value=profile):
            with self.assertRaisesRegex(RuntimeError, "thread CPU"):
                MATRIX.callback_profile_proof("http://127.0.0.1:1", "m")

    def test_matrix_python_preflight_fails_before_runtime_setup(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            temporary_root = Path(temporary_dir)
            failing_python = temporary_root / "python"
            failing_python.write_text(
                "#!/bin/sh\nprintf 'missing required modules: numpy\\n' >&2\nexit 1\n",
                encoding="utf-8",
            )
            failing_python.chmod(0o755)
            report_dir = temporary_root / "report-must-not-exist"
            env = os.environ.copy()
            env["FULLMAG_MATRIX_PYTHON"] = str(failing_python)

            completed = subprocess.run(
                [
                    sys.executable,
                    str(MODULE_PATH),
                    "--report-dir",
                    str(report_dir),
                ],
                capture_output=True,
                env=env,
                text=True,
            )

            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("matrix Python preflight failed", completed.stderr)
            self.assertIn("numpy", completed.stderr)
            self.assertFalse(
                report_dir.exists(),
                "preflight must fail before report directories or services are created",
            )

    def test_h_demag_terminal_artifact_converts_soa_chunk_to_api_aos(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            output_dir = Path(temporary_dir)
            zarr_dir = output_dir / "fields" / "H_demag.zarr"
            zarr_dir.mkdir(parents=True)
            (zarr_dir / ".zarray").write_text(
                json.dumps(
                    {
                        "chunks": [1, 3, 2],
                        "compressor": None,
                        "dtype": "<f8",
                        "order": "C",
                        "shape": [2, 3, 2],
                        "zarr_format": 2,
                    }
                ),
                encoding="utf-8",
            )
            (zarr_dir / ".zattrs").write_text(
                json.dumps(
                    {
                        "axes": ["sample", "component", "cell"],
                        "storage_layout": "soa_component_major",
                    }
                ),
                encoding="utf-8",
            )
            (zarr_dir / "samples.csv").write_text(
                "sample,step,time,solver_dt,chunk_key,dtype,scalar_bytes,cell_count\n"
                "0,0,0,0,0.0.0,<f8,8,2\n"
                "1,52,1,1,1.0.0,<f8,8,2\n",
                encoding="utf-8",
            )
            soa = [1.0, 4.0, 2.0, 5.0, 3.0, 6.0]
            (zarr_dir / "1.0.0").write_bytes(struct.pack("<6d", *soa))

            proof = MATRIX.h_demag_terminal_artifact_proof(output_dir, 52)

            expected_aos = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0]
            expected_bytes = struct.pack("<6d", *expected_aos)
            self.assertEqual(
                proof["_artifact_h_demag_terminal_values"], expected_aos
            )
            self.assertEqual(
                proof["artifact_h_demag_terminal_aos_sha256"],
                hashlib.sha256(expected_bytes).hexdigest(),
            )

    def test_h_demag_only_keeps_direct_preterminal_payload_proof(self) -> None:
        self.assertEqual(
            MATRIX.preterminal_quantities_for_mode("H_demag"),
            ("H_demag",),
        )
        self.assertTrue(MATRIX.requires_primary_live_proof("H_demag"))
        self.assertTrue(
            MATRIX.requires_browser_consumed_response("H_demag", "control_room")
        )
        self.assertFalse(
            MATRIX.requires_browser_pending_state("H_demag", "control_room")
        )

    def test_full_cache_uses_terminal_cache_and_browser_proofs(self) -> None:
        self.assertEqual(
            MATRIX.preterminal_quantities_for_mode("full_cache"),
            (),
        )
        self.assertFalse(MATRIX.requires_primary_live_proof("full_cache"))
        self.assertTrue(MATRIX.requires_terminal_full_cache_proof("full_cache"))
        self.assertEqual(
            set(MATRIX.terminal_quantities_for_mode("full_cache")),
            {
                "m",
                "H_ex",
                "H_demag",
                "H_ext",
                "H_eff",
                "torque",
                "H_ani_cubic",
                "eden_ex",
                "eden_demag",
                "eden_ext",
                "eden_ani",
                "eden_total",
            },
        )
        self.assertFalse(
            MATRIX.requires_browser_consumed_response("full_cache", "control_room")
        )
        self.assertTrue(
            MATRIX.requires_browser_pending_state("full_cache", "control_room")
        )
        self.assertFalse(
            MATRIX.requires_browser_consumed_response(
                "full_cache", "interactive_no_browser"
            )
        )

    def test_dedicated_energy_qualifications_select_distinct_operator_payloads(self) -> None:
        with mock.patch.object(MATRIX, "ENERGY_QUALIFICATION", "dg0_ms"):
            dg0 = set(MATRIX.terminal_quantities_for_mode("full_cache"))
            self.assertNotIn("H_ani_cubic", dg0)
            self.assertNotIn("eden_ani", dg0)
            env = MATRIX.common_runtime_env("full_cache", 10, "interactive_no_browser", "/tmp", 1)
            self.assertEqual(env["FULLMAG_FEM_EXECUTION"], "cpu")

        with mock.patch.object(MATRIX, "ENERGY_QUALIFICATION", "uniaxial"):
            uniaxial = set(MATRIX.terminal_quantities_for_mode("full_cache"))
            self.assertIn("H_ani", uniaxial)
            self.assertNotIn("H_ani_cubic", uniaxial)

        with mock.patch.object(MATRIX, "ENERGY_QUALIFICATION", "cubic"):
            cubic = set(MATRIX.terminal_quantities_for_mode("full_cache"))
            self.assertIn("H_ani_cubic", cubic)
            self.assertNotIn("H_ani", cubic)

        with mock.patch.object(MATRIX, "ENERGY_QUALIFICATION", "interfacial_dmi"):
            interfacial = set(MATRIX.terminal_quantities_for_mode("full_cache"))
            self.assertIn("H_dmi", interfacial)
            self.assertNotIn("H_dmi_bulk", interfacial)
            self.assertNotIn("eden_ani", interfacial)

        with mock.patch.object(MATRIX, "ENERGY_QUALIFICATION", "bulk_dmi"):
            bulk = set(MATRIX.terminal_quantities_for_mode("full_cache"))
            self.assertIn("H_dmi_bulk", bulk)
            self.assertNotIn("H_dmi", bulk)
            self.assertNotIn("eden_ani", bulk)


if __name__ == "__main__":
    unittest.main()
