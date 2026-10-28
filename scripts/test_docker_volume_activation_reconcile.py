"""Source regressions for the narrow unknown-activation quarantine route."""

from __future__ import annotations

import base64
import hashlib
import importlib
import os
from pathlib import Path
import subprocess
from subprocess import CompletedProcess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parent))
module = importlib.import_module("docker_volume_activation_reconcile")
cancelled_activation_guard = importlib.import_module("docker_volume_cancelled_activation_guard")
from docker_build_control import BuildControl, BuildControlError, canonical, control_read_script


PROJECT = "fullmag-worktree-demo"
VOLUME = "fullmag-worktree-demo-control"
ATTEMPT = "a" * 32
DEV_ATTEMPT = "b" * 32
CONFIG = "c" * 64
IMAGE = "sha256:" + "d" * 64
BACKEND = "e" * 64
HELPER = "f" * 64
JOURNAL = "1" * 64
SOURCE = "C:/git/fullmag"
REQUEST = "fdm:cpu-docker-20261019-2035"
KEY = "2" * 64


class Control:
    project = PROJECT
    volume = VOLUME
    namespace = ""
    namespace_registry = None
    namespace_registry_sha256 = None
    identity = {
        "project_name": PROJECT,
        "project_id": "fullmag-project",
        "worktree_id": "demo",
        "checkout_kind": "worktree",
    }

    def read_raw(self, relative, *, optional=False):
        if relative == "offline-reconciliation/current.json" and optional:
            return None
        raise AssertionError("Unexpected offline control read: " + relative)


def unresolved(**changes: object) -> dict[str, object]:
    value: dict[str, object] = {
        "schema": module.ACTIVATION_UNRESOLVED_SCHEMA,
        "state": module.UNKNOWN_STATE,
        "phase": "activation",
        "activation_outcome": module.UNKNOWN_STATE,
        "reason": module.UNKNOWN_REASON,
        "compose_project": PROJECT,
        "control_volume": VOLUME,
        "activation_attempt": ATTEMPT,
        "development_attempt": DEV_ATTEMPT,
        "config_sha256": CONFIG,
        "source_root": SOURCE,
        "image_id": IMAGE,
        "backend_container": BACKEND,
        "source_relative": "examples/model.py",
        "source_sha256": "3" * 64,
        "request_id": REQUEST,
        "provenance_sha256": "4" * 64,
        "activation_receipt_key": KEY,
        "activation_receipt_path": module._activation_marker_path(KEY),
        "activation_receipt_sha256": "5" * 64,
        "helper_container": "fullmag-control-" + ATTEMPT,
        "helper_id": HELPER,
        "helper_sha256": "6" * 64,
        "native_stop_journal_sha256": JOURNAL,
        "reconciliation_attempt": module._activation_reconciliation_token(ATTEMPT),
        "created_at": 1_729_000_000.0,
    }
    value.update(changes)
    return value


def reconciliation_receipt(*, state: str = "failed-confirmed") -> dict[str, object]:
    return {
        "schema": module.OPERATION_SCHEMA,
        "phase": "activation-reconciliation",
        "state": state,
        "attempt": module._activation_reconciliation_token(ATTEMPT),
        "compose_project": PROJECT,
        "control_volume": VOLUME,
        "reconciled_activation_attempt": ATTEMPT,
        "activation_outcome": module.UNKNOWN_STATE,
        "reason": module.UNKNOWN_REASON,
        "activation_receipt_sha256": "5" * 64,
        "backend_container": BACKEND,
        "image_id": IMAGE,
        "development_attempt": DEV_ATTEMPT,
        "config_sha256": CONFIG,
        "source_root": SOURCE,
        "native_stop_journal_sha256": JOURNAL,
    }


def _read_absent_cancelled_activation_recovery(
    _control: object,
    relative: str,
    *,
    optional: bool = False,
    **_kwargs: object,
) -> None:
    if relative != cancelled_activation_guard.RECORD or not optional:
        raise AssertionError("expected the optional cancelled-activation recovery record")
    return None


class UnknownActivationTests(unittest.TestCase):
    def test_control_read_authenticates_parent_chain_before_optional_absence(self) -> None:
        script = control_read_script("/control/activation/attempts/" + ATTEMPT + "/receipt.json")
        self.assertLess(script.index("check_parent /control"), script.index("check_parent /control/activation"))
        self.assertLess(script.index("check_parent /control/activation"), script.index("test ! -L /control/activation/attempts/" + ATTEMPT + "/receipt.json"))
        self.assertLess(
            script.index("test ! -L /control/activation/attempts/" + ATTEMPT + "/receipt.json"),
            script.index("test -e /control/activation/attempts/" + ATTEMPT + "/receipt.json || exit 44"),
        )
        with self.assertRaises(BuildControlError):
            control_read_script("/control/activation/../receipt.json")

    def test_reconciling_finalization_is_locked_and_replayable(self) -> None:
        script = module._reconciliation_finalization_script(
            activation_attempt=ATTEMPT,
            reconciliation_attempt=module._activation_reconciliation_token(ATTEMPT),
        )
        self.assertIn("exec 9>/control/operation.lock", script)
        self.assertIn("test ! -L /control/active", script)
        self.assertIn("test ! -e /control/active", script)
        self.assertIn("FULLMAG_FINAL_RECONCILING_SHA256", script)
        self.assertIn("FULLMAG_FINAL_RECEIPT_SHA256", script)
        self.assertIn("FULLMAG_FINAL_UNRESOLVED_REPLACE_SHA256", script)
        self.assertIn("FULLMAG_FINAL_ACTIVATION_TERMINAL_REPLACE_SHA256", script)
        self.assertIn("publish /control/activation/unresolved.json", script)
        self.assertIn("publish /control/activation/attempts/" + ATTEMPT + "/terminal.json", script)
        self.assertLess(script.index("flock -n 9"), script.index("publish /control/activation/unresolved.json"))
        self.assertNotIn("rm -f -- /control/active", script)
        source = Path(__file__).with_name("docker_volume_activation_reconcile.py").read_text(encoding="utf-8")
        live = source.index("helper_terminal = {")
        wait = source.index("_wait_for_helper_exit(helper_id)", live)
        finalize = source.index("_finalize_reconciling_without_active(", wait)
        self.assertIn('"helper_id": helper_id', source[live:wait])
        self.assertIn('"helper_state": "running"', source[live:wait])
        self.assertLess(wait, finalize)
        self.assertNotIn('control.write(reconciliation_root + "/terminal.json", final_receipt)', source[live:])

    def test_failed_receipt_alone_is_not_a_completed_reconciliation(self) -> None:
        source = Path(__file__).with_name("docker_volume_activation_reconcile.py").read_text(encoding="utf-8")
        self.assertIn('if sibling is None or sibling != final_raw:', source)
        self.assertIn('raise _fail("Terminal activation reconciliation is incomplete")', source)

    def test_quarantine_requires_exact_group_and_admission_fence(self) -> None:
        record = unresolved()
        expected = {
            "development_attempt": DEV_ATTEMPT,
            "config_sha256": CONFIG,
            "source_root": SOURCE,
            "image_id": IMAGE,
            "backend_container": BACKEND,
        }
        self.assertEqual(
            module._validate_unresolved_activation(Control(), record, expected=expected),
            record,
        )
        with self.assertRaises(BuildControlError):
            module._validate_unresolved_activation(
                Control(), record, expected={**expected, "source_root": "C:/other"}
            )
        # Only the unresolved activation exists; no preparation was aborted.
        def read_json(_control, relative, optional=False):
            return record if relative == "activation/unresolved.json" else None

        with patch.object(
            cancelled_activation_guard,
            "_read_control_bytes",
            side_effect=_read_absent_cancelled_activation_recovery,
        ), patch.object(module, "_read_json", side_effect=read_json):
            with self.assertRaisesRegex(BuildControlError, "unknown outcome"):
                module.assert_no_unresolved_activation(
                    Control(),
                    development_attempt=DEV_ATTEMPT,
                    config_sha256=CONFIG,
                    source_root=SOURCE,
                    image_id=IMAGE,
                    backend_container=BACKEND,
                )

    def test_malformed_or_foreign_quarantine_fails_closed(self) -> None:
        for changed in (
            {"schema": "foreign.v1"},
            {"state": "succeeded"},
            {"control_volume": "other-control"},
            {"activation_receipt_path": "/tmp/activation.json"},
            {"backend_container": "not-a-container"},
        ):
            with self.subTest(changed=changed), self.assertRaises(BuildControlError):
                module._validate_unresolved_activation(Control(), {**unresolved(), **changed})

    def test_absent_quarantine_requires_an_authenticated_absence_probe(self) -> None:
        absent = unresolved(
            helper_state="absent-confirmed",
            helper_id=None,
            helper_absence_probe_sha256="7" * 64,
        )
        self.assertEqual(module._validate_unresolved_activation(Control(), absent), absent)
        for changed in (
            {"helper_id": HELPER},
            {"helper_absence_probe_sha256": None},
            {"helper_state": "unknown"},
        ):
            with self.subTest(changed=changed), self.assertRaises(BuildControlError):
                module._validate_unresolved_activation(Control(), {**absent, **changed})

    def test_helper_absence_accepts_known_docker_diagnostics_with_exact_identity(self) -> None:
        helper = "fullmag-control-" + ATTEMPT
        expected = hashlib.sha256(canonical({
            "schema": "fullmag.docker-helper-absence-probe.v1", "state": "absent",
            "helper_name": helper, "containers": [],
        })).hexdigest()
        for diagnostic in (
                "error: no such object: ", "Error: No such object: ",
                "Error response from daemon: No such container: "):
            missing = CompletedProcess([], 1, b"[]\n", (diagnostic + helper + "\n").encode())
            empty = CompletedProcess([], 0, b"", b"")
            with self.subTest(diagnostic=diagnostic), patch.object(
                    module, "docker_capture", side_effect=[missing, empty]):
                self.assertEqual(module._probe_helper_absence(helper), expected)
        for diagnostic in ("error: no such object: other-helper", "permission denied"):
            failed = CompletedProcess([], 1, b"[]\n", diagnostic.encode())
            with self.subTest(diagnostic=diagnostic), patch.object(
                    module, "docker_capture", return_value=failed), self.assertRaises(BuildControlError):
                module._probe_helper_absence(helper)

    def test_helper_absence_probe_rejects_live_and_foreign_names(self) -> None:
        live = CompletedProcess([], 0, b"[]", b"")
        with patch.object(module, "docker_capture", return_value=live):
            self.assertIsNone(module._probe_helper_absence("fullmag-control-" + ATTEMPT))

        helper_name = "fullmag-control-" + ATTEMPT
        missing = CompletedProcess([], 1, b"", ("Error: No such object: " + helper_name).encode())
        foreign = CompletedProcess([], 0, (HELPER + "\n").encode(), b"")
        with patch.object(module, "docker_capture", side_effect=[missing, foreign]):
            with self.assertRaisesRegex(BuildControlError, "occupied"):
                module._probe_helper_absence(helper_name)

        daemon_error = CompletedProcess([], 2, b"", b"permission denied")
        with patch.object(module, "docker_capture", return_value=daemon_error):
            with self.assertRaisesRegex(BuildControlError, "absence could not"):
                module._probe_helper_absence(helper_name)

    def test_offline_unknown_activation_fences_new_activation_before_other_reads(self) -> None:
        with patch(
            "docker_volume_offline_reconcile.assert_activation_allowed",
            side_effect=BuildControlError("Original activation outcome remains unknown-retained"),
        ), patch.object(module, "_read_json") as later_read:
            with self.assertRaisesRegex(BuildControlError, "unknown-retained"):
                module.assert_no_unresolved_activation(Control(), request_id="new-request")
            later_read.assert_not_called()

    def test_no_quarantine_allows_guard_to_finish_without_docker(self) -> None:
        with patch.object(
            cancelled_activation_guard,
            "_read_control_bytes",
            side_effect=_read_absent_cancelled_activation_recovery,
        ), patch.object(module, "_read_json", return_value=None):
            module.assert_no_unresolved_activation(
                Control(),
                development_attempt=DEV_ATTEMPT,
                config_sha256=CONFIG,
                source_root=SOURCE,
                image_id=IMAGE,
                backend_container=BACKEND,
            )

    def test_activation_guard_is_before_startup_prepare_route(self) -> None:
        explicit = (Path(__file__).with_name("docker_volume_activate.py")).read_text(encoding="utf-8")
        self.assertLess(
            explicit.index("assert_no_unresolved_activation("),
            explicit.index("startup_helper, helper_hashes = _startup_helper("),
        )
        direct = (Path(__file__).with_name("docker_volume_dev.py")).read_text(encoding="utf-8")
        self.assertLess(
            direct.index("assert_no_unresolved_activation(control)"),
            direct.index("authorization = startup_helper.prepare("),
        )

    def test_absent_helper_dispatch_preserves_original_raw_receipt(self) -> None:
        document = {"name": PROJECT}
        config = hashlib.sha256(canonical(document)).hexdigest()
        journal = canonical({"schema": "fullmag.stop-failed-admission.v1",
                             "state": "stopped-confirmed", "container_id": BACKEND,
                             "image_id": IMAGE, "container_state": {}})
        terminal = b'{"state":"shutdown_unknown"}\n'
        original = b'{ "original": "receipt with exact bytes" }\n'
        native = {"journal_sha256": hashlib.sha256(journal).hexdigest(),
                  "terminal_process_receipt_sha256": hashlib.sha256(terminal).hexdigest()}

        def read(_control, relative, *, optional=False):
            if relative == "active":
                return (ATTEMPT + "\n").encode()
            if relative.startswith("verification/stop-failed-"):
                return journal
            if relative == "runtime-control/runtime-service/process-tree.json":
                return terminal
            if relative.startswith("verification/stopped-namespace-attestation-"):
                return None
            raise AssertionError(relative)

        expected = {"state": "failed-confirmed"}
        with patch.object(module, "_control_bytes", side_effect=read), \
                patch.object(module, "_read_json", return_value=None), \
                patch.object(module, "_validate_native_restart_metadata", return_value=native), \
                patch.object(module, "_validate_stopped_backend"), \
                patch.object(module, "_validate_activation_receipt", return_value=({}, original, {})), \
                patch.object(module, "_probe_helper_absence", return_value="7" * 64), \
                patch.object(module, "_reconcile_absent_helper", autospec=True, return_value=expected) as commit:
            result = module.reconcile_unknown_activation(
                Control(), previous={"attempt": DEV_ATTEMPT,
                    "inputs": {"source_root": SOURCE, "image_id": IMAGE}}, document=document,
                selected_source=SOURCE, config_sha256=config, image_id=IMAGE,
                backend_id=BACKEND, native_restart_metadata=native)
        self.assertIs(result, expected)
        self.assertEqual(commit.call_args.kwargs["receipt_raw"], original)

    def test_replay_of_completed_reconciliation_does_not_touch_helper(self) -> None:
        absence = "7" * 64
        record = unresolved(
            helper_state="absent-confirmed",
            helper_id=None,
            helper_absence_probe_sha256=absence,
        )
        receipt = reconciliation_receipt()
        receipt.update(
            helper_container="fullmag-control-" + ATTEMPT,
            helper_id=None,
            helper_state="absent-confirmed",
            helper_absence_probe_sha256=absence,
        )
        receipt_raw = module.canonical(receipt) + b"\n"
        activation_terminal = {
            "helper_state": "absent-confirmed",
            "helper_id": None,
            "helper_absence_probe_sha256": absence,
        }
        activation_terminal_raw = module.canonical(activation_terminal) + b"\n"

        def control_bytes(_control, relative, *, optional=False):
            if relative == "active":
                return None
            if relative == "activation/attempts/" + ATTEMPT + "/terminal.json":
                return activation_terminal_raw
            if relative.endswith("/receipt.json") or relative.endswith("/terminal.json") \
                    or relative == "activation-reconciliation/current.json":
                return receipt_raw
            raise AssertionError(relative)

        with patch.object(module, "_control_bytes", side_effect=control_bytes), \
                patch.object(module, "_read_json", side_effect=[record, receipt, activation_terminal]), \
                patch.object(module, "docker_capture") as docker:
            result = module.reconcile_unknown_activation(
                Control(),
                previous={},
                document={},
                selected_source=SOURCE,
                config_sha256=CONFIG,
                image_id=IMAGE,
                backend_id=BACKEND,
                native_restart_metadata=None,
            )
        self.assertEqual(result, receipt)
        docker.assert_not_called()

    def test_incomplete_quarantine_cannot_be_treated_as_reconciled(self) -> None:
        record = unresolved()
        with patch.object(module, "_control_bytes", return_value=None), \
                patch.object(module, "_read_json", side_effect=[record, None]):
            with self.assertRaisesRegex(BuildControlError, "without a completed reconciliation"):
                module.reconcile_unknown_activation(
                    Control(),
                    previous={},
                    document={},
                    selected_source=SOURCE,
                    config_sha256=CONFIG,
                    image_id=IMAGE,
                    backend_id=BACKEND,
                    native_restart_metadata=None,
                )

    def test_lease_protocol_is_single_sourced_for_recovery_authentication(self) -> None:
        control = object.__new__(BuildControl)
        control.namespace = ""
        control.namespace_registry = None
        control.namespace_registry_sha256 = None
        script = control.operation_script("activation", ATTEMPT)
        self.assertIn("printf 'READY\\n'", script)
        self.assertIn("printf 'LOGGED\\n'", script)
        self.assertIn("until test -f '/control/activation/attempts/" + ATTEMPT + "/terminal.json'", script)
        self.assertIn("rm /control/active", script)

    def test_absent_reconciliation_uses_locked_cas_and_fails_closed(self) -> None:
        script = module._reconciliation_helper_script(
            activation_attempt=ATTEMPT,
            reconciliation_attempt=module._activation_reconciliation_token(ATTEMPT),
            backend_id=BACKEND,
        )
        self.assertIn("exec 9>/control/operation.lock", script)
        self.assertIn("flock -n 9", script)
        self.assertIn("FULLMAG_RECON_ACTIVE_SHA256", script)
        self.assertIn("FULLMAG_RECON_OLD_RECEIPT_SHA256", script)
        self.assertIn("FULLMAG_RECON_RECEIPT_SHA256", script)
        self.assertLess(script.index("exact_active"), script.index("rm -f -- /control/active"))
        self.assertIn("FULLMAG_RECON_ACTIVATION_TERMINAL_SHA256", script)
        self.assertIn("FULLMAG_RECON_ACTIVATION_TERMINAL_REPLACE_SHA256", script)
        self.assertIn("printf 'RECONCILED\\n'", script)

    def test_reconciliation_helper_failure_is_not_treated_as_commit(self) -> None:
        class HelperControl(Control):
            def helper_args(self, script: str, *, name: str):
                return ["docker", "--entrypoint", "/bin/bash", "helper", "-c", script]

        with patch.object(
            module,
            "bounded_capture",
            return_value=CompletedProcess([], 1, b"", b"flock unavailable or active CAS changed"),
        ):
            with self.assertRaisesRegex(BuildControlError, "did not commit"):
                module._run_absent_helper_reconciliation(
                    HelperControl(),
                    activation_attempt=ATTEMPT,
                    reconciliation_attempt=module._activation_reconciliation_token(ATTEMPT),
                    backend_id=BACKEND,
                    stop_journal_sha256=JOURNAL,
                    terminal_process_sha256="8" * 64,
                    active_raw=(ATTEMPT + "\n").encode(),
                    receipt_raw=b"receipt",
                    unresolved_raw=b"",
                    unresolved_payload=b"{}\n",
                    reconciliation_payload=b"{}\n",
                    reconciliation_replace_sha256="",
                    reconciliation_terminal_payload=b"{}\n",
                    reconciliation_current_payload=b"{}\n",
                    activation_terminal_payload=b"{}\n",
                )

    def test_generated_reconciliation_transaction_commits_and_rejects_changed_active(self) -> None:
        reconciliation_attempt = module._activation_reconciliation_token(ATTEMPT)
        old_receipt = b'{"state":"outcome-unknown-resources-retained"}\n'
        stop_journal = b'{"state":"stopped-confirmed"}\n'
        terminal_process = b'{"state":"shutdown_unknown"}\n'
        unresolved = b'{"state":"unknown-retained"}\n'
        reconciliation = b'{"state":"failed-confirmed"}\n'
        activation_terminal = b'{"state":"failed-confirmed","technical":true}\n'
        script = module._reconciliation_helper_script(
            activation_attempt=ATTEMPT,
            reconciliation_attempt=reconciliation_attempt,
            backend_id=BACKEND,
        )
        tmp_parent = os.environ.get("TMPDIR")
        if not tmp_parent or not Path(tmp_parent).is_dir():
            tmp_parent = None
        with tempfile.TemporaryDirectory(dir=tmp_parent) as temporary:
            control_root = Path(temporary) / "control"
            receipt_path = control_root / "activation" / "attempts" / ATTEMPT / "receipt.json"
            receipt_path.parent.mkdir(parents=True)
            (control_root / "active").parent.mkdir(parents=True, exist_ok=True)
            (control_root / "active").write_bytes((ATTEMPT + "\n").encode())
            receipt_path.write_bytes(old_receipt)
            stop_path = control_root / "verification" / ("stop-failed-" + BACKEND + ".json")
            stop_path.parent.mkdir(parents=True)
            stop_path.write_bytes(stop_journal)
            terminal_path = control_root / "runtime-control" / "runtime-service" / "process-tree.json"
            terminal_path.parent.mkdir(parents=True)
            terminal_path.write_bytes(terminal_process)
            rendered = script.replace("/control", str(control_root))
            environment = {
                **os.environ,
                "FULLMAG_RECON_ACTIVE_TOKEN": ATTEMPT,
                "FULLMAG_RECON_ACTIVE_SHA256": module.hashlib.sha256((ATTEMPT + "\n").encode()).hexdigest(),
                "FULLMAG_RECON_OLD_RECEIPT_SHA256": module.hashlib.sha256(old_receipt).hexdigest(),
                "FULLMAG_RECON_STOP_JOURNAL_SHA256": module.hashlib.sha256(stop_journal).hexdigest(),
                "FULLMAG_RECON_TERMINAL_PROCESS_SHA256": module.hashlib.sha256(terminal_process).hexdigest(),
                "FULLMAG_RECON_UNRESOLVED_B64": base64.b64encode(unresolved).decode(),
                "FULLMAG_RECON_UNRESOLVED_SHA256": module.hashlib.sha256(unresolved).hexdigest(),
                "FULLMAG_RECON_UNRESOLVED_REPLACE_SHA256": module.hashlib.sha256(b"").hexdigest(),
                "FULLMAG_RECON_RECEIPT_B64": base64.b64encode(reconciliation).decode(),
                "FULLMAG_RECON_RECEIPT_SHA256": module.hashlib.sha256(reconciliation).hexdigest(),
                "FULLMAG_RECON_RECEIPT_REPLACE_SHA256": "",
                "FULLMAG_RECON_TERMINAL_B64": base64.b64encode(reconciliation).decode(),
                "FULLMAG_RECON_TERMINAL_SHA256": module.hashlib.sha256(reconciliation).hexdigest(),
                "FULLMAG_RECON_CURRENT_B64": base64.b64encode(reconciliation).decode(),
                "FULLMAG_RECON_CURRENT_SHA256": module.hashlib.sha256(reconciliation).hexdigest(),
                "FULLMAG_RECON_ACTIVATION_TERMINAL_B64": base64.b64encode(activation_terminal).decode(),
                "FULLMAG_RECON_ACTIVATION_TERMINAL_SHA256": module.hashlib.sha256(activation_terminal).hexdigest(),
                "FULLMAG_RECON_ACTIVATION_TERMINAL_REPLACE_SHA256": "",
            }
            completed = subprocess.run(
                ["bash", "-euc", rendered], env=environment,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr.decode())
            self.assertFalse((control_root / "active").exists())
            self.assertEqual(
                (control_root / "activation-reconciliation" / "current.json").read_bytes(),
                reconciliation,
            )

            # A crash after publishing the technical terminal but before the
            # final unlink is replayable: the exact terminal is accepted.
            (control_root / "active").write_bytes((ATTEMPT + "\n").encode())
            replayed = subprocess.run(
                ["bash", "-euc", rendered], env=environment,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
            )
            self.assertEqual(replayed.returncode, 0, replayed.stderr.decode())
            self.assertFalse((control_root / "active").exists())

            # A changed active token is rejected by the same generated
            # protocol; the marker remains retained for controlled recovery.
            (control_root / "active").write_bytes(("f" * 32 + "\n").encode())
            rejected = subprocess.run(
                ["bash", "-euc", rendered], env=environment,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
            )
            self.assertNotEqual(rejected.returncode, 0)
            self.assertTrue((control_root / "active").exists())

    def test_generated_finalization_transaction_commits_and_replays(self) -> None:
        """Exercise the live-helper final CAS transaction on private control data."""
        reconciliation_attempt = module._activation_reconciliation_token(ATTEMPT)
        old_unresolved = b'{"helper_state":"running"}\n'
        final_unresolved = b'{"helper_id":null,"helper_state":"absent-confirmed"}\n'
        activation_receipt = b'{"state":"outcome-unknown-resources-retained"}\n'
        old_activation_terminal = b'{"helper_id":"' + HELPER.encode() + b'","helper_state":"running"}\n'
        final_activation_terminal = b'{"helper_id":null,"helper_state":"absent-confirmed"}\n'
        old_reconciliation = b'{"state":"reconciling","helper_state":"running"}\n'
        final_reconciliation = b'{"state":"failed-confirmed","helper_id":null,"helper_state":"absent-confirmed"}\n'
        script = module._reconciliation_finalization_script(
            activation_attempt=ATTEMPT,
            reconciliation_attempt=reconciliation_attempt,
        )
        tmp_parent = os.environ.get("TMPDIR")
        if not tmp_parent or not Path(tmp_parent).is_dir():
            tmp_parent = None
        with tempfile.TemporaryDirectory(dir=tmp_parent) as temporary:
            control_root = Path(temporary) / "control"
            unresolved_path = control_root / "activation" / "unresolved.json"
            activation_root = control_root / "activation" / "attempts" / ATTEMPT
            reconciliation_root = control_root / "activation-reconciliation" / "attempts" / reconciliation_attempt
            activation_root.mkdir(parents=True)
            reconciliation_root.mkdir(parents=True)
            unresolved_path.write_bytes(old_unresolved)
            (activation_root / "receipt.json").write_bytes(activation_receipt)
            (activation_root / "terminal.json").write_bytes(old_activation_terminal)
            (reconciliation_root / "receipt.json").write_bytes(old_reconciliation)
            rendered = script.replace("/control", str(control_root))
            environment = {
                **os.environ,
                "FULLMAG_FINAL_UNRESOLVED_B64": base64.b64encode(final_unresolved).decode(),
                "FULLMAG_FINAL_UNRESOLVED_SHA256": module.hashlib.sha256(final_unresolved).hexdigest(),
                "FULLMAG_FINAL_UNRESOLVED_REPLACE_SHA256": module.hashlib.sha256(old_unresolved).hexdigest(),
                "FULLMAG_FINAL_ACTIVATION_RECEIPT_SHA256": module.hashlib.sha256(activation_receipt).hexdigest(),
                "FULLMAG_FINAL_ACTIVATION_TERMINAL_B64": base64.b64encode(final_activation_terminal).decode(),
                "FULLMAG_FINAL_ACTIVATION_TERMINAL_SHA256": module.hashlib.sha256(final_activation_terminal).hexdigest(),
                "FULLMAG_FINAL_ACTIVATION_TERMINAL_REPLACE_SHA256": module.hashlib.sha256(old_activation_terminal).hexdigest(),
                "FULLMAG_FINAL_RECONCILING_SHA256": module.hashlib.sha256(old_reconciliation).hexdigest(),
                "FULLMAG_FINAL_RECEIPT_B64": base64.b64encode(final_reconciliation).decode(),
                "FULLMAG_FINAL_RECEIPT_SHA256": module.hashlib.sha256(final_reconciliation).hexdigest(),
                "FULLMAG_FINAL_TERMINAL_B64": base64.b64encode(final_reconciliation).decode(),
                "FULLMAG_FINAL_TERMINAL_SHA256": module.hashlib.sha256(final_reconciliation).hexdigest(),
                "FULLMAG_FINAL_CURRENT_B64": base64.b64encode(final_reconciliation).decode(),
                "FULLMAG_FINAL_CURRENT_SHA256": module.hashlib.sha256(final_reconciliation).hexdigest(),
            }
            completed = subprocess.run(
                ["bash", "-euc", rendered], env=environment,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr.decode())
            self.assertEqual(unresolved_path.read_bytes(), final_unresolved)
            self.assertEqual((activation_root / "terminal.json").read_bytes(), final_activation_terminal)
            self.assertEqual((reconciliation_root / "receipt.json").read_bytes(), final_reconciliation)
            self.assertEqual((reconciliation_root / "terminal.json").read_bytes(), final_reconciliation)
            self.assertEqual(
                (control_root / "activation-reconciliation" / "current.json").read_bytes(),
                final_reconciliation,
            )

            replayed = subprocess.run(
                ["bash", "-euc", rendered], env=environment,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
            )
            self.assertEqual(replayed.returncode, 0, replayed.stderr.decode())

    def test_generated_namespace_attestation_is_idempotent_and_respects_held_lock(self) -> None:
        """Exercise the image-owned sidecar CAS without touching real control data."""
        script = module._namespace_attestation_script(backend_id=BACKEND)
        self.assertIn("stopped-namespace-attestation-" + BACKEND + ".json.lock", script)
        self.assertNotIn("exec 9>/control/operation.lock", script)
        journal = b'{"state":"stopped-confirmed"}\n'
        terminal = b'{"state":"shutdown_unknown"}\n'
        owner = b'{"state":"failed"}\n'
        attestation = b'{"schema":"fullmag.docker-stopped-namespace-attestation.v1"}\n'
        tmp_parent = os.environ.get("TMPDIR")
        if not tmp_parent or not Path(tmp_parent).is_dir():
            tmp_parent = None
        with tempfile.TemporaryDirectory(dir=tmp_parent) as temporary:
            control_root = Path(temporary) / "control"
            verification = control_root / "verification"
            (control_root / "runtime-control" / "runtime-service").mkdir(parents=True)
            (control_root / "runtime-control" / "runtime-services").mkdir(parents=True)
            verification.mkdir(parents=True)
            journal_path = verification / ("stop-failed-" + BACKEND + ".json")
            terminal_path = control_root / "runtime-control" / "runtime-service" / "process-tree.json"
            owner_path = control_root / "runtime-control" / "runtime-services" / "OWNER.json"
            journal_path.write_bytes(journal)
            terminal_path.write_bytes(terminal)
            owner_path.write_bytes(owner)
            rendered = script.replace("/control", str(control_root))
            environment = {
                **os.environ,
                "FULLMAG_NS_JOURNAL_SHA256": module.hashlib.sha256(journal).hexdigest(),
                "FULLMAG_NS_TERMINAL_SHA256": module.hashlib.sha256(terminal).hexdigest(),
                "FULLMAG_NS_OWNER_SHA256": module.hashlib.sha256(owner).hexdigest(),
                "FULLMAG_NS_ATTESTATION_B64": base64.b64encode(attestation).decode(),
                "FULLMAG_NS_ATTESTATION_SHA256": module.hashlib.sha256(attestation).hexdigest(),
            }
            lock_path = control_root / "operation.lock"
            ready_path = control_root / "holder.ready"
            holder_script = (
                f"exec 9>{module.shlex.quote(str(lock_path))}; "
                f"flock -n 9; : > {module.shlex.quote(str(ready_path))}; sleep 10"
            )
            holder = subprocess.Popen(["bash", "-euc", holder_script])
            try:
                for _ in range(100):
                    if ready_path.exists():
                        break
                    time.sleep(0.01)
                self.assertTrue(ready_path.exists(), "lock holder did not acquire the private lock")
                observed = subprocess.run(
                    ["bash", "-euc", rendered], env=environment,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
                )
                self.assertEqual(observed.returncode, 0, observed.stderr.decode())
                target = verification / ("stopped-namespace-attestation-" + BACKEND + ".json")
                self.assertEqual(target.read_bytes(), attestation)

                # The dedicated observer lock does not weaken the backing-proof
                # CAS: changing a journal after capture is rejected even while
                # the unrelated activation operation lock is held.
                journal_path.write_bytes(b'{"state":"changed"}\n')
                altered = subprocess.run(
                    ["bash", "-euc", rendered], env=environment,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
                )
                self.assertNotEqual(altered.returncode, 0)
                self.assertEqual(target.read_bytes(), attestation)
            finally:
                holder.terminate()
                holder.wait(timeout=5)

            journal_path.write_bytes(journal)
            committed = subprocess.run(
                ["bash", "-euc", rendered], env=environment,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
            )
            self.assertEqual(committed.returncode, 0, committed.stderr.decode())
            self.assertEqual(target.read_bytes(), attestation)
            # A second invocation reuses the exact immutable bytes and still
            # passes the same CAS/hash protocol.
            replayed = subprocess.run(
                ["bash", "-euc", rendered], env=environment,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
            )
            self.assertEqual(replayed.returncode, 0, replayed.stderr.decode())
            self.assertEqual(target.read_bytes(), attestation)


if __name__ == "__main__":
    unittest.main()
