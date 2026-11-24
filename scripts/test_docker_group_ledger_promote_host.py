"""Interpreted promotion controller and fixed migration shell routes."""
import argparse
import ast
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import Mock, patch

import docker_group_ledger_promote_host as host
from docker_build_control import BuildControlError
from test_docker_group_ledger_bootstrap_host import document_fixture


class PromotionHostTests(unittest.TestCase):
    def test_target_mount_only_is_rebound_without_initialization_or_frontend_change(self):
        document = document_fixture(); before = deepcopy(document)
        control = SimpleNamespace(volume="control-volume")
        updated = host.configured_document(document, "/request", "a" * 64, control, "private/ledger")
        self.assertEqual(document, before)
        self.assertEqual(updated["services"]["frontend"], before["services"]["frontend"])
        for mount in updated["services"]["backend"]["volumes"]:
            original = next(row for row in before["services"]["backend"]["volumes"] if row["target"] == mount["target"])
            if mount["target"] == "/host-ledger":
                self.assertEqual(mount["source"], "control")
                self.assertEqual(mount["volume"], {"subpath": "private/ledger", "nocopy": True})
                self.assertTrue(mount["read_only"])
            else: self.assertEqual(mount, original)
        with self.assertRaises(BuildControlError):
            host.configured_document(document, "/request", "a" * 64, control, "other/ledger")

    def test_semantic_receipt_hash_ignores_only_json_serialization(self):
        value = {"state": "verified"}
        control = SimpleNamespace(read_bytes=lambda _: b'{"state": "verified"}\n')
        expected = host.bootstrap.digest(host.common.canonical(value))
        self.assertEqual(host.semantic_record(control, "own/receipt.json", expected), value)
        with self.assertRaises(BuildControlError): host.semantic_record(control, "../other", expected)
        with self.assertRaises(BuildControlError): host.semantic_record(control, "own/receipt.json", "0" * 64)

    def test_preview_never_recreates_services_or_opens_a_write_lease(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = SimpleNamespace(repo_root=str(root), source_root=str(root), bootstrap_attempt="a" * 32,
                bootstrap_sha256="b" * 64, image_id="sha256:" + "c" * 64, relocation_receipt="group-ledger-relocation/attempts/" + "9" * 32 + "/relocation.json",
                relocation_receipt_sha256="d" * 64, apply=False)
            backend = {"Id": "e" * 64, "State": {"StartedAt": "old"}}
            result = {"candidate": "/candidate"}
            receipt = {"schema": host.relocation.SCHEMA, "state": "verified", "request": {
                "bootstrap": {"terminal_path": "group-ledger-bootstrap/attempts/" + args.bootstrap_attempt + "/terminal.json",
                    "terminal_sha256": args.bootstrap_sha256, "container_id": backend["Id"], "started_at": "old"},
                "native_program": {"candidate": result["candidate"]}}}
            control = SimpleNamespace(project="own", prepare=Mock(), operation=Mock())
            with patch.object(host.common, "require_host"), patch.object(host.common, "_select_source", return_value=(root, {})), \
                    patch.object(host.common, "_compose_identity", return_value={}), patch.object(host.common, "BuildControl", return_value=control), \
                    patch.object(host, "predecessor", return_value=({}, result, {}, {}, backend, {})), \
                    patch.object(host, "semantic_record", return_value=receipt), patch.object(host.relocation, "validate_request"), \
                    patch.object(host.relocation, "assert_no_consumers"), patch.object(host.relocation, "_live_consumers", return_value=[]), \
                    patch.object(host.common, "verify_bootstrap_image"), patch.object(host.common, "compose_capture") as lifecycle:
                observed = host.run(args)
                self.assertFalse(observed["apply"])
                control.prepare.assert_not_called(); control.operation.assert_not_called(); lifecycle.assert_not_called()

    def dispatch(self, script, suffix):
        from test_just_development_recovery_shell import DevelopmentRecoveryShellTests
        recipe = ('python "/ignored/scripts/' + script + '" --repo-root "/ignored" '
            "--source-root '/selected/$(printf injected);worktree' --bootstrap-attempt '" + "a" * 32
            + "' --bootstrap-sha256 '" + "b" * 64 + "' --image-id 'sha256:" + "c" * 64 + "'" + suffix)
        return DevelopmentRecoveryShellTests().dispatch(recipe, '  *"scripts/' + script + '"*)\n')

    def test_closed_relocation_route_accepts_only_inspect_or_transfer_with_exact_pair(self):
        script = "docker_group_ledger_relocation_host.py"
        pair = " --request 'group-ledger-relocation-inspect/attempts/" + "d" * 32 + "/request.json' --request-sha256 '" + "e" * 64 + "'"
        for suffix in (" --mode 'inspect'", " --mode 'transfer'" + pair):
            result = self.dispatch(script, suffix)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(b'/selected/$(printf injected);worktree', result.stdout.split(b'\0'))
        for suffix in (" --mode 'transfer'", " --mode 'inspect'" + pair,
                       " --mode 'other'", " --mode 'transfer'" + pair + '; printf injected',
                       " --mode 'transfer'" + pair.replace('e' * 64, 'short')):
            result = self.dispatch(script, suffix)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertFalse(result.stdout)

    def test_closed_promotion_route_keeps_apply_explicit_and_rejects_composites(self):
        script = "docker_group_ledger_promote_host.py"
        suffix = " --relocation-receipt 'group-ledger-relocation/attempts/" + "d" * 32 + "/relocation.json' --relocation-receipt-sha256 '" + "e" * 64 + "'"
        for extra in ("", " --apply"):
            result = self.dispatch(script, suffix + extra)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(b'--apply' in result.stdout.split(b'\0'), bool(extra))
        for extra in ('; printf injected', ' && printf injected', '\nprintf injected', ' --apply --apply', ' --fresh-state'):
            result = self.dispatch(script, suffix + extra)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertFalse(result.stdout)

    def test_no_promotion_host_path_builds_or_serves_or_initializes_ledger(self):
        calls = {node.func.attr for node in ast.walk(ast.parse(Path(host.__file__).read_text()))
                 if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)}
        self.assertFalse(calls & {"_prepare_locked", "_group_ledger", "initialize_host_configuration", "_serve", "stop_idle", "rmtree"})


if __name__ == "__main__":
    unittest.main()
