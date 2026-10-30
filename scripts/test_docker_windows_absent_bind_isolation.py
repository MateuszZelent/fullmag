"""Synthetic absent-bind proof regressions; no Docker/WSL/native process or archive writes run."""
from contextlib import ExitStack, contextmanager
import copy
from pathlib import Path, PureWindowsPath
import stat
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest import mock

import docker_windows_absent_bind_isolation as absent
import docker_windows_bind_isolation as windows
from docker_build_control import BuildControlError
from docker_compose_identity import source_labels

SOURCE = r"D:\foreign\missing\state"
PROJECT = "fullmag-worktree-fixture-worktree"
SOURCE_ROOT = "/home/user/repo"
LAYOUT = {"repo_root": SOURCE_ROOT, "worktree_id": "fixture-worktree",
          "env": {"FULLMAG_PROJECT_ID": "fixture-project"}}
BACKEND_ID = "b" * 64
FOREIGN_ID = "a" * 64
IMAGE_ID = "sha256:" + "d" * 64
REFERENCE_ROOT = "/home/user/storage"


def _container(identifier, *, source=SOURCE, running=False):
    state = {
        "Status": "running" if running else "exited",
        "Running": running,
        "Paused": False,
        "Restarting": False,
        "OOMKilled": False,
        "Dead": False,
        "Pid": 4321 if running else 0,
        "ExitCode": 0,
        "StartedAt": "2026-10-30T01:00:00Z",
        "FinishedAt": "" if running else "2026-10-30T02:00:00Z",
        "Error": "",
    }
    return {
        "Id": identifier,
        "Image": IMAGE_ID,
        "Config": {"Labels": {}, "Env": ["PRIVATE=not-copied"]},
        "HostConfig": {"Binds": [source + ":/foreign"], "Mounts": []},
        "Mounts": [{"Type": "bind", "Source": source, "Destination": "/foreign", "RW": False}],
        "NetworkSettings": {"Networks": {"bridge": {"NetworkID": "e" * 64}}},
        "State": state,
    }


def _identity():
    return {
        "project_name": PROJECT,
        "network_name": PROJECT + "_fullmag",
        "project_id": "fixture-project",
        "worktree_id": "fixture-worktree",
        "checkout_kind": "worktree",
        "source_root": SOURCE_ROOT,
        "registered_name": "fixture-worktree",
    }


def _engine():
    return {
        "ID": "fixture-engine",
        "Name": "docker-desktop",
        "OperatingSystem": "Docker Desktop",
        "OSType": "linux",
        "KernelVersion": "6.6-microsoft-standard-WSL2",
    }


def _linux_identity():
    return {
        "source_root": "/home/user/repo",
        "reference_root": REFERENCE_ROOT,
        "source_inode": 101,
        "reference_inode": 102,
        "root_device": 2128,
        "root_mount": {"target": "/", "fstype": "ext4", "fsroot": "/"},
        "marker_sha256": "f" * 64,
        "engine_id": "fixture-engine",
    }


def _native_absence(source=SOURCE, *, missing_code=2):
    path = windows._windows_source_path(source)
    ancestor = PureWindowsPath(r"D:\foreign")
    chain = [ancestor, *ancestor.parents]
    return {
        "schema": absent.NATIVE_SCHEMA,
        "path": path,
        "missing_code": missing_code,
        "ancestor": str(ancestor),
        "ancestors": [
            {"path": str(item), "file_id": "0x" + format(index + 1, "032x"), "attributes": 0x10}
            for index, item in enumerate(chain)
        ],
        "volume": "D:",
        "fixed": True,
        "serial": "12ABCDEF",
        "filesystem": "NTFS",
    }


def _drvfs_mapping(source=SOURCE):
    return {
        "path": "/mnt/d/foreign/missing/state",
        "roundtrip": windows._windows_source_path(source),
        "ancestor": "/mnt/d/foreign",
        "ancestor_roundtrip": r"D:\foreign",
        "mount": {"target": "/mnt/d", "source": str(PureWindowsPath("D:/")), "fstype": "9p", "fsroot": "/"},
        "device": 111,
        "inode": 555,
        "mode": stat.S_IFDIR | 0o755,
    }


def _next(values):
    values = [copy.deepcopy(value) for value in values]
    index = 0

    def observe(*_args, **_kwargs):
        nonlocal index
        value = values[min(index, len(values) - 1)]
        index += 1
        return copy.deepcopy(value)

    return observe


@contextmanager
def _patched_observations(backend, foreign, *, foreign_views=None, native_views=None,
                          mapping_views=None, translated_path=None):
    foreign_views = foreign_views or [foreign]
    native_views = native_views or [_native_absence()]
    mapping_views = mapping_views or [_drvfs_mapping()]
    inspect_counts = {backend["Id"]: 0, foreign["Id"]: 0}
    inspected_foreign = [copy.deepcopy(value) for value in foreign_views]

    def inspect(identifier):
        if identifier == backend["Id"]:
            inspect_counts[identifier] += 1
            return copy.deepcopy(backend)
        if identifier == foreign["Id"]:
            index = inspect_counts[identifier]
            inspect_counts[identifier] += 1
            return copy.deepcopy(inspected_foreign[min(index, len(inspected_foreign) - 1)])
        raise AssertionError("producer inspected an unpinned container ID")

    with ExitStack() as stack:
        stack.enter_context(mock.patch.object(windows, "_inspect", side_effect=inspect))
        stack.enter_context(mock.patch("docker_development_inputs.select_checkout", return_value=mock.sentinel.checkout))
        stack.enter_context(mock.patch("fullmag_storage.resolve_layout", return_value=LAYOUT))
        stack.enter_context(mock.patch("fullmag_storage.worktree_records", return_value=[{"worktree": "/home/user/main"}]))
        stack.enter_context(mock.patch(
            "docker_linux_native_readmission.live_bind_path",
            side_effect=lambda value: Path(SOURCE_ROOT if value == "/host/repo" else REFERENCE_ROOT)))
        stack.enter_context(mock.patch.dict(windows.os.environ, {"WSL_DISTRO_NAME": "Ubuntu"}))
        stack.enter_context(mock.patch.object(windows, "_linux_identity", return_value=_linux_identity()))
        stack.enter_context(mock.patch.object(windows, "_engine", return_value=_engine()))
        stack.enter_context(mock.patch.object(absent, "_native", side_effect=_next(native_views)))
        if translated_path is None:
            stack.enter_context(mock.patch.object(absent, "_mapping", side_effect=_next(mapping_views)))
        else:
            stack.enter_context(mock.patch.object(
                windows, "_capture", return_value=str(translated_path).encode("utf-8")))
        archive = stack.enter_context(mock.patch("docker_bind_overlap_probe._archive_foreign_proof"))
        yield archive


class AbsentWindowsBindProofTests(unittest.TestCase):
    def setUp(self):
        identity = _identity()
        self.backend = _container(BACKEND_ID)
        self.backend["Config"]["Labels"].update(source_labels(identity))
        self.backend["Config"]["Labels"].update({
            "com.docker.compose.project": PROJECT, "com.docker.compose.service": "backend"})
        self.backend["Mounts"] = [
            {"Type": "bind", "Source": "/host/repo", "Destination": "/opt/fullmag/source", "RW": False},
            {"Type": "bind", "Source": "/host/storage", "Destination": "/state", "RW": True},
            {"Type": "volume", "Name": "fixture-control", "Destination": "/opt/fullmag/control", "RW": True},
            {"Type": "volume", "Name": "fixture-ledger", "Destination": "/host-ledger", "RW": True},
        ]
        self.foreign = _container(FOREIGN_ID)
        self.foreign["Config"]["Labels"]["com.docker.compose.project"] = "foreign-project"
        self.control = SimpleNamespace(project=PROJECT, identity=identity,
                                       volume="fixture-control", namespace="fixture-namespace")

    def produce(self):
        return absent.prove_absent_stopped_windows_bind(
            self.control, self.backend, self.foreign, SOURCE, Path(REFERENCE_ROOT))

    def test_producer_returns_typed_proof_accepted_by_real_validator(self):
        with _patched_observations(self.backend, self.foreign) as archive:
            proof = self.produce()
            self.assertEqual(set(proof), windows.PROOF_FIELDS)
            self.assertIs(absent.validate_absent_stopped_windows_bind_proof(
                proof, source=SOURCE, container_id=FOREIGN_ID), proof)
            self.assertEqual(proof["schema"], absent.SCHEMA)
            self.assertEqual(proof["decision"], "absent-stopped")
            self.assertEqual(proof["before"], proof["after"])
            self.assertEqual(proof["before"]["foreign"]["id"], FOREIGN_ID)
            self.assertEqual(proof["before"]["native"]["missing_code"], 2)
            self.assertNotIn("PRIVATE=not-copied", repr(proof))
            archive.assert_called_once_with(self.control, proof)

            archive.reset_mock()
            with self.assertRaises(BuildControlError):
                absent.validate_absent_stopped_windows_bind_proof(
                    proof, source=SOURCE + r"\other", container_id=FOREIGN_ID)
            with self.assertRaises(BuildControlError):
                absent.validate_absent_stopped_windows_bind_proof(
                    proof, source=SOURCE, container_id="c" * 64)
            archive.assert_not_called()

    def test_running_consumer_is_rejected_without_archiving(self):
        self.foreign = _container(FOREIGN_ID, running=True)
        with _patched_observations(self.backend, self.foreign) as archive:
            with self.assertRaisesRegex(BuildControlError, "exactly stopped"):
                self.produce()
            archive.assert_not_called()

    def test_consumer_change_between_observations_is_rejected_without_archiving(self):
        changed = copy.deepcopy(self.foreign)
        changed["State"]["StartedAt"] = "2026-10-30T03:00:00Z"
        changed["State"]["ExitCode"] = 7
        with _patched_observations(
                self.backend, self.foreign, foreign_views=[self.foreign, changed]) as archive:
            with self.assertRaisesRegex(BuildControlError, "changed during observation"):
                self.produce()
            archive.assert_not_called()

    def test_native_absence_must_be_confirmed_before_archiving(self):
        unconfirmed = _native_absence(missing_code=5)
        with _patched_observations(
                self.backend, self.foreign, native_views=[unconfirmed]) as archive:
            with self.assertRaisesRegex(BuildControlError, "Native absence evidence is malformed"):
                self.produce()
            archive.assert_not_called()

    def test_existing_translated_target_is_not_accepted_as_absent(self):
        with TemporaryDirectory() as directory:
            with _patched_observations(
                    self.backend, self.foreign, translated_path=Path(directory)) as archive:
                with self.assertRaisesRegex(BuildControlError, "Translated absent bind exists"):
                    self.produce()
                archive.assert_not_called()


if __name__ == "__main__":
    unittest.main()
