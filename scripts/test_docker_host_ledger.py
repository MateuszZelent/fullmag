#!/usr/bin/env python3
"""Focused interpreted checks for the Docker Desktop host-ledger adapter."""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path, PureWindowsPath

import docker_host_ledger as ledger
import fullmag_storage as storage

IMAGE = "sha256:" + "a" * 64


class FakeDocker:
    def __init__(self, values):
        self.values = values
        self.containers = {}
        self.calls = []

    def __call__(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if args[:2] == ("info", "--format"):
            return json.dumps({"ID": "desktop-daemon-1", "OSType": "linux"})
        if args[:2] == ("image", "inspect"):
            return json.dumps([{"Id": IMAGE, "Config": {"Volumes": None}, "Created": "now"}])
        if args[0] == "compose" and "config" in args:
            if "--quiet" in args:
                return ""
            environment = kwargs.get("environment") or {}
            expected_names = (
                "FULLMAG_HOST_LEDGER_PROFILE", "FULLMAG_HOST_LEDGER_PROJECT_ID",
                "FULLMAG_HOST_LEDGER_STORAGE_ROOT", "FULLMAG_HOST_LEDGER_BACKING_IMAGE",
                "FULLMAG_HOST_LEDGER_MOUNT_ROOT", "FULLMAG_HOST_LEDGER_LOCK_PATH",
                "FULLMAG_HOST_LEDGER_OWNER_MARKER", "FULLMAG_HOST_LEDGER_SIZE_BYTES",
                "FULLMAG_HOST_LEDGER_MOUNT_TARGET", "FULLMAG_HOST_LEDGER_LEDGER_ROOT",
                "FULLMAG_HOST_LEDGER_HOST_PID", "FULLMAG_HOST_LEDGER_RUNTIME_UID",
                "FULLMAG_HOST_LEDGER_RUNTIME_GID", "FULLMAG_HOST_LEDGER_LOCK_WAIT_SECONDS",
            )
            maintenance_environment = {name: environment[name] for name in expected_names}
            maintenance = {
                "image": IMAGE,
                "profiles": ["host-ledger-maintenance"],
                "user": "0:0",
                "privileged": True,
                "pid": "host",
                "network_mode": "none",
                "restart": "no",
                "read_only": True,
                "entrypoint": ["/bin/bash", "/usr/local/sbin/docker_host_ledger.sh"],
                "command": ["ensure"],
                "environment": maintenance_environment,
                "volumes": [
                    {"type": "bind", "source": environment["FULLMAG_HOST_LEDGER_HELPER_PATH"],
                     "target": "/usr/local/sbin/docker_host_ledger.sh", "read_only": True,
                     "bind": {"create_host_path": False}},
                    {"type": "bind", "source": environment["FULLMAG_HOST_LEDGER_STORAGE_ROOT"],
                     "target": environment["FULLMAG_HOST_LEDGER_STORAGE_ROOT"],
                     "bind": {"create_host_path": False}},
                    {"type": "bind", "source": environment["FULLMAG_HOST_LEDGER_MOUNT_ROOT"],
                     "target": environment["FULLMAG_HOST_LEDGER_MOUNT_ROOT"],
                     "bind": {}},
                ],
            }
            return json.dumps({
                "name": "fullmag-host-ledger-test",
                "services": {
                    "backend": {
                        "image": "incomplete-backend",
                        "environment": {
                            "FULLMAG_DOCKER_HOST_ID": environment["FULLMAG_DOCKER_HOST_ID"],
                        },
                    },
                    "host-ledger-maintenance": maintenance,
                },
            })
        if args[0] == "run":
            name = args[args.index("--name") + 1]
            label = args[args.index("--label") + 1].split("=", 1)[1]
            self.containers[name] = self._container(name, label, "python")
            return "fullmag-host-ledger-host-python3-v1\n"
        if args[0] == "compose" and "run" in args:
            name = args[args.index("--name") + 1]
            label = args[args.index("--label") + 1].split("=", 1)[1]
            action = args[-1]
            self.containers[name] = self._container(name, label, action)
            return json.dumps(self._receipt(action)) + "\n"
        if args[0] == "logs":
            container = self.containers[args[1]]
            action = container["Config"]["Labels"].get("org.fullmag.host-ledger.action")
            if action == "python":
                return "fullmag-host-ledger-host-python3-v1\n"
            return json.dumps(self._receipt(action)) + "\n"
        if args[0] == "inspect":
            return json.dumps([self.containers[args[1]]])
        if args[0] == "rm":
            self.containers.pop(args[1], None)
            return args[1]
        if args[0] == "exec":
            return "verified"
        raise AssertionError(f"unexpected fake docker call: {args!r}")

    def _container(self, name, label, action):
        return {
            "Id": name + "-id", "Name": "/" + name, "Image": IMAGE,
            "Config": {"Labels": {
                "org.fullmag.host-ledger.owner": label,
                "org.fullmag.host-ledger.action": action,
            }},
            "State": {"Status": "exited", "ExitCode": 0},
        }

    def _receipt(self, action):
        return {
            "schema": ledger.HOST_RECEIPT_SCHEMA, "profile": ledger.PROFILE,
            "project_id": self.values["project_id"],
            # The helper runs in Docker Desktop's Linux daemon namespace.  A
            # real receipt therefore reports the daemon-side backing image,
            # even though the fixture inputs are local host paths.
            "backing_image": ledger._daemon_path(self.values["backing_image"], "backing image"),
            "mount_root": self.values["mount_root"], "mount_target": "/host-ledger",
            "ledger_root": self.values["mount_root"] + "/ledger", "filesystem": "ext4",
            "filesystem_uuid": "11111111-1111-1111-1111-111111111111", "image_size_bytes": ledger.IMAGE_SIZE_BYTES,
            "loop_device": "/dev/loop7", "mount_active": True, "state": "ready" if action == "ensure" else "validated",
        }


class TypeErrorDocker:
    def __init__(self):
        self.calls = 0
        self.kwargs = None

    def __call__(self, *args, **kwargs):
        self.calls += 1
        self.kwargs = kwargs
        raise TypeError("unexpected keyword argument after entering Docker")


class HostLedgerTests(unittest.TestCase):
    @staticmethod
    def _compose_repo(root: Path) -> Path:
        repo = root / "repo"
        (repo / "scripts" / "lib").mkdir(parents=True)
        (repo / "scripts" / "lib" / ledger.HELPER_COPY_NAME).write_text(
            "#!/bin/sh\necho helper\n", encoding="utf-8"
        )
        (repo / "compose.host-ledger.yaml").write_text(
            "services:\n"
            "  backend:\n"
            "    image: ${FULLMAG_HOST_LEDGER_HELPER_IMAGE:?backend image}\n"
            "  host-ledger-maintenance:\n"
            "    image: ${FULLMAG_HOST_LEDGER_HELPER_IMAGE:?maintenance image}\n"
            "    privileged: true\n"
            "    pid: host\n"
            "    network_mode: none\n",
            encoding="utf-8",
        )
        return repo

    def test_windows_drive_mapping_is_linux_daemon_scoped(self):
        self.assertEqual(
            ledger._daemon_path(r"C:\git\fullmag\storage", "storage"),
            "/run/desktop/mnt/host/c/git/fullmag/storage",
        )
        with self.assertRaises(ledger.HostLedgerError):
            ledger._daemon_path(r"C:\git\fullmag\..\storage", "storage")

    def test_within_compares_windows_path_kinds_as_booleans(self):
        self.assertTrue(
            ledger._within(
                r"C:\git\fullmag\storage\runs\docker-all",
                r"C:\git\fullmag\storage",
            )
        )
        self.assertFalse(
            ledger._within(
                r"C:\git\other\runs\docker-all",
                r"C:\git\fullmag\storage",
            )
        )
        self.assertFalse(
            ledger._within(
                r"C:\git\fullmag\storage",
                "/mnt/c/git/fullmag/storage",
            )
        )

    def test_storage_resolver_keeps_linux_mount_paths_under_windows_syntax(self):
        value = storage.linux_host_ledger_infrastructure(
            PureWindowsPath(r"C:\git\fullmag\storage"), "fullmag-test-abc123", ledger.PROFILE
        )
        self.assertEqual(value["host_ledger_mount_root"], "/mnt/fullmag-host-ledger-fullmag-test-abc123")
        self.assertEqual(value["host_ledger_ledger_root"], "/mnt/fullmag-host-ledger-fullmag-test-abc123/ledger")

    def test_prepare_freezes_overlay_and_runs_bounded_maintenance(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            repo = self._compose_repo(root)
            storage_root = root / "storage"
            values = {
                "project_id": "fullmag-test-abc123",
                "storage_root": str(storage_root),
                "backing_image": str(storage_root / "build-volumes" / ledger.IMAGE_NAME),
                "mount_root": "/mnt/fullmag-host-ledger-fullmag-test-abc123",
            }
            fake = FakeDocker(values)
            layout = {
                "project_id": values["project_id"], "storage_root": values["storage_root"],
                "runs_root": str(root / "runs"),
                "host_ledger_backing_image": values["backing_image"],
                "host_ledger_mount_root": values["mount_root"],
            }
            run_root = root / "runs" / "docker-all" / "run1"
            result = ledger.prepare(layout, repo, IMAGE, run_root, fake)
            self.assertEqual(result["schema"], ledger.SCHEMA)
            self.assertEqual(result["ledger_root"], "/host-ledger/ledger")
            self.assertTrue(Path(result["compose_overlay"]).is_file())
            maintenance = json.loads(Path(result["maintenance_compose"]).read_text())
            self.assertEqual(set(maintenance["services"]), {"host-ledger-maintenance"})
            service = maintenance["services"]["host-ledger-maintenance"]
            self.assertEqual(service["image"], IMAGE)
            self.assertEqual(service["network_mode"], "none")
            self.assertTrue(service["privileged"])
            self.assertEqual(result["environment"]["FULLMAG_HOST_LEDGER_ROOT"], "/host-ledger/ledger")
            self.assertEqual(result["host_receipt"]["filesystem"], "ext4")
            self.assertEqual(result["environment"]["FULLMAG_DOCKER_HOST_ID"], hashlib.sha256(b"desktop-daemon-1").hexdigest())
            actions = [
                args[-1]
                for args, _ in fake.calls
                if args[0] == "compose" and "run" in args
            ]
            self.assertEqual(actions, ["ensure"])
            self.assertFalse(fake.containers)
            config_calls = [
                (args, kwargs)
                for args, kwargs in fake.calls
                if args[0] == "compose" and "config" in args
            ]
            self.assertEqual(len(config_calls), 2)
            for args, _ in config_calls:
                self.assertIn("--profile", args)
                self.assertEqual(
                    args[args.index("--profile") + 1], "host-ledger-maintenance"
                )
            self.assertIn("--no-consistency", config_calls[0][0])
            self.assertNotIn("--quiet", config_calls[0][0])
            self.assertIn("--quiet", config_calls[1][0])
            self.assertNotIn("--no-consistency", config_calls[1][0])
            self.assertEqual(
                config_calls[0][1]["environment"]["FULLMAG_HOST_LEDGER_HELPER_IMAGE"], IMAGE
            )

    def test_render_maintenance_has_no_host_yaml_dependency(self):
        source = Path(ledger.__file__).read_text(encoding="utf-8")
        self.assertNotIn("import yaml", source)

    def test_overlay_passes_daemon_identity_to_backend(self):
        digest = "c" * 64
        environment = {"FULLMAG_DOCKER_HOST_ID": digest}
        document = {
            "services": {
                "backend": {"environment": {"FULLMAG_DOCKER_HOST_ID": digest}},
                "host-ledger-maintenance": {},
            }
        }
        ledger._validate_overlay_config(document, environment)
        for backend_environment in (
            {},
            {"FULLMAG_DOCKER_HOST_ID": "d" * 64},
        ):
            document["services"]["backend"]["environment"] = backend_environment
            with self.assertRaises(ledger.HostLedgerError):
                ledger._validate_overlay_config(document, environment)

        compose = Path(ledger.__file__).parents[1] / "compose.host-ledger.yaml"
        compose_source = compose.read_text(encoding="utf-8")
        self.assertIn(
            "FULLMAG_DOCKER_HOST_ID: ${FULLMAG_DOCKER_HOST_ID:?Resolved Docker daemon identity is required}",
            compose_source,
        )

    def test_helper_uses_container_python_and_host_root_filesystem_paths(self):
        helper = Path(ledger.__file__).parents[1] / "scripts" / "lib" / ledger.HELPER_COPY_NAME
        source = helper.read_text(encoding="utf-8")
        self.assertIn("host_root_path()", source)
        self.assertIn("/proc/%s/root%s", source)
        self.assertNotIn("host python3", source)
        self.assertIn('require_command python3', source)
        self.assertIn('exec {LOCK_FD}>"$(host_root_path "${LOCK_PATH}")"', source)
        self.assertNotIn("losetup --find --show --read-write", source)
        self.assertIn('host losetup --find --show "${BACKING_IMAGE}"', source)

    def test_invoke_type_error_is_unknown_without_retry_or_environment_loss(self):
        docker = TypeErrorDocker()
        with self.assertRaises(ledger.DockerInvocationUnknown) as raised:
            ledger._invoke(
                docker,
                "compose",
                "config",
                timeout=17,
                environment={"FULLMAG_TEST_ENV": "pinned"},
            )
        self.assertEqual(docker.calls, 1)
        self.assertEqual(docker.kwargs["environment"], {"FULLMAG_TEST_ENV": "pinned"})
        self.assertTrue(ledger._unknown(raised.exception))
        self.assertEqual(raised.exception.timeout_seconds, 17)

    def test_capture_rejects_nonzero_completed_process_before_json_use(self):
        with self.assertRaises(ledger.HostLedgerError):
            ledger._capture(
                subprocess.CompletedProcess(
                    ["docker", "compose"],
                    1,
                    stdout='{"services": {}}',
                    stderr="compose failed",
                )
            )

    def test_owned_container_reads_logs_before_removal_when_stdout_has_no_receipt(self):
        class LogsOnlyDocker(FakeDocker):
            def __call__(self, *args, **kwargs):
                result = super().__call__(*args, **kwargs)
                if args[0] == "compose" and "run" in args:
                    return "progress without receipt\n"
                return result

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            fake = LogsOnlyDocker({
                "project_id": "test", "backing_image": str(root / "image.ext4"),
                "mount_root": "/mnt/fullmag-host-ledger-test",
            })
            run_root = root / "run"
            run_root.mkdir()
            args = [
                "compose", "run", "--name", "owned", "--label",
                "org.fullmag.host-ledger.owner=token", "host-ledger-maintenance", "ensure",
            ]
            _, receipt = ledger._run_owned_container(
                args=args, name="owned", image_id=IMAGE, label_value="token",
                run_root=run_root, prefix="logs", docker_callable=fake, timeout=30,
            )
            self.assertEqual(receipt["schema"], ledger.HOST_RECEIPT_SCHEMA)
            operations = [call[0][0] for call in fake.calls]
            self.assertLess(operations.index("logs"), operations.index("rm"))

    def test_capture_rejects_nonzero_mapping_before_json_use(self):
        with self.assertRaises(ledger.HostLedgerError):
            ledger._capture({"returncode": 1, "stdout": '{"schema": "fake"}', "stderr": "failed"})

    def test_frozen_copy_never_replaces_existing_file_or_reparse_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            source = root / "source.sh"
            destination = root / "destination.sh"
            target = root / "outside.sh"
            source.write_text("owned", encoding="utf-8")
            destination.write_text("different", encoding="utf-8")
            with self.assertRaises(ledger.HostLedgerError):
                ledger._copy_immutable(source, destination, 1024, 0o444)
            self.assertEqual(destination.read_text(encoding="utf-8"), "different")
            destination.unlink()
            target.write_text("outside", encoding="utf-8")
            destination.symlink_to(target)
            with self.assertRaises(ledger.HostLedgerError):
                ledger._copy_immutable(source, destination, 1024, 0o444)
            self.assertEqual(target.read_text(encoding="utf-8"), "outside")

    @unittest.skipUnless(os.name == "nt", "native Windows only")
    def test_native_write_guard_releases_regular_ancestor_handles(self):
        import windows_folder_host as host

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve() / "owned"
            root.mkdir()
            renamed = Path(tmp).resolve() / "renamed"
            with host._pinned_no_reparse_ancestors(root):
                self.assertTrue(root.is_dir())
            root.rename(renamed)
            self.assertTrue(renamed.is_dir())
            self.assertFalse(root.exists())

    @unittest.skipUnless(os.name == "nt", "native Windows only")
    def test_native_write_guard_rejects_reparse_ancestor(self):
        import windows_folder_host as host

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            directory = host.prepare_probe_link(root)
            junction = directory / "host-junction"
            self.assertTrue(host.storage.is_link(junction))
            with self.assertRaises((OSError, ValueError)):
                with host._pinned_no_reparse_ancestors(junction):
                    pass

    def test_receipt_requires_project_uuid_and_loop_identity(self):
        values = {
            "project_id": "fullmag-test",
            "mount_root": "/mnt/fullmag-host-ledger-fullmag-test",
            "backing_image": "/run/desktop/mnt/host/c/storage/build-volumes/fullmag-host-ledger-v1.ext4",
        }
        incomplete = {
            "schema": ledger.HOST_RECEIPT_SCHEMA, "profile": ledger.PROFILE,
            "state": "validated", "project_id": values["project_id"],
            "backing_image": values["backing_image"], "mount_root": values["mount_root"],
            "ledger_root": values["mount_root"] + "/ledger", "mount_target": ledger.MOUNT_TARGET,
            "filesystem": "ext4", "filesystem_uuid": "11111111-1111-1111-1111-111111111111",
            "image_size_bytes": ledger.IMAGE_SIZE_BYTES, "mount_active": True,
        }
        with self.assertRaises(ledger.HostLedgerError):
            ledger._validate_host_receipt(incomplete, values)
        incomplete["loop_device"] = "/dev/loop7"
        ledger._validate_host_receipt(incomplete, values)

    def test_validate_container_requires_rw_parent_and_live_ledger_child(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            run_root = root / "run"
            maintenance_compose = run_root / "compose.host-ledger.maintenance.json"
            backing_image = ledger._daemon_path(
                root / "storage" / "build-volumes" / ledger.IMAGE_NAME,
                "backing image",
            )
            profile = {
                "profile": ledger.PROFILE,
                "project_id": "test",
                "mount_root": "/mnt/fullmag-host-ledger-test",
                "image_id": IMAGE,
                "maintenance_compose": str(maintenance_compose),
                "run_root": str(run_root),
                "run_id": "a" * 32,
                "backing_image": backing_image,
                "host_receipt": {"filesystem": "ext4", "mount_active": True},
            }
            fake = FakeDocker({
                "project_id": "test",
                "backing_image": profile["backing_image"],
                "mount_root": profile["mount_root"],
            })
            backend = {
                "Id": "backend-id", "Image": IMAGE, "Config": {"User": "65532:65532", "Env": [
                    "FULLMAG_DOCKER_HOST_EXECUTION=1", "FULLMAG_HOST_LEDGER_PROFILE=host-ledger-v1",
                    "FULLMAG_HOST_LEDGER_ROOT=/host-ledger/ledger",
                ]},
                "Mounts": [{"Destination": "/host-ledger", "Type": "bind", "RW": True, "Source": profile["mount_root"]}],
                "HostConfig": {"Privileged": False},
            }
            result = ledger.validate_container(backend, profile, fake)
            self.assertEqual(result["host_verification"], "PASS")
            self.assertEqual(result["ledger_root"], "/host-ledger/ledger")
            actions = [
                args[-1]
                for args, _ in fake.calls
                if args[0] == "compose" and "run" in args
            ]
            self.assertEqual(actions, ["verify"])
            direct_profile = dict(profile)
            direct_profile.pop("maintenance_compose")
            direct_profile["host_receipt"] = {"filesystem": "ext4", "mount_active": True}
            with self.assertRaises(ledger.HostLedgerError):
                ledger.validate_container(backend, direct_profile, fake)
            backend["Mounts"][0]["RW"] = False
            with self.assertRaises(ledger.HostLedgerError):
                ledger.validate_container(backend, profile, fake)


if __name__ == "__main__":
    unittest.main()
