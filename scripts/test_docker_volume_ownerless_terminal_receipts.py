"""Low-level contract tests for ownerless terminal receipt helpers."""

from __future__ import annotations

import unittest
from types import MappingProxyType

from docker_build_control import BuildControlError
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


if __name__ == "__main__":
    unittest.main()
