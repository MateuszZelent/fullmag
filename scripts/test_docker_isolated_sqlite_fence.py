from __future__ import annotations

import errno
import fcntl
import json
import os
from pathlib import Path
import shlex
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import docker_isolated_sqlite_fence as fence
from docker_build_control import BuildControlError
from docker_compose_identity import source_labels


class FakeControl:
    def __init__(self):
        self.project = "fullmag-worktree-fence-test"
        self.volume = "fullmag-shared-test"
        self.namespace = "groups/fence-test"
        self.namespace_registry_sha256 = "a" * 64
        self.image = "sha256:" + "b" * 64
        self.labels = {"org.fullmag.build-control": "v1"}
        self.identity = {
            "project_name": self.project,
            "project_id": "test-project",
            "worktree_id": "fence-test",
            "checkout_kind": "worktree",
        }

    def _namespace_guard(self, script):
        return "test namespace-registry; " + script

    def helper_args(self, script, *, name=None, initialize=False):
        if initialize:
            raise AssertionError("the fence helper must use helper_args without initialization")
        script = self._namespace_guard(script)
        args = [
            "docker", "--context", "desktop-linux", "run", "--rm", "-i",
            "--pull", "never", "--network", "none", "--runtime", "runc",
            "--read-only", "--cap-drop", "ALL", "--security-opt",
            "no-new-privileges:true", "--pids-limit", "32", "--memory", "64m",
            "--cpus", "0.25", "--env", "NVIDIA_VISIBLE_DEVICES=void",
            "--mount", ("type=volume,src=" + self.volume + ",dst=/control,"
                        "volume-nocopy,volume-subpath=" + self.namespace),
            "--mount", ("type=volume,src=" + self.volume
                        + ",dst=/registry,readonly,volume-nocopy"),
            "--user", "65532:65532",
        ]
        labels = {
            "com.docker.compose.project": self.project,
            "com.docker.compose.service": "build-control",
            **self.labels,
            **source_labels(self.identity),
        }
        for key, value in labels.items():
            args.extend(["--label", key + "=" + value])
        if name:
            args.extend(["--name", name])
        return [*args, "--entrypoint", "/bin/bash", self.image,
                "-euo", "pipefail", "-c", script]


def _mount_spec(args, target):
    specs = []
    for index, value in enumerate(args[:-1]):
        if value == "--mount" and (",dst=" + target + ",") in ("," + args[index + 1] + ","):
            specs.append(args[index + 1])
    return specs


def _volume_options(source, target, *, readonly, subpath=None):
    options = {"NoCopy": True}
    if subpath is not None:
        options["Subpath"] = subpath
    return {"Type": "volume", "Source": source, "Target": target,
            "ReadOnly": readonly, "VolumeOptions": options}


def _bind_options(source, target, *, readonly):
    return {"Type": "bind", "Source": source, "Target": target,
            "ReadOnly": readonly}


def _inspection(control, args, name, requested_source, daemon_source, *, user, groups,
                database_read_only):
    host_mounts = [
        _volume_options(control.volume, "/control", readonly=True,
                        subpath=control.namespace),
        _volume_options(control.volume, "/registry", readonly=True),
        _bind_options(requested_source, "/sqlite-source/workspace.db",
                      readonly=database_read_only),
    ]
    mounts = [
        {"Type": "volume", "Name": control.volume, "Source": "/docker/control",
         "Destination": "/control", "RW": False},
        {"Type": "volume", "Name": control.volume, "Source": "/docker/control",
         "Destination": "/registry", "RW": False},
        {"Type": "bind", "Source": daemon_source,
         "Destination": "/sqlite-source/workspace.db",
         "RW": not database_read_only},
    ]
    labels = {
        "com.docker.compose.project": control.project,
        "com.docker.compose.service": "build-control",
        **control.labels,
        **source_labels(control.identity),
    }
    return {
        "Id": "c" * 64,
        "Name": "/" + name,
        "Image": control.image,
        "Config": {
            "Image": control.image,
            "Cmd": args[-4:],
            "Entrypoint": ["/bin/bash"],
            "User": user,
            "Env": ["NVIDIA_VISIBLE_DEVICES=void"],
            "OpenStdin": True,
            "Tty": False,
            "Labels": labels,
        },
        "State": {"Running": True, "Pid": 42},
        "HostConfig": {
            "NetworkMode": "none", "Runtime": "runc",
            "ReadonlyRootfs": True, "PidsLimit": 32,
            "Memory": 64 * 1024 * 1024, "NanoCpus": 250_000_000,
            "CapDrop": ["ALL"], "CapAdd": [],
            "SecurityOpt": ["no-new-privileges:true"], "Privileged": False,
            "AutoRemove": True, "PidMode": "", "IpcMode": "private",
            "GroupAdd": [str(value) for value in groups],
            "Binds": None, "Tmpfs": None, "Devices": [], "DeviceRequests": [],
            "Mounts": host_mounts,
        },
        "Mounts": mounts,
    }


class IsolatedSqliteFenceTests(unittest.TestCase):
    def setUp(self):
        self.control = FakeControl()
        self.requested_source = "/home/test/storage/user-data/workspace.db"
        self.daemon_source = "/run/desktop/mnt/host/wsl/fullmag/user-data/workspace.db"
        self.name = "fullmag-sqlite-fence-" + "d" * 32

    def backend(self):
        return {
            "Id": "d" * 64,
            "Image": "sha256:" + "e" * 64,
            "Config": {"Labels": {
                "com.docker.compose.project": self.control.project,
                "com.docker.compose.service": "backend",
                **source_labels(self.control.identity),
            }},
            "State": {"Running": False},
            "Mounts": [{
                "Type": "bind", "Source": "/home/test/storage/user-data",
                "Destination": "/user-data", "RW": True,
            }],
        }

    def test_helper_args_are_same_project_control_only_and_database_fenced(self):
        args = fence._managed_helper_args(
            self.control, "print READY", name=self.name,
            database_source=self.requested_source, user="65532:65532",
            group_add=(), database_read_only=True,
        )
        self.assertEqual(_mount_spec(args, "/control")[0].split(","), [
            "type=volume", "src=" + self.control.volume, "dst=/control", "readonly",
            "volume-nocopy", "volume-subpath=" + self.control.namespace,
        ])
        self.assertEqual(_mount_spec(args, "/sqlite-source/workspace.db"), [
            "type=bind,src=" + self.requested_source
            + ",dst=/sqlite-source/workspace.db,readonly"
        ])
        self.assertNotIn("--cap-add", args)
        self.assertEqual(args[args.index("--cap-drop") + 1], "ALL")
        self.assertEqual(args[args.index("--user") + 1], "65532:65532")
        self.assertEqual(args[args.index("--network") + 1], "none")
        self.assertEqual(args[args.index("--runtime") + 1], "runc")

    def test_owner_helper_has_only_database_rw_and_owner_identity(self):
        args = fence._managed_helper_args(
            self.control, "print READY", name=self.name,
            database_source=self.daemon_source, user="65532:1234",
            group_add=(65532,), database_read_only=False,
        )
        db_spec = _mount_spec(args, "/sqlite-source/workspace.db")
        self.assertEqual(db_spec, [
            "type=bind,src=" + self.daemon_source
            + ",dst=/sqlite-source/workspace.db"
        ])
        self.assertEqual(args[args.index("--user") + 1], "65532:1234")
        self.assertEqual(args[args.index("--group-add") + 1], "65532")
        self.assertNotIn("--cap-add", args)

    def test_host_inspect_may_omit_default_readwrite_bind_flag_only(self):
        args = fence._managed_helper_args(
            self.control, "print READY", name=self.name,
            database_source=self.daemon_source, user="65532:1234",
            group_add=(65532,), database_read_only=False,
        )
        expected = dict(
            control=self.control, document=_inspection(
                self.control, args, self.name, self.daemon_source,
                self.daemon_source, user="65532:1234", groups=(65532,),
                database_read_only=False,
            ), name=self.name, arguments=args,
            host_mount_source=self.daemon_source,
            expected_daemon_source=self.daemon_source,
            user="65532:1234", group_add=(65532,), database_read_only=False,
        )
        expected["document"]["HostConfig"]["Mounts"][2].pop("ReadOnly")
        self.assertEqual(fence._validate_helper_inspection(**expected), "c" * 64)

        for invalid_read_only in (True, "false"):
            changed = json.loads(json.dumps(expected["document"]))
            changed["HostConfig"]["Mounts"][2]["ReadOnly"] = invalid_read_only
            self.assertRejectedInspection(expected, changed)

    def test_helper_uses_pinned_backend_image_without_mutating_control(self):
        original_image = self.control.image
        backend = {"Image": "sha256:" + "c" * 64}
        helper_control = fence._python_helper_control(self.control, backend)
        self.assertEqual(helper_control.image, backend["Image"])
        self.assertEqual(self.control.image, original_image)
        with self.assertRaises(BuildControlError):
            fence._python_helper_control(self.control, {"Image": "moving:tag"})

    def test_helper_auth_rejects_capability_mount_and_container_id_drift(self):
        args = fence._managed_helper_args(
            self.control, "print READY", name=self.name,
            database_source=self.requested_source, user="65532:65532",
            group_add=(), database_read_only=True,
        )
        expected = dict(
            control=self.control, document=_inspection(
                self.control, args, self.name, self.requested_source,
                self.daemon_source, user="65532:65532", groups=(),
                database_read_only=True,
            ), name=self.name, arguments=args,
            host_mount_source=self.requested_source,
            expected_daemon_source=self.daemon_source,
            user="65532:65532", group_add=(), database_read_only=True,
        )
        self.assertEqual(fence._validate_helper_inspection(**expected), "c" * 64)

        inherited = json.loads(json.dumps(expected["document"]))
        inherited["Config"]["Labels"]["org.opencontainers.image.title"] = "CUDA base image"
        inherited_expected = dict(expected, document=inherited)
        self.assertEqual(fence._validate_helper_inspection(**inherited_expected), "c" * 64)

        changed = json.loads(json.dumps(expected["document"]))
        changed["Config"]["Labels"]["com.docker.compose.project"] = "foreign-project"
        self.assertRejectedInspection(expected, changed)

        changed = json.loads(json.dumps(expected["document"]))
        source_label = next(iter(source_labels(self.control.identity)))
        changed["Config"]["Labels"][source_label] = "foreign-source"
        self.assertRejectedInspection(expected, changed)

        changed = json.loads(json.dumps(expected["document"]))
        changed["HostConfig"]["CapAdd"] = ["DAC_OVERRIDE"]
        self.assertRejectedInspection(expected, changed)

        changed = json.loads(json.dumps(expected["document"]))
        changed["HostConfig"]["PidsLimit"] = 4096
        self.assertRejectedInspection(expected, changed)

        changed = json.loads(json.dumps(expected["document"]))
        changed["Mounts"][2]["Source"] = self.daemon_source + "/other"
        self.assertRejectedInspection(expected, changed)

        changed = json.loads(json.dumps(expected["document"]))
        changed["HostConfig"]["GroupAdd"] = ["7"]
        self.assertRejectedInspection(expected, changed)

        changed = json.loads(json.dumps(expected["document"]))
        changed["Id"] = "not-a-full-container-id"
        self.assertRejectedInspection(expected, changed)

    def test_readonly_probe_accepts_only_canonical_or_known_wsl_source_alias(self):
        args = fence._managed_helper_args(
            self.control, "print READY", name=self.name,
            database_source=self.requested_source, user="65532:65532",
            group_add=(), database_read_only=True,
        )

        for host_source, daemon_source in (
            (self.requested_source, self.requested_source),
            (self.daemon_source, self.daemon_source),
        ):
            with self.subTest(host_source=host_source):
                document = _inspection(
                    self.control, args, self.name, host_source, daemon_source,
                    user="65532:65532", groups=(), database_read_only=True,
                )
                self.assertEqual(fence._validate_helper_inspection(
                    control=self.control, document=document, name=self.name,
                    arguments=args, host_mount_source=self.requested_source,
                    expected_daemon_source=None, user="65532:65532",
                    group_add=(), database_read_only=True,
                ), "c" * 64)

        for host_source, daemon_source in (
            ("/var/lib/docker/foreign/workspace.db", "/var/lib/docker/foreign/workspace.db"),
            (self.daemon_source, self.requested_source),
        ):
            with self.subTest(rejected_source=host_source), self.assertRaises(BuildControlError):
                document = _inspection(
                    self.control, args, self.name, host_source, daemon_source,
                    user="65532:65532", groups=(), database_read_only=True,
                )
                fence._validate_helper_inspection(
                    control=self.control, document=document, name=self.name,
                    arguments=args, host_mount_source=self.requested_source,
                    expected_daemon_source=None, user="65532:65532",
                    group_add=(), database_read_only=True,
                )

    def test_each_phase_accepts_its_own_ephemeral_wsl_alias_for_the_same_requested_file(self):
        # Docker Desktop can allocate a daemon-private alias per container.
        # The owner alias is accepted only after the helper's lock conflicts
        # with this exact host FD, and HostConfig/Mounts agree within inspect.
        aliases = (
            "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu2/"
            + "a" * 64 + "/workspace.db",
            "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu2/"
            + "b" * 64 + "/workspace.db",
        )
        read_only_args = fence._managed_helper_args(
            self.control, "print READY", name=self.name,
            database_source=self.requested_source, user="65532:65532",
            group_add=(), database_read_only=True,
        )
        probe_document = _inspection(
            self.control, read_only_args, self.name, aliases[0], aliases[0],
            user="65532:65532", groups=(), database_read_only=True,
        )
        self.assertEqual(fence._validate_helper_inspection(
            control=self.control, document=probe_document, name=self.name,
            arguments=read_only_args, host_mount_source=self.requested_source,
            expected_daemon_source=None, user="65532:65532", group_add=(),
            database_read_only=True,
        ), "c" * 64)

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            database = root / "workspace.db"
            import sqlite3
            with sqlite3.connect(database) as connection:
                connection.execute("CREATE TABLE fixture(value INTEGER)")
                connection.execute("INSERT INTO fixture VALUES (1)")
            original_bytes = database.read_bytes()
            host_fd = os.open(database, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            process = None
            read_lock_held = False
            try:
                fence._acquire_host_read_lock(host_fd)
                read_lock_held = True
                owner_program = shlex.split(fence._owner_script())[-1].replace(
                    'Path("/sqlite-source/workspace.db")', f"Path({str(database)!r})")
                process = subprocess.Popen(
                    [sys.executable, "-I", "-B", "-c", owner_program],
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE, bufsize=0,
                )
                process._fullmag_helper_name = self.name
                blocked = json.loads(fence.retained._readline(process, timeout=10))
                self.assertEqual(blocked["state"], "BLOCKED")
                host_info = os.fstat(host_fd)
                self.assertEqual(
                    (blocked["device"], blocked["inode"], blocked["uid"], blocked["gid"]),
                    (host_info.st_dev, host_info.st_ino, host_info.st_uid, host_info.st_gid),
                )
                fence._release_host_read_lock(host_fd)
                read_lock_held = False
                process.stdin.write(b"GO\n")
                process.stdin.flush()
                ready = json.loads(fence.retained._readline(process, timeout=10))
                self.assertEqual(ready["state"], "READY")

                owner_user = str(host_info.st_uid) + ":" + str(host_info.st_gid)
                owner_args = fence._managed_helper_args(
                    self.control, "print READY", name=self.name,
                    database_source=str(database), user=owner_user,
                    group_add=(), database_read_only=False,
                )
                owner_document = _inspection(
                    self.control, owner_args, self.name, aliases[1], aliases[1],
                    user=owner_user, groups=(), database_read_only=False,
                )
                with self.assertRaises(BuildControlError):
                    fence._validate_helper_inspection(
                        control=self.control, document=owner_document, name=self.name,
                        arguments=owner_args, host_mount_source=str(database),
                        expected_daemon_source=None, user=owner_user, group_add=(),
                        database_read_only=False,
                    )
                changed = json.loads(json.dumps(owner_document))
                changed["HostConfig"]["Mounts"][2]["Source"] = aliases[0]
                with self.assertRaises(BuildControlError):
                    fence._owner_inspect_source(changed, str(database))
                with patch.object(
                        fence, "docker_capture",
                        return_value=SimpleNamespace(
                            stdout=json.dumps([owner_document]).encode("utf-8"))):
                    self.assertEqual(fence._inspect_helper(
                        self.control, process, self.name, owner_args,
                        requested_source=str(database), expected_daemon_source=None,
                        user=owner_user, group_add=(), database_read_only=False,
                        owner_lock_fd=host_fd,
                    )[0], "c" * 64)
            finally:
                if read_lock_held:
                    fence._release_host_read_lock(host_fd)
                if process is not None:
                    if process.stdin is not None and not process.stdin.closed:
                        process.stdin.close()
                    if process.poll() is None:
                        released = json.loads(fence.retained._readline(process, timeout=10))
                        self.assertEqual(released["state"], "RELEASED")
                    self.assertEqual(process.wait(timeout=10), 0)
                    if process.stdout is not None:
                        process.stdout.close()
                    if process.stderr is not None:
                        process.stderr.close()
                fence._prove_host_read_lock_available(host_fd)
                os.close(host_fd)
            self.assertEqual(database.read_bytes(), original_bytes)

    def test_workspace_fence_verify_callback_is_not_in_json_receipt(self):
        calls = []
        receipt = fence.WorkspaceDatabaseFence(
            {"database_present": True, "inode": 7}, lambda: calls.append("verified"))
        receipt.verify()
        self.assertEqual(calls, ["verified"])
        self.assertEqual(json.loads(json.dumps(receipt)),
                         {"database_present": True, "inode": 7})

    def test_absent_workspace_fence_verify_rejects_a_later_database(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaisesRegex(
                    BuildControlError,
                    "Workspace database appeared during absent-source validation"):
                with patch.object(fence, "validate_host_path", return_value=root):
                    with fence.hold_managed_workspace_database(
                            self.control, self.backend(), root) as receipt:
                        self.assertEqual(dict(receipt), {"database_present": False})
                        receipt.verify()
                        (root / "workspace.db").write_bytes(b"appeared")

    def test_stopped_backend_validation_does_not_require_control_only_labels(self):
        backend = self.backend()
        self.assertNotIn("org.fullmag.build-control", backend["Config"]["Labels"])
        self.assertEqual(fence._validate_backend_source(self.control, backend),
                         "/home/test/storage/user-data")

    def test_probe_host_identity_requires_same_file_and_owner_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            database = Path(temporary) / "workspace.db"
            database.write_bytes(b"temporary fixture")
            info = database.stat()
            identity = {
                "device": info.st_dev, "inode": info.st_ino, "size": info.st_size,
                "uid": info.st_uid, "gid": info.st_gid,
                "mode": stat.S_IMODE(info.st_mode), "links": info.st_nlink,
                "regular": stat.S_ISREG(info.st_mode),
            }
            fence._validate_probe_host_identity(identity, info)
            for field in ("device", "inode", "size", "uid", "gid", "mode", "links"):
                changed = dict(identity)
                changed[field] += 1
                with self.subTest(field=field), self.assertRaises(BuildControlError):
                    fence._validate_probe_host_identity(changed, info)

    @unittest.skipUnless(sys.platform.startswith("linux") and hasattr(fcntl, "F_OFD_SETLK"),
                         "Linux OFD locks are required")
    def test_permission_error_is_not_mistaken_for_a_lock_conflict(self):
        with tempfile.TemporaryDirectory() as temporary:
            database = Path(temporary) / "workspace.db"
            database.write_bytes(b"temporary fixture")
            fd = os.open(database, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                with patch.object(fence, "_host_lock_command",
                                  side_effect=OSError(errno.EPERM, "permission denied")):
                    with self.assertRaisesRegex(
                            BuildControlError,
                            "Host could not verify the SQLite lock conflict"):
                        fence._prove_host_read_lock_conflict(fd)
            finally:
                os.close(fd)

    def test_owner_blocked_metadata_must_match_probe_and_host_before_go(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            host = root / "host.db"
            foreign = root / "foreign.db"
            host.write_bytes(b"host fixture")
            foreign.write_bytes(b"other fixture")
            host_info = host.stat()
            foreign_info = foreign.stat()
            probe = {
                "device": host_info.st_dev, "inode": host_info.st_ino,
                "size": host_info.st_size, "uid": host_info.st_uid,
                "gid": host_info.st_gid, "mode": stat.S_IMODE(host_info.st_mode),
                "links": host_info.st_nlink, "regular": True,
            }
            foreign_owner = {
                "device": foreign_info.st_dev, "inode": foreign_info.st_ino,
                "size": foreign_info.st_size, "uid": foreign_info.st_uid,
                "gid": foreign_info.st_gid, "mode": stat.S_IMODE(foreign_info.st_mode),
                "links": foreign_info.st_nlink, "regular": True,
            }
            with self.assertRaises(BuildControlError):
                fence._validate_owner_probe_identity(foreign_owner, probe, host_info)
            changed_owner = dict(probe, gid=probe["gid"] + 1)
            with self.assertRaises(BuildControlError):
                fence._validate_owner_probe_identity(changed_owner, probe, host_info)

    def test_yield_exception_releases_helper_and_closes_host_fd_once(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            database = root / "workspace.db"
            database.write_bytes(b"temporary fixture")
            info = database.stat()
            probe_process = SimpleNamespace()
            owner_process = SimpleNamespace(poll=lambda: None)
            ready = json.dumps({"state": "READY"})
            blocked = json.dumps({"state": "BLOCKED"})
            start_results = [
                (probe_process, "probe", ["probe"], ready, {}),
                (owner_process, "owner", ["owner"], blocked, None),
            ]
            metadata = {
                "device": info.st_dev, "inode": info.st_ino, "size": info.st_size,
                "uid": info.st_uid, "gid": info.st_gid,
                "mode": stat.S_IMODE(info.st_mode),
                "links": 1, "regular": True,
            }
            released = []
            real_open, real_close = os.open, os.close
            database_fds = set()
            close_counts = {}

            def tracked_open(path, flags, *args, **kwargs):
                fd = real_open(path, flags, *args, **kwargs)
                if Path(path) == database:
                    database_fds.add(fd)
                return fd

            def tracked_close(fd):
                if fd in database_fds:
                    close_counts[fd] = close_counts.get(fd, 0) + 1
                return real_close(fd)

            with (
                patch.object(fence, "validate_host_path", return_value=root),
                patch.object(fence, "_start_helper", side_effect=lambda *args, **kwargs: start_results.pop(0)),
                patch.object(fence, "_database_daemon_source", return_value=self.daemon_source),
                patch.object(fence, "_validate_helper_inspection"),
                patch.object(fence, "_metadata_ack", side_effect=lambda _line, owner: dict(metadata)),
                patch.object(fence, "_continue_owner_helper", return_value=dict(metadata)),
                patch.object(fence, "_inspect_helper", return_value=("c" * 64, {})),
                patch.object(fence, "_release_helper", side_effect=lambda process: released.append(process)),
                patch.object(fence, "_prove_host_read_lock_conflict"),
                patch.object(fence, "_assert_host_identity"),
                patch.object(fence.os, "open", side_effect=tracked_open),
                patch.object(fence.os, "close", side_effect=tracked_close),
            ):
                with self.assertRaisesRegex(RuntimeError, "fixture failure"):
                    with fence.hold_managed_workspace_database(
                            self.control, self.backend(), root):
                        raise RuntimeError("fixture failure")

            self.assertEqual(released, [probe_process, owner_process])
            self.assertEqual(len(database_fds), 1)
            self.assertEqual(close_counts, {next(iter(database_fds)): 1})

    def test_owner_metadata_requires_actual_owner_write_access_without_fallback(self):
        record = {
            "device": 1, "inode": 2, "size": 4096,
            "uid": 65534, "gid": 65534, "mode": 0o640,
            "links": 1, "regular": True,
        }
        self.assertEqual(fence._metadata_ack(record, owner=True)["uid"], 65534)
        for key, value in (("uid", 1 << 32), ("gid", True), ("mode", 0o440)):
            changed = dict(record)
            changed[key] = value
            with self.subTest(field=key), self.assertRaises(BuildControlError):
                fence._metadata_ack(changed, owner=True)

    def assertRejectedInspection(self, expected, document):
        changed = dict(expected)
        changed["document"] = document
        with self.assertRaises(BuildControlError):
            fence._validate_helper_inspection(**changed)

    def test_posix_bind_source_rejects_comma_parent_and_windows_namespace(self):
        for source in (
            "/storage/user,data/workspace.db",
            "/storage/user-data/../other/workspace.db",
            "C:\\storage\\workspace.db",
        ):
            with self.subTest(source=source), self.assertRaises(BuildControlError):
                fence._require_posix_bind_source(source)

    @unittest.skipUnless(sys.platform.startswith("linux") and hasattr(fcntl, "F_OFD_SETLK"),
                         "Linux OFD locks are required")
    def test_kernel_lock_conflict_releases_without_changing_source_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            database = root / "workspace.db"
            import sqlite3
            with sqlite3.connect(database) as connection:
                connection.execute("CREATE TABLE fixture(value INTEGER)")
                connection.execute("INSERT INTO fixture VALUES (1)")
            original = database.read_bytes()
            original_info = database.stat()
            program = fence._sqlite_module_source() + """
import json, os, sys
with hold_workspace_database(Path(sys.argv[1])):
    info = os.stat(Path(sys.argv[1]) / 'workspace.db', follow_symlinks=False)
    print(json.dumps({'state':'READY','device':info.st_dev,'inode':info.st_ino,
                      'size':info.st_size}), flush=True)
    sys.stdin.buffer.read()
print(json.dumps({'state':'RELEASED'}), flush=True)
"""
            process = subprocess.Popen(
                [sys.executable, "-I", "-B", "-c", program, str(root)],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, bufsize=0,
            )
            host_fd = None
            try:
                ready = json.loads(fence.retained._readline(process, timeout=10))
                self.assertEqual(ready["state"], "READY")
                host_fd = os.open(database, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                before = os.fstat(host_fd)
                self.assertEqual((before.st_dev, before.st_ino, before.st_size),
                                 (ready["device"], ready["inode"], ready["size"]))
                lock = struct.pack("@hhqqi4x", fcntl.F_RDLCK, os.SEEK_SET,
                                   0x40000000, 512, 0)
                with self.assertRaises(OSError) as raised:
                    fcntl.fcntl(host_fd, fcntl.F_OFD_SETLK, lock)
                self.assertIn(raised.exception.errno, (errno.EAGAIN, errno.EACCES))
                after = os.fstat(host_fd)
                self.assertEqual((before.st_dev, before.st_ino, before.st_size),
                                 (after.st_dev, after.st_ino, after.st_size))
            finally:
                if process.stdin is not None and not process.stdin.closed:
                    process.stdin.close()
                if process.poll() is None:
                    released = fence.retained._readline(process, timeout=10)
                    self.assertEqual(json.loads(released)["state"], "RELEASED")
                self.assertEqual(process.wait(timeout=10), 0)
                if process.stdout is not None:
                    process.stdout.close()
                if process.stderr is not None:
                    process.stderr.close()
                if host_fd is not None:
                    os.close(host_fd)
            self.assertEqual(database.read_bytes(), original)
            after_info = database.stat()
            self.assertEqual((after_info.st_dev, after_info.st_ino, after_info.st_size,
                              after_info.st_mtime_ns, stat.S_IMODE(after_info.st_mode)),
                             (original_info.st_dev, original_info.st_ino, original_info.st_size,
                              original_info.st_mtime_ns, stat.S_IMODE(original_info.st_mode)))

    @unittest.skipUnless(sys.platform.startswith("linux") and hasattr(fcntl, "F_OFD_SETLK"),
                         "Linux OFD locks are required")
    def test_fence_on_different_database_does_not_conflict_with_host_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            host_root = root / "host"
            foreign_root = root / "foreign"
            host_root.mkdir()
            foreign_root.mkdir()
            import sqlite3
            for database in (host_root / "workspace.db", foreign_root / "workspace.db"):
                with sqlite3.connect(database) as connection:
                    connection.execute("CREATE TABLE fixture(value INTEGER)")
                    connection.execute("INSERT INTO fixture VALUES (1)")
            program = fence._sqlite_module_source() + """
import json, sys
with hold_workspace_database(Path(sys.argv[1])):
    info = os.stat(Path(sys.argv[1]) / 'workspace.db', follow_symlinks=False)
    print(json.dumps({'state':'READY','device':info.st_dev,'inode':info.st_ino}), flush=True)
    sys.stdin.buffer.read()
print(json.dumps({'state':'RELEASED'}), flush=True)
"""
            process = subprocess.Popen(
                [sys.executable, "-I", "-B", "-c", program, str(foreign_root)],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, bufsize=0,
            )
            host_fd = None
            try:
                ready = json.loads(fence.retained._readline(process, timeout=10))
                self.assertEqual(ready["state"], "READY")
                host_fd = os.open(host_root / "workspace.db",
                                  os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                host_info = os.fstat(host_fd)
                self.assertNotEqual((host_info.st_dev, host_info.st_ino),
                                    (ready["device"], ready["inode"]))
                with self.assertRaisesRegex(
                        BuildControlError,
                        "Managed SQLite exclusive fence is not visible to the host"):
                    fence._prove_host_read_lock_conflict(host_fd)

                owner_user = str(host_info.st_uid) + ":" + str(host_info.st_gid)
                owner_args = fence._managed_helper_args(
                    self.control, "print READY", name=self.name,
                    database_source=str(host_root / "workspace.db"),
                    user=owner_user, group_add=(), database_read_only=False,
                )
                foreign_alias = (
                    "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu2/"
                    + "f" * 64 + "/workspace.db"
                )
                owner_document = _inspection(
                    self.control, owner_args, self.name, foreign_alias, foreign_alias,
                    user=owner_user, groups=(), database_read_only=False,
                )
                process._fullmag_helper_name = self.name
                with patch.object(
                        fence, "docker_capture",
                        return_value=SimpleNamespace(
                            stdout=json.dumps([owner_document]).encode("utf-8"))):
                    with self.assertRaises(BuildControlError):
                        fence._inspect_helper(
                            self.control, process, self.name, owner_args,
                            requested_source=str(host_root / "workspace.db"),
                            expected_daemon_source=None, user=owner_user,
                            group_add=(), database_read_only=False,
                            owner_lock_fd=host_fd,
                        )
            finally:
                if process.stdin is not None and not process.stdin.closed:
                    process.stdin.close()
                if process.poll() is None:
                    released = json.loads(fence.retained._readline(process, timeout=10))
                    self.assertEqual(released["state"], "RELEASED")
                self.assertEqual(process.wait(timeout=10), 0)
                if process.stdout is not None:
                    process.stdout.close()
                if process.stderr is not None:
                    process.stderr.close()
                if host_fd is not None:
                    os.close(host_fd)


if __name__ == "__main__":
    unittest.main()
