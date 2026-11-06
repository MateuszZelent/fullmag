"""Reference closure and preservation inventories, using real temporary trees."""
import base64
import json
from pathlib import Path
import stat
import tempfile
import unittest

from docker_activation_history import EXPORT_SCHEMA, preserved_output
from docker_activation_history_inventory import control_references, source_inventory, tree_inventory
from docker_activation_history_policy import HistoryError, canonical, digest
from test_docker_activation_history_policy import fixture, TOKEN, RUN, raw


class HistoryInventoryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve() / "control"
        self.root.mkdir()
        (self.root / "activation/attempts").mkdir(parents=True)

    def put(self, relative, value):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw(value))
        return path

    def terminal(self, token, run, retirement=None):
        value = {"schema": "fullmag.docker-build-operation.v1", "phase": "activation",
                 "state": "succeeded", "attempt": token, "run_id": run}
        if retirement is not None:
            value["retirement"] = retirement
        for name in ("receipt.json", "terminal.json"):
            self.put("activation/attempts/" + token + "/" + name, value)
        return value

    def test_current_and_direct_predecessor_protected_without_pinning_entire_history(self):
        a, b, c = "a" * 32, "b" * 32, "c" * 32
        self.terminal(a, "run-a")
        self.terminal(b, "run-b", {"run_id": "run-a"})
        current = self.terminal(c, "run-c", {"run_id": "run-b"})
        self.put("activation/current.json", current)
        proof = control_references(self.root, a)
        self.assertIn(b, proof["protected"])
        self.assertIn(c, proof["protected"])
        self.assertNotIn(a, proof["protected"])
        with self.assertRaisesRegex(HistoryError, "referenced"):
            control_references(self.root, b)

    def test_explicit_transitive_attempt_path_pin_stays_live(self):
        a, b, c = "a" * 32, "b" * 32, "c" * 32
        self.terminal(a, "run-a")
        self.terminal(b, "run-b")
        self.put("activation/attempts/" + b + "/recovery-pin.json",
                 {"record": "/control/activation/attempts/" + a + "/terminal.json"})
        self.put("activation/current.json", self.terminal(c, "run-c", {"run_id": "run-b"}))
        with self.assertRaisesRegex(HistoryError, "transitive"):
            control_references(self.root, a)

    def test_prepared_unclaimed_previous_current_remains_a_recovery_pin(self):
        self.terminal(TOKEN, RUN)
        self.put("prepared-unclaimed/preparation/previous-current.json", {"attempt": TOKEN})
        with self.assertRaisesRegex(HistoryError, "prepared-unclaimed"):
            control_references(self.root, TOKEN)

    def test_host_device_reattest_intent_and_current_are_reference_hash_pins(self):
        candidate = "d" * 32
        operation_attempt = "e" * 32
        certificate_sha = "f" * 64
        pins = {"attempt": candidate, "config_sha256": "1" * 64,
                "certificate_sha256": certificate_sha, "expected_host_device": 11,
                "source_root": "/source", "compose_project": "fullmag-worktree-test"}
        intent = {"pins": pins, "state_root": "/state", "engine_id": "engine",
                  "old_certificate": "old", "new_certificate": "new",
                  "containers": {"backend": "2" * 64}}
        intent_path = ("host-device-reattest/" + certificate_sha + "/intent.json")
        self.put(intent_path, intent)

        operation = {"schema": "fullmag.docker-build-operation.v1",
                     "phase": "host-device-reattest", "state": "succeeded",
                     "attempt": operation_attempt, "compose_project": pins["compose_project"],
                     "control_volume": "fullmag-worktree-test-control", "inputs": pins,
                     "new_certificate_sha256": "3" * 64}
        self.put("host-device-reattest/attempts/" + operation_attempt + "/receipt.json", operation)
        self.put("host-device-reattest/attempts/" + operation_attempt + "/terminal.json", operation)
        current_path = "host-device-reattest/current.json"
        self.put(current_path, operation)

        proof = control_references(self.root, "0" * 32)
        self.assertIn(candidate, proof["protected"])
        self.assertEqual(digest(raw(intent)), proof["pins"][intent_path])
        self.assertEqual(digest(raw(operation)), proof["pins"][current_path])
        with self.assertRaisesRegex(HistoryError, "referenced"):
            control_references(self.root, candidate)

    def test_failed_or_inconsistent_terminal_attempt_is_a_live_root(self):
        a, b = "a" * 32, "b" * 32
        self.terminal(a, "run-a")
        value = self.terminal(b, "run-b", {"run_id": "run-a"})
        self.put("activation/attempts/" + b + "/receipt.json", {**value, "state": "outcome-unknown-resources-retained"})
        with self.assertRaisesRegex(HistoryError, "referenced"):
            control_references(self.root, a)
        self.put("activation/attempts/" + b + "/terminal.json", {**value, "state": "failed-confirmed"})
        with self.assertRaisesRegex(HistoryError, "referenced"):
            control_references(self.root, a)

    def test_only_correlated_completed_retirement_marker_is_historical(self):
        response = {"state": "retired", "operation_id": TOKEN, "run_id": "previous-run"}
        value = self.terminal(TOKEN, RUN, response)
        value["retirement_inputs_sha256"] = "f" * 64
        for name in ("receipt.json", "terminal.json"):
            self.put("activation/attempts/" + TOKEN + "/" + name, value)
        marker_path = "backend/workspace-retirement-" + TOKEN + "/retirement.json"
        marker = {"schema": "fullmag.docker-workspace-retirement-receipt.v1", "state": "retired",
                  "operation_id": TOKEN, "response": response, "operation_inputs_sha256": "f" * 64}
        self.put(marker_path, marker)
        self.assertNotIn(TOKEN, control_references(self.root, TOKEN)["protected"])
        self.put(marker_path, {**marker, "operation_inputs_sha256": "0" * 64})
        with self.assertRaisesRegex(HistoryError, "workspace-retirement"):
            control_references(self.root, TOKEN)

    def test_new_consumer_root_symlinks_and_invalid_json_refuse(self):
        path = self.put("new-consumer/pin.json", {"attempt": TOKEN})
        with self.assertRaisesRegex(HistoryError, "Unclassified"):
            control_references(self.root, TOKEN)
        path.unlink(); path.parent.rmdir()
        (self.root / "backend").symlink_to(self.root / "activation")
        with self.assertRaisesRegex(HistoryError, "Linked"):
            control_references(self.root, TOKEN)
        (self.root / "backend").unlink()
        self.put("backend/bad.json", {}).write_bytes(b"{invalid")
        with self.assertRaisesRegex(HistoryError, "strict JSON"):
            control_references(self.root, TOKEN)

    def test_private_cache_and_verification_are_not_live_reference_roots(self):
        self.put("private/backend/cache.json", {"attempt": TOKEN})
        self.put("verification/test-fixture.json", {"attempt": TOKEN})
        self.assertNotIn(TOKEN, control_references(self.root, TOKEN)["protected"])

    def test_opaque_owner_marker_requires_exact_pinned_metadata(self):
        path = self.put(".fullmag-toolchain-control-owner.json", {"schema": "owned"})
        s = path.stat()
        pin = {"sha256": digest(path.read_bytes()), "stat": {"inode": s.st_ino, "size": s.st_size,
               "mtime_ns": s.st_mtime_ns, "uid": s.st_uid, "gid": s.st_gid, "mode": stat.S_IMODE(s.st_mode)}}
        with self.assertRaisesRegex(HistoryError, "authenticated pin"):
            control_references(self.root, TOKEN)
        control_references(self.root, TOKEN, owner_marker_pin=pin)
        path.write_bytes(b"changed bytes")
        with self.assertRaisesRegex(HistoryError, "authenticated pin"):
            control_references(self.root, TOKEN, owner_marker_pin=pin)

    def test_tree_metadata_and_payload_changes_affect_preservation_digest(self):
        directory = self.root / "output"
        directory.mkdir()
        (directory / ".zgroup").write_bytes(b'{"zarr_format":2}')
        (directory / "chunk").write_bytes(b"field bytes")
        before = tree_inventory(directory)
        self.assertEqual(before, tree_inventory(directory))
        (directory / "chunk").write_bytes(b"changed field bytes")
        self.assertNotEqual(before, tree_inventory(directory))
        (directory / "link").symlink_to(directory / "chunk")
        with self.assertRaisesRegex(HistoryError, "link"):
            tree_inventory(directory)

    def test_launcher_source_inventory_detects_changes_and_links(self):
        path = self.put("scripts/launcher.py", {})
        before = source_inventory(self.root)
        path.write_text("print('changed')")
        self.assertNotEqual(before, source_inventory(self.root))
        (path.parent / "linked.py").symlink_to(path)
        with self.assertRaises(HistoryError):
            source_inventory(self.root)

    def test_preserved_output_requires_exact_script_records_and_run_zarr(self):
        from test_docker_activation_history_output import PreservedRunOutputTests
        output_fixture = PreservedRunOutputTests()
        output_fixture.setUp()
        self.addCleanup(output_fixture.doCleanups)
        zarr, run_id = output_fixture.zarr, output_fixture.run_id
        files, _, _ = fixture()
        script = b'study.storage(output_dir="/user-data/results.zarr")\n'
        receipt = json.loads(files["receipt.json"])
        receipt["source_sha256"] = digest(script)
        receipt["run_id"] = run_id
        files["receipt.json"] = raw(receipt)
        zarr.with_suffix(".py").write_bytes(script)
        export = {"schema": EXPORT_SCHEMA, "attempt": TOKEN, "run_id": run_id,
                  "source_sha256": receipt["source_sha256"], "zarr_name": zarr.name,
                  "records": {name: base64.b64encode(content).decode() for name, content in files.items()}}
        export_path = zarr.with_suffix(".activation-" + TOKEN + ".json")
        export_path.write_bytes(raw(export))
        request = {"output_name": zarr.name, "attempt": TOKEN}
        before = preserved_output(zarr.parent, request, files)
        self.assertEqual(before, preserved_output(zarr.parent, request, files))
        export["records"]["terminal.json"] = base64.b64encode(b"different").decode()
        export_path.write_bytes(raw(export))
        with self.assertRaisesRegex(HistoryError, "exact activation"):
            preserved_output(zarr.parent, request, files)


if __name__ == "__main__":
    unittest.main()
