"""Lightweight source and provenance checks for the fixed-service codegen route."""
from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_dev_codegen as codegen  # noqa: E402


class DockerDevCodegenTests(unittest.TestCase):
    def test_failed_command_retains_both_streams_and_exit_code(self) -> None:
        command = [sys.executable, '-B', '-c',
                   'import sys; print("compiler diagnostic"); print("wrapper failure", file=sys.stderr); sys.exit(7)']
        with mock.patch.object(codegen, '_docker_argv', return_value=command):
            with self.assertRaises(codegen.CodegenError) as raised:
                codegen._capture(('fixture',), timeout=5)
        self.assertEqual(raised.exception.exit_code, 7)
        self.assertEqual(raised.exception.stdout.strip(), b'compiler diagnostic')
        self.assertEqual(raised.exception.stderr.strip(), b'wrapper failure')
        self.assertFalse(raised.exception.reconciliation_required)

    @unittest.skipUnless(os.name == "posix" and shutil.which("bash"), "requires executable POSIX shell fixture")
    def test_just_wrapper_preserves_explicit_codegen_checkout(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            interpreter = Path(directory) / "python-probe"
            interpreter.write_text(
                f"#!{sys.executable}\nimport json, sys\n"
                "if sys.argv[1:2] != ['-c']: print(json.dumps(sys.argv[1:]))\n",
                encoding="utf-8",
            )
            interpreter.chmod(0o700)
            root = Path(__file__).resolve().parents[1]
            source = "/example/worktrees/selected checkout"
            recipe = f'python3 "{root}/scripts/docker_dev.py" --repo-root "{root}" codegen-openapi --source-root \'{source}\''
            result = subprocess.run(
                ["bash", str(root / "scripts/just_storage_shell.sh"), recipe],
                env={**os.environ, "FULLMAG_STORAGE_PYTHON": str(interpreter)},
                text=True, capture_output=True, check=True,
            )
            self.assertEqual(json.loads(result.stdout)[-3:], ["codegen-openapi", "--source-root", source])

    def test_frontend_requires_readonly_control_but_writable_build_state(self) -> None:
        document = {"Mounts": [
            {"Destination": "/opt/fullmag/source", "Type": "bind", "RW": False},
            {"Destination": "/state/development", "Type": "volume", "RW": True},
            {"Destination": "/opt/fullmag/control", "Type": "volume", "RW": False},
        ]}
        codegen._validate_mounts(document, "frontend")
        document["Mounts"][-1]["RW"] = True
        with self.assertRaisesRegex(codegen.CodegenError, "readonly"):
            codegen._validate_mounts(document, "frontend")

    def test_path_identity_normalizes_windows_and_wsl_forms(self) -> None:
        expected = codegen._path_identity(r"C:\git\fullmag\fullmag")
        for alias in (
            "/mnt/c/git/fullmag/fullmag",
            "/host_mnt/c/git/fullmag/fullmag",
            "/run/desktop/mnt/host/c/git/fullmag/fullmag",
        ):
            self.assertEqual(expected, codegen._path_identity(alias))

    def test_source_probe_uses_backend_module_root(self) -> None:
        self.assertIn('sys.path.insert(0, "/opt/fullmag")', codegen.SOURCE_PROBE_SCRIPT)

    def test_frontend_codegen_runs_from_persistent_workspace_state(self) -> None:
        with mock.patch.object(codegen, "_exec", return_value=(b"ok", b"")) as execute:
            codegen._run_frontend("frontend-id", ("/usr/local/bin/node", "--version"))
        _container, _arguments = execute.call_args.args[:2]
        options = execute.call_args.kwargs
        self.assertEqual(options["workdir"], "/state/development/workspace")
        self.assertEqual(options["environment"]["HOME"], "/state/development")
        self.assertEqual(options["environment"]["npm_config_store_dir"], "/state/development/pnpm-store")

    def test_running_service_requires_actual_host_source_mount_and_env(self) -> None:
        identity = {
            "project_id": "project-id",
            "worktree_id": "worktree-id",
            "checkout_kind": "worktree",
        }
        labels = {
            "com.docker.compose.project": "project",
            "com.docker.compose.service": "backend",
            "org.fullmag.compose.project": "project",
            "org.fullmag.source.project-id": "project-id",
            "org.fullmag.source.worktree-id": "worktree-id",
            "org.fullmag.source.checkout-kind": "worktree",
        }
        document = {
            "State": {"Running": True},
            "Image": "sha256:" + "a" * 64,
            "Config": {
                "Image": "fullmag/backend:dev",
                "Labels": labels,
                "Env": [r"FULLMAG_SOURCE_HOST_ROOT=C:\git\fullmag\fullmag"],
            },
            "Mounts": [
                {
                    "Destination": "/opt/fullmag/source",
                    "Type": "bind",
                    "RW": False,
                    "Source": "/run/desktop/mnt/host/c/git/fullmag/fullmag",
                },
                {
                    "Destination": "/opt/fullmag/source-git",
                    "Type": "bind",
                    "RW": False,
                    "Source": "/run/desktop/mnt/host/c/git/fullmag/fullmag/.git",
                },
                {"Destination": "/build", "Type": "volume", "RW": True},
                {"Destination": "/opt/fullmag/package", "Type": "volume", "RW": True},
                {"Destination": "/opt/fullmag/control", "Type": "volume", "RW": True},
            ],
        }
        with mock.patch.object(codegen, "_capture", return_value=(b"container-id\n", b"")):
            with mock.patch.object(codegen, "_inspect", return_value=document):
                container, observed = codegen._running_service(
                    "project", "backend", identity, Path(r"C:\git\fullmag\fullmag")
                )
        self.assertEqual(container, "container-id")
        self.assertIs(observed, document)

        document["Config"]["Env"] = [r"FULLMAG_SOURCE_ROOT=C:\git\fullmag\fullmag"]
        with mock.patch.object(codegen, "_capture", return_value=(b"container-id\n", b"")):
            with mock.patch.object(codegen, "_inspect", return_value=document):
                with self.assertRaises(codegen.CodegenError):
                    codegen._running_service(
                        "project", "backend", identity, Path(r"C:\git\fullmag\fullmag")
                    )

    def _admitted_wsl_services(self):
        from bootstrap_docker_toolchain import control_volume_name
        from docker_build_control import canonical
        selected = Path("/home/kking/git/fullmag/worktrees/antenna")
        alias = "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu/" + "5d" * 32
        identity = {"project_id":"project-id", "worktree_id":"worktree-id", "checkout_kind":"worktree"}
        image = "sha256:" + "a" * 64
        ids = {"backend":"b" * 64, "frontend":"f" * 64}
        control = control_volume_name("project")
        owner = "/run/fullmag/frontend-owner"
        owner_options = "rw,nosuid,nodev,noexec,size=1m,uid=65532,gid=65532,mode=0700"
        compose = {"name":"project", "services":{}, "volumes":{}}
        actual = {}
        for role in ids:
            labels = {"com.docker.compose.project":"project", "com.docker.compose.service":role,
                "org.fullmag.compose.project":"project", "org.fullmag.source.project-id":"project-id",
                "org.fullmag.source.worktree-id":"worktree-id", "org.fullmag.source.checkout-kind":"worktree"}
            environment = {"FULLMAG_SOURCE_HOST_ROOT" if role == "backend" else "FULLMAG_SOURCE_ROOT":str(selected)}
            volumes = [{"target":"/opt/fullmag/source", "type":"bind", "read_only":True, "source":str(selected)}]
            pins = {"/opt/fullmag/source":alias}
            if role == "backend":
                volumes.append({"target":"/opt/fullmag/source-git", "type":"bind", "read_only":True,
                    "source":"/home/kking/git/fullmag/.git"})
                pins["/opt/fullmag/source-git"] = "/home/kking/git/fullmag/.git"
            for target, name, readonly in (("/build","build",False), ("/opt/fullmag/package","package",False),
                    ("/opt/fullmag/control","control",role == "frontend")) if role == "backend" else (
                    ("/state/development","state",False), ("/opt/fullmag/control","control",True)):
                compose["volumes"][name] = {"name":control if name == "control" else "project-" + name}
                volumes.append({"target":target,"type":"volume","source":name,"read_only":readonly})
            expected = {"image":image, "environment":environment, "labels":labels,
                "volumes":volumes,"x-fullmag-daemon-binds":pins}
            if role == "frontend":
                expected["tmpfs"] = [owner + ":" + owner_options]
            compose["services"][role] = expected
            mounts = [{"Destination":v["target"],"Type":v["type"],"RW":not v["read_only"],
                **({"Source":pins[v["target"]]} if v["type"] == "bind" else
                   {"Name":compose["volumes"][v["source"]]["name"]})} for v in volumes]
            if role == "frontend":
                mounts.append({"Destination":owner,"Type":"tmpfs","RW":True})
            actual[role] = {"Id":ids[role],"Image":image,"State":{"Running":True},
                "Config":{"Image":image,"Labels":labels,"Env":[k + "=" + v for k,v in environment.items()]},
                "HostConfig":{"ReadonlyRootfs":True,"Privileged":False,
                    "Tmpfs":{owner:owner_options} if role == "frontend" else {}},"Mounts":mounts}
        receipt = {"schema":"fullmag.docker-build-operation.v1","phase":"development","state":"succeeded",
            "attempt":"c" * 32,"compose_project":"project","backend_container":ids["backend"],
            "frontend_container":ids["frontend"],"inputs":{"source_root":str(selected),
                **{"source_" + k:v for k,v in identity.items()}},"config_sha256":codegen._sha256(canonical(compose))}
        return selected, identity, compose, actual, receipt

    def _select_admitted_wsl_service(self, role, fixture, *, terminal=None, changed_verified=None):
        selected, identity, compose, actual, receipt = fixture
        receipt_raw = codegen._canonical_json(receipt)
        reads = []
        def capture(arguments, **_kwargs):
            target = next(a.rsplit("=",1)[1] for a in arguments if a.startswith("label=com.docker.compose.service="))
            return actual[target]["Id"].encode() + b"\n", b""
        def inspect(identifier):
            if identifier.startswith("sha256:"):
                return {"Id":identifier,"Config":{}}
            return next(document for document in actual.values() if document["Id"] == identifier)
        def execute(container, arguments, **_kwargs):
            self.assertEqual(container, actual["backend"]["Id"])
            self.assertEqual(arguments[:4], ("/bin/bash","-euo","pipefail","-c"))
            script = arguments[4]
            reads.append(script)
            if "/development/verified.json" in script:
                return (changed_verified if changed_verified is not None and len(reads) > 3 else receipt_raw), b""
            self.assertIn("development/attempts/" + receipt["attempt"], script)
            if "/terminal.json" in script:
                return receipt_raw if terminal is None else terminal, b""
            self.assertIn("/compose.json", script)
            return codegen._canonical_json(compose), b""
        with mock.patch.object(codegen,"_capture",side_effect=capture), mock.patch.object(
                codegen,"_inspect",side_effect=inspect), mock.patch.object(codegen,"_exec",side_effect=execute):
            result = codegen._running_service("project",role,identity,selected)
        self.assertEqual(len(reads),4)
        return result

    def test_wsl_daemon_alias_requires_exact_succeeded_admission_for_both_services(self):
        for role in ("backend","frontend"):
            with self.subTest(role=role):
                fixture = self._admitted_wsl_services()
                container, document = self._select_admitted_wsl_service(role,fixture)
                self.assertEqual(container, fixture[3][role]["Id"])
                self.assertIs(document,fixture[3][role])
                self.assertNotEqual(codegen._path_identity(document["Mounts"][0]["Source"]),
                    codegen._path_identity(str(fixture[0])))

    def test_admitted_wsl_alias_refuses_daemon_or_compose_drift(self):
        from docker_build_control import canonical
        for change in ("daemon", "daemon-case", "configured-source", "pin", "readonly", "control", "stopped", "image", "labels"):
            with self.subTest(change=change):
                fixture = self._admitted_wsl_services()
                compose, actual = fixture[2:4]
                if change == "daemon": actual["backend"]["Mounts"][0]["Source"] += "different"
                elif change == "daemon-case": actual["backend"]["Mounts"][0]["Source"] = actual["backend"]["Mounts"][0]["Source"].upper()
                elif change == "configured-source": compose["services"]["backend"]["volumes"][0]["source"] = "/foreign"
                elif change == "pin": compose["services"]["backend"]["x-fullmag-daemon-binds"]["/opt/fullmag/source"] += "different"
                elif change == "readonly": actual["frontend"]["Mounts"][0]["RW"] = True
                elif change == "control": next(m for m in actual["backend"]["Mounts"] if m["Destination"] == "/opt/fullmag/control")["Name"] = "foreign-control"
                elif change == "stopped": actual["frontend"]["State"]["Running"] = False
                elif change == "image": actual["frontend"]["Image"] = "sha256:" + "d" * 64
                else: actual["frontend"]["Config"]["Labels"] = {"com.docker.compose.project":"foreign"}
                if change in ("configured-source", "pin"):
                    fixture[4]["config_sha256"] = codegen._sha256(canonical(compose))
                with self.assertRaises(codegen.CodegenError):
                    self._select_admitted_wsl_service("backend",fixture)

    def test_admitted_wsl_alias_refuses_foreign_source_or_wrong_receipt(self):
        for key, value in (("schema","wrong"),("phase","image-dev"),("state","failed"),
                ("attempt","../foreign"),("compose_project","foreign"),("config_sha256","d" * 64),
                ("backend_container","e" * 64),("frontend_container","e" * 64)):
            with self.subTest(key=key):
                fixture = self._admitted_wsl_services()
                fixture[4][key] = value
                with self.assertRaises(codegen.CodegenError):
                    self._select_admitted_wsl_service("frontend",fixture)
        fixture = list(self._admitted_wsl_services())
        fixture[0] = Path("/home/kking/git/foreign")
        for role, name in (("backend","FULLMAG_SOURCE_HOST_ROOT"),("frontend","FULLMAG_SOURCE_ROOT")):
            fixture[3][role]["Config"]["Env"] = [name + "=" + str(fixture[0])]
        with self.assertRaises(codegen.CodegenError):
            self._select_admitted_wsl_service("frontend",fixture)

    def test_wsl_alias_refuses_metadata_without_pins_and_changed_admission(self):
        fixture = self._admitted_wsl_services()
        fixture[2]["services"]["backend"].pop("x-fullmag-daemon-binds")
        from docker_build_control import canonical
        fixture[4]["config_sha256"] = codegen._sha256(canonical(fixture[2]))
        with self.assertRaisesRegex(codegen.CodegenError,"daemon bind"):
            self._select_admitted_wsl_service("backend",fixture)
        fixture = self._admitted_wsl_services()
        with self.assertRaisesRegex(codegen.CodegenError,"terminal"):
            self._select_admitted_wsl_service("backend",fixture,terminal=b"{}")
        with self.assertRaisesRegex(codegen.CodegenError,"changed"):
            self._select_admitted_wsl_service("backend",fixture,changed_verified=b"{}")

    def test_backend_provenance_requires_receipt_and_binary_binding(self) -> None:
        receipt_sha = "a" * 64
        provenance_sha = "b" * 64
        binary_sha = "c" * 64
        native = {"source_snapshot_sha256": "d" * 64, "source_snapshot_dirty": True}
        receipt = {
            "schema": "fullmag.direct-compose.backend-build-receipt.v1",
            "state": "succeeded",
            "source": {
                "resolved_commit": "e" * 40,
                "source_digest": "f" * 64,
            },
            "native_source_identity": native,
            "artifacts": [{"path": "bin/fullmag-api", "sha256": binary_sha}],
        }
        provenance = {
            "schema": "fullmag.docker-all-image.v1",
            "state": "succeeded",
            "build_receipt_sha256": receipt_sha,
            "binary_hashes": {"fullmag-api": binary_sha},
        }
        identity, observed_provenance_sha, observed_binary_sha = codegen._validate_backend(
            receipt, provenance, receipt_sha, f"{provenance_sha}:{binary_sha}"
        )
        self.assertEqual(identity["commit"], "e" * 40)
        self.assertEqual(observed_provenance_sha, provenance_sha)
        self.assertEqual(observed_binary_sha, binary_sha)
        provenance["build_receipt_sha256"] = "1" * 64
        with self.assertRaises(codegen.CodegenError):
            codegen._validate_backend(
                receipt, provenance, receipt_sha, f"{provenance_sha}:{binary_sha}"
            )

    def test_mount_validation_requires_named_volume_technical_state(self) -> None:
        mounts = [
            {"Destination": "/opt/fullmag/source", "Type": "bind", "RW": False},
            {"Destination": "/opt/fullmag/source-git", "Type": "bind", "RW": False},
            {"Destination": "/build", "Type": "volume", "RW": True},
            {"Destination": "/opt/fullmag/package", "Type": "volume", "RW": True},
            {"Destination": "/opt/fullmag/control", "Type": "volume", "RW": True},
        ]
        codegen._validate_mounts({"Mounts": mounts}, "backend")
        mounts[2]["Type"] = "bind"
        with self.assertRaises(codegen.CodegenError):
            codegen._validate_mounts({"Mounts": mounts}, "backend")

    def test_source_match_rejects_changed_native_snapshot(self) -> None:
        native = {"source_snapshot_sha256": "a" * 64, "source_snapshot_dirty": False}
        backend = {
            "commit": "b" * 40,
            "snapshot": "a" * 64,
            "source_digest": "c" * 64,
            "native": native,
        }
        probe = {
            "resolved_commit": "b" * 40,
            "source_snapshot_sha256": "a" * 64,
            "source_digest": "c" * 64,
            "native_source_identity": dict(native),
        }
        self.assertTrue(codegen._source_matches(probe, backend))
        probe["native_source_identity"]["source_snapshot_dirty"] = True
        self.assertFalse(codegen._source_matches(probe, backend))

    def test_docker_dev_parser_exposes_codegen_without_lifecycle_options(self) -> None:
        import docker_dev

        parsed = docker_dev._parser().parse_args(["--repo-root", ".", "codegen-openapi"])
        self.assertEqual(parsed.action, "codegen-openapi")
        self.assertIsNone(parsed.source_root)

    def test_output_snapshot_hash_is_canonical_and_changes_with_any_output(self) -> None:
        first = {"b": b"two", "a": b"one"}
        second = {"a": b"one", "b": b"two"}
        self.assertEqual(codegen._output_snapshot_sha256(first), codegen._output_snapshot_sha256(second))
        second["b"] = b"changed"
        self.assertNotEqual(codegen._output_snapshot_sha256(first), codegen._output_snapshot_sha256(second))

    def test_receipt_key_is_deterministic_and_excludes_ephemeral_stage(self) -> None:
        source_identity = {"git_commit": "a" * 40, "source_digest": "b" * 64}
        tools = {"node": "v1", "pnpm": "v2"}
        first = codegen._codegen_receipt_key(source_identity, "c" * 64, "d" * 64, tools)
        second = codegen._codegen_receipt_key(
            dict(reversed(tuple(source_identity.items()))), "c" * 64, "d" * 64,
            dict(reversed(tuple(tools.items()))),
        )
        self.assertEqual(first, second)
        self.assertNotEqual(codegen._codegen_receipt_key(source_identity, "c" * 64, "d" * 64, {"node": "v3", "pnpm": "v2"}), first)

    def test_failure_receipt_is_bounded_and_preserves_uncertain_cleanup(self) -> None:
        error = codegen.CodegenError("stdout " + "x" * 10000, reconciliation_required=True)
        receipt = codegen._failure_receipt_document(
            project="project",
            phase="frontend-codegen",
            error=error,
            backend_id="backend-id",
            frontend_id="frontend-id",
            stage="stage-id",
            cleanup_state="unknown",
            started=0.0,
        )
        self.assertEqual(receipt["state"], "failed")
        self.assertEqual(receipt["outcome"], "unknown")
        self.assertFalse(receipt["staging"]["cleanup_confirmed"])
        self.assertTrue(receipt["error"]["reconciliation_required"])
        self.assertLessEqual(len(receipt["error"]["message"]), 1024)
        self.assertEqual(receipt["staging"]["stage_id"], "stage-id")

    def test_technical_volume_inspection_rejects_redirected_local_volume(self) -> None:
        unsafe = {
            "Name": "volume",
            "Driver": "local",
            "Options": {"type": "none", "o": "bind", "device": "/mnt/c/build"},
            "Scope": "local",
            "Mountpoint": "/var/lib/docker/volumes/volume/_data",
        }
        with mock.patch.object(codegen, "_capture", return_value=(json.dumps([unsafe]).encode(), b"")):
            with self.assertRaises(codegen.CodegenError):
                codegen._inspect_named_volume("volume")

    def test_technical_volume_inspection_binds_frontend_control_subpath(self) -> None:
        from bootstrap_docker_toolchain import control_volume_name

        project = "project"
        control = control_volume_name(project)
        names = {
            "build": "project-build",
            "package": "project-package",
            "state": "project-state",
            "control": control,
        }
        documents = {
            name: {
                "Name": name,
                "Driver": "local",
                "Options": {},
                "Scope": "local",
                "Mountpoint": f"/var/lib/docker/volumes/{name}/_data",
            }
            for name in names.values()
        }
        backend = {
            "Mounts": [
                {"Destination": "/build", "Type": "volume", "RW": True, "Name": names["build"],
                 "Source": f"/var/lib/docker/volumes/{names['build']}/_data"},
                {"Destination": "/opt/fullmag/package", "Type": "volume", "RW": True, "Name": names["package"],
                 "Source": f"/var/lib/docker/volumes/{names['package']}/_data"},
                {"Destination": "/opt/fullmag/control", "Type": "volume", "RW": True, "Name": control,
                 "Source": f"/var/lib/docker/volumes/{control}/_data"},
            ],
            "HostConfig": {"Mounts": [
                {"Type": "volume", "Source": names["build"], "Target": "/build",
                 "VolumeOptions": {"NoCopy": True}},
                {"Type": "volume", "Source": names["package"], "Target": "/opt/fullmag/package",
                 "VolumeOptions": {"NoCopy": True}},
                {"Type": "volume", "Source": control, "Target": "/opt/fullmag/control",
                 "VolumeOptions": {"NoCopy": True}},
            ]},
        }
        frontend = {
            "Mounts": [
                {"Destination": "/state/development", "Type": "volume", "RW": True, "Name": names["state"],
                 "Source": f"/var/lib/docker/volumes/{names['state']}/_data"},
                {
                    "Destination": "/opt/fullmag/control",
                    "Type": "volume",
                    "RW": True,
                    "Name": control,
                    "Source": f"/var/lib/docker/volumes/{control}/_data",
                },
            ],
            "HostConfig": {"Mounts": [
                {"Type": "volume", "Source": names["state"], "Target": "/state/development",
                 "VolumeOptions": {"NoCopy": True}},
                {"Type": "volume", "Source": control, "Target": "/opt/fullmag/control",
                 "VolumeOptions": {"NoCopy": True, "Subpath": "frontend"}},
            ]},
        }
        with mock.patch.object(codegen, "_inspect_named_volume", side_effect=lambda name: documents[name]):
            inspected = codegen._inspect_technical_volumes(project, backend, frontend)
        self.assertEqual(inspected["control_volume_name"], control)
        self.assertEqual(inspected["mounts"]["frontend"]["/opt/fullmag/control"]["subpath"], "frontend")

        frontend["HostConfig"]["Mounts"][1]["VolumeOptions"].pop("Subpath")
        with mock.patch.object(codegen, "_inspect_named_volume", side_effect=lambda name: documents[name]):
            with self.assertRaises(codegen.CodegenError):
                codegen._inspect_technical_volumes(project, backend, frontend)

    def test_output_baseline_and_publication_are_four_file_scoped(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            generated = source / "apps/control-room/src/kernel/api/generated"
            generated.mkdir(parents=True)
            names = ("openapi-v2.json", "openapi-v2-types.ts", "openapi-v2-client.ts", "openapi-v2-paths.ts")
            before = codegen._output_baseline(source, names)
            outputs = {name: name.encode() for name in names}
            published = codegen._publish_outputs(source, outputs, before)
            self.assertEqual(set(published), set(names))
            self.assertEqual({name: (generated / name).read_bytes() for name in names}, outputs)


    @unittest.skipUnless(os.name == "posix", "requires POSIX permission bits")
    def test_published_sources_are_world_readable_before_atomic_replace(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary)
            generated = source / "apps/control-room/src/kernel/api/generated"
            generated.mkdir(parents=True)
            names = ("openapi-v2.json", "openapi-v2-types.ts", "openapi-v2-client.ts", "openapi-v2-paths.ts")
            before = codegen._output_baseline(source, names)
            replace = os.replace
            observed = []
            def publish(prepared, destination):
                self.assertEqual(stat.S_IMODE(prepared.stat().st_mode), 0o644)
                observed.append(destination.name)
                replace(prepared, destination)
            with mock.patch.object(codegen.os, "replace", side_effect=publish):
                codegen._publish_outputs(source, {name:name.encode() for name in names}, before)
            self.assertEqual(observed, list(names))
            for name in names:
                self.assertEqual(stat.S_IMODE((generated / name).stat().st_mode), 0o644)
                self.assertEqual((generated / name).read_bytes(), name.encode())

    @unittest.skipUnless(os.name == "posix", "requires POSIX permission bits")
    def test_chmod_failure_and_source_collision_preserve_existing_outputs(self) -> None:
        for failure in ("chmod", "collision"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temporary:
                source = Path(temporary)
                generated = source / "apps/control-room/src/kernel/api/generated"
                generated.mkdir(parents=True)
                names = ("openapi-v2.json", "openapi-v2-types.ts", "openapi-v2-client.ts", "openapi-v2-paths.ts")
                for name in names:
                    (generated / name).write_bytes(b"previous")
                    (generated / name).chmod(0o640)
                before = codegen._output_baseline(source, names)
                if failure == "collision":
                    (generated / names[0]).write_bytes(b"concurrent edit")
                preserved = {name:((generated / name).read_bytes(), (generated / name).stat().st_mode) for name in names}
                outputs = {name:name.encode() for name in names}
                if failure == "chmod":
                    with mock.patch.object(codegen.os, "chmod", side_effect=PermissionError("refused")):
                        with self.assertRaises(PermissionError):
                            codegen._publish_outputs(source, outputs, before)
                else:
                    with self.assertRaisesRegex(codegen.CodegenError, "changed while codegen"):
                        codegen._publish_outputs(source, outputs, before)
                self.assertEqual({name:((generated / name).read_bytes(), (generated / name).stat().st_mode) for name in names}, preserved)
                self.assertEqual(sorted(path.name for path in generated.iterdir()), sorted(names))


if __name__ == "__main__":
    unittest.main()
