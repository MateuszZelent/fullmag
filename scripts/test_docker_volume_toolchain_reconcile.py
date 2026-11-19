"""Interpreted regression checks for canceled BuildKit reconciliation."""
import copy
from datetime import datetime
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from bootstrap_docker_toolchain import control_volume_name
from docker_compose_identity import source_labels
import docker_volume_toolchain_reconcile as subject
import docker_volume_reconcile as publication
from docker_build_control import BuildControlError, canonical


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.original = {"schema": "fullmag.docker-build-operation.v1", "phase": "toolchain",
            "attempt": "a" * 32, "state": "starting", "compose_project": "project",
            "control_volume": "volume", "helper_container": "fullmag-control-" + "a" * 32,
            "started_at": 1000.0, "inputs": {"target": "fem-gpu-dev",
                "build_args": {"FULLMAG_MFEM_BUILD_JOBS": "2"}, "source_inputs": []}}
        self.raw = canonical(self.original) + b"\n"
        self.document = {"services": {"fem-gpu-toolchain": {"build": {
            "dockerfile": "docker/fem-gpu/Dockerfile", "target": "fem-gpu-dev",
            "args": self.original["inputs"]["build_args"]}}}}
        self.record = {"Ref": "b" * 25, "Dockerfile": "docker/fem-gpu/Dockerfile",
            "Target": "fem-gpu-dev", "VCSRevision": "c" * 40, "VCSRepository": "https://example/repo",
            "Status": "canceled", "Error": {"Code": 1, "Message": "context canceled"},
            "StartedAt": 1010.0, "CompletedAt": 1020.0,
            "Labels": {"com.docker.compose.project": "project", "com.docker.compose.service": "fem-gpu-toolchain"},
            "BuildArgs": self.original["inputs"]["build_args"]}
        self.request = {"schema": subject.SCHEMA, "attempt": "a" * 32,
            "unknown_receipt_sha256": subject.digest(self.raw), "compose_sha256": "d" * 64,
            "build_log_sha256": "e" * 64, "helper_fingerprint": "f" * 64,
            "helper_started_at": "1970-01-01T00:16:40Z",
            "phase_current_sha256": None, "verified_sha256": None,
            "build_ref": "b" * 25, "build_record_sha256": subject.digest(canonical(self.record)),
            "source_revision": "c" * 40, "source_repository": "https://example/repo",
            "source_root": str(Path.cwd()), "compose_project": "project", "engine_id": "engine",
            "buildkit_observer": {"kind": "native"},
            "buildx_version": "github.com/docker/buildx v0.36.1-desktop.1 synthetic",
            "builders": [{"Name": "builder", "Driver": "docker", "Nodes": [
                {"Name": "node", "Endpoint": "endpoint", "IDs": ["worker"], "Version": "v0.32.2", "Status": "running"}]}],
            "controller_inputs": {path: "0" * 64 for path in (
                "scripts/docker_volume_toolchain_reconcile.py", "scripts/docker_volume_reconcile.py",
                "scripts/docker_volume_activation_reconcile.py")}}
        self.builder = copy.deepcopy(self.request["builders"][0])

    def qualified_request(self):
        request = copy.deepcopy(self.request)
        request["buildkit_observer"] = {"kind": "native"}
        request["buildx_version"] = "github.com/docker/buildx v0.38.1-desktop.1"
        request["engine_id"] = "engine"
        native_builder = {"Name": "default", "Driver": "docker", "Nodes": [{
            "Endpoint": "default", "Name": "default", "IDs": ["engine"],
            "Version": "v0.34.2", "Status": "running"}]}
        native_builders = [native_builder,
            {"Name": "desktop-linux", "Driver": "", "Nodes": [{
                "Endpoint": "", "Name": ""}], "Err": "protocol not available"},
            {"Name": "desktop-windows", "Driver": "", "Nodes": [{
                "Endpoint": "", "Name": ""}], "Err": "protocol not available"},
        ]
        request["builders"] = subject._normalized_buildx_rows(native_builders)
        request["native_contexts"] = [
            {"Name": name, "DockerEndpoint": endpoint, "Current": name == "default", "Error": ""}
            for name, endpoint in subject.WSL_CONTEXT_ENDPOINTS.items()
        ]
        request["native_context_inspects"] = {
            name: {"Host": endpoint, "SkipTLSVerify": False}
            for name, endpoint in subject.WSL_CONTEXT_ENDPOINTS.items()
        }
        linux_plugin_path = "/usr/local/lib/docker/cli-plugins/docker-buildx"
        request["native_buildx_plugin"] = {
            "path": linux_plugin_path,
            "inventory": [{"Name": "buildx", "Version": "v0.38.1",
                           "Path": linux_plugin_path, "sha256": "1" * 64}],
        }
        windows_builders = [
            {"Name": "default", "Driver": "docker", "Nodes": [{
                "Endpoint": "default", "Name": "default", "IDs": ["engine"],
                "Version": "v0.34.2", "Status": "running"}]},
            {"Name": "desktop-linux", "Driver": "docker", "Nodes": [{
                "Endpoint": "desktop-linux", "Name": "desktop-linux", "IDs": ["engine"],
                "Version": "v0.34.2", "Status": "running"}]},
            {"Name": "desktop-windows", "Driver": "", "Nodes": [{
                "Endpoint": "", "Name": ""}],
             "Err": 'Get "http://%2F%2F.%2Fpipe%2FdockerDesktopWindowsEngine/_ping": context deadline exceeded'},
            {"Name": "fullmag-windows", "Driver": "docker-container", "Nodes": [{
                "Endpoint": "desktop-linux", "Name": "fullmag-windows0",
                "Flags": ["--allow-insecure-entitlement=network.host"], "Status": "inactive"}]},
        ]
        contexts = [
            {"Name": "default", "Description": "Current DOCKER_HOST based configuration",
             "DockerEndpoint": subject.WINDOWS_CONTEXT_ENDPOINTS["default"], "Current": False, "Error": ""},
            {"Name": "desktop-linux", "Description": "Docker Desktop",
             "DockerEndpoint": subject.WINDOWS_CONTEXT_ENDPOINTS["desktop-linux"], "Current": True, "Error": ""},
            {"Name": "desktop-windows", "Description": "Docker Desktop",
             "DockerEndpoint": subject.WINDOWS_CONTEXT_ENDPOINTS["desktop-windows"], "Current": False, "Error": ""},
        ]
        plugin_path = r"C:\Program Files\Docker\cli-plugins\docker-buildx.exe"
        desktop_plugin_path = r"C:\Program Files\Docker\cli-plugins\docker-desktop.exe"
        request["windows_desktop_observer"] = {
            "schema": "fullmag.docker-desktop-toolchain-observer.v1",
            "executable": str(subject.WINDOWS_DOCKER), "sha256": "2" * 64,
            "version": "29.9.3", "linux_context": "default",
            "linux_context_endpoint": "unix:///var/run/docker.sock",
            "powershell_executable": str(subject.WINDOWS_POWERSHELL), "powershell_sha256": "3" * 64,
            "settings_path": str(subject.DOCKER_DESKTOP_SETTINGS), "settings_sha256": "4" * 64,
            "python_executable": "/usr/bin/python3", "python_sha256": "5" * 64,
            "linux_engine_id": "engine",
            "desktop_engines": [{"Name": "linux", "Description": "Linux engine", "Current": True}],
            "contexts": contexts,
            "context_inspects": {name: {"Host": endpoint, "SkipTLSVerify": False}
                                 for name, endpoint in subject.WINDOWS_CONTEXT_ENDPOINTS.items()},
            "buildx_builders": subject._normalized_buildx_rows(windows_builders),
            "plugins": [
                {"Name": "buildx", "Version": "v0.38.1", "Path": plugin_path, "sha256": "6" * 64},
                {"Name": "desktop", "Version": "4.99.0", "Path": desktop_plugin_path, "sha256": "7" * 64},
            ],
        }
        self.foreign_helper_fixture(request)
        return request, native_builders, windows_builders

    def foreign_helper_fixture(self, request):
        attempt = "b" * 32
        project = "fullmag-worktree-foreign-test"
        identity = {"project_name": project, "project_id": "foreign-project-id",
                    "worktree_id": "foreign-worktree-id", "checkout_kind": "worktree"}
        image = "example/helper@sha256:" + "c" * 64
        volume = control_volume_name(project)
        helper_name = "fullmag-control-" + attempt
        initial_pin = {**identity, "control_volume": volume, "helper_image": image}
        control = subject._foreign_helper_control(initial_pin)
        script = control.operation_script("image-dev", attempt)
        helper_args = control.helper_args(script, name=helper_name)
        argv = ["docker", "--context", "desktop-linux", *helper_args[1:]]
        command_line = subprocess.list2cmdline(argv)
        started_at = "2026-11-19T08:32:44.856587551Z"
        container_id = "a" * 64
        helper_image_id = "sha256:" + "d" * 64
        image_labels = {
            "maintainer": "NVIDIA CORPORATION <cudatools@nvidia.com>",
            "org.opencontainers.image.ref.name": "ubuntu",
            "org.opencontainers.image.version": "22.04",
        }
        control.image_labels = image_labels
        entrypoint = helper_args.index("--entrypoint")
        labels = {
            **image_labels,
            "com.docker.compose.project": project,
            "com.docker.compose.service": "build-control",
            **control.labels,
            **source_labels(identity),
        }
        document = {
            "Id": container_id,
            "Name": "/" + helper_name,
            "Image": helper_image_id,
            "Config": {"Image": image, "Entrypoint": ["/bin/bash"],
                       "Cmd": helper_args[entrypoint + 3:],
                       "User": "65532:65532", "Labels": labels},
            "State": {"Running": True, "StartedAt": started_at},
            "HostConfig": {
                "NetworkMode": "none", "ReadonlyRootfs": True, "Privileged": False,
                "CapAdd": None, "CapDrop": ["ALL"],
                "SecurityOpt": ["no-new-privileges:true"], "PidsLimit": 32,
                "Memory": 64 * 1024 * 1024, "NanoCpus": 250_000_000, "Runtime": "runc",
                "AutoRemove": True,
                "Devices": None, "DeviceRequests": None, "PidMode": "", "IpcMode": "private",
                "UTSMode": "", "UsernsMode": "", "Binds": None, "Tmpfs": None,
                "Mounts": [{"Type": "volume", "Source": volume, "Target": "/control",
                            "VolumeOptions": {"NoCopy": True}}],
            },
            "Mounts": [{"Type": "volume", "Name": volume,
                        "Source": "/var/lib/docker/volumes/" + volume + "/_data",
                        "Destination": "/control", "Driver": "local", "Mode": "z",
                        "RW": True, "Propagation": ""}],
        }
        pins = {
            "schema": "fullmag.foreign-control-helper.v1",
            "pid": 121028,
            "process_name": "docker.exe",
            "process_creation_date": "/Date(1795077072607)/",
            "process_executable_path": r"C:\Program Files\Docker\Docker\resources\bin\docker.exe",
            "command_line_sha256": subject.digest(command_line.encode("utf-8")),
            "argv_sha256": subject.digest(canonical(argv)),
            "container_id": container_id,
            "container_started_at": started_at,
            "container_inspect_sha256": subject.digest(canonical(document)),
            **identity,
            "control_volume": volume,
            "helper_name": helper_name,
            "attempt": attempt,
            "phase": "image-dev",
            "helper_image": image,
            "helper_image_id": helper_image_id,
        }
        request["foreign_control_helper"] = pins
        process = {"ProcessId": pins["pid"], "Name": pins["process_name"],
                   "CreationDate": pins["process_creation_date"],
                   "ExecutablePath": pins["process_executable_path"],
                   "CommandLine": command_line}
        return pins, control, document, process

    def test_valid_native_canceled_record(self):
        subject.validate_request(self.request)
        subject.validate_record(self.record, self.request, self.original, self.document)

    def test_each_identity_or_outcome_mismatch_is_rejected(self):
        variants = [
            ("Ref", "q" * 25), ("Status", "completed"), ("Error", {"Code": 0, "Message": ""}),
            ("Dockerfile", "other"), ("Target", "other"), ("BuildArgs", {}),
            ("VCSRevision", "1" * 40), ("VCSRepository", "https://wrong"),
            ("StartedAt", 999), ("StartedAt", 1400), ("CompletedAt", 1000),
            ("Labels", {"com.docker.compose.project": "foreign", "com.docker.compose.service": "fem-gpu-toolchain"}),
            ("Labels", {"com.docker.compose.project": "project", "com.docker.compose.service": "backend"})]
        for key, value in variants:
            with self.subTest(key=key, value=value), self.assertRaises(BuildControlError):
                observed = copy.deepcopy(self.record)
                observed[key] = value
                subject.validate_record(observed, self.request, self.original, self.document)

    def native_record(self):
        result = copy.deepcopy(self.record)
        result["StartedAt"] = "1970-01-01T00:16:50Z"
        result["CompletedAt"] = "1970-01-01T01:17:00+01:00"
        result["Dockerfile"] = "docker\\fem-gpu\\Dockerfile"
        for key in ("Labels", "BuildArgs"):
            result[key] = [{"Name": key, "Value": value} for key, value in result[key].items()]
        result["Error"]["Stack"] = "changing observer stack"
        result["Duration"] = 123
        return result

    def test_projection_ignores_only_observer_noise(self):
        self.assertEqual(subject.build_record(self.native_record()), self.record)
        native = self.native_record()
        native["Error"]["Stack"] = "other observer"
        native["Duration"] = 999
        self.assertEqual(subject.build_record(native), self.record)

    def test_duplicate_build_argument_or_label_is_rejected(self):
        for key in ("BuildArgs", "Labels"):
            native = self.native_record()
            native[key].append(native[key][0])
            with self.subTest(key=key), self.assertRaises(BuildControlError):
                subject.build_record(native)

    def test_missing_or_timezone_free_time_is_rejected(self):
        for value in (None, "nonsense", "1970-01-01T00:16:50"):
            native = self.native_record()
            native["StartedAt"] = value
            with self.subTest(value=value), self.assertRaises(BuildControlError):
                subject.build_record(native)

    def test_nanosecond_rfc3339_timestamps_keep_offset_and_fraction_for_comparison(self):
        later = subject.timestamp("2026-11-19T12:50:15.139850753+01:00")
        earlier = subject.timestamp("2026-11-19T11:50:15.139850752Z")
        self.assertGreater(later, earlier)
        self.assertEqual(int(later), 1795089015)
        self.assertEqual(
            subject.timestamp("2026-11-19T12:50:15.000000001+01:00")
            - subject.timestamp("2026-11-19T11:50:15Z"),
            subject.Decimal("0.000000001"),
        )
        with self.assertRaises(BuildControlError):
            subject.timestamp("2026-11-19T12:50:15.1234567890+01:00")

    def test_build_record_digest_keeps_legacy_microsecond_truncation(self):
        native = self.native_record()
        native["StartedAt"] = "2026-11-19T12:50:15.139850753+01:00"
        native["CompletedAt"] = "2026-11-19T12:50:16.139850753+01:00"
        record = subject.build_record(native)
        expected = copy.deepcopy(record)
        expected["StartedAt"] = datetime.fromisoformat(
            "2026-11-19T12:50:15.139850+01:00"
        ).timestamp()
        expected["CompletedAt"] = datetime.fromisoformat(
            "2026-11-19T12:50:16.139850+01:00"
        ).timestamp()
        self.assertEqual(subject.digest(canonical(record)), subject.digest(canonical(expected)))
        self.assertGreater(
            subject.timestamp(native["StartedAt"]),
            subject.Decimal(str(record["StartedAt"])),
        )

    def test_native_context_endpoints_pin_exact_wsl_aliases(self):
        request, _, _ = self.qualified_request()
        def capture(*args, **_kwargs):
            if args == ("context", "show"):
                return SimpleNamespace(stdout=b"default\n")
            if args == ("context", "ls", "--format", "json"):
                return SimpleNamespace(stdout=canonical(request["native_contexts"]))
            if args[:2] == ("context", "inspect"):
                name = args[2]
                return SimpleNamespace(stdout=canonical(request["native_context_inspects"][name]))
            self.fail("Unexpected native context command: " + repr(args))
        with patch.object(subject, "docker_capture", side_effect=capture):
            subject.validate_native_context(request)

        request["native_context_inspects"]["desktop-linux"]["Host"] = "unix:///wrong.sock"
        with patch.object(subject, "docker_capture", side_effect=capture), \
             self.assertRaisesRegex(BuildControlError, "not the pinned local Desktop alias"):
            subject.validate_native_context(request)

    def test_qualified_request_rejects_unpinned_native_context_alias(self):
        request, _, _ = self.qualified_request()
        request["native_contexts"][-1]["DockerEndpoint"] = "unix:///other-engine.sock"
        with self.assertRaisesRegex(BuildControlError, "Linux-origin context inventory"):
            subject.validate_request(request)

    def test_qualified_desktop_profile_pins_versions_and_single_origin_builder(self):
        request, _, _ = self.qualified_request()
        subject.validate_request(request)
        request["buildx_version"] = "github.com/docker/buildx v0.37.9"
        with self.assertRaisesRegex(BuildControlError, "Buildx v0.38.1"):
            subject.validate_request(request)

    def test_qualified_origin_builder_rejects_shadow_or_nonintegrated_workers(self):
        request, builders, _ = self.qualified_request()
        subject._validate_native_integrated_builder_inventory(builders, request)
        builder = builders[0]
        for changed in (
            {**builder, "Driver": "docker-container"},
            {**builder, "Nodes": [{**builder["Nodes"][0], "Status": "inactive"}]},
            {**builder, "Nodes": [{**builder["Nodes"][0], "Version": "v0.32.2"}]},
            {**builder, "Nodes": [{**builder["Nodes"][0], "IDs": ["remote-worker"]}]},
        ):
            candidate = [changed, *builders[1:]]
            with self.subTest(changed=changed), self.assertRaises(BuildControlError):
                subject._validate_native_integrated_builder_inventory(candidate, request)
        extra = {**builder, "Name": "remote", "Nodes": [dict(builder["Nodes"][0])]}
        request["builders"] = subject._normalized_buildx_rows([*builders, extra])
        with self.assertRaisesRegex(BuildControlError, "independent or shadow builder"):
            subject._validate_native_integrated_builder_inventory([*builders, extra], request)

        request, builders, _ = self.qualified_request()
        for alias_name in ("desktop-linux", "desktop-windows"):
            changed = copy.deepcopy(builders)
            alias = next(row for row in changed if row["Name"] == alias_name)
            alias["Nodes"][0]["IDs"] = ["worker"]
            request["builders"] = subject._normalized_buildx_rows(changed)
            with self.subTest(alias=alias_name), self.assertRaisesRegex(BuildControlError, "synthetic placeholder"):
                subject._validate_native_integrated_builder_inventory(changed, request)

    def test_windows_aliases_are_accepted_only_as_empty_synthetic_rows(self):
        request, _, windows_builders = self.qualified_request()
        response = {"returncode": 0, "stderr": b""}
        def capture(_request, *args, **kwargs):
            if args[:3] == ("buildx", "ls", "--format"):
                return SimpleNamespace(stdout=canonical(windows_builders), **response)
            self.assertEqual(args[:3], ("container", "inspect", "buildx_buildkit_fullmag-windows0"))
            return SimpleNamespace(stdout=b"[]", stderr=b"Error response from daemon: No such container: buildx_buildkit_fullmag-windows0\n", returncode=1)
        with patch.object(subject, "windows_desktop_capture", side_effect=capture):
            subject._validate_windows_buildx_inventory(request)

        changed = copy.deepcopy(windows_builders)
        alias = next(row for row in changed if row["Name"] == "desktop-windows")
        alias["Nodes"][0] = {"Name": "desktop-windows", "Endpoint": "remote", "IDs": ["worker"]}
        request["windows_desktop_observer"]["buildx_builders"] = subject._normalized_buildx_rows(changed)
        with patch.object(subject, "windows_desktop_capture", side_effect=lambda *_a, **_k: SimpleNamespace(
                stdout=canonical(changed), stderr=b"", returncode=0)), \
             self.assertRaisesRegex(BuildControlError, "real or ambiguous BuildKit node"):
            subject._validate_windows_buildx_inventory(request)

    def test_windows_contexts_are_exact_and_endpoint_metadata_is_not_pipe_absence(self):
        request, _, _ = self.qualified_request()
        calls = []
        def capture(_request, *args, **kwargs):
            calls.append((args, kwargs))
            if args == ("context", "ls", "--format", "json"):
                return SimpleNamespace(stdout=canonical(request["windows_desktop_observer"]["contexts"]))
            name = args[2]
            return SimpleNamespace(stdout=canonical(
                request["windows_desktop_observer"]["context_inspects"][name]))
        with patch.object(subject, "windows_desktop_capture", side_effect=capture):
            subject._windows_context_inventory(request)
        self.assertEqual(len(calls), 4)
        self.assertEqual(calls[0][0], ("context", "ls", "--format", "json"))

        request["windows_desktop_observer"]["contexts"][2]["DockerEndpoint"] = "tcp://remote:2375"
        with patch.object(subject, "windows_desktop_capture", side_effect=capture), \
             self.assertRaises(BuildControlError):
            subject._windows_context_inventory(request)

    def test_desktop_only_linux_evidence_requires_policy_engine_list_and_500_route(self):
        request, _, _ = self.qualified_request()
        profile = request["windows_desktop_observer"]
        profile["python_executable"] = str(Path(subject.sys.executable).resolve())
        plugin_rows = [{key: plugin[key] for key in ("Name", "Version", "Path")}
                       for plugin in profile["plugins"]]

        def validate(desktop_engines=None, windows_context_error=None, install_settings=None):
            desktop_engines = desktop_engines or profile["desktop_engines"]
            windows_context_error = windows_context_error or (
                b"request failed: HTTP 500 for /v1.56/version")
            install_settings = install_settings or b'{"noWindowsContainers":true}'
            def capture(_request, *args, **kwargs):
                if args == ("version", "--format", "{{.Client.Version}}"):
                    return SimpleNamespace(stdout=b"29.9.3\n", stderr=b"", returncode=0)
                if args == ("desktop", "engine", "ls", "--format", "json"):
                    return SimpleNamespace(stdout=canonical(desktop_engines), stderr=b"", returncode=0)
                if args == ("info", "--format", "{{.ID}}\t{{.OSType}}"):
                    return SimpleNamespace(stdout=b"engine\tlinux\n", stderr=b"", returncode=0)
                if args == ("version", "--format", "{{.Server.Version}}"):
                    return SimpleNamespace(stdout=b"", stderr=windows_context_error, returncode=1)
                if args == ("info", "--format", "{{json .ClientInfo.Plugins}}"):
                    return SimpleNamespace(stdout=canonical(plugin_rows), stderr=b"", returncode=0)
                self.fail("Unexpected desktop evidence command: " + repr((args, kwargs)))

            with patch.object(subject, "_require_pinned_file", side_effect=lambda path, *_a, **_k: Path(path)), \
                 patch.object(Path, "read_bytes", return_value=install_settings), \
                 patch.object(subject, "windows_desktop_capture", side_effect=capture), \
                 patch.object(subject, "_windows_context_inventory", return_value=profile["contexts"]), \
                 patch.object(subject, "_validate_windows_buildx_inventory", return_value=profile["buildx_builders"]), \
                 patch.object(subject, "_validate_plugin_files"):
                return subject.validate_windows_desktop_profile(request)

        self.assertEqual(validate(), profile["buildx_builders"])
        with self.assertRaisesRegex(BuildControlError, "only the selected Linux engine"):
            validate(desktop_engines=[*profile["desktop_engines"], {
                "Name": "windows", "Description": "Windows engine", "Current": False}])
        with self.assertRaisesRegex(BuildControlError, "explicitly configured for Linux"):
            validate(install_settings=b'{"noWindowsContainers":false}')
        with self.assertRaisesRegex(BuildControlError, "version-endpoint HTTP 500"):
            validate(windows_context_error=b"context deadline exceeded")

    def test_windows_only_inactive_builder_must_have_no_container(self):
        request, _, windows_builders = self.qualified_request()
        inactive = next(row for row in windows_builders if row["Name"] == "fullmag-windows")
        inactive["Nodes"][0]["Status"] = "running"
        request["windows_desktop_observer"]["buildx_builders"] = subject._normalized_buildx_rows(windows_builders)
        with patch.object(subject, "windows_desktop_capture", return_value=SimpleNamespace(
                stdout=canonical(windows_builders), stderr=b"", returncode=0)), \
             self.assertRaisesRegex(BuildControlError, "may be active"):
            subject._validate_windows_buildx_inventory(request)

        request, _, windows_builders = self.qualified_request()
        def present(*_args, **_kwargs):
            if _args[1:4] == ("buildx", "ls", "--format"):
                return SimpleNamespace(stdout=canonical(windows_builders), stderr=b"", returncode=0)
            return SimpleNamespace(stdout=b"[]", stderr=b"", returncode=0)
        with patch.object(subject, "windows_desktop_capture", side_effect=present), \
             self.assertRaisesRegex(BuildControlError, "exists or its absence"):
            subject._validate_windows_buildx_inventory(request)

        request, _, windows_builders = self.qualified_request()
        def ambiguous(*_args, **_kwargs):
            if _args[1:4] == ("buildx", "ls", "--format"):
                return SimpleNamespace(stdout=canonical(windows_builders), stderr=b"", returncode=0)
            return SimpleNamespace(stdout=b"[]", stderr=b"Error response from daemon: context deadline exceeded", returncode=1)
        with patch.object(subject, "windows_desktop_capture", side_effect=ambiguous), \
             self.assertRaisesRegex(BuildControlError, "exists or its absence"):
            subject._validate_windows_buildx_inventory(request)

    def test_native_buildx_shadow_instance_blocks_qualified_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            instances = root / "buildx" / "instances"
            instances.mkdir(parents=True)
            with patch.dict(subject.os.environ, {"DOCKER_CONFIG": str(root)}, clear=False):
                subject.validate_native_instances_absent()
                (instances / "shadow.json").write_text("{}", encoding="utf-8")
                with self.assertRaisesRegex(BuildControlError, "shadow Buildx instance"):
                    subject.validate_native_instances_absent()

    def test_effective_buildx_plugin_pin_accepts_desktop_symlink_and_checks_target_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "docker-desktop" / "cli-tools" / "buildx"
            target.parent.mkdir(parents=True)
            target.write_bytes(b"pinned buildx plugin")
            alias = root / "usr" / "local" / "lib" / "docker" / "cli-plugins" / "docker-buildx"
            alias.parent.mkdir(parents=True)
            alias.symlink_to(target)
            inventory = [{"Name": "buildx", "Version": "v0.38.1", "Path": str(alias)}]
            expected = [{"Name": "buildx", "Version": "v0.38.1", "Path": str(alias),
                         "sha256": subject.digest(b"pinned buildx plugin")}]
            subject._validate_plugin_files(inventory, expected, windows=False, label="Linux")
            expected[0]["sha256"] = "0" * 64
            with self.assertRaisesRegex(BuildControlError, "plugin executable changed"):
                subject._validate_plugin_files(inventory, expected, windows=False, label="Linux")

    def test_windows_process_snapshot_rejects_daemons_and_live_build_clients(self):
        request, _, _ = self.qualified_request()
        with patch.object(subject, "_windows_process_rows", return_value=[]), \
             self.assertRaisesRegex(BuildControlError, "unrecognized process"):
            subject._windows_process_snapshot(request)
        daemon = {"Name": "dockerd.exe", "ProcessId": 12, "CreationDate": "now", "CommandLine": "dockerd"}
        client = {"Name": "docker.exe", "ProcessId": 13, "CreationDate": "now", "CommandLine": "docker.exe build ."}
        for row in (daemon, client):
            with patch.object(subject, "_windows_process_rows", return_value=[row]), \
                 self.assertRaises(BuildControlError):
                subject._windows_process_snapshot(request)

    def test_windows_cim_empty_output_is_not_an_empty_process_list(self):
        request, _, _ = self.qualified_request()
        for output in (b"", b" \t\r\n"):
            with self.subTest(output=output), \
                 patch.object(subject, "windows_powershell_capture", return_value=SimpleNamespace(
                     stdout=output, stderr=b"")), \
                 self.assertRaisesRegex(BuildControlError, "returned empty output"):
                subject._windows_process_rows(request)
        with patch.object(subject, "windows_powershell_capture", return_value=SimpleNamespace(
                stdout=b"[]", stderr=b"")):
            self.assertEqual(subject._windows_process_rows(request), [])

    def test_windows_process_snapshot_accepts_only_exact_pinned_foreign_control_helper(self):
        request, _, _ = self.qualified_request()
        pins, control, document, process = self.foreign_helper_fixture(request)
        with patch.object(subject, "_windows_process_rows", return_value=[process]) as census, \
             patch.object(subject, "_foreign_helper_control", return_value=control), \
             patch.object(subject, "_inspect_foreign_control_helper") as inspect:
            result = subject._windows_process_snapshot(request)
        self.assertEqual(result["windows_foreign_control_helpers"], 1)
        self.assertEqual(result["windows_potential_build_clients"], [])
        self.assertEqual(census.call_count, 1)
        inspect.assert_not_called()
        self.assertNotIn("CommandLine", result)

    def test_qualified_profile_allows_omitted_foreign_helper_only_when_census_is_clear(self):
        request, _, _ = self.qualified_request()
        _, _, _, process = self.foreign_helper_fixture(request)
        request.pop("foreign_control_helper")
        subject.validate_request(request)
        with patch.object(subject, "_windows_process_rows", return_value=[]) as census, \
             patch.object(subject, "_inspect_foreign_control_helper") as inspect:
            result = subject._windows_process_snapshot(request)
        self.assertEqual(census.call_count, 1)
        self.assertEqual(result["windows_foreign_control_helpers"], 0)
        inspect.assert_not_called()

        with patch.object(subject, "_windows_process_rows", return_value=[process]), \
             self.assertRaisesRegex(BuildControlError, "without an exact declared helper pin"):
            subject._windows_process_snapshot(request)

    def test_host_clients_propagates_unpinned_windows_build_client_refusal(self):
        request, _, _ = self.qualified_request()
        _, _, _, process = self.foreign_helper_fixture(request)
        request.pop("foreign_control_helper")
        with patch.object(subject.Path, "is_file", return_value=True), \
             patch.object(subject.Path, "iterdir", return_value=[]), \
             patch.object(subject.Path, "read_text", return_value="linux-boot-id"), \
             patch.object(subject, "_windows_process_rows", return_value=[process]), \
             patch.object(subject, "validate_windows_desktop_profile") as profile, \
             self.assertRaisesRegex(BuildControlError, "without an exact declared helper pin"):
            subject.host_clients(Path.cwd(), request)
        profile.assert_not_called()

    def test_final_census_rejects_windows_client_added_during_slow_checks(self):
        request, _, _ = self.qualified_request()
        _, _, _, process = self.foreign_helper_fixture(request)
        unpinned = copy.deepcopy(process)
        unpinned["ProcessId"] += 1
        unpinned["CommandLine"] = "docker.exe build ."
        events = []
        rows = {"value": [process]}

        def validated_profile(_request):
            events.append("slow-windows-profile")
            rows["value"] = [process, unpinned]

        def process_rows(_request):
            events.append("windows-census")
            return rows["value"]

        with patch.object(subject, "validate_observer", side_effect=lambda _request: events.append("observer")), \
             patch.object(subject, "validate_native_context", side_effect=lambda _request: events.append("native-context")), \
             patch.object(subject, "_windows_context_inventory", side_effect=lambda _request: events.append("windows-contexts")), \
             patch.object(subject, "validate_windows_desktop_profile", side_effect=validated_profile), \
             patch.object(subject, "_inspect_foreign_control_helper", side_effect=lambda *_: events.append("helper-inspect")), \
             patch.object(subject, "_windows_process_rows", side_effect=process_rows), \
             patch.object(subject, "_linux_process_snapshot") as linux_snapshot, \
             self.assertRaisesRegex(BuildControlError, "additional or unrecognized"):
            subject.host_clients(Path.cwd(), request, final=True)
        self.assertLess(events.index("helper-inspect"), events.index("windows-census"))
        self.assertEqual(events.count("windows-census"), 1)
        linux_snapshot.assert_not_called()

    def test_final_census_rejects_wsl_client_added_during_slow_checks(self):
        request, _, _ = self.qualified_request()
        _, _, _, process = self.foreign_helper_fixture(request)
        events = []
        state = {"client_started": False}

        def validated_profile(_request):
            events.append("slow-windows-profile")
            state["client_started"] = True

        def linux_snapshot(_source):
            events.append("wsl-census")
            if state["client_started"]:
                return {"linux_boot_id": "boot", "linux_processes_scanned": 1}, (321,)
            return {"linux_boot_id": "boot", "linux_processes_scanned": 0}, ()

        with patch.object(subject, "validate_observer", side_effect=lambda _request: events.append("observer")), \
             patch.object(subject, "validate_native_context", side_effect=lambda _request: events.append("native-context")), \
             patch.object(subject, "_windows_context_inventory", side_effect=lambda _request: events.append("windows-contexts")), \
             patch.object(subject, "validate_windows_desktop_profile", side_effect=validated_profile), \
             patch.object(subject, "_inspect_foreign_control_helper", side_effect=lambda *_: events.append("helper-inspect")), \
             patch.object(subject, "_windows_process_rows", return_value=[process]) as windows_rows, \
             patch.object(subject, "_linux_process_snapshot", side_effect=linux_snapshot), \
             self.assertRaisesRegex(BuildControlError, "Potential live build clients remain: \(321,\)"):
            subject.host_clients(Path.cwd(), request, final=True)
        self.assertLess(events.index("slow-windows-profile"), events.index("wsl-census"))
        self.assertLess(events.index("helper-inspect"), events.index("wsl-census"))
        self.assertEqual(windows_rows.call_count, 1)

    def test_foreign_control_helper_rejects_unpinned_and_reused_client_identity(self):
        request, _, _ = self.qualified_request()
        pins, control, document, process = self.foreign_helper_fixture(request)
        altered = copy.deepcopy(process)
        altered["ProcessId"] += 1
        with patch.object(subject, "_windows_process_rows", return_value=[altered]), \
             patch.object(subject, "_foreign_helper_control", return_value=control), \
             self.assertRaisesRegex(BuildControlError, "process identity was reused"):
            subject._windows_process_snapshot(request)

        altered = copy.deepcopy(process)
        altered["CommandLine"] += " "
        with patch.object(subject, "_windows_process_rows", return_value=[altered]), \
             patch.object(subject, "_foreign_helper_control", return_value=control), \
             self.assertRaisesRegex(BuildControlError, "raw command line"):
            subject._windows_process_snapshot(request)

    def test_foreign_control_helper_rechecks_exact_container_and_rejects_extra_client(self):
        request, _, _ = self.qualified_request()
        pins, control, document, process = self.foreign_helper_fixture(request)
        other = copy.deepcopy(process)
        other["ProcessId"] += 1
        with patch.object(subject, "_windows_process_rows", create=True,
                          return_value=[process, other]), \
             patch.object(subject, "_foreign_helper_control", return_value=control), \
             self.assertRaisesRegex(BuildControlError, "additional or unrecognized"):
            subject._windows_process_snapshot(request)

    def test_final_host_census_checks_topology_before_process_rows(self):
        request, _, _ = self.qualified_request()
        _, _, _, process = self.foreign_helper_fixture(request)
        events = []
        def profile(_request):
            events.append("slow-profile")
        def inspect(*_args):
            events.append("exact-helper-inspect")
        def windows_rows(_request):
            events.append("windows-census")
            return [process]
        def linux_snapshot(_source):
            events.append("wsl-census")
            return {"linux_boot_id": "boot", "linux_processes_scanned": 0}, ()
        with patch.object(subject, "validate_observer", side_effect=lambda _request: events.append("observer")), \
             patch.object(subject, "validate_native_context", side_effect=lambda _request: events.append("native-context")), \
             patch.object(subject, "_windows_context_inventory", side_effect=lambda _request: events.append("windows-contexts")), \
             patch.object(subject, "validate_windows_desktop_profile", side_effect=profile), \
             patch.object(subject, "_inspect_foreign_control_helper", side_effect=inspect), \
             patch.object(subject, "_windows_process_rows", side_effect=windows_rows), \
             patch.object(subject, "_linux_process_snapshot", side_effect=linux_snapshot):
            result = subject.host_clients(Path.cwd(), request, final=True)
        self.assertEqual(result["host_process_census_passes"], 2)
        self.assertEqual(events.count("windows-census"), 2)
        self.assertEqual(events.count("wsl-census"), 2)
        self.assertLess(events.index("slow-profile"), events.index("exact-helper-inspect"))
        self.assertLess(events.index("exact-helper-inspect"), events.index("windows-census"))
        self.assertLess(events.index("windows-census"), events.index("wsl-census"))

    def test_foreign_control_helper_document_rejects_master_access_and_privilege(self):
        request, _, _ = self.qualified_request()
        pins, control, document, _ = self.foreign_helper_fixture(request)
        subject._validate_foreign_control_helper_document(
            document, pins, control, control.image_labels
        )
        variants = []
        changed = copy.deepcopy(document)
        changed["HostConfig"]["NetworkMode"] = "bridge"
        variants.append(changed)
        changed = copy.deepcopy(document)
        changed["HostConfig"]["ReadonlyRootfs"] = False
        variants.append(changed)
        changed = copy.deepcopy(document)
        changed["HostConfig"]["Privileged"] = True
        variants.append(changed)
        changed = copy.deepcopy(document)
        changed["HostConfig"]["CapAdd"] = ["SYS_ADMIN"]
        variants.append(changed)
        changed = copy.deepcopy(document)
        changed["HostConfig"]["Mounts"].append({"Type": "bind", "Source": "/var/run/docker.sock",
                                                 "Target": "/var/run/docker.sock"})
        variants.append(changed)
        changed = copy.deepcopy(document)
        changed["Mounts"].append({"Type": "volume", "Name": "master-control",
                                  "Destination": "/master", "RW": True})
        variants.append(changed)
        changed = copy.deepcopy(document)
        changed["Mounts"][0]["Source"] = "/other/control"
        variants.append(changed)
        for candidate in variants:
            with self.subTest(host_config=candidate["HostConfig"]), \
                 self.assertRaises(BuildControlError):
                subject._validate_foreign_control_helper_document(
                    candidate, pins, control, control.image_labels
                )

    def test_foreign_control_helper_cross_observer_inspection_pins_engine_container_and_volume(self):
        request, _, _ = self.qualified_request()
        pins, control, document, _ = self.foreign_helper_fixture(request)
        image_document = {"Id": pins["helper_image_id"], "Config": {"Labels": control.image_labels}}
        volume = {"Name": pins["control_volume"], "Driver": "local", "Options": None,
                  "Labels": control.labels}
        native = [
            SimpleNamespace(stdout=b"engine", stderr=b""),
            SimpleNamespace(stdout=canonical([document]), stderr=b""),
            SimpleNamespace(stdout=canonical([image_document]), stderr=b""),
            SimpleNamespace(stdout=canonical([volume]), stderr=b""),
        ]
        windows = [
            SimpleNamespace(stdout=b"engine\tlinux", stderr=b""),
            SimpleNamespace(stdout=canonical([document]), stderr=b""),
            SimpleNamespace(stdout=canonical([image_document]), stderr=b""),
            SimpleNamespace(stdout=canonical([volume]), stderr=b""),
        ]
        with patch.object(subject, "docker_capture", side_effect=native) as native_capture, \
             patch.object(subject, "windows_desktop_capture", side_effect=windows) as windows_capture:
            observed = subject._inspect_foreign_control_helper(request, pins, control)
        self.assertIn(pins["container_id"], observed)
        self.assertEqual(native_capture.call_count, 4)
        self.assertEqual(windows_capture.call_count, 4)
        self.assertTrue(all(call.kwargs.get("context", "desktop-linux") == "desktop-linux"
                            for call in windows_capture.call_args_list))

        altered_volume = copy.deepcopy(volume)
        altered_volume["Labels"].pop("org.fullmag.build.role")
        with patch.object(subject, "docker_capture", side_effect=[
                SimpleNamespace(stdout=b"engine", stderr=b""),
                SimpleNamespace(stdout=canonical([document]), stderr=b""),
                SimpleNamespace(stdout=canonical([image_document]), stderr=b""),
                SimpleNamespace(stdout=canonical([altered_volume]), stderr=b""),
        ]), patch.object(subject, "windows_desktop_capture", side_effect=windows), \
             self.assertRaisesRegex(BuildControlError, "control volume"):
            subject._inspect_foreign_control_helper(request, pins, control)

    def test_enoexec_uses_only_the_pinned_init_trampoline(self):
        executable = Path("/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe")
        interpreter = Path("/usr/bin/python3")
        observed = []
        def capture(command, **kwargs):
            observed.append((command, kwargs))
            if len(observed) == 1:
                raise OSError(subject.errno.ENOEXEC, "exec format error")
            return SimpleNamespace(returncode=0, stdout=b"ok", stderr=b"")
        with patch.object(subject, "_require_pinned_file", side_effect=[executable, interpreter]), \
             patch.object(Path, "is_file", return_value=True), \
             patch.object(Path, "resolve", new=lambda path, *args, **kwargs: path), \
             patch.object(subject.os, "access", return_value=True), \
             patch.object(subject, "bounded_capture", side_effect=capture):
            result = subject._windows_executable_capture(
                executable, ["--context", "desktop-linux", "info"], sha256="a" * 64,
                python_path=str(interpreter), python_sha256="b" * 64,
            )
        self.assertEqual(result.stdout, b"ok")
        bridge = observed[1][0]
        self.assertEqual(bridge[0:3], [str(interpreter), "-B", "-c"])
        self.assertIn("os.execv('/init', sys.argv[1:])", bridge[3])
        self.assertEqual(bridge[4:], [str(executable), str(executable), executable.name,
                                      "--context", "desktop-linux", "info"])

    def test_non_enoexec_does_not_use_windows_interpreter_fallback(self):
        executable = Path("/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe")
        with patch.object(subject, "_require_pinned_file", return_value=executable), \
             patch.object(subject, "bounded_capture", side_effect=PermissionError("denied")) as capture:
            with self.assertRaises(PermissionError):
                subject._windows_executable_capture(
                    executable, ["info"], sha256="a" * 64,
                    python_path="/usr/bin/python3", python_sha256="b" * 64,
                )
        self.assertEqual(capture.call_count, 1)

    def history_fake(self, *, rows=None, active=None, builders=None, record=None):
        if rows is None:
            rows = [{"ref": "builder/node/" + "b" * 25, "created_at": "1970-01-01T00:16:50Z",
                     "completed_at": "1970-01-01T00:17:00Z"}]
        def capture(*args, **kwargs):
            if args == ("buildx", "ls", "--format", "json"):
                value = b"\n".join(canonical(x) for x in (builders or [self.builder]))
            elif args == ("info", "--format", "{{.ID}}"):
                value = b"engine\n"
            elif args == ("buildx", "version"):
                value = self.request["buildx_version"].encode() + b"\n"
            elif args[:3] == ("buildx", "history", "ls"):
                value = b"\n".join(canonical(x) for x in ((active or []) if "status=running" in args else rows))
            elif args[:3] == ("buildx", "history", "inspect"):
                value = canonical(record or self.native_record())
            else:
                self.fail("Unexpected Docker mutation/command: " + repr(args))
            return SimpleNamespace(stdout=value, returncode=0)
        return capture

    def qualified_history_fake(self, builders, *, rows=None, active=None, record=None):
        if rows is None:
            rows = [{"ref": "builder/node/" + "b" * 25,
                     "created_at": "1970-01-01T00:16:40.000000001Z",
                     "completed_at": "1970-01-01T00:17:00.000000001Z"}]
        if active is None:
            active = []
        if record is None:
            record = self.native_record()
            record["StartedAt"] = "1970-01-01T00:16:40.000000001Z"
            record["CompletedAt"] = "1970-01-01T00:17:00.000000001Z"
        calls = []
        def capture(*args, **kwargs):
            calls.append(args)
            if args == ("info", "--format", "{{.ID}}"):
                value = b"engine\n"
            elif args == ("buildx", "version"):
                value = b"github.com/docker/buildx v0.38.1-desktop.1\n"
            elif args == ("context", "show"):
                value = b"default\n"
            elif args == ("context", "ls", "--format", "json"):
                value = canonical([
                    {"Name": name, "DockerEndpoint": endpoint,
                     "Current": name == "default", "Error": ""}
                    for name, endpoint in subject.WSL_CONTEXT_ENDPOINTS.items()
                ])
            elif args[:2] == ("context", "inspect"):
                name = args[2]
                value = canonical({"Host": subject.WSL_CONTEXT_ENDPOINTS[name],
                                   "SkipTLSVerify": False})
            elif args == ("buildx", "ls", "--format", "json"):
                value = canonical(builders)
            elif args[:3] == ("buildx", "history", "ls"):
                value = b"\n".join(canonical(row) for row in (active if "status=running" in args else rows))
            elif args[:3] == ("buildx", "history", "inspect"):
                value = canonical(record)
            else:
                self.fail("Unexpected strict profile Docker command: " + repr(args))
            return SimpleNamespace(stdout=value, returncode=0, stderr=b"")
        capture.calls = calls
        return capture

    def test_history_accepts_one_complete_terminal_record(self):
        with patch.object(subject, "docker_capture", self.history_fake()):
            self.assertEqual(subject.history(self.request, self.original), self.record)

    def test_qualified_history_uses_one_v0342_worker_two_independent_probes_and_ns_floor(self):
        request, builders, _ = self.qualified_request()
        rows = [{"ref": "builder/node/" + "b" * 25,
                 "created_at": "1970-01-01T00:16:39.000000001Z",
                 "completed_at": "1970-01-01T00:17:00.000000001Z"}]
        record = self.native_record()
        record["StartedAt"] = "1970-01-01T00:16:39.000000001Z"
        record["CompletedAt"] = "1970-01-01T00:17:00.000000001Z"
        fake = self.qualified_history_fake(builders, rows=rows, record=record)
        with patch.object(subject, "validate_native_instances_absent"), \
             patch.object(subject, "validate_native_buildx_plugin"), \
             patch.object(subject, "validate_windows_desktop_profile"), \
             patch.object(subject, "docker_capture", side_effect=fake):
            result = subject.history(request, self.original)
        self.assertEqual(result["Ref"], "b" * 25)
        request["build_record_sha256"] = subject.digest(canonical(result))
        subject.validate_record(result, request, self.original, self.document)

        probes = [args for args in fake.calls if args[:3] == ("buildx", "history", "ls")]
        self.assertEqual(len(probes), 2)
        self.assertIn("startedAt>1970-01-01T00:16:39Z", probes[0])
        self.assertIn("status=running", probes[1])
        self.assertFalse(any("startedAt" in value for value in probes[1]))
        self.assertTrue(all("--builder" in args and args[args.index("--builder") + 1] == "default"
                            for args in probes))

    def test_qualified_history_rejects_exact_floor_boundary(self):
        request, builders, _ = self.qualified_request()
        rows = [{"ref": "builder/node/" + "b" * 25,
                 "created_at": "1970-01-01T00:16:39Z",
                 "completed_at": "1970-01-01T00:17:00Z"}]
        record = self.native_record()
        record["StartedAt"] = "1970-01-01T00:16:39Z"
        fake = self.qualified_history_fake(builders, rows=rows, record=record)
        with patch.object(subject, "validate_native_instances_absent"), \
             patch.object(subject, "validate_native_buildx_plugin"), \
             patch.object(subject, "validate_windows_desktop_profile"), \
             patch.object(subject, "docker_capture", side_effect=fake), \
             self.assertRaisesRegex(BuildControlError, "outside the pinned filter-before-limit window"):
            subject.history(request, self.original)

    def test_qualified_history_rejects_buildx_v0382_limit(self):
        request, builders, _ = self.qualified_request()
        rows = [{"ref": "builder/node/" + str(index).zfill(20),
                 "created_at": "1970-01-01T00:16:40Z", "completed_at": "1970-01-01T00:17:00Z"}
                for index in range(50)]
        fake = self.qualified_history_fake(builders, rows=rows)
        with patch.object(subject, "validate_native_instances_absent"), \
             patch.object(subject, "validate_native_buildx_plugin"), \
             patch.object(subject, "validate_windows_desktop_profile"), \
             patch.object(subject, "docker_capture", side_effect=fake), \
             self.assertRaisesRegex(BuildControlError, "may be truncated"):
            subject.history(request, self.original)

    def test_preview_requires_same_record_and_rechecks_controller_lease_and_helper(self):
        import bootstrap_docker_toolchain
        source = Path(__file__).resolve().parents[1]
        request, _, _ = self.qualified_request()
        request.update(source_root=str(source), compose_project="project")
        original = {"schema": "fullmag.docker-build-operation.v1", "phase": "toolchain",
            "attempt": request["attempt"], "state": "building", "compose_project": "project",
            "control_volume": "volume", "helper_container": self.original["helper_container"],
            "started_at": 1000.0, "inputs": {"target": "fem-gpu-dev",
                "build_args": self.original["inputs"]["build_args"], "source_inputs": []}}
        original_raw = canonical(original) + b"\n"
        request["unknown_receipt_sha256"] = subject.digest(original_raw)
        document = {"name": "project", "services": {"fem-gpu-toolchain": {
            "build": {"context": str(source), "dockerfile": "docker/fem-gpu/Dockerfile",
                      "target": "fem-gpu-dev", "args": original["inputs"]["build_args"]}}}}
        compose_raw = canonical(document)
        request["compose_sha256"] = subject.digest(compose_raw)
        request["controller_inputs"] = {
            relative: subject.digest((source / relative).read_bytes()) for relative in (
                "scripts/docker_volume_toolchain_reconcile.py", "scripts/docker_volume_reconcile.py",
                "scripts/docker_volume_activation_reconcile.py")}
        request["build_record_sha256"] = subject.digest(canonical(self.record))
        request["build_log_sha256"] = "e" * 64
        helper = {"State": {"StartedAt": request["helper_started_at"]}}
        control = SimpleNamespace(project="project", volume="volume", path=lambda p: "/control/" + p)
        raw_reads = []
        def read(_control, relative, optional=False):
            raw_reads.append((relative, optional))
            if relative == "toolchain/attempts/" + request["attempt"] + "/unknown-receipt.json":
                return None
            if relative == "toolchain/attempts/" + request["attempt"] + "/receipt.json":
                return original_raw
            if relative == "active":
                return request["attempt"].encode() + b"\n"
            raise AssertionError("Unexpected control read " + relative)
        capture_calls = []
        def docker(*args, **kwargs):
            capture_calls.append(args)
            return SimpleNamespace(stdout=("e" * 64 + "  build.log\n").encode())
        histories = [copy.deepcopy(self.record), copy.deepcopy(self.record)]
        clients = {"linux_boot_id": "boot", "potential_build_clients": []}
        events = []
        validate_source_control = subject._validate_source_and_control_pins
        def source_control_check(*args):
            events.append("source-control")
            return validate_source_control(*args)
        def host_client_check(*args, **kwargs):
            events.append("final-census" if kwargs.get("final") else "early-census")
            return clients
        with patch.object(subject, "read_raw", side_effect=read), \
             patch.object(subject, "pin_file", return_value=compose_raw), \
             patch.object(subject, "_validate_helper", return_value=(helper, "helper")), \
             patch.object(subject, "_validate_helper_logged"), \
             patch.object(subject, "fingerprint", return_value=request["helper_fingerprint"]), \
             patch.object(subject, "docker_capture", side_effect=docker), \
             patch.object(subject, "_validate_host_client_environment",
                          side_effect=lambda _request: events.append("slow-host-probes")), \
             patch.object(subject, "_validate_source_and_control_pins",
                          side_effect=source_control_check), \
             patch.object(subject, "host_clients", side_effect=host_client_check) as host_clients, \
             patch.object(subject, "history", side_effect=histories) as history, \
             patch.object(subject.time, "sleep"), \
             patch.object(bootstrap_docker_toolchain, "tracked_input_files", return_value=[]), \
             patch.object(bootstrap_docker_toolchain, "read_input"):
            result = subject.preview(control, source, request)
        self.assertEqual(result[0], original_raw)
        self.assertEqual(history.call_count, 2)
        self.assertEqual(host_clients.call_count, 2)
        self.assertEqual(events[-3:], ["slow-host-probes", "source-control", "final-census"])
        self.assertEqual(host_clients.call_args.kwargs,
                         {"final": True, "environment_validated": True})
        self.assertEqual(len([args for args in capture_calls if args[:2] == ("exec", "helper")]), 3)
        self.assertIn(("active", False), raw_reads)

        legacy_request = copy.deepcopy(self.request)
        for key in ("controller_inputs", "compose_sha256", "unknown_receipt_sha256"):
            legacy_request[key] = request[key]
        with patch.object(subject, "read_raw", side_effect=read), \
             patch.object(subject, "pin_file", return_value=compose_raw), \
             patch.object(subject, "_validate_helper", return_value=(helper, "helper")), \
             patch.object(subject, "_validate_helper_logged"), \
             patch.object(subject, "fingerprint", return_value=request["helper_fingerprint"]), \
             patch.object(subject, "docker_capture", side_effect=docker), \
             patch.object(subject, "_linux_process_snapshot", return_value=({"linux_boot_id": "boot"}, ())) as linux, \
             patch.object(subject, "_legacy_windows_process_snapshot", return_value=({}, ())) as windows, \
             patch.object(subject, "history", return_value=self.record), \
             patch.object(subject.time, "sleep"), \
             patch.object(bootstrap_docker_toolchain, "tracked_input_files", return_value=[]):
            _, _, observed_clients = subject.preview(control, source, legacy_request)
        self.assertEqual(observed_clients["host_process_census_passes"], 2)
        self.assertEqual((linux.call_count, windows.call_count), (3, 3))

        request["controller_inputs"]["scripts/docker_volume_toolchain_reconcile.py"] = "0" * 64
        histories = [copy.deepcopy(self.record), copy.deepcopy(self.record)]
        with patch.object(subject, "read_raw", side_effect=read), \
             patch.object(subject, "pin_file", return_value=compose_raw), \
             patch.object(subject, "_validate_helper", return_value=(helper, "helper")), \
             patch.object(subject, "_validate_helper_logged"), \
             patch.object(subject, "fingerprint", return_value=request["helper_fingerprint"]), \
             patch.object(subject, "docker_capture", side_effect=docker), \
             patch.object(subject, "_validate_host_client_environment"), \
             patch.object(subject, "host_clients", return_value=clients), \
             patch.object(subject, "history", side_effect=histories), \
             patch.object(subject.time, "sleep"), \
             patch.object(bootstrap_docker_toolchain, "tracked_input_files", return_value=[]), \
             patch.object(bootstrap_docker_toolchain, "read_input"), \
             self.assertRaisesRegex(BuildControlError, "Controller source changed"):
            subject.preview(control, source, request)

    def test_history_rejects_possible_truncation(self):
        rows = [{"ref": str(i), "created_at": "1970-01-01T00:16:50Z"} for i in range(50)]
        with patch.object(subject, "docker_capture", self.history_fake(rows=rows)), self.assertRaises(BuildControlError):
            subject.history(self.request, self.original)

    def test_history_never_boots_stopped_builder(self):
        self.builder["Nodes"][0]["Status"] = "stopped"
        self.request["builders"] = [self.builder]
        with patch.object(subject, "docker_capture", self.history_fake()), self.assertRaises(BuildControlError):
            subject.history(self.request, self.original)

    def test_active_unattributed_record_is_rejected(self):
        active = [{"ref": "builder/node/" + "b" * 25, "created_at": "1970-01-01T00:16:50Z"}]
        record = self.native_record()
        record["CompletedAt"] = None
        record["Labels"] = []
        with patch.object(subject, "docker_capture", self.history_fake(rows=active, active=active, record=record)), self.assertRaises(BuildControlError):
            subject.history(self.request, self.original)

    def test_builder_aliases_share_one_worker_record(self):
        other = copy.deepcopy(self.builder)
        other["Name"] = "alias"
        self.request["builders"] = sorted([self.builder, other], key=lambda x: x["Name"])
        with patch.object(subject, "docker_capture", self.history_fake(builders=[self.builder, other])):
            self.assertEqual(subject.history(self.request, self.original), self.record)

    def test_worker_alias_is_deduplicated_before_context_specific_query(self):
        first = copy.deepcopy(self.builder)
        first["Name"] = "default"
        preferred = copy.deepcopy(self.builder)
        preferred["Name"] = "desktop-linux"
        self.request["builders"] = [first, preferred]
        self.request["buildkit_observer"] = {"kind": "windows-docker-desktop", "context": "desktop-linux"}
        fake = self.history_fake(builders=[first, preferred])
        calls = []
        def capture(_request, *args, **kwargs):
            if "--builder" in args:
                self.assertEqual(args[args.index("--builder") + 1], "desktop-linux")
                calls.append(args)
            return fake(*args, **kwargs)
        with patch.object(subject, "validate_observer"), patch.object(subject, "observer_capture", capture):
            self.assertEqual(subject.history(self.request, self.original), self.record)
        self.assertEqual(len(calls), 3)

    def test_distinct_worker_collision_is_ambiguous(self):
        other = copy.deepcopy(self.builder)
        other["Name"] = "other"
        other["Nodes"][0]["IDs"] = ["second-worker"]
        self.request["builders"] = [self.builder, other]
        with patch.object(subject, "docker_capture", self.history_fake(builders=[self.builder, other])), self.assertRaises(BuildControlError):
            subject.history(self.request, self.original)

    def test_live_client_parser_excludes_only_read_operations(self):
        safe = [["docker.exe", "stats", "--no-stream"], ["docker", "--context", "desktop-linux", "inspect", "id"],
                ["docker-buildx.exe", "history", "ls"], ["docker", "buildx", "history", "inspect", "ref"],
                ["docker-compose", "ps"], ["python", "scripts/docker_volume_toolchain_reconcile.py", "--preview"]]
        dangerous = [["python", "scripts/docker_dev.py", "--recreate-volume"],
                     ["python", "scripts/bootstrap_docker_toolchain.py"], ["just", "docker-dev"],
                     ["docker", "exec", "id", "echo", "inspect"],
                     ["docker", "run", "image", "inspect"], ["docker", "compose", "-f", "-", "build"],
                     ["docker", "buildx", "bake"], ["docker", "--unknown", "inspect"],
                     ["docker", "--context"], ["docker-buildx.exe", "build", "."]]
        for argv in safe:
            with self.subTest(argv=argv):
                self.assertFalse(subject.potential_build_client(argv))
        for argv in dangerous:
            with self.subTest(argv=argv):
                self.assertTrue(subject.potential_build_client(argv))

    def test_result_never_invents_exit_status_or_success(self):
        raw = subject.failure_result(self.raw, self.record, self.request, "9" * 64)
        result = json.loads(raw)
        self.assertEqual(result["state"], "failed-confirmed")
        self.assertNotIn("exit_code", result)
        self.assertNotIn("image_id", result)
        self.assertEqual(result["build_data_qualification"], "NOT VERIFIED")
        self.assertEqual(result["inputs"], self.original["inputs"])
        self.assertEqual(json.loads(self.raw), self.original)
        self.assertEqual(raw, subject.failure_result(self.raw, self.record, self.request, "9" * 64))
        self.assertNotEqual(raw, subject.failure_result(self.raw, self.record, self.request, "8" * 64))

    def test_publication_is_failure_only_and_keeps_verified_pin(self):
        control = SimpleNamespace(path=lambda p: "/control/" + p)
        script = publication.commit_script(control, "toolchain/attempts/" + "a" * 32,
            self.request, "toolchain/attempts/" + "a" * 32 + "/reconciliation/" + "9" * 64,
            "9" * 64, self.request["unknown_receipt_sha256"], phase="toolchain", publish_verified=False)
        targets = script.split("for p in ", 1)[1].split("; do", 1)[0]
        self.assertNotIn("verified.json", targets)
        self.assertTrue(targets.endswith("/terminal.json'"))
        self.assertIn("exec 8<>/control/operation.lock; if flock -n 8; then exit 72;", script)
        self.assertIn("test ! -e '/control/toolchain/verified.json'", script)
        self.assertIn(self.request["compose_sha256"], script)
        self.assertIn(self.request["build_log_sha256"], script)
        self.assertNotIn("rm /control/active", script)
        for schema, publish in [(subject.SCHEMA, True), (publication.SCHEMA, False),
                                (publication.PRESTART_SCHEMA, False)]:
            request = {**self.request, "schema": schema}
            with self.subTest(schema=schema, publish=publish), self.assertRaises(BuildControlError):
                publication.commit_script(control, "toolchain/attempts/" + "a" * 32,
                    request, "journal", "9" * 64, "0" * 64,
                    phase="toolchain", publish_verified=publish)

    def test_replay_only_accepts_own_exact_result_and_preserves_history(self):
        # Fake I/O executes controller transaction logic; it never invokes Docker.
        import docker_dev
        request_raw = canonical(self.request) + b"\n"
        request_sha = subject.digest(request_raw)
        args = SimpleNamespace(source_root=str(Path.cwd()), request="request.json",
                               request_sha256=request_sha, preview=False)
        root = "toolchain/attempts/" + "a" * 32
        result = subject.failure_result(self.raw, self.record, self.request, request_sha)
        files = {"request.json": request_raw, root + "/receipt.json": self.raw,
                 "active": b"a" * 32 + b"\n", root + "/compose.json": canonical(self.document)}
        self.request["compose_sha256"] = subject.digest(files[root + "/compose.json"])
        request_raw = canonical(self.request) + b"\n"
        request_sha = subject.digest(request_raw)
        args.request_sha256 = request_sha
        files["request.json"] = request_raw
        result = subject.failure_result(self.raw, self.record, self.request, request_sha)
        class FakeControl:
            project = "project"
            volume = "volume"
            def path(self, relative): return "/control/" + relative
            def helper_args(self, script): return [script]
            def write_bytes(self, relative, raw): files[relative] = raw
        control = FakeControl()
        def read(_control, relative, optional=False):
            if relative in files: return files[relative]
            if optional: return None
            raise AssertionError("Unexpected missing file " + relative)
        partial = [True]
        def commit(*_args, **_kwargs):
            files[root + "/receipt.json"] = result
            if partial[0]:
                partial[0] = False
                raise OSError("simulated client interruption after atomic first write")
            files["toolchain/current.json"] = result
            files[root + "/terminal.json"] = result
            del files["active"]  # Model only the original helper's terminal acknowledgement.
            return SimpleNamespace(returncode=0)
        configured = {"services": {"fem-gpu-toolchain": {"build": {"args": {"FULLMAG_CUDA_BASE_IMAGE": "pinned"}}}}}
        with patch.object(docker_dev, "_select_source", return_value=(Path.cwd(), {})), \
             patch.object(docker_dev, "_compose_identity", return_value={}), \
             patch.object(subject, "toolchain_configuration", return_value=configured), \
             patch.object(subject, "BuildControl", return_value=control), \
             patch.object(subject, "preview", return_value=(self.raw, self.record, {})), \
             patch.object(subject, "read_raw", side_effect=read), \
             patch.object(publication, "read_raw", side_effect=read), \
             patch.object(subject, "bounded_capture", side_effect=commit), \
             patch.object(subject, "_probe_helper_absence", return_value="absence-sha"):
            with self.assertRaises(OSError):
                subject.reconcile(args)
            self.assertNotIn(root + "/terminal.json", files)
            self.assertIn("active", files)
            subject.reconcile(args)
            self.assertEqual(files[root + "/unknown-receipt.json"], self.raw)
            self.assertEqual(files[root + "/terminal.json"], result)
            self.assertNotIn("toolchain/verified.json", files)
            subject.reconcile(args)  # Idempotent post-commit verification, no second mutation.
            foreign = json.loads(result)
            foreign["reconciliation"]["request_sha256"] = "0" * 64
            files[root + "/terminal.json"] = canonical(foreign) + b"\n"
            with self.assertRaises(BuildControlError):
                subject.reconcile(args)


    def test_time_filter_precedes_limit_but_running_filter_has_no_time_bound(self):
        fake = self.history_fake()
        calls = []
        def capture(*args, **kwargs):
            if args[:3] == ("buildx", "history", "ls"):
                calls.append(args)
            return fake(*args, **kwargs)
        with patch.object(subject, "docker_capture", capture):
            subject.history(self.request, self.original)
        self.assertEqual(len(calls), 2)
        self.assertIn("startedAt>1970-01-01T00:16:39Z", calls[0])
        self.assertFalse(any("startedAt>=" in item for item in calls[0]))
        self.assertIn("status=running", calls[1])
        self.assertFalse(any("startedAt" in item or "completedAt" in item for item in calls[1]))
        self.assertFalse(any("startedAt<" in item for args in calls for item in args))

    def test_old_running_build_is_not_hidden_by_time_window(self):
        active = [{"ref": "builder/node/" + "b" * 25, "created_at": "1970-01-01T00:00:01Z"}]
        record = self.native_record()
        record["StartedAt"] = "1970-01-01T00:00:01Z"
        record["CompletedAt"] = None
        with patch.object(subject, "docker_capture", self.history_fake(rows=[], active=active, record=record)), self.assertRaises(BuildControlError):
            subject.history(self.request, self.original)

    def test_unreviewed_server_filter_version_is_rejected(self):
        self.builder["Nodes"][0]["Version"] = "v0.31.0"
        self.request["builders"] = [self.builder]
        with patch.object(subject, "docker_capture", self.history_fake()), self.assertRaises(BuildControlError):
            subject.history(self.request, self.original)

    def test_observer_must_target_the_linux_control_engine(self):
        self.request["buildkit_observer"] = {"kind": "native"}
        with patch.object(subject, "docker_capture", return_value=SimpleNamespace(stdout=b"engine\n")), \
             patch.object(subject, "observer_capture", return_value=SimpleNamespace(stdout=b"other-engine\n")), \
             self.assertRaises(BuildControlError):
            subject.validate_observer(self.request)

    def test_observer_kind_and_native_options_are_closed(self):
        for observer in ({"kind": "unknown"}, {"kind": "native", "skip_checks": True}):
            self.request["buildkit_observer"] = observer
            with patch.object(subject, "docker_capture", return_value=SimpleNamespace(stdout=b"engine\n")), \
                 self.assertRaises(BuildControlError):
                subject.validate_observer(self.request)

    def test_windows_observer_executable_and_version_are_pinned(self):
        raw = b"synthetic pinned Docker executable"
        self.request["buildkit_observer"] = {"kind": "windows-docker-desktop",
            "executable": "/mnt/c/Docker/docker.exe", "context": "desktop-linux",
            "sha256": subject.digest(raw), "version": "1.2.3"}
        with patch.object(subject, "docker_capture", return_value=SimpleNamespace(stdout=b"engine\n")), \
             patch.object(Path, "read_bytes", return_value=raw), \
             patch.object(subject, "observer_capture", side_effect=[
                 SimpleNamespace(stdout=b"1.2.3\n"), SimpleNamespace(stdout=b"engine\n"),
                 SimpleNamespace(stdout=self.request["buildx_version"].encode() + b"\n")]):
            subject.validate_observer(self.request)
        for content, version in ((b"replaced executable", b"1.2.3\n"), (raw, b"wrong-version\n")):
            with patch.object(subject, "docker_capture", return_value=SimpleNamespace(stdout=b"engine\n")), \
                 patch.object(Path, "read_bytes", return_value=content), \
                 patch.object(subject, "observer_capture", return_value=SimpleNamespace(stdout=version)), \
                 self.assertRaises(BuildControlError):
                subject.validate_observer(self.request)

    def test_changed_or_missing_buildx_plugin_version_is_rejected(self):
        for changed in (b"other plugin version\n", b""):
            with self.subTest(changed=changed), \
                 patch.object(subject, "docker_capture", return_value=SimpleNamespace(stdout=b"engine\n")), \
                 patch.object(subject, "observer_capture", side_effect=[
                     SimpleNamespace(stdout=b"engine\n"), SimpleNamespace(stdout=changed)]), \
                 self.assertRaisesRegex(BuildControlError, "Buildx plugin version changed"):
                subject.validate_observer(self.request)
        self.request.pop("buildx_version")
        with self.assertRaisesRegex(BuildControlError, "Exact Buildx plugin version required"):
            subject.validate_request(self.request)


if __name__ == "__main__":
    unittest.main()
