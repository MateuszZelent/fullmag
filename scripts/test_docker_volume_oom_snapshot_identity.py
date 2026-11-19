"""Source-only contracts for stable group-ledger identity in Linux OOM stop.

The runtime ledger's snapshot digest advances as inventory is observed. That
volatile field must not invalidate a stop admission when every other ledger
fact and the store admission proof stay byte-for-byte equivalent.
"""
from __future__ import annotations

import copy
import unittest

import docker_volume_stop_failed as stop


def ledger_document(*, snapshot: str = "a" * 64) -> dict[str, object]:
    return {
        "schema_version": "host_resource_ledger.v1",
        "policy": {
            "schema_version": "host_resource_policy.v1",
            "host_id": "group-host-a",
            "budget": {"cpu": 8, "memory_bytes": 16_000},
        },
        "history": [{"operation_id": "op-1", "state": "released"}],
        "node_policy": {"revision": 4, "nodes": ["node-a"]},
        "reservations": [{"id": "reservation-a", "state": "released", "bytes": 4096}],
        "readiness": {"state": "ready", "generation": 11},
        "runtime_state": {
            "schema_version": "host_runtime_state.v1",
            "snapshot_sha256": snapshot,
            "readiness_sha256": "b" * 64,
        },
    }


def ready_probe_cas_fields() -> dict[str, object]:
    return {
        "process_receipt_sha256": "1" * 64,
        "ready_pin_sha256": "2" * 64,
        "owner_identity_sha256": "3" * 64,
        "runtime_config_sha256": "4" * 64,
        "certificate_sha256": "5" * 64,
        "group_ledger_host_id": "group-host-a",
        "group_ledger_policy_host_id": "group-host-a",
        "group_ledger_sha256": "6" * 64,
        "group_ledger_stable_sha256": "7" * 64,
        "store_id": "sha256:" + "8" * 64,
        "store_proof_sha256": "9" * 64,
        "store_admission_sha256": "a" * 64,
        "catalog_count": 2,
        "task_count": 3,
        "terminal_run_count": 2,
        "lease_count": 1,
        "reservation_count": 1,
        "no_pending_transactions": True,
        "all_tasks_terminal": True,
        "all_leases_released": True,
        "all_reservations_released": True,
        "api_pid": 42,
        "api_pid_exists": False,
        "api_listener_open": False,
        "native_process_pids": [50, 51],
    }


class LinuxOOMLedgerSnapshotIdentityTests(unittest.TestCase):
    def test_snapshot_advance_is_semantically_stable_and_does_not_mutate_input(self) -> None:
        first = ledger_document(snapshot="a" * 64)
        second = ledger_document(snapshot="c" * 64)
        original_first = copy.deepcopy(first)
        original_second = copy.deepcopy(second)

        first_digest = stop._linux_oom_ledger_digest(first)
        second_digest = stop._linux_oom_ledger_digest(second)

        self.assertEqual(first_digest, second_digest)
        self.assertEqual(first, original_first)
        self.assertEqual(second, original_second)

    def test_each_nonvolatile_ledger_branch_changes_the_digest(self) -> None:
        base = ledger_document()
        expected = stop._linux_oom_ledger_digest(base)
        mutations = {
            "schema": lambda value: value.update(schema_version="host_resource_ledger.v2"),
            "policy": lambda value: value["policy"].update(host_id="other-group"),
            "history": lambda value: value["history"].append(
                {"operation_id": "op-2", "state": "failed"}
            ),
            "node_policy": lambda value: value["node_policy"].update(revision=5),
            "reservations": lambda value: value["reservations"][0].update(bytes=8192),
            "readiness": lambda value: value["readiness"].update(generation=12),
            "runtime readiness digest": lambda value: value["runtime_state"].update(
                readiness_sha256="d" * 64
            ),
        }
        for label, mutate in mutations.items():
            with self.subTest(field=label):
                changed = copy.deepcopy(base)
                mutate(changed)
                self.assertNotEqual(stop._linux_oom_ledger_digest(changed), expected)

    def test_runtime_state_is_optional_for_legacy_ledger_documents(self) -> None:
        value = ledger_document()
        value.pop("runtime_state")
        before = copy.deepcopy(value)
        digest = stop._linux_oom_ledger_digest(value)
        self.assertRegex(digest, r"^[0-9a-f]{64}$")
        self.assertEqual(value, before)

    def test_malformed_runtime_state_fails_closed_without_mutating_input(self) -> None:
        malformed = (
            {"schema_version": "other.v1", "snapshot_sha256": "a" * 64,
             "readiness_sha256": "b" * 64},
            {"schema_version": "host_runtime_state.v1", "snapshot_sha256": "0" * 64,
             "readiness_sha256": "b" * 64},
            {"schema_version": "host_runtime_state.v1", "snapshot_sha256": "a" * 64,
             "readiness_sha256": "g" * 64},
            {"schema_version": "host_runtime_state.v1", "snapshot_sha256": "a" * 64},
        )
        for state in malformed:
            with self.subTest(runtime_state=state):
                value = ledger_document()
                value["runtime_state"] = copy.deepcopy(state)
                before = copy.deepcopy(value)
                with self.assertRaises((stop.BuildControlError, TypeError, ValueError)):
                    stop._linux_oom_ledger_digest(value)
                self.assertEqual(value, before)

    def test_ready_probe_cas_uses_stable_admission_pins_and_omits_raw_digests(self) -> None:
        probe = ready_probe_cas_fields()
        baseline = stop._linux_oom_ready_probe_cas(probe)

        for field in ("group_ledger_sha256", "store_proof_sha256"):
            with self.subTest(raw_digest=field):
                changed = dict(probe)
                changed[field] = "f" * 64
                self.assertEqual(stop._linux_oom_ready_probe_cas(changed), baseline)

        for field in ("group_ledger_stable_sha256", "store_admission_sha256"):
            with self.subTest(admission_digest=field):
                changed = dict(probe)
                changed[field] = "e" * 64
                self.assertNotEqual(stop._linux_oom_ready_probe_cas(changed), baseline)

        changed = dict(probe)
        changed["certificate_sha256"] = "f" * 64
        self.assertNotEqual(stop._linux_oom_ready_probe_cas(changed), baseline)


if __name__ == "__main__":
    unittest.main()
