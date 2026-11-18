"""Low-level contract tests for ownerless terminal receipt helpers."""

from __future__ import annotations

import copy
import hashlib
import json
import unittest
from types import MappingProxyType

from docker_build_control import BuildControlError, canonical
import docker_volume_preowner_drained as preowner


PROCESS_KEYS = {
    "schema",
    "state",
    "accepted_store",
    "api_pid",
    "bootstrap",
    "qualification",
    "error",
    "api_diagnostic_only",
    "api_failure_fence",
}


def valid_pre_receipt() -> dict[str, object]:
    return {
        "schema": "fullmag.docker-process-tree.v1",
        "state": "failed_outcome_retained",
        "accepted_store": "/state/runs/docker-all/session-store",
        "api_pid": 4242,
        "bootstrap": {"receipt": "bootstrap-pin"},
        "qualification": "startup-diagnostic-only",
        "error": preowner.OWNERLESS_STARTUP_ERROR,
        "api_diagnostic_only": True,
        "api_failure_fence": (
            "/opt/fullmag/runtime-control/runtime-service/api-failure-"
            + "0123456789abcdef0123456789abcdef.json"
        ),
    }


def valid_shutdown_receipt(before: dict[str, object]) -> dict[str, object]:
    return {
        **before,
        "state": "shutdown_unknown",
        "api_exit_code": 1,
        "shutdown_error": preowner.OWNERLESS_SHUTDOWN_ERROR,
    }


class OwnerlessTerminalReceiptTests(unittest.TestCase):
    def assertRejected(self, callback, *args) -> None:
        with self.assertRaises(BuildControlError):
            callback(*args)

    def test_accepts_exact_diagnostic_only_pre_receipt(self) -> None:
        receipt = valid_pre_receipt()
        result = preowner._validate_ownerless_process_receipt(
            MappingProxyType(receipt),
        )

        self.assertEqual(set(receipt), PROCESS_KEYS)
        self.assertEqual(result, receipt)
        self.assertIsNot(result, receipt)

    def test_pre_receipt_rejects_missing_or_unapproved_fields(self) -> None:
        for key in sorted(PROCESS_KEYS):
            with self.subTest(missing=key):
                receipt = valid_pre_receipt()
                del receipt[key]
                self.assertRejected(preowner._validate_ownerless_process_receipt, receipt)

        for key, value in (
            ("unexpected", True),
            ("service_owner", {}),
            ("runtime_pid", 123),
            ("terminal_service_owner", {}),
        ):
            with self.subTest(extra=key):
                receipt = valid_pre_receipt()
                receipt[key] = value
                self.assertRejected(preowner._validate_ownerless_process_receipt, receipt)

    def test_pre_receipt_rejects_wrong_state_and_diagnostic_bindings(self) -> None:
        cases = (
            ("schema", "fullmag.docker-process-tree.v0"),
            ("state", "drained"),
            ("error", "different startup error"),
            ("api_diagnostic_only", False),
            ("api_diagnostic_only", 1),
            ("api_pid", True),
            ("api_pid", 1),
            ("api_pid", 0),
            ("api_pid", -1),
            ("accepted_store", "state/runs/session-store"),
            ("qualification", None),
            ("api_failure_fence", "/tmp/api-failure-0123456789abcdef0123456789abcdef.json"),
        )
        for key, value in cases:
            with self.subTest(field=key, value=value):
                receipt = valid_pre_receipt()
                receipt[key] = value
                self.assertRejected(preowner._validate_ownerless_process_receipt, receipt)

    def test_accepts_only_exact_shutdown_receipt_with_original_bindings_preserved(self) -> None:
        before = valid_pre_receipt()
        after = valid_shutdown_receipt(before)

        result = preowner._validate_ownerless_shutdown_receipt(before, after)

        self.assertEqual(result, after)
        self.assertIsNot(result, after)

    def test_shutdown_receipt_rejects_nonterminal_shape_and_invalid_wait_observation(self) -> None:
        before = valid_pre_receipt()
        valid_after = valid_shutdown_receipt(before)
        cases = (
            ("state", "failed_outcome_retained"),
            ("state", "drained"),
            ("shutdown_error", "different shutdown error"),
            ("api_exit_code", True),
            ("api_exit_code", "1"),
        )
        for key, value in cases:
            with self.subTest(field=key, value=value):
                after = dict(valid_after)
                after[key] = value
                self.assertRejected(preowner._validate_ownerless_shutdown_receipt, before, after)

        for key, value in (("api_exit_code", None), ("shutdown_error", None)):
            with self.subTest(missing=key):
                after = dict(valid_after)
                del after[key]
                self.assertRejected(preowner._validate_ownerless_shutdown_receipt, before, after)

        extra = {**valid_after, "runtime_pid": 123}
        self.assertRejected(preowner._validate_ownerless_shutdown_receipt, before, extra)

    def test_shutdown_receipt_rejects_changes_to_any_startup_binding(self) -> None:
        before = valid_pre_receipt()
        mutations = {
            "schema": "fullmag.docker-process-tree.v2",
            "accepted_store": "/state/runs/other/session-store",
            "api_pid": 4243,
            "bootstrap": {"receipt": "changed"},
            "qualification": "changed qualification",
            "error": "changed startup error",
            "api_diagnostic_only": False,
            "api_failure_fence": (
                "/opt/fullmag/runtime-control/runtime-service/api-failure-"
                + "fedcba9876543210fedcba9876543210.json"
            ),
        }
        for key, value in mutations.items():
            with self.subTest(changed=key):
                after = valid_shutdown_receipt(before)
                after[key] = value
                self.assertRejected(preowner._validate_ownerless_shutdown_receipt, before, after)

        with self.subTest(changed="before receipt"):
            changed_before = dict(before)
            changed_before["error"] = "different startup error"
            self.assertRejected(
                preowner._validate_ownerless_shutdown_receipt,
                changed_before,
                valid_shutdown_receipt(before),
            )


GIB = 1024 ** 3
PARENT_ATTEMPT = "a" * 32
BACKEND_ID = "b" * 64
IMAGE_ID = "sha256:" + "c" * 64
STARTED_AT = "2026-11-08T10:29:57.151722168Z"
SOURCE_ROOT = "/repo/fullmag"


class MemoryControl:
    def __init__(self, project="fullmag-worktree-test", volume="fullmag-control-test", namespace="ns"):
        self.project = project
        self.volume = volume
        self.namespace = namespace
        self.records: dict[str, bytes] = {}
        self.profile_reads = 0
        self.profile_appears_on_second_read = None

    def read_bytes(self, relative, *, optional=False, maximum=8 * 1024 * 1024, timeout=90):
        if relative == "backend/resource-budget.json":
            self.profile_reads += 1
            if self.profile_reads == 2 and self.profile_appears_on_second_read is not None:
                return self.profile_appears_on_second_read
        raw = self.records.get(relative)
        if raw is None:
            if optional:
                return None
            raise BuildControlError("fixture record is absent: " + relative)
        if len(raw) > maximum:
            raise BuildControlError("fixture record exceeds requested bound")
        return raw


def valid_budget_fixture():
    control = MemoryControl()
    document = {
        "name": control.project,
        "services": {
            "backend": {
                "mem_limit": 64 * GIB,
                "cpus": 8,
                "environment": {
                    "FULLMAG_DOCKER_CPU_MILLIS": "8000",
                    "FULLMAG_DOCKER_MEMORY_BYTES": str(64 * GIB),
                },
            },
            "frontend": {"image": "sha256:" + "d" * 64},
        },
    }
    config_sha = hashlib.sha256(canonical(document)).hexdigest()
    outer_limits = {
        "cpu.max": "800000 100000\n",
        "memory.max": f"{64 * GIB}\n",
    }
    terminal = {
        "schema": "fullmag.docker-build-operation.v1",
        "phase": "development",
        "state": "failed-confirmed",
        "attempt": PARENT_ATTEMPT,
        "compose_project": control.project,
        "control_volume": control.volume,
        "control_namespace": control.namespace,
        "config_sha256": config_sha,
        "inputs": {"source_root": SOURCE_ROOT, "image_id": IMAGE_ID},
        "backend_container": BACKEND_ID,
        "backend_started_at": STARTED_AT,
        "ledger_profile": "group-ledger-v1",
        "error": preowner.OWNERLESS_PARENT_ERROR,
        "worker_cgroup": {
            "state": "ready",
            "container_id": BACKEND_ID,
            "image_id": IMAGE_ID,
            "compose_project": control.project,
            "outer_limits": outer_limits,
        },
    }
    terminal_raw = canonical(terminal) + b"\n"
    root = "development/attempts/" + PARENT_ATTEMPT
    control.records.update({
        root + "/terminal.json": terminal_raw,
        root + "/receipt.json": terminal_raw,
        "development/current.json": terminal_raw,
        root + "/compose.json": canonical(document) + b"\n",
    })
    backend = {
        "Id": BACKEND_ID,
        "Image": IMAGE_ID,
        "State": {"StartedAt": STARTED_AT},
        "HostConfig": {
            "Memory": 64 * GIB,
            "NanoCpus": 8_000_000_000,
            "MemorySwap": 128 * GIB,
        },
    }
    previous = json.loads(terminal_raw)
    return control, document, backend, previous, config_sha, terminal_raw


def republish_budget_fixture(fixture, *, document=None, terminal=None):
    control, original_document, backend, previous, _, _ = fixture
    document = original_document if document is None else document
    terminal = copy.deepcopy(previous if terminal is None else terminal)
    config_sha = hashlib.sha256(canonical(document)).hexdigest()
    terminal["config_sha256"] = config_sha
    terminal_raw = canonical(terminal) + b"\n"
    root = "development/attempts/" + terminal["attempt"]
    control.records.update({
        root + "/terminal.json": terminal_raw,
        root + "/receipt.json": terminal_raw,
        "development/current.json": terminal_raw,
        root + "/compose.json": canonical(document) + b"\n",
    })
    return control, document, backend, json.loads(terminal_raw), config_sha, terminal_raw


class RetainedComposeBudgetTests(unittest.TestCase):
    def assertRejected(self, fixture, *, document=None, backend=None, previous=None,
                       expected_message=None):
        control, original_document, original_backend, original_previous, _, _ = fixture
        with self.assertRaises(BuildControlError) as raised:
            preowner._budget(
                control,
                original_document if document is None else document,
                original_backend if backend is None else backend,
                original_previous if previous is None else previous,
                IMAGE_ID,
            )
        if expected_message is not None:
            self.assertIn(expected_message, str(raised.exception))

    def test_ownerless_parent_uses_exact_explicit_compose_budget_without_profile(self) -> None:
        fixture = valid_budget_fixture()
        control, document, backend, previous, _, terminal_raw = fixture
        original_document = copy.deepcopy(document)

        result = preowner._budget(control, document, backend, previous, IMAGE_ID)

        self.assertEqual(result["source"], "retained-compose")
        self.assertEqual(result["budget"], {
            "memory_bytes": 64 * GIB,
            "cpus": 8,
            "memory_swap_bytes": 128 * GIB,
        })
        self.assertEqual(result["parent_attempt"], PARENT_ATTEMPT)
        self.assertEqual(result["image_id"], IMAGE_ID)
        self.assertEqual(result["started_at"], STARTED_AT)
        self.assertEqual(result["parent_terminal_sha256"], hashlib.sha256(terminal_raw).hexdigest())
        self.assertEqual(
            result["parent_compose_sha256"],
            hashlib.sha256(control.records["development/attempts/" + PARENT_ATTEMPT + "/compose.json"]).hexdigest(),
        )
        self.assertNotIn("receipt_path", result)
        self.assertNotIn("receipt_sha256", result)
        self.assertNotIn("profile_sha256", result)
        self.assertEqual(document, original_document)

    def test_budget_remains_identical_after_exact_backend_is_stopped(self) -> None:
        fixture = valid_budget_fixture()
        control, document, backend, previous, _, _ = fixture
        before = preowner._budget(control, document, backend, previous, IMAGE_ID)
        stopped = copy.deepcopy(backend)
        stopped["State"].update({
            "Status": "exited",
            "Running": False,
            "Pid": 0,
            "ExitCode": 1,
            "OOMKilled": False,
        })

        after = preowner._budget(control, document, stopped, previous, IMAGE_ID)

        self.assertEqual(after, before)

    def test_compose_requires_explicit_positive_integer_limits(self) -> None:
        for field, value in (("mem_limit", None), ("mem_limit", True), ("mem_limit", float(64 * GIB)),
                             ("cpus", None), ("cpus", 8.0), ("cpus", False)):
            with self.subTest(field=field, value=value):
                fixture = valid_budget_fixture()
                document = copy.deepcopy(fixture[1])
                if value is None:
                    document["services"]["backend"].pop(field, None)
                else:
                    document["services"]["backend"][field] = value
                fixture = republish_budget_fixture(fixture, document=document)
                self.assertRejected(
                    fixture,
                    expected_message="Retained Compose limits must be explicit normalized positive integers",
                )

    def test_explicit_swap_limit_uses_shared_compose_semantics(self) -> None:
        for swap in (96 * GIB, -1):
            with self.subTest(swap=swap):
                fixture = valid_budget_fixture()
                document = copy.deepcopy(fixture[1])
                document["services"]["backend"]["memswap_limit"] = swap
                fixture = republish_budget_fixture(fixture, document=document)
                fixture[2]["HostConfig"]["MemorySwap"] = swap
                result = preowner._budget(fixture[0], fixture[1], fixture[2], fixture[3], IMAGE_ID)
                self.assertEqual(result["budget"]["memory_swap_bytes"], swap)

        fixture = valid_budget_fixture()
        document = copy.deepcopy(fixture[1])
        document["services"]["backend"]["memswap_limit"] = 32 * GIB
        fixture = republish_budget_fixture(fixture, document=document)
        self.assertRejected(
            fixture,
            expected_message="Retained Compose swap limit is invalid",
        )

    def test_environment_kernel_and_admission_must_all_match_compose(self) -> None:
        for field, value in (("FULLMAG_DOCKER_CPU_MILLIS", "16000"),
                             ("FULLMAG_DOCKER_MEMORY_BYTES", str(128 * GIB))):
            with self.subTest(environment=field):
                fixture = valid_budget_fixture()
                document = copy.deepcopy(fixture[1])
                document["services"]["backend"]["environment"][field] = value
                fixture = republish_budget_fixture(fixture, document=document)
                self.assertRejected(
                    fixture,
                    expected_message="retained Compose budget differs from its explicit backend environment",
                )

        for field, value in (("Memory", 128 * GIB), ("NanoCpus", 16_000_000_000),
                             ("MemorySwap", 64 * GIB)):
            with self.subTest(host_config=field):
                fixture = valid_budget_fixture()
                backend = copy.deepcopy(fixture[2])
                backend["HostConfig"][field] = value
                self.assertRejected(
                    fixture,
                    backend=backend,
                    expected_message="current backend kernel limits differ from retained Compose",
                )

        for field, value in (("cpu.max", "700000 100000\n"),
                             ("memory.max", f"{63 * GIB}\n")):
            with self.subTest(admission=field):
                fixture = valid_budget_fixture()
                previous = copy.deepcopy(fixture[3])
                previous["worker_cgroup"]["outer_limits"][field] = value
                fixture = republish_budget_fixture(fixture, terminal=previous)
                self.assertRejected(
                    fixture,
                    expected_message="parent worker-cgroup admission limits differ from retained Compose",
                )

    def test_parent_attempt_compose_start_and_container_identity_are_pinned(self) -> None:
        fixture = valid_budget_fixture()
        previous = copy.deepcopy(fixture[3])
        previous["attempt"] = "e" * 32
        self.assertRejected(fixture, previous=previous)

        fixture = valid_budget_fixture()
        previous = copy.deepcopy(fixture[3])
        previous["config_sha256"] = "f" * 64
        self.assertRejected(fixture, previous=previous)

        fixture = valid_budget_fixture()
        document = copy.deepcopy(fixture[1])
        document["services"]["backend"]["cpus"] = 7
        self.assertRejected(fixture, document=document)

        fixture = valid_budget_fixture()
        backend = copy.deepcopy(fixture[2])
        backend["State"]["StartedAt"] = "2026-11-08T10:30:00Z"
        self.assertRejected(fixture, backend=backend)

        fixture = valid_budget_fixture()
        backend = copy.deepcopy(fixture[2])
        backend["Id"] = "e" * 64
        self.assertRejected(fixture, backend=backend)

    def test_present_profile_never_falls_through_and_legacy_absence_stays_rejected(self) -> None:
        for profile in (canonical({"schema": "foreign-profile"}) + b"\n", b"{malformed"):
            with self.subTest(profile=profile):
                fixture = valid_budget_fixture()
                fixture[0].records["backend/resource-budget.json"] = profile
                self.assertRejected(fixture)

        fixture = valid_budget_fixture()
        fixture[0].profile_appears_on_second_read = canonical({"schema": "late-profile"}) + b"\n"
        self.assertRejected(fixture)

        fixture = valid_budget_fixture()
        previous = copy.deepcopy(fixture[3])
        previous["error"] = "different failed development"
        self.assertRejected(
            fixture,
            previous=previous,
            expected_message="backend/resource-budget.json",
        )


if __name__ == "__main__":
    unittest.main()
