from __future__ import annotations

import importlib.util
import hashlib
import json
import os
import tempfile
import unittest
from unittest import mock
from pathlib import Path
import sys


HELPER_PATH = (
    Path(__file__).resolve().parents[1]
    / "docker"
    / "all-in-one"
    / "backend_volume_cache_maintenance.py"
)
SPEC = importlib.util.spec_from_file_location("backend_volume_cache_maintenance", HELPER_PATH)
assert SPEC is not None and SPEC.loader is not None
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)

BACKEND_DIR = HELPER_PATH.parent
sys.path.insert(0, str(BACKEND_DIR))
import backend_dev as backend  # noqa: E402


class BackendVolumeCacheMaintenanceTests(unittest.TestCase):
    @staticmethod
    def _test_owner() -> tuple[int, int]:
        # The production service is root + CAP_CHOWN. A non-root interpreted
        # test cannot chown to 65532, so it exercises the same contract with
        # the current test user while retaining the production default below.
        if os.geteuid() == 0:
            return helper.DEFAULT_OWNER_UID, helper.DEFAULT_OWNER_GID
        return os.getuid(), os.getgid()

    def _environment(self) -> dict[str, str]:
        return {
            "FULLMAG_BACKEND_CACHE_SCHEMA": helper.SCHEMA,
            "FULLMAG_BACKEND_CACHE_PROFILE": helper.PROFILE,
            "FULLMAG_BACKEND_CACHE_MAINTENANCE_PROFILE": helper.MAINTENANCE_PROFILE,
            "FULLMAG_BACKEND_CACHE_MAINTENANCE_ACTION": "ensure",
            "FULLMAG_BACKEND_CACHE_BUILD_ROOT": helper.BUILD_ROOT,
            "FULLMAG_BACKEND_CACHE_PACKAGE_ROOT": helper.PACKAGE_ROOT,
            "FULLMAG_BACKEND_CACHE_CONTROL_ROOT": helper.CONTROL_ROOT,
            "FULLMAG_BACKEND_CACHE_CONTROL_NAMESPACE": helper.CONTROL_BACKEND_ROOT,
            "FULLMAG_BACKEND_CACHE_OWNER_UID": str(helper.DEFAULT_OWNER_UID),
            "FULLMAG_BACKEND_CACHE_OWNER_GID": str(helper.DEFAULT_OWNER_GID),
            "FULLMAG_BACKEND_CACHE_PROJECT_ID": "fullmag",
            "FULLMAG_BACKEND_CACHE_KEY": "a" * 64,
            "FULLMAG_BACKEND_CACHE_UNIT_KEY": "b" * 64,
            "FULLMAG_BACKEND_CACHE_OWNER_ID": "b" * 64,
            "FULLMAG_BACKEND_CACHE_WORKTREE_ID": "docker-all-master-integration-20261017",
            "FULLMAG_BACKEND_CACHE_TOOLCHAIN_IMAGE_ID": "sha256:" + "c" * 64,
            "FULLMAG_BACKEND_CARGO_PROFILE": "backend-dev",
            "FULLMAG_BACKEND_RUNTIME_IMAGE_ID": "sha256:" + "d" * 64,
            "FULLMAG_BACKEND_CACHE_BUILD_VOLUME": "fullmag-cache-build",
            "FULLMAG_BACKEND_CACHE_PACKAGE_VOLUME": "fullmag-cache-package",
            "FULLMAG_BUILD_CONTROL_VOLUME": "fullmag-build-control-test",
            "FULLMAG_BACKEND_CACHE_CONTROL_VOLUME": "fullmag-build-control-test",
        }

    def _package_marker(self, uid: int, gid: int) -> tuple[bytes, bytes]:
        environment = self._environment()
        marker = {
            "schema": helper.OWNER_SCHEMA,
            "state": "owned",
            "unit_key": environment["FULLMAG_BACKEND_CACHE_UNIT_KEY"],
            "owner_id": environment["FULLMAG_BACKEND_CACHE_OWNER_ID"],
            "role": helper.PACKAGE_ROLE,
            "volume_name": environment["FULLMAG_BACKEND_CACHE_PACKAGE_VOLUME"],
            "uid": uid,
            "gid": gid,
        }
        marker_raw = helper._canonical(marker)
        return (
            marker_raw + b"\n",
            b"fullmag-cache-readback:"
            + hashlib.sha256(marker_raw).hexdigest().encode("ascii"),
        )

    def _write_owned_record(self, path: Path, value: bytes, mode: int, uid: int, gid: int) -> None:
        path.write_bytes(value)
        path.chmod(mode)
        if os.geteuid() == 0:
            os.chown(path, uid, gid)

    def _seed_legacy_package_pair(self, package: Path, uid: int, gid: int) -> tuple[bytes, bytes]:
        marker, readback = self._package_marker(uid, gid)
        self._write_owned_record(package / helper.MARKER_NAME, marker, 0o640, uid, gid)
        self._write_owned_record(package / helper.READBACK_NAME, readback, 0o600, uid, gid)
        return marker, readback

    def _ensure(self, build: Path, package: Path, **kwargs):
        control = package.parent / "control"
        control.mkdir(exist_ok=True)
        return helper.ensure(build, package, control_root=control, **kwargs)

    def test_fresh_and_reopen_prove_marker_readback_pair_without_host_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            build = root / "build"
            package = root / "package"
            build.mkdir()
            package.mkdir()
            uid, gid = self._test_owner()
            receipt = self._ensure(
                build,
                package,
                environment=self._environment(),
                owner_uid=uid,
                owner_gid=gid,
            )
            repeated = self._ensure(
                build,
                package,
                environment=self._environment(),
                owner_uid=uid,
                owner_gid=gid,
            )
            self.assertEqual(receipt, repeated)
            self.assertEqual(receipt["state"], "ready")
            self.assertEqual(receipt["probe"]["state"], "passed")
            self.assertEqual(receipt["probe"]["owner_uid"], uid)
            self.assertEqual(receipt["probe"]["owner_gid"], gid)
            self.assertEqual(set(receipt["markers"]), {"build", "package", "control"})
            self.assertNotIn(str(root), json.dumps(receipt))
            marker_roots = {
                build: build,
                package: package
                / backend.PACKAGE_DEVELOPMENT_DIRNAME
                / backend.PACKAGE_CACHE_CONTROL_DIRNAME,
                root / "control": root / "control" / "backend",
            }
            for path, marker_root in marker_roots.items():
                marker = marker_root / helper.MARKER_NAME
                readback = marker_root / helper.READBACK_NAME
                self.assertTrue(marker.is_file())
                self.assertTrue(readback.is_file())
                marker_document = json.loads(marker.read_text())
                if path == root / "control":
                    self.assertEqual(
                        marker_document,
                        {
                            "mount": helper.CONTROL_ROOT,
                            "namespace": helper.CONTROL_BACKEND_ROOT,
                            "role": helper.CONTROL_ROLE,
                            "schema": helper.CONTROL_NAMESPACE_SCHEMA,
                            "state": "owned",
                            "volume_name": self._environment()[
                                "FULLMAG_BUILD_CONTROL_VOLUME"
                            ],
                        },
                    )
                else:
                    self.assertEqual(marker_document["uid"], uid)
                self.assertTrue(readback.read_bytes().startswith(b"fullmag-cache-readback:"))
            self.assertFalse((package / helper.MARKER_NAME).exists())
            self.assertFalse((package / helper.READBACK_NAME).exists())
            control_root = root / "control"
            expected_namespaces = {
                "frontend": "frontend",
                "runtime-control": "runtime-control",
            }
            for name, relative in expected_namespaces.items():
                namespace = control_root / name
                marker_path = namespace / helper.CONTROL_MARKER_NAME
                marker_document = json.loads(marker_path.read_text(encoding="utf-8"))
                self.assertEqual(marker_document["state"], "owned")
                self.assertEqual(marker_document["volume_name"], self._environment()["FULLMAG_BUILD_CONTROL_VOLUME"])
                self.assertEqual(marker_document["namespace"], f"{helper.CONTROL_ROOT}/{relative}")
                self.assertEqual((namespace.stat().st_uid, namespace.stat().st_gid), (uid, gid))
            runtime_services = control_root / "runtime-control" / "runtime-services"
            self.assertTrue(runtime_services.is_dir())
            self.assertEqual((runtime_services.stat().st_uid, runtime_services.stat().st_gid), (uid, gid))
            self.assertFalse((runtime_services / helper.CONTROL_MARKER_NAME).exists())
            self.assertEqual(
                backend._package_children(
                    package, "empty backend package", exclude_development_control=True
                ),
                {},
            )

    def test_control_children_are_created_before_parent_ownership_handoff(self):
        # Emulate the missing DAC_OVERRIDE capability even on a test host
        # where root has broader privileges or the test runs unprivileged.
        opened = helper._open_child_directory
        finalize = helper._finalize_guest_root
        handed_off = set()

        def identity(fd):
            info = os.fstat(fd)
            return info.st_dev, info.st_ino

        def open_child(parent, name, uid, gid, label):
            if identity(parent) in handed_off:
                raise helper.MaintenanceError("parent was handed off before child creation")
            descriptor = opened(parent, name, uid, gid, label)
            handed_off.discard(identity(descriptor))
            return descriptor

        def handoff(directory, uid, gid):
            finalize(directory, uid, gid)
            handed_off.add(identity(directory))

        with tempfile.TemporaryDirectory() as temporary:
            control = Path(temporary) / "control"
            control.mkdir()
            uid, gid = self._test_owner()
            with mock.patch.object(helper, "_open_child_directory", side_effect=open_child), mock.patch.object(
                helper, "_finalize_guest_root", side_effect=handoff
            ):
                for _ in range(2):
                    helper._ensure_control_namespace(control, "control-test", uid, gid)
            self.assertTrue((control / "runtime-control" / "runtime-services").is_dir())

    def test_legacy_package_pair_moves_without_copy_or_user_file_loss(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            build = root / "build"
            package = root / "package"
            build.mkdir()
            package.mkdir()
            uid, gid = self._test_owner()
            marker, readback = self._seed_legacy_package_pair(package, uid, gid)
            user_file = package / "user-owned-input.txt"
            user_file.write_bytes(b"keep me")
            old_marker_stat = (package / helper.MARKER_NAME).stat()
            old_readback_stat = (package / helper.READBACK_NAME).stat()

            self._ensure(
                build,
                package,
                environment=self._environment(),
                owner_uid=uid,
                owner_gid=gid,
            )

            control = (
                package
                / backend.PACKAGE_DEVELOPMENT_DIRNAME
                / backend.PACKAGE_CACHE_CONTROL_DIRNAME
            )
            self.assertEqual((control / helper.MARKER_NAME).read_bytes(), marker)
            self.assertEqual((control / helper.READBACK_NAME).read_bytes(), readback)
            self.assertEqual((control / helper.MARKER_NAME).stat().st_ino, old_marker_stat.st_ino)
            self.assertEqual((control / helper.READBACK_NAME).stat().st_ino, old_readback_stat.st_ino)
            self.assertEqual(
                (control / helper.MARKER_NAME).stat().st_uid,
                old_marker_stat.st_uid,
            )
            self.assertEqual(
                (control / helper.MARKER_NAME).stat().st_mode & 0o777,
                old_marker_stat.st_mode & 0o777,
            )
            self.assertEqual(
                (control / helper.READBACK_NAME).stat().st_uid,
                old_readback_stat.st_uid,
            )
            self.assertEqual(
                (control / helper.READBACK_NAME).stat().st_mode & 0o777,
                old_readback_stat.st_mode & 0o777,
            )
            self.assertFalse((package / helper.MARKER_NAME).exists())
            self.assertFalse((package / helper.READBACK_NAME).exists())
            self.assertEqual(user_file.read_bytes(), b"keep me")

            backend._ensure_package_development_root(package)
            self.assertEqual(
                set(
                    backend._package_children(
                        package, "migrated backend package", exclude_development_control=True
                    )
                ),
                {"user-owned-input.txt"},
            )

            repeated = self._ensure(
                build,
                package,
                environment=self._environment(),
                owner_uid=uid,
                owner_gid=gid,
            )
            self.assertEqual(repeated["state"], "ready")
            self.assertEqual((control / helper.MARKER_NAME).stat().st_ino, old_marker_stat.st_ino)

    def test_partial_legacy_package_pair_is_rejected_without_touching_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            build = root / "build"
            package = root / "package"
            build.mkdir()
            package.mkdir()
            uid, gid = self._test_owner()
            marker, _ = self._seed_legacy_package_pair(package, uid, gid)
            readback = package / helper.READBACK_NAME
            readback.unlink()
            user_file = package / "user-owned-input.txt"
            user_file.write_bytes(b"keep me")
            with self.assertRaisesRegex(helper.MaintenanceError, "pair is incomplete"):
                self._ensure(
                    build,
                    package,
                    environment=self._environment(),
                    owner_uid=uid,
                    owner_gid=gid,
                )
            self.assertEqual((package / helper.MARKER_NAME).read_bytes(), marker)
            self.assertFalse(readback.exists())
            self.assertEqual(user_file.read_bytes(), b"keep me")
            self.assertFalse((package / backend.PACKAGE_DEVELOPMENT_DIRNAME).exists())

    def test_package_control_conflict_is_rejected_without_overwrite(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            build = root / "build"
            package = root / "package"
            build.mkdir()
            package.mkdir()
            uid, gid = self._test_owner()
            marker, readback = self._seed_legacy_package_pair(package, uid, gid)
            control = (
                package
                / backend.PACKAGE_DEVELOPMENT_DIRNAME
                / backend.PACKAGE_CACHE_CONTROL_DIRNAME
            )
            control.mkdir(parents=True)
            foreign_marker = control / helper.MARKER_NAME
            self._write_owned_record(foreign_marker, b"foreign\n", 0o640, uid, gid)
            with self.assertRaisesRegex(helper.MaintenanceError, "foreign or incomplete"):
                self._ensure(
                    build,
                    package,
                    environment=self._environment(),
                    owner_uid=uid,
                    owner_gid=gid,
                )
            self.assertEqual((package / helper.MARKER_NAME).read_bytes(), marker)
            self.assertEqual((package / helper.READBACK_NAME).read_bytes(), readback)
            self.assertEqual(foreign_marker.read_bytes(), b"foreign\n")

    def test_backend_package_control_rejects_unknown_cache_record(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            build = root / "build"
            package = root / "package"
            build.mkdir()
            package.mkdir()
            uid, gid = self._test_owner()
            self._ensure(
                build,
                package,
                environment=self._environment(),
                owner_uid=uid,
                owner_gid=gid,
            )
            control = (
                package
                / backend.PACKAGE_DEVELOPMENT_DIRNAME
                / backend.PACKAGE_CACHE_CONTROL_DIRNAME
            )
            (control / "unexpected-control-record").write_bytes(b"foreign")
            with self.assertRaisesRegex(backend.BackendBuildError, "incomplete or unknown"):
                backend._ensure_package_development_root(package)

    def test_hardlinked_package_records_fail_before_truncating_target(self):
        for record_name in (helper.MARKER_NAME, helper.READBACK_NAME):
            with self.subTest(record_name=record_name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                build = root / "build"
                package = root / "package"
                build.mkdir()
                package.mkdir()
                uid, gid = self._test_owner()
                self._ensure(
                    build,
                    package,
                    environment=self._environment(),
                    owner_uid=uid,
                    owner_gid=gid,
                )
                control = (
                    package
                    / backend.PACKAGE_DEVELOPMENT_DIRNAME
                    / backend.PACKAGE_CACHE_CONTROL_DIRNAME
                )
                record = control / record_name
                target = root / "outside-record"
                os.link(record, target)
                before = target.read_bytes()
                with self.assertRaisesRegex(helper.MaintenanceError, "unexpected link count"):
                    self._ensure(
                        build,
                        package,
                        environment=self._environment(),
                        owner_uid=uid,
                        owner_gid=gid,
                    )
                self.assertEqual(target.read_bytes(), before)
                self.assertEqual(record.read_bytes(), before)
                self.assertEqual(record.stat().st_nlink, 2)

    def test_legacy_package_symlink_is_rejected_without_following(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            build = root / "build"
            package = root / "package"
            build.mkdir()
            package.mkdir()
            uid, gid = self._test_owner()
            _, readback = self._seed_legacy_package_pair(package, uid, gid)
            marker = package / helper.MARKER_NAME
            marker.unlink()
            outside = root / "outside-marker"
            outside.write_bytes(b"outside")
            marker.symlink_to(outside)
            (package / helper.READBACK_NAME).write_bytes(readback)
            with self.assertRaises(helper.MaintenanceError):
                self._ensure(
                    build,
                    package,
                    environment=self._environment(),
                    owner_uid=uid,
                    owner_gid=gid,
                )
            self.assertTrue(marker.is_symlink())
            self.assertEqual(outside.read_bytes(), b"outside")
            self.assertFalse((package / backend.PACKAGE_DEVELOPMENT_DIRNAME).exists())

    def test_foreign_marker_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            build = root / "build"
            package = root / "package"
            build.mkdir()
            package.mkdir()
            marker = build / helper.MARKER_NAME
            marker.write_text(json.dumps({"foreign": True}), encoding="utf-8")
            before = marker.read_bytes()
            with self.assertRaisesRegex(helper.MaintenanceError, "foreign"):
                self._ensure(
                    build,
                    package,
                    environment=self._environment(),
                    owner_uid=self._test_owner()[0],
                    owner_gid=self._test_owner()[1],
                )
            self.assertEqual(marker.read_bytes(), before)

    def test_marker_symlink_is_rejected_without_following(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            build = root / "build"
            package = root / "package"
            build.mkdir()
            package.mkdir()
            target = root / "outside-marker"
            target.write_text("{}", encoding="utf-8")
            (build / helper.MARKER_NAME).symlink_to(target)
            with self.assertRaises(helper.MaintenanceError):
                self._ensure(
                    build,
                    package,
                    environment=self._environment(),
                    owner_uid=self._test_owner()[0],
                    owner_gid=self._test_owner()[1],
                )
            self.assertEqual(target.read_text(encoding="utf-8"), "{}")

    def test_backend_handoff_keeps_reopenable_directory_and_narrow_records(self):
        """Exercise the DAC-sensitive layout on a real temporary filesystem."""

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            build = root / "build"
            package = root / "package"
            build.mkdir()
            package.mkdir()
            build.chmod(0o755)
            package.chmod(0o755)
            uid, gid = self._test_owner()
            self._ensure(
                build,
                package,
                environment=self._environment(),
                owner_uid=uid,
                owner_gid=gid,
            )

            marker_roots = {
                build: build,
                package: package
                / backend.PACKAGE_DEVELOPMENT_DIRNAME
                / backend.PACKAGE_CACHE_CONTROL_DIRNAME,
            }
            for path, marker_root in marker_roots.items():
                self.assertEqual((path.stat().st_uid, path.stat().st_gid), (uid, gid))
                directory_mode = path.stat().st_mode & 0o777
                self.assertEqual(directory_mode & 0o700, 0o700)
                # A CAP_CHOWN-only reopen must be able to traverse/read the
                # backend-owned directory before taking record ownership.
                self.assertEqual(directory_mode & 0o005, 0o005)
                marker = marker_root / helper.MARKER_NAME
                readback = marker_root / helper.READBACK_NAME
                self.assertEqual((marker.stat().st_uid, marker.stat().st_gid), (uid, gid))
                self.assertEqual((readback.stat().st_uid, readback.stat().st_gid), (uid, gid))
                self.assertEqual(marker.stat().st_mode & 0o777, 0o640)
                self.assertEqual(readback.stat().st_mode & 0o777, 0o600)

            # A process interrupted while returning a record to the backend
            # owner is recoverable without widening either file's mode.
            if os.geteuid() == 0:
                for marker_root in marker_roots.values():
                    os.chown(marker_root / helper.MARKER_NAME, 0, 0)
                    os.chown(marker_root / helper.READBACK_NAME, 0, 0)
                self._ensure(
                    build,
                    package,
                    environment=self._environment(),
                    owner_uid=uid,
                    owner_gid=gid,
                )
                for marker_root in marker_roots.values():
                    self.assertEqual(
                        (marker_root / helper.MARKER_NAME).stat().st_uid,
                        uid,
                    )
                    self.assertEqual(
                        (marker_root / helper.READBACK_NAME).stat().st_uid,
                        uid,
                    )

    @staticmethod
    def _frontend_identity(uid: int | None = None, gid: int | None = None) -> dict[str, object]:
        return {
            "project_id": "fullmag-worktree-demo",
            "cache_key": "a" * 64,
            "volume_name": "fullmag-worktree-demo-frontend-dev-v2-" + "a" * 32,
            "uid": os.getuid() if uid is None else uid,
            "gid": os.getgid() if gid is None else gid,
        }

    def test_frontend_state_provisions_exact_parents_without_recursing(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary) / "state"
            state.mkdir()
            state.chmod(0o755)
            control_room = state / "workspace/apps/control-room"
            for name in ("app", "src", "public", "scripts"):
                (control_room / name / "nested").mkdir(parents=True)
                (control_room / name / "nested/source.ts").write_text(
                    "live source\n", encoding="utf-8"
                )
            user_file = control_room / "components.json"
            user_file.write_bytes(b"keep\n")
            identity = self._frontend_identity()

            first = helper._ensure_frontend_state_subtree(state, identity)
            second = helper._ensure_frontend_state_subtree(state, identity)

            self.assertEqual(first, second)
            self.assertEqual(
                first["directories"],
                [
                    helper.FRONTEND_STATE_ROOT,
                    helper.FRONTEND_WORKSPACE_ROOT,
                    helper.FRONTEND_APPS_ROOT,
                    helper.FRONTEND_APP_ROOT,
                    *[
                        f"{helper.FRONTEND_APP_ROOT}/{name}"
                        for name in helper.FRONTEND_LIVE_DIRECTORY_NAMES
                    ],
                ],
            )
            self.assertEqual(user_file.read_bytes(), b"keep\n")
            self.assertEqual(
                (control_room / "app/nested/source.ts").read_text(encoding="utf-8"),
                "live source\n",
            )
            for relative in (
                Path("workspace"),
                Path("workspace/apps"),
                Path("workspace/apps/control-room"),
                *(Path("workspace/apps/control-room") / name for name in helper.FRONTEND_LIVE_DIRECTORY_NAMES),
            ):
                directory = state / relative
                self.assertEqual((directory.stat().st_uid, directory.stat().st_gid),
                                 (identity["uid"], identity["gid"]))

    def test_frontend_state_foreign_marker_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary) / "state"
            state.mkdir()
            state.chmod(0o755)
            marker = state / helper.FRONTEND_STATE_MARKER_NAME
            marker.write_bytes(b'{"foreign":true}\n')
            before = marker.read_bytes()
            with self.assertRaises(helper.MaintenanceError):
                helper._ensure_frontend_state_subtree(state, self._frontend_identity())
            self.assertEqual(marker.read_bytes(), before)

    def test_frontend_state_recovers_root_parents_without_changing_live_files(self):
        if os.geteuid() != 0:
            self.skipTest("root ownership recovery requires CAP_CHOWN")
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary) / "state"
            control_room = state / "workspace/apps/control-room"
            for name in helper.FRONTEND_LIVE_DIRECTORY_NAMES:
                (control_room / name).mkdir(parents=True)
            live_file = control_room / "app/source.ts"
            live_file.write_bytes(b"source\n")
            identity = self._frontend_identity(helper.DEFAULT_OWNER_UID, helper.DEFAULT_OWNER_GID)

            helper._ensure_frontend_state_subtree(state, identity)

            for relative in (
                Path("."),
                Path("workspace"),
                Path("workspace/apps"),
                Path("workspace/apps/control-room"),
                *(Path("workspace/apps/control-room") / name for name in helper.FRONTEND_LIVE_DIRECTORY_NAMES),
            ):
                directory = state / relative
                self.assertEqual(
                    (directory.stat().st_uid, directory.stat().st_gid),
                    (helper.DEFAULT_OWNER_UID, helper.DEFAULT_OWNER_GID),
                )
            self.assertEqual(live_file.read_bytes(), b"source\n")
            self.assertEqual((live_file.stat().st_uid, live_file.stat().st_gid), (0, 0))

    def test_frontend_environment_requires_fixed_production_owner(self):
        environment = {
            "FULLMAG_FRONTEND_STATE_SCHEMA": helper.FRONTEND_STATE_SCHEMA,
            "FULLMAG_FRONTEND_STATE_PROFILE": helper.FRONTEND_STATE_PROFILE,
            "FULLMAG_FRONTEND_STATE_MAINTENANCE_PROFILE": helper.FRONTEND_STATE_MAINTENANCE_PROFILE,
            "FULLMAG_FRONTEND_STATE_MAINTENANCE_ACTION": "ensure",
            "FULLMAG_FRONTEND_STATE_ROOT": helper.FRONTEND_STATE_ROOT,
            "FULLMAG_FRONTEND_STATE_PROJECT_ID": "fullmag-worktree-demo",
            "FULLMAG_FRONTEND_STATE_CACHE_KEY": "a" * 64,
            "FULLMAG_FRONTEND_STATE_VOLUME": "fullmag-worktree-demo-frontend-dev-v2-" + "a" * 32,
            "FULLMAG_FRONTEND_STATE_OWNER_UID": "65532",
            "FULLMAG_FRONTEND_STATE_OWNER_GID": "65532",
        }
        identity = helper._frontend_environment(environment)
        self.assertEqual(identity["uid"], helper.DEFAULT_OWNER_UID)
        environment["FULLMAG_FRONTEND_STATE_OWNER_UID"] = str(os.getuid())
        if os.getuid() != helper.DEFAULT_OWNER_UID:
            with self.assertRaises(helper.MaintenanceError):
                helper._frontend_environment(environment)

    def test_production_contract_keeps_uid_and_fixed_guest_roots(self):
        self.assertEqual(helper.DEFAULT_OWNER_UID, 65532)
        self.assertEqual(helper.DEFAULT_OWNER_GID, 65532)
        self.assertEqual(helper.BUILD_ROOT, "/build")
        self.assertEqual(helper.PACKAGE_ROOT, "/opt/fullmag/package")


if __name__ == "__main__":
    unittest.main(verbosity=2)
