"""Regressions for native preparation of a fresh Windows runtime state."""

from __future__ import annotations

import inspect
import hashlib
import contextlib
import io
import json
import os
import subprocess
from pathlib import Path
import sys
import tempfile
import unittest
import urllib.parse
import urllib.request
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_volume_dev


class DockerVolumeDevRuntimeStateTests(unittest.TestCase):
    @staticmethod
    def _frontend_owner_service(actual_options):
        owner = "/run/fullmag/frontend-owner"
        return {
            "document": {
                "services": {
                    "frontend": {
                        "environment": {},
                        "labels": {},
                        "volumes": [],
                        "tmpfs": [owner + ":rw,nosuid,nodev,noexec,size=1m,uid=65532,gid=65532,mode=0700"],
                    }
                },
                "volumes": {},
            },
            "actual": {
                "Config": {"Env": [], "Labels": {}},
                "HostConfig": {
                    "ReadonlyRootfs": True,
                    "Privileged": False,
                    "Tmpfs": {owner: actual_options},
                },
                "Mounts": [{"Destination": owner, "Type": "tmpfs", "RW": True}],
            },
        }

    def test_retained_frontend_owner_tmpfs_is_exact_and_conflicts_fail_closed(self):
        fixture = self._frontend_owner_service(
            "rw,nosuid,nodev,noexec,size=1m,uid=65532,gid=65532,mode=0700"
        )
        docker_volume_dev._validate_retained_service(
            fixture["document"], fixture["actual"], "frontend", {}
        )
        for tampered in (
            "ro,nosuid,nodev,noexec,size=1m,uid=65532,gid=65532,mode=0700",
            "rw,ro,nosuid,nodev,noexec,size=1m,uid=65532,gid=65532,mode=0700",
            "rw,nosuid,nodev,exec,size=1m,uid=65532,gid=65532,mode=0700",
            "rw,nosuid,nodev,noexec,size=1m,uid=65532,gid=65532,mode=0777",
        ):
            with self.subTest(tampered=tampered):
                changed = self._frontend_owner_service(tampered)
                with self.assertRaisesRegex(docker_volume_dev.BuildControlError, "tmpfs"):
                    docker_volume_dev._validate_retained_service(
                        changed["document"], changed["actual"], "frontend", {}
                    )

    def test_native_contract_allowlist_keeps_one_contract_per_invocation(self):
        self.assertEqual(docker_volume_dev._native_contracts(None), ())
        self.assertEqual(docker_volume_dev._native_contracts([]), ())
        self.assertEqual(
            docker_volume_dev._native_contracts(["fem-cuda-activity-trace"]),
            ("fem-cuda-activity-trace",),
        )
        self.assertEqual(
            docker_volume_dev._native_contracts(["fem-demag-poisson"]),
            ("fem-demag-poisson",),
        )
        for values in (
            ["unknown-contract"],
            ["fem-cuda-activity-trace", "fem-demag-poisson"],
            ["fem-cuda-activity-trace", "fem-cuda-activity-trace"],
            "fem-cuda-activity-trace",
        ):
            with self.subTest(values=values), self.assertRaisesRegex(
                docker_volume_dev.BuildControlError, "Native contracts"
            ):
                docker_volume_dev._native_contracts(values)

    def test_legacy_frontend_manifest_is_allowed_only_for_recreation(self):
        fixture = self._frontend_owner_service(
            "rw,nosuid,nodev,noexec,size=1m,uid=65532,gid=65532,mode=0700"
        )
        fixture["document"]["services"]["frontend"].pop("tmpfs")
        fixture["actual"]["HostConfig"].pop("Tmpfs")
        fixture["actual"]["Mounts"] = []
        with self.assertRaisesRegex(docker_volume_dev.BuildControlError, "missing.*owner tmpfs"):
            docker_volume_dev._validate_retained_service(
                fixture["document"], fixture["actual"], "frontend", {}
            )
        docker_volume_dev._validate_retained_service(
            fixture["document"],
            fixture["actual"],
            "frontend",
            {},
            allow_legacy_frontend=True,
        )

    @staticmethod
    def _prepared_restart_probe_script():
        captured = {}

        def capture(*args, **kwargs):
            captured["script"] = args[-1]
            return "null\n"

        with patch.object(docker_volume_dev, "docker_text", side_effect=capture):
            result = docker_volume_dev._terminal_session_restart_probe(
                "e" * 64, allow_prepared=True,
            )
        if result is not None:
            raise AssertionError("probe generation unexpectedly returned a runtime result")
        return captured["script"]

    def _execute_prepared_restart_probe(self, commands, *, queue_items=(), released_runs=()):
        run_id = "run-prepared-1"
        session_id = "session-prepared-1"
        api_instance = "11111111-2222-4333-8444-555555555555"
        resource_revisions = {
            "scene_revision": 5,
            "mesh_revision": 8,
            "stages_revision": 3,
            "commands_revision": 10,
            "command_completion_revision": 10,
            "simulation_preparation_revision": 2,
        }
        status = {
            "session": {
                "session_id": session_id,
                "session_epoch": "epoch-7",
                "request_scope_epoch": "scope-9",
            },
            "solver": {"state": "awaiting_command"},
            "resources": resource_revisions,
            "run": {"run_id": run_id},
        }
        current_run = {
            "run_id": run_id,
            "session_id": session_id,
            "status": "waiting_for_solve",
            "revision": 11,
        }
        queue = {
            "schema_version": "compute_queue.v1",
            "next_cursor": None,
            "items": list(queue_items),
        }
        routes = {
            "/v2/sessions/current/status": status,
            "/v2/sessions/current/simulation/runs/current": current_run,
            "/v2/platform/compute/queue": queue,
            "/v2/platform/runtime-service": {"configured": True, "state": "ready"},
            "/v2/sessions/current/simulation/preparation": {
                "status": "ready", "failure": None,
            },
            "/v2/sessions/current/simulation/stages/execution": {
                "run_id": run_id,
                "runtime_state": "awaiting_command",
                "total_stages": 3,
                "stage_statuses": ["pending", "pending", "pending"],
                "completed_stage_indexes": [],
            },
            "/v2/sessions/current/simulation/commands": commands,
        }

        class Headers:
            @staticmethod
            def get_all(name):
                return [api_instance] if name.lower() == "x-fullmag-api-instance" else []

        class Response:
            status = 200
            headers = Headers()

            def __init__(self, value):
                self.raw = json.dumps(value).encode("utf-8")

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, traceback):
                return False

            def read(self, size=-1):
                return self.raw if size < 0 else self.raw[:size]

        def urlopen(request, timeout=30):
            path = urllib.parse.urlsplit(request.full_url).path
            if request.get_method() != "GET" or path not in routes:
                raise AssertionError(f"unexpected preflight request: {request.get_method()} {path}")
            return Response(routes[path])

        script = self._prepared_restart_probe_script()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            runs_root = root / "runs"
            runs_root.mkdir()
            held_run_ids = {run_id}
            held_run_ids.update(item["run_id"] for item in queue_items)
            for held_run_id in held_run_ids:
                run_root = runs_root / held_run_id
                run_root.mkdir()
                intent = {
                    "run_id": held_run_id,
                    "specification": {
                        "parameters": {
                            "fullmag.accepted_run_start": {
                                "schema_version": "accepted_run_start_policy.v1",
                                "mode": "manual",
                            },
                        },
                    },
                }
                (run_root / "run_intent.json").write_text(json.dumps(intent), encoding="utf-8")
                if held_run_id in released_runs:
                    (run_root / "start_release.json").write_text("{}", encoding="utf-8")
            config = root / "runtime-service.json"
            config.write_text(json.dumps({"store_root": str(root)}), encoding="utf-8")
            output = io.StringIO()
            namespace = {"__name__": "__restart_probe_fixture__"}
            with patch.dict(os.environ, {"FULLMAG_RUNTIME_SERVICE_CONFIG": str(config)}):
                with patch.object(urllib.request, "urlopen", side_effect=urlopen):
                    with contextlib.redirect_stdout(output):
                        exec(compile(script, "<prepared-restart-probe-fixture>", "exec"), namespace)
            return json.loads(output.getvalue())

    @staticmethod
    def _prepared_commands(records):
        states = {
            "pending_count": "queued",
            "accepted_count": "accepted",
            "dispatched_count": "dispatched",
            "running_count": "running",
            "completed_count": "completed",
            "rejected_count": "rejected",
            "failed_count": "failed",
        }
        return {
            "revision": 10,
            **{field: sum(record.get("status") == state for record in records)
               for field, state in states.items()},
            "can_accept_commands": False,
            "runtime_controls": [],
            "commands": list(records),
        }

    @staticmethod
    def _completed_grid_record(run_id="run-prepared-1", *, command_id="cmd-grid-1", seq=1):
        return {
            "command_id": command_id,
            "seq": seq,
            "kind": "fdm_grid_refresh",
            "target": {"kind": "run", "run_id": run_id},
            "status": "completed",
            "created_at_unix_ms": 100,
            "dispatched_at_unix_ms": 110,
            "completed_at_unix_ms": 120,
            "completion_status": "completed",
            "error": None,
        }

    def test_prepared_restart_probe_accepts_empty_or_completed_current_run_grid_ledger(self):
        queue_items = [{"run_id": "run-held-2", "state": "accepted"}]
        synchronous_grid = self._completed_grid_record()
        # Synchronous preparation receipts omit the optional dispatch timestamp
        # and the absent error field, matching the real UI Grid response.
        synchronous_grid.pop("dispatched_at_unix_ms")
        synchronous_grid.pop("error")
        for records in ([], [self._completed_grid_record()], [synchronous_grid]):
            with self.subTest(record_count=len(records), synchronous=records == [synchronous_grid]):
                result = self._execute_prepared_restart_probe(
                    self._prepared_commands(records), queue_items=queue_items,
                )
                self.assertEqual(result["schema"], "fullmag.docker-prepared-session-drain-preflight.v1")
                self.assertEqual(result["session_id"], "session-prepared-1")
                self.assertEqual(result["session_epoch"], "epoch-7")
                self.assertEqual(result["request_scope_epoch"], "scope-9")
                self.assertEqual(result["run"]["run_id"], "run-prepared-1")
                self.assertEqual(set(result["held_run_intent_sha256"]), {"run-prepared-1", "run-held-2"})
                self.assertEqual(result["prepared_commands"], self._prepared_commands(records))

    def test_prepared_restart_probe_rejects_foreign_or_nonterminal_command_receipts(self):
        queue_items = [{"run_id": "run-held-2", "state": "accepted"}]
        valid = self._completed_grid_record()
        rejected = []
        foreign = dict(valid, target={"kind": "run", "run_id": "run-held-2"})
        rejected.append(("foreign run", foreign, None))
        wrong_kind = dict(valid, kind="compute_energies")
        rejected.append(("compute command", wrong_kind, None))
        for state in ("queued", "accepted", "dispatched", "running", "rejected", "failed"):
            rejected.append((state, dict(valid, status=state), None))
        rejected.append(("cancelled completion", dict(valid, completion_status="cancelled"), None))
        rejected.append(("failed completion", dict(valid, completion_status="failed"), None))
        rejected.append(("error receipt", dict(valid, error="grid failed"), None))
        rejected.append(("bad timestamp order", dict(valid, completed_at_unix_ms=109), None))
        rejected.append(("invalid dispatch timestamp", dict(valid, dispatched_at_unix_ms="110"), None))
        rejected.append(("missing completion timestamp", dict(valid, completed_at_unix_ms=None), None))
        synchronous_reversed = dict(valid, completed_at_unix_ms=99)
        synchronous_reversed.pop("dispatched_at_unix_ms")
        rejected.append(("reversed synchronous receipt", synchronous_reversed, None))
        rejected.append(("duplicate command id", dict(valid, seq=2), [valid]))
        rejected.append(("duplicate sequence", dict(valid, command_id="cmd-grid-2"), [valid]))
        for label, record, extra_records in rejected:
            with self.subTest(label=label), self.assertRaisesRegex(
                RuntimeError, "prepared restart",
            ):
                self._execute_prepared_restart_probe(
                    self._prepared_commands([*(extra_records or ()), record]),
                    queue_items=queue_items,
                )

    def test_prepared_restart_probe_rejects_inconsistent_counts_and_released_manual_runs(self):
        record = self._completed_grid_record()
        inconsistent = self._prepared_commands([record])
        inconsistent["completed_count"] = 0
        with self.assertRaisesRegex(RuntimeError, "prepared restart"):
            self._execute_prepared_restart_probe(inconsistent)
        stale_revision = self._prepared_commands([record])
        stale_revision["revision"] = 9
        with self.assertRaisesRegex(RuntimeError, "prepared restart"):
            self._execute_prepared_restart_probe(stale_revision)

        for released_run in ("run-prepared-1", "run-held-2"):
            with self.subTest(released_run=released_run), self.assertRaisesRegex(
                RuntimeError, "released Compute gate",
            ):
                self._execute_prepared_restart_probe(
                    self._prepared_commands([record]),
                    queue_items=[{"run_id": "run-held-2", "state": "accepted"}],
                    released_runs=(released_run,),
                )

    def test_actual_process_probe_reads_runtime_control_receipt_and_missing_state(self):
        with tempfile.TemporaryDirectory() as directory:
            control = Path(directory) / "runtime-control"
            receipt = control / "runtime-service" / "process-tree.json"
            receipt.parent.mkdir(parents=True)
            expected = {"state": "failed-confirmed", "error": "admission closed"}
            receipt.write_text(json.dumps(expected))
            environment = {
                "PATH": os.environ.get("PATH", ""),
                "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "docker/all-in-one"),
                "FULLMAG_RUNTIME_CONTROL_ROOT": str(control),
            }
            for present in (True, False):
                if not present:
                    receipt.unlink()
                result = subprocess.run(
                    [sys.executable, "-B", "-c", docker_volume_dev.BACKEND_PROCESS_RECEIPT_SCRIPT],
                    env=environment, text=True, capture_output=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout), expected if present else {"state": "not-published"})

    def test_restart_probe_recognizes_profiled_startup_refusals(self):
        captured = {}

        def capture(*args, **kwargs):
            captured["args"] = args
            return subprocess.CompletedProcess(args, 0, b"null\n", b"")

        with patch.object(docker_volume_dev, "docker_capture", side_effect=capture):
            result = docker_volume_dev._terminal_session_restart_probe("e" * 64)

        self.assertIsNone(result)
        script = captured["args"][-1]
        compile(script, "<terminal-session-restart-probe>", "exec")
        self.assertIn('"solver_profile" in authorization', script)
        self.assertIn('"solver_profile_sha256"', script)
        self.assertIn('"invalid_solver_profile"', script)
        self.assertIn('"accepted_solver_profile_unsupported"', script)

    def test_restart_probe_authenticates_cuda_trace_refusal_marker_at_runtime(self):
        request_id = "cuda-trace-refusal"
        source_sha256 = "b" * 64
        relative = "examples/sp4.py"
        trace = {
            "schema_version": "accepted_cuda_trace.v1",
            "max_bytes": 67108864,
            "max_duration_ms": 60000,
        }
        solver_profile = {
            "schema_version": "accepted_solver_profile.v1",
            "config": {
                "enabled": True,
                "sample_every": 1,
                "sample_interval_wall_ms": 0,
                "max_samples": 128,
                "emit_engine_log": False,
                "persist_artifact": True,
            },
        }
        authorization = {
            "schema": "fullmag.docker-startup-script.v1",
            "authorization": "explicit_startup_script",
            "source_root": "/source",
            "source_path": "/source/" + relative,
            "source_relative": relative,
            "source_sha256": source_sha256,
            "source_size_bytes": 10,
            "source_commit": None,
            "container_source_root": "/opt/fullmag/source",
            "container_script_path": "/opt/fullmag/source/" + relative,
            "request_id": request_id,
            "execution_policy": {
                "mode": "canonical_live_v2", "auto_study": True,
                "interactive": "script_metadata", "wait_for_solve": "script_metadata",
                "legacy_cli": False,
            },
            "solver_profile": solver_profile,
            "cuda_trace": trace,
        }
        key = hashlib.sha256(request_id.encode()).hexdigest()
        marker = {
            "schema": "fullmag.docker-startup-activation-receipt.v1",
            "state": "rejected",
            "request_id": request_id,
            "provenance_sha256": "c" * 64,
            "source_sha256": source_sha256,
            "authorization": authorization,
            "result": {
                "schema": "fullmag.startup-script-activation.v1",
                "state": "rejected",
                "request_id": request_id,
                "source_sha256": source_sha256,
                "source_relative": relative,
                "rejection": {
                    "http_status": 422,
                    "code": "accepted_cuda_trace_unsupported",
                    "message": "trace unavailable",
                },
            },
        }

        with tempfile.TemporaryDirectory() as temporary:
            control_root = Path(temporary).resolve()
            marker_dir = control_root / ("script-activation-" + key)
            marker_dir.mkdir()
            marker_path = marker_dir / "activation.json"
            marker_path.write_text(json.dumps(marker), encoding="utf-8")

            captured = {}

            def capture(*args, **kwargs):
                captured["args"] = args
                return subprocess.CompletedProcess(args, 0, b"null\n", b"")

            with patch.object(docker_volume_dev, "docker_capture", side_effect=capture):
                probe_result = docker_volume_dev._terminal_session_restart_probe(
                    "e" * 64, startup_enabled=False,
                )
            self.assertIsNone(probe_result)
            probe = captured["args"][-1]
            code = probe[probe.index("def unique_object"):
                         probe.index("def startup_failed_preacceptance")]
            code = code.replace("/opt/fullmag/control/backend", str(control_root))
            namespace = {
                "STARTUP_ENABLED": False,
                "MAX": 1024 * 1024,
                "MAX_STARTUP_RECEIPT": 2 * 1024 * 1024,
                "MAX_STARTUP_MARKERS": 256,
                "MAX_CONTROL_ENTRIES": 4096,
                "hashlib": hashlib,
                "json": json,
                "os": os,
                "re": __import__("re"),
                "stat": __import__("stat"),
            }
            exec(compile(code, "<restart-probe-startup-marker>", "exec"), namespace)
            canonical_sha256 = lambda value: hashlib.sha256(
                json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest()
            profile_sha256 = canonical_sha256(solver_profile)
            status = {"session": {"script": {"path": authorization["container_script_path"]}}}
            legacy_session_id = "docker-startup-" + hashlib.sha256(
                (request_id + "\0" + source_sha256).encode()
            ).hexdigest()
            with self.assertRaisesRegex(RuntimeError, "no unique exact rejected activation receipt"):
                namespace["rejected_startup_marker"](status, (legacy_session_id, 1, 1))

            for max_bytes in (67108864, 134217728, 536870912):
                trace["max_bytes"] = max_bytes
                expected_trace_sha256 = canonical_sha256(trace)
                session_material = (
                    request_id + "\0" + source_sha256 + "\0" + profile_sha256
                    + "\0cuda_trace\0" + expected_trace_sha256
                )
                session_id = "docker-startup-" + hashlib.sha256(session_material.encode()).hexdigest()
                marker_path.write_text(json.dumps(marker), encoding="utf-8")
                accepted = namespace["rejected_startup_marker"](status, (session_id, 1, 1))
                self.assertEqual(accepted["solver_profile_sha256"], profile_sha256)
                self.assertEqual(accepted["cuda_trace_sha256"], expected_trace_sha256)

            for code in ("accepted_script_capture_invalid", "accepted_script_capture_required", "accepted_script_compilation_failed"):
                marker["result"]["rejection"]["code"] = code
                marker_path.write_text(json.dumps(marker), encoding="utf-8")
                accepted = namespace["rejected_startup_marker"](status, (session_id, 1, 1))
                self.assertEqual(accepted["rejection"]["code"], code)
            for code in ("accepted_run_commit_failed", "accepted_unknown_outcome"):
                marker["result"]["rejection"]["code"] = code
                marker_path.write_text(json.dumps(marker), encoding="utf-8")
                with self.assertRaisesRegex(RuntimeError, "not a known pre-acceptance outcome"):
                    namespace["rejected_startup_marker"](status, (session_id, 1, 1))
            marker["result"]["rejection"]["code"] = "accepted_cuda_trace_unsupported"

            trace["max_bytes"] = 536870911
            marker_path.write_text(json.dumps(marker), encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "cuda trace"):
                namespace["rejected_startup_marker"](status, (session_id, 1, 1))

    @staticmethod
    def _development_context():
        identity = {
            "project_name": "fullmag-worktree-test",
            "project_id": "fullmag",
            "worktree_id": "worktree-test",
            "checkout_kind": "worktree",
        }
        control = docker_volume_dev.BuildControl.__new__(docker_volume_dev.BuildControl)
        control.identity = dict(identity)
        control.project = identity["project_name"]
        operation = {
            "root": "development/attempts/" + "a" * 32,
            "lease_ready": True,
            "receipt": {
                "phase": "development",
                "attempt": "a" * 32,
                "compose_project": identity["project_name"],
                "inputs": {
                    "source_root": "/checkout",
                    "source_project_id": identity["project_id"],
                    "source_worktree_id": identity["worktree_id"],
                    "source_checkout_kind": identity["checkout_kind"],
                },
            },
        }
        return identity, control, operation

    def test_recovery_reuses_only_matching_development_operation(self):
        identity, control, operation = self._development_context()
        receipt = docker_volume_dev._validate_existing_development_operation(
            control, operation, Path("/checkout"), identity
        )
        self.assertEqual(receipt["phase"], "development")
        self.assertEqual(
            docker_volume_dev._validate_prepared_start_context(
                {
                    "toolchain": {
                        "image_id": "sha256:" + "b" * 64,
                        "inputs": {"build_args": {}},
                    },
                    "images": {"backend": {"image_id": "sha256:" + "c" * 64}},
                }
            )[0]["image_id"],
            "sha256:" + "b" * 64,
        )
        operation["receipt"]["phase"] = "resume"
        with self.assertRaisesRegex(docker_volume_dev.BuildControlError, "development phase"):
            docker_volume_dev._validate_existing_development_operation(
                control, operation, Path("/checkout"), identity
            )

    def test_recovery_context_rejects_identity_and_environment_override(self):
        identity, control, operation = self._development_context()
        operation["receipt"]["inputs"]["source_root"] = "/other-checkout"
        with self.assertRaisesRegex(docker_volume_dev.BuildControlError, "source differs"):
            docker_volume_dev._validate_existing_development_operation(
                control, operation, Path("/checkout"), identity
            )
        self.assertEqual(
            docker_volume_dev._validate_recovery_environment(
                {"FULLMAG_CONTAINER_RECOVERY_REQUEST": "request-1"}
            ),
            {"FULLMAG_CONTAINER_RECOVERY_REQUEST": "request-1"},
        )
        for name in ("FULLMAG_SOURCE_ROOT", "PATH"):
            with self.assertRaisesRegex(docker_volume_dev.BuildControlError, "unsupported"):
                docker_volume_dev._validate_recovery_environment({name: "value"})

    def test_precreate_uses_real_write_probe_and_exact_directories(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state"
            state.mkdir()

            with patch.object(docker_volume_dev.sys, "platform", "win32"):
                prepared = docker_volume_dev._precreate_new_windows_runtime_state(state)

            expected = tuple(
                relative.as_posix()
                for relative in docker_volume_dev._NEW_WINDOWS_RUNTIME_STATE_DIRECTORIES
            )
            self.assertEqual(prepared, expected)
            for relative in expected:
                self.assertTrue((state / relative).is_dir())
            self.assertEqual(
                list((state / expected[-1]).iterdir()),
                [],
                "the write probe must not leave technical files in Windows runtime state",
            )

    def test_precreate_rejects_existing_runtime_data_without_adopting_it(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state"
            existing = state / "runs/docker-all/session-store"
            existing.mkdir(parents=True)
            marker = existing / "existing.json"
            marker.write_text("keep", encoding="utf-8")

            with patch.object(docker_volume_dev.sys, "platform", "win32"), self.assertRaises(
                docker_volume_dev.BuildControlError
            ):
                docker_volume_dev._precreate_new_windows_runtime_state(state)

            self.assertEqual(marker.read_text(encoding="utf-8"), "keep")
            self.assertTrue(existing.is_dir())

    def test_precreate_rejects_reparse_entry_before_creating_children(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state"
            state.mkdir()
            redirected = root / "outside"
            redirected.mkdir()
            try:
                (state / "runs").symlink_to(redirected, target_is_directory=True)
            except (OSError, NotImplementedError) as error:
                self.skipTest(f"symlink test requires native reparse support: {error}")

            with patch.object(docker_volume_dev.sys, "platform", "win32"), self.assertRaises(
                docker_volume_dev.BuildControlError
            ):
                docker_volume_dev._precreate_new_windows_runtime_state(state)

            self.assertEqual(list(redirected.iterdir()), [])
            self.assertFalse((redirected / "docker-all").exists())

    def test_start_wires_preparation_before_mount_and_compose(self):
        source = inspect.getsource(docker_volume_dev.start)
        self.assertLess(
            source.index("_precreate_new_windows_runtime_state(state)"),
            source.index("local_volume(state)"),
        )
        self.assertLess(
            source.index("_precreate_new_windows_runtime_state(state)"),
            source.index("_start_compose_services("),
        )


if __name__ == "__main__":
    unittest.main()
