import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

spec=importlib.util.spec_from_file_location('snapshot_gate',Path(__file__).resolve().parents[1]/'docker/all-in-one/runtime_service_snapshot.py')
gate=importlib.util.module_from_spec(spec);spec.loader.exec_module(gate)


class CopiedPayloadGateTests(unittest.TestCase):
    def test_hashes_actual_payload_and_rejects_same_size_corruption(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);p=root/'result';p.write_bytes(b'kept')
            tree={'directories':[], 'files':[{'path':'result','size':4,'sha256':hashlib.sha256(b'kept').hexdigest()}]}
            gate._content(root,tree)
            p.write_bytes(b'lost')
            with self.assertRaisesRegex(ValueError,'bytes changed or differ'):gate._content(root,tree)

    def test_missing_unexpected_and_linked_payloads_are_rejected(self):
        for kind in ('missing','unexpected','linked'):
            with self.subTest(kind=kind),tempfile.TemporaryDirectory() as folder:
                root=Path(folder);p=root/'result'
                tree={'directories':[], 'files':[{'path':'result','size':1,'sha256':hashlib.sha256(b'x').hexdigest()}]}
                if kind=='unexpected':p.write_bytes(b'x');(root/'extra').write_bytes(b'y')
                if kind=='linked':(root/'target').write_bytes(b'x');p.symlink_to(root/'target')
                with self.assertRaises(ValueError):gate._content(root,tree)

    def test_missing_empty_directory_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            with self.assertRaisesRegex(ValueError,'directory tree is incomplete'):
                gate._content(root,{'directories':['current'],'files':[]})

    def test_control_document_rejects_digest_drift(self):
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder)/'request';p.write_bytes(b'{}')
            self.assertEqual(gate._read(p,hashlib.sha256(b'{}').hexdigest()),b'{}')
            with self.assertRaisesRegex(ValueError,'digest'):gate._read(p,'0'*64)


def _json_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


class RecordingService:
    def __init__(self, receipt):
        self.receipt = receipt
        self.events = []

    def _run_cli(self, paths, arguments, *, timeout):
        self.events.append(("native", arguments, timeout))
        return self.receipt

    def _atomic_json(self, path, value, name):
        self.events.append(("receipt", name))
        Path(path).write_bytes(_json_bytes(value))


class SnapshotAdmissionTests(unittest.TestCase):
    terminal_run = "1" * 32
    held_run = "2" * 32

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.control = root / "control" / "isolated-snapshot"
        self.control.mkdir(parents=True)
        self.state_runs = root / "state" / "runs"
        self.state_runs.mkdir(parents=True)
        self.user_data = root / "user-data"
        self.user_data.mkdir()
        self.live_workspace = root / "control" / "runtime-control" / "local-live"
        (self.live_workspace / "current").mkdir(parents=True)
        self.paths = SimpleNamespace(store=root / "runtime-store" / "session-store")

        self.state_tree = self._add_payload(self.state_runs, "held/result.json", b"state")
        self.user_tree = self._add_payload(self.user_data, "workspace/project.json", b"project")
        live_tree = self._add_payload(self.live_workspace, "current/model.json", b"model")
        self.live_record = {
            "schema": "fullmag.isolated-control-workspace.v1",
            "present": True,
            "tree": live_tree,
        }
        self.request = {
            "schema_version": "runtime_service_retained_snapshot_validation_request.v1",
            "request_id": "00000000-0000-0000-0000-000000000000",
            "source_manifest_sha256": "",
            "retained_terminal_runs": [{"run_id": self.terminal_run}],
            "retained_held_manual_runs": [{"run_id": self.held_run}],
        }
        self.source = {
            "schema": "fullmag.isolated-session-snapshot-manifest.v1",
            "restore_run_id": self.held_run,
            "live_workspace": self.live_record,
        }
        self.source_raw = _json_bytes(self.source)
        self.request["source_manifest_sha256"] = _sha(self.source_raw)
        self.request_raw = _json_bytes(self.request)
        self.config_raw = b'{"runtime_config":"pinned"}'
        self.content = {
            "state": self.state_tree,
            "user_data": self.user_tree,
            "live_workspace": self.live_record,
        }
        self.content_raw = _json_bytes(self.content)
        self.request_path = self.control / "request.json"
        self.config_path = self.control / "original-config.json"
        self.source_path = self.control / "source-manifest.json"
        self.content_path = self.control / "copied-content.json"
        self.start_path = self.control / "start.json"
        self.request_path.write_bytes(self.request_raw)
        self.config_path.write_bytes(self.config_raw)
        self.source_path.write_bytes(self.source_raw)
        self.content_path.write_bytes(self.content_raw)
        self.meta = {
            "schema": "fullmag.isolated-snapshot-start.v1",
            "allow_script_replay": False,
            "request_sha256": _sha(self.request_raw),
            "config_sha256": _sha(self.config_raw),
            "source_manifest_sha256": _sha(self.source_raw),
            "copied_content_sha256": _sha(self.content_raw),
            "restore_run_id": self.held_run,
        }
        self.start_path.write_bytes(_json_bytes(self.meta))
        self.receipt = {
            "schema_version": "runtime_service_retained_snapshot_validation.v1",
            "state": "validated-read-only",
            "request_sha256": _sha(self.request_raw),
            "config_sha256": _sha(self.config_raw),
            "source_manifest_sha256": _sha(self.source_raw),
            "run_ids": sorted([self.terminal_run, self.held_run]),
            "terminal_count": 1,
            "held_count": 1,
            "owner_changed": False,
            "compute_started": False,
        }
        self.service = RecordingService(self.receipt)
        self.fixed_paths = {
            Path("/opt/fullmag/control"): root / "control",
            Path("/state/runs"): self.state_runs,
            Path("/user-data"): self.user_data,
            Path("/opt/fullmag/control/runtime-control/local-live"): self.live_workspace,
        }

    @staticmethod
    def _add_payload(root, relative, data):
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        directories = sorted({str(parent) for parent in Path(relative).parents
                              if str(parent) not in {"", "."}})
        return {"directories": directories, "files": [{
            "path": relative,
            "size": len(data),
            "sha256": _sha(data),
        }]}

    def _mapped_path(self, value):
        path = Path(value)
        for fixed, actual in sorted(self.fixed_paths.items(), key=lambda pair: len(pair[0].parts), reverse=True):
            if path == fixed:
                return actual
            try:
                return actual / path.relative_to(fixed)
            except ValueError:
                continue
        return path

    def admit(self):
        environment = {
            gate.META_ENV: "/opt/fullmag/control/isolated-snapshot/start.json",
            gate.SHA_ENV: _sha(self.start_path.read_bytes()),
        }
        with mock.patch.object(gate, "Path", self._mapped_path), \
             mock.patch.dict(os.environ, environment):
            return gate.admit(self.paths, self.service)

    def _rewrite_meta(self, *, duplicate=False, extra=None, remove=None):
        value = dict(self.meta)
        if extra:
            value.update(extra)
        if remove:
            value.pop(remove, None)
        raw = _json_bytes(value)
        if duplicate:
            raw = raw.replace(b'"schema":', b'"schema":"duplicate","schema":', 1)
        self.start_path.write_bytes(raw)

    def test_corrupt_actual_payload_blocks_native_and_receipt(self):
        (self.state_runs / "held/result.json").write_bytes(b"xxxxx")
        with self.assertRaises(ValueError):
            self.admit()
        self.assertEqual(self.service.events, [])

    def test_incomplete_actual_payload_blocks_native_and_receipt(self):
        (self.state_runs / "held/result.json").unlink()
        with self.assertRaises(ValueError):
            self.admit()
        self.assertEqual(self.service.events, [])

    def test_missing_empty_live_workspace_directory_blocks_native_and_receipt(self):
        (self.live_workspace / "current" / "model.json").unlink()
        (self.live_workspace / "current").rmdir()
        self.live_record["tree"] = {"directories": ["current"], "files": []}
        self.source["live_workspace"] = self.live_record
        self.source_raw = _json_bytes(self.source)
        self.source_path.write_bytes(self.source_raw)
        self.request["source_manifest_sha256"] = _sha(self.source_raw)
        self.request_raw = _json_bytes(self.request)
        self.request_path.write_bytes(self.request_raw)
        self.content["live_workspace"] = self.live_record
        self.content_raw = _json_bytes(self.content)
        self.content_path.write_bytes(self.content_raw)
        self.meta.update({
            "request_sha256": _sha(self.request_raw),
            "source_manifest_sha256": _sha(self.source_raw),
            "copied_content_sha256": _sha(self.content_raw),
        })
        self.start_path.write_bytes(_json_bytes(self.meta))

        with self.assertRaisesRegex(ValueError, "directory tree is incomplete"):
            self.admit()
        self.assertEqual(self.service.events, [])

    def test_valid_first_admission_runs_native_before_publishing_receipt(self):
        result = self.admit()
        self.assertEqual(result, self.receipt)
        self.assertEqual([event[0] for event in self.service.events], ["native", "receipt"])
        self.assertFalse((self.paths.store / "runtime-services" / "OWNER.json").exists())
        self.assertEqual(json.loads(self._receipt_path().read_bytes()), self.receipt)

    def _receipt_path(self):
        return self.control / "native-validation.json"

    def test_existing_exact_receipt_skips_replay_after_ordinary_payload_edits(self):
        self.admit()
        self.service.events.clear()
        (self.state_runs / "held/result.json").write_bytes(b"edited afterward")
        self.user_data.mkdir(exist_ok=True)
        (self.user_data / "later-note.txt").write_text("ordinary later state", encoding="utf-8")
        result = self.admit()
        self.assertEqual(result, self.receipt)
        self.assertEqual(self.service.events, [])

    def test_existing_receipt_rejects_bool_for_count_and_unknown_fields(self):
        self.admit()
        for mutation in ("bool-count", "unknown-field"):
            with self.subTest(mutation=mutation):
                actual = dict(self.receipt)
                if mutation == "bool-count":
                    actual["terminal_count"] = True
                else:
                    actual["extra"] = "not part of receipt schema"
                self._receipt_path().write_bytes(_json_bytes(actual))
                self.service.events.clear()
                with self.assertRaisesRegex(ValueError, "admission differs"):
                    self.admit()
                self.assertEqual(self.service.events, [])

    def test_native_receipt_bool_count_is_not_accepted_as_integer(self):
        self.service.receipt = dict(self.receipt, terminal_count=True)
        with self.assertRaisesRegex(ValueError, "different evidence"):
            self.admit()
        self.assertEqual([event[0] for event in self.service.events], ["native"])
        self.assertFalse(self._receipt_path().exists())

    def test_start_document_requires_exact_seven_fields_and_rejects_duplicate_keys(self):
        for name, kwargs in (
            ("unknown", {"extra": {"operator_hint": "ignored"}}),
            ("missing", {"remove": "restore_run_id"}),
            ("duplicate", {"duplicate": True}),
        ):
            with self.subTest(name=name):
                self._rewrite_meta(**kwargs)
                with self.assertRaises(ValueError):
                    self.admit()
                self.assertEqual(self.service.events, [])

    def test_duplicate_request_keys_are_rejected(self):
        duplicate = self.request_raw.replace(
            b'"schema_version":"runtime_service_retained_snapshot_validation_request.v1"',
            b'"schema_version":"runtime_service_retained_snapshot_validation_request.v1",'
            b'"schema_version":"runtime_service_retained_snapshot_validation_request.v1"',
        )
        self.request_path.write_bytes(duplicate)
        self.meta["request_sha256"] = _sha(duplicate)
        self.start_path.write_bytes(_json_bytes(self.meta))
        with self.assertRaises(ValueError):
            self.admit()
        self.assertEqual(self.service.events, [])

if __name__=='__main__':unittest.main()
