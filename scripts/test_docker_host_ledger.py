#!/usr/bin/env python3
"""Focused interpreted checks for the Docker Desktop host-ledger adapter."""
from __future__ import annotations

import hashlib
import json
import os
import stat
import subprocess
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path, PureWindowsPath
from types import SimpleNamespace
from unittest.mock import patch

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
            maintenance_environment.update({
                "FULLMAG_DOCKER_HOST_ID": environment["FULLMAG_DOCKER_HOST_ID"],
                "FULLMAG_HOST_LEDGER_PUBLISH_CAPACITY": environment.get(
                    "FULLMAG_HOST_LEDGER_PUBLISH_CAPACITY", "0"),
                "FULLMAG_HOST_LEDGER_DOCKER_CPU_COUNT": environment.get(
                    "FULLMAG_HOST_LEDGER_DOCKER_CPU_COUNT", ""),
                "FULLMAG_HOST_LEDGER_DOCKER_MEMORY_TOTAL_BYTES": environment.get(
                    "FULLMAG_HOST_LEDGER_DOCKER_MEMORY_TOTAL_BYTES", ""),
            })
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
    def _volume_ledger_fixture():
        backend, profile, docker = HostLedgerTests._pinned_ledger_fixture()
        profile["host_receipt"]["device_alias"] = "/dev/disk/by-uuid/" + profile["host_receipt"]["filesystem_uuid"]
        descriptor = ledger.host_volume_descriptor("fullmag-master", profile["project_id"], profile["mount_root"], profile["host_receipt"])
        volume = {"Name": descriptor["name"], "Driver": "local", "Scope": "local",
            "Options": dict(descriptor["options"]), "Labels": dict(descriptor["labels"]),
            "Mountpoint": "/var/lib/docker/volumes/" + descriptor["name"] + "/_data"}
        profile["daemon_volume"] = descriptor
        backend["Config"]["Labels"] = {"com.docker.compose.project": "fullmag-master"}
        backend["Mounts"][0].update(Type="volume", Name=descriptor["name"], Driver="local", Source=volume["Mountpoint"])
        calls = []
        def invoke(*args, **kwargs):
            calls.append(args)
            if args[:2] == ("volume", "inspect"):
                return json.dumps([volume])
            if args[:2] == ("volume", "ls"):
                return descriptor["name"] + "\n"
            return docker(*args, **kwargs)
        return backend, profile, volume, invoke, calls

    def test_volume_descriptor_preserves_daemon_mount_and_never_creates_new_storage(self):
        _, profile, volume, docker, calls = self._volume_ledger_fixture()
        descriptor = ledger.prepare_host_volume(profile, "fullmag-master", docker)
        self.assertEqual(descriptor["options"], {"type": "ext4", "o": "rw", "device": profile["host_receipt"]["device_alias"]})
        self.assertEqual(descriptor["compose_volume"], {"name": volume["Name"], "external": True})
        self.assertTrue(descriptor["mount"]["volume"]["nocopy"])
        self.assertEqual([args[:2] for args in calls], [("volume", "ls"), ("volume", "inspect")])

    def test_v2_volume_rejects_raw_loop_and_v1_and_keeps_uuid_bound_name_across_loop_reallocation(self):
        _, profile, _, _, _ = self._volume_ledger_fixture()
        original = profile["daemon_volume"]
        self.assertTrue(original["name"].startswith("fullmag-host-ledger-ext4-v2-"))
        changed = {**profile["host_receipt"], "loop_device": "/dev/loop99"}
        recreated = ledger.host_volume_descriptor("fullmag-master", "test", profile["mount_root"], changed)
        self.assertEqual(recreated["name"], original["name"])
        self.assertEqual(recreated["labels"], original["labels"])
        self.assertNotEqual(recreated["host_receipt"]["loop_device"], original["host_receipt"]["loop_device"])
        for alias in (None, "/dev/loop7", "/dev/fullmag-host-ledger-foreign-token"):
            with self.subTest(alias=alias), self.assertRaises(ledger.HostLedgerError):
                ledger.host_volume_descriptor("fullmag-master", "test", profile["mount_root"],
                    {**profile["host_receipt"], "device_alias": alias})
        backend, profile, _, docker, _ = self._volume_ledger_fixture()
        profile["daemon_volume"]["schema"] = "fullmag.host-ledger-volume.v1"
        with self.assertRaises(ledger.HostLedgerError):
            ledger.validate_container(backend, profile, docker)

    def test_fresh_receipt_loop_mismatch_is_rejected_before_volume_inspection(self):
        backend, profile, _, docker, calls = self._volume_ledger_fixture()
        profile["host_receipt"] = {**profile["host_receipt"], "loop_device": "/dev/loop99"}
        with self.assertRaisesRegex(ledger.HostLedgerError, "fresh maintenance"):
            ledger.validate_container(backend, profile, docker)
        self.assertEqual(calls, [])

    def test_probe_spec_is_isolated_readonly_and_uses_existing_exact_volume(self):
        _, profile, _, _, _ = self._volume_ledger_fixture()
        descriptor = profile["daemon_volume"]
        document = ledger.host_volume_probe_spec(descriptor, IMAGE)
        service = document["services"]["host-ledger-volume-probe"]
        self.assertEqual(service["user"], "65532:65532")
        self.assertEqual(service["network_mode"], "none")
        self.assertNotIn("pid", service)
        self.assertFalse(service["privileged"])
        self.assertTrue(service["read_only"])
        self.assertEqual(service["cap_drop"], ["ALL"])
        self.assertEqual(service["volumes"], [{**descriptor["mount"], "read_only": True}])
        self.assertTrue(document["volumes"]["host-ledger"]["external"])
        self.assertIn("signal.alarm(45)", service["command"][0])
        self.assertEqual(json.loads(service["command"][1]), descriptor)

    def test_prepare_creates_only_absent_owned_local_bind_descriptor(self):
        _, profile, _, docker, calls = self._volume_ledger_fixture()
        mutations = []
        def absent(*args, **kwargs):
            if args[:2] == ("volume", "ls"):
                return "unrelated-existing-volume\n"
            if args[:2] == ("volume", "create"):
                mutations.append(args)
                return args[-1]
            return docker(*args, **kwargs)
        descriptor = ledger.prepare_host_volume(profile, "fullmag-master", absent)
        self.assertEqual(len(mutations), 1)
        self.assertIn("device=" + profile["host_receipt"]["device_alias"], mutations[0])
        self.assertIn("type=ext4", mutations[0])
        self.assertIn("o=rw", mutations[0])
        self.assertEqual(mutations[0][-1], descriptor["name"])

    def test_prepare_requires_canonical_host_receipt_before_docker(self):
        _, profile, _, docker, calls = self._volume_ledger_fixture()
        profile["host_receipt"]["mount_root"] = "/some/unverified/root"
        with self.assertRaises(ledger.HostLedgerError):
            ledger.prepare_host_volume(profile, "fullmag-master", docker)
        self.assertEqual(calls, [])

    def test_managed_local_volume_is_attested_against_actual_volume_metadata(self):
        backend, profile, _, docker, calls = self._volume_ledger_fixture()
        result = ledger.validate_container(backend, profile, docker)
        self.assertEqual(result["host_receipt"]["mount_root"], profile["mount_root"])
        self.assertEqual(result["host_verification"], "PASS")
        self.assertEqual(calls[0][:2], ("volume", "inspect"))

    def test_volume_driver_device_or_owner_drift_is_never_adopted(self):
        for changed in ("Driver", "Options", "Labels", "Scope"):
            with self.subTest(changed=changed):
                backend, profile, volume, docker, calls = self._volume_ledger_fixture()
                volume[changed] = {"type": "none", "o": "bind", "device": "/wsl/rewritten/root"} if changed == "Options" else {} if changed == "Labels" else "foreign"
                with self.assertRaises(ledger.HostLedgerError):
                    ledger.prepare_host_volume(profile, "fullmag-master", docker)
                self.assertFalse(any(args[:2] in {("volume", "create"), ("volume", "rm")} for args in calls))
                with self.assertRaises(ledger.HostLedgerError):
                    ledger.validate_container(backend, profile, docker)

    def test_backend_cannot_substitute_arbitrary_volume_bind_or_source(self):
        for changed, value in (("Name", "arbitrary-volume"), ("Source", "/other/_data"),
                               ("Type", "bind"), ("RW", False), ("Driver", "foreign")):
            with self.subTest(changed=changed):
                backend, profile, _, docker, _ = self._volume_ledger_fixture()
                backend["Mounts"][0][changed] = value
                with self.assertRaises(ledger.HostLedgerError):
                    ledger.validate_container(backend, profile, docker)

    def test_unmanaged_volume_or_changed_descriptor_has_no_bind_pin_fallback(self):
        backend, profile, _, docker, _ = self._volume_ledger_fixture()
        del profile["daemon_volume"]
        with self.assertRaises(ledger.HostLedgerError):
            ledger.validate_container(backend, profile, docker)
        backend, profile, _, docker, _ = self._volume_ledger_fixture()
        profile["daemon_volume"]["options"]["device"] = "/other"
        with self.assertRaises(ledger.HostLedgerError):
            ledger.validate_container(backend, profile, docker)

    @staticmethod
    def _pinned_ledger_fixture():
        canonical = "/mnt/fullmag-host-ledger-test"
        alias = "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu/ledger-token"
        environment = {"FULLMAG_DOCKER_HOST_EXECUTION": "1",
            "FULLMAG_HOST_LEDGER_PROFILE": ledger.PROFILE,
            "FULLMAG_HOST_LEDGER_ROOT": ledger.LEDGER_ROOT,
            "FULLMAG_HOST_LEDGER_MOUNT_ROOT": canonical,
            "FULLMAG_HOST_LEDGER_PROJECT_ID": "test", "FULLMAG_DOCKER_HOST_ID": "engine"}
        values = {"project_id": "test", "mount_root": canonical,
                  "backing_image": "/storage/build-volumes/" + ledger.IMAGE_NAME}
        docker = FakeDocker(values)
        profile = {"profile": ledger.PROFILE, "image_id": IMAGE, **values,
            "environment": environment, "daemon_binds": {ledger.MOUNT_TARGET: alias},
            "host_receipt": docker._receipt("verify")}
        backend = {"Id": "backend-id", "Image": IMAGE,
            "Config": {"User": "65532:65532", "Env": [key + "=" + value for key, value in environment.items()]},
            "HostConfig": {"Privileged": False},
            "Mounts": [{"Destination": ledger.MOUNT_TARGET, "Type": "bind", "RW": True, "Source": alias}]}
        return backend, profile, docker

    def test_pinned_client_alias_cannot_replace_the_canonical_host_ledger_mount(self):
        backend, profile, docker = self._pinned_ledger_fixture()
        with self.assertRaisesRegex(ledger.HostLedgerError, "managed mount root"):
            ledger.validate_container(backend, profile, docker)
        self.assertEqual(docker.calls, [])
        backend["Mounts"][0]["Source"] = profile["mount_root"]
        self.assertEqual(ledger.validate_container(backend, profile, docker)["host_verification"], "PASS")

    def test_bind_rejects_noncanonical_root_despite_matching_client_pin(self):
        for changed in ("/other/ledger", "/run/desktop/client/ledger"):
            with self.subTest(source=changed):
                backend, profile, docker = self._pinned_ledger_fixture()
                backend["Mounts"][0]["Source"] = changed
                profile["daemon_binds"][ledger.MOUNT_TARGET] = changed
                with self.assertRaisesRegex(ledger.HostLedgerError, "managed mount root"):
                    ledger.validate_container(backend, profile, docker)
                self.assertEqual(docker.calls, [])

    def test_obsolete_client_pins_never_admit_a_noncanonical_bind(self):
        for pins in ({}, {ledger.MOUNT_TARGET: ""}, "invalid", None,
                     {ledger.MOUNT_TARGET: "/run/../other"}, {ledger.MOUNT_TARGET: "//host/ledger"},
                     {ledger.MOUNT_TARGET: "/"}, {ledger.MOUNT_TARGET: "/run/ledger\tbad"}):
            with self.subTest(pins=pins):
                backend, profile, docker = self._pinned_ledger_fixture()
                profile["daemon_binds"] = pins
                with self.assertRaises(ledger.HostLedgerError):
                    ledger.validate_container(backend, profile, docker)
                self.assertEqual(docker.calls, [])

    def test_daemon_alias_does_not_replace_canonical_receipt_validation(self):
        for field in ("mount_root", "backing_image", "project_id"):
            with self.subTest(field=field):
                backend, profile, _, docker, _ = self._volume_ledger_fixture()
                profile["host_receipt"][field] = backend["Mounts"][0]["Source"]
                with self.assertRaises(ledger.HostLedgerError):
                    ledger.validate_container(backend, profile, docker)

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


class HostVolumeProbeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "host-ledger"
        self.root.mkdir(mode=0o755)
        (self.root / "ledger").mkdir(mode=0o770)
        (self.root / "ledger").chmod(0o770)
        self.namespace = {}
        exec(ledger.HOST_VOLUME_PROBE_FUNCTIONS, self.namespace)
        _, profile, _, _, _ = HostLedgerTests._volume_ledger_fixture()
        self.descriptor = profile["daemon_volume"]
        self.marker = {"schema": "fullmag.host-ledger-owner.v1", "profile": ledger.PROFILE,
            "project_id": "test", "backing_image": profile["backing_image"],
            "mount_root": profile["mount_root"], "filesystem_uuid": self.descriptor["filesystem_uuid"],
            "image_size_bytes": ledger.IMAGE_SIZE_BYTES, "mount_target": ledger.MOUNT_TARGET,
            "runtime_uid": 65532, "runtime_gid": 65532,
            "owner_token": "11111111-1111-4111-8111-111111111111"}
        self.marker_path = self.root / ".fullmag-host-ledger-owner.json"
        self.save_marker()

    def save_marker(self):
        if self.marker_path.exists():
            self.marker_path.chmod(0o644)
        self.marker_path.write_text(json.dumps(self.marker))
        self.marker_path.chmod(0o444)

    def execute_probe(self, *, device=(7, 7), filesystem=0xef53, incorrect_owner=None):
        # Real files, nofollow descriptors and JSON parsing; only kernel-owned
        # metadata/device observations are substituted for this host-only test.
        lstat, fstat = os.lstat, os.fstat
        def metadata(value, path):
            path = Path(path)
            if path not in {self.root, self.root / "ledger", self.marker_path}:
                return value
            result = SimpleNamespace(**{key: getattr(value, key) for key in (
                "st_mode", "st_dev", "st_uid", "st_gid", "st_ino", "st_nlink", "st_size", "st_mtime_ns", "st_ctime_ns")})
            result.st_dev = os.makedev(7, 7)
            result.st_uid = result.st_gid = 65532 if path == self.root / "ledger" else 0
            if incorrect_owner == path.name:
                result.st_uid = 1000
            return result
        def observed_lstat(path):
            return metadata(lstat(path), path)
        def observed_fstat(fd):
            return metadata(fstat(fd), os.readlink("/proc/self/fd/" + str(fd)))
        with ExitStack() as stack:
            stack.enter_context(patch.object(os, "lstat", side_effect=observed_lstat))
            stack.enter_context(patch.object(os, "fstat", side_effect=observed_fstat))
            stack.enter_context(patch.object(os, "geteuid", return_value=65532))
            stack.enter_context(patch.object(os, "getegid", return_value=65532))
            stack.enter_context(patch.object(os, "statvfs", return_value=SimpleNamespace(f_flag=os.ST_RDONLY)))
            stack.enter_context(patch.dict(self.namespace, {
                "_ledger_loop_device": lambda loop: device,
                "_ledger_statfs_type": lambda root: filesystem}))
            return self.namespace["probe"](self.descriptor, str(self.root))

    def test_probe_reads_exact_owner_marker_and_current_loop_device(self):
        result = self.execute_probe()
        self.assertEqual(result["filesystem_uuid"], self.descriptor["filesystem_uuid"])
        self.assertEqual(result["loop_device"], "/dev/loop7")
        self.assertEqual(result["device_alias"], "/dev/disk/by-uuid/" + self.descriptor["filesystem_uuid"])
        self.assertEqual(result["state"], "verified")

    def test_marker_uuid_backing_and_scope_cannot_be_substituted(self):
        for field, wrong in (("filesystem_uuid", "22222222-2222-2222-2222-222222222222"),
                             ("backing_image", "/foreign/image"), ("project_id", "foreign"),
                             ("owner_token", "00000000-0000-0000-0000-000000000000"),
                             ("runtime_uid", 1000), ("image_size_bytes", True)):
            with self.subTest(field=field):
                original = self.marker[field]
                self.marker[field] = wrong
                self.save_marker()
                with self.assertRaises(ValueError):
                    self.execute_probe()
                self.marker[field] = original
        self.save_marker()

    def test_foreign_loop_or_nonext4_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "exact loop ext4"):
            self.execute_probe(device=(7, 99))
        with self.assertRaisesRegex(ValueError, "exact loop ext4"):
            self.execute_probe(filesystem=0x1234)

    def test_marker_symlink_and_bad_permissions_are_rejected(self):
        self.marker_path.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "owner marker ownership"):
            self.execute_probe()
        self.marker_path.chmod(0o444)
        with self.assertRaises(ValueError):
            self.execute_probe(incorrect_owner=self.marker_path.name)
        actual = self.root / "real-marker"
        self.marker_path.rename(actual)
        self.marker_path.symlink_to(actual)
        with self.assertRaisesRegex(ValueError, "symlink"):
            self.execute_probe()

    def test_runtime_directory_mode_and_owner_are_enforced(self):
        (self.root / "ledger").chmod(0o777)
        with self.assertRaisesRegex(ValueError, "runtime directory ownership"):
            self.execute_probe()
        (self.root / "ledger").chmod(0o770)
        with self.assertRaisesRegex(ValueError, "runtime directory ownership"):
            self.execute_probe(incorrect_owner="ledger")


if __name__ == "__main__":
    unittest.main()
