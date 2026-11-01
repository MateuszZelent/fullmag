from __future__ import annotations

from contextlib import contextmanager, redirect_stdout
import copy
from io import StringIO
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))
import docker_backend_volume_cache as backend_cache  # noqa: E402
import docker_cache_retirement as retirement  # noqa: E402
import docker_frontend_cache as frontend_cache  # noqa: E402
import docker_group_storage as group_storage  # noqa: E402
import docker_shared_build_storage as shared_storage  # noqa: E402
import bootstrap_docker_toolchain as bootstrap  # noqa: E402

RUNTIME_IMAGE = "sha256:" + "a" * 64
TOOLCHAIN_IMAGE = "sha256:" + "b" * 64
HELPER_ID = "f" * 64
PROJECT_ID = "fullmag"
WORKTREE_ID = "retire-wt"


class Completed:
    def __init__(self, code=0, stdout="", stderr=""):
        self.returncode = code
        self.stdout = stdout
        self.stderr = stderr


class FakeDocker:
    def __init__(self):
        self.volumes = {}
        self.containers = {}
        self.removed = []
        self.fail_remove = None

    def add_volume(self, name, labels):
        self.volumes[name] = {
            "Name": name, "Driver": "local", "Options": {}, "Scope": "local",
            "Mountpoint": f"/var/lib/docker/volumes/{name}/_data", "Labels": dict(labels),
        }

    def __call__(self, *args):
        if args[:3] == ("volume", "ls", "--quiet"):
            filters = []
            for index, value in enumerate(args):
                if value == "--filter":
                    filters.append(args[index + 1].removeprefix("label="))
            names = []
            for name, document in self.volumes.items():
                labels = document["Labels"]
                if all("=" in item and labels.get(item.split("=", 1)[0]) == item.split("=", 1)[1]
                       for item in filters):
                    names.append(name)
            return Completed(stdout="\n".join(sorted(names)))
        if args[:2] == ("volume", "inspect"):
            name = args[2]
            if name not in self.volumes:
                return Completed(1, stderr=f"Error: no such volume: {name}")
            return Completed(stdout=json.dumps([self.volumes[name]]))
        if args[:3] == ("ps", "--all", "--no-trunc"):
            return Completed(stdout="\n".join(sorted(self.containers)))
        if args and args[0] == "inspect":
            if any(name not in self.containers for name in args[1:]):
                return Completed(1, stderr="No such object")
            return Completed(stdout=json.dumps([self.containers[name] for name in args[1:]]))
        if args[:2] == ("volume", "rm"):
            name = args[2]
            if self.fail_remove == name:
                self.fail_remove = None
                return Completed(1, stderr="volume is in use")
            if name not in self.volumes:
                return Completed(1, stderr=f"Error: no such volume: {name}")
            if any(mount.get("Name") == name for doc in self.containers.values() for mount in doc["Mounts"]):
                return Completed(1, stderr="volume is in use")
            del self.volumes[name]
            self.removed.append(name)
            return Completed(stdout=name)
        raise AssertionError(f"Unexpected Docker call: {args!r}")


class FakeControl:
    def __init__(self, source_root):
        self.project = f"fullmag-worktree-{WORKTREE_ID}"
        self.volume = bootstrap.control_volume_name(self.project)
        self.namespace = ""
        self.identity = {
            "checkout_kind": "worktree", "worktree_id": WORKTREE_ID,
            "project_id": PROJECT_ID, "source_root": str(source_root),
            "project_name": self.project,
        }
        self.labels = {
            "org.fullmag.build-control.schema": "fullmag.build-control.v1",
            "org.fullmag.compose.project": self.project,
            "org.fullmag.source.worktree-id": WORKTREE_ID,
            "org.fullmag.build.role": "control",
        }
        self.records = {}
        self.operations = 0
        self.last_operation = None
        self.on_operation = None

    def read(self, path, *, optional=False):
        value = self.records.get(path)
        return copy.deepcopy(value)

    def write(self, path, value):
        self.records[path] = copy.deepcopy(value)

    @contextmanager
    def operation(self, phase, inputs, *, minimum_free_bytes):
        assert phase == "cache-retirement"
        assert minimum_free_bytes >= retirement.MIN_FREE_CONTROL_BYTES
        self.operations += 1
        operation = {"helper_container_id": HELPER_ID, "retirement_helper_ids": [],
                     "receipt": {"state": "starting"}, "daemon_pending": False}
        self.last_operation = operation
        if self.on_operation is not None:
            self.on_operation()
        try:
            yield operation
        except BaseException:
            operation["receipt"]["state"] = "failed-confirmed"
            raise
        else:
            operation["receipt"].setdefault("state", "succeeded")


class RetirementTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve(strict=True)
        self.source = self.root / "source"
        self.source.mkdir()
        self.source = self.source.resolve(strict=True)
        self.storage_root = self.root / "storage"
        self.storage_root.mkdir()
        self.storage_root = self.storage_root.resolve(strict=True)
        self.layout = {
            "repo_root": str(self.source), "storage_root": str(self.storage_root),
            "worktree_id": WORKTREE_ID, "project_id": PROJECT_ID,
        }
        self.control = FakeControl(self.source)
        self.docker = FakeDocker()
        self.backend_profile = self._backend_profile(WORKTREE_ID, self.source, self.project)
        for role in (backend_cache.BUILD_VOLUME_ROLE, backend_cache.PACKAGE_VOLUME_ROLE):
            name = self.backend_profile["volume_names"][role]
            self.docker.add_volume(name, backend_cache.volume_labels(self.backend_profile, role))
        self.shared_name = shared_storage.shared_volume_names(PROJECT_ID)[shared_storage.PACKAGE_ROLE]
        self.docker.add_volume(self.shared_name, shared_storage.shared_volume_labels(PROJECT_ID, shared_storage.PACKAGE_ROLE))
        self.frontend_v2_name = frontend_cache._v2_volume_name(self.project, "c" * 64)
        self.docker.add_volume(self.frontend_v2_name, {
            frontend_cache.VOLUME_SCHEMA_LABEL: frontend_cache.SCHEMA,
            frontend_cache.VOLUME_PROFILE_LABEL: frontend_cache.PROFILE,
            frontend_cache.VOLUME_PROJECT_LABEL: self.project,
            frontend_cache.VOLUME_KEY_LABEL: "c" * 64,
        })
        legacy_key = "d" * 64
        self.frontend_v1_name = f"fullmag-dev-frontend-v1-{legacy_key[:24]}"
        self.docker.add_volume(self.frontend_v1_name, {
            **{key: value for key, value in self.control.labels.items() if key.startswith("org.fullmag.")},
            "org.fullmag.build.role": "frontend", "org.fullmag.build.cache-key": legacy_key,
        })

    def tearDown(self):
        self.temporary.cleanup()

    @property
    def project(self):
        return f"fullmag-worktree-{WORKTREE_ID}"

    def _backend_profile(self, worktree_id, source_root, compose_project, *, shared_packages=False,
                         cargo_profile="backend-dev"):
        return backend_cache.prepare(
            {"storage_root": str(self.storage_root), "project_id": PROJECT_ID,
             "worktree_id": worktree_id, "compose_project": compose_project},
            source_root, RUNTIME_IMAGE, self.storage_root,
            source_root=source_root, toolchain_image=TOOLCHAIN_IMAGE,
            cargo_profile=cargo_profile,
            control_volume_name=f"fullmag-build-control-{worktree_id}",
            shared_packages=shared_packages,
        )

    def _retire(self, callback=None):
        return retirement.retire(self.control, self.layout, "task-1", "owner-1",
                                 retire_namespaces=callback, docker=self.docker)

    def _group_cache_profile(self, *, source_root=None):
        source_root = source_root or self.source
        prepared = backend_cache._plan(
            {"storage_root": str(self.storage_root), "project_id": PROJECT_ID,
             "worktree_id": WORKTREE_ID, "compose_project": self.project},
            source_root, RUNTIME_IMAGE, self.storage_root,
            source_root=source_root, toolchain_image=TOOLCHAIN_IMAGE,
            cargo_profile="backend-dev", control_volume_name=self.control.volume,
            control_namespace="", shared_packages=True, group_volume=True,
        )
        build_labels = backend_cache.volume_labels(prepared, backend_cache.BUILD_VOLUME_ROLE)
        self.docker.add_volume(self.control.volume, build_labels)
        documents = {
            backend_cache.BUILD_VOLUME_ROLE: self.docker.volumes[self.control.volume],
            backend_cache.CONTROL_VOLUME_ROLE: self.docker.volumes[self.control.volume],
            backend_cache.PACKAGE_VOLUME_ROLE: self.docker.volumes[self.shared_name],
        }
        markers = {
            backend_cache.BUILD_VOLUME_ROLE: {
                "schema": backend_cache.OWNER_SCHEMA, "state": "owned",
                "unit_key": prepared["unit_key"], "owner_id": prepared["owner_id"],
                "role": backend_cache.BUILD_VOLUME_ROLE,
                "volume_name": self.control.volume, "uid": 65532, "gid": 65532,
            },
            backend_cache.PACKAGE_VOLUME_ROLE: {
                "schema": backend_cache.OWNER_SCHEMA, "state": "owned",
                "unit_key": prepared["unit_key"], "owner_id": prepared["owner_id"],
                "role": backend_cache.PACKAGE_VOLUME_ROLE,
                "volume_name": self.shared_name, "uid": 65532, "gid": 65532,
            },
            backend_cache.CONTROL_VOLUME_ROLE: {
                "schema": "fullmag.docker-toolchain-control-owner.v1", "state": "owned",
                "role": backend_cache.CONTROL_VOLUME_ROLE,
                "volume_name": self.control.volume,
                "mount": backend_cache.CONTROL_TARGET,
                "namespace": backend_cache.CONTROL_BACKEND_TARGET,
            },
        }
        receipt = {
            "schema": backend_cache.MAINTENANCE_RECEIPT_SCHEMA,
            "profile": backend_cache.PROFILE, "state": "ready",
            "project_id": PROJECT_ID, "worktree_id": WORKTREE_ID,
            "cache_key": prepared["cache_key"], "unit_key": prepared["unit_key"],
            "owner_id": prepared["owner_id"], "cargo_profile": prepared["cargo_profile"],
            "runtime_image_id": RUNTIME_IMAGE, "toolchain_image_id": TOOLCHAIN_IMAGE,
            "volume_names": prepared["volume_names"], "markers": markers,
            "probe": {"schema": backend_cache.PROBE_SCHEMA, "state": "passed",
                      "owner_uid": 65532, "owner_gid": 65532,
                      "volumes": {role: {key: True for key in
                          ("regular_marker", "writable", "readonly_reopen", "no_reparse")}
                          for role in backend_cache.VOLUME_ROLES}},
        }
        profile = backend_cache.validate(prepared, documents, receipt)
        self.control.records[retirement.GROUP_STORAGE_REGISTRY_PATH] = {
            "schema": retirement.PRIVATE_GROUP_REGISTRY_SCHEMA,
            "state": "ready", "profile": profile,
        }
        self.control.records[retirement.GROUP_STORAGE_OWNER_PATH] = group_storage.owner_manifest(
            self.control, self.source
        )
        return profile

    def _run_private_cleanup_guest(self, owner, group, control_root, backend_root, frontend_root):
        script = retirement._private_group_cleanup_script(
            owner, group, plan_sha256="a" * 64, control_root=str(control_root),
            backend_root=str(backend_root), frontend_root=str(frontend_root),
        )
        guest = script.split("<<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]
        output = StringIO()
        with redirect_stdout(output):
            exec(compile(guest, "private-group-cache-cleanup", "exec"),
                 {"__name__": "__main__"})
        return json.loads(output.getvalue())

    def test_removes_only_exact_private_targets_and_preserves_shared_and_foreign_volumes(self):
        foreign = self._backend_profile("other-wt", self.source, "fullmag-worktree-other-wt")
        foreign_name = foreign["volume_names"][backend_cache.BUILD_VOLUME_ROLE]
        self.docker.add_volume(foreign_name, backend_cache.volume_labels(foreign, backend_cache.BUILD_VOLUME_ROLE))
        callback_calls = []

        def retire_groups(unit_keys, operation):
            callback_calls.append((unit_keys, operation))
            return {"state": "succeeded", "unit_keys": list(unit_keys), "removed": list(unit_keys)}

        result = self._retire(retire_groups)

        expected = {self.backend_profile["volume_names"][backend_cache.BUILD_VOLUME_ROLE],
                    self.backend_profile["volume_names"][backend_cache.PACKAGE_VOLUME_ROLE],
                    self.frontend_v2_name, self.frontend_v1_name}
        self.assertEqual(set(self.docker.removed), expected)
        self.assertIn(self.shared_name, self.docker.volumes)
        self.assertIn(foreign_name, self.docker.volumes)
        self.assertEqual(callback_calls[0][0], [self.backend_profile["unit_key"]])
        self.assertEqual(result["state"], "succeeded")
        self.assertEqual(self.control.records[retirement.CLOSING_PATH]["state"], "closing")
        self.assertEqual(self.control.last_operation["receipt"]["state"], "succeeded")

    def test_retained_worktree_container_blocks_before_any_plan_or_deletion(self):
        self.docker.containers["1" * 64] = {
            "Id": "1" * 64, "Config": {"Labels": {"com.docker.compose.project": self.project}},
            "Mounts": [],
        }
        with self.assertRaisesRegex(retirement.CacheRetirementError, "retained containers"):
            self._retire(lambda keys, operation: {"state": "succeeded", "unit_keys": keys})
        self.assertEqual(self.docker.removed, [])
        self.assertNotIn(retirement.CLOSING_PATH, self.control.records)

    def test_unlabelled_unrelated_container_does_not_block_retirement(self):
        self.docker.containers["3" * 64] = {
            "Id": "3" * 64, "Config": {"Labels": None}, "Mounts": [],
        }
        result = self._retire(lambda keys, operation: {"state": "succeeded", "unit_keys": keys})
        self.assertEqual(result["state"], "succeeded")

    def test_unrelated_windows_drive_binds_do_not_block_retirement(self):
        self.docker.containers["3" * 64] = {
            "Id": "3" * 64, "Config": {"Labels": None},
            "Mounts": [{"Type": "bind", "Source": source} for source in (
                r"C:\git\fullmag\worktrees\other",
                r"C:\git\fullmag\worktrees\other/apps/control-room/app",
                r"E:\git\storage\runtimes\other",
                "D:/git/other",
            )],
        }
        result = self._retire(lambda keys, operation: {"state": "succeeded", "unit_keys": keys})
        self.assertEqual(result["state"], "succeeded")
        self.assertEqual(len(self.docker.removed), 4)
        self.assertIn(self.shared_name, self.docker.volumes)

    def test_unknown_bind_path_formats_block_before_plan_or_deletion(self):
        for source in (None, "", r"relative\path", "relative/path",
                       r"\\wsl.localhost\docker-desktop\var\lib\docker\volumes",
                       "//wsl.localhost/docker-desktop/var/lib/docker/volumes"):
            with self.subTest(source=source):
                self.docker.containers["3" * 64] = {
                    "Id": "3" * 64, "Config": {"Labels": None},
                    "Mounts": [{"Type": "bind", "Source": source}],
                }
                with self.assertRaisesRegex(retirement.CacheRetirementError, "bind-source inventory is ambiguous"):
                    self._retire(lambda keys, operation: {"state": "succeeded", "unit_keys": keys})
                self.assertEqual(self.docker.removed, [])
                self.assertNotIn(retirement.PLAN_PATH, self.control.records)

    def test_posix_private_and_shared_bind_aliases_still_block(self):
        private = self.docker.volumes[self.backend_profile["volume_names"][backend_cache.BUILD_VOLUME_ROLE]]
        shared = self.docker.volumes[self.shared_name]
        for source in (private["Mountpoint"], private["Mountpoint"] + "/child",
                       "/", "/var/lib/docker/volumes", shared["Mountpoint"] + "/artifacts"):
            with self.subTest(source=source):
                self.docker.containers["3" * 64] = {
                    "Id": "3" * 64, "Config": {"Labels": None},
                    "Mounts": [{"Type": "bind", "Source": source}],
                }
                with self.assertRaisesRegex(retirement.CacheRetirementError, "bind-aliases"):
                    self._retire(lambda keys, operation: {"state": "succeeded", "unit_keys": keys})
                self.assertEqual(self.docker.removed, [])
                self.assertNotIn(retirement.PLAN_PATH, self.control.records)

    def test_unlabelled_private_volume_consumer_blocks(self):
        name = self.backend_profile["volume_names"][backend_cache.BUILD_VOLUME_ROLE]
        self.docker.containers["4" * 64] = {
            "Id": "4" * 64, "Config": {"Labels": None},
            "Mounts": [{"Type": "volume", "Name": name}],
        }
        with self.assertRaisesRegex(retirement.CacheRetirementError, "still mounts private cache volume"):
            self._retire(lambda keys, operation: {"state": "succeeded", "unit_keys": keys})
        self.assertEqual(self.docker.removed, [])

    def test_unlabelled_shared_volume_consumer_blocks(self):
        shared = self.docker.volumes[self.shared_name]
        self.docker.containers["5" * 64] = {
            "Id": "5" * 64, "Config": {"Labels": None},
            "Mounts": [{"Type": "volume", "Name": self.shared_name,
                        "Destination": backend_cache.SHARED_BACKEND_TARGET,
                        "Source": shared["Mountpoint"]}],
        }
        with self.assertRaisesRegex(retirement.CacheRetirementError, "environment is malformed"):
            self._retire(lambda keys, operation: {"state": "succeeded", "unit_keys": keys})
        self.assertEqual(self.docker.removed, [])

    def test_new_private_volume_at_lease_acquisition_blocks_before_plan_or_deletion(self):
        def create_new_cache():
            profile = self._backend_profile(WORKTREE_ID, self.source, self.project,
                                            cargo_profile="release")
            name = profile["volume_names"][backend_cache.BUILD_VOLUME_ROLE]
            self.docker.add_volume(name, backend_cache.volume_labels(profile, backend_cache.BUILD_VOLUME_ROLE))

        self.control.on_operation = create_new_cache
        with self.assertRaisesRegex(retirement.CacheRetirementError, "inventory changed"):
            self._retire(lambda keys, operation: {"state": "succeeded", "unit_keys": keys})
        self.assertEqual(self.docker.removed, [])
        self.assertNotIn(retirement.PLAN_PATH, self.control.records)
        self.assertNotIn(retirement.CLOSING_PATH, self.control.records)

    def test_renamed_volumes_with_owned_frontend_labels_block(self):
        v2_labels = {
            frontend_cache.VOLUME_SCHEMA_LABEL: frontend_cache.SCHEMA,
            frontend_cache.VOLUME_PROFILE_LABEL: frontend_cache.PROFILE,
            frontend_cache.VOLUME_PROJECT_LABEL: self.project,
            frontend_cache.VOLUME_KEY_LABEL: "e" * 64,
        }
        self.docker.add_volume("renamed-frontend-v2", v2_labels)
        with self.assertRaisesRegex(retirement.CacheRetirementError, "Frontend v2 volume identity"):
            self._retire(lambda keys, operation: {"state": "succeeded", "unit_keys": keys})
        self.assertEqual(self.docker.removed, [])

    def test_renamed_legacy_frontend_volume_with_owned_labels_blocks(self):
        labels = {**{key: value for key, value in self.control.labels.items()
                     if key.startswith("org.fullmag.")},
                  "org.fullmag.build.role": "frontend",
                  "org.fullmag.build.cache-key": "e" * 64}
        self.docker.add_volume("renamed-frontend-v1", labels)
        with self.assertRaisesRegex(retirement.CacheRetirementError, "Legacy frontend volume ownership"):
            self._retire(lambda keys, operation: {"state": "succeeded", "unit_keys": keys})
        self.assertEqual(self.docker.removed, [])

    def test_unknown_shared_root_consumer_blocks(self):
        self._add_root_consumer(other=True, malformed=True)
        with self.assertRaisesRegex(retirement.CacheRetirementError, "Unknown shared package consumer"):
            self._retire(lambda keys, operation: {"state": "succeeded", "unit_keys": keys})
        self.assertEqual(self.docker.removed, [])

    def test_registered_other_group_root_alias_with_distinct_namespace_is_allowed(self):
        self._add_root_consumer(other=True)
        result = self._retire(lambda keys, operation: {"state": "succeeded", "unit_keys": keys})
        self.assertEqual(result["state"], "succeeded")
        self.assertIn(self.shared_name, self.docker.volumes)

    def test_partial_retry_uses_durable_units_after_build_volume_is_absent(self):
        build_name = self.backend_profile["volume_names"][backend_cache.BUILD_VOLUME_ROLE]
        package_name = self.backend_profile["volume_names"][backend_cache.PACKAGE_VOLUME_ROLE]
        self.docker.fail_remove = package_name
        callback_calls = []
        callback = lambda keys, operation: (callback_calls.append(list(keys)) or
                                             {"state": "succeeded", "unit_keys": list(keys)})
        with self.assertRaisesRegex(retirement.CacheRetirementError, "Docker command failed"):
            self._retire(callback)
        self.assertNotIn(build_name, self.docker.volumes)
        self.assertIn(package_name, self.docker.volumes)

        result = self._retire(callback)
        self.assertEqual(result["state"], "succeeded")
        self.assertEqual(callback_calls, [[self.backend_profile["unit_key"]]])
        self.assertNotIn(package_name, self.docker.volumes)
        self.assertIn(self.shared_name, self.docker.volumes)

    def test_private_group_registry_admits_exact_stable_unit_without_control_volume_target(self):
        profile = self._group_cache_profile()
        group = retirement._private_group_registry(
            self.control, self.layout,
            retirement._identity(self.control, self.layout), self.docker,
        )
        self.assertEqual(group["unit_key"], profile["unit_key"])
        self.assertEqual(group["volume_name"], self.control.volume)
        self.assertEqual(group["build_subpath"], "private/backend")
        self.assertNotIn(self.control.volume, [item["name"] for item in
                                              retirement._plan(
                                                  retirement._identity(self.control, self.layout),
                                                  "task-1", "owner-1", [], [group["unit_key"]],
                                                  {"name": self.shared_name, "labels": {},
                                                   "mountpoint": self.docker.volumes[self.shared_name]["Mountpoint"]}
                                              )["volumes"]])

    def test_private_group_registry_rejects_wrong_source_or_unit(self):
        profile = self._group_cache_profile()
        bad_source = copy.deepcopy(profile)
        bad_source["identity"]["inputs"]["source_root"] = str(self.storage_root)
        self.control.records[retirement.GROUP_STORAGE_REGISTRY_PATH]["profile"] = bad_source
        with self.assertRaisesRegex(retirement.CacheRetirementError, "Private group cache"):
            retirement._private_group_registry(
                self.control, self.layout,
                retirement._identity(self.control, self.layout), self.docker,
            )

        self.control.records[retirement.GROUP_STORAGE_REGISTRY_PATH]["profile"] = profile
        bad_unit = copy.deepcopy(profile)
        bad_unit["unit_key"] = "e" * 64
        self.control.records[retirement.GROUP_STORAGE_REGISTRY_PATH]["profile"] = bad_unit
        with self.assertRaisesRegex(retirement.CacheRetirementError, "Private group cache"):
            retirement._private_group_registry(
                self.control, self.layout,
                retirement._identity(self.control, self.layout), self.docker,
            )

    def test_private_group_registry_rejects_foreign_owner_marker(self):
        self._group_cache_profile()
        self.control.records[retirement.GROUP_STORAGE_OWNER_PATH]["source_root"] = str(self.storage_root)
        with self.assertRaisesRegex(retirement.CacheRetirementError, "owner marker differs"):
            retirement._private_group_registry(
                self.control, self.layout,
                retirement._identity(self.control, self.layout), self.docker,
            )

    def test_retirement_adds_registered_group_namespace_but_never_removes_control_volume(self):
        profile = self._group_cache_profile()
        callback_calls = []
        callback = lambda keys, operation: (callback_calls.append(list(keys)) or
                                             {"state": "succeeded", "unit_keys": list(keys)})
        with mock.patch.object(retirement, "_clear_private_group_cache",
                               return_value={"state": "succeeded", "cleared": []}):
            result = self._retire(callback)
        expected_units = sorted({self.backend_profile["unit_key"], profile["unit_key"]})
        self.assertEqual(callback_calls, [expected_units])
        self.assertEqual(result["namespaces_pending"], expected_units)
        self.assertNotIn(self.control.volume, self.docker.removed)
        self.assertIn(self.control.volume, self.docker.volumes)

    def test_group_registry_supplies_namespace_without_legacy_backend_volume(self):
        profile = self._group_cache_profile()
        for role in (backend_cache.BUILD_VOLUME_ROLE, backend_cache.PACKAGE_VOLUME_ROLE):
            self.docker.volumes.pop(self.backend_profile["volume_names"][role])
        callbacks = []
        callback = lambda keys, operation: (callbacks.append(list(keys)) or
                                             {"state": "succeeded", "unit_keys": list(keys)})
        with mock.patch.object(retirement, "_clear_private_group_cache",
                               return_value={"state": "succeeded", "cleared": []}):
            self._retire(callback)
        self.assertEqual(callbacks, [[profile["unit_key"]]])

    def test_control_volume_bind_alias_blocks_group_cache_retirement(self):
        self._group_cache_profile()
        control_root = self.docker.volumes[self.control.volume]["Mountpoint"]
        self.docker.containers["7" * 64] = {
            "Id": "7" * 64, "Config": {"Labels": None},
            "Mounts": [{"Type": "bind", "Source": control_root + "/private/ledger"}],
        }
        with self.assertRaisesRegex(retirement.CacheRetirementError, "bind-aliases the protected group control"):
            self._retire(lambda keys, operation: {"state": "succeeded", "unit_keys": keys})
        self.assertEqual(self.docker.removed, [])
        self.assertNotIn(retirement.PLAN_PATH, self.control.records)

    def test_private_cleanup_guest_script_is_syntax_valid_and_role_scoped(self):
        self._group_cache_profile()
        group = retirement._private_group_registry(
            self.control, self.layout,
            retirement._identity(self.control, self.layout), self.docker,
        )
        owner = group_storage.owner_manifest(self.control, self.source)
        script = retirement._private_group_cleanup_script(owner, group, plan_sha256="a" * 64)
        guest = script.split("<<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]
        compile(guest, "private-group-cache-cleanup", "exec")
        self.assertIn("private/ledger is protected by the read-only control mount", script)
        self.assertIn("unknown frontend cache/next entries", script)
        self.assertNotIn("/private-ledger", script)

    def test_private_cleanup_helper_uses_readonly_control_and_only_backend_frontend_subpaths(self):
        self._group_cache_profile()
        identity = retirement._identity(self.control, self.layout)
        group = retirement._private_group_registry(self.control, self.layout, identity, self.docker)
        operation = {}
        base_args = ["docker", "run", "--mount",
                     "type=volume,src=" + self.control.volume + ",dst=/control,volume-nocopy",
                     "--entrypoint", "/bin/bash", "image", "-c", "script"]
        captured = {}

        def fake_capture(args, **kwargs):
            captured["args"] = list(args)
            leaves = {role + "/" + path: "absent" for role, paths in
                      retirement._PRIVATE_CACHE_LEAVES.items() for path in paths}
            report = {
                "schema": retirement.PRIVATE_GROUP_CLEANUP_SCHEMA, "state": "succeeded",
                "plan_sha256": "a" * 64,
                "unit_key": group["unit_key"], "registry_sha256": group["registry_sha256"],
                "owner_sha256": group["owner_sha256"], "leaves": leaves,
                "retained": {role: {key: [] for key in
                            ("root_entries", "workspace_entries", "control_room_entries",
                             "unknown_next_cache_entries")}
                             for role in ("backend", "frontend")},
                "preserved": [
                    "source workspaces are not mounted",
                    "control records and private/.owner.json via read-only control mount",
                    "private/ledger is protected by the read-only control mount",
                    "all non-allowlisted backend/frontend entries",
                    "unknown frontend cache/next entries",
                ],
            }
            return Completed(stdout=json.dumps(report).encode("utf-8"))

        with mock.patch.object(self.control, "helper_args", return_value=base_args, create=True):
            with mock.patch.object(self.control, "subpath", side_effect=lambda value: value, create=True):
                with mock.patch.object(retirement, "bounded_capture", side_effect=fake_capture):
                    receipt = retirement._clear_private_group_cache(
                        self.control, identity, group, operation, "a" * 64,
                    )
        mounts = [captured["args"][index + 1] for index, arg in enumerate(captured["args"][:-1])
                  if arg == "--mount"]
        self.assertTrue(any(item.startswith("type=volume,src=" + self.control.volume
                             + ",dst=/control,") and item.endswith(",readonly") for item in mounts))
        self.assertTrue(any("dst=/private-backend" in item and "volume-subpath=private/backend" in item
                            for item in mounts))
        self.assertTrue(any("dst=/private-frontend" in item and "volume-subpath=private/frontend" in item
                            for item in mounts))
        self.assertFalse(any("volume-subpath=private/ledger" in item for item in mounts))
        self.assertEqual(receipt["state"], "succeeded")

    def test_unverified_private_cleanup_receipt_blocks_retry(self):
        self._group_cache_profile()
        identity = retirement._identity(self.control, self.layout)
        group = retirement._private_group_registry(self.control, self.layout, identity, self.docker)
        self.control.records[retirement.PRIVATE_GROUP_RESULT_PATH] = {
            "schema": retirement.PRIVATE_GROUP_CLEANUP_SCHEMA, "state": "succeeded",
            "unit_key": group["unit_key"], "registry_sha256": group["registry_sha256"],
            "owner_sha256": group["owner_sha256"], "plan_sha256": "a" * 64,
        }
        with self.assertRaisesRegex(retirement.CacheRetirementError, "outcome is not proven"):
            retirement._clear_private_group_cache(self.control, identity, group, {}, "a" * 64)

    def test_private_cache_leaf_symlink_is_refused_without_touching_target(self):
        if os.name != "posix":
            self.skipTest("the guest cleanup uses POSIX dir_fd/O_NOFOLLOW semantics")
        self._group_cache_profile()
        identity = retirement._identity(self.control, self.layout)
        group = retirement._private_group_registry(self.control, self.layout, identity, self.docker)
        owner = group_storage.owner_manifest(self.control, self.source)
        control_root = self.root / "guest-control"
        backend_root = self.root / "guest-backend"
        frontend_root = self.root / "guest-frontend"
        outside = self.root / "outside"
        (control_root / "private").mkdir(parents=True)
        backend_root.mkdir()
        frontend_root.mkdir()
        (control_root / "private" / ".owner.json").write_text(
            json.dumps(owner, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
        (backend_root / "workspace").mkdir()
        outside.mkdir()
        payload = outside / "keep.txt"
        payload.write_text("preserve", encoding="utf-8")
        link = backend_root / "workspace" / ".fullmag-build"
        try:
            link.symlink_to(outside, target_is_directory=True)
        except (OSError, NotImplementedError) as error:
            self.skipTest(f"symlink creation unavailable: {error}")
        with self.assertRaisesRegex(SystemExit, "linked or not a directory"):
            self._run_private_cleanup_guest(owner, group, control_root, backend_root, frontend_root)
        self.assertEqual(payload.read_text(encoding="utf-8"), "preserve")

    def test_nested_dependency_symlink_is_unlinked_without_following_outside(self):
        if os.name != "posix":
            self.skipTest("the guest cleanup uses POSIX dir_fd/O_NOFOLLOW semantics")
        self._group_cache_profile()
        identity = retirement._identity(self.control, self.layout)
        group = retirement._private_group_registry(self.control, self.layout, identity, self.docker)
        owner = group_storage.owner_manifest(self.control, self.source)
        control_root = self.root / "guest-control"
        backend_root = self.root / "guest-backend"
        frontend_root = self.root / "guest-frontend"
        (control_root / "private").mkdir(parents=True)
        (control_root / "private" / ".owner.json").write_text(
            json.dumps(owner, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
        backend_root.mkdir()
        frontend_root.mkdir()
        outside = self.root / "outside-dependency"
        outside.mkdir()
        payload = outside / "keep.txt"
        payload.write_text("preserve", encoding="utf-8")
        node_modules = frontend_root / "workspace" / "node_modules"
        node_modules.mkdir(parents=True)
        link = node_modules / "linked-package"
        try:
            link.symlink_to(outside, target_is_directory=True)
        except (OSError, NotImplementedError) as error:
            self.skipTest(f"symlink creation unavailable: {error}")
        report = self._run_private_cleanup_guest(owner, group, control_root, backend_root, frontend_root)
        self.assertFalse(node_modules.exists())
        self.assertEqual(payload.read_text(encoding="utf-8"), "preserve")
        self.assertEqual(report["leaves"]["frontend/workspace/node_modules"], "cleared")

    def _add_root_consumer(self, *, other, malformed=False):
        worktree = "other-wt" if other else WORKTREE_ID
        source = self.root / worktree
        source.mkdir(exist_ok=True)
        compose = f"fullmag-worktree-{worktree}"
        profile = self._backend_profile(worktree, source, compose, shared_packages=True)
        unit = profile["unit_key"]
        labels = {
            **backend_cache._container_labels(profile),
            "com.docker.compose.project": compose,
            "org.fullmag.compose.project": compose,
            "org.fullmag.source.project-id": PROJECT_ID,
            "org.fullmag.source.worktree-id": worktree,
            "org.fullmag.source.checkout-kind": "worktree",
            "com.docker.compose.service": "backend",
        }
        environment = {
            **profile["environment"],
            "FULLMAG_SOURCE_ROOT": str(source),
            "FULLMAG_SOURCE_PROJECT_ID": PROJECT_ID,
            "FULLMAG_SOURCE_WORKTREE_ID": worktree,
            "FULLMAG_SOURCE_CHECKOUT_KIND": "worktree",
        }
        if malformed:
            labels[backend_cache.LABEL_CACHE_KEY] = "e" * 64
            environment["FULLMAG_BACKEND_CACHE_KEY"] = "e" * 64
        shared_mountpoint = self.docker.volumes[self.shared_name]["Mountpoint"]
        group = backend_cache.shared_group(unit)
        package = {"Type": "volume", "Name": self.shared_name,
                   "Destination": backend_cache.PACKAGE_TARGET,
                   "Source": f"{shared_mountpoint}/{group}"}
        root = {"Type": "volume", "Name": self.shared_name,
                "Destination": backend_cache.SHARED_BACKEND_TARGET,
                "Source": shared_mountpoint}
        self.docker.containers["2" * 64] = {
            "Id": "2" * 64,
            "Config": {"Labels": labels, "Env": [f"{key}={value}" for key, value in environment.items()]},
            "HostConfig": {"Mounts": [
                {"Type": "volume", "Source": self.shared_name,
                 "Target": backend_cache.PACKAGE_TARGET,
                 "VolumeOptions": {"Subpath": group}},
                {"Type": "volume", "Source": self.shared_name,
                 "Target": backend_cache.SHARED_BACKEND_TARGET},
            ]},
            "Mounts": [package, root],
        }


if __name__ == "__main__":
    unittest.main()
