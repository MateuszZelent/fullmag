"""Regression tests for live references beside historical backend markers."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from docker_activation_history_inventory import control_references
from docker_activation_history_policy import HistoryError, digest


def make_root(path):
    root = Path(path) / "control"
    (root / "activation/attempts").mkdir(parents=True)
    return root


def put(root, relative, value):
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(value, bytes):
        path.write_bytes(value)
    else:
        path.write_text(json.dumps(value, separators=(",", ":")) + "\n")
    return path


def activation_marker(root, token):
    key = "a" * 64
    terminal = {
        "schema": "fullmag.docker-build-operation.v1",
        "phase": "activation",
        "state": "succeeded",
        "attempt": token,
        "run_id": "run-" + token[:8],
        "activation_receipt_key": key,
        "request_id": "request-" + token[:8],
        "source_sha256": "b" * 64,
        "provenance_sha256": "c" * 64,
    }
    for name in ("receipt.json", "terminal.json"):
        put(root, f"activation/attempts/{token}/{name}", terminal)
    marker_relative = f"backend/script-activation-{key}/activation.json"
    put(root, marker_relative, {
        "state": "activated",
        "attempt": token,
        "request_id": terminal["request_id"],
        "source_sha256": terminal["source_sha256"],
        "provenance_sha256": terminal["provenance_sha256"],
    })
    return marker_relative


def retirement_marker(root, token):
    response = {"state": "retired", "operation_id": token, "run_id": "run-old"}
    terminal = {
        "schema": "fullmag.docker-build-operation.v1",
        "phase": "activation",
        "state": "succeeded",
        "attempt": token,
        "run_id": "run-" + token[:8],
        "retirement": response,
        "retirement_inputs_sha256": "d" * 64,
    }
    for name in ("receipt.json", "terminal.json"):
        put(root, f"activation/attempts/{token}/{name}", terminal)
    marker_relative = f"backend/workspace-retirement-{token}/retirement.json"
    put(root, marker_relative, {
        "schema": "fullmag.docker-workspace-retirement-receipt.v1",
        "state": "retired",
        "operation_id": token,
        "response": response,
        "operation_inputs_sha256": terminal["retirement_inputs_sha256"],
    })
    return marker_relative


class HistoricalMarkerReferenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = make_root(self.temporary.name)

    def test_only_authenticated_runtime_heartbeat_is_excluded_from_plan_digest(self):
        token = "owner-token"
        owner = {"schema_version": "runtime_service_owner.v1", "protocol": "stdin-v1",
                 "target_id": "docker-all", "state": "ready", "owner_token": token,
                 "heartbeat_at": "2026-11-05T21:12:37.731114153Z", "pid": 123,
                 "attempt": "c" * 32}
        path = "runtime-control/runtime-services/OWNER.json"
        ready = "runtime-control/runtime-services/docker-client-" + token + ".json"
        put(self.root, path, owner)
        put(self.root, ready, owner)
        before = control_references(self.root, "f" * 32)
        owner["heartbeat_at"] = "2026-11-05T21:12:42.731114153Z"
        put(self.root, path, owner)
        after = control_references(self.root, "f" * 32)
        self.assertEqual(before["pins"], after["pins"])
        self.assertIn("c" * 32, after["protected"])
        owner["pid"] = 456
        put(self.root, path, owner)
        with self.assertRaisesRegex(HistoryError, "Ready identity"):
            control_references(self.root, "f" * 32)
        put(self.root, ready, owner)
        self.assertNotEqual(before["pins"], control_references(self.root, "f" * 32)["pins"])
        owner["heartbeat_at"] = "not-a-timestamp"
        put(self.root, path, owner)
        with self.assertRaisesRegex(HistoryError, "heartbeat"):
            control_references(self.root, "f" * 32)

    def test_released_host_ledger_writer_normalizes_only_transaction_identity_and_times(self):
        owner_relative = "runtime-control/host-ledger-roots/WRITER.owner.json"
        registry_relative = "runtime-control/host-ledger-roots/HOST_LEDGER_ROOTS.json"
        owner = {
            "schema": "fullmag.writer.v1",
            "token": "11111111-1111-4111-8111-111111111111",
            "process_start_token": "22222222-2222-4222-8222-222222222222",
            "host": "host-a",
            "pid": 2345,
            "acquired_at": "2026-11-05T21:12:37.731114153Z",
            "heartbeat_at": "2026-11-05T21:12:42.731114153Z",
            "released": True,
        }
        registry = {
            "schema_version": "host_ledger_root_registry.v1",
            "roots_by_host_id": {"host-a": "/state/ledger-a"},
        }
        put(self.root, owner_relative, owner)
        registry_path = put(self.root, registry_relative, registry)
        first = control_references(self.root, "f" * 32)
        self.assertEqual(first["pins"][registry_relative], digest(registry_path.read_bytes()))

        next_transaction = {
            **owner,
            "token": "33333333-3333-4333-8333-333333333333",
            "acquired_at": "2026-11-05T21:13:37.731114153Z",
            "heartbeat_at": "2026-11-05T21:13:42.731114153Z",
        }
        put(self.root, owner_relative, next_transaction)
        second = control_references(self.root, "f" * 32)
        self.assertEqual(first["pins"][owner_relative], second["pins"][owner_relative])
        self.assertEqual(first["sha256"], second["sha256"])
        self.assertEqual(first["pins"][registry_relative], second["pins"][registry_relative])

        identity_changes = (
            ("pid", 2346),
            ("host", "host-b"),
            ("process_start_token", "44444444-4444-4444-8444-444444444444"),
            ("future_identity", {"revision": 2}),
        )
        for key, value in identity_changes:
            changed = copy.deepcopy(owner)
            changed[key] = value
            put(self.root, owner_relative, changed)
            with self.subTest(field=key):
                proof = control_references(self.root, "f" * 32)
                self.assertNotEqual(first["pins"][owner_relative], proof["pins"][owner_relative])
        for key, value in (
            ("schema", "fullmag.writer.v2"),
            ("released", False),
            ("token", "not-a-uuid"),
            ("process_start_token", "not-a-uuid"),
            ("host", ""),
            ("pid", True),
            ("acquired_at", "not-a-timestamp"),
            ("heartbeat_at", "2026-02-30T21:12:42Z"),
        ):
            changed = copy.deepcopy(owner)
            changed[key] = value
            put(self.root, owner_relative, changed)
            with self.subTest(invalid_field=key), self.assertRaises(HistoryError):
                control_references(self.root, "f" * 32)

        put(self.root, owner_relative, owner)
        registry["roots_by_host_id"]["host-a"] = "/state/ledger-b"
        put(self.root, registry_relative, registry)
        registry_changed = control_references(self.root, "f" * 32)
        self.assertNotEqual(first["pins"][registry_relative], registry_changed["pins"][registry_relative])
        self.assertNotEqual(first["sha256"], registry_changed["sha256"])

    def test_linked_host_ledger_writer_owner_is_refused(self):
        owner = self.root / "runtime-control/host-ledger-roots/WRITER.owner.json"
        owner.parent.mkdir(parents=True)
        target = put(self.root, "outside-writer-owner.json", {"schema": "fullmag.writer.v1"})
        owner.symlink_to(target)
        put(self.root, "runtime-control/host-ledger-roots/HOST_LEDGER_ROOTS.json", {
            "schema_version": "host_ledger_root_registry.v1", "roots_by_host_id": {},
        })

        with self.assertRaisesRegex(HistoryError, "Linked or special control reference entry"):
            control_references(self.root, "f" * 32)

    def assert_marker_only_is_excluded(self, marker_relative, closed_attempt, sibling_relative,
                                       nested_relative, sibling_attempt, nested_attempt):
        proof = control_references(self.root, "f" * 32)
        self.assertNotIn(closed_attempt, proof["protected"])
        self.assertNotIn(marker_relative, proof["pins"])
        self.assertIn(sibling_attempt, proof["protected"])
        self.assertIn(nested_attempt, proof["protected"])
        self.assertIn(sibling_relative, proof["pins"])
        self.assertIn(nested_relative, proof["pins"])

    def test_activated_marker_does_not_hide_sibling_or_nested_reference_pins(self):
        closed = "1" * 32
        sibling_attempt = "2" * 32
        nested_attempt = "3" * 32
        marker = activation_marker(self.root, closed)
        directory = str(Path(marker).parent)
        sibling = f"{directory}/sibling.json"
        nested = f"{directory}/details/pin.json"
        put(self.root, sibling, {"attempt": sibling_attempt})
        put(self.root, nested, {
            "receipt": f"/control/activation/attempts/{nested_attempt}/terminal.json"
        })

        self.assert_marker_only_is_excluded(
            marker, closed, sibling, nested, sibling_attempt, nested_attempt,
        )

    def test_retirement_marker_does_not_hide_sibling_or_nested_reference_pins(self):
        closed = "4" * 32
        sibling_attempt = "5" * 32
        nested_attempt = "6" * 32
        marker = retirement_marker(self.root, closed)
        directory = str(Path(marker).parent)
        sibling = f"{directory}/sibling.json"
        nested = f"{directory}/details/pin.json"
        put(self.root, sibling, {"attempt": sibling_attempt})
        put(self.root, nested, {
            "receipt": f"/control/activation/attempts/{nested_attempt}/terminal.json"
        })

        self.assert_marker_only_is_excluded(
            marker, closed, sibling, nested, sibling_attempt, nested_attempt,
        )

    def test_malformed_sibling_json_is_not_hidden_by_either_historical_marker(self):
        for kind in ("activation", "retirement"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temporary:
                root = make_root(temporary)
                token = "7" * 32 if kind == "activation" else "8" * 32
                marker = (activation_marker(root, token) if kind == "activation"
                          else retirement_marker(root, token))
                sibling = root / Path(marker).parent / "unknown.json"
                sibling.write_bytes(b"{not-json\n")

                with self.assertRaisesRegex(HistoryError, "strict JSON"):
                    control_references(root, "f" * 32)

    def test_symlink_sibling_is_not_hidden_by_either_historical_marker(self):
        for kind in ("activation", "retirement"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temporary:
                root = make_root(temporary)
                token = "9" * 32 if kind == "activation" else "a" * 32
                marker = (activation_marker(root, token) if kind == "activation"
                          else retirement_marker(root, token))
                sibling = root / Path(marker).parent / "unknown.json"
                target = put(root, "outside.json", {"attempt": "b" * 32})
                sibling.symlink_to(target)

                with self.assertRaisesRegex(HistoryError, "Linked or special"):
                    control_references(root, "f" * 32)

    def test_sibling_json_still_consumes_the_control_pin_byte_budget(self):
        closed = "c" * 32
        marker = activation_marker(self.root, closed)
        sibling = self.root / Path(marker).parent / "sibling.json"
        sibling.write_text('{"pin":"' + ("d" * 128) + '"}\n')

        with patch("docker_activation_history_inventory.MAX_PIN_BYTES", 1):
            with self.assertRaisesRegex(HistoryError, "byte budget"):
                control_references(self.root, "f" * 32)


if __name__ == "__main__":
    unittest.main()
