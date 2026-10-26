"""Pure regressions for cancelled activation recovery evidence and fencing."""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPT_DIR = ROOT / "scripts"
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import docker_volume_cancelled_activation_guard as cancelled_guard
import docker_volume_unclaimed_cancellation as unclaimed_cancellation
from docker_build_control import BuildControlError, canonical


ACTIVATION_ATTEMPT = "a" * 32
DEVELOPMENT_ATTEMPT = "d" * 32
ARCHIVE_ATTEMPT_A = "e" * 32
ARCHIVE_ATTEMPT_B = "f" * 32
CONFIG_SHA256 = "1" * 64
IMAGE_ID = "sha256:" + "2" * 64
BACKEND_ID = "3" * 64
FRONTEND_ID = "4" * 64
BACKEND_STARTED_AT = "2026-10-25T10:11:12.123456789Z"
SOURCE_ROOT = "/worktrees/cancelled-activation"
STATE_ROOT = "/storage/sessions/cancelled-activation"


def _raw(value: object) -> bytes:
    return canonical(value) + b"\n"


def _duplicate_key(raw: bytes, key: str) -> bytes:
    key_token = json.dumps(key).encode("utf-8") + b":"
    start = raw.index(key_token)
    value_start = start + len(key_token)
    delimiters = [
        position
        for marker in (b",", b"}")
        if (position := raw.find(marker, value_start)) >= 0
    ]
    end = min(delimiters)
    pair = raw[start:end]
    return raw[:end] + b"," + pair + raw[end:]


class FakeControl:
    project = "fullmag-worktree-cancelled-activation"
    volume = project + "-control"
    namespace = "cancelled-activation-test"

    def __init__(self) -> None:
        self.files: dict[str, object] = {}
        self.raw_files: dict[str, bytes] = {}
        self.reads: list[str] = []

    def read(self, path: str, *, optional: bool = False) -> object:
        self.reads.append(path)
        if path not in self.files:
            if optional:
                return None
            raise BuildControlError("missing fake control record: " + path)
        return deepcopy(self.files[path])


def _read_control_bytes(
    control: FakeControl,
    relative: str,
    *,
    optional: bool = False,
    **_kwargs: object,
) -> bytes | None:
    value = control.raw_files.get(relative)
    if value is None and not optional:
        raise BuildControlError("missing fake control bytes: " + relative)
    return value


def _record_fixture() -> tuple[FakeControl, dict[str, object]]:
    control = FakeControl()
    original_receipt = b"original activation receipt\n"
    record: dict[str, object] = {
        "schema": cancelled_guard.SCHEMA,
        "state": "stopped-awaiting-fresh-archive",
        "activation_attempt": ACTIVATION_ATTEMPT,
        "development_attempt": DEVELOPMENT_ATTEMPT,
        "request_id": "request-cancelled-activation-17",
        "restart_policy": "fresh-state-only",
        "execution_state": "not-started",
        "original_receipt_sha256": hashlib.sha256(original_receipt).hexdigest(),
        "config_sha256": CONFIG_SHA256,
        "source_root": SOURCE_ROOT,
        "state_root": STATE_ROOT,
        "image_id": IMAGE_ID,
        "backend_container": BACKEND_ID,
        "frontend_container": FRONTEND_ID,
        "backend_started_at": BACKEND_STARTED_AT,
    }
    record_raw = _raw(record)
    terminal = {
        "state": "failed-confirmed",
        "activation_state": "operator-cancelled-after-confirmed-drain",
        "cancelled_recovery_sha256": hashlib.sha256(record_raw).hexdigest(),
    }
    control.raw_files.update({
        cancelled_guard.RECORD: record_raw,
        f"verification/cancelled-activation-{ACTIVATION_ATTEMPT}/terminal.json": record_raw,
        f"activation/attempts/{ACTIVATION_ATTEMPT}/receipt.json": original_receipt,
    })
    control.files[
        f"activation/attempts/{ACTIVATION_ATTEMPT}/terminal.json"
    ] = terminal
    return control, record


def _archive_root(attempt: str) -> str:
    return "recreate-services/attempts/" + attempt


def _install_archive(
    control: FakeControl,
    record: dict[str, object],
    attempt: str,
    *,
    intent_overrides: dict[str, object] | None = None,
    removed_overrides: dict[str, str] | None = None,
) -> dict[str, object]:
    root = _archive_root(attempt)
    archive_path = root + "/runtime-control-archive-terminal.json"
    intent_path = root + "/runtime-control-archive-intent.json"
    intent: dict[str, object] = {
        "source_root": record["source_root"],
        "previous_state_root": record["state_root"],
    }
    if intent_overrides:
        intent.update(intent_overrides)
    intent_raw = _raw(intent)
    removed = {
        "backend": str(record["backend_container"]),
        "frontend": str(record["frontend_container"]),
    }
    if removed_overrides:
        removed.update(removed_overrides)
    archive: dict[str, object] = {
        "schema": "fullmag.docker-fresh-runtime-archive-terminal.v1",
        "state": "succeeded",
        "operation_attempt": attempt,
        "compose_project": control.project,
        "control_volume": control.volume,
        "control_namespace": control.namespace,
        "removed_containers": removed,
        "preserved_group_ledger_volume": control.project + "-group-ledger",
        "intent_sha256": hashlib.sha256(intent_raw).hexdigest(),
    }
    recreation = {
        "schema": "fullmag.docker-build-operation.v1",
        "phase": "recreate-services",
        "state": "succeeded",
        "attempt": attempt,
        "compose_project": control.project,
        "control_volume": control.volume,
        "control_namespace": control.namespace,
        "fresh_state": True,
        "inputs": {
            "attempt": record["development_attempt"],
            "config_sha256": record["config_sha256"],
        },
        "runtime_control_archive": deepcopy(archive),
    }
    generation: dict[str, object] = {
        "schema": "fullmag.docker-group-ledger-generation.v1",
        "compose_project": control.project,
        "generation": attempt,
        "archive_terminal_path": archive_path,
        "archive_terminal_sha256": hashlib.sha256(canonical(archive)).hexdigest(),
        "preserved_volume": archive["preserved_group_ledger_volume"],
    }
    control.files[archive_path] = archive
    control.files[root + "/terminal.json"] = recreation
    control.files["group-ledger-generation.json"] = generation
    control.raw_files[intent_path] = intent_raw
    return generation


def _refresh_archive_binding(control: FakeControl, attempt: str) -> None:
    root = _archive_root(attempt)
    archive = control.files[root + "/runtime-control-archive-terminal.json"]
    recreation = control.files[root + "/terminal.json"]
    generation = control.files["group-ledger-generation.json"]
    assert isinstance(archive, dict)
    assert isinstance(recreation, dict)
    assert isinstance(generation, dict)
    recreation["runtime_control_archive"] = deepcopy(archive)
    generation["archive_terminal_sha256"] = hashlib.sha256(canonical(archive)).hexdigest()
    generation["preserved_volume"] = archive["preserved_group_ledger_volume"]


def _valid_backend(record: dict[str, object]) -> dict[str, object]:
    return {
        "Id": record["backend_container"],
        "Image": record["image_id"],
        "State": {
            "Running": False,
            "OOMKilled": False,
            "ExitCode": 0,
            "StartedAt": record["backend_started_at"],
        },
    }


class CancelledActivationRecoveryGuardTests(unittest.TestCase):
    def setUp(self) -> None:
        self.read_bytes_patch = patch.object(cancelled_guard, "_read_control_bytes", _read_control_bytes)
        self.read_bytes_patch.start()
        self.addCleanup(self.read_bytes_patch.stop)

    def test_record_and_retained_terminal_tampering_are_rejected(self) -> None:
        tamper_cases = ("current", "immutable", "receipt", "terminal")
        for case in tamper_cases:
            with self.subTest(case=case):
                control, _record = _record_fixture()
                if case == "current":
                    control.raw_files[cancelled_guard.RECORD] += b" "
                elif case == "immutable":
                    path = (
                        "verification/cancelled-activation-"
                        + ACTIVATION_ATTEMPT
                        + "/terminal.json"
                    )
                    control.raw_files[path] += b" "
                elif case == "receipt":
                    control.raw_files[
                        f"activation/attempts/{ACTIVATION_ATTEMPT}/receipt.json"
                    ] += b"tampered"
                else:
                    path = f"activation/attempts/{ACTIVATION_ATTEMPT}/terminal.json"
                    terminal = control.files[path]
                    assert isinstance(terminal, dict)
                    terminal["cancelled_recovery_sha256"] = "0" * 64

                with self.assertRaisesRegex(BuildControlError, "evidence changed"):
                    cancelled_guard.read_record(control)

    def test_malformed_record_and_terminal_documents_are_rejected(self) -> None:
        for raw in (b"not-json", b"[]", b"null", b"7"):
            with self.subTest(record=raw):
                control, _record = _record_fixture()
                control.raw_files[cancelled_guard.RECORD] = raw
                with self.assertRaises(BuildControlError):
                    cancelled_guard.read_record(control)

        control, _record = _record_fixture()
        control.files[
            f"activation/attempts/{ACTIVATION_ATTEMPT}/terminal.json"
        ] = []
        with self.assertRaisesRegex(BuildControlError, "evidence changed"):
            cancelled_guard.read_record(control)

    def test_duplicate_recovery_record_key_is_rejected(self) -> None:
        control, record = _record_fixture()
        control.raw_files[cancelled_guard.RECORD] = _duplicate_key(
            _raw(record), "state"
        )

        with self.assertRaisesRegex(BuildControlError, "duplicate JSON keys"):
            cancelled_guard.read_record(control)

    def test_malformed_or_conflicting_archive_anchors_are_rejected(self) -> None:
        cases = (
            [],
            {"schema": "other", "recovery_sha256": "0" * 64, "generation": {}},
            {
                "schema": "fullmag.cancelled-activation-archive.v1",
                "recovery_sha256": "0" * 64,
                "generation": {},
            },
        )
        for anchor in cases:
            with self.subTest(anchor=anchor):
                control, record = _record_fixture()
                path = (
                    "cancelled-activation-recovery/archives/"
                    + ACTIVATION_ATTEMPT
                    + ".json"
                )
                control.files[path] = anchor
                with self.assertRaisesRegex(BuildControlError, "archive anchor differs"):
                    cancelled_guard.has_archive(control, record)

    def test_old_request_replay_and_old_state_reuse_are_blocked(self) -> None:
        control, record = _record_fixture()

        with self.assertRaisesRegex(BuildControlError, "request cannot be replayed"):
            cancelled_guard.assert_start_allowed(
                control,
                request_id=str(record["request_id"]),
            )
        with self.assertRaisesRegex(BuildControlError, "runtime cannot be resumed"):
            cancelled_guard.assert_start_allowed(
                control,
                reuse_state={"state": record["state_root"]},
            )

    def test_fresh_recreation_requires_the_pinned_request_and_backend_incarnation(self) -> None:
        control, record = _record_fixture()
        previous = {
            "attempt": DEVELOPMENT_ATTEMPT,
            "inputs": {
                "source_root": SOURCE_ROOT,
                "image_id": IMAGE_ID,
            },
            "state_root": STATE_ROOT,
        }
        args = SimpleNamespace(fresh_state=True, config_sha256=CONFIG_SHA256)
        backend = _valid_backend(record)

        with patch.object(
            cancelled_guard,
            "docker_capture",
            return_value=SimpleNamespace(stdout=json.dumps([backend]).encode()),
        ) as inspect:
            cancelled_guard.require_fresh_recreation(
                control,
                args,
                previous,
                recreate_services=True,
            )
        inspect.assert_called_once_with("inspect", BACKEND_ID)

        invalid_pins = (
            ("recreate flag", False, args, previous),
            ("fresh state flag", True, SimpleNamespace(fresh_state=False, config_sha256=CONFIG_SHA256), previous),
            ("config digest", True, SimpleNamespace(fresh_state=True, config_sha256="9" * 64), previous),
            (
                "source root",
                True,
                args,
                {**previous, "inputs": {**previous["inputs"], "source_root": "/other/source"}},
            ),
            (
                "image id",
                True,
                args,
                {**previous, "inputs": {**previous["inputs"], "image_id": "sha256:" + "8" * 64}},
            ),
            ("state root", True, args, {**previous, "state_root": "/other/state"}),
        )
        for label, recreate, candidate_args, candidate_previous in invalid_pins:
            with self.subTest(pin=label), patch.object(
                cancelled_guard, "docker_capture"
            ) as inspect:
                with self.assertRaisesRegex(BuildControlError, "pinned fresh-state recreation"):
                    cancelled_guard.require_fresh_recreation(
                        control,
                        candidate_args,
                        candidate_previous,
                        recreate_services=recreate,
                    )
                inspect.assert_not_called()

        backend_mutations = (
            ("container id", lambda value: value.update(Id="8" * 64)),
            ("image id", lambda value: value.update(Image="sha256:" + "8" * 64)),
            ("running", lambda value: value["State"].update(Running=True)),
            ("oom killed", lambda value: value["State"].update(OOMKilled=True)),
            ("exit code", lambda value: value["State"].update(ExitCode=1)),
            ("started at", lambda value: value["State"].update(StartedAt="changed")),
        )
        for label, mutate in backend_mutations:
            with self.subTest(backend=label):
                changed_backend = deepcopy(backend)
                mutate(changed_backend)
                with patch.object(
                    cancelled_guard,
                    "docker_capture",
                    return_value=SimpleNamespace(
                        stdout=json.dumps([changed_backend]).encode()
                    ),
                ):
                    with self.assertRaisesRegex(BuildControlError, "drain identity changed"):
                        cancelled_guard.require_fresh_recreation(
                            control,
                            args,
                            previous,
                            recreate_services=True,
                        )

        for rows in ([], [backend, deepcopy(backend)]):
            with self.subTest(inspect_rows=len(rows)), patch.object(
                cancelled_guard,
                "docker_capture",
                return_value=SimpleNamespace(stdout=json.dumps(rows).encode()),
            ):
                with self.assertRaisesRegex(BuildControlError, "inspection is ambiguous"):
                    cancelled_guard.require_fresh_recreation(
                        control,
                        args,
                        previous,
                        recreate_services=True,
                    )

    def test_archive_requires_intent_digest_and_exact_source_state_and_service_ids(self) -> None:
        control, record = _record_fixture()
        generation = _install_archive(control, record, ARCHIVE_ATTEMPT_A)
        self.assertTrue(cancelled_guard._archive_matches(control, record, generation))

        cases = ("intent digest", "source root", "state root", "backend id", "frontend id")
        for case in cases:
            with self.subTest(binding=case):
                control, record = _record_fixture()
                generation = _install_archive(control, record, ARCHIVE_ATTEMPT_A)
                root = _archive_root(ARCHIVE_ATTEMPT_A)
                archive_path = root + "/runtime-control-archive-terminal.json"
                intent_path = root + "/runtime-control-archive-intent.json"
                archive = control.files[archive_path]
                assert isinstance(archive, dict)
                if case == "intent digest":
                    intent = json.loads(control.raw_files[intent_path])
                    intent["source_root"] = "/tampered/source"
                    control.raw_files[intent_path] = _raw(intent)
                elif case in {"source root", "state root"}:
                    intent = json.loads(control.raw_files[intent_path])
                    key = "source_root" if case == "source root" else "previous_state_root"
                    intent[key] = "/different/" + key
                    intent_raw = _raw(intent)
                    control.raw_files[intent_path] = intent_raw
                    archive["intent_sha256"] = hashlib.sha256(intent_raw).hexdigest()
                    _refresh_archive_binding(control, ARCHIVE_ATTEMPT_A)
                else:
                    removed = archive["removed_containers"]
                    assert isinstance(removed, dict)
                    service = "backend" if case == "backend id" else "frontend"
                    removed[service] = "8" * 64
                    _refresh_archive_binding(control, ARCHIVE_ATTEMPT_A)

                self.assertFalse(
                    cancelled_guard._archive_matches(control, record, generation)
                )

    def test_duplicate_archive_intent_key_is_rejected(self) -> None:
        control, record = _record_fixture()
        generation = _install_archive(control, record, ARCHIVE_ATTEMPT_A)
        root = _archive_root(ARCHIVE_ATTEMPT_A)
        archive = control.files[root + "/runtime-control-archive-terminal.json"]
        assert isinstance(archive, dict)
        intent_path = root + "/runtime-control-archive-intent.json"
        intent_raw = _duplicate_key(control.raw_files[intent_path], "source_root")
        control.raw_files[intent_path] = intent_raw
        archive["intent_sha256"] = hashlib.sha256(intent_raw).hexdigest()
        _refresh_archive_binding(control, ARCHIVE_ATTEMPT_A)

        with self.assertRaisesRegex(BuildControlError, "duplicate JSON keys"):
            cancelled_guard._archive_matches(control, record, generation)

    def test_pinned_archive_anchor_survives_a_later_generation(self) -> None:
        control, record = _record_fixture()
        generation_a = _install_archive(control, record, ARCHIVE_ATTEMPT_A)
        anchor_path = (
            "cancelled-activation-recovery/archives/"
            + ACTIVATION_ATTEMPT
            + ".json"
        )

        def publish_immutable(fake_control: FakeControl, path: str, raw: bytes) -> None:
            if path in fake_control.files:
                raise BuildControlError("fake immutable path already exists")
            fake_control.files[path] = json.loads(raw)

        publish = Mock(side_effect=publish_immutable)
        with patch.object(unclaimed_cancellation, "_publish_immutable", publish):
            cancelled_guard.pin_archive(control)

            anchor = deepcopy(control.files[anchor_path])
            self.assertEqual(anchor["generation"], generation_a)
            self.assertEqual(
                anchor["recovery_sha256"],
                hashlib.sha256(canonical(record)).hexdigest(),
            )

            # A later current generation belongs to a different source and
            # state. The earlier archive remains the one pinned to this recovery.
            _install_archive(
                control,
                record,
                ARCHIVE_ATTEMPT_B,
                intent_overrides={
                    "source_root": "/later/source",
                    "previous_state_root": "/later/state",
                },
            )
            control.reads.clear()
            self.assertTrue(cancelled_guard.has_archive(control, record))
            self.assertNotIn("group-ledger-generation.json", control.reads)
            control.reads.clear()
            cancelled_guard.pin_archive(control)

        self.assertEqual(control.files[anchor_path], anchor)
        self.assertEqual(publish.call_count, 1)
        self.assertNotIn("group-ledger-generation.json", control.reads)


if __name__ == "__main__":
    unittest.main()
