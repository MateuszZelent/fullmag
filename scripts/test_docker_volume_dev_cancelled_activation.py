from __future__ import annotations

import ast
import hashlib
import importlib
import json
from pathlib import Path
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
import sys
sys.path[:0] = [str(ROOT / "scripts")]
module = importlib.import_module("docker_volume_dev")


def _raw(value: object) -> bytes:
    return module.canonical(value) + b"\n"


def _fixture():
    attempt = "a" * 32
    development_attempt = "b" * 32
    backend = "3" * 64
    image = "sha256:" + "4" * 64
    probe = {
        "schema": "fullmag.docker-activation-cancel-probe.v1",
        "run_id": "run-live-1",
        "task_id": "task-1",
        "request_id": "docker-volume-request-1",
        "source_sha256": "2" * 64,
        "catalog_revision": 3,
        "cancellation_id": "cancel-1",
        "run_intent_sha256": "8" * 64,
        "run_catalog_sha256": "9" * 64,
        "cancellation_intent_sha256": "a" * 64,
        "activation_marker_sha256": "7" * 64,
        "host_ledger_sha256": "b" * 64,
        "matching_reservations": 0,
        "task_count": 1,
        "store_file_count": 8,
        "live_api_instance_id": "api-instance-1",
        "live_session_id": "session-1",
        "live_session_epoch": 1,
        "live_scene_revision": 7,
        "live_workspace_sha256": "d" * 64,
        "current_session_sha256": "e" * 64,
        "scene": {"revision": 7},
        "compute_queue": {"schema_version": "compute_queue.v1", "items": []},
        "runtime_service": {
            "configured": True,
            "state": "ready",
            "reason": {"code": "service_ready"},
        },
        "health": {"status": "ok", "active_session": True},
    }
    proof = {
        "schema": module._CANCELLED_ACTIVATION_SCHEMA,
        "state": "accepted-then-cancelled",
        "activation_attempt": attempt,
        "development_attempt": development_attempt,
        "compose_project": "fullmag-worktree-demo",
        "source_root": "/mnt/c/git/fullmag/fullmag",
        "config_sha256": "1" * 64,
        "image_id": image,
        "backend_container": backend,
        "request_id": probe["request_id"],
        "source_sha256": probe["source_sha256"],
        "run_id": probe["run_id"],
        "task_id": probe["task_id"],
        "cancellation_id": probe["cancellation_id"],
        "catalog_revision": probe["catalog_revision"],
        "live_api_instance_id": probe["live_api_instance_id"],
        "live_session_id": probe["live_session_id"],
        "live_session_epoch": probe["live_session_epoch"],
        "live_scene_revision": probe["live_scene_revision"],
        "live_workspace_sha256": probe["live_workspace_sha256"],
        "current_session_sha256": probe["current_session_sha256"],
        "helper_container": "fullmag-control-" + attempt,
        "helper_container_id": "5" * 64,
        "unknown_receipt_sha256": "6" * 64,
        "activation_marker_sha256": probe["activation_marker_sha256"],
        "run_intent_sha256": probe["run_intent_sha256"],
        "run_catalog_sha256": probe["run_catalog_sha256"],
        "cancellation_intent_sha256": probe["cancellation_intent_sha256"],
        "host_ledger_sha256": probe["host_ledger_sha256"],
    }
    proof["probe_sha256"] = "c" * 64
    request_key = hashlib.sha256(proof["request_id"].encode()).hexdigest()
    inputs = {
        "development_attempt": development_attempt,
        "config_sha256": proof["config_sha256"],
        "source_root": proof["source_root"],
        "image_id": image,
        "backend_container": backend,
        "request_id": proof["request_id"],
        "source_sha256": proof["source_sha256"],
        "activation_receipt_path": (
            "/opt/fullmag/control/backend/script-activation-" + request_key + "/activation.json"
        ),
        "activation_receipt_key": request_key,
    }
    current = {
        "schema": "fullmag.docker-build-operation.v1",
        "phase": "activation",
        "compose_project": proof["compose_project"],
        "control_volume": "fullmag-worktree-demo-control",
        "attempt": attempt,
        "state": "failed-confirmed",
        "activation_state": "accepted-then-cancelled",
        "cancellation_proof_sha256": hashlib.sha256(_raw(proof)).hexdigest(),
        "run_id": proof["run_id"],
        "task_id": proof["task_id"],
        "cancellation_id": proof["cancellation_id"],
        "inputs": inputs,
    }
    return proof, probe, current, attempt, development_attempt, backend, image


class CancelledActivationPreflightTests(unittest.TestCase):
    def test_startup_activation_uses_effective_container_environment(self):
        self.assertFalse(module._retained_startup_enabled({"Config": {"Env": []}}))
        self.assertFalse(module._retained_startup_enabled({"Config": {"Env": ["FULLMAG_STARTUP_ENABLED=0"]}}))
        self.assertTrue(module._retained_startup_enabled({"Config": {"Env": ["FULLMAG_STARTUP_ENABLED=1"]}}))
        with self.assertRaises(module.BuildControlError):
            module._retained_startup_enabled({"Config": {"Env": ["FULLMAG_STARTUP_ENABLED=unknown"]}})

    def test_matching_proof_rechecks_store_and_runtime_before_mutation(self):
        proof, probe, current, attempt, development_attempt, backend, image = _fixture()
        current_raw = _raw(current)
        proof_raw = _raw(proof)
        records = {
            "activation/current.json": (current, current_raw),
            f"activation/attempts/{attempt}/terminal.json": (current, current_raw),
            f"activation/attempts/{attempt}/accepted-then-cancelled.json": (proof, proof_raw),
        }

        class Control:
            project = proof["compose_project"]
            volume = current["control_volume"]

        with patch.object(module, "_read_cancelled_activation_record", side_effect=lambda _control, relative, **_options: records[relative]), \
                patch.object(module, "_read_cancelled_activation_bytes", return_value=None), \
                patch.object(module, "_cancelled_activation_store_probe", return_value=probe) as store_probe:
            result = module._validate_cancelled_activation_preflight(
                Control(),
                "development/attempts/" + development_attempt,
                {"inputs": {"image_id": image}},
                {},
                Path(proof["source_root"]),
                proof["config_sha256"],
                backend,
                {},
            )
        self.assertEqual(result["proof_sha256"], hashlib.sha256(proof_raw).hexdigest())
        store_probe.assert_called_once()
        self.assertEqual(store_probe.call_args.kwargs["expected_scene_revision"], proof["live_scene_revision"])

    def test_global_observation_digests_can_change_but_catalog_digest_cannot(self):
        proof, probe, current, attempt, development_attempt, backend, image = _fixture()
        current_raw = _raw(current)
        proof_raw = _raw(proof)
        records = {
            "activation/current.json": (current, current_raw),
            f"activation/attempts/{attempt}/terminal.json": (current, current_raw),
            f"activation/attempts/{attempt}/accepted-then-cancelled.json": (proof, proof_raw),
        }

        class Control:
            project = proof["compose_project"]
            volume = current["control_volume"]

        probe["host_ledger_sha256"] = "f" * 64
        probe["current_session_sha256"] = "0" * 64
        with patch.object(module, "_read_cancelled_activation_record", side_effect=lambda _control, relative, **_options: records[relative]), \
                patch.object(module, "_read_cancelled_activation_bytes", return_value=None), \
                patch.object(module, "_cancelled_activation_store_probe", return_value=probe):
            result = module._validate_cancelled_activation_preflight(
                Control(), "development/attempts/" + development_attempt,
                {"inputs": {"image_id": image}}, {}, Path(proof["source_root"]),
                proof["config_sha256"], backend, {},
            )
        self.assertEqual(result["proof_sha256"], hashlib.sha256(proof_raw).hexdigest())

        probe["run_catalog_sha256"] = "f" * 64
        with patch.object(module, "_read_cancelled_activation_record", side_effect=lambda _control, relative, **_options: records[relative]), \
                patch.object(module, "_read_cancelled_activation_bytes", return_value=None), \
                patch.object(module, "_cancelled_activation_store_probe", return_value=probe):
            with self.assertRaises(module.BuildControlError):
                module._validate_cancelled_activation_preflight(
                    Control(), "development/attempts/" + development_attempt,
                    {"inputs": {"image_id": image}}, {}, Path(proof["source_root"]),
                    proof["config_sha256"], backend, {},
                )

    def test_changed_probe_or_missing_proof_fails_closed(self):
        proof, probe, current, attempt, development_attempt, backend, image = _fixture()
        records = {
            "activation/current.json": (current, _raw(current)),
            f"activation/attempts/{attempt}/terminal.json": (current, _raw(current)),
            f"activation/attempts/{attempt}/accepted-then-cancelled.json": (proof, _raw(proof)),
        }
        probe["run_catalog_sha256"] = "f" * 64

        class Control:
            project = proof["compose_project"]
            volume = current["control_volume"]

        with patch.object(module, "_read_cancelled_activation_record", side_effect=lambda _control, relative, **_options: records[relative]), \
                patch.object(module, "_read_cancelled_activation_bytes", return_value=None), \
                patch.object(module, "_cancelled_activation_store_probe", return_value=probe):
            with self.assertRaises(module.BuildControlError):
                module._validate_cancelled_activation_preflight(
                    Control(), "development/attempts/" + development_attempt,
                    {"inputs": {"image_id": image}}, {}, Path(proof["source_root"]),
                    proof["config_sha256"], backend, {},
                )

        current["activation_state"] = "accepted"
        records = {"activation/current.json": (current, _raw(current))}
        with patch.object(module, "_read_cancelled_activation_record", side_effect=lambda _control, relative, **_options: records[relative]):
            with self.assertRaises(module.BuildControlError):
                module._validate_cancelled_activation_preflight(
                    Control(), "development/attempts/" + development_attempt,
                    {"inputs": {"image_id": image}}, {}, Path(proof["source_root"]),
                    proof["config_sha256"], backend, {},
                )

    def test_live_session_without_cancelled_activation_names_the_refusal(self):
        # A session created by `fm.connect()` has no activation record at all.
        with patch.object(
            module,
            "_read_cancelled_activation_record",
            side_effect=lambda _control, _relative, **options: (
                (None, None) if options.get("optional") else self.fail("missing record must be optional")
            ),
        ):
            with self.assertRaisesRegex(module.BuildControlError, "active session"):
                module._validate_cancelled_activation_preflight(
                    object(), "development/attempts/a", {}, {}, Path("."), "0" * 64, "backend", {},
                )

    def test_probe_source_uses_nonblocking_writer_locks_and_no_mutation(self):
        source = (ROOT / "scripts" / "docker_volume_dev.py").read_text()
        tree = ast.parse(source)
        function = next(
            node for node in tree.body
            if isinstance(node, ast.FunctionDef) and node.name == "_cancelled_activation_probe_script"
        )
        function_source = ast.get_source_segment(source, function)
        self.assertIsNotNone(function_source)
        self.assertIn("fcntl.LOCK_EX|fcntl.LOCK_NB", function_source)
        self.assertIn("matching", function_source)
        self.assertNotIn("safe_tree", function_source)
        self.assertNotIn("os.unlink", function_source)
        self.assertNotIn("os.remove", function_source)
        self.assertNotIn("requests.post", function_source)

        probe_tree = ast.parse(module._cancelled_activation_probe_script())
        runtime_lines = [
            node.lineno for node in ast.walk(probe_tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "api_get"
            and node.args
            and isinstance(node.args[0], ast.Constant)
            and node.args[0].value == "/v2/platform/runtime-service"
        ]
        self.assertEqual(len(runtime_lines), 1)
        unlock_lines = [
            node.lineno for node in ast.walk(probe_tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "fcntl"
            and node.func.attr == "flock"
            and len(node.args) >= 2
            and isinstance(node.args[1], ast.Attribute)
            and isinstance(node.args[1].value, ast.Name)
            and node.args[1].value.id == "fcntl"
            and node.args[1].attr == "LOCK_UN"
        ]
        self.assertGreaterEqual(len(unlock_lines), 2)
        unlock_before_runtime = {
            node.args[0].id for node in ast.walk(probe_tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "fcntl"
            and node.func.attr == "flock"
            and len(node.args) >= 2
            and isinstance(node.args[0], ast.Name)
            and isinstance(node.args[1], ast.Attribute)
            and isinstance(node.args[1].value, ast.Name)
            and node.args[1].value.id == "fcntl"
            and node.args[1].attr == "LOCK_UN"
            and node.lineno < runtime_lines[0]
        }
        self.assertTrue({"store_fd", "ledger_fd"} <= unlock_before_runtime)
        self.assertLess(max(line for line in unlock_lines if line < runtime_lines[0]), runtime_lines[0])



if __name__ == "__main__":
    unittest.main()
