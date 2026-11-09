"""Focused checks for fresh-runtime archive inode and private-ledger retention."""
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import docker_group_ledger
import docker_group_storage
import docker_volume_fresh_runtime as fresh_runtime
from bootstrap_docker_toolchain import control_volume_name
from docker_build_control import BuildControlError, canonical


TOKEN = "b" * 32
PRIOR = "c" * 32
BACKEND = "d" * 64
FRONTEND = "e" * 64
IMAGE = "sha256:" + "f" * 64
DAEMON = "a" * 64


class FakeControl:
    project = "fullmag-worktree-fixture"
    volume = control_volume_name(project)
    namespace = ""

    def __init__(self, *, namespace="", files=None):
        self.namespace = namespace
        self.files = deepcopy(files or {})
        self.identity = {
            "source_root": str(ROOT), "project_name": self.project,
            "project_id": "fixture-project", "worktree_id": "fixture-worktree",
            "checkout_kind": "worktree",
        }

    def read(self, path, *, optional=False):
        if path not in self.files:
            if optional:
                return None
            raise BuildControlError("missing fake control record: " + path)
        return deepcopy(self.files[path])

    def subpath(self, relative):
        return "/".join(part for part in (self.namespace, relative) if part)


def _private_fixture(namespace=""):
    control = FakeControl(namespace=namespace)
    subpath = docker_group_storage.role_subpath(control, "ledger")
    expected = docker_group_ledger.profile(
        DAEMON, control.project, control.volume, IMAGE, ledger_subpath=subpath,
    )
    compose = {
        "name": control.project,
        "services": {"backend": {
            "environment": expected["environment"],
            "volumes": [{
                "type": "volume", "source": docker_group_ledger.COMPOSE_VOLUME,
                "target": docker_group_ledger.MOUNT_TARGET, "read_only": False,
                "volume": {"nocopy": True, "subpath": subpath},
            }],
        }},
        "volumes": {docker_group_ledger.COMPOSE_VOLUME: {
            "name": control.volume, "external": True,
        }},
    }
    previous_root = "development/attempts/" + PRIOR
    control.files[previous_root + "/compose.json"] = compose
    control.files[previous_root + "/terminal.json"] = {
        "schema": "fullmag.docker-build-operation.v1", "phase": "development",
        "state": "succeeded", "attempt": PRIOR,
        "compose_project": control.project, "control_volume": control.volume,
        "control_namespace": namespace,
        "inputs": {
            "image_id": IMAGE, "source_root": str(ROOT),
            "source_project_id": "fixture-project", "source_worktree_id": "fixture-worktree",
            "source_checkout_kind": "worktree",
        },
    }
    control.files[previous_root + "/group-ledger.json"] = {
        "schema": "fullmag.docker-group-ledger.v1", "profile": docker_group_ledger.PROFILE,
        "daemon_id_sha256": DAEMON, "compose_project": control.project,
        "volume_name": control.volume,
        "host_id": expected["environment"][docker_group_ledger.HOST_ID_ENV],
    }
    operation = {"receipt": {"inputs": {
        "attempt": PRIOR, "config_sha256": hashlib.sha256(canonical(compose)).hexdigest(),
    }}}
    backend = {
        "Image": IMAGE,
        "Config": {"User": "65532:65532",
                   "Env": [key + "=" + value for key, value in expected["environment"].items()]},
        "Mounts": [{
            "Type": "volume", "Name": control.volume,
            "Destination": docker_group_ledger.MOUNT_TARGET, "RW": True,
            "Driver": "local", "Source": "/var/lib/docker/volumes/fixture/_data/" + subpath,
        }],
        "HostConfig": {"Privileged": False, "Mounts": [{
            "Type": "volume", "Source": control.volume,
            "Target": docker_group_ledger.MOUNT_TARGET,
            "VolumeOptions": {"Subpath": subpath},
        }]},
    }
    operation["root"] = "recreate-services/attempts/" + TOKEN
    return control, operation, {"backend": backend}, compose, expected


class ArchiveShellTests(unittest.TestCase):
    def _run_script(self, root, intent, *, verify_only=False):
        script = fresh_runtime._archive_script(TOKEN, intent, root=str(root), verify_only=verify_only)
        script = script.replace("fresh_uid=65532", "fresh_uid=" + str(os.getuid()))
        script = script.replace("fresh_gid=65532", "fresh_gid=" + str(os.getgid()))
        script = script.replace("expected_role_owner='65532:65532'",
                                "expected_role_owner='" + str(os.getuid()) + ":" + str(os.getgid()) + "'")
        result = subprocess.run(["bash", "-euo", "pipefail", "-c", script],
                                capture_output=True, text=True, check=False, timeout=15)
        return result

    def _fixture(self, root):
        root = Path(root)
        (root / "runtime-control" / "runtime-services").mkdir(parents=True)
        (root / "runtime-control" / "runtime-services" / "prior.json").write_text("old runtime", encoding="utf-8")
        role = root / "private" / "ledger"
        role.mkdir(parents=True)
        role.chmod(0o750)
        leaf = role / "ledger"
        leaf.mkdir()
        (leaf / "reservation.json").write_bytes(b"preserve ledger bytes\x00\xff")
        (root / "active").write_text(TOKEN + "\n", encoding="ascii")
        return {
            "schema": "fullmag.docker-fresh-runtime-archive-intent.v1",
            "operation_attempt": TOKEN,
            "runtime_control_device_inode": f"{os.stat(root / 'runtime-control').st_dev}:{os.stat(root / 'runtime-control').st_ino}",
            "preserved_group_ledger_subpath": "private/ledger",
            "preserved_group_ledger_device_inode": f"{os.stat(leaf).st_dev}:{os.stat(leaf).st_ino}",
            "preserved_group_ledger_owner": f"{os.stat(leaf).st_uid}:{os.stat(leaf).st_gid}",
            "preserved_group_ledger_mode": f"{os.stat(leaf).st_mode & 0o777:o}",
            "preserved_group_ledger_role_device_inode": f"{os.stat(role).st_dev}:{os.stat(role).st_ino}",
            "preserved_group_ledger_role_owner": "65532:65532",
            "preserved_group_ledger_role_mode": "750",
        }

    def test_private_archive_moves_both_roots_once_and_verify_only_is_read_only(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            intent = self._fixture(root)
            old_runtime = intent["runtime_control_device_inode"]
            old_ledger = intent["preserved_group_ledger_device_inode"]
            old_ledger_owner = intent["preserved_group_ledger_owner"]
            old_ledger_mode = intent["preserved_group_ledger_mode"]
            old_role = intent["preserved_group_ledger_role_device_inode"]
            production_script = fresh_runtime._archive_script(TOKEN, intent, root=str(root))
            self.assertIn("fresh_uid=65532", production_script)
            self.assertIn("fresh_gid=65532", production_script)
            result = self._run_script(root, intent)
            self.assertEqual(result.returncode, 0, result.stderr)

            archive = root / "runtime-archives" / TOKEN
            archived_runtime = archive / "runtime-services" / "prior.json"
            archived_ledger_root = archive / "group-ledger"
            archived_ledger = archived_ledger_root / "reservation.json"
            self.assertEqual(archived_runtime.read_text(encoding="utf-8"), "old runtime")
            self.assertEqual(archived_ledger.read_bytes(), b"preserve ledger bytes\x00\xff")
            self.assertEqual(f"{os.stat(archive).st_dev}:{os.stat(archive).st_ino}", old_runtime)
            self.assertEqual(f"{os.stat(archived_ledger_root).st_dev}:{os.stat(archived_ledger_root).st_ino}", old_ledger)
            role = root / "private" / "ledger"
            self.assertEqual(f"{os.stat(role).st_dev}:{os.stat(role).st_ino}", old_role)
            self.assertEqual(os.stat(role).st_mode & 0o777, 0o750)
            fresh_ledger = role / "ledger"
            self.assertEqual(list(fresh_ledger.iterdir()), [])
            self.assertEqual(os.stat(fresh_ledger).st_uid, os.getuid())
            self.assertEqual(os.stat(fresh_ledger).st_gid, os.getgid())
            self.assertEqual(os.stat(fresh_ledger).st_mode & 0o777, 0o750)
            fresh_ledger_inode = os.stat(fresh_ledger).st_ino
            self.assertNotEqual(f"{os.stat(fresh_ledger).st_dev}:{os.stat(fresh_ledger).st_ino}", old_ledger)
            archived_root = archive / "group-ledger"
            self.assertEqual(f"{os.stat(archived_root).st_uid}:{os.stat(archived_root).st_gid}", old_ledger_owner)
            self.assertEqual(f"{os.stat(archived_root).st_mode & 0o777:o}", old_ledger_mode)

            retry = self._run_script(root, intent)
            verify = self._run_script(root, intent, verify_only=True)
            self.assertEqual(retry.returncode, 0, retry.stderr)
            self.assertEqual(verify.returncode, 0, verify.stderr)
            self.assertEqual(os.stat(fresh_ledger).st_ino, fresh_ledger_inode)
            self.assertEqual(archived_ledger.read_bytes(), b"preserve ledger bytes\x00\xff")

    def test_resume_after_runtime_rename_finishes_ledger_without_repeating_runtime_move(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            intent = self._fixture(root)
            archive = root / "runtime-archives" / TOKEN
            archive.parent.mkdir()
            os.rename(root / "runtime-control", archive)
            result = self._run_script(root, intent)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(f"{os.stat(archive).st_dev}:{os.stat(archive).st_ino}",
                             intent["runtime_control_device_inode"])
            self.assertEqual((archive / "runtime-services" / "prior.json").read_text(encoding="utf-8"), "old runtime")
            self.assertEqual((archive / "group-ledger" / "reservation.json").read_bytes(),
                             b"preserve ledger bytes\x00\xff")

    def test_resume_after_both_renames_finishes_without_repeating_moves(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            intent = self._fixture(root)
            archive = root / "runtime-archives" / TOKEN
            archive.parent.mkdir()
            os.rename(root / "runtime-control", archive)
            os.rename(root / "private" / "ledger" / "ledger", archive / "group-ledger")
            result = self._run_script(root, intent)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((archive / "group-ledger" / "reservation.json").read_bytes(),
                             b"preserve ledger bytes\x00\xff")

    def test_resume_completes_exact_empty_root_and_refuses_mutated_fresh_root(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            intent = self._fixture(root)
            archive = root / "runtime-archives" / TOKEN
            archive.parent.mkdir()
            os.rename(root / "runtime-control", archive)
            os.rename(root / "private" / "ledger" / "ledger", archive / "group-ledger")
            fresh_control = root / "runtime-control"
            fresh_control.mkdir(mode=0o750)
            partial_inode = os.stat(fresh_control).st_ino
            original_runtime_inode = intent["runtime_control_device_inode"]
            result = self._run_script(root, intent)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(os.stat(fresh_control).st_ino, partial_inode)
            self.assertEqual(f"{os.stat(archive).st_dev}:{os.stat(archive).st_ino}", original_runtime_inode)
            self.assertEqual((archive / "runtime-services" / "prior.json").read_text(encoding="utf-8"), "old runtime")
            self.assertEqual((archive / "group-ledger" / "reservation.json").read_bytes(),
                             b"preserve ledger bytes\x00\xff")
            self.assertEqual(sorted(path.name for path in fresh_control.iterdir()), ["runtime-services"])
            self.assertEqual(list((fresh_control / "runtime-services").iterdir()), [])

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            intent = self._fixture(root)
            archive = root / "runtime-archives" / TOKEN
            archive.parent.mkdir()
            os.rename(root / "runtime-control", archive)
            os.rename(root / "private" / "ledger" / "ledger", archive / "group-ledger")
            mutated_root = root / "runtime-control"
            mutated_root.mkdir(mode=0o750)
            (mutated_root / "runtime-services").mkdir(mode=0o750)
            (root / "runtime-control" / "unexpected.txt").write_text("must not be accepted", encoding="utf-8")
            result = self._run_script(root, intent)
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue((root / "private" / "ledger").is_dir())
            self.assertEqual((archive / "group-ledger" / "reservation.json").read_bytes(),
                             b"preserve ledger bytes\x00\xff")

    def test_legacy_named_ledger_path_keeps_runtime_only_archive(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "runtime-control" / "runtime-services").mkdir(parents=True)
            (root / "runtime-control" / "runtime-services" / "prior.json").write_text("old", encoding="utf-8")
            (root / "active").write_text(TOKEN + "\n", encoding="ascii")
            intent = {
                "runtime_control_device_inode": f"{os.stat(root / 'runtime-control').st_dev}:{os.stat(root / 'runtime-control').st_ino}",
            }
            result = self._run_script(root, intent)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((root / "runtime-archives" / TOKEN / "runtime-services" / "prior.json").read_text(encoding="utf-8"), "old")
            self.assertFalse((root / "runtime-archives" / TOKEN / "group-ledger").exists())
            self.assertTrue((root / "runtime-control" / "runtime-services").is_dir())


class RetainedLedgerProofTests(unittest.TestCase):
    def test_private_compose_hostconfig_and_environment_bind_the_expected_role(self):
        control, operation, retained, _, _ = _private_fixture()
        binding = fresh_runtime._retained_group_ledger_binding(control, operation, retained)
        self.assertEqual(binding, {
            "volume_name": control.volume, "private": True,
            "subpath": "private/ledger", "control_role_path": "private/ledger",
            "control_leaf_path": "private/ledger/ledger",
        })

    def test_namespaced_private_ledger_uses_full_compose_subpath_and_local_archive_path(self):
        namespace = "namespaces/" + "1" * 32
        control, operation, retained, _, _ = _private_fixture(namespace)
        binding = fresh_runtime._retained_group_ledger_binding(control, operation, retained)
        self.assertEqual(binding["subpath"], namespace + "/private/ledger")
        self.assertEqual(binding["control_role_path"], "private/ledger")
        self.assertEqual(binding["control_leaf_path"], "private/ledger/ledger")

    def test_private_ledger_rejects_wrong_hostconfig_subpath_and_missing_private_environment(self):
        control, operation, retained, _, _ = _private_fixture()
        wrong_mount = deepcopy(retained)
        wrong_mount["backend"]["HostConfig"]["Mounts"][0]["VolumeOptions"]["Subpath"] = "private/backend"
        with self.assertRaises(BuildControlError):
            fresh_runtime._retained_group_ledger_binding(control, operation, wrong_mount)
        wrong_env = deepcopy(retained)
        wrong_env["backend"]["Config"]["Env"] = [
            item for item in wrong_env["backend"]["Config"]["Env"]
            if not item.startswith(docker_group_ledger.PRIVATE_GROUP_STORAGE_ENV + "=")
        ]
        with self.assertRaises(BuildControlError):
            fresh_runtime._retained_group_ledger_binding(control, operation, wrong_env)

    def test_exact_authenticated_helper_is_allowed_but_foreign_control_consumer_is_not(self):
        control = FakeControl()
        helper = "1" * 64
        foreign = "2" * 64
        private_binding = {"private": True, "volume_name": control.volume}
        with patch.object(fresh_runtime, "_container_ids", side_effect=[{helper}, {helper}]) as ids:
            fresh_runtime._assert_ledger_consumers(control, helper, private_binding)
            self.assertEqual(ids.call_count, 2)
        with patch.object(fresh_runtime, "_container_ids", side_effect=[{helper}, {helper, foreign}]):
            with self.assertRaises(BuildControlError):
                fresh_runtime._assert_ledger_consumers(control, helper, private_binding)

    def test_legacy_separate_ledger_still_requires_zero_consumers(self):
        control = FakeControl()
        helper = "1" * 64
        foreign = "2" * 64
        legacy = {"private": False, "volume_name": "fullmag-dev-group-ledger-v1-" + "9" * 64}
        with patch.object(fresh_runtime, "_container_ids",
                          side_effect=[set(), {helper}, {helper}]) as ids:
            fresh_runtime._assert_ledger_consumers(control, helper, legacy)
            self.assertEqual(ids.call_count, 3)
        with patch.object(fresh_runtime, "_container_ids", return_value={foreign}):
            with self.assertRaises(BuildControlError):
                fresh_runtime._assert_ledger_consumers(control, helper, legacy)

    def test_private_archive_receipt_binds_leaf_and_unchanged_role_wrapper(self):
        intent = {
            "runtime_control_device_inode": "8:10",
            "preserved_group_ledger_subpath": "namespaces/" + "1" * 32 + "/private/ledger",
            "preserved_group_ledger_device_inode": "8:20",
            "preserved_group_ledger_owner": "65532:65532",
            "preserved_group_ledger_mode": "750",
            "preserved_group_ledger_role_device_inode": "8:21",
            "preserved_group_ledger_role_owner": "65532:65532",
            "preserved_group_ledger_role_mode": "750",
        }
        output = "\t".join([
            "ARCHIVED", "8:10", "8:11", "8:12", "a" * 64, "-",
            "8:20", "65532:65532", "750", "8:22", "65532:65532",
            "8:21", "65532:65532", "750",
        ]) + "\n"
        with patch.object(fresh_runtime, "docker_capture",
                          return_value=SimpleNamespace(stdout=output.encode("ascii"))):
            evidence = fresh_runtime._archive_runtime_control("f" * 64, TOKEN, intent)
        self.assertEqual(evidence["archived_group_ledger_device_inode"], "8:20")
        self.assertEqual(evidence["fresh_group_ledger_device_inode"], "8:22")
        self.assertEqual(evidence["preserved_group_ledger_role_device_inode"], "8:21")
        self.assertEqual(evidence["fresh_group_ledger_role_device_inode"], "8:21")

    def test_archive_preflight_receipt_pins_role_and_actual_leaf_separately(self):
        output = "PREFLIGHT\t8:10\t8:20\t65532:65532\t750\t8:21\t65532:65532\t750\n"
        with patch.object(fresh_runtime, "docker_capture",
                          return_value=SimpleNamespace(stdout=output.encode("ascii"))) as capture:
            evidence = fresh_runtime._archive_preflight("f" * 64, "private/ledger")
        self.assertEqual(evidence, {
            "runtime_control_device_inode": "8:10",
            "preserved_group_ledger_role_device_inode": "8:20",
            "preserved_group_ledger_role_owner": "65532:65532",
            "preserved_group_ledger_role_mode": "750",
            "preserved_group_ledger_device_inode": "8:21",
            "preserved_group_ledger_owner": "65532:65532",
            "preserved_group_ledger_mode": "750",
        })
        command = capture.call_args.args
        self.assertIn("ledger=\"$role/ledger\"", command[-1])
        self.assertNotIn("mv", command[-1])

    def test_private_generation_pins_archive_leaf_to_its_exact_namespace(self):
        namespace = "namespaces/" + "1" * 32
        control = FakeControl(namespace=namespace)
        archive = {
            "schema": "fullmag.docker-fresh-runtime-archive-terminal.v1",
            "state": "succeeded", "operation_attempt": TOKEN,
            "compose_project": control.project,
            "preserved_group_ledger_volume": control.volume,
            "preserved_runtime_control_device_inode": "8:10",
            "archived_runtime_control_device_inode": "8:10",
            "fresh_runtime_control_device_inode": "8:11",
            "fresh_runtime_services_device_inode": "8:12",
            "preserved_group_ledger_subpath": namespace + "/private/ledger",
            "mapping": fresh_runtime._archive_mapping(TOKEN, private_ledger=True),
            "preserved_group_ledger_device_inode": "8:20",
            "archived_group_ledger_device_inode": "8:20",
            "preserved_group_ledger_owner": "65532:65532",
            "archived_group_ledger_owner": "65532:65532",
            "preserved_group_ledger_mode": "750",
            "archived_group_ledger_mode": "750",
            "preserved_group_ledger_role_device_inode": "8:21",
            "fresh_group_ledger_role_device_inode": "8:21",
            "preserved_group_ledger_role_owner": "65532:65532",
            "fresh_group_ledger_role_owner": "65532:65532",
            "preserved_group_ledger_role_mode": "750",
            "fresh_group_ledger_role_mode": "750",
            "fresh_group_ledger_device_inode": "8:22",
            "fresh_group_ledger_owner": "65532:65532",
        }
        archive_path = "recreate-services/attempts/" + TOKEN + "/runtime-control-archive-terminal.json"
        control.files[archive_path] = archive
        generation = {
            "schema": "fullmag.docker-group-ledger-generation.v1",
            "compose_project": control.project, "generation": TOKEN,
            "archive_terminal_path": archive_path,
            "archive_terminal_sha256": hashlib.sha256(canonical(archive)).hexdigest(),
            "preserved_volume": control.volume,
            "preserved_subpath": namespace + "/private/ledger",
            "archived_group_ledger_path": "runtime-archives/" + TOKEN + "/group-ledger",
        }
        self.assertEqual(fresh_runtime.pinned_group_archive(control, generation), archive)

        wrong_namespace = deepcopy(archive)
        wrong_namespace["preserved_group_ledger_subpath"] = "namespaces/" + "2" * 32 + "/private/ledger"
        control.files[archive_path] = wrong_namespace
        wrong_generation = deepcopy(generation)
        wrong_generation["archive_terminal_sha256"] = hashlib.sha256(canonical(wrong_namespace)).hexdigest()
        wrong_generation["preserved_subpath"] = wrong_namespace["preserved_group_ledger_subpath"]
        with self.assertRaises(BuildControlError):
            fresh_runtime.pinned_group_archive(control, wrong_generation)

    def test_legacy_profile_stays_separate_and_has_no_private_archive_mapping(self):
        control = FakeControl()
        old_volume = "fullmag-dev-group-ledger-v1-" + "9" * 64
        expected = docker_group_ledger.profile(DAEMON, control.project, old_volume, IMAGE)
        compose = {
            "name": control.project,
            "services": {"backend": {"environment": expected["environment"], "volumes": [{
                "type": "volume", "source": docker_group_ledger.COMPOSE_VOLUME,
                "target": docker_group_ledger.MOUNT_TARGET, "read_only": False,
                "volume": {"nocopy": True},
            }]}},
            "volumes": {docker_group_ledger.COMPOSE_VOLUME: {"name": old_volume, "external": True}},
        }
        previous_root = "development/attempts/" + PRIOR
        control.files[previous_root + "/compose.json"] = compose
        control.files[previous_root + "/terminal.json"] = {
            "schema": "fullmag.docker-build-operation.v1", "phase": "development",
            "state": "succeeded", "attempt": PRIOR, "compose_project": control.project,
            "control_volume": control.volume,
            "inputs": {
                "image_id": IMAGE, "source_root": str(ROOT),
                "source_project_id": "fixture-project", "source_worktree_id": "fixture-worktree",
                "source_checkout_kind": "worktree",
            },
        }
        control.files[previous_root + "/group-ledger.json"] = {
            "schema": "fullmag.docker-group-ledger.v1", "profile": docker_group_ledger.PROFILE,
            "daemon_id_sha256": DAEMON,
            "compose_project": control.project, "volume_name": old_volume,
            "host_id": expected["environment"][docker_group_ledger.HOST_ID_ENV],
        }
        operation = {"receipt": {"inputs": {
            "attempt": PRIOR, "config_sha256": hashlib.sha256(canonical(compose)).hexdigest(),
        }}}
        backend = {"Image": IMAGE,
                   "Config": {"User": "65532:65532",
                              "Env": [key + "=" + value for key, value in expected["environment"].items()]},
                   "HostConfig": {"Privileged": False},
                   "Mounts": [{"Type": "volume", "Name": old_volume,
                               "Destination": docker_group_ledger.MOUNT_TARGET, "RW": True}]}
        binding = fresh_runtime._retained_group_ledger_binding(control, operation, {"backend": backend})
        self.assertFalse(binding["private"])
        self.assertEqual(fresh_runtime._archive_mapping(TOKEN, private_ledger=False), {
            "previous_runtime_control": "runtime-control",
            "archived_runtime_control": "runtime-archives/" + TOKEN,
            "fresh_runtime_control": "runtime-control",
            "fresh_runtime_services": "runtime-control/runtime-services",
        })


if __name__ == "__main__":
    unittest.main()
