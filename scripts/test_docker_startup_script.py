"""Interpreted regressions for the Docker startup-script admission boundary."""
from __future__ import annotations

import hashlib
from contextlib import nullcontext
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import docker_startup_script as startup
import fullmag_docker_runtime as docker_runtime


class DockerStartupScriptTests(unittest.TestCase):
    def write_script(self, root: Path, relative: str = "models/scene.py") -> Path:
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("import fullmag as fm\nfm.interactive(True)\n", encoding="utf-8")
        return path

    def test_prepare_pins_relative_path_and_hash(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            script = self.write_script(root)
            authorization = startup.prepare(
                root,
                Path("models") / "scene.py",
                request_id="startup-test-1",
                source_commit="a" * 40,
            )
            self.assertEqual(authorization.source_relative, "models/scene.py")
            self.assertEqual(authorization.container_script_path, "/opt/fullmag/source/models/scene.py")
            self.assertEqual(
                authorization.source_sha256,
                hashlib.sha256(script.read_bytes()).hexdigest(),
            )
            request = startup.build_activation_request(authorization.as_dict())
            self.assertEqual(request["schema"], startup.REQUEST_SCHEMA)
            self.assertEqual(request["source"]["sha256"], authorization.source_sha256)
            self.assertTrue(request["execution"]["auto_study"])
            self.assertEqual(request["execution"]["wait_for_solve"], "script_metadata")
            self.assertFalse(request["execution"]["legacy_cli"])
            self.assertTrue(startup.STARTUP_ENDPOINT.startswith("/v1/internal/live/current/"))
            self.assertEqual(startup.MAX_SCRIPT_BYTES, 1024 * 1024)

    def test_managed_receipt_path_is_deterministic_and_bounded(self) -> None:
        key = "a" * 64
        expected = Path("/opt/fullmag/control/backend/script-activation-" + key + "/activation.json")
        self.assertEqual(startup.activation_receipt_path_for_key(key), expected)
        for invalid in ("", "A" * 64, "../" + "a" * 61, "a" * 63):
            with self.subTest(invalid=invalid), self.assertRaises(startup.StartupScriptError):
                startup.activation_receipt_path_for_key(invalid)

    def test_health_gate_accepts_only_a_definitive_empty_workspace(self) -> None:
        class Response:
            status = 200

            def __init__(self, payload):
                self.payload = payload

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def read(self, _maximum):
                return json.dumps(self.payload).encode("utf-8")

        for payload, accepted in (
            ({"status": "ok", "active_session": False}, True),
            ({"status": "ok", "active_session": True}, False),
            ({"status": "ok", "active_session": None}, False),
            ({"status": "degraded", "active_session": False}, False),
        ):
            opener = mock.Mock()
            opener.open.return_value = Response(payload)
            with self.subTest(payload=payload), mock.patch.object(
                startup.urllib.request, "build_opener", return_value=opener
            ):
                if accepted:
                    self.assertEqual(
                        startup._assert_no_active_session("http://127.0.0.1:8081"),
                        payload,
                    )
                else:
                    with self.assertRaises(startup.StartupScriptError):
                        startup._assert_no_active_session("http://127.0.0.1:8081")
            request = opener.open.call_args.args[0]
            self.assertEqual(request.full_url, "http://127.0.0.1:8081/v2/platform/health")
            self.assertEqual(request.get_method(), "GET")

    def test_prepare_rejects_symlink_and_escape(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            self.write_script(root)
            outside = root.parent / (root.name + "-outside.py")
            outside.write_text("print('outside')\n", encoding="utf-8")
            link = root / "link.py"
            try:
                link.symlink_to(outside)
            except (OSError, NotImplementedError) as error:
                self.skipTest(f"symlinks unavailable: {error}")
            with self.assertRaises(startup.StartupScriptError):
                startup.prepare(root, link, request_id="startup-test-2")
            with self.assertRaises(startup.StartupScriptError):
                startup.prepare(root, "../" + outside.name, request_id="startup-test-3")

    def test_provenance_is_exclusive_and_digest_is_attested(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            script = self.write_script(root)
            authorization = startup.prepare(root, script, request_id="startup-test-provenance")
            target = root / "startup-provenance.json"
            observed = startup.write_provenance(target, authorization)
            self.assertEqual(observed, hashlib.sha256(target.read_bytes()).hexdigest())
            with self.assertRaisesRegex(startup.StartupScriptError, "already exists"):
                startup.write_provenance(target, authorization)

    def test_activation_response_requires_pinned_request_and_hash(self) -> None:
        authorization = {
            "schema": startup.AUTHORIZATION_SCHEMA,
            "authorization": startup.AUTHORIZATION_KIND,
            "request_id": "startup-test-4",
            "source_sha256": "b" * 64,
            "source_size_bytes": 2,
        }
        response = {
            "schema": startup.RESPONSE_SCHEMA,
            "authorization": startup.AUTHORIZATION_KIND,
            "request_id": "startup-test-4",
            "source_sha256": "b" * 64,
            "status": "waiting_for_solve",
            "session_id": "session-startup-test-4",
            "run_id": "run-startup-test-4",
            "step_ids": ["step-startup-test-4"],
            "scene_revision": 0,
            "runtime_metadata": {"interactive": True, "wait_for_solve": True},
            "execution": {
                "mode": "canonical_live_v2",
                "auto_study": True,
                "interactive": "script_metadata",
                "wait_for_solve": "script_metadata",
                "legacy_cli": False,
            },
        }
        self.assertEqual(startup.validate_activation_response(response, authorization), response)
        for field, value in (("request_id", "other"), ("source_sha256", "c" * 64)):
            tampered = dict(response)
            tampered[field] = value
            with self.assertRaises(startup.StartupScriptError):
                startup.validate_activation_response(tampered, authorization)

    def test_activation_uses_bounded_mesh_compatible_default_timeout(self) -> None:
        authorization = {
            "schema": startup.AUTHORIZATION_SCHEMA,
            "authorization": startup.AUTHORIZATION_KIND,
            "request_id": "startup-test-timeout",
            "source_sha256": "b" * 64,
            "source_relative": "models/scene.py",
            "container_script_path": "/opt/fullmag/source/models/scene.py",
            "container_source_root": "/opt/fullmag/source",
        }
        response = {
            "schema": startup.RESPONSE_SCHEMA,
            "authorization": startup.AUTHORIZATION_KIND,
            "request_id": authorization["request_id"],
            "source_sha256": authorization["source_sha256"],
            "status": "waiting_for_solve",
            "session_id": "session-startup-timeout",
            "run_id": "run-startup-timeout",
            "step_ids": ["step-startup-timeout"],
            "scene_revision": 1,
            "runtime_metadata": {"interactive": True, "wait_for_solve": True},
            "execution": {
                "mode": "canonical_live_v2",
                "auto_study": True,
                "interactive": "script_metadata",
                "wait_for_solve": "script_metadata",
                "legacy_cli": False,
            },
        }

        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def read(self, _maximum):
                return json.dumps(response).encode("utf-8")

        observed = {}

        class Opener:
            def open(self, _request, *, timeout):
                observed["timeout"] = timeout
                return Response()

        with mock.patch.object(startup.urllib.request, "build_opener", return_value=Opener()):
            result = startup.activate(authorization)
        self.assertEqual(result, response)
        self.assertEqual(observed["timeout"], startup.STARTUP_ACTIVATION_TIMEOUT_SECONDS)
        self.assertEqual(startup.STARTUP_ACTIVATION_TIMEOUT_SECONDS, 2100.0)

    def test_activation_rejects_unbounded_timeout(self) -> None:
        authorization = {
            "schema": startup.AUTHORIZATION_SCHEMA,
            "authorization": startup.AUTHORIZATION_KIND,
            "request_id": "startup-test-timeout-bound",
            "source_sha256": "b" * 64,
            "source_relative": "models/scene.py",
            "container_script_path": "/opt/fullmag/source/models/scene.py",
            "container_source_root": "/opt/fullmag/source",
        }
        with self.assertRaisesRegex(startup.StartupScriptError, "between 0 and 2100"):
            startup.activate(authorization, timeout=2101)

    def test_activation_response_rejects_legacy_cli_claim(self) -> None:
        authorization = {
            "schema": startup.AUTHORIZATION_SCHEMA,
            "authorization": startup.AUTHORIZATION_KIND,
            "request_id": "startup-test-5",
            "source_sha256": "d" * 64,
        }
        response = {
            "schema": startup.RESPONSE_SCHEMA,
            "authorization": startup.AUTHORIZATION_KIND,
            "request_id": "startup-test-5",
            "source_sha256": "d" * 64,
            "status": "accepted",
            "session_id": "session-startup-test-5",
            "run_id": "run-startup-test-5",
            "step_ids": ["step-startup-test-5"],
            "scene_revision": 2,
            "runtime_metadata": {"interactive": False, "wait_for_solve": False},
            "execution": {
                "mode": "canonical_live_v2",
                "auto_study": True,
                "interactive": "script_metadata",
                "wait_for_solve": "script_metadata",
                "legacy_cli": True,
            },
        }
        with self.assertRaises(startup.StartupScriptError):
            startup.validate_activation_response(response, authorization)

    def test_activation_response_requires_the_complete_live_execution_contract(self) -> None:
        authorization = {
            "schema": startup.AUTHORIZATION_SCHEMA,
            "authorization": startup.AUTHORIZATION_KIND,
            "request_id": "startup-test-6",
            "source_sha256": "e" * 64,
        }
        response = {
            "schema": startup.RESPONSE_SCHEMA,
            "authorization": startup.AUTHORIZATION_KIND,
            "request_id": "startup-test-6",
            "source_sha256": "e" * 64,
            "status": "accepted",
            "session_id": "session-startup-test-6",
            "run_id": "run-startup-test-6",
            "step_ids": ["step-startup-test-6"],
            "scene_revision": 3,
            "runtime_metadata": {"interactive": False, "wait_for_solve": False},
            "execution": {
                "mode": "canonical_live_v2",
                "auto_study": True,
                "interactive": "script_metadata",
                "wait_for_solve": "script_metadata",
                "legacy_cli": False,
            },
        }
        for field in ("mode", "auto_study", "interactive", "wait_for_solve", "legacy_cli"):
            tampered = json.loads(json.dumps(response))
            tampered["execution"].pop(field)
            with self.subTest(field=field), self.assertRaises(startup.StartupScriptError):
                startup.validate_activation_response(tampered, authorization)

    def test_activation_response_requires_server_execution_identity_and_wait_state(self) -> None:
        authorization = {
            "schema": startup.AUTHORIZATION_SCHEMA,
            "authorization": startup.AUTHORIZATION_KIND,
            "request_id": "startup-test-dto",
            "source_sha256": "f" * 64,
        }
        response = {
            "schema": startup.RESPONSE_SCHEMA,
            "authorization": startup.AUTHORIZATION_KIND,
            "request_id": authorization["request_id"],
            "source_sha256": authorization["source_sha256"],
            "status": "accepted",
            "session_id": "session-startup-dto",
            "run_id": "run-startup-dto",
            "step_ids": ["step-startup-dto"],
            "scene_revision": 4,
            "runtime_metadata": {"interactive": True, "wait_for_solve": False},
            "execution": {
                "mode": "canonical_live_v2",
                "auto_study": True,
                "interactive": "script_metadata",
                "wait_for_solve": "script_metadata",
                "legacy_cli": False,
            },
        }
        self.assertEqual(startup.validate_activation_response(response, authorization), response)
        for field, value in (
            ("session_id", ""),
            ("run_id", None),
            ("step_ids", []),
            ("step_ids", ["duplicate", "duplicate"]),
            ("scene_revision", True),
            ("scene_revision", 2**64),
            ("runtime_metadata", {"interactive": 1, "wait_for_solve": False}),
            ("runtime_metadata", {"interactive": False, "wait_for_solve": True}),
            ("status", "waiting_for_solve"),
        ):
            tampered = json.loads(json.dumps(response))
            tampered[field] = value
            with self.subTest(field=field, value=value), self.assertRaises(startup.StartupScriptError):
                startup.validate_activation_response(tampered, authorization)

    def test_overlay_is_readonly_and_mounts_selected_checkout_only_when_enabled(self) -> None:
        authorization = {
            "source_root": "/host/checkout",
            "container_script_path": "/opt/fullmag/source/examples/start.py",
        }
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            overlay = root / "compose.startup.json"
            provenance = root / "run" / "startup-provenance.json"
            provenance.parent.mkdir()
            provenance.write_text("{}\n", encoding="utf-8")
            docker_runtime._write_startup_overlay(
                overlay, authorization, include_source=True,
                provenance_path=provenance,
                provenance_sha256="a" * 64, helper_sha256="b" * 64,
            )
            document = json.loads(overlay.read_text(encoding="utf-8"))
            service = document["services"]["backend"]
            self.assertEqual(service["environment"]["FULLMAG_STARTUP_ENABLED"], "1")
            self.assertEqual(
                service["environment"]["FULLMAG_STARTUP_SCRIPT"],
                authorization["container_script_path"],
            )
            self.assertEqual(service["environment"]["FULLMAG_STARTUP_PROVENANCE_SHA256"], "a" * 64)
            self.assertEqual(service["environment"]["FULLMAG_STARTUP_HELPER_SHA256"], "b" * 64)
            self.assertEqual(
                {mount["target"] for mount in service["volumes"]},
                {"/opt/fullmag/source", "/run/fullmag/startup-provenance.json"},
            )
            self.assertTrue(all(mount["read_only"] for mount in service["volumes"]))
            self.assertEqual(
                next(mount["source"] for mount in service["volumes"]
                     if mount["target"] == "/run/fullmag/startup-provenance.json"),
                str(provenance.resolve()),
            )
            docker_runtime._write_startup_overlay(
                overlay, authorization, include_source=False, provenance_path=provenance
            )
            document = json.loads(overlay.read_text(encoding="utf-8"))
            self.assertEqual(
                [mount["target"] for mount in document["services"]["backend"]["volumes"]],
                ["/run/fullmag/startup-provenance.json"],
            )

    def test_entrypoint_does_not_reintroduce_scratch_cli(self) -> None:
        entrypoint = Path(__file__).parents[1] / "docker/all-in-one/entrypoint.py"
        text = entrypoint.read_text(encoding="utf-8")
        self.assertIn("docker_startup_script.run_from_environment()", text)
        self.assertIn("/opt/fullmag/docker_startup_script.py", text)
        self.assertNotIn("/opt/fullmag/source/scripts", text)
        self.assertLess(text.index("startup_result = activate_startup_script()"),
                        text.index('receipt.update(state="ready"'))
        self.assertNotIn("fullmag-bin", text)

    def test_entrypoint_rejects_partial_startup_environment(self) -> None:
        entrypoint = Path(__file__).parents[1] / "docker/all-in-one/entrypoint.py"
        spec = importlib.util.spec_from_file_location("fullmag_all_in_one_entrypoint", entrypoint)
        self.assertIsNotNone(spec)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        with mock.patch.dict(
            os.environ,
            {"FULLMAG_STARTUP_API": "http://127.0.0.1:8081"},
            clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "environment is incomplete"):
                module.activate_startup_script()


class StartupRejectionTests(unittest.TestCase):
    def setUp(self):
        self.receipt_directory = tempfile.TemporaryDirectory()
        self.receipt_path = Path(self.receipt_directory.name) / "activation.json"
        self.receipt_patch = mock.patch.object(startup, "ACTIVATION_RECEIPT_PATH", self.receipt_path)
        self.receipt_patch.start()
        self.health_patch = mock.patch.object(startup, "_assert_no_active_session")
        self.health_check = self.health_patch.start()
        self.health_check.return_value = {"status": "ok", "active_session": False}

    def tearDown(self):
        self.health_patch.stop()
        self.receipt_patch.stop()
        self.receipt_directory.cleanup()

    def authorization(self):
        return {
            "schema": startup.AUTHORIZATION_SCHEMA,
            "authorization": startup.AUTHORIZATION_KIND,
            "request_id": "startup-rejection-test",
            "source_sha256": hashlib.sha256(b"script").hexdigest(),
            "source_relative": "models/scene.py",
            "source_size_bytes": len(b"script"),
            "container_script_path": "/opt/fullmag/source/models/scene.py",
            "container_source_root": "/opt/fullmag/source",
        }

    def run_environment(self):
        authorization = self.authorization()
        return mock.patch.dict(os.environ, {
            "FULLMAG_STARTUP_ENABLED": "1",
            "FULLMAG_STARTUP_SCRIPT": authorization["container_script_path"],
            "FULLMAG_STARTUP_PROVENANCE": "/run/fullmag/startup-provenance.json",
            startup.PROVENANCE_SHA256_ENV: "a" * 64,
        }, clear=True)

    def bounded_regular(self, path, _maximum, label):
        if label == "startup activation receipt":
            return self.receipt_path.read_bytes()
        return b"script"

    def test_only_structured_validation_http_errors_are_known_rejections(self):
        import io
        import urllib.error
        for status, payload, known in [
            (400, {"code": "bad_request", "message": "unsupported model"}, True),
            (422, {"code": "validation_error", "message": "invalid model"}, True),
            (422, {"code": "accepted_execution_plan_invalid", "message": "canonical accepted study lowering failed: shared-domain mesh missing"}, True),
            (422, {"code": "accepted_gpu_scope_unsupported", "message": "unsupported GPU study"}, True),
            (422, {"code": "accepted_script_capture_invalid", "message": "source closure invalid"}, True),
            (422, {"code": "accepted_script_capture_required", "message": "source capture required"}, True),
            (422, {"code": "accepted_script_compilation_failed", "message": "closed-loop compilation failed"}, True),
            (409, {"code": "accepted_script_source_changed", "message": "entry source changed"}, False),
            (409, {"code": "accepted_script_scene_changed", "message": "captured scene changed"}, False),
            (422, {"code": "accepted_run_commit_failed", "message": "durable store failed"}, False),
            (422, {"code": "accepted_run_catalog_failed", "message": "catalog publication failed"}, False),
            (422, {"code": "accepted_unknown_future_code", "message": "unknown boundary"}, False),
            (409, {"code": "accepted_execution_plan_invalid", "message": "release conflict after admission"}, False),
            (400, {"code": "unsupported_capability", "message": "interactive=false with wait_for_solve=true"}, True),
            (422, {"code": "docker_startup_output_mapping_required", "message": "output alias is required"}, True),
            (422, {"code": "docker_startup_output_mapping_invalid", "message": "output alias is invalid"}, True),
            (422, {"code": "docker_startup_output_mapping_future", "message": "unknown output failure"}, False),
            (409, {"code": "docker_startup_output_mapping_required", "message": "conflict"}, False),
            (500, {"code": "docker_startup_output_mapping_invalid", "message": "server failure"}, False),
            (422, {"code": "docker_startup_execution_policy_rejected", "message": "invalid protocol envelope"}, False),
            (500, {"code": "internal_error", "message": "service failure"}, False),
            (403, {"code": "forbidden", "message": "owner mismatch"}, False),
            (400, {"code": "bad_request"}, False),
            (400, {"code": [], "message": "invalid response"}, False),
        ]:
            error = urllib.error.HTTPError("http://127.0.0.1:8081", status, "error", {},
                                           io.BytesIO(json.dumps(payload).encode()))
            opener = mock.Mock()
            opener.open.side_effect = error
            with self.subTest(status=status, payload=payload), mock.patch.object(
                startup.urllib.request, "build_opener", return_value=opener,
            ):
                with self.assertRaises(startup.StartupScriptError) as caught:
                    startup.activate(self.authorization())
                self.assertEqual(isinstance(caught.exception, startup.StartupScriptRejected), known)

    def test_http_error_body_read_keeps_client_failures_fatal(self):
        import urllib.error

        class BrokenBody:
            def read(self, _maximum):
                raise OSError("response pipe closed")

            def close(self):
                pass

        for status, transport_unknown in ((401, False), (403, False), (409, True)):
            error = urllib.error.HTTPError(
                "http://127.0.0.1:8081", status, "error", {}, BrokenBody()
            )
            opener = mock.Mock()
            opener.open.side_effect = error
            with self.subTest(status=status), mock.patch.object(
                startup.urllib.request, "build_opener", return_value=opener,
            ):
                with self.assertRaises(startup.StartupScriptError) as caught:
                    startup.activate(self.authorization())
                self.assertEqual(
                    isinstance(caught.exception, startup._StartupActivationTransportUnknown),
                    transport_unknown,
                )

    def test_rejection_is_durable_bounded_and_fenced_without_activation(self):
        authorization = self.authorization()
        with self.run_environment(), mock.patch.object(
            startup, "_load_provenance_with_digest", return_value=(authorization, "a" * 64),
        ), mock.patch.object(startup, "_bounded_regular", side_effect=self.bounded_regular), mock.patch.object(
            startup, "activate", side_effect=startup.StartupScriptRejected(400, "bad_request", "x" * 3000),
        ):
            receipt = startup.run_from_environment()
        self.assertEqual(receipt["state"], "rejected")
        self.assertNotIn("response", receipt)
        self.assertEqual(len(receipt["rejection"]["message"]), 2048)
        self.assertEqual(startup.validate_rejection_receipt(receipt, authorization), receipt)
        with self.assertRaises(docker_runtime.StartupScriptRejected) as caught:
            docker_runtime._validate_startup_process_receipt({
                "schema": "fullmag.docker-process-tree.v1", "state": "ready",
                "startup_activation": receipt,
            }, authorization, startup)
        self.assertEqual(caught.exception.activation, receipt)
        for key in ("request_id", "source_sha256", "source_relative"):
            altered = {**receipt, key: "foreign"}
            with self.subTest(key=key), self.assertRaises(startup.StartupScriptError):
                startup.validate_rejection_receipt(altered, authorization)

    def test_output_mapping_rejection_is_durable_and_replays_without_posting(self):
        import io
        import urllib.error

        authorization = self.authorization()
        for code in ("docker_startup_output_mapping_required", "docker_startup_output_mapping_invalid"):
            with self.subTest(code=code):
                self.receipt_path.unlink(missing_ok=True)
                opener = mock.Mock()
                opener.open.side_effect = urllib.error.HTTPError(
                    "http://127.0.0.1:8081", 422, "error", {},
                    io.BytesIO(json.dumps({"code": code, "message": "output alias is unavailable"}).encode()),
                )
                with self.run_environment(), mock.patch.object(
                    startup, "_load_provenance_with_digest", return_value=(authorization, "a" * 64),
                ), mock.patch.object(startup, "_bounded_regular", side_effect=self.bounded_regular), mock.patch.object(
                    startup.urllib.request, "build_opener", return_value=opener,
                ):
                    first = startup.run_from_environment()
                    durable = self.receipt_path.read_bytes()
                    replay = startup.run_from_environment()
                self.assertEqual(first["state"], "rejected")
                self.assertEqual(first["rejection"]["code"], code)
                self.assertEqual(replay, first)
                self.assertEqual(self.receipt_path.read_bytes(), durable)
                self.assertEqual(json.loads(durable)["state"], "rejected")
                opener.open.assert_called_once()

    def test_long_rejection_preserves_traceback_start_and_final_cause(self):
        short = "unsupported mixed-P1 configuration"
        self.assertEqual(startup.StartupScriptRejected(422, "validation_error", short).message, short)

        prefix = 'Traceback (most recent call last):\n  File "/opt/fullmag/runner.py", line 42, in solve\n'
        final_cause = "RuntimeError: final native solver cause"
        rejection = startup.StartupScriptRejected(
            422,
            "validation_error",
            prefix + ("detail from an intermediate frame\n" * 200) + final_cause,
        )
        self.assertLessEqual(len(rejection.message), startup.MAX_STARTUP_REJECTION_MESSAGE_CHARS)
        self.assertTrue(rejection.message.startswith(prefix))
        self.assertIn(startup.STARTUP_REJECTION_TRUNCATION_MARKER, rejection.message)
        self.assertTrue(rejection.message.endswith(final_cause))

    def test_infrastructure_and_provenance_failures_remain_fatal(self):
        authorization = self.authorization()
        with self.run_environment(), mock.patch.object(
            startup, "_load_provenance_with_digest", return_value=(authorization, "a" * 64),
        ), mock.patch.object(startup, "_bounded_regular", side_effect=self.bounded_regular), mock.patch.object(
            startup, "activate", side_effect=startup.StartupScriptError(
                "startup activation response schema mismatch"
            ),
        ):
            with self.assertRaisesRegex(startup.StartupScriptError, "response schema mismatch"):
                startup.run_from_environment()
        self.receipt_path.unlink()
        with self.run_environment(), mock.patch.object(
            startup, "_load_provenance_with_digest", return_value=(authorization, "b" * 64),
        ), mock.patch.object(startup, "activate") as activate:
            with self.assertRaisesRegex(startup.StartupScriptError, "provenance differs"):
                startup.run_from_environment()
            activate.assert_not_called()

    def test_rejected_script_enters_healthy_supervision_before_user_shutdown(self):
        import copy
        import sys
        from types import SimpleNamespace
        entrypoint = Path(__file__).parents[1] / "docker/all-in-one/entrypoint.py"
        spec = importlib.util.spec_from_file_location("fullmag_rejection_entrypoint", entrypoint)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        authorization = self.authorization()
        receipts = []
        api = mock.Mock(pid=123)
        api.poll.return_value = None
        api.wait.return_value = 0
        with tempfile.TemporaryDirectory() as directory:
            paths = SimpleNamespace(state_root=Path(directory), store=Path(directory) / "store")
            handle = SimpleNamespace(owner={"state": "ready"})
            service = SimpleNamespace(
                prepare_storage=mock.Mock(return_value=paths),
                initialize_accepted_store=mock.Mock(return_value={"binding": "test"}),
                recover_container_namespace=mock.Mock(return_value=None),
                container_recovery_configuration_override=mock.Mock(
                    side_effect=lambda _paths, _recovery: nullcontext()
                ),
                recover_idle_failure=mock.Mock(return_value=None),
                POST_BUILD_START_ENV="FULLMAG_DOCKER_POST_BUILD_CONTINUATION",
                POST_BUILD_START_SHA_ENV="FULLMAG_DOCKER_POST_BUILD_CONTINUATION_SHA256",
                ensure_configuration=mock.Mock(return_value={}),
                process_environment=mock.Mock(return_value={}),
                terminal_observation_preflight=mock.Mock(return_value=None),
                accepted_reattach_preflight=lambda _paths: None,
                terminal_observation_api_input=mock.Mock(
                    side_effect=lambda _paths, **_kwargs: nullcontext(({}, None, None))
                ),
                process_receipt_path=mock.Mock(return_value=Path(directory) / "process-tree.json"),
                start=mock.Mock(return_value=handle),
                stop=mock.Mock(return_value={"state": "drained"}),
                _atomic_json=lambda _path, value, _label: receipts.append(copy.deepcopy(value)),
            )
            maintenance = mock.Mock()
            def start_maintenance(_service, _path, ready):
                self.assertEqual(ready["state"], "ready")
                self.assertEqual(receipts[-1]["state"], "ready")
                api.terminate.assert_not_called()
                return maintenance
            def stop_maintenance():
                api.terminate.assert_called_once()
                service.stop.assert_not_called()
                raise OSError("maintenance receipt failed")
            maintenance.stop.side_effect = stop_maintenance
            def user_shutdown(_seconds):
                api.terminate.assert_not_called()
                self.assertEqual(receipts[-1]["state"], "ready")
                self.assertEqual(receipts[-1]["startup_activation"]["state"], "rejected")
                return True
            event = mock.Mock()
            event.wait.side_effect = user_shutdown
            with self.run_environment(), mock.patch.dict(sys.modules, {
                "runtime_service": service,
                # Normal startup carries no unclaimed-cancellation request.
                "runtime_service_unclaimed_cancellation": mock.Mock(run=mock.Mock(return_value=None)),
            }), \
                    mock.patch.object(module.threading, "Event", return_value=event), \
                    mock.patch.object(module.signal, "signal"), \
                    mock.patch.object(module.subprocess, "Popen", return_value=api), \
                    mock.patch.object(module, "_start_cache_maintenance", side_effect=start_maintenance) as maintenance_start, \
                    mock.patch.object(module, "activate_startup_script", side_effect=startup.run_from_environment), \
                    mock.patch.object(startup, "_load_provenance_with_digest", return_value=(authorization, "a" * 64)), \
                    mock.patch.object(startup, "_bounded_regular", side_effect=self.bounded_regular), \
                    mock.patch.object(startup, "activate", side_effect=startup.StartupScriptRejected(400, "bad_request", "unsupported model")):
                self.assertEqual(module.serve(), 0)
            service.terminal_observation_preflight.assert_called_once_with(paths)
            service.terminal_observation_api_input.assert_called_once_with(
                paths, terminal_preflight=None, accepted_preflight=None
            )
            maintenance_start.assert_called_once()
            maintenance.stop.assert_called_once()
            service.stop.assert_called_once_with(handle, timeout=30)
            self.assertEqual(receipts[-1]["state"], "drained")


class ActivationReceiptTests(unittest.TestCase):
    def setUp(self):
        self.receipt_directory = tempfile.TemporaryDirectory()
        self.receipt_path = Path(self.receipt_directory.name) / "activation.json"
        self.receipt_patch = mock.patch.object(startup, "ACTIVATION_RECEIPT_PATH", self.receipt_path)
        self.receipt_patch.start()
        self.health_patch = mock.patch.object(startup, "_assert_no_active_session")
        self.health_check = self.health_patch.start()
        self.health_check.return_value = {"status": "ok", "active_session": False}
        self.source_bytes = b"script"
        self.authorization = {
            "schema": startup.AUTHORIZATION_SCHEMA,
            "authorization": startup.AUTHORIZATION_KIND,
            "request_id": "startup-receipt-test",
            "source_sha256": hashlib.sha256(self.source_bytes).hexdigest(),
            "source_relative": "models/scene.py",
            "source_size_bytes": len(self.source_bytes),
            "container_script_path": "/opt/fullmag/source/models/scene.py",
            "container_source_root": "/opt/fullmag/source",
        }
        self.provenance_sha256 = "a" * 64

    def tearDown(self):
        self.health_patch.stop()
        self.receipt_patch.stop()
        self.receipt_directory.cleanup()

    def environment(self):
        return mock.patch.dict(os.environ, {
            "FULLMAG_STARTUP_ENABLED": "1",
            "FULLMAG_STARTUP_SCRIPT": self.authorization["container_script_path"],
            "FULLMAG_STARTUP_PROVENANCE": "/run/fullmag/startup-provenance.json",
            startup.PROVENANCE_SHA256_ENV: self.provenance_sha256,
        }, clear=True)

    def bounded_regular(self, path, _maximum, label):
        if label == "startup activation receipt":
            return self.receipt_path.read_bytes()
        if label == "mounted startup script":
            return self.source_bytes
        raise AssertionError(f"unexpected bounded read: {label}")

    def response(self):
        return self.response_for(self.authorization)

    def response_for(self, authorization):
        return {
            "schema": startup.RESPONSE_SCHEMA,
            "authorization": startup.AUTHORIZATION_KIND,
            "request_id": authorization["request_id"],
            "source_sha256": authorization["source_sha256"],
            "status": "accepted",
            "session_id": "session-startup-receipt-test",
            "run_id": "run-startup-receipt-test",
            "step_ids": ["step-startup-receipt-test"],
            "scene_revision": 2,
            "runtime_metadata": {"interactive": True, "wait_for_solve": False},
            "execution": {
                "mode": "canonical_live_v2",
                "auto_study": True,
                "interactive": "script_metadata",
                "wait_for_solve": "script_metadata",
                "legacy_cli": False,
            },
        }

    def test_terminal_activation_replays_without_reading_changed_script_or_posting(self):
        with self.environment(), mock.patch.object(
            startup, "_load_provenance_with_digest", return_value=(self.authorization, self.provenance_sha256),
        ), mock.patch.object(startup, "_bounded_regular", side_effect=self.bounded_regular), mock.patch.object(
            startup, "activate", return_value=self.response(),
        ) as activate:
            first = startup.run_from_environment()
        activate.assert_called_once()
        self.assertEqual(first["state"], "activated")
        durable = json.loads(self.receipt_path.read_text(encoding="utf-8"))
        self.assertEqual(durable["schema"], startup.ACTIVATION_RECEIPT_SCHEMA)
        self.assertEqual(durable["state"], "activated")
        self.assertEqual(durable["request_id"], self.authorization["request_id"])
        self.assertEqual(durable["provenance_sha256"], self.provenance_sha256)
        self.assertEqual(durable["source_sha256"], self.authorization["source_sha256"])
        self.source_bytes = b"changed-script"
        self.health_check.side_effect = startup.StartupScriptError(
            "active session should not be consulted for a terminal replay"
        )
        def no_script_read(path, _maximum, label):
            if label == "startup activation receipt":
                return self.receipt_path.read_bytes()
            raise AssertionError("terminal replay must not reread the mounted startup script")
        with self.environment(), mock.patch.object(
            startup, "_load_provenance_with_digest", return_value=(self.authorization, self.provenance_sha256),
        ), mock.patch.object(startup, "_bounded_regular", side_effect=no_script_read), mock.patch.object(
            startup, "activate",
        ) as activate:
            replay = startup.run_from_environment()
        self.assertEqual(replay, first)
        activate.assert_not_called()

    def test_two_distinct_requests_use_distinct_receipts_when_health_reports_no_active_session(self):
        root = Path(self.receipt_directory.name) / "control" / "backend"
        root.mkdir(parents=True)
        authorization_one = self.authorization
        authorization_two = {
            **authorization_one,
            "request_id": "startup-receipt-test-two",
            "source_sha256": hashlib.sha256(b"script-two").hexdigest(),
            "source_size_bytes": len(b"script-two"),
        }
        provenance_one = "a" * 64
        provenance_two = "b" * 64
        requests = (
            (authorization_one, b"script", provenance_one),
            (authorization_two, b"script-two", provenance_two),
        )
        with mock.patch.object(startup, "STARTUP_RECEIPT_ROOT", root):
            paths = [
                startup.activation_receipt_path_for_key(
                    hashlib.sha256(authorization["request_id"].encode()).hexdigest()
                )
                for authorization, _source, _provenance in requests
            ]
            for authorization, source_bytes, provenance_sha256 in requests:
                receipt_path = startup.activation_receipt_path_for_key(
                    hashlib.sha256(authorization["request_id"].encode()).hexdigest()
                )
                self.health_check.reset_mock()
                with mock.patch.object(startup, "ACTIVATION_RECEIPT_PATH", receipt_path), \
                        self.environment_for(authorization, provenance_sha256), \
                        mock.patch.object(
                            startup, "_load_provenance_with_digest",
                            return_value=(authorization, provenance_sha256),
                        ), \
                        mock.patch.object(
                            startup, "_bounded_regular",
                            side_effect=lambda path, _maximum, label: (
                                Path(path).read_bytes()
                                if label == "startup activation receipt"
                                else source_bytes
                                if label == "mounted startup script"
                                else (_ for _ in ()).throw(AssertionError(label))
                            ),
                        ), \
                        mock.patch.object(
                            startup, "activate", side_effect=lambda auth, **_: self.response_for(auth)
                        ) as activate:
                    result = startup.run_from_environment()
                self.assertEqual(result["state"], "activated")
                self.assertEqual(activate.call_count, 1)
                self.health_check.assert_called_once_with("http://127.0.0.1:8081")
        self.assertNotEqual(paths[0], paths[1])
        self.assertTrue(paths[0].exists())
        self.assertTrue(paths[1].exists())

    def environment_for(self, authorization, provenance_sha256):
        return mock.patch.dict(os.environ, {
            "FULLMAG_STARTUP_ENABLED": "1",
            "FULLMAG_STARTUP_SCRIPT": authorization["container_script_path"],
            "FULLMAG_STARTUP_PROVENANCE": "/run/fullmag/startup-provenance.json",
            startup.PROVENANCE_SHA256_ENV: provenance_sha256,
        }, clear=True)

    def test_active_session_refuses_new_request_before_started_marker(self):
        self.health_check.side_effect = startup.StartupScriptError(
            "backend has an active or unknown session"
        )
        with self.environment(), mock.patch.object(
            startup, "_load_provenance_with_digest", return_value=(self.authorization, self.provenance_sha256),
        ), mock.patch.object(startup, "_bounded_regular", side_effect=self.bounded_regular), mock.patch.object(
            startup, "activate",
        ) as activate:
            with self.assertRaisesRegex(startup.StartupScriptError, "active or unknown"):
                startup.run_from_environment()
        self.assertFalse(self.receipt_path.exists())
        activate.assert_not_called()

    def test_started_receipt_blocks_unknown_post_retry(self):
        with self.environment(), mock.patch.object(
            startup, "_load_provenance_with_digest", return_value=(self.authorization, self.provenance_sha256),
        ), mock.patch.object(startup, "_bounded_regular", side_effect=self.bounded_regular), mock.patch.object(
            startup, "activate", side_effect=startup._StartupActivationTransportUnknown("HTTP 500"),
        ) as activate:
            with self.assertRaises(startup.StartupActivationOutcomeUnknown) as caught:
                startup.run_from_environment()
        self.assertEqual(caught.exception.diagnostic["state"], "unknown")
        self.assertEqual(caught.exception.diagnostic["durable_state"], "started")
        self.assertEqual(caught.exception.diagnostic["request_id"], self.authorization["request_id"])
        activate.assert_called_once()
        self.health_check.reset_mock()
        with self.environment(), mock.patch.object(
            startup, "_load_provenance_with_digest", return_value=(self.authorization, self.provenance_sha256),
        ), mock.patch.object(startup, "_bounded_regular", side_effect=self.bounded_regular), mock.patch.object(
            startup, "activate",
        ) as activate:
            with self.assertRaises(startup.StartupActivationOutcomeUnknown) as replay:
                startup.run_from_environment()
        self.assertIn("prevents a retry", replay.exception.diagnostic["error"])
        activate.assert_not_called()
        self.health_check.assert_not_called()

    def test_marker_fsync_failure_is_fatal_without_post_or_unknown(self):
        with self.environment(), mock.patch.object(
            startup, "_load_provenance_with_digest", return_value=(self.authorization, self.provenance_sha256),
        ), mock.patch.object(startup, "_bounded_regular", side_effect=self.bounded_regular), mock.patch.object(
            startup.os, "fsync", side_effect=OSError("marker fsync failed"),
        ), mock.patch.object(startup, "activate") as activate:
            with self.assertRaisesRegex(startup.StartupScriptError, "cannot publish startup activation receipt"):
                startup.run_from_environment()
        self.assertTrue(self.receipt_path.exists())
        activate.assert_not_called()

    def test_rejected_terminal_result_replays_without_posting(self):
        rejection = startup.StartupScriptRejected(422, "validation_error", "invalid model")
        with self.environment(), mock.patch.object(
            startup, "_load_provenance_with_digest", return_value=(self.authorization, self.provenance_sha256),
        ), mock.patch.object(startup, "_bounded_regular", side_effect=self.bounded_regular), mock.patch.object(
            startup, "activate", side_effect=rejection,
        ) as activate:
            first = startup.run_from_environment()
        self.assertEqual(first["state"], "rejected")
        activate.assert_called_once()
        with self.environment(), mock.patch.object(
            startup, "_load_provenance_with_digest", return_value=(self.authorization, self.provenance_sha256),
        ), mock.patch.object(startup, "_bounded_regular", side_effect=self.bounded_regular), mock.patch.object(
            startup, "activate",
        ) as activate:
            replay = startup.run_from_environment()
        self.assertEqual(replay, first)
        activate.assert_not_called()

    def test_foreign_receipt_hash_fails_closed_without_post(self):
        with self.environment(), mock.patch.object(
            startup, "_load_provenance_with_digest", return_value=(self.authorization, self.provenance_sha256),
        ), mock.patch.object(startup, "_bounded_regular", side_effect=self.bounded_regular), mock.patch.object(
            startup, "activate", return_value=self.response(),
        ):
            startup.run_from_environment()
        document = json.loads(self.receipt_path.read_text(encoding="utf-8"))
        document["provenance_sha256"] = "b" * 64
        self.receipt_path.write_text(json.dumps(document), encoding="utf-8")
        with self.environment(), mock.patch.object(
            startup, "_load_provenance_with_digest", return_value=(self.authorization, self.provenance_sha256),
        ), mock.patch.object(startup, "_bounded_regular", side_effect=self.bounded_regular), mock.patch.object(
            startup, "activate",
        ) as activate:
            with self.assertRaisesRegex(startup.StartupScriptError, "different request"):
                startup.run_from_environment()
        activate.assert_not_called()

    def test_changed_receipt_authorization_snapshot_fails_closed_without_post(self):
        with self.environment(), mock.patch.object(
            startup, "_load_provenance_with_digest", return_value=(self.authorization, self.provenance_sha256),
        ), mock.patch.object(startup, "_bounded_regular", side_effect=self.bounded_regular), mock.patch.object(
            startup, "activate", return_value=self.response(),
        ):
            startup.run_from_environment()
        document = json.loads(self.receipt_path.read_text(encoding="utf-8"))
        document["authorization"]["source_size_bytes"] += 1
        self.receipt_path.write_text(json.dumps(document), encoding="utf-8")
        with self.environment(), mock.patch.object(
            startup, "_load_provenance_with_digest", return_value=(self.authorization, self.provenance_sha256),
        ), mock.patch.object(startup, "_bounded_regular", side_effect=self.bounded_regular), mock.patch.object(
            startup, "activate",
        ) as activate:
            with self.assertRaisesRegex(startup.StartupScriptError, "different request"):
                startup.run_from_environment()
        activate.assert_not_called()

    def test_receipt_symlink_is_rejected_without_post(self):
        target = self.receipt_path.with_name("foreign-receipt.json")
        target.write_text("{}", encoding="utf-8")
        try:
            self.receipt_path.symlink_to(target)
        except (OSError, NotImplementedError) as error:
            self.skipTest(f"symlinks unavailable: {error}")
        with self.environment(), mock.patch.object(
            startup, "_load_provenance_with_digest", return_value=(self.authorization, self.provenance_sha256),
        ), mock.patch.object(startup, "activate") as activate:
            with self.assertRaises(startup.StartupScriptError):
                startup.run_from_environment()
        activate.assert_not_called()

    def test_corrupt_receipt_is_retained_and_blocks_post(self):
        self.receipt_path.write_text("{", encoding="utf-8")
        with self.environment(), mock.patch.object(
            startup, "_load_provenance_with_digest", return_value=(self.authorization, self.provenance_sha256),
        ), mock.patch.object(startup, "_bounded_regular", side_effect=self.bounded_regular), mock.patch.object(
            startup, "activate",
        ) as activate:
            with self.assertRaisesRegex(startup.StartupScriptError, "not valid JSON"):
                startup.run_from_environment()
        activate.assert_not_called()


if __name__ == "__main__":
    unittest.main()
