"""Interpreted contract checks for the private terminal-workspace bridge.

These tests exercise bounded Python transport and exact retained-operation
identity with a fake local HTTP opener; native runtime needs separate proof.
"""
from __future__ import annotations

import importlib.util
import io
import json
import sys
import hashlib
import os
import inspect
import unittest
from unittest.mock import patch, Mock
from contextlib import ExitStack
from types import SimpleNamespace
import tempfile
import subprocess
import shutil
try:
    import fcntl
except ImportError:
    fcntl = None
from pathlib import Path
from urllib.error import HTTPError


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
SPEC = importlib.util.spec_from_file_location("retirement_draft_helper", ROOT / "scripts/docker_startup_script.py")
assert SPEC is not None and SPEC.loader is not None
helper = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = helper
SPEC.loader.exec_module(helper)
import docker_volume_activate as activate


class _Response:
    def __init__(self, status: int, value: object):
        self.status = status
        self._body = json.dumps(value).encode("utf-8")
        self.headers = {}

    def read(self, _maximum: int = -1) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class _Opener:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        response = next(self.responses)
        if isinstance(response, BaseException):
            raise response
        return response


def _status(scope="api:7", session_id="session-1", run_id="run-1"):
    return {
        "schema": "fullmag.live-workspace-retirement-context.v1",
        "api_instance_id": scope.rsplit(":", 1)[0],
        "request_scope_epoch": scope,
        "session_id": session_id,
        "run_id": run_id,
    }


def _retirement():
    digest = "a" * 64
    return {
        "schema": helper.RETIREMENT_RESPONSE_SCHEMA,
        "state": "retired",
        "operation_id": "docker-volume-op-1",
        "session_id": "session-1",
        "run_id": "run-1",
        "request_scope_epoch": "api:7",
        "api_request_scope_epoch": "api:7",
        "session_epoch": 4,
        "scene_revision": 9,
        "state_version": 12,
        "terminal_outcome": "completed",
        "archive_manifest_path": "retirements/docker-volume-op-1/project/retirement-manifest.json",
        "archive_sha256": digest,
        "terminal_evidence_sha256": digest,
        "ui_state_scope": "backend_typed_workspace",
        "script_available": True,
    }


def _patch_opener(monkeypatch, responses):
    opener = _Opener(responses)
    monkeypatch.setattr(helper.urllib.request, "build_opener", lambda *_args: opener)
    return opener


class _Patches:
    def __init__(self, stack):
        self.stack = stack

    def setattr(self, target, name, value):
        return self.stack.enter_context(patch.object(target, name, value))

    def setenv(self, name, value):
        self.stack.enter_context(patch.dict(os.environ, {name: value}))


class RetirementTransportTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.monkeypatch = _Patches(self.stack)
        self.stack.enter_context(patch.object(helper, "_retirement_operator_token", return_value="0123456789abcdef0123456789abcdef"))

    def test_5xx_with_refusal_code_is_still_unknown(self):
        for status in (500, 503):
            for as_exception in (False, True):
                with self.subTest(status=status, as_exception=as_exception):
                    body = {"code": "live_retirement_runtime_not_terminal"}
                    response = (HTTPError("http://127.0.0.1:8081", status, "unavailable", {}, io.BytesIO(json.dumps(body).encode()))
                                if as_exception else _Response(status, body))
                    _patch_opener(self.monkeypatch, [_Response(200, _status()), response])
                    with self.assertRaises(helper.RetirementOutcomeUnknown):
                        helper._retire_current_workspace_transport("docker-volume-op-1")

    def test_empty_current_workspace_is_a_safe_noop(self):
        monkeypatch = self.monkeypatch
        opener = _patch_opener(
            monkeypatch,
            [_Response(200, _status(session_id=None, run_id=None))],
        )
        assert helper._retire_current_workspace_transport("docker-volume-op-1") is None
        assert len(opener.requests) == 1

    def test_retained_retirement_replays_after_api_restart_with_empty_workspace(self):
        monkeypatch = self.monkeypatch
        response = _retirement()
        response["request_scope_epoch"] = "old-api:7"
        response["api_request_scope_epoch"] = "new-api:12"
        response["state"] = "replayed"
        opener = _patch_opener(monkeypatch, [
            _Response(200, _status(scope="new-api:12", session_id=None, run_id=None)),
            _Response(200, response),
        ])
        result = helper._retire_current_workspace_transport(
            "docker-volume-op-1",
            predecessor={"proof_sha256": "f" * 64, "request_scope_epoch": "old-api:7"},
            retained_identity={"session_id": "session-1", "run_id": "run-1"},
        )
        assert result is not None and result["state"] == "replayed"
        request = opener.requests[1][0]
        assert json.loads(request.data) == {
            "schema": helper.RETIREMENT_REQUEST_SCHEMA,
            "operation_id": "docker-volume-op-1",
            "session_id": "session-1",
            "run_id": "run-1",
            "request_scope_epoch": "new-api:12",
            "predecessor": {
                "proof_sha256": "f" * 64,
                "request_scope_epoch": "old-api:7",
            },
        }

    def test_terminal_workspace_response_is_fenced(self):
        monkeypatch = self.monkeypatch
        opener = _patch_opener(monkeypatch, [_Response(200, _status()), _Response(200, _retirement())])
        result = helper._retire_current_workspace_transport("docker-volume-op-1")
        assert result is not None and result["state"] == "retired"
        request = opener.requests[1][0]
        body = json.loads(request.data)
        assert body == {
            "schema": helper.RETIREMENT_REQUEST_SCHEMA,
            "operation_id": "docker-volume-op-1",
            "session_id": "session-1",
            "run_id": "run-1",
            "request_scope_epoch": "api:7",
        }

    def test_post_conflict_is_outcome_unknown(self):
        monkeypatch = self.monkeypatch
        opener = _patch_opener(monkeypatch, [_Response(200, _status()), _Response(409, {})])
        try:
            helper._retire_current_workspace_transport("docker-volume-op-1")
        except helper.RetirementOutcomeUnknown as error:
            assert error.diagnostic["state"] == "unknown"
            assert error.diagnostic["phase"] == "retirement"
        else:
            raise AssertionError("a retirement conflict must retain the operation as unknown")
        assert len(opener.requests) == 2

    def test_unknown_retirement_carries_only_authenticated_archive_predecessor(self):
        monkeypatch = self.monkeypatch
        with tempfile.TemporaryDirectory() as directory:
            runs_root = Path(directory) / "runs"
            manifest = (
                runs_root
                / "session-store"
                / "retirements"
                / "docker-volume-op-1"
                / "project"
                / "retirement-manifest.json"
            )
            manifest.parent.mkdir(parents=True)
            raw = json.dumps(
                {
                    "schema": "fullmag.live-workspace-retirement-proof.v2",
                    "state": "retired",
                    "operation_id": "docker-volume-op-1",
                    "session_id": "session-1",
                    "run_id": "run-1",
                    "request_scope_epoch": "old-api:7",
                },
                sort_keys=True,
            ).encode("utf-8")
            manifest.write_bytes(raw)
            monkeypatch.setenv("FULLMAG_RUNS_ROOT", str(runs_root))
            opener = _patch_opener(monkeypatch, [_Response(200, _status()), _Response(500, {})])
            try:
                helper._retire_current_workspace_transport("docker-volume-op-1")
            except helper.RetirementOutcomeUnknown as error:
                predecessor = error.diagnostic["retirement"]
            else:
                raise AssertionError("a server failure must retain the retirement predecessor")
            assert predecessor == {
                "operation_id": "docker-volume-op-1",
                "archive_sha256": hashlib.sha256(raw).hexdigest(),
                "request_scope_epoch": "old-api:7",
                "session_id": "session-1",
                "run_id": "run-1",
                "api_request_scope_epoch": "api:7",
            }
            assert len(opener.requests) == 2

    def test_retained_retirement_receipt_requires_exact_operation_and_inputs(self):
        operation_id = "a" * 32
        receipt = {
            "schema": activate.OPERATION_SCHEMA,
            "phase": "activation",
            "state": "outcome-unknown-resources-retained",
            "attempt": operation_id,
            "helper_container": "fullmag-control-" + operation_id,
            "helper_sha256": "1" * 64,
            "inputs": {
                "development_attempt": "b" * 32,
                "config_sha256": "c" * 64,
                "source_root": "C:/git/fullmag",
                "image_id": "sha256:" + "d" * 64,
                "backend_container": "e" * 64,
                "source_relative": "examples/model.py",
                "source_sha256": "1" * 64,
                "request_id": "request-1",
                "provenance_sha256": "2" * 64,
                "activation_receipt_key": "19f1064b619d49d35392eac7261cd7266c720671fc594f4b226f32bf0bee74ba",
                "activation_receipt_path": "/opt/fullmag/control/backend/script-activation-19f1064b619d49d35392eac7261cd7266c720671fc594f4b226f32bf0bee74ba/activation.json",
            },
            "retirement": {
                "operation_id": operation_id,
                "session_id": "session-1",
                "run_id": "run-1",
                "archive_sha256": "f" * 64,
                "request_scope_epoch": "old-api:7",
                "api_request_scope_epoch": "api:8",
            },
        }
        receipt["retirement_inputs_sha256"] = activate._retirement_inputs_sha256(receipt["inputs"])
        receipt["retirement_phase"] = "retirement"
        validated, context = activate._validate_retirement_receipt(
            receipt,
            operation_id=operation_id,
            development_attempt="b" * 32,
            config_sha256="c" * 64,
            source_root="C:/git/fullmag",
            image_id="sha256:" + "d" * 64,
            backend_id="e" * 64,
        )
        assert validated["attempt"] == operation_id
        assert context["predecessor"] == {
            "proof_sha256": "f" * 64,
            "request_scope_epoch": "old-api:7",
        }
        receipt["retirement"]["operation_id"] = "9" * 32
        try:
            activate._validate_retirement_receipt(
                receipt,
                operation_id=operation_id,
                development_attempt="b" * 32,
                config_sha256="c" * 64,
                source_root="C:/git/fullmag",
                image_id="sha256:" + "d" * 64,
                backend_id="e" * 64,
            )
        except activate.BuildControlError:
            pass
        else:
            raise AssertionError("retained retirement operation identity must be immutable")

    def test_operator_token_is_header_only(self):
        monkeypatch = self.monkeypatch
        opener = _patch_opener(monkeypatch, [_Response(200, _status()), _Response(200, _retirement())])
        result = helper._retire_current_workspace_transport("docker-volume-op-1")
        request = opener.requests[1][0]
        assert request.get_header("Authorization") == "Bearer 0123456789abcdef0123456789abcdef"
        assert b"0123456789abcdef0123456789abcdef" not in request.data
        assert "0123456789abcdef0123456789abcdef" not in json.dumps(result)

    def test_scope_mismatch_is_not_accepted(self):
        monkeypatch = self.monkeypatch
        response = _retirement()
        response["api_request_scope_epoch"] = "other-api:8"
        _patch_opener(monkeypatch, [_Response(200, _status()), _Response(200, response)])
        try:
            helper._retire_current_workspace_transport("docker-volume-op-1")
        except helper.RetirementOutcomeUnknown as error:
            assert error.diagnostic["phase"] == "retirement"
        else:
            raise AssertionError("a mismatched retirement response must fail closed")

    def test_known_active_run_refusal_is_confirmed_without_unknown_quarantine(self):
        opener = _patch_opener(self.monkeypatch, [
            _Response(200, _status()),
            _Response(409, {"code": "live_retirement_runtime_not_terminal"}),
        ])
        with self.assertRaises(helper.StartupScriptError) as caught:
            helper._retire_current_workspace_transport("docker-volume-op-1")
        self.assertNotIsInstance(caught.exception, helper.RetirementOutcomeUnknown)
        self.assertEqual(len(opener.requests), 2)

    def test_unavailable_context_sends_no_retirement_post(self):
        opener = _patch_opener(self.monkeypatch, [TimeoutError("lost read")])
        with self.assertRaises(helper.StartupScriptError) as caught:
            helper._retire_current_workspace_transport("docker-volume-op-1")
        self.assertNotIsInstance(caught.exception, helper.RetirementOutcomeUnknown)
        self.assertEqual(len(opener.requests), 1)
        self.assertEqual(opener.requests[0][0].get_method(), "GET")

    def test_noncanonical_api_urls_are_rejected_before_network(self):
        opener = _patch_opener(self.monkeypatch, [])
        for url in ["http://127.0.0.1:9999", "http://user@127.0.0.1:8081", "http://127.0.0.1:8081/other", "http://127.0.0.1:8081?query=1", "https://127.0.0.1:8081"]:
            with self.subTest(url=url), self.assertRaises(helper.StartupScriptError):
                helper._retire_current_workspace_transport("docker-volume-op-1", api_base=url)
        self.assertFalse(opener.requests)

    def test_incomplete_context_identity_sends_no_post(self):
        opener = _patch_opener(self.monkeypatch, [_Response(200, _status(run_id=None))])
        with self.assertRaises(helper.StartupScriptError):
            helper._retire_current_workspace_transport("docker-volume-op-1")
        self.assertEqual(len(opener.requests), 1)

    def test_response_archive_and_integer_fences_are_validated(self):
        for field, value in [("archive_manifest_path", "retirements/other/project/retirement-manifest.json"), ("session_epoch", True), ("scene_revision", -1), ("state_version", "12")]:
            with self.subTest(field=field):
                response = dict(_retirement(), **{field: value})
                opener = _patch_opener(self.monkeypatch, [_Response(200, _status()), _Response(200, response)])
                with self.assertRaises(helper.RetirementOutcomeUnknown):
                    helper._retire_current_workspace_transport("docker-volume-op-1")
                self.assertEqual(len(opener.requests), 2)


class PrivateCapabilityReaderTests(unittest.TestCase):
    def test_ambient_credentials_are_rejected_before_reading_private_file(self):
        with patch.dict(os.environ, {"FULLMAG_LOCAL_COMPUTE_OPERATOR_TOKEN": "a" * 32}):
            with self.assertRaisesRegex(helper.StartupScriptError, "ambient"):
                helper._retirement_operator_token()

    def test_private_reader_is_required_and_its_secret_is_not_in_errors(self):
        from types import SimpleNamespace
        with patch.dict(os.environ, {}, clear=True):
            for token in [None, "malformed-secret"]:
                with self.subTest(token=token), patch.dict(sys.modules, {"entrypoint": SimpleNamespace(read_operator_capability=lambda: token)}):
                    with self.assertRaisesRegex(helper.StartupScriptError, "unavailable") as caught:
                        helper._retirement_operator_token()
                    self.assertNotIn("malformed-secret", str(caught.exception))
            with patch.dict(sys.modules, {"entrypoint": SimpleNamespace(read_operator_capability=lambda: "c" * 32)}):
                self.assertEqual(helper._retirement_operator_token(), "c" * 32)


class DurableRetirementTests(unittest.TestCase):
    operation = "b" * 32
    inputs = "d" * 64

    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        directory = self.stack.enter_context(tempfile.TemporaryDirectory())
        self.root = Path(directory) / "backend"
        self.root.mkdir()
        self.stack.enter_context(patch.object(helper, "STARTUP_RECEIPT_ROOT", self.root))
        self.stack.enter_context(patch.object(helper, "_retirement_operator_token", return_value="0123456789abcdef0123456789abcdef"))
        self.context = self.stack.enter_context(patch.object(helper, "_retirement_context", return_value=_status()))
        self.archive = self.stack.enter_context(patch.object(helper, "_retirement_archive_receipt", return_value=None))
        self.response = dict(_retirement(), operation_id=self.operation, archive_manifest_path=f"retirements/{self.operation}/project/retirement-manifest.json")
        self.transport = self.stack.enter_context(patch.object(helper, "_retire_current_workspace_transport", return_value=self.response))

    def retire(self):
        return helper.retire_current_workspace(self.operation, operation_inputs_sha256=self.inputs)

    def test_partial_intent_write_never_exposes_malformed_final_marker(self):
        original_write = os.write
        writes = 0
        def fail_after_partial(fd, data):
            nonlocal writes
            writes += 1
            if writes == 1:
                return original_write(fd, data[:5])
            raise OSError(28, "injected no space")
        with patch.object(helper.os, "write", side_effect=fail_after_partial):
            with self.assertRaises(helper.StartupScriptError):
                self.retire()
        self.transport.assert_not_called()
        self.assertIsNone(helper.read_retirement_receipt(self.operation, self.inputs))
        self.assertFalse(list(self.root.glob("*/.*.tmp")))
        self.assertEqual(self.retire()["state"], "retired")

    def test_intent_file_fsync_failure_prevents_post_and_final_marker(self):
        with patch.object(helper.os, "fsync", side_effect=OSError("injected file sync failure")):
            with self.assertRaises(helper.StartupScriptError):
                self.retire()
        self.transport.assert_not_called()
        self.assertIsNone(helper.read_retirement_receipt(self.operation, self.inputs))
        self.assertFalse(list(self.root.glob("*/.*.tmp")))

    def test_exclusive_publication_never_replaces_existing_intent(self):
        self.retire()
        path = helper._retirement_receipt_path(self.operation)
        original = path.read_bytes()
        with self.assertRaises(helper._StartupActivationReceiptExists):
            helper._exclusive_retirement_intent(path, {"foreign": True})
        self.assertEqual(path.read_bytes(), original)
        self.assertFalse(list(self.root.glob("*/.*.tmp")))

    def test_parent_fsync_failure_retains_complete_intent_without_post(self):
        helper._ensure_activation_receipt_parent(helper._retirement_receipt_path(self.operation))
        original_sync = os.fsync
        syncs = 0
        def fail_parent(fd):
            nonlocal syncs
            syncs += 1
            if syncs == 2:
                raise OSError("injected parent sync failure")
            return original_sync(fd)
        with patch.object(helper.os, "fsync", side_effect=fail_parent):
            with self.assertRaises(helper.StartupScriptError):
                self.retire()
        self.transport.assert_not_called()
        self.assertEqual(helper.read_retirement_receipt(self.operation, self.inputs)["state"], "started")
        self.assertEqual(self.retire()["state"], "retired")

    def test_intent_is_durable_before_post_and_terminal_reuses_one_record(self):
        def post(*_args, **_kwargs):
            intent = helper.read_retirement_receipt(self.operation, self.inputs)
            self.assertEqual(intent["state"], "started")
            self.assertEqual((intent["session_id"], intent["run_id"]), ("session-1", "run-1"))
            return self.response
        self.transport.side_effect = post
        self.assertEqual(self.retire()["archive_sha256"], "a" * 64)
        terminal = helper.read_retirement_receipt(self.operation, self.inputs)
        self.assertEqual(terminal["state"], "retired")
        self.assertEqual(terminal["response"]["operation_id"], self.operation)
        self.assertEqual(len(list(self.root.glob("*/retirement.json"))), 1)
        self.assertFalse(list(self.root.glob("*/.*.tmp")))

    def test_lost_post_before_archive_can_resume_only_the_exact_recorded_run(self):
        self.transport.side_effect = [helper.RetirementOutcomeUnknown(self.operation, "retirement", "lost response"), self.response]
        with self.assertRaises(helper.RetirementOutcomeUnknown):
            self.retire()
        self.assertEqual(helper.read_retirement_receipt(self.operation, self.inputs)["state"], "started")
        self.assertEqual(self.retire()["run_id"], "run-1")
        for call in self.transport.call_args_list:
            self.assertEqual(call.args[0], self.operation)
            self.assertEqual(call.kwargs["retained_identity"], {"session_id": "session-1", "run_id": "run-1"})
        self.assertEqual(len(list(self.root.glob("*/retirement.json"))), 1)

    def test_recorded_operation_never_retires_a_different_current_workspace(self):
        self.transport.side_effect = helper.RetirementOutcomeUnknown(self.operation, "retirement", "lost response")
        with self.assertRaises(helper.RetirementOutcomeUnknown):
            self.retire()
        self.transport.reset_mock()
        self.context.return_value = _status(session_id="other-session", run_id="other-run")
        with self.assertRaisesRegex(helper.StartupScriptError, "differs"):
            self.retire()
        self.transport.assert_not_called()

    def test_new_api_empty_workspace_uses_exact_archive_and_current_scope(self):
        self.transport.side_effect = helper.RetirementOutcomeUnknown(self.operation, "retirement", "lost response")
        with self.assertRaises(helper.RetirementOutcomeUnknown):
            self.retire()
        self.context.return_value = _status(scope="new-api:12", session_id=None, run_id=None)
        self.archive.return_value = {"archive_sha256": "a" * 64, "request_scope_epoch": "api:7"}
        self.transport.side_effect = None
        self.transport.return_value = dict(self.response, state="replayed", api_request_scope_epoch="new-api:12")
        self.retire()
        call = self.transport.call_args
        self.assertEqual(call.kwargs["predecessor"], {"proof_sha256": "a" * 64, "request_scope_epoch": "api:7"})
        self.assertEqual(call.kwargs["observed_context"]["request_scope_epoch"], "new-api:12")
        self.assertEqual(helper.read_retirement_receipt(self.operation, self.inputs)["state"], "retired")

    def test_recorded_run_absent_without_archive_remains_unknown(self):
        self.transport.side_effect = helper.RetirementOutcomeUnknown(self.operation, "retirement", "lost response")
        with self.assertRaises(helper.RetirementOutcomeUnknown):
            self.retire()
        self.transport.reset_mock()
        self.context.return_value = _status(session_id=None, run_id=None)
        with self.assertRaises(helper.RetirementOutcomeUnknown):
            self.retire()
        self.transport.assert_not_called()
        self.assertEqual(helper.read_retirement_receipt(self.operation, self.inputs)["state"], "started")

    def test_input_digest_drift_rejects_replay_before_api_access(self):
        self.retire()
        self.context.reset_mock()
        with self.assertRaisesRegex(helper.StartupScriptError, "differs"):
            helper.retire_current_workspace(self.operation, operation_inputs_sha256="f" * 64)
        self.context.assert_not_called()

    def test_failed_terminal_receipt_does_not_claim_confirmed_completion(self):
        with patch.object(helper, "_replace_json", side_effect=helper.StartupScriptError("injected durable write failure")):
            with self.assertRaises(helper.RetirementOutcomeUnknown) as caught:
                self.retire()
        self.assertEqual(caught.exception.diagnostic["retirement"]["archive_sha256"], "a" * 64)
        self.assertEqual(helper.read_retirement_receipt(self.operation, self.inputs)["state"], "started")

    def test_known_active_refusal_records_rejection_and_never_reposts_that_operation(self):
        self.transport.side_effect = helper.RetirementRefused(self.operation, "live_retirement_runtime_not_terminal")
        with self.assertRaises(helper.StartupScriptError):
            self.retire()
        self.assertEqual(helper.read_retirement_receipt(self.operation, self.inputs)["state"], "rejected")
        self.transport.reset_mock()
        with self.assertRaises(helper.StartupScriptError):
            self.retire()
        self.transport.assert_not_called()

    def test_retained_operation_without_intent_never_binds_a_new_workspace(self):
        with self.assertRaises(helper.RetirementOutcomeUnknown):
            helper.retire_current_workspace(self.operation, operation_inputs_sha256=self.inputs,
                                            require_existing_intent=True)
        self.context.assert_not_called()
        self.transport.assert_not_called()
        self.assertFalse(list(self.root.iterdir()))

    def test_preflight_failure_without_intent_is_confirmed_without_post(self):
        self.context.side_effect = helper.StartupScriptError("API unavailable")
        with self.assertRaises(helper.RetirementRefused) as caught:
            self.retire()
        self.assertEqual(caught.exception.diagnostic["code"], "preflight_failed")
        self.transport.assert_not_called()
        self.assertFalse(list(self.root.iterdir()))

    def test_preflight_failure_with_prior_unknown_never_claims_refusal(self):
        self.transport.side_effect = helper.RetirementOutcomeUnknown(self.operation, "retirement", "lost")
        with self.assertRaises(helper.RetirementOutcomeUnknown):
            self.retire()
        self.context.side_effect = helper.StartupScriptError("API unavailable")
        with self.assertRaises(helper.StartupScriptError) as caught:
            self.retire()
        self.assertNotIsInstance(caught.exception, helper.RetirementRefused)
        self.assertEqual(helper.read_retirement_receipt(self.operation, self.inputs)["state"], "started")

    def test_refused_retry_preserves_original_unknown_post(self):
        self.transport.side_effect = [helper.RetirementOutcomeUnknown(self.operation, "retirement", "lost"),
                                      helper.RetirementRefused(self.operation, "live_retirement_busy")]
        with self.assertRaises(helper.RetirementOutcomeUnknown):
            self.retire()
        with self.assertRaises(helper.RetirementOutcomeUnknown):
            self.retire()
        self.assertEqual(helper.read_retirement_receipt(self.operation, self.inputs)["state"], "started")

    def test_empty_workspace_requires_no_intent_or_post(self):
        self.context.return_value = _status(session_id=None, run_id=None)
        self.assertIsNone(self.retire())
        self.transport.assert_not_called()
        self.assertFalse(list(self.root.iterdir()))


@unittest.skipUnless(fcntl is not None and all(shutil.which(tool) for tool in ("bash", "flock", "sync", "sha256sum")), "requires Linux shell CAS tools")
class RetirementFinalizeTests(unittest.TestCase):
    operation = "b" * 32
    previous_operation = "a" * 32
    helper_id = "f" * 64

    class _Control:
        def __init__(self, root, receipt):
            self.root = Path(root)
            self.receipt = receipt
            self.project = "fullmag-retirement-test"
            self.volume = "fullmag-retirement-test-control"
            self.namespace = ""
            self.namespace_registry_sha256 = None
            self.inspect_calls = []

        def _inspect_operation_helper(self, operation, *, expected_id=None):
            self.inspect_calls.append((operation, expected_id))
            if operation != {"receipt": self.receipt}:
                raise activate.ControlOutcomeUnknown("helper receipt differs")
            if expected_id not in (None, RetirementFinalizeTests.helper_id):
                raise activate.ControlOutcomeUnknown("helper identity pin differs")
            return RetirementFinalizeTests.helper_id

        def _namespace_guard(self, script):
            return script

        def helper_args(self, script, **_kwargs):
            return ["bash", "-c", script.replace("/control", str(self.root))]

        def write_bytes(self, relative, payload):
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(payload)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "control"
        self.attempt = self.root / "activation/attempts" / self.operation
        self.attempt.mkdir(parents=True)
        self.project = "fullmag-retirement-test"
        self.volume = "fullmag-retirement-test-control"
        self.receipt = {
            "schema": activate.OPERATION_SCHEMA,
            "phase": "activation",
            "state": "outcome-unknown-resources-retained",
            "attempt": self.operation,
            "compose_project": self.project,
            "control_volume": self.volume,
            "helper_container": "fullmag-control-" + self.operation,
        }
        self.receipt_raw = activate.canonical(self.receipt) + b"\n"
        self.result = {"state": "retirement-only", "retirement": {"state": "retired"}}
        self.terminal = dict(
            self.receipt,
            state="failed-confirmed",
            activation_state="retirement-replayed",
            retirement_resume_state="succeeded",
        )
        self.result_raw = activate.canonical(self.result) + b"\n"
        self.terminal_raw = activate.canonical(self.terminal) + b"\n"
        self.previous_terminal = {
            "schema": activate.OPERATION_SCHEMA,
            "phase": "activation",
            "state": "succeeded",
            "attempt": self.previous_operation,
            "compose_project": self.project,
            "control_volume": self.volume,
        }
        self.previous_raw = activate.canonical(self.previous_terminal) + b"\n"
        (self.root / "active").write_bytes(self.operation.encode("ascii") + b"\n")
        (self.root / "operation.lock").touch()
        (self.attempt / "receipt.json").write_bytes(self.receipt_raw)
        old_attempt = self.root / "activation/attempts" / self.previous_operation
        old_attempt.mkdir()
        (old_attempt / "terminal.json").write_bytes(self.previous_raw)
        (self.root / "activation/current.json").write_bytes(self.previous_raw)
        self.control = self._Control(self.root, self.receipt)

    def _read_control(self, control, relative, *, optional=False, maximum=8 * 1024 * 1024):
        path = control.root / relative
        if not path.exists():
            if optional:
                return None
            raise activate.BuildControlError("fixture control record is missing: " + relative)
        raw = path.read_bytes()
        if len(raw) > maximum:
            raise activate.BuildControlError("fixture control record exceeds its byte bound")
        return raw

    def _finalize(self):
        kwargs = {
            "operation_id": self.operation,
            "receipt_raw": self.receipt_raw,
            "result": self.result,
            "terminal": self.terminal,
        }
        if "retained_receipt" in inspect.signature(
            activate._finalize_retained_retirement
        ).parameters:
            kwargs["retained_receipt"] = self.receipt
        activate._finalize_retained_retirement(self.control, **kwargs)

    def test_live_logger_cas_publishes_over_terminal_previous_current_and_keeps_lease(self):
        commands = []
        lock = (self.root / "operation.lock").open("rb")
        self.addCleanup(lock.close)
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)

        def exec_live_helper(command, *, data=b"", timeout=90, **_kwargs):
            commands.append(command)
            self.assertIn(self.helper_id, command)
            script = command[-1].replace("/control", str(self.root))
            completed = subprocess.run(
                ["bash", "-c", script], input=data, capture_output=True, timeout=timeout
            )
            return SimpleNamespace(
                returncode=completed.returncode,
                stdout=completed.stdout,
                stderr=completed.stderr,
            )

        with patch("docker_volume_activation_reconcile._probe_helper_absence", return_value=None), \
             patch.object(activate, "_read_control_bytes", side_effect=self._read_control), \
             patch("docker_dev_host.docker_argv", return_value=["docker"]), \
             patch.object(activate, "bounded_capture", side_effect=exec_live_helper), \
             patch.object(activate, "_wait_retirement_lease_release", return_value=True):
            self._finalize()

        self.assertEqual(len(commands), 1)
        self.assertEqual(len(self.control.inspect_calls), 2)
        self.assertEqual(
            [
                (self.attempt / "result.json").read_bytes(),
                (self.root / "activation/current.json").read_bytes(),
                (self.attempt / "terminal.json").read_bytes(),
            ],
            [self.result_raw, self.terminal_raw, self.terminal_raw],
        )
        self.assertEqual((self.root / "active").read_bytes(), self.operation.encode("ascii") + b"\n")
        self.assertNotIn("flock", commands[0][-1])

    def test_absent_logger_cas_accepts_producer_lf_and_releases_lease(self):
        with patch("docker_volume_activation_reconcile._probe_helper_absence", return_value={"state": "absent"}), \
             patch.object(activate, "_read_control_bytes", side_effect=self._read_control):
            self._finalize()

        self.assertEqual((self.attempt / "result.json").read_bytes(), self.result_raw)
        self.assertEqual((self.root / "activation/current.json").read_bytes(), self.terminal_raw)
        self.assertEqual((self.attempt / "terminal.json").read_bytes(), self.terminal_raw)
        self.assertFalse((self.root / "active").exists())

    def test_refused_retirement_finalizes_with_lf_and_previous_terminal(self):
        self.result["retirement"]["state"] = "rejected"
        self.terminal["activation_state"] = "retirement-refused-recovered"
        self.terminal["retirement_resume_state"] = "refused"
        with patch("docker_volume_activation_reconcile._probe_helper_absence", return_value={"state": "absent"}), \
             patch.object(activate, "_read_control_bytes", side_effect=self._read_control):
            self._finalize()
        self.assertFalse((self.root / "active").exists())
        self.assertEqual((self.attempt / "terminal.json").read_bytes(),
                         activate.canonical(self.terminal) + b"\n")

    def test_partial_current_publish_is_idempotent_when_target_pointer_is_already_current(self):
        (self.attempt / "result.json").write_bytes(self.result_raw)
        (self.root / "activation/current.json").write_bytes(self.terminal_raw)
        with patch("docker_volume_activation_reconcile._probe_helper_absence", return_value={"state": "absent"}), \
             patch.object(activate, "_read_control_bytes", side_effect=self._read_control):
            self._finalize()

        self.assertEqual((self.root / "activation/current.json").read_bytes(), self.terminal_raw)
        self.assertEqual((self.attempt / "terminal.json").read_bytes(), self.terminal_raw)
        self.assertFalse((self.root / "active").exists())

    def test_previous_current_must_be_a_terminal_of_this_control_group(self):
        cases = (
            ("schema", {"schema": "foreign", "phase": "activation", "state": "succeeded"}),
            ("phase", {"schema": activate.OPERATION_SCHEMA, "phase": "startup", "state": "succeeded"}),
            ("state", {"schema": activate.OPERATION_SCHEMA, "phase": "activation", "state": "building"}),
            ("project", dict(self.previous_terminal, compose_project="foreign")),
            ("volume", dict(self.previous_terminal, control_volume="foreign")),
            ("attempt", dict(self.previous_terminal, attempt="not-a-token")),
        )
        for label, record in cases:
            with self.subTest(label=label):
                raw = activate.canonical(record) + b"\n"
                (self.root / "activation/current.json").write_bytes(raw)
                (self.root / "activation/attempts" / self.previous_operation / "terminal.json").write_bytes(raw)
                with patch("docker_volume_activation_reconcile._probe_helper_absence", return_value={"state": "absent"}), \
                     patch.object(activate, "_read_control_bytes", side_effect=self._read_control), \
                     patch.object(activate, "bounded_capture") as shell:
                    with self.assertRaises(activate.ControlOutcomeUnknown):
                        self._finalize()
                shell.assert_not_called()
                (self.root / "activation/current.json").write_bytes(self.previous_raw)
                (self.root / "activation/attempts" / self.previous_operation / "terminal.json").write_bytes(self.previous_raw)

    def test_previous_current_must_match_its_per_attempt_terminal_bytes(self):
        (self.root / "activation/attempts" / self.previous_operation / "terminal.json").write_bytes(b"changed\n")
        with patch("docker_volume_activation_reconcile._probe_helper_absence", return_value={"state": "absent"}), \
             patch.object(activate, "_read_control_bytes", side_effect=self._read_control), \
             patch.object(activate, "bounded_capture") as shell:
            with self.assertRaises(activate.ControlOutcomeUnknown):
                self._finalize()
        shell.assert_not_called()

    def test_active_receipt_and_current_drift_prevent_finalizer_cas(self):
        paths = (
            self.root / "active",
            self.attempt / "receipt.json",
            self.root / "activation/current.json",
        )
        for path in paths:
            with self.subTest(path=path.name):
                original = path.read_bytes()
                path.write_bytes(b"foreign\n")
                with patch("docker_volume_activation_reconcile._probe_helper_absence", return_value={"state": "absent"}), \
                     patch.object(activate, "_read_control_bytes", side_effect=self._read_control), \
                     patch.object(activate, "bounded_capture") as shell:
                    with self.assertRaises(activate.ControlOutcomeUnknown):
                        self._finalize()
                shell.assert_not_called()
                path.write_bytes(original)

    def test_cas_rechecks_current_after_observation_before_any_publication(self):
        script = activate._retirement_cas_script(
            operation_id=self.operation, active_raw=self.operation.encode() + b"\n",
            receipt_raw=self.receipt_raw, result_raw=self.result_raw,
            terminal_raw=self.terminal_raw, current_raw=self.terminal_raw,
            expected_current_raw=self.previous_raw)
        (self.root / "activation/current.json").write_bytes(b"changed after observation")
        completed = subprocess.run(["bash", "-c", script.replace("/control", str(self.root))],
                                   capture_output=True, timeout=5)
        self.assertNotEqual(completed.returncode, 0)
        self.assertFalse((self.attempt / "result.json").exists())
        self.assertFalse((self.attempt / "terminal.json").exists())
        self.assertTrue((self.root / "active").exists())

    def test_wait_release_accepts_only_single_lf_while_logger_exits(self):
        reads = [self.operation.encode("ascii") + b"\n", None]
        with patch.object(activate, "_read_control_bytes", side_effect=reads), \
             patch.object(activate.time, "sleep"):
            self.assertTrue(
                activate._wait_retirement_lease_release(
                    self.control, operation_id=self.operation, timeout=1
                )
            )


@unittest.skipUnless(fcntl is not None and all(shutil.which(tool) for tool in ("bash", "flock", "sync", "sha256sum")), "requires Linux shell CAS tools")
class RetirementCasTests(unittest.TestCase):
    operation = "b" * 32

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "control"
        self.attempt = self.root / "activation/attempts" / self.operation
        self.attempt.mkdir(parents=True)
        self.payloads = {"active_raw": self.operation.encode(), "receipt_raw": b'{"state":"unknown"}',
                         "result_raw": b'{"state":"retired"}', "terminal_raw": b'{"state":"succeeded"}',
                         "current_raw": b'{"state":"succeeded"}'}
        (self.root / "active").write_bytes(self.payloads["active_raw"])
        (self.attempt / "receipt.json").write_bytes(self.payloads["receipt_raw"])

    def run_cas(self):
        script = activate._retirement_cas_script(operation_id=self.operation, **self.payloads)
        # Only this fixture remaps the production constant into an isolated temp root.
        script = script.replace("/control", str(self.root))
        return subprocess.run(["bash", "-c", script], capture_output=True, timeout=5)

    def assert_complete(self):
        for name in ("result", "terminal"):
            self.assertEqual((self.attempt / (name + ".json")).read_bytes(), self.payloads[name + "_raw"])
        self.assertEqual((self.root / "activation/current.json").read_bytes(), self.payloads["current_raw"])
        self.assertFalse((self.root / "active").exists())

    def test_cas_cannot_pin_and_release_another_operations_active_lease(self):
        foreign = dict(self.payloads, active_raw=b"c" * 32)
        with self.assertRaises(activate.BuildControlError):
            activate._retirement_cas_script(operation_id=self.operation, **foreign)
        self.assertEqual((self.root / "active").read_bytes(), self.payloads["active_raw"])
        self.assertFalse((self.attempt / "terminal.json").exists())

    def test_publish_and_exact_replay(self):
        first = self.run_cas()
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertIn(b"FINALIZED\n", first.stdout)
        self.assert_complete()
        replay = self.run_cas()
        self.assertEqual(replay.returncode, 0, replay.stderr)
        self.assertIn(b"ALREADY_FINALIZED\n", replay.stdout)

    def test_namespaced_cas_requires_registry_lock_and_digest(self):
        with self.assertRaises(activate.BuildControlError):
            activate._retirement_cas_script(
                operation_id=self.operation,
                namespace_registry_sha256="invalid",
                **self.payloads,
            )

        registry = Path(self.temp.name) / "registry"
        (registry / "namespaces").mkdir(parents=True)
        registry_bytes = b'{"schema":"fullmag.namespace-registry.v1"}\n'
        (registry / "namespaces" / "current.json").write_bytes(registry_bytes)
        control_lock = self.root / "operation.lock"
        control_lock.touch()
        os.link(control_lock, registry / "operation.lock")
        digest = hashlib.sha256(registry_bytes).hexdigest()
        script = activate._retirement_cas_script(
            operation_id=self.operation,
            namespace_registry_sha256=digest,
            **self.payloads,
        )
        script = script.replace("/control", str(self.root)).replace("/registry", str(registry))
        result = subprocess.run(["bash", "-c", script], capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_complete()

    def test_namespaced_cas_rejects_foreign_registry_lock(self):
        registry = Path(self.temp.name) / "registry"
        (registry / "namespaces").mkdir(parents=True)
        registry_bytes = b'{"schema":"fullmag.namespace-registry.v1"}\n'
        (registry / "namespaces" / "current.json").write_bytes(registry_bytes)
        (self.root / "operation.lock").touch()
        (registry / "operation.lock").touch()
        digest = hashlib.sha256(registry_bytes).hexdigest()
        script = activate._retirement_cas_script(
            operation_id=self.operation,
            namespace_registry_sha256=digest,
            **self.payloads,
        )
        script = script.replace("/control", str(self.root)).replace("/registry", str(registry))
        result = subprocess.run(["bash", "-c", script], capture_output=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.root / "active").exists())
        self.assertFalse((self.attempt / "terminal.json").exists())

    def test_namespaced_cas_rejects_registry_digest_drift(self):
        registry = Path(self.temp.name) / "registry"
        (registry / "namespaces").mkdir(parents=True)
        expected_registry_bytes = b'{"schema":"fullmag.namespace-registry.v1"}\n'
        (registry / "namespaces" / "current.json").write_bytes(b"drift\n")
        control_lock = self.root / "operation.lock"
        control_lock.touch()
        os.link(control_lock, registry / "operation.lock")
        digest = hashlib.sha256(expected_registry_bytes).hexdigest()
        script = activate._retirement_cas_script(
            operation_id=self.operation,
            namespace_registry_sha256=digest,
            **self.payloads,
        )
        script = script.replace("/control", str(self.root)).replace("/registry", str(registry))
        result = subprocess.run(["bash", "-c", script], capture_output=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.root / "active").exists())
        self.assertFalse((self.attempt / "terminal.json").exists())

    def test_partial_records_resume_before_terminal(self):
        (self.attempt / "result.json").write_bytes(self.payloads["result_raw"])
        (self.root / "activation/current.json").write_bytes(self.payloads["current_raw"])
        result = self.run_cas()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_complete()

    def test_active_or_receipt_drift_prevents_publication(self):
        for path in (self.root / "active", self.attempt / "receipt.json"):
            original = path.read_bytes()
            path.write_bytes(b"foreign")
            self.assertNotEqual(self.run_cas().returncode, 0)
            self.assertFalse((self.attempt / "terminal.json").exists())
            path.write_bytes(original)

    def test_conflicting_current_keeps_active_and_never_publishes_terminal(self):
        current = self.root / "activation/current.json"
        current.write_bytes(b"foreign")
        self.assertNotEqual(self.run_cas().returncode, 0)
        self.assertEqual(current.read_bytes(), b"foreign")
        self.assertTrue((self.root / "active").exists())
        self.assertFalse((self.attempt / "terminal.json").exists())

    def test_lock_contention_preserves_active(self):
        with (self.root / "operation.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertNotEqual(self.run_cas().returncode, 0)
        self.assertTrue((self.root / "active").exists())
        self.assertFalse((self.attempt / "result.json").exists())

    def test_dangling_active_symlink_is_never_finalized(self):
        self.assertEqual(self.run_cas().returncode, 0)
        (self.root / "active").symlink_to(self.root / "absent")
        self.assertNotEqual(self.run_cas().returncode, 0)
        self.assertTrue((self.root / "active").is_symlink())

    def test_hardlinked_final_record_is_not_accepted_as_replay(self):
        self.assertEqual(self.run_cas().returncode, 0)
        os.link(self.attempt / "terminal.json", self.root / "foreign-terminal")
        self.assertNotEqual(self.run_cas().returncode, 0)


if __name__ == "__main__":
    unittest.main()
