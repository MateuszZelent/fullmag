from __future__ import annotations

import contextlib
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import docker_dev
import docker_isolated_control_prepare as prepare
from docker_build_control import BuildControlError, canonical


PROJECT = "fullmag-master"
VOLUME = "fullmag-control-fullmag-master"
PROJECT_ID = "source-project"
WORKTREE_ID = "docker-all-master"
RECOVERY_ID = "a" * 32
ATTEMPT = "b" * 32
BACKEND_IMAGE = "sha256:" + "c" * 64
PARENT_IMAGE = "sha256:" + "d" * 64


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def encode(value) -> bytes:
    return canonical(value)


class SnapshotControlFixture:
    def __init__(self, root: Path, *, file_count: int = 32):
        self.root = root
        self.file_count = file_count
        self.control = root / "namespace"
        self.runtime_control = self.control / "runtime-control"
        self.live = self.runtime_control / "local-live"
        self.snapshot = self.control / "isolated-snapshot"
        self.registry = root / "registry"
        self.runtime_control.mkdir(parents=True)
        self.live.mkdir()
        self.snapshot.mkdir()
        self.registry.mkdir()
        self.tree = self._live_tree()
        self.record, self.registry_document = self._control_documents()

    def _live_tree(self):
        directory = self.live / "current"
        directory.mkdir()
        files = []
        for index in range(self.file_count):
            raw = (f"retained-model-{index:02d}\n".encode())
            name = f"model-{index:02d}.json"
            path = directory / name
            path.write_bytes(raw)
            files.append({"path": "current/" + name, "size": len(raw), "sha256": sha(raw)})
        return {"directories": ["current"], "files": files}

    def _control_documents(self):
        live_workspace = {
            "schema": "fullmag.isolated-control-workspace.v1",
            "present": True,
            "tree": self.tree,
        }
        source = {
            "schema": "fullmag.isolated-session-snapshot-manifest.v1",
            "restore_run_id": "2" * 32,
            "live_workspace": live_workspace,
        }
        source_raw = encode(source)
        request = {
            "schema_version": "runtime_service_retained_snapshot_validation_request.v1",
            "request_id": "00000000-0000-0000-0000-000000000001",
            "source_manifest_sha256": sha(source_raw),
            "retained_terminal_runs": [{"run_id": "1" * 32}],
            "retained_held_manual_runs": [{"run_id": "2" * 32}],
        }
        request_raw = encode(request)
        config_raw = b'{"runtime":"retained"}'
        content_raw = encode({"state": {}, "user_data": {}, "live_workspace": live_workspace})
        native = {
            "schema_version": "runtime_service_retained_snapshot_validation.v1",
            "state": "validated-read-only",
            "request_sha256": sha(request_raw),
            "config_sha256": sha(config_raw),
            "source_manifest_sha256": sha(source_raw),
            "run_ids": ["1" * 32, "2" * 32],
            "terminal_count": 1,
            "held_count": 1,
            "owner_changed": False,
            "compute_started": False,
        }
        self.native_raw = encode(native)
        start = {
            "schema": "fullmag.isolated-snapshot-start.v1",
            "allow_script_replay": False,
            "request_sha256": sha(request_raw),
            "config_sha256": sha(config_raw),
            "source_manifest_sha256": sha(source_raw),
            "copied_content_sha256": sha(content_raw),
            "restore_run_id": "2" * 32,
        }
        documents = {
            "start.json": encode(start),
            "copied-content.json": content_raw,
            "source-manifest.json": source_raw,
            "request.json": request_raw,
            "original-config.json": config_raw,
        }
        startup = "namespaces/" + RECOVERY_ID + "/isolated-snapshot/"
        pins = {}
        for name, raw in documents.items():
            (self.snapshot / name).write_bytes(raw)
            pins[startup + name] = sha(raw)
        record = {
            "schema": "fullmag.docker-isolated-session-snapshot.v1",
            "state": "snapshot-copied-awaiting-native-admission",
            "recovery_id": RECOVERY_ID,
            "namespace": "namespaces/" + RECOVERY_ID,
            "previous_namespace": "",
            "compose_project": PROJECT,
            "control_volume": VOLUME,
            "source_project_id": PROJECT_ID,
            "source_worktree_id": WORKTREE_ID,
            "source_root": "/home/source/fullmag",
            "source_state_root": "/storage/state/source",
            "destination_state_root": "/storage/state/copy",
            "source_user_data_root": "/storage/user/source",
            "destination_user_data_root": "/storage/user/copy",
            "source_manifest_path": "namespace-recovery/" + RECOVERY_ID + "/source-manifest.json",
            "source_manifest_sha256": sha(source_raw),
            "request_path": "namespace-recovery/" + RECOVERY_ID + "/request.json",
            "request_sha256": sha(request_raw),
            "original_config_path": "namespace-recovery/" + RECOVERY_ID + "/original-config.json",
            "original_config_sha256": sha(config_raw),
            "old_container_ids": {"backend": "e" * 64, "frontend": "f" * 64},
            "old_image_id": BACKEND_IMAGE,
            "allow_old_request_replay": False,
            "allow_new_requests": False,
            "terminal_run_count": 1,
            "held_manual_run_count": 1,
            "old_development_attempt": ATTEMPT,
            "old_request_id": "old-request",
            "previous_registry_path": "namespace-recovery/" + RECOVERY_ID + "/previous-registry.json",
            "previous_registry_sha256": "1" * 64,
            "control_pins": pins,
        }
        registry = {
            "schema": "fullmag.docker-control-namespace-registry.v1",
            "recovery_id": RECOVERY_ID,
            "namespace": record["namespace"],
            "receipt_path": "namespace-recovery/" + RECOVERY_ID + "/terminal.json",
            "receipt_sha256": "3" * 64,
            "compose_project": PROJECT,
            "control_volume": VOLUME,
            "source_project_id": PROJECT_ID,
            "source_worktree_id": WORKTREE_ID,
        }
        (self.registry / "namespaces").mkdir()
        (self.registry / "namespaces" / "current.json").write_bytes(encode(registry))
        return record, registry

    def helper_payload(self):
        registry_raw = (self.registry / "namespaces" / "current.json").read_bytes()
        return {
            "schema": prepare.HELPER_INPUT_SCHEMA,
            "record": self.record,
            "control_volume": VOLUME,
            "registry_sha256": sha(registry_raw),
            "project": PROJECT,
            "project_id": PROJECT_ID,
            "worktree_id": WORKTREE_ID,
            "backend_image_id": BACKEND_IMAGE,
            "backend_image_attempt": ATTEMPT,
        }

    def run_helper(self, *, factory_mode: str | None = None):
        module_root = Path(__file__).resolve().parents[1] / "docker" / "all-in-one"
        script = prepare._control_prepare_helper_script(
            control_root=self.control,
            registry_root=self.registry,
            module_root=module_root,
            owner_uid=os.getuid(),
            owner_gid=os.getgid(),
        )
        if factory_mode:
            wrapper = f"""
import sys
sys.path.insert(0, {str(module_root)!r})
import backend_volume_cache_maintenance as maintenance
_ensure = maintenance._ensure_control_namespace
def _test_factory(*args, **kwargs):
    if {factory_mode!r} == 'before':
        raise RuntimeError('injected factory failure')
    result = _ensure(*args, **kwargs)
    if {factory_mode!r} == 'after':
        raise RuntimeError('injected post-factory failure')
    return result
maintenance._ensure_control_namespace = _test_factory
exec(compile({script!r}, '<control-prepare-helper>', 'exec'))
"""
            script = wrapper
        return subprocess.run(
            [sys.executable, "-I", "-B", "-c", script],
            input=encode(self.helper_payload()), capture_output=True, check=False,
        )


class HelperPreparationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.fixture = SnapshotControlFixture(Path(self.temporary.name))

    def source_tree_bytes(self):
        return {
            path.relative_to(self.fixture.live).as_posix(): path.read_bytes()
            for path in self.fixture.live.rglob("*") if path.is_file()
        }

    def test_fresh_prepare_uses_factory_and_restores_exact_32_file_workspace(self):
        before = self.source_tree_bytes()
        result = self.fixture.run_helper()
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt["state"], "initialized")
        self.assertEqual(receipt["live_workspace_file_count"], 32)
        self.assertIs(receipt["workspace_baseline_verified"], True)
        self.assertIs(receipt["native_admission_present"], False)
        self.assertIs(receipt["compute_started"], False)
        self.assertIs(receipt["source_unchanged"], True)
        self.assertEqual(self.source_tree_bytes(), before)
        self.assertTrue(self.fixture.live.is_dir())
        self.assertFalse((self.fixture.snapshot / "parked-local-live").exists())
        self.assertEqual(
            set(path.name for path in self.fixture.runtime_control.iterdir()),
            {"local-live", ".fullmag-toolchain-control-owner.json",
             ".fullmag-backend-cache-readback", "runtime-services"},
        )
        self.assertEqual(list((self.fixture.runtime_control / "runtime-services").iterdir()), [])

    def test_already_owned_rerun_validates_factory_without_park_transition(self):
        first = self.fixture.run_helper()
        self.assertEqual(first.returncode, 0, first.stderr.decode())
        (self.fixture.snapshot / "native-validation.json").write_bytes(self.fixture.native_raw)
        edited = self.fixture.live / "current" / "model-00.json"
        edited.write_bytes(b"legitimate later session edit\n")
        runtime_service = self.fixture.runtime_control / "runtime-service"
        runtime_service.mkdir()
        service_config = runtime_service / "config.json"
        service_config.write_bytes(b'{"session":"retained"}\n')
        second = self.fixture.run_helper()
        self.assertEqual(second.returncode, 0, second.stderr.decode())
        self.assertEqual(edited.read_bytes(), b"legitimate later session edit\n")
        receipt = json.loads(second.stdout)
        self.assertIs(receipt["workspace_baseline_verified"], False)
        self.assertIs(receipt["native_admission_present"], True)
        self.assertTrue(self.fixture.live.is_dir())
        self.assertEqual(service_config.read_bytes(), b'{"session":"retained"}\n')
        self.assertFalse((self.fixture.snapshot / "parked-local-live").exists())

    def test_factory_failure_restores_tree_and_next_attempt_resumes(self):
        before = self.source_tree_bytes()
        failed = self.fixture.run_helper(factory_mode="before")
        self.assertNotEqual(failed.returncode, 0)
        self.assertTrue(self.fixture.live.is_dir())
        parked = self.fixture.snapshot / "parked-local-live"
        self.assertFalse(parked.exists())
        self.assertEqual(self.source_tree_bytes(), before)
        resumed = self.fixture.run_helper()
        self.assertEqual(resumed.returncode, 0, resumed.stderr.decode())
        self.assertEqual(self.source_tree_bytes(), before)
        self.assertFalse(parked.exists())

    def test_failure_after_factory_is_resumable_without_replacing_markers(self):
        failed = self.fixture.run_helper(factory_mode="after")
        self.assertNotEqual(failed.returncode, 0)
        self.assertTrue(self.fixture.live.is_dir())
        self.assertFalse((self.fixture.snapshot / "parked-local-live").exists())
        resumed = self.fixture.run_helper()
        self.assertEqual(resumed.returncode, 0, resumed.stderr.decode())
        self.assertTrue(self.fixture.live.is_dir())
        self.assertFalse((self.fixture.snapshot / "parked-local-live").exists())

    def test_interrupted_parked_state_resumes_only_from_exact_tree(self):
        parked = self.fixture.snapshot / "parked-local-live"
        self.fixture.live.rename(parked)
        result = self.fixture.run_helper()
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertTrue(self.fixture.live.is_dir())
        self.assertFalse(parked.exists())

    def test_native_admission_before_unowned_marker_is_rejected(self):
        (self.fixture.snapshot / "native-validation.json").write_bytes(self.fixture.native_raw)
        result = self.fixture.run_helper()
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(self.fixture.live.is_dir())
        self.assertFalse((self.fixture.snapshot / "parked-local-live").exists())

    def test_empty_pinned_live_workspace_is_valid_and_reports_dynamic_count(self):
        with tempfile.TemporaryDirectory() as folder:
            fixture = SnapshotControlFixture(Path(folder), file_count=0)
            result = fixture.run_helper()
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            receipt = json.loads(result.stdout)
            self.assertEqual(receipt["live_workspace_file_count"], 0)
            self.assertTrue(fixture.live.is_dir())

    def test_pin_drift_or_payload_corruption_blocks_before_park(self):
        cases = ("pin", "payload")
        for case in cases:
            with self.subTest(case=case):
                with tempfile.TemporaryDirectory() as folder:
                    fixture = SnapshotControlFixture(Path(folder))
                    if case == "pin":
                        (fixture.snapshot / "start.json").write_bytes(b"{}")
                    else:
                        (fixture.live / "current" / "model-00.json").write_bytes(b"drift")
                    before = fixture.live.is_dir()
                    result = fixture.run_helper()
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(fixture.live.is_dir(), before)
                    self.assertFalse((fixture.snapshot / "parked-local-live").exists())

    def test_foreign_runtime_entry_or_park_target_blocks_without_overwrite(self):
        for kind in ("runtime-entry", "park-target"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as folder:
                fixture = SnapshotControlFixture(Path(folder))
                if kind == "runtime-entry":
                    (fixture.runtime_control / "foreign").write_bytes(b"keep")
                else:
                    parked = fixture.snapshot / "parked-local-live"
                    parked.mkdir()
                    (parked / "foreign").write_bytes(b"keep")
                result = fixture.run_helper()
                self.assertNotEqual(result.returncode, 0)
                self.assertTrue(fixture.live.is_dir())
                if kind == "park-target":
                    self.assertEqual((fixture.snapshot / "parked-local-live" / "foreign").read_bytes(), b"keep")

    def test_live_workspace_links_are_rejected_without_moving_payload(self):
        live_file = self.fixture.live / "current" / "model-00.json"
        replacement = live_file.with_suffix(".tmp")
        replacement.write_bytes(live_file.read_bytes())
        live_file.unlink()
        live_file.symlink_to(replacement)
        result = self.fixture.run_helper()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.fixture.snapshot / "parked-local-live").exists())
        self.assertTrue(live_file.is_symlink())


class ControllerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.fixture = SnapshotControlFixture(Path(self.temporary.name) / "controller")
        self.record = self.fixture.record
        self.registry = self.fixture.registry_document
        self.registry_raw = encode(self.registry)
        self.namespace_sha = sha(self.registry_raw)
        inputs = {"parent_image_id": PARENT_IMAGE, "files": [{"path": "backend.py", "sha256": "4" * 64}]}
        current = {
            "phase": "image-backend", "state": "succeeded", "attempt": ATTEMPT,
            "compose_project": PROJECT, "control_volume": VOLUME,
            "source_digest": sha(encode(inputs)), "inputs": inputs,
            "image_id": BACKEND_IMAGE,
        }
        self.documents = {
            "image-backend/current.json": current,
            f"image-backend/attempts/{ATTEMPT}/terminal.json": current,
            "isolated-snapshot/copied-content.json": json.loads(
                (self.fixture.snapshot / "copied-content.json").read_bytes()
            ),
        }
        self.control = FakeControl(self.record, self.registry, self.namespace_sha, self.documents)

    def test_uses_fresh_namespace_resolver_and_pinned_current_attempt_image(self):
        result = self.invoke()
        self.assertEqual(result["state"], "initialized")
        self.assertEqual(self.control.resolver_calls, 1)
        self.assertEqual(self.control.helper_images[-1], BACKEND_IMAGE)
        self.assertTrue(self.control.helper_initialize[-1])
        self.assertEqual(self.control.operation_phases, ["snapshot-control-prepare"])
        self.assertIn("snapshot-control-prepare.json", self.control.writes[-1][0])
        self.assertEqual(len(self.control.quiescence_calls), 1)
        project, identity, owned = self.control.quiescence_calls[0]
        self.assertEqual(project, PROJECT)
        self.assertEqual(identity, self.control.identity)
        self.assertEqual(owned, {
            "name": "fullmag-control-" + "4" * 32,
            "image": BACKEND_IMAGE,
            "volume": VOLUME,
            "attempt": "4" * 32,
            "namespace": self.control.namespace,
        })

    def test_existing_development_operation_is_reused_without_nested_lease(self):
        operation = {"root": "development/attempts/" + "5" * 32,
                     "receipt": {"phase": "development", "attempt": "5" * 32,
                                 "helper_container": "fullmag-control-" + "5" * 32}}
        self.control._active_operation = operation
        result = self.invoke(operation=operation)
        self.assertEqual(result["state"], "initialized")
        self.assertEqual(self.control.operation_phases, [])
        self.assertIn("snapshot_control_prepare", operation["receipt"])
        self.assertTrue(self.control.writes[-1][0].startswith(operation["root"]))
        self.assertEqual(len(self.control.quiescence_calls), 1)
        self.assertEqual(self.control.quiescence_calls[0][2], {
            "name": "fullmag-control-" + operation["receipt"]["attempt"],
            "image": "sha256:" + "9" * 64,
            "volume": VOLUME,
            "attempt": operation["receipt"]["attempt"],
            "namespace": self.control.namespace,
        })

    def test_unknown_helper_result_retains_daemon_pending_and_pinned_helper_identity(self):
        operation = {"root": "development/attempts/" + "5" * 32,
                     "receipt": {"phase": "development", "attempt": "5" * 32,
                                 "helper_container": "fullmag-control-" + "5" * 32},
                     "daemon_pending": False}
        self.control._active_operation = operation
        with self.assertRaises(prepare.ControlOutcomeUnknown):
            self.invoke(
                operation=operation,
                capture_side_effect=prepare.ControlOutcomeUnknown("timeout"),
            )

        helper_name = "fullmag-snapshot-control-" + operation["receipt"]["attempt"]
        self.assertIs(operation["daemon_pending"], True)
        self.assertEqual(operation["receipt"]["snapshot_control_helper"], helper_name)
        self.assertEqual(operation["receipt"]["snapshot_control_helper_image"], BACKEND_IMAGE)
        self.assertEqual(self.control.helper_names[-1], helper_name)
        self.assertIn(operation["root"] + "/receipt.json", [path for path, _ in self.control.writes])

    def test_mismatched_snapshot_record_or_attempt_image_does_not_launch_helper(self):
        for change in ("record", "attempt"):
            with self.subTest(change=change):
                control = FakeControl(self.record, self.registry, self.namespace_sha, self.documents)
                record = copy.deepcopy(self.record)
                documents = dict(control.documents)
                if change == "record":
                    record["recovery_id"] = "9" * 32
                else:
                    documents[f"image-backend/attempts/{ATTEMPT}/terminal.json"] = {
                        **documents[f"image-backend/attempts/{ATTEMPT}/terminal.json"],
                        "image_id": "sha256:" + "9" * 64,
                    }
                    control.documents = documents
                with self.assertRaises(BuildControlError):
                    self.invoke(control=control, record=record)
                self.assertEqual(control.helper_calls, [])

    def invoke(self, *, control=None, record=None, operation=None, capture_side_effect=None):
        control = control or self.control
        record = record or self.record
        registry = self.registry
        raw = self.registry_raw
        receipt = {
            "schema": prepare.RECEIPT_SCHEMA,
            "state": "initialized",
            "recovery_id": RECOVERY_ID,
            "namespace": "namespaces/" + RECOVERY_ID,
            "control_volume": VOLUME,
            "backend_image_id": BACKEND_IMAGE,
            "backend_image_attempt": ATTEMPT,
            "live_workspace_file_count": len(self.fixture.tree["files"]),
            "live_workspace_tree_sha256": "6" * 64,
            "workspace_baseline_verified": True,
            "native_admission_present": False,
            "control_marker_sha256": "7" * 64,
            "control_readback_sha256": "8" * 64,
            "source_unchanged": True,
            "compute_started": False,
        }
        completed = subprocess.CompletedProcess([], 0, stdout=encode(receipt), stderr=b"")

        def resolver(root_control, parsed, raw_registry):
            control.resolver_calls += 1
            self.assertEqual(root_control.namespace, "")
            self.assertEqual(raw_registry, raw)
            root_control.namespace = self.fixture.record["namespace"]
            root_control.namespace_registry = {
                **parsed,
                "retirement": self.fixture.record,
            }
            root_control.namespace_registry_sha256 = sha(raw_registry)

        def quiescence_guard(*args, **kwargs):
            control.quiescence_calls.append((args[0], args[1], kwargs["owned_control"]))

        capture_options = {"return_value": completed}
        if capture_side_effect is not None:
            capture_options = {"side_effect": capture_side_effect}

        with mock.patch.object(prepare, "_raw", return_value=raw), \
             mock.patch.object(prepare, "resolve_snapshot_namespace", side_effect=resolver), \
             mock.patch.object(prepare, "validate_snapshot_namespace_receipt"), \
             mock.patch.object(docker_dev, "_assert_no_running_fullmag", side_effect=quiescence_guard), \
             mock.patch.object(prepare, "bounded_capture", **capture_options):
            return prepare.prepare_snapshot_control(control, record, operation=operation)


class FakeControl:
    def __init__(self, record, registry, registry_sha, documents):
        self.project = PROJECT
        self.volume = VOLUME
        self.identity = {"project_id": PROJECT_ID, "worktree_id": WORKTREE_ID}
        self.namespace = record["namespace"]
        self.namespace_registry = {**registry, "retirement": record}
        self.namespace_registry_sha256 = registry_sha
        self.image = "sha256:" + "9" * 64
        self.documents = documents
        self.resolver_calls = 0
        self.helper_calls = []
        self.helper_images = []
        self.helper_names = []
        self.helper_initialize = []
        self.operation_phases = []
        self.writes = []
        self.stored_receipts = {}
        self.quiescence_calls = []
        self._active_operation = None

    def read(self, relative, *, optional=False):
        if relative not in self.documents:
            if optional:
                return None
            raise BuildControlError("missing test document " + relative)
        return copy.deepcopy(self.documents[relative])

    def helper_args(self, command, *, name=None, initialize=False):
        self.helper_calls.append(command)
        self.helper_images.append(self.image)
        self.helper_names.append(name)
        self.helper_initialize.append(initialize)
        return ["managed-helper", command]

    def write(self, relative, value):
        self.writes.append((relative, copy.deepcopy(value)))
        self.stored_receipts[relative] = copy.deepcopy(value)

    def _assert_live_operation_helper(self, operation):
        if self._active_operation is not operation:
            raise BuildControlError("no active test operation")

    @contextlib.contextmanager
    def operation(self, phase, inputs):
        self.operation_phases.append(phase)
        operation = {"root": phase + "/attempts/" + "4" * 32,
                     "receipt": {"phase": phase, "attempt": "4" * 32,
                                 "helper_container": "fullmag-control-" + "4" * 32}}
        self._active_operation = operation
        try:
            yield operation
        finally:
            self._active_operation = None


if __name__ == "__main__":
    unittest.main()
