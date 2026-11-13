"""Pure mocked checks for the failed-run read-only evidence observer."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock


sys.path.insert(0, str(Path(__file__).resolve().parent))

import docker_volume_failed_run_resume_observer as observer
import test_docker_volume_failed_run_resume as validator_fixtures


def _raw(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode() + b"\n"


class _Control:
    project = "fullmag-observer-tests"

    def __init__(self, records):
        self.records = records
        self.read_paths = []

    def read_bytes(self, path, *, maximum):
        self.read_paths.append((path, maximum))
        value = self.records.get(path)
        if value is None:
            raise AssertionError("unexpected control read: " + path)
        return value


class FailedRunObserverTests(unittest.TestCase):
    def _runtime_records(self, fence_path=None):
        fence_path = fence_path or (
            "/opt/fullmag/runtime-control/runtime-service/api-failure-"
            + "a" * 32 + ".json"
        )
        return {
            "runtime-control/runtime-service/docker-all.json": _raw({
                "schema_version": "runtime_service_config.v2", "target_id": "docker-all",
                "store_root": "/state/runs/docker-all/session-store",
            }),
            "runtime-control/runtime-services/OWNER.json": _raw({
                "schema_version": "runtime_service_owner.v1", "state": "failed",
            }),
            "runtime-control/runtime-service/process-tree.json": _raw({
                "schema": "fullmag.docker-process-tree.v1", "state": "shutdown_unknown",
                "api_failure_fence": fence_path, "api_pid": 111,
            }),
            "runtime-control/runtime-service/api-failure-" + "a" * 32 + ".json": _raw({
                "schema": "fullmag.api-runtime-failure-fence.v1", "api_pid": 111,
            }),
        }

    def test_runtime_capture_returns_only_four_exact_raw_hash_pins(self):
        control = _Control(self._runtime_records())

        result = observer.capture_runtime_evidence(control, {}, {})

        self.assertEqual(set(result), {
            "runtime_config", "failed_owner", "terminal_process_receipt", "api_failure_fence",
        })
        self.assertEqual(result["runtime_config"]["sha256"], hashlib.sha256(
            control.records["runtime-control/runtime-service/docker-all.json"]
        ).hexdigest())
        self.assertEqual(control.read_paths[-1][0],
                         "runtime-control/runtime-service/api-failure-" + "a" * 32 + ".json")

    def test_runtime_capture_rejects_process_receipt_fence_outside_canonical_directory(self):
        control = _Control(self._runtime_records("/tmp/api-failure-" + "a" * 32 + ".json"))

        with self.assertRaisesRegex(observer.BuildControlError, "canonical API failure fence"):
            observer.capture_runtime_evidence(control, {}, {})

        self.assertEqual(len(control.read_paths), 3)

    def test_snapshot_capture_uses_pinned_linux_mounts_and_runs_the_existing_validator(self):
        snapshot = validator_fixtures._accepted_run_snapshot()
        certificate = {"engine_id": "test-engine", "owner_token": "test-owner"}
        store_id = "sha256:" + hashlib.sha256(observer.canonical({
            "schema": "fullmag.linux-native-store-identity.v1",
            "engine_id": certificate["engine_id"], "owner_token": certificate["owner_token"],
            "relative_state_path": "runs/docker-all/session-store",
        })).hexdigest()
        snapshot["host_ledger"]["store_id"] = store_id
        snapshot["host_ledger"]["reservations"][0]["store_id"] = store_id
        state_source = "/tmp/retained-state"
        certificate_source = state_source + "/linux-native-host.json"
        certificate_target = "/run/fullmag/linux-native-host.json"
        backend = {
            "Image": "sha256:" + "1" * 64,
            "Mounts": [{"Destination": certificate_target, "Type": "bind",
                        "Source": certificate_source, "RW": False}],
        }
        compose = {"services": {"backend": {
            "environment": {"FULLMAG_SESSION_STORAGE_PROFILE": "linux-native-v1"},
            "volumes": [{"type": "bind", "source": certificate_source,
                         "target": certificate_target, "read_only": True}],
            "x-fullmag-daemon-binds": {certificate_target: certificate_source},
        }}}
        control = _Control({})
        captured = SimpleNamespace(returncode=0, stdout=json.dumps(snapshot).encode(), stderr=b"")
        with (mock.patch("docker_volume_container_recovery._bind_source", return_value="/tmp/retained-state"),
              mock.patch("docker_volume_container_recovery._ledger_snapshot_mount",
                         return_value=("type=bind,src=/tmp/retained-ledger,dst=/host-ledger,readonly", None)),
              mock.patch("docker_volume_dev._retained_certificate", return_value=certificate),
              mock.patch.object(observer, "bounded_capture", return_value=captured) as run):
            result = observer.capture_accepted_run_snapshot(
                control, backend, compose, validator_fixtures.RUN_ID,
            )

        self.assertEqual(result["run_id"], validator_fixtures.RUN_ID)
        argv = run.call_args.args[0]
        self.assertIn("--read-only", argv)
        self.assertIn("--network", argv)
        self.assertIn("none", argv)
        self.assertIn("type=bind,src=/tmp/retained-state,dst=/state,readonly", argv)
        self.assertIn("type=bind,src=/tmp/retained-ledger,dst=/host-ledger,readonly", argv)
        self.assertIn("FULLMAG_HOST_CERTIFICATE=/state/linux-native-host.json", argv)
        self.assertNotIn("FULLMAG_HOST_CERTIFICATE=/state/.host.json", argv)

    def test_certificate_bind_must_be_unique_readonly_and_match_state_source(self):
        target = "/run/fullmag/linux-native-host.json"
        state_source = "/tmp/retained-state"
        source = state_source + "/linux-native-host.json"
        compose = {"services": {"backend": {
            "volumes": [{"type": "bind", "source": source,
                         "target": target, "read_only": True}],
        }}}
        backend = {"Mounts": [{"Destination": target, "Type": "bind",
                                "Source": source, "RW": False}]}

        self.assertEqual(observer._retained_certificate_bind_source(
            backend, compose, state_source), source)

        writable_runtime_mount = {"Mounts": [dict(backend["Mounts"][0], RW=True)]}
        with self.assertRaisesRegex(observer.BuildControlError, "read-only"):
            observer._retained_certificate_bind_source(
                writable_runtime_mount, compose, state_source)

        wrong_compose_source = {"services": {"backend": {
            "volumes": [{"type": "bind", "source": "/tmp/other/linux-native-host.json",
                         "target": target, "read_only": True}],
        }}}
        with self.assertRaisesRegex(observer.BuildControlError, "selected state"):
            observer._retained_certificate_bind_source(
                backend, wrong_compose_source, state_source)

        daemon_alias = (
            "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/qa/state/"
            "linux-native-host.json"
        )
        alias_backend = {"Mounts": [dict(backend["Mounts"][0], Source=daemon_alias)]}
        alias_compose = {"services": {"backend": {
            "volumes": [{"type": "bind", "source": source,
                         "target": target, "read_only": True}],
            "x-fullmag-daemon-binds": {target: daemon_alias},
        }}}
        self.assertEqual(observer._retained_certificate_bind_source(
            alias_backend, alias_compose, state_source), source)
        mismatched_alias = {"services": {"backend": {
            "volumes": [{"type": "bind", "source": source,
                         "target": target, "read_only": True}],
            "x-fullmag-daemon-binds": {target: "/run/desktop/other-source"},
        }}}
        with self.assertRaisesRegex(observer.BuildControlError, "alias differs"):
            observer._retained_certificate_bind_source(
                alias_backend, mismatched_alias, state_source)

    def test_task_admission_uses_lease_run_id_and_crosschecks_its_path_identity(self):
        run_id = validator_fixtures.RUN_ID
        task_id = "task-" + "1" * 64
        attempt_id = "attempt-" + "2" * 32
        resource_id = "docker-all.compute.cpu"
        admission = {
            "schema_version": "task_admission.v1",
            "expected_catalog_revision": 2,
            "queued_task": {"task_id": task_id, "lifecycle": "queued"},
            # The admitted task intentionally has no run_id; the lease owns it.
            "task": {"task_id": task_id, "attempt_id": attempt_id,
                     "ownership_epoch": 1, "resource_id": resource_id,
                     "lifecycle": "preparing"},
            "lease": {"schema_version": "resource_lease.v1", "run_id": run_id,
                      "task_id": task_id, "attempt_id": attempt_id,
                      "ownership_epoch": 1, "resource_id": resource_id,
                      "lease_token": "lease-" + "3" * 32, "state": "active"},
            "resolved_inputs_snapshot": {},
        }
        relative = ("runs/" + run_id + "/task_admissions/" + task_id + "/"
                    + attempt_id + ".json")

        self.assertEqual(observer._task_admission_identity(admission, relative, run_id), {
            "run_id": run_id, "task_id": task_id, "attempt_id": attempt_id,
            "ownership_epoch": 1, "resource_id": resource_id,
        })

        wrong_run = {**admission, "lease": {**admission["lease"], "run_id": "run-other"}}
        with self.assertRaisesRegex(ValueError, "selected run"):
            observer._task_admission_identity(wrong_run, relative, run_id)
        wrong_path = relative.replace(attempt_id, "attempt-" + "4" * 32)
        with self.assertRaisesRegex(ValueError, "path"):
            observer._task_admission_identity(admission, wrong_path, run_id)
        wrong_lease = {**admission, "lease": {**admission["lease"], "resource_id": "other"}}
        with self.assertRaisesRegex(ValueError, "lease identity"):
            observer._task_admission_identity(wrong_lease, relative, run_id)
        boolean_epoch = {**admission, "lease": {**admission["lease"],
                                                  "ownership_epoch": True}}
        with self.assertRaisesRegex(ValueError, "lease identity"):
            observer._task_admission_identity(boolean_epoch, relative, run_id)
        unexpected_task_run = {**admission, "task": {**admission["task"],
                                                       "run_id": "run-other"}}
        with self.assertRaisesRegex(ValueError, "task identity"):
            observer._task_admission_identity(unexpected_task_run, relative, run_id)

    def test_linux_store_identity_survives_certificate_rotation_without_reprobing_namespace(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary) / "state"
            store = state / "runs" / "docker-all" / "session-store"
            store.mkdir(parents=True)
            state_stat = state.stat()
            store_stat = store.stat()
            certificate = {
                "schema": "fullmag.linux-native-host.v1",
                "storage_profile": "linux-native-v1",
                "role": "session",
                "owner_scope": "docker-linux",
                "owner_token": "a" * 32,
                "engine_id": "sha256:" + "b" * 64,
                "host_root": str(state),
                "host_filesystem": "ext4",
                "host_platform": "linux",
                "host_device": state_stat.st_dev,
                "host_root_no_reparse": True,
                "host_inode": state_stat.st_ino,
                # These fields legitimately change during managed image reuse.
                "image_id": "sha256:" + "c" * 64,
                "source_commit": "d" * 40,
                "restart_verified": False,
            }

            identity = observer._stable_linux_host_identity(
                certificate, dict(certificate), state_stat.st_dev,
                state_stat.st_ino, store_stat.st_dev,
            )

        self.assertEqual(identity["owner_token"], "a" * 32)
        self.assertEqual(identity["engine_id"], "sha256:" + "b" * 64)
        self.assertNotIn("image_id", identity)
        self.assertNotIn("restart_verified", identity)

        script = observer._accepted_store_script()
        self.assertIn("def _stable_linux_host_identity", script)
        self.assertNotIn("linux_native_probe", script)
        self.assertNotIn("mount_namespace_inode", script)
        self.assertNotIn("require_restart=True", script)

    def test_linux_store_identity_rejects_owner_or_state_mount_drift(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary) / "state"
            store = state / "runs" / "docker-all" / "session-store"
            store.mkdir(parents=True)
            state_stat = state.stat()
            store_stat = store.stat()
            certificate = {
                "schema": "fullmag.linux-native-host.v1",
                "storage_profile": "linux-native-v1",
                "role": "session",
                "owner_scope": "docker-linux",
                "owner_token": "a" * 32,
                "engine_id": "engine-test",
                "host_root": str(state),
                "host_filesystem": "ext4",
                "host_platform": "linux",
                "host_device": state_stat.st_dev,
                "host_root_no_reparse": True,
                "host_inode": state_stat.st_ino,
            }
            other_owner = dict(certificate, owner_token="e" * 32)
            with self.assertRaisesRegex(ValueError, "owner marker"):
                observer._stable_linux_host_identity(
                    certificate, other_owner, state_stat.st_dev,
                    state_stat.st_ino, store_stat.st_dev,
                )
            with self.assertRaisesRegex(ValueError, "state mount"):
                observer._stable_linux_host_identity(
                    certificate, dict(certificate), state_stat.st_dev + 1,
                    state_stat.st_ino, store_stat.st_dev,
                )


if __name__ == "__main__":
    unittest.main()
