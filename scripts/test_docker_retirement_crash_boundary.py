"""Regression checks for retained retirement recovery after a host crash."""
from __future__ import annotations

import importlib.util
import hashlib
import json
from contextlib import contextmanager
from pathlib import Path
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
WORKTREE_SCRIPTS = Path(
    "/mnt/c/git/fullmag/worktrees/docker-volume-only-implementation-20261018/scripts"
)
sys.path.insert(0, str(ROOT / "scripts"))
if WORKTREE_SCRIPTS.is_dir():
    sys.path.insert(1, str(WORKTREE_SCRIPTS))


SPEC = importlib.util.spec_from_file_location(
    "retirement_crashboundary_activation",
    ROOT / "scripts/docker_volume_activate.py",
)
assert SPEC is not None and SPEC.loader is not None
activate = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = activate
SPEC.loader.exec_module(activate)


OPERATION_ID = "a" * 32
HELPER_SHA256 = "c" * 64
INPUTS_SHA256 = "d" * 64
RECEIPT_RAW = b'{"retained":true}\n'


def _receipt() -> dict[str, object]:
    return {
        "schema": activate.OPERATION_SCHEMA,
        "phase": "activation",
        "state": "outcome-unknown-resources-retained",
        "attempt": OPERATION_ID,
        "helper_sha256": HELPER_SHA256,
    }


def _missing_context() -> dict[str, object]:
    return {
        "operation_id": OPERATION_ID,
        "helper_sha256": HELPER_SHA256,
        "inputs_sha256": INPUTS_SHA256,
        "bindings": {},
        "phase": "retirement",
        "missing_retirement": True,
    }


def _retired_response() -> dict[str, object]:
    return {
        "state": "retirement-only",
        "retirement": {
            "state": "retired",
            "operation_id": OPERATION_ID,
            "session_id": "session-1",
            "run_id": "run-1",
            "request_scope_epoch": "api:7",
            "api_request_scope_epoch": "api:7",
            "archive_sha256": "e" * 64,
            "marker_sha256": "f" * 64,
        },
    }


def _pending_evidence() -> dict[str, object]:
    return {
        "state": "pending",
        "operation_id": OPERATION_ID,
        "session_id": "session-1",
        "run_id": "run-1",
        "request_scope_epoch": "api:7",
        "api_request_scope_epoch": "api:7",
        "marker_sha256": "f" * 64,
    }


def _partial_terminal_case(state: str) -> tuple[dict[str, object], bytes, bytes, bytes, bytes]:
    inputs = {
        "development_attempt": "b" * 32,
        "config_sha256": "c" * 64,
        "source_root": "C:/git/fullmag",
        "image_id": "sha256:" + "d" * 64,
        "backend_container": "e" * 64,
        "source_relative": "examples/model.py",
        "source_sha256": "1" * 64,
        "request_id": "request-1",
        "provenance_sha256": "0" * 64,
        "activation_receipt_key": "19f1064b619d49d35392eac7261cd7266c720671fc594f4b226f32bf0bee74ba",
        "activation_receipt_path": "/opt/fullmag/control/backend/script-activation-19f1064b619d49d35392eac7261cd7266c720671fc594f4b226f32bf0bee74ba/activation.json",
    }
    provenance = {
        "request_id": inputs["request_id"],
        "source_sha256": inputs["source_sha256"],
        "source_relative": inputs["source_relative"],
        "container_script_path": "/opt/fullmag/source/" + inputs["source_relative"],
    }
    provenance_raw = json.dumps(provenance, sort_keys=True, separators=(",", ":")).encode("utf-8")
    inputs["provenance_sha256"] = hashlib.sha256(provenance_raw).hexdigest()
    receipt = {
        "schema": activate.OPERATION_SCHEMA,
        "phase": "activation",
        "state": "outcome-unknown-resources-retained",
        "attempt": OPERATION_ID,
        "helper_container": "fullmag-control-" + OPERATION_ID,
        "helper_sha256": HELPER_SHA256,
        "inputs": inputs,
        "retirement_inputs_sha256": activate._retirement_inputs_sha256(inputs),
        "retirement_phase": "retirement",
    }
    retirement = _retired_response()["retirement"]
    if state == "rejected":
        retirement = dict(_pending_evidence(), state="rejected")
    terminal = dict(receipt)
    terminal.update(
        state="failed-confirmed",
        activation_state=(
            "retirement-refused-recovered" if state == "rejected" else "retirement-replayed"
        ),
        retirement=retirement,
        retirement_resume_state=("refused" if state == "rejected" else "succeeded"),
    )
    receipt_raw = json.dumps(receipt, sort_keys=True, separators=(",", ":")).encode("utf-8") + b"\n"
    terminal_raw = json.dumps(terminal, sort_keys=True, separators=(",", ":")).encode("utf-8") + b"\n"
    result_raw = json.dumps(
        {"state": "retirement-only", "retirement": retirement},
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8") + b"\n"
    return receipt, receipt_raw, provenance_raw, terminal_raw, result_raw


class CrashBoundaryTests(unittest.TestCase):
    def test_retained_context_rejects_noncanonical_lease_before_receipt_read(self):
        token = OPERATION_ID.encode("ascii")
        for raw in (b" " + token, token + b" ", token + b"\r\n", token + b"\n\n"):
            with self.subTest(raw=raw), patch.object(activate, "_read_control_bytes", return_value=raw) as read:
                with self.assertRaisesRegex(activate.BuildControlError, "identity is invalid"):
                    activate._retained_retirement_context(
                        SimpleNamespace(), development_attempt="b" * 32,
                        config_sha256="c" * 64, source_root="/source", image_id="sha256:" + "d" * 64,
                        backend_id="e" * 64)
                self.assertEqual(read.call_count, 1)

    @contextmanager
    def _resume(self, *, run, finalize=None):
        if finalize is None:
            finalize = lambda *args, **kwargs: None
        with patch.object(activate, "_run_fixed_activation", side_effect=run) as runner:
            with patch.object(activate, "_finalize_retained_retirement", side_effect=finalize) as finalizer:
                yield runner, finalizer

    def test_host_crash_after_unknown_75_retries_same_intent_only(self):
        """A lost host write after exit 75 must retain the lease, then replay the marker."""
        unknown = activate.ControlOutcomeUnknown("retirement outcome is unknown")
        unknown.retirement = _pending_evidence()
        calls = [unknown, _retired_response()]
        finalizations = []

        def finalize(*args, **kwargs):
            finalizations.append(kwargs)

        with self._resume(run=calls, finalize=finalize) as (runner, _finalizer):
            with self.assertRaises(activate.ControlOutcomeUnknown):
                activate._resume_retained_retirement(
                    object(), backend_id="b" * 64, operation_id=OPERATION_ID,
                    context=_missing_context(), receipt=_receipt(), receipt_raw=RECEIPT_RAW,
                    helper_sha256=HELPER_SHA256, activation_timeout_seconds=1,
                )
            with patch.object(
                activate, "_read_control_bytes",
                side_effect=[OPERATION_ID.encode("ascii"), RECEIPT_RAW],
            ):
                activate._resume_retained_retirement(
                    object(), backend_id="b" * 64, operation_id=OPERATION_ID,
                    context=_missing_context(), receipt=_receipt(), receipt_raw=RECEIPT_RAW,
                    helper_sha256=HELPER_SHA256, activation_timeout_seconds=1,
                )

        self.assertEqual(runner.call_count, 2)
        for call in runner.call_args_list:
            self.assertTrue(call.kwargs["retirement_only"])
            self.assertTrue(call.kwargs["retirement_require_existing_intent"])
            self.assertIsNone(call.kwargs["retirement_identity"])
            self.assertIsNone(call.kwargs["retirement_predecessor"])
        self.assertEqual(len(finalizations), 1)

    def test_retained_retirement_accepts_producer_active_lease_newline(self):
        """The active lease producer writes the exact token followed by one LF."""
        finalizations = []

        def finalize(*args, **kwargs):
            finalizations.append(kwargs)

        with self._resume(
            run=lambda *args, **kwargs: _retired_response(), finalize=finalize
        ):
            with patch.object(
                activate,
                "_read_control_bytes",
                side_effect=[OPERATION_ID.encode("ascii") + b"\n", RECEIPT_RAW],
            ):
                activate._resume_retained_retirement(
                    object(), backend_id="b" * 64, operation_id=OPERATION_ID,
                    context=_missing_context(), receipt=_receipt(), receipt_raw=RECEIPT_RAW,
                    helper_sha256=HELPER_SHA256, activation_timeout_seconds=1,
                )

        self.assertEqual(len(finalizations), 1)

    def test_retained_retirement_rejects_noncanonical_active_lease_bytes(self):
        """Only the exact token and its producer's single LF are valid leases."""
        token = OPERATION_ID.encode("ascii")
        invalid_active_values = (
            b" " + token,
            token + b" ",
            token + b"\n\n",
            token + b"\r\n",
            b"b" * 32 + b"\n",
        )

        for active in invalid_active_values:
            with self.subTest(active=active):
                with self._resume(run=lambda *args, **kwargs: _retired_response()) as (
                    _runner,
                    finalizer,
                ):
                    with patch.object(
                        activate,
                        "_read_control_bytes",
                        side_effect=[active, RECEIPT_RAW],
                    ):
                        with self.assertRaises(activate.ControlOutcomeUnknown):
                            activate._resume_retained_retirement(
                                object(), backend_id="b" * 64, operation_id=OPERATION_ID,
                                context=_missing_context(), receipt=_receipt(), receipt_raw=RECEIPT_RAW,
                                helper_sha256=HELPER_SHA256, activation_timeout_seconds=1,
                            )

                finalizer.assert_not_called()

    def test_host_crash_after_refusal_78_closes_confirmed_marker(self):
        """A durable rejected intent can close the retained operation without a POST."""
        evidence = dict(_pending_evidence(), state="rejected")
        refusal = {
            "schema": activate.RETIREMENT_REFUSAL_SCHEMA,
            "state": "refused",
            "operation_id": OPERATION_ID,
            "code": "live_retirement_runtime_not_terminal",
            "retirement": evidence,
        }
        error = activate.BuildControlError("known retirement refusal")
        error.retirement_refusal = refusal
        finalizations = []

        def finalize(*args, **kwargs):
            finalizations.append(kwargs)

        with self._resume(run=error, finalize=finalize) as (runner, _finalizer):
            with patch.object(
                activate, "_read_control_bytes",
                side_effect=[OPERATION_ID.encode("ascii"), RECEIPT_RAW],
            ):
                activate._resume_retained_retirement(
                    object(), backend_id="b" * 64, operation_id=OPERATION_ID,
                    context=_missing_context(), receipt=_receipt(), receipt_raw=RECEIPT_RAW,
                    helper_sha256=HELPER_SHA256, activation_timeout_seconds=1,
                )

        self.assertEqual(runner.call_count, 1)
        self.assertTrue(runner.call_args.kwargs["retirement_require_existing_intent"])
        self.assertEqual(len(finalizations), 1)
        terminal = finalizations[0]["terminal"]
        self.assertEqual(terminal["activation_state"], "retirement-refused-recovered")
        self.assertEqual(terminal["retirement"]["state"], "rejected")

    def test_missing_image_intent_stays_unknown_and_never_binds_foreign_workspace(self):
        """No marker is not evidence of no POST; the retained lease remains quarantined."""
        unknown = activate.ControlOutcomeUnknown("retained retirement has no image-owned intent")
        finalizations = []

        def finalize(*args, **kwargs):
            finalizations.append(kwargs)

        with self._resume(run=unknown, finalize=finalize) as (runner, _finalizer):
            with self.assertRaises(activate.ControlOutcomeUnknown):
                activate._resume_retained_retirement(
                    object(), backend_id="b" * 64, operation_id=OPERATION_ID,
                    context=_missing_context(), receipt=_receipt(), receipt_raw=RECEIPT_RAW,
                    helper_sha256=HELPER_SHA256, activation_timeout_seconds=1,
                )

        self.assertEqual(runner.call_count, 1)
        self.assertTrue(runner.call_args.kwargs["retirement_require_existing_intent"])
        self.assertEqual(finalizations, [])

    def test_retained_wrapper_sets_existing_intent_guard_on_unknown(self):
        diagnostic = {
            "schema": "fullmag.live-retirement-diagnostic.v1",
            "state": "unknown",
            "operation_id": OPERATION_ID,
            "phase": "retirement",
            "error": "transport lost",
            "retirement": _pending_evidence(),
        }
        docker_result = SimpleNamespace(
            returncode=activate.ACTIVATE_EXIT_UNKNOWN,
            stdout=json.dumps(diagnostic).encode("utf-8"),
            stderr=b"",
        )
        with patch.object(activate, "docker_capture", return_value=docker_result) as capture:
            with self.assertRaises(activate.ControlOutcomeUnknown) as caught:
                activate._run_fixed_activation(
                    "b" * 64,
                    script_path=None,
                    provenance_path=None,
                    provenance_sha256=None,
                    helper_sha256=HELPER_SHA256,
                    activation_timeout_seconds=1,
                    retirement_operation_id=OPERATION_ID,
                    retirement_inputs_sha256=INPUTS_SHA256,
                    retirement_require_existing_intent=True,
                    retirement_only=True,
                )
        self.assertEqual(caught.exception.retirement, _pending_evidence())
        command = capture.call_args.args
        self.assertIn("--env", command)
        self.assertIn("FULLMAG_RETIREMENT_REQUIRE_EXISTING_INTENT=1", command)

    def test_missing_host_receipt_context_keeps_all_immutable_pins(self):
        inputs = {
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
        }
        receipt = {
            "schema": activate.OPERATION_SCHEMA,
            "phase": "activation",
            "state": "outcome-unknown-resources-retained",
            "attempt": OPERATION_ID,
            "helper_container": "fullmag-control-" + OPERATION_ID,
            "helper_sha256": HELPER_SHA256,
            "inputs": inputs,
            "retirement_inputs_sha256": activate._retirement_inputs_sha256(inputs),
            "retirement_phase": "retirement",
        }
        _validated, context = activate._validate_retirement_receipt(
            receipt,
            operation_id=OPERATION_ID,
            development_attempt="b" * 32,
            config_sha256="c" * 64,
            source_root="C:/git/fullmag",
            image_id="sha256:" + "d" * 64,
            backend_id="e" * 64,
        )
        self.assertTrue(context["missing_retirement"])
        self.assertEqual(context["inputs_sha256"], receipt["retirement_inputs_sha256"])

    def test_partial_terminal_success_replays_records_without_api(self):
        receipt, receipt_raw, provenance_raw, terminal_raw, result_raw = _partial_terminal_case("retired")
        with patch.object(
            activate,
            "_read_control_bytes",
            side_effect=[OPERATION_ID.encode("ascii"), receipt_raw, provenance_raw, terminal_raw],
        ):
            retained = activate._retained_retirement_context(
                object(),
                development_attempt="b" * 32,
                config_sha256="c" * 64,
                source_root="C:/git/fullmag",
                image_id="sha256:" + "d" * 64,
                backend_id="e" * 64,
            )
        self.assertIsNotNone(retained)
        retained_receipt, context, retained_raw = retained
        self.assertTrue(context["missing_retirement"])
        self.assertEqual(retained_raw, receipt_raw)
        with patch.object(activate, "_run_fixed_activation") as runner, patch.object(
            activate, "_read_control_bytes", return_value=result_raw
        ), patch.object(activate, "_finalize_retained_retirement") as finalize:
            activate._resume_retained_retirement(
                object(), backend_id="e" * 64, operation_id=OPERATION_ID,
                context=context, receipt=retained_receipt, receipt_raw=receipt_raw,
                helper_sha256=HELPER_SHA256, activation_timeout_seconds=1,
            )
        runner.assert_not_called()
        finalize.assert_called_once()

    def test_partial_terminal_refusal_replays_records_without_api(self):
        receipt, receipt_raw, provenance_raw, terminal_raw, result_raw = _partial_terminal_case("rejected")
        with patch.object(
            activate,
            "_read_control_bytes",
            side_effect=[OPERATION_ID.encode("ascii"), receipt_raw, provenance_raw, terminal_raw],
        ):
            retained = activate._retained_retirement_context(
                object(),
                development_attempt="b" * 32,
                config_sha256="c" * 64,
                source_root="C:/git/fullmag",
                image_id="sha256:" + "d" * 64,
                backend_id="e" * 64,
            )
        self.assertIsNotNone(retained)
        retained_receipt, context, retained_raw = retained
        self.assertTrue(context["missing_retirement"])
        self.assertEqual(retained_raw, receipt_raw)
        with patch.object(activate, "_run_fixed_activation") as runner, patch.object(
            activate, "_read_control_bytes", return_value=result_raw
        ), patch.object(activate, "_finalize_retained_retirement") as finalize:
            activate._resume_retained_retirement(
                object(), backend_id="e" * 64, operation_id=OPERATION_ID,
                context=context, receipt=retained_receipt, receipt_raw=receipt_raw,
                helper_sha256=HELPER_SHA256, activation_timeout_seconds=1,
            )
        runner.assert_not_called()
        finalize.assert_called_once()


if __name__ == "__main__":
    unittest.main()
