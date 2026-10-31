from __future__ import annotations

import ast
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

import docker_group_storage as group_storage
from bootstrap_docker_toolchain import control_volume_name


class FakeControl:
    def __init__(self, source: Path, *, project="fullmag-worktree-alpha", worktree="alpha",
                 namespace="", extra_identity=None):
        self.project = project
        self.namespace = namespace
        self.volume = control_volume_name(project)
        self.identity = {
            "project_name": project,
            "project_id": "source-project-alpha",
            "worktree_id": worktree,
            "source_root": str(source.resolve()),
            **(extra_identity or {}),
        }
        self.shared_labels = {
            "com.fullmag.compose.project": project,
            "com.fullmag.toolchain.control.schema": "fullmag.docker-toolchain-control.v1",
            "com.fullmag.toolchain.control.project": project,
            "com.fullmag.toolchain.control.mount": "/opt/fullmag/control",
        }
        self._active_operation = None
        self.helper_calls = []

    def subpath(self, relative=""):
        return "/".join(part for part in (self.namespace, relative) if part)

    def helper_args(self, script, *, initialize=False):
        self.helper_calls.append({"script": script, "initialize": initialize})
        mount = f"type=volume,src={self.volume},dst=/control,volume-nocopy"
        if self.namespace:
            mount += f",volume-subpath={self.namespace}"
        return ["docker", "run", "--network", "none", "--cap-drop", "ALL",
                "--cap-add", "CHOWN", "--user", "0:0" if initialize else "65532:65532",
                "--mount", mount, "--entrypoint", "/bin/bash", "image@sha256:" + "a" * 64,
                "-euo", "pipefail", "-c", script]


class DockerGroupStorageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.temp_root = Path(self.temporary.name).resolve(strict=True)
        self.source = self.temp_root / "source"
        self.source.mkdir()
        self.source = self.source.resolve(strict=True)
        self.control = FakeControl(self.source)
        self.operation = self.operation_for(self.control, self.source)
        self.control._active_operation = self.operation
        self.inspect_calls = []
        self.helper_calls = []

    @staticmethod
    def operation_for(control, source):
        attempt = "a" * 32
        phase = "backend-build"
        return {
            "root": f"{phase}/attempts/{attempt}",
            "receipt": {
                "phase": phase,
                "attempt": attempt,
                "compose_project": control.project,
                "control_volume": control.volume,
                "inputs": {"source_root": str(source.resolve())},
            },
        }

    def docker_ok(self, *args, **kwargs):
        self.inspect_calls.append((args, kwargs))
        document = {
            "Name": self.control.volume,
            "Driver": "local",
            "Options": None,
            "Labels": dict(self.control.shared_labels),
        }
        return subprocess.CompletedProcess(args, 0, json.dumps([document]).encode(), b"")

    def bounded_ok(self, command, **kwargs):
        self.helper_calls.append((command, kwargs))
        return subprocess.CompletedProcess(command, 0, b"", b"")

    def prepare(self, *, control=None, operation=None, source=None, docker=None, bounded=None):
        return group_storage.prepare(
            control or self.control,
            self.operation if operation is None else operation,
            self.source if source is None else source,
            docker=self.docker_ok if docker is None else docker,
            bounded=self.bounded_ok if bounded is None else bounded,
        )

    def test_roles_and_compose_and_cli_mounts_are_exact(self):
        self.assertEqual(group_storage.role_subpath(self.control, "backend"), "private/backend")
        self.assertEqual(group_storage.role_subpath(self.control, "frontend"), "private/frontend")
        self.assertEqual(group_storage.role_subpath(self.control, "ledger"), "private/ledger")
        self.assertEqual(group_storage.volume_declaration(self.control),
                         {"name": self.control.volume, "external": True})
        self.assertEqual(
            group_storage.compose_mount_descriptor(
                self.control, "backend", "/opt/fullmag/backend-build"),
            {
                "type": "volume", "source": "backend-build-cache",
                "target": "/opt/fullmag/backend-build", "read_only": False,
                "volume": {"nocopy": True, "subpath": "private/backend"},
            },
        )
        self.assertEqual(
            group_storage.cli_mount_args(self.control, "ledger", "/host-ledger", read_only=True),
            ["--mount", f"type=volume,src={self.control.volume},dst=/host-ledger,readonly,volume-nocopy,volume-subpath=private/ledger"],
        )

    def test_compose_aliases_can_match_existing_launchers(self):
        declarations = group_storage.compose_volume_declarations(
            self.control, {"backend": "backend-cache-build"})
        self.assertEqual(declarations["backend-cache-build"], {
            "name": self.control.volume, "external": True,
        })
        with self.assertRaises(group_storage.GroupStorageError):
            group_storage.compose_volume_declarations(
                self.control, {"backend": "same", "frontend": "same"})

    def test_namespace_prefixes_roles_and_control_mount(self):
        control = FakeControl(self.source, namespace="namespaces/" + "b" * 32)
        self.assertEqual(group_storage.role_subpath(control, "frontend"),
                         "namespaces/" + "b" * 32 + "/private/frontend")
        mount = group_storage.compose_mount_descriptor(
            control, "control", "/opt/fullmag/control", compose_name="control-volume")
        self.assertEqual(mount["source"], "control-volume")
        self.assertEqual(mount["volume"], {
            "nocopy": True, "subpath": "namespaces/" + "b" * 32,
        })

    def test_rejects_unknown_roles_malicious_paths_and_namespaces(self):
        for role in ("root", "private/../../escape", "BACKEND"):
            with self.subTest(role=role), self.assertRaises(group_storage.GroupStorageError):
                group_storage.role_subpath(self.control, role)
        for target in ("relative/path", "/safe/../escape", "/safe//path", "/safe,readonly"):
            with self.subTest(target=target), self.assertRaises(group_storage.GroupStorageError):
                group_storage.compose_mount_descriptor(self.control, "backend", target)
        for namespace in ("../foreign", "namespaces/../x", "namespaces/" + "A" * 32,
                          "namespaces/" + "b" * 31):
            control = FakeControl(self.source, namespace=namespace)
            with self.subTest(namespace=namespace), self.assertRaises(group_storage.GroupStorageError):
                group_storage.role_subpath(control, "backend")

    def test_control_volume_identity_ignores_toolchain_profile_and_commit(self):
        first = self.prepare()
        other = FakeControl(self.source, extra_identity={
            "toolchain_fingerprint": "f" * 64,
            "build_profile": "frontend-v99",
            "source_commit": "d" * 40,
            "cache_key": "e" * 64,
        })
        second_operation = self.operation_for(other, self.source)
        other._active_operation = second_operation
        second = group_storage.prepare(other, second_operation, self.source,
                                       docker=self.docker_ok, bounded=self.bounded_ok)
        self.assertEqual(first["control_volume"], second["control_volume"])
        self.assertEqual(first, second)
        self.assertNotIn("toolchain_fingerprint", first)
        self.assertNotIn("source_commit", first)

    def test_distinct_worktrees_get_distinct_stable_volumes(self):
        other = FakeControl(self.source, project="fullmag-worktree-beta", worktree="beta")
        self.assertNotEqual(self.control.volume, other.volume)
        self.assertEqual(self.control.volume, control_volume_name(self.control.project))
        self.assertEqual(other.volume, control_volume_name(other.project))

    def test_prepare_requires_active_operation_and_never_creates_volume(self):
        self.control._active_operation = None
        with self.assertRaises(group_storage.GroupStorageError):
            self.prepare()
        self.assertEqual(self.inspect_calls, [])
        self.assertEqual(self.control.helper_calls, [])

        self.control._active_operation = self.operation
        result = self.prepare()
        self.assertEqual([call[0] for call in self.inspect_calls],
                         [("volume", "inspect", self.control.volume)])
        self.assertTrue(self.control.helper_calls[0]["initialize"])
        self.assertEqual(len(self.helper_calls), 1)
        self.assertEqual(result["control_volume"], self.control.volume)

    def test_missing_or_foreign_volume_refuses_before_helper(self):
        def missing(*args, **kwargs):
            return subprocess.CompletedProcess(args, 1, b"", b"no such volume")
        with self.assertRaises(group_storage.GroupStorageError):
            self.prepare(docker=missing)
        self.assertEqual(self.control.helper_calls, [])
        self.assertEqual(self.helper_calls, [])

        def foreign(*args, **kwargs):
            document = {"Name": self.control.volume, "Driver": "local", "Options": None,
                        "Labels": {"com.fullmag.compose.project": "another-group"}}
            return subprocess.CompletedProcess(args, 0, json.dumps([document]).encode(), b"")
        with self.assertRaises(group_storage.GroupStorageError):
            self.prepare(docker=foreign)
        self.assertEqual(self.control.helper_calls, [])
        self.assertEqual(self.helper_calls, [])

    def test_wrong_source_path_and_source_symlink_refuse_before_docker(self):
        other = self.temp_root / "other"
        other.mkdir()
        with self.assertRaises(group_storage.GroupStorageError):
            self.prepare(source=other)
        self.assertEqual(self.inspect_calls, [])

        link = self.temp_root / "source-link"
        try:
            link.symlink_to(self.source, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("host does not permit creating a directory symlink")
        with self.assertRaises(group_storage.GroupStorageError):
            self.prepare(source=link)
        self.assertEqual(self.inspect_calls, [])

    def test_owner_manifest_binds_stable_source_group_and_root_helper_scope(self):
        manifest = self.prepare()
        self.assertEqual(manifest["schema"], "fullmag.docker-group-storage-owner.v1")
        self.assertEqual(manifest["source_root"], str(self.source.resolve()))
        self.assertEqual(manifest["source_worktree_id"], "alpha")
        self.assertEqual(manifest["source_project_id"], "source-project-alpha")
        self.assertEqual(manifest["layout"]["roles"], {
            "backend": "private/backend", "frontend": "private/frontend",
            "ledger": "private/ledger",
        })
        command = self.helper_calls[0][0]
        script = command[-1]
        self.assertTrue(self.control.helper_calls[0]["initialize"])
        self.assertIn(".owner.json", script)
        self.assertIn("65532", script)
        self.assertIn("backend", script)
        self.assertIn("frontend", script)
        self.assertIn("ledger", script)
        self.assertEqual(command[command.index("--user") + 1], "0:0")
        self.assertIn("CHOWN", command)
        self.assertIn("--cap-drop", command)

    def test_operation_receipt_must_bind_source_project_and_volume(self):
        bad = self.operation_for(self.control, self.source)
        bad["receipt"]["control_volume"] = "foreign-volume"
        with self.assertRaises(group_storage.GroupStorageError):
            self.prepare(operation=bad)
        self.assertEqual(self.inspect_calls, [])

        bad_source = self.operation_for(self.control, self.source)
        bad_source["receipt"]["inputs"]["source_root"] = str(Path(self.temporary.name).resolve())
        with self.assertRaises(group_storage.GroupStorageError):
            self.prepare(operation=bad_source)
        self.assertEqual(self.inspect_calls, [])

    def test_guest_initializer_is_valid_python_and_only_chowns_role_leaves(self):
        self.prepare()
        script = self.helper_calls[0][0][-1]
        guest = script.split("python3 - <<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]
        ast.parse(guest)
        self.assertIn("os.geteuid() != 0", guest)
        self.assertIn("os.O_NOFOLLOW", guest)
        self.assertIn("os.fchown(role_fd, 65532, 65532)", guest)
        self.assertNotIn("os.chown(", guest)
        self.assertIn(".owner.json", guest)


if __name__ == "__main__":
    unittest.main()
