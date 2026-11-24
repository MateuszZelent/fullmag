"""Managed-current publication regression; no Docker or native compilation."""
import ast
from copy import deepcopy
import io
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import docker_build_control as build_control
from docker_build_control import BuildControlError
import docker_group_ledger_relocation as relocation


class ManagedCurrentTests(unittest.TestCase):
    def fixture(self):
        attempt = "a" * 32
        root = "group-ledger-relocation/attempts/" + attempt
        current = {"schema": "fullmag.docker-build-operation.v1", "phase": "group-ledger-relocation",
            "state": "succeeded", "attempt": attempt, "compose_project": "own-group", "control_volume": "own-volume",
            "inputs": {"source_root": "/sources/antenna"}, "runtime_started": False, "solve_started": False,
            "relocation_receipt": root + "/relocation.json", "relocation_sha256": "b" * 64}
        records = {"group-ledger-relocation/current.json": current, root + "/terminal.json": deepcopy(current)}
        control = SimpleNamespace(project="own-group", volume="own-volume", namespace="", identity={"source_root": "/sources/antenna"},
            read=lambda key, optional=False: records.get(key))
        pointer = {"schema": relocation.SCHEMA, "receipt_path": root + "/relocation.json", "receipt_sha256": "b" * 64}
        return control, records, current, pointer

    def test_existing_managed_publication_resolves_without_rewriting_history(self):
        control, records, _, expected = self.fixture()
        before = deepcopy(records)
        self.assertEqual(relocation.read_relocation_pointer(control), expected)
        self.assertEqual(records, before)

    def test_absence_is_optional_but_legacy_pointer_is_not_managed_authority(self):
        control, records, _, pointer = self.fixture()
        records.pop("group-ledger-relocation/current.json")
        self.assertIsNone(relocation.read_relocation_pointer(control))
        records["group-ledger-relocation/current.json"] = pointer
        with self.assertRaisesRegex(BuildControlError, "managed publication"):
            relocation.read_relocation_pointer(control)

    def test_failed_foreign_or_malformed_publication_refuses_even_with_matching_terminal(self):
        for key, value in (("state", "failed-confirmed"), ("phase", "development"), ("compose_project", "foreign"),
                           ("control_volume", "foreign"), ("runtime_started", True), ("solve_started", True),
                           ("inputs", None), ("inputs", {"source_root": "/foreign"}), ("attempt", "../escape")):
            control, records, current, _ = self.fixture()
            current[key] = value
            terminal = next(name for name in records if name.endswith("/terminal.json"))
            records[terminal] = deepcopy(current)
            with self.subTest(key=key, value=value), self.assertRaises(BuildControlError):
                relocation.read_relocation_pointer(control)

    def test_current_must_equal_its_immutable_terminal_including_unknown_retained_fields(self):
        control, records, current, _ = self.fixture()
        for mutation in ({"finished_at": 42}, {"relocation_sha256": "c" * 64}):
            with self.subTest(mutation=mutation):
                original = deepcopy(current)
                current.update(mutation)
                with self.assertRaisesRegex(BuildControlError, "immutable terminal"):
                    relocation.read_relocation_pointer(control)
                current.clear(); current.update(original)
        records.pop(next(name for name in records if name.endswith("/terminal.json")))
        with self.assertRaisesRegex(BuildControlError, "immutable terminal"):
            relocation.read_relocation_pointer(control)

    def test_cross_attempt_artifact_and_noncanonical_digest_refuse(self):
        for key, value in (("relocation_receipt", "group-ledger-relocation/attempts/" + "c" * 32 + "/relocation.json"),
                           ("relocation_receipt", "development/current.json"), ("relocation_sha256", "B" * 64)):
            control, records, current, _ = self.fixture()
            current[key] = value
            records[next(name for name in records if name.endswith("/terminal.json"))] = deepcopy(current)
            with self.subTest(key=key), self.assertRaisesRegex(BuildControlError, "exact attempt"):
                relocation.read_relocation_pointer(control)

    def test_namespaced_control_cannot_read_a_legacy_root_migration(self):
        control, _, _, _ = self.fixture()
        control.namespace = "namespaces/" + "d" * 32
        with self.assertRaisesRegex(BuildControlError, "original root namespace"):
            relocation.read_relocation_pointer(control)

    def test_real_build_control_finalizer_publishes_receipt_and_accessor_resolves_it(self):
        records = {}
        lines = iter(("READY", "LOGGED"))
        logger = SimpleNamespace(stdin=io.BytesIO(), wait=lambda timeout: 0)
        control = SimpleNamespace(project="own-group", volume="own-volume", namespace="", _active_operation=None,
            identity={"source_root": "/sources/antenna"}, space=lambda: {}, path=build_control.BuildControl.path,
            operation_script=lambda *args: "closed-test-lease", helper_args=lambda *args, **kwargs: ["never-executed"],
            _line=lambda *args: next(lines), _pin_operation_helper=lambda *args: "e" * 64,
            write=lambda path, value: records.update({path: deepcopy(value)}),
            read=lambda path, optional=False: records.get(path))
        with patch.object(build_control.subprocess, "Popen", return_value=logger), patch.object(build_control, "_assert_free_space"), \
                patch.object(build_control, "mirror_console"):
            with build_control.BuildControl.operation(control, "group-ledger-relocation", {"source_root": "/sources/antenna"}) as operation:
                expected = {"schema": relocation.SCHEMA, "receipt_path": operation["root"] + "/relocation.json", "receipt_sha256": "b" * 64}
                # This reproduces the redundant write that the real finalizer replaces.
                control.write("group-ledger-relocation/current.json", expected)
                operation["receipt"].update(state="succeeded", relocation_receipt=expected["receipt_path"],
                    relocation_sha256=expected["receipt_sha256"], runtime_started=False, solve_started=False)
        self.assertEqual(records["group-ledger-relocation/current.json"]["schema"], "fullmag.docker-build-operation.v1")
        before = deepcopy(records)
        self.assertEqual(relocation.read_relocation_pointer(control), expected)
        self.assertEqual(before, records)

    def test_transfer_does_not_publish_a_second_owner_of_phase_current(self):
        tree = ast.parse(Path(relocation.__file__).read_text())
        transfer = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "transfer")
        writes = [node for node in ast.walk(transfer) if isinstance(node, ast.Call)
                  and isinstance(node.func, ast.Attribute) and node.func.attr == "write"]
        self.assertFalse(any(node.args and isinstance(node.args[0], ast.Constant)
            and node.args[0].value == "group-ledger-relocation/current.json" for node in writes))


if __name__ == "__main__":
    unittest.main()
