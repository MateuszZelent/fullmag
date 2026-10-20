"""Interpreted contract tests for the orphan namespace-grant boundary."""
from __future__ import annotations

import ast
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
import uuid
from unittest import mock


_SPEC = importlib.util.spec_from_file_location(
    "docker_orphan_namespace_grant",
    Path(__file__).with_name("docker_orphan_namespace_grant.py"),
)
assert _SPEC is not None and _SPEC.loader is not None
grant = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(grant)


REQUEST_ID = "03741782-a58a-4faa-b65d-0217b65240f3"
IMAGE_ID = "sha256:" + "b" * 64
CONTAINER_ID = "a" * 64
OWNER_TOKEN = "owner-namespace-fixture"


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":")).encode("utf-8")


def _sha(value):
    return hashlib.sha256(value).hexdigest()


def _grant(*, host_sha, root_device=1, root_inode=2, namespace_inode=3,
           owner_token=OWNER_TOKEN):
    return {
        "schema": "fullmag.windows-folder-session.v1",
        "storage_profile": "windows-folder-v1",
        "role": "session",
        "state": "operational",
        "container_root": "/state",
        "host_attestation_sha256": host_sha,
        "owner_token": owner_token,
        "root_device": root_device,
        "root_inode": root_inode,
        "mount_namespace_inode": namespace_inode,
        "power_loss": "NOT VERIFIED",
        "checks": {name: True for name in grant.CHECKS},
    }


def _owner():
    return {
        "schema_version": "runtime_service_owner.v1",
        "protocol": "stdin-v1",
        "state": "failed",
        "target_id": "docker-all",
        "owner_token": OWNER_TOKEN,
        "children": [
            {"role": "compute", "pid": 41, "status": "exited_failure"},
            {"role": "preparation", "pid": 42, "status": "exited_success"},
        ],
    }


def _request(config_sha, owner_sha, host_sha):
    return {
        "schema_version": "host_worker_orphan_teardown_request.v1",
        "request_id": REQUEST_ID,
        "config_sha256": config_sha,
        "owner_sha256": owner_sha,
        "windows_folder_host_sha256": host_sha,
        "containers": [{
            "container_id": CONTAINER_ID,
            "image_id": IMAGE_ID,
        }],
        "expected": {
            "reservation_state": "committed",
            "local_lease_state": "active",
            "started_receipt_absent": True,
            "worker_exit_receipt_absent": True,
            "task_outcome": "unknown",
            "solve_replay": False,
        },
        "worker_launch_gate": {"state": "consumed", "token": REQUEST_ID},
    }


def _fixture():
    temporary = tempfile.TemporaryDirectory()
    root = Path(temporary.name)
    state = root / "runs" / "docker-all" / "session-store"
    (state / "runtime-services").mkdir(parents=True)
    (root / "diagnostics" / "orphan" / REQUEST_ID).mkdir(parents=True)
    (root / "run" / "fullmag").mkdir(parents=True)
    config = {"schema_version": "runtime_service_config.v1",
              "store_root": "/state/runs/docker-all/session-store",
              "target_id": "docker-all"}
    config_raw = _canonical(config)
    host = {
        "schema": "fullmag.windows-folder-host.v1",
        "storage_profile": "windows-folder-v1",
        "role": "session",
        "owner_scope": "docker-desktop-linux",
        "image_id": IMAGE_ID,
        "owner_token": OWNER_TOKEN,
        "restart_verified": True,
    }
    host_raw = _canonical(host)
    owner_raw = _canonical(_owner())
    request = _request(_sha(config_raw), _sha(owner_raw), _sha(host_raw))
    request_raw = _canonical(request)
    (root / ".fullmag" / "runtime-service").mkdir(parents=True)
    (root / ".fullmag" / "runtime-service" / "docker-all.json").write_bytes(config_raw)
    (root / "run" / "fullmag" / "windows-folder-host.json").write_bytes(host_raw)
    (state / "runtime-services" / "OWNER.json").write_bytes(owner_raw)
    (root / "diagnostics" / "orphan" / REQUEST_ID / "request.json").write_bytes(request_raw)
    old = _grant(host_sha=_sha(host_raw), root_device=1, root_inode=2, namespace_inode=3)
    (root / ".fullmag-windows-folder-grant.json").write_text(
        json.dumps(old, indent=2) + "\n", encoding="utf-8")
    context = grant.build_grant_context(
        request, "prepare", image_id=IMAGE_ID, target_container_id=CONTAINER_ID)
    return temporary, root, context, host


class _Probe:
    def __init__(self, namespace, root, host, *, mutate_owner=False):
        self.namespace = namespace
        self.root = root
        self.host = host
        self.mutate_owner = mutate_owner
        self.called = []

    def run(self, *, require_restart):
        self.called.append(require_restart)
        self.assert_true = require_restart
        state = self.root
        state_stat = os.stat(state)
        namespace_inode = os.stat("/proc/self/ns/mnt").st_ino
        host_raw = (self.root / "run" / "fullmag" /
                    "windows-folder-host.json").read_bytes()
        value = _grant(host_sha=_sha(host_raw), root_device=state_stat.st_dev,
                       root_inode=state_stat.st_ino,
                       namespace_inode=namespace_inode)
        path = self.root / ".fullmag-windows-folder-grant.json"
        path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
        if self.mutate_owner:
            owner_path = (self.root / "runs" / "docker-all" /
                          "session-store" / "runtime-services" / "OWNER.json")
            owner_path.write_bytes(owner_path.read_bytes() + b" ")
        return value


class NamespaceGrantTests(unittest.TestCase):
    def test_context_is_strict_and_binds_request_image_and_paths(self):
        temporary, _root, context, _host = _fixture()
        self.addCleanup(temporary.cleanup)
        self.assertEqual(context["schema"], grant.CONTEXT_SCHEMA)
        self.assertEqual(context["config_path"], grant.CONFIG_PATH)
        self.assertEqual(context["host_certificate_path"], grant.HOST_CERTIFICATE_PATH)
        self.assertEqual(context["grant_path"], grant.GRANT_PATH)
        self.assertEqual(set(context), grant.CONTEXT_KEYS)
        self.assertEqual(context["context_sha256"], grant._context_digest(context))
        with self.assertRaises(ValueError):
            grant.build_grant_context(
                {**{"schema_version": "wrong"}}, "prepare",
                image_id=IMAGE_ID, target_container_id=CONTAINER_ID)
        bad = dict(context)
        bad["context_sha256"] = "0" * 64
        with self.assertRaises(ValueError):
            grant.validate_grant_receipt({}, bad)

    def test_guest_runs_real_probe_seam_and_returns_current_namespace_proof(self):
        temporary, root, context, host = _fixture()
        self.addCleanup(temporary.cleanup)
        namespace = {}
        exec(compile(grant.GUEST_NAMESPACE_GRANT_SCRIPT,
                     "<guest-namespace-grant>", "exec"), namespace)
        probe = _Probe(namespace, root, host)
        with mock.patch.dict(os.environ, {"FULLMAG_RUNTIME_IMAGE_ID": IMAGE_ID}, clear=False):
            proof = namespace["_issue_recovery_namespace_grant"](
                context, _fs_root=root, _probe=probe)
        self.assertEqual(probe.called, [True])
        validated = grant.validate_grant_receipt(proof, context)
        self.assertEqual(validated["status"], "ready")
        self.assertEqual(validated["new_grant"]["mount_namespace_inode"],
                         os.stat("/proc/self/ns/mnt").st_ino)

    def test_fresh_probe_is_valid_when_namespace_identity_is_reused(self):
        temporary, root, context, host = _fixture()
        self.addCleanup(temporary.cleanup)
        namespace = {}
        exec(compile(grant.GUEST_NAMESPACE_GRANT_SCRIPT,
                     "<guest-namespace-grant>", "exec"), namespace)
        probe = _Probe(namespace, root, host)
        with mock.patch.dict(os.environ, {"FULLMAG_RUNTIME_IMAGE_ID": IMAGE_ID}, clear=False):
            namespace["_issue_recovery_namespace_grant"](context, _fs_root=root, _probe=probe)
            proof = namespace["_issue_recovery_namespace_grant"](
                context, _fs_root=root, _probe=probe)
        self.assertEqual(probe.called, [True, True])
        self.assertEqual(proof["old_grant_sha256"], proof["new_grant_sha256"])
        self.assertEqual(grant.validate_grant_receipt(proof, context)["status"], "ready")

    def test_guest_rejects_owner_replacement_after_probe(self):
        temporary, root, context, host = _fixture()
        self.addCleanup(temporary.cleanup)
        namespace = {}
        exec(compile(grant.GUEST_NAMESPACE_GRANT_SCRIPT,
                     "<guest-namespace-grant>", "exec"), namespace)
        probe = _Probe(namespace, root, host, mutate_owner=True)
        with mock.patch.dict(os.environ, {"FULLMAG_RUNTIME_IMAGE_ID": IMAGE_ID}, clear=False):
            with self.assertRaisesRegex(RuntimeError, "evidence changed"):
                namespace["_issue_recovery_namespace_grant"](
                    context, _fs_root=root, _probe=probe)

    def test_guest_rejects_symlinked_authoritative_record(self):
        temporary, root, context, host = _fixture()
        self.addCleanup(temporary.cleanup)
        owner_path = (root / "runs" / "docker-all" / "session-store" /
                      "runtime-services" / "OWNER.json")
        owner_path.unlink()
        owner_path.symlink_to(root / "outside-owner.json")
        (root / "outside-owner.json").write_bytes(_canonical(_owner()))
        namespace = {}
        exec(compile(grant.GUEST_NAMESPACE_GRANT_SCRIPT,
                     "<guest-namespace-grant>", "exec"), namespace)
        with mock.patch.dict(os.environ, {"FULLMAG_RUNTIME_IMAGE_ID": IMAGE_ID}, clear=False):
            with self.assertRaises(OSError):
                namespace["_issue_recovery_namespace_grant"](
                    context, _fs_root=root, _probe=_Probe(namespace, root, host))

    def test_guest_script_calls_existing_probe_and_has_no_control_plane_imports(self):
        tree = ast.parse(grant.GUEST_NAMESPACE_GRANT_SCRIPT)
        function = next(node for node in tree.body
                        if isinstance(node, ast.FunctionDef) and
                        node.name == "_issue_recovery_namespace_grant")
        calls = [node for node in ast.walk(function) if isinstance(node, ast.Call)]
        self.assertTrue(any(
            isinstance(node.func, ast.Attribute) and node.func.attr == "run" and
            any(keyword.arg == "require_restart" and
                isinstance(keyword.value, ast.Constant) and keyword.value.value is True
                for keyword in node.keywords)
            for node in calls
        ))
        forbidden = {"socket", "ctypes", "http", "urllib", "requests"}
        imports = [node for node in ast.walk(tree)
                   if isinstance(node, (ast.Import, ast.ImportFrom))]
        imported = {alias.name.split(".")[0] for node in imports for alias in node.names}
        self.assertTrue(forbidden.isdisjoint(imported))

    def test_receipt_rejects_context_scope_or_grant_identity_changes(self):
        temporary, root, context, host = _fixture()
        self.addCleanup(temporary.cleanup)
        namespace = {}
        exec(compile(grant.GUEST_NAMESPACE_GRANT_SCRIPT,
                     "<guest-namespace-grant>", "exec"), namespace)
        with mock.patch.dict(os.environ, {"FULLMAG_RUNTIME_IMAGE_ID": IMAGE_ID}, clear=False):
            proof = namespace["_issue_recovery_namespace_grant"](
                context, _fs_root=root, _probe=_Probe(namespace, root, host))
        mutated = dict(proof)
        mutated["target_container_id"] = "c" * 64
        with self.assertRaises(ValueError):
            grant.validate_grant_receipt(mutated, context)
        mutated = dict(proof)
        mutated["new_grant"] = dict(proof["new_grant"], root_inode=999)
        with self.assertRaises(ValueError):
            grant.validate_grant_receipt(mutated, context)


if __name__ == "__main__":
    unittest.main()
