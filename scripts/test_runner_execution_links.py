"""Regression tests for the read-only Windows execution-link verifier."""

from __future__ import annotations

import importlib.util
import hashlib
import json
import ntpath
import os
from pathlib import Path
import struct
import tempfile
import unittest
from unittest import mock


_MODULE_PATH = Path(__file__).with_name("windows") / "audit_runner_execution_links.py"
_SPEC = importlib.util.spec_from_file_location("audit_runner_execution_links", _MODULE_PATH)
if _SPEC is None or _SPEC.loader is None:  # pragma: no cover - test bootstrap failure
    raise RuntimeError(f"cannot load verifier module: {_MODULE_PATH}")
_AUDIT = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_AUDIT)


def _records_for(mapping: dict[str, str]):
    normalized = {
        _AUDIT._key(path): target for path, target in mapping.items()
    }

    def decode(path: str) -> dict[str, str]:
        return {"kind": "fixture", "direct_target": normalized[_AUDIT._key(path)]}

    return decode


class RunnerExecutionLinkVerifierTests(unittest.TestCase):
    def test_hash_refuses_reparse_before_opening_file(self) -> None:
        path = r"C:\audit\source\file.txt"
        with mock.patch.object(
            _AUDIT, "_check_ancestors", side_effect=_AUDIT.AuditError("reparse ancestor")
        ) as check, mock.patch("builtins.open") as open_file:
            with self.assertRaises(_AUDIT.AuditError):
                _AUDIT._sha256_file(path)
            check.assert_called_once_with(r"C:\audit\source")
            open_file.assert_not_called()
        with mock.patch.object(
            _AUDIT, "_check_ancestors"
        ), mock.patch.object(_AUDIT, "_is_reparse", return_value=True), mock.patch(
            "builtins.open"
        ) as open_file:
            with self.assertRaises(_AUDIT.AuditError):
                _AUDIT._sha256_file(path)
            open_file.assert_not_called()

    def test_intermediate_directory_escape_is_external(self) -> None:
        root = r"C:\audit"
        consumer = r"C:\audit\consumer"
        directory_link = r"C:\audit\dir-link"
        with mock.patch.object(
            _AUDIT,
            "_decode_record",
            side_effect=_records_for(
                {
                    consumer: r"dir-link\file.bin",
                    directory_link: r"..\outside",
                }
            ),
        ):
            records, _counts = _AUDIT._resolve_records(root, [consumer, directory_link])
        consumer_record = next(item for item in records if item["path"] == "consumer")
        self.assertEqual(consumer_record["status"], "external_target")

    def test_parent_after_named_directory_reparse_is_external(self) -> None:
        root = r"C:\audit"
        alias = r"C:\audit\root-alias"
        consumer = r"C:\audit\consumer"
        with mock.patch.object(
            _AUDIT,
            "_decode_record",
            side_effect=_records_for(
                {
                    alias: ".",
                    consumer: r"root-alias\..\secret",
                }
            ),
        ), mock.patch.object(_AUDIT.os.path, "exists", return_value=True):
            records, _counts = _AUDIT._resolve_records(root, [alias, consumer])
        consumer_record = next(item for item in records if item["path"] == "consumer")
        self.assertEqual(consumer_record["status"], "external_target")

    def test_external_component_target_cannot_reenter_with_suffix(self) -> None:
        root = r"C:\audit"
        alias = r"C:\audit\alias"
        consumer = r"C:\audit\consumer"
        with mock.patch.object(
            _AUDIT,
            "_decode_record",
            side_effect=_records_for(
                {
                    alias: r"..\outside",
                    consumer: r"alias\..\audit\secret",
                }
            ),
        ):
            records, _counts = _AUDIT._resolve_records(root, [alias, consumer])
        consumer_record = next(item for item in records if item["path"] == "consumer")
        self.assertEqual(consumer_record["status"], "external_target")

    def test_reparse_chain_cycle_is_rejected(self) -> None:
        root = r"C:\audit"
        first = r"C:\audit\first"
        second = r"C:\audit\second"
        with mock.patch.object(
            _AUDIT,
            "_decode_record",
            side_effect=_records_for({first: "second", second: "first"}),
        ):
            records, _counts = _AUDIT._resolve_records(root, [first, second])
        self.assertEqual({item["status"] for item in records}, {"cycle"})

    def test_nul_and_drive_relative_targets_fail_closed(self) -> None:
        link = r"C:\audit\link"
        with self.assertRaises(_AUDIT.AuditError):
            _AUDIT._target_path(link, "target\0.bin")
        with self.assertRaises(_AUDIT.AuditError):
            _AUDIT._target_path(link, "")
        with self.assertRaises(_AUDIT.AuditError):
            _AUDIT._target_path(link, r"C:relative-target")

    def test_volume_guid_namespace_target_fails_closed(self) -> None:
        with self.assertRaises(_AUDIT.AuditError):
            _AUDIT._target_path(
                r"C:\audit\link",
                r"\??\Volume{01234567-89ab-cdef-0123-456789abcdef}\outside",
            )

    def test_unknown_windows_symlink_flags_fail_closed(self) -> None:
        target = "target.bin".encode("utf-16-le")
        payload = struct.pack(
            "<HHHHI",
            0,
            len(target),
            len(target),
            len(target),
            7,
        ) + target + target
        buffer = struct.pack("<IHH", _AUDIT.TAG_SYMLINK, len(payload), 0) + payload
        with mock.patch.object(_AUDIT, "_read_reparse_buffer", return_value=buffer):
            with self.assertRaises(_AUDIT.AuditError):
                _AUDIT._decode_record(r"C:\audit\link")

    @unittest.skipUnless(os.name == "nt", "requires Windows filesystem APIs")
    def test_zero_link_execution_tree_is_safe(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            report = _AUDIT.audit_execution(temporary)
        self.assertEqual(report["reparse_count"], 0)
        self.assertTrue(report["all_targets_safe"])

    @unittest.skipUnless(os.name == "nt", "requires Windows path semantics")
    def test_existing_or_dangling_reparse_output_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = os.path.join(temporary, "evidence.json")
            normalized_output = ntpath.normcase(ntpath.normpath(output))

            def is_output_reparse(path: str) -> bool:
                return ntpath.normcase(ntpath.normpath(path)) == normalized_output

            with mock.patch.object(_AUDIT, "_is_reparse", side_effect=is_output_reparse):
                with mock.patch.object(_AUDIT.os.path, "lexists", return_value=True):
                    with self.assertRaises(_AUDIT.AuditError):
                        _AUDIT._output_path(output)

    @unittest.skipUnless(os.name == "nt", "requires Windows path semantics")
    def test_source_manifest_unknown_entry_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as execution, tempfile.TemporaryDirectory() as capsule:
            Path(capsule, "tree").mkdir()
            manifest_path = os.path.join(capsule, "manifest.json")
            with open(manifest_path, "w", encoding="utf-8", newline="\n") as stream:
                json.dump({"entries": [{"type": "opaque", "path": "source.txt"}]}, stream)
            with self.assertRaises(_AUDIT.AuditError):
                _AUDIT.compare_source_capsule(execution, capsule)

    @unittest.skipUnless(os.name == "nt", "requires Windows path semantics")
    def test_unexpected_top_level_source_extra_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as execution, tempfile.TemporaryDirectory() as capsule:
            Path(capsule, "tree").mkdir()
            content = b"expected\n"
            digest = hashlib.sha256(content).hexdigest()
            Path(execution, "expected.txt").write_bytes(content)
            Path(capsule, "tree", "expected.txt").write_bytes(content)
            Path(capsule, "tree", "unexpected", "empty").mkdir(parents=True)
            Path(execution, "unexpected.txt").write_text("extra\n", encoding="utf-8")
            manifest_path = os.path.join(capsule, "manifest.json")
            with open(manifest_path, "w", encoding="utf-8", newline="\n") as stream:
                json.dump(
                    {
                        "entries": [
                            {
                                "type": "file",
                                "path": "expected.txt",
                                "size": len(content),
                                "sha256": digest,
                            }
                        ]
                    },
                    stream,
                )
            report = _AUDIT.compare_source_capsule(execution, capsule)
        self.assertEqual(report["extra_top_level"], ["unexpected.txt"])
        self.assertFalse(report["extra_top_level_generated_only"])
        self.assertEqual(report["source_capsule_extra_directories"], ["unexpected", "unexpected\\empty"])
        self.assertFalse(report["source_match"])

    @unittest.skipUnless(os.name == "nt", "requires Windows path semantics")
    def test_unexpected_nested_execution_extra_fails_closed(self) -> None:
        content = b"expected nested file\n"
        digest = hashlib.sha256(content).hexdigest()
        entry = {
            "type": "file",
            "path": "apps\\control-room\\expected.txt",
            "size": len(content),
            "sha256": digest,
        }
        with tempfile.TemporaryDirectory() as execution, tempfile.TemporaryDirectory() as capsule:
            execution_expected = Path(execution, "apps", "control-room", "expected.txt")
            capsule_expected = Path(capsule, "tree", "apps", "control-room", "expected.txt")
            execution_expected.parent.mkdir(parents=True)
            capsule_expected.parent.mkdir(parents=True)
            execution_expected.write_bytes(content)
            capsule_expected.write_bytes(content)
            Path(execution, "apps", "control-room", "unexpected.bin").write_bytes(b"extra\n")
            Path(capsule, "tree").mkdir(exist_ok=True)
            Path(capsule, "manifest.json").write_text(
                json.dumps({"entries": [entry]}),
                encoding="utf-8",
            )
            report = _AUDIT.compare_source_capsule(execution, capsule)
        self.assertIn("apps\\control-room\\unexpected.bin", report["unexpected_execution_extra_entries"])
        self.assertFalse(report["source_match"])

    @unittest.skipUnless(os.name == "nt", "requires Windows path semantics")
    def test_empty_manifest_and_overlapping_capsule_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            Path(root, "tree").mkdir()
            Path(root, "manifest.json").write_text(
                json.dumps({"entries": []}),
                encoding="utf-8",
            )
            with self.assertRaises(_AUDIT.AuditError):
                _AUDIT.compare_source_capsule(root, root)
            with tempfile.TemporaryDirectory() as execution:
                with self.assertRaises(_AUDIT.AuditError):
                    _AUDIT.compare_source_capsule(execution, root)

    @unittest.skipUnless(os.name == "nt", "requires Windows path semantics")
    def test_preserved_source_capsule_tree_is_verified(self) -> None:
        content = b"source capsule fixture\n"
        digest = hashlib.sha256(content).hexdigest()
        entry = {
            "type": "file",
            "path": "source.txt",
            "size": len(content),
            "sha256": digest,
        }
        with tempfile.TemporaryDirectory() as execution, tempfile.TemporaryDirectory() as capsule:
            tree = Path(capsule, "tree")
            tree.mkdir()
            Path(execution, "source.txt").write_bytes(content)
            Path(tree, "source.txt").write_bytes(content)
            Path(capsule, "manifest.json").write_text(
                json.dumps({"entries": [entry]}),
                encoding="utf-8",
            )
            report = _AUDIT.compare_source_capsule(execution, capsule)
            self.assertTrue(report["source_capsule_match"])
            self.assertTrue(report["source_match"])
            Path(tree, "source.txt").write_bytes(b"tampered\n")
            tampered = _AUDIT.compare_source_capsule(execution, capsule)
        self.assertFalse(tampered["source_capsule_match"])
        self.assertFalse(tampered["source_match"])
        self.assertEqual(tampered["source_capsule_mismatches"][0]["path"], "source.txt")

    @unittest.skipUnless(os.name == "nt", "requires Windows path semantics")
    def test_report_requires_new_path_and_stays_outside_source_capsule(self) -> None:
        with (
            tempfile.TemporaryDirectory() as execution,
            tempfile.TemporaryDirectory() as capsule,
            tempfile.TemporaryDirectory() as output_root,
        ):
            existing = os.path.join(output_root, "existing.json")
            Path(existing).write_text("old\n", encoding="utf-8")
            with self.assertRaises(_AUDIT.AuditError):
                _AUDIT._write_report(
                    existing,
                    {"schema": "fixture"},
                    forbidden_roots=[execution, capsule],
                )
            with self.assertRaises(_AUDIT.AuditError):
                _AUDIT._write_report(
                    os.path.join(capsule, "new.json"),
                    {"schema": "fixture"},
                    forbidden_roots=[execution, capsule],
                )

    def test_empty_execution_selection_is_not_vacuously_safe(self) -> None:
        report = _AUDIT.audit_executions([])
        self.assertFalse(report["all_safe"])
        self.assertTrue(report["errors"])

    def test_nested_generated_roots_are_explicitly_allowlisted(self) -> None:
        self.assertTrue(_AUDIT._is_generated_extra(r"apps\control-room\node_modules\pkg\index.js"))
        self.assertTrue(_AUDIT._is_generated_extra(r"apps\control-room\.next\server\BUILD_ID"))
        self.assertTrue(_AUDIT._is_generated_extra(r"apps\control-room\out\index.html"))
        self.assertFalse(_AUDIT._is_generated_extra(r"apps\control-room\src\unexpected.bin"))


if __name__ == "__main__":
    unittest.main()
