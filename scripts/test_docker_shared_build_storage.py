from __future__ import annotations

import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import subprocess

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))
import docker_shared_build_storage as storage  # noqa: E402


class VolumeFixture:
    def __init__(self, project_id):
        self.project_id = project_id
        self.descriptors = storage.volume_descriptors(project_id)
        self.documents = {}
        self.calls = []

    def _document(self, role):
        descriptor = self.descriptors[role]
        return {
            "Name": descriptor["name"],
            "Driver": "local",
            "Options": {},
            "Scope": "local",
            "Mountpoint": f"/var/lib/docker/volumes/{descriptor['name']}/_data",
            "Labels": descriptor["labels"],
        }

    def __call__(self, *arguments):
        self.calls.append(arguments)
        if arguments[:2] == ("volume", "inspect"):
            name = arguments[2]
            for role, descriptor in self.descriptors.items():
                if descriptor["name"] == name:
                    if role not in self.documents:
                        raise storage.VolumeNotFound(name)
                    return [self.documents[role]]
            raise AssertionError(name)
        if arguments[:2] == ("volume", "create"):
            role = next(
                role for role, descriptor in self.descriptors.items()
                if descriptor["name"] == arguments[-1]
            )
            self.documents[role] = self._document(role)
            return arguments[-1]
        raise AssertionError(arguments)


class SharedBuildStorageTests(unittest.TestCase):
    def test_volume_names_and_labels_are_project_stable_and_task_independent(self):
        first = storage.shared_volume_names("fullmag")
        second = storage.shared_volume_names("fullmag")
        different_project = storage.shared_volume_names("other-project")
        self.assertEqual(first, second)
        self.assertEqual(
            first[storage.PACKAGE_ROLE],
            "fullmag-shared-packages-v1-"
            + hashlib.sha256(b"fullmag").hexdigest()[:24],
        )
        self.assertNotEqual(first, different_project)
        for role in storage.VOLUME_ROLES:
            labels = storage.shared_volume_labels("fullmag", role)
            self.assertEqual(labels[storage.LABEL_SCHEMA], storage.SCHEMA)
            self.assertEqual(labels[storage.LABEL_PROJECT], "fullmag")
            self.assertEqual(labels[storage.LABEL_ROLE], role)
            self.assertNotIn(storage.LABEL_UNIT, labels)

    def test_descriptors_expose_root_alias_private_mount_and_cache_mounts(self):
        descriptors = storage.volume_descriptors("fullmag")
        self.assertEqual(
            [descriptors[role]["target"] for role in storage.VOLUME_ROLES],
            [storage.SHARED_BACKEND_TARGET, storage.SHARED_CARGO_TARGET, storage.SHARED_PNPM_TARGET],
        )
        key = "a" * 64
        package = storage.package_mount_descriptor("fullmag", key)
        self.assertEqual(package["target"], storage.PACKAGE_ROOT_TARGET)
        self.assertEqual(package["volume"]["subpath"], f"groups/{key}")
        mounts = storage.initializer_mount_descriptors("fullmag")
        self.assertEqual(len(mounts), 3)
        self.assertTrue(all("subpath" not in mount["volume"] for mount in mounts))
        runtime_dependencies = storage.dependency_mount_descriptors("fullmag")
        self.assertEqual(
            [mount["target"] for mount in runtime_dependencies],
            [storage.SHARED_CARGO_TARGET, storage.SHARED_PNPM_TARGET],
        )
        self.assertEqual(
            [mount["volume"]["subpath"] for mount in runtime_dependencies],
            [storage.CARGO_HOME_DIRECTORY, storage.PNPM_STORE_DIRECTORY],
        )
        self.assertEqual(
            storage.initializer_environment(key)["FULLMAG_SHARED_BACKEND_GROUP"],
            f"groups/{key}",
        )
        self.assertEqual(storage.initializer_labels("fullmag", key)[storage.LABEL_UNIT], key)

    def test_ensure_volumes_creates_only_exact_local_volumes(self):
        docker = VolumeFixture("fullmag")
        documents = storage.ensure_volumes(docker, "fullmag")
        self.assertEqual(set(documents), set(storage.VOLUME_ROLES))
        create_calls = [call for call in docker.calls if call[:2] == ("volume", "create")]
        self.assertEqual(len(create_calls), len(storage.VOLUME_ROLES))
        for call in create_calls:
            self.assertIn("--driver", call)
            self.assertIn("local", call)
            self.assertNotIn("--opt", call)
        calls_after_create = len(docker.calls)
        storage.ensure_volumes(docker, "fullmag")
        self.assertEqual(len(docker.calls) - calls_after_create, len(storage.VOLUME_ROLES))

    def test_ensure_volumes_rejects_foreign_backing_and_labels(self):
        for mutation in (
            lambda doc: doc.update(Driver="nfs"),
            lambda doc: doc.update(Options={"device": "/host/path"}),
            lambda doc: doc["Labels"].update({storage.LABEL_PROJECT: "other"}),
            lambda doc: doc["Labels"].update({"foreign": "label"}),
        ):
            docker = VolumeFixture("fullmag")
            docker.documents[storage.PACKAGE_ROLE] = docker._document(storage.PACKAGE_ROLE)
            mutation(docker.documents[storage.PACKAGE_ROLE])
            with self.subTest(document=docker.documents[storage.PACKAGE_ROLE]), self.assertRaises(storage.SharedBuildStorageError):
                storage.ensure_volumes(docker, "fullmag")

    def test_initializer_is_idempotent_with_concurrent_groups(self):
        namespace = {"__name__": "shared_initializer_test"}
        exec(compile(storage._INITIALIZER_PYTHON, "<shared-initializer>", "exec"), namespace)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = root / "package"
            cargo = root / "cargo"
            pnpm = root / "pnpm"
            package.mkdir()
            cargo.mkdir()
            pnpm.mkdir()
            uid, gid = os.getuid(), os.getgid()
            if os.geteuid() == 0:
                os.chown(package, 0, 0)
                os.chown(cargo, 0, 0)
                os.chown(pnpm, 0, 0)
                artifacts = package / "artifacts"
                artifacts.mkdir()
                os.chown(artifacts, storage.OWNER_UID, storage.OWNER_GID)
                retained = artifacts / "retained.data"
                retained.write_text("preserve", encoding="utf-8")
                os.chown(retained, 0, 0)
            keys = ("a" * 64, "b" * 64, "a" * 64, "b" * 64)
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                results = list(pool.map(
                    lambda key: namespace["initialize_guest_storage"](
                        str(package), str(cargo), str(pnpm), key, uid, gid
                    ),
                    keys,
                ))
            self.assertTrue(all(result["state"] == "ready" for result in results))
            self.assertEqual(sorted(path.name for path in (package / "groups").iterdir()), ["a" * 64, "b" * 64])
            expected = [
                package / "groups",
                package / "groups" / ("a" * 64),
                package / "groups" / ("b" * 64),
                package / "artifacts",
                package / "locks",
                package / "staging",
                cargo / "home",
                cargo / "home" / "registry",
                cargo / "home" / "git",
                pnpm / "store",
            ]
            for path in expected:
                self.assertTrue(path.is_dir())
                self.assertEqual((path.stat().st_uid, path.stat().st_gid), (uid, gid))
            if os.geteuid() == 0:
                self.assertEqual(
                    ((package / "artifacts" / "retained.data").stat().st_uid,
                     (package / "artifacts" / "retained.data").stat().st_gid),
                    (0, 0),
                )
            gc_lock = package / ".gc.lock"
            self.assertTrue(gc_lock.is_file())
            self.assertEqual((gc_lock.stat().st_uid, gc_lock.stat().st_gid), (uid, gid))
            self.assertEqual(os.stat(gc_lock).st_mode & 0o777, 0o600)
            lock = package / ".fullmag-shared-build-storage.init.lock"
            self.assertTrue(lock.is_file())
            self.assertEqual((lock.stat().st_uid, lock.stat().st_gid), (uid, gid))
            self.assertEqual(os.stat(lock).st_mode & 0o777, 0o600)

    @unittest.skipUnless(os.geteuid() == 0, "requires root to exercise UID 65532 access")
    def test_uid_65532_can_use_initialized_subpaths_without_owning_volume_roots(self):
        namespace = {"__name__": "shared_initializer_test"}
        exec(compile(storage._INITIALIZER_PYTHON, "<shared-initializer>", "exec"), namespace)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            root.chmod(0o755)
            package = root / "package"
            cargo = root / "cargo"
            pnpm = root / "pnpm"
            package.mkdir()
            cargo.mkdir()
            pnpm.mkdir()
            key = "f" * 64
            receipt = namespace["initialize_guest_storage"](
                str(package), str(cargo), str(pnpm), key,
                storage.OWNER_UID, storage.OWNER_GID,
            )
            self.assertEqual(receipt["state"], "ready")
            self.assertEqual((package.stat().st_uid, package.stat().st_gid), (0, 0))
            self.assertEqual((cargo.stat().st_uid, cargo.stat().st_gid), (0, 0))
            self.assertEqual((pnpm.stat().st_uid, pnpm.stat().st_gid), (0, 0))
            script = r"""
import fcntl
import os
import pathlib
import sys
os.setgid(65532)
os.setuid(65532)
package, cargo, pnpm, key = map(pathlib.Path, sys.argv[1:])
(package / "groups" / key / "uid-check").mkdir()
(package / "artifacts" / "uid-check").write_text("ok")
(cargo / "home" / "registry" / "uid-check").mkdir()
(pnpm / "store" / "uid-check").mkdir()
with (package / ".gc.lock").open("r+b") as stream:
    fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
try:
    (package / ".fullmag-shared-build-storage.init.lock").open("r+b")
except PermissionError:
    pass
else:
    raise AssertionError("UID 65532 opened the root-owned initializer lock")
"""
            result = subprocess.run(
                [sys.executable, "-B", "-c", script, str(package), str(cargo), str(pnpm), key],
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_initializer_rejects_symlink_directories_without_following(self):
        namespace = {"__name__": "shared_initializer_test"}
        exec(compile(storage._INITIALIZER_PYTHON, "<shared-initializer>", "exec"), namespace)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = root / "package"
            cargo = root / "cargo"
            pnpm = root / "pnpm"
            package.mkdir()
            cargo.mkdir()
            pnpm.mkdir()
            victim = root / "outside"
            victim.mkdir()
            (package / "groups").symlink_to(victim, target_is_directory=True)
            with self.assertRaises(namespace["InitError"]):
                namespace["initialize_guest_storage"](
                    str(package), str(cargo), str(pnpm), "c" * 64,
                    os.getuid(), os.getgid(),
                )
            self.assertEqual(list(victim.iterdir()), [])
            self.assertFalse((victim / ("c" * 64)).exists())

    def test_initializer_receipt_is_exact(self):
        key = "d" * 64
        receipt = {
            "schema": "fullmag.shared-build-storage-initializer.v1",
            "state": "ready",
            "unit_key": key,
            "group": f"groups/{key}",
            "owner_uid": 65532,
            "owner_gid": 65532,
        }
        self.assertEqual(storage.validate_initializer_receipt(receipt, key), receipt)
        with self.assertRaises(storage.SharedBuildStorageError):
            storage.validate_initializer_receipt({**receipt, "foreign": True}, key)


if __name__ == "__main__":
    unittest.main(verbosity=2)
