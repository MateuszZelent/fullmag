from __future__ import annotations

from contextlib import contextmanager, redirect_stdout
import copy
from io import StringIO
import json
import os
from pathlib import Path
import subprocess
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
CUDA_BASE_IMAGE = "nvidia/cuda:12.6.3-devel-ubuntu22.04@sha256:" + "c" * 64
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
        self.image = CUDA_BASE_IMAGE
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
        self.cache_project_id = PROJECT_ID
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
            {"storage_root": str(self.storage_root), "project_id": self.cache_project_id,
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

    def _interrupted_retirement(self):
        self._group_cache_profile()
        identity = retirement._identity(self.control, self.layout)
        group = retirement._private_group_registry(self.control, self.layout, identity, self.docker)
        shared = retirement._shared_package(self.control, identity, self.docker)
        plan = retirement._plan(identity, "task-1", "owner-1", [], [group["unit_key"]], shared, group)
        inputs = {**identity, "task_id": "task-1", "owner": "owner-1",
                  "plan_sha256": retirement.hashlib.sha256(retirement._canonical(plan)).hexdigest()}
        closing = {"schema": retirement.CLOSING_SCHEMA, "state": "closing", **inputs}
        attempt = "1" * 32
        self.control.records.update({
            "active": (attempt + "\n").encode(),
            retirement.PLAN_PATH: plan,
            retirement.CLOSING_PATH: closing,
            retirement.PRIVATE_GROUP_RESULT_PATH: {
                "schema": retirement.PRIVATE_GROUP_CLEANUP_SCHEMA, "state": "outcome-unknown",
                "plan_sha256": inputs["plan_sha256"],
                **{key: group[key] for key in ("unit_key", "registry_sha256", "owner_sha256")},
            },
            f"cache-retirement/attempts/{attempt}/receipt.json": {
                "schema": "fullmag.docker-build-operation.v1", "phase": "cache-retirement",
                "state": "outcome-unknown-resources-retained", "attempt": attempt,
                "compose_project": self.project, "control_volume": self.control.volume,
                "helper_container": f"fullmag-control-{attempt}", "inputs": inputs,
            },
        })

        def read_bytes(path, *, optional=False):
            value = self.control.read(path, optional=optional)
            return value if value is None or isinstance(value, bytes) else retirement._canonical(value) + b"\n"

        self.control.read_bytes = read_bytes
        self.control._inspect_operation_helper = mock.Mock(return_value=HELPER_ID)
        self.docker.containers[HELPER_ID] = {
            "Id": HELPER_ID, "Config": {"Labels": {
                "com.docker.compose.project": self.project,
                "org.fullmag.compose.project": self.project,
                "org.fullmag.source.project-id": PROJECT_ID,
                "org.fullmag.source.worktree-id": WORKTREE_ID,
                "org.fullmag.source.checkout-kind": "worktree",
            }},
            "Mounts": [{"Type": "volume", "Name": self.control.volume, "Destination": "/control"}],
        }
        receipt_sha = retirement.hashlib.sha256(read_bytes(f"cache-retirement/attempts/{attempt}/receipt.json")).hexdigest()
        return identity, plan, closing, inputs, f"{attempt}@{receipt_sha}"

    def test_interrupted_private_retirement_releases_only_bound_lease_and_can_retry_terminal(self):
        identity, plan, closing, inputs, pin = self._interrupted_retirement()

        def publish(control, helper_id, attempt, terminal_path, terminal, pins, docker):
            self.assertEqual(helper_id, HELPER_ID)
            self.assertEqual(terminal["state"], "failed-confirmed")
            self.assertEqual(terminal["private_cleanup_recovery"]["interrupted_private_receipt"],
                             control.records[retirement.PRIVATE_GROUP_RESULT_PATH])
            self.assertEqual(pins[retirement.PLAN_PATH], control.read_bytes(retirement.PLAN_PATH))
            control.write(terminal_path, terminal)
            # The original Docker helper, not the recovery client, clears the lease.
            del control.records["active"]
            del docker.containers[helper_id]

        original_run = retirement._run
        with mock.patch.object(retirement, "_run", side_effect=lambda args, docker: (
            "READY\nLOGGED\n" if args == ("logs", HELPER_ID) else original_run(args, docker)
        )):
            with mock.patch.object(retirement, "_publish_interrupted_terminal", side_effect=publish) as write:
                for _ in range(2):
                    result = retirement._reconcile_private_cleanup(
                        self.control, identity, plan, closing, inputs, pin, self.docker
                    )
                    self.assertEqual(result, self.control.read_bytes(retirement.PRIVATE_GROUP_RESULT_PATH))
                write.assert_called_once()

    def test_interrupted_private_retirement_refuses_drift_and_other_helper(self):
        identity, plan, closing, inputs, pin = self._interrupted_retirement()
        with mock.patch.object(retirement, "_publish_interrupted_terminal") as write:
            with self.assertRaisesRegex(retirement.CacheRetirementError, "operator pin"):
                retirement._reconcile_private_cleanup(
                    self.control, identity, plan, closing, inputs, pin.split("@")[0] + "@" + "0" * 64, self.docker
                )
            consumer = copy.deepcopy(self.docker.containers[HELPER_ID])
            consumer["Id"] = "d" * 64
            self.docker.containers[consumer["Id"]] = consumer
            original_run = retirement._run
            with mock.patch.object(retirement, "_run", side_effect=lambda args, docker: (
                "READY\nLOGGED\n" if args == ("logs", HELPER_ID) else original_run(args, docker)
            )):
                with self.assertRaisesRegex(retirement.CacheRetirementError, "retained containers"):
                    retirement._reconcile_private_cleanup(
                        self.control, identity, plan, closing, inputs, pin, self.docker
                    )
            write.assert_not_called()

    def test_private_cleanup_retry_rejects_different_receipt_bytes(self):
        identity, plan, _, inputs, _ = self._interrupted_retirement()
        receipt = self.control.read(retirement.PRIVATE_GROUP_RESULT_PATH)
        reformatted = json.dumps(receipt, indent=2).encode()
        self.assertEqual(json.loads(reformatted), receipt)
        with mock.patch.object(retirement, "bounded_capture") as launch:
            with self.assertRaisesRegex(retirement.CacheRetirementError, "outcome is not proven"):
                retirement._clear_private_group_cache(
                    self.control, identity, plan["private_group_cache"], {}, inputs["plan_sha256"],
                    resumed_private_raw=reformatted,
                )
        launch.assert_not_called()

    @unittest.skipUnless(os.name == "posix", "terminal CAS uses the Linux control helper shell")
    def test_terminal_publication_checks_pinned_bytes_and_held_lock(self):
        import fcntl

        self.control.path = lambda relative: str(self.root / relative)
        self.control._namespace_guard = lambda script: script
        attempt = "1" * 32
        terminal = f"cache-retirement/attempts/{attempt}/terminal.json"
        terminal_file = self.root / terminal
        terminal_file.parent.mkdir(parents=True)
        active = (attempt + "\n").encode()
        (self.root / "active").write_bytes(active)
        (self.root / retirement.PLAN_PATH).write_bytes(b"exact plan")
        pins = {"active": active, retirement.PLAN_PATH: b"exact plan"}
        proof = {"state": "failed-confirmed"}

        def docker(*args):
            self.assertEqual(args[:4], ("exec", "--user", "65532:65532", HELPER_ID))
            return subprocess.run(args[4:], capture_output=True, text=True, check=False)

        def publish():
            retirement._publish_interrupted_terminal(
                self.control, HELPER_ID, attempt, terminal, proof, pins, docker
            )

        with (self.root / "operation.lock").open("wb") as lock:
            with self.assertRaisesRegex(retirement.CacheRetirementError, r"failed \(72\)"):
                publish()
            self.assertFalse(terminal_file.exists())
            fcntl.flock(lock, fcntl.LOCK_EX)
            (self.root / retirement.PLAN_PATH).write_bytes(b"changed plan")
            with self.assertRaises(retirement.CacheRetirementError):
                publish()
            self.assertFalse(terminal_file.exists())
            (self.root / retirement.PLAN_PATH).write_bytes(pins[retirement.PLAN_PATH])
            publish()
        self.assertEqual(json.loads(terminal_file.read_bytes()), proof)
        self.assertEqual((self.root / "active").read_bytes(), active)

    def _group_cache_profile(self, *, source_root=None):
        source_root = source_root or self.source
        prepared = backend_cache._plan(
            {"storage_root": str(self.storage_root), "project_id": self.cache_project_id,
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
            "project_id": self.cache_project_id, "worktree_id": WORKTREE_ID,
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

    def _assert_missing_other_consumer_source_is_retained(self, *, group_volume):
        retiring_group = self._group_cache_profile() if group_volume else None
        self._add_root_consumer(other=True, group_volume=group_volume)
        consumer = self.docker.containers["2" * 64]
        consumer_unit = consumer["Config"]["Labels"][backend_cache.LABEL_UNIT]
        other_source = self.root / "other-wt"
        other_source.rmdir()

        callback_calls = []
        callback = lambda keys, operation: (callback_calls.append(list(keys)) or
                                             {"state": "succeeded", "unit_keys": list(keys)})
        if group_volume:
            with mock.patch.object(retirement, "_clear_private_group_cache",
                                   return_value={"state": "succeeded", "cleared": []}):
                result = self._retire(callback)
        else:
            result = self._retire(callback)

        self.assertEqual(result["state"], "succeeded")
        self.assertIn("2" * 64, self.docker.containers)
        self.assertIn(self.shared_name, self.docker.volumes)
        self.assertNotIn(consumer_unit, callback_calls[0])
        package_mount = next(
            mount for mount in consumer["HostConfig"]["Mounts"]
            if mount.get("Target") == backend_cache.PACKAGE_TARGET
        )
        self.assertEqual(package_mount["VolumeOptions"]["Subpath"], backend_cache.shared_group(consumer_unit))
        expected_retiring = {self.backend_profile["unit_key"]}
        if retiring_group is not None:
            expected_retiring.add(retiring_group["unit_key"])
        self.assertEqual(set(callback_calls[0]), expected_retiring)

    def test_retirement_preserves_legacy_other_consumer_with_missing_recorded_source(self):
        self._assert_missing_other_consumer_source_is_retained(group_volume=False)

    def test_retirement_preserves_group_volume_other_consumer_with_missing_recorded_source(self):
        self._assert_missing_other_consumer_source_is_retained(group_volume=True)

    def _set_other_consumer_recorded_source(self, consumer, source_root):
        labels = consumer["Config"]["Labels"]
        environment = dict(item.split("=", 1) for item in consumer["Config"]["Env"] if "=" in item)
        source_key = ("FULLMAG_SOURCE_HOST_ROOT" if "FULLMAG_SOURCE_HOST_ROOT" in environment
                      else "FULLMAG_SOURCE_ROOT")
        environment[source_key] = source_root
        inputs = {
            "source_root": source_root,
            "worktree_id": labels[backend_cache.LABEL_WORKTREE],
            "toolchain_image_id": labels[backend_cache.LABEL_TOOLCHAIN],
            "cargo_profile": labels[backend_cache.LABEL_CARGO_PROFILE],
        }
        cache_key = backend_cache._sha256({"schema": backend_cache.KEY_SCHEMA, **inputs})
        labels[backend_cache.LABEL_CACHE_KEY] = cache_key
        environment["FULLMAG_BACKEND_CACHE_KEY"] = cache_key

        if environment.get("FULLMAG_PRIVATE_GROUP_STORAGE") == "group-volume-v1":
            unit = backend_cache._sha256({
                "schema": retirement._PRIVATE_UNIT_SCHEMA,
                "project_id": labels[backend_cache.LABEL_PROJECT],
                "worktree_id": labels[backend_cache.LABEL_WORKTREE],
                "source_root": source_root,
            })
        else:
            unit = backend_cache._sha256({
                "schema": backend_cache.SCHEMA,
                "project_id": labels[backend_cache.LABEL_PROJECT],
                "cache_key": cache_key,
                "worktree_id": labels[backend_cache.LABEL_WORKTREE],
                "toolchain_image_id": labels[backend_cache.LABEL_TOOLCHAIN],
                "cargo_profile": labels[backend_cache.LABEL_CARGO_PROFILE],
            })
            name_id = retirement.hashlib.sha256(
                f"{labels[backend_cache.LABEL_PROJECT]}:{unit}".encode()
            ).hexdigest()[:24]
            environment["FULLMAG_BACKEND_CACHE_BUILD_VOLUME"] = f"fullmag-backend-v2-{name_id}-build"

        labels[backend_cache.LABEL_UNIT] = unit
        labels[backend_cache.LABEL_OWNER] = unit
        environment["FULLMAG_BACKEND_CACHE_UNIT_KEY"] = unit
        environment["FULLMAG_BACKEND_CACHE_OWNER_ID"] = unit
        environment["FULLMAG_SHARED_BACKEND_GROUP"] = backend_cache.shared_group(unit)
        group = backend_cache.shared_group(unit)
        mountpoint = self.docker.volumes[self.shared_name]["Mountpoint"]
        for mount in consumer["HostConfig"]["Mounts"]:
            if mount.get("Target") == backend_cache.PACKAGE_TARGET:
                mount["VolumeOptions"]["Subpath"] = group
        for mount in consumer["Mounts"]:
            if mount.get("Destination") == backend_cache.PACKAGE_TARGET:
                mount["Source"] = f"{mountpoint}/{group}"
        consumer["Config"]["Env"] = [f"{key}={value}" for key, value in environment.items()]
        return unit

    def test_retirement_accepts_canonical_windows_source_for_legacy_consumer(self):
        self._add_root_consumer(other=True)
        consumer = self.docker.containers["2" * 64]
        other_unit = self._set_other_consumer_recorded_source(consumer, r"C:\src\other-wt")
        (self.root / "other-wt").rmdir()
        result = self._retire(lambda keys, operation: {"state": "succeeded", "unit_keys": keys})
        self.assertEqual(result["state"], "succeeded")
        self.assertIn("2" * 64, self.docker.containers)
        self.assertIn(self.shared_name, self.docker.volumes)
        self.assertNotIn(other_unit, result["namespaces_pending"])

    def test_retirement_accepts_canonical_windows_source_for_group_volume_consumer(self):
        retiring_group = self._group_cache_profile()
        self._add_root_consumer(other=True, group_volume=True)
        consumer = self.docker.containers["2" * 64]
        other_unit = self._set_other_consumer_recorded_source(consumer, r"C:\src\other-wt")
        (self.root / "other-wt").rmdir()
        callback_calls = []
        callback = lambda keys, operation: (callback_calls.append(list(keys)) or
                                             {"state": "succeeded", "unit_keys": list(keys)})
        with mock.patch.object(retirement, "_clear_private_group_cache",
                               return_value={"state": "succeeded", "cleared": []}):
            result = self._retire(callback)
        self.assertEqual(result["state"], "succeeded")
        self.assertIn("2" * 64, self.docker.containers)
        self.assertIn(self.shared_name, self.docker.volumes)
        self.assertNotIn(other_unit, callback_calls[0])
        self.assertIn(retiring_group["unit_key"], callback_calls[0])

    def test_recorded_cache_identity_rejects_noncanonical_or_nonlocal_paths(self):
        invalid_paths = (
            str(self.source) + "/.",
            str(self.source) + "/../source",
            str(self.root) + "//source",
            str(self.source) + "/",
            str(self.source) + "\x00",
            str(self.source) + "\x01",
            "//server/share/source",
            r"\\server\share\source",
            r"C:relative\source",
            r"C:\source/mixed",
            r"C:\source\\nested",
            r"C:\source\..\source",
            "C:\\source\\nested\\",
        )
        for source_root in invalid_paths:
            with self.subTest(source_root=repr(source_root)):
                with self.assertRaises(retirement.CacheRetirementError):
                    retirement._recorded_cache_key(
                        backend_cache, source_root, "other-wt", TOOLCHAIN_IMAGE, "backend-dev"
                    )

    def test_other_consumer_cache_key_and_source_drift_are_rejected(self):
        self._add_root_consumer(other=True)
        consumer = self.docker.containers["2" * 64]
        identity = retirement._identity(self.control, self.layout)
        shared = retirement._shared_package(self.control, identity, self.docker)

        consumer["Config"]["Labels"][backend_cache.LABEL_CACHE_KEY] = "e" * 64
        with self.assertRaisesRegex(retirement.CacheRetirementError, "labels/environment"):
            retirement._registered_other_shared_consumer(consumer, identity, shared, set())

        self._add_root_consumer(other=True)
        consumer = self.docker.containers["2" * 64]
        environment = dict(item.split("=", 1) for item in consumer["Config"]["Env"] if "=" in item)
        environment["FULLMAG_SOURCE_WORKTREE_ID"] = "different-wt"
        consumer["Config"]["Env"] = [f"{key}={value}" for key, value in environment.items()]
        with self.assertRaisesRegex(retirement.CacheRetirementError, "labels/environment"):
            retirement._registered_other_shared_consumer(consumer, identity, shared, set())

        self._add_root_consumer(other=True)
        consumer = self.docker.containers["2" * 64]
        alternate_source = self.root / "alternate-source"
        alternate_source.mkdir()
        environment = dict(item.split("=", 1) for item in consumer["Config"]["Env"] if "=" in item)
        environment["FULLMAG_SOURCE_ROOT"] = str(alternate_source)
        consumer["Config"]["Env"] = [f"{key}={value}" for key, value in environment.items()]
        with self.assertRaisesRegex(retirement.CacheRetirementError, "not derived from its source identity"):
            retirement._registered_other_shared_consumer(consumer, identity, shared, set())

    def test_retiring_consumer_worktree_and_unit_block_before_source_validation(self):
        self._add_root_consumer(other=True)
        consumer = self.docker.containers["2" * 64]
        identity = retirement._identity(self.control, self.layout)
        shared = retirement._shared_package(self.control, identity, self.docker)
        other_source = self.root / "other-wt"
        other_source.rmdir()

        consumer["Config"]["Labels"][backend_cache.LABEL_WORKTREE] = WORKTREE_ID
        with self.assertRaisesRegex(retirement.CacheRetirementError, "retiring worktree"):
            retirement._registered_other_shared_consumer(
                consumer, identity, shared, {self.backend_profile["unit_key"]}
            )

        consumer["Config"]["Labels"][backend_cache.LABEL_WORKTREE] = "other-wt"
        consumer["Config"]["Labels"][backend_cache.LABEL_UNIT] = self.backend_profile["unit_key"]
        with self.assertRaisesRegex(retirement.CacheRetirementError, "retiring groups"):
            retirement._registered_other_shared_consumer(
                consumer, identity, shared, {self.backend_profile["unit_key"]}
            )

    def test_split_project_ids_retire_only_the_registered_private_namespace(self):
        self.layout.pop("project_id")
        self.layout.update(project_root=str(self.root), env={"FULLMAG_PROJECT_ID": PROJECT_ID})
        self.cache_project_id = backend_cache._safe_project_id(self.layout)
        self.assertNotEqual(self.cache_project_id, PROJECT_ID)
        self.shared_name = shared_storage.shared_volume_names(self.cache_project_id)[shared_storage.PACKAGE_ROLE]
        self.docker.add_volume(self.shared_name, shared_storage.shared_volume_labels(
            self.cache_project_id, shared_storage.PACKAGE_ROLE,
        ))
        profile = self._group_cache_profile()
        self._add_root_consumer(other=True, group_volume=True)
        identity = retirement._identity(self.control, self.layout)
        self.assertEqual(identity["project_id"], PROJECT_ID)
        self.assertEqual(identity["cache_project_id"], self.cache_project_id)
        shared = retirement._shared_package(self.control, identity, self.docker)
        consumer = self.docker.containers["2" * 64]
        consumer_unit = consumer["Config"]["Labels"][backend_cache.LABEL_UNIT]
        with self.assertRaisesRegex(retirement.CacheRetirementError, "still consumes a retiring"):
            retirement._registered_other_shared_consumer(consumer, identity, shared, {consumer_unit})
        callback = mock.Mock(return_value={"state": "succeeded", "unit_keys": [profile["unit_key"]]})
        with mock.patch.object(retirement, "_clear_private_group_cache", return_value={"state": "succeeded"}):
            result = self._retire(callback)
        self.assertEqual(result["state"], "succeeded")
        self.assertEqual(callback.call_args.args[0], [profile["unit_key"]])
        self.assertIn(self.shared_name, self.docker.volumes)
        self.assertIn("2" * 64, self.docker.containers)

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

    def test_next_managed_aliases_are_unlinked_and_only_their_pinned_cache_dirs_are_cleared(self):
        if os.name != "posix":
            self.skipTest("the guest cleanup uses POSIX dir_fd/O_NOFOLLOW semantics")
        self._group_cache_profile()
        group = retirement._private_group_registry(
            self.control, self.layout,
            retirement._identity(self.control, self.layout), self.docker,
        )
        owner = group_storage.owner_manifest(self.control, self.source)
        control_root = self.root / "guest-control"
        backend_root = self.root / "guest-backend"
        frontend_root = self.root / "guest-frontend"
        (control_root / "private").mkdir(parents=True)
        (control_root / "private" / ".owner.json").write_text(
            json.dumps(owner, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
        backend_root.mkdir()
        frontend_root.mkdir()

        app_root = frontend_root / "workspace" / "apps" / "control-room"
        app_root.mkdir(parents=True)
        aliases = {
            ".next": "/state/development/cache/next/default",
            ".next-control-room-8080": "/state/development/cache/next/dev-8080",
        }
        for name, target in aliases.items():
            (app_root / name).symlink_to(target, target_is_directory=True)

        pinned_default = frontend_root / "cache" / "next" / "default"
        pinned_dev = frontend_root / "cache" / "next" / "dev-8080"
        for cache in (pinned_default, pinned_dev):
            cache.mkdir(parents=True)
            (cache / "build.bin").write_bytes(b"discard")
        unknown = frontend_root / "cache" / "next" / "unrecognized-profile"
        unknown.mkdir()
        unknown_payload = unknown / "keep.txt"
        unknown_payload.write_text("preserve", encoding="utf-8")

        report = self._run_private_cleanup_guest(
            owner, group, control_root, backend_root, frontend_root,
        )

        self.assertTrue(all(not (app_root / name).is_symlink() for name in aliases))
        self.assertFalse(pinned_default.exists())
        self.assertFalse(pinned_dev.exists())
        self.assertEqual(unknown_payload.read_text(encoding="utf-8"), "preserve")
        self.assertEqual(report["retained"]["frontend"]["unknown_next_cache_entries"],
                         ["unrecognized-profile"])
        self.assertEqual(report["leaves"]["frontend/workspace/apps/control-room/.next"],
                         "unlinked")
        self.assertEqual(
            report["leaves"]["frontend/workspace/apps/control-room/.next-control-room-8080"],
            "unlinked",
        )
        self.assertEqual(report["leaves"]["frontend/cache/next/default"], "cleared")
        self.assertEqual(report["leaves"]["frontend/cache/next/dev-8080"], "cleared")

    def test_next_pinned_caches_are_cleared_when_aliases_were_removed_by_interrupted_cleanup(self):
        if os.name != "posix":
            self.skipTest("the guest cleanup uses POSIX dir_fd/O_NOFOLLOW semantics")
        self._group_cache_profile()
        group = retirement._private_group_registry(
            self.control, self.layout,
            retirement._identity(self.control, self.layout), self.docker,
        )
        owner = group_storage.owner_manifest(self.control, self.source)
        control_root = self.root / "guest-control"
        backend_root = self.root / "guest-backend"
        frontend_root = self.root / "guest-frontend"
        (control_root / "private").mkdir(parents=True)
        (control_root / "private" / ".owner.json").write_text(
            json.dumps(owner, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
        backend_root.mkdir()
        frontend_root.mkdir()
        app_root = frontend_root / "workspace" / "apps" / "control-room"
        app_root.mkdir(parents=True)
        pinned = frontend_root / "cache" / "next" / "dev-8080"
        pinned.mkdir(parents=True)
        (pinned / "build.bin").write_bytes(b"discard")

        report = self._run_private_cleanup_guest(
            owner, group, control_root, backend_root, frontend_root,
        )

        self.assertFalse(pinned.exists())
        self.assertEqual(report["leaves"]["frontend/workspace/apps/control-room/.next"],
                         "absent")
        self.assertEqual(report["leaves"]["frontend/cache/next/dev-8080"], "cleared")

    def test_legacy_real_next_directories_remain_clearable(self):
        if os.name != "posix":
            self.skipTest("the guest cleanup uses POSIX dir_fd/O_NOFOLLOW semantics")
        self._group_cache_profile()
        group = retirement._private_group_registry(
            self.control, self.layout,
            retirement._identity(self.control, self.layout), self.docker,
        )
        owner = group_storage.owner_manifest(self.control, self.source)
        control_root = self.root / "guest-control"
        backend_root = self.root / "guest-backend"
        frontend_root = self.root / "guest-frontend"
        (control_root / "private").mkdir(parents=True)
        (control_root / "private" / ".owner.json").write_text(
            json.dumps(owner, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
        backend_root.mkdir()
        frontend_root.mkdir()
        app_root = frontend_root / "workspace" / "apps" / "control-room"
        for name in (".next", ".next-control-room-8080"):
            legacy_cache = app_root / name
            legacy_cache.mkdir(parents=True)
            (legacy_cache / "build.bin").write_bytes(b"discard")

        report = self._run_private_cleanup_guest(
            owner, group, control_root, backend_root, frontend_root,
        )

        self.assertFalse((app_root / ".next").exists())
        self.assertFalse((app_root / ".next-control-room-8080").exists())
        self.assertEqual(report["leaves"]["frontend/workspace/apps/control-room/.next"],
                         "cleared")
        self.assertEqual(
            report["leaves"]["frontend/workspace/apps/control-room/.next-control-room-8080"],
            "cleared",
        )

    def test_wrong_next_alias_target_is_refused_without_following_or_clearing_cache(self):
        if os.name != "posix":
            self.skipTest("the guest cleanup uses POSIX dir_fd/O_NOFOLLOW semantics")
        self._group_cache_profile()
        group = retirement._private_group_registry(
            self.control, self.layout,
            retirement._identity(self.control, self.layout), self.docker,
        )
        owner = group_storage.owner_manifest(self.control, self.source)
        control_root = self.root / "guest-control"
        backend_root = self.root / "guest-backend"
        frontend_root = self.root / "guest-frontend"
        (control_root / "private").mkdir(parents=True)
        (control_root / "private" / ".owner.json").write_text(
            json.dumps(owner, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
        backend_root.mkdir()
        frontend_root.mkdir()
        app_root = frontend_root / "workspace" / "apps" / "control-room"
        app_root.mkdir(parents=True)
        outside = self.root / "outside-next-cache"
        outside.mkdir()
        outside_payload = outside / "keep.txt"
        outside_payload.write_text("preserve", encoding="utf-8")
        wrong_alias = app_root / ".next"
        wrong_alias.symlink_to(outside, target_is_directory=True)
        pinned = frontend_root / "cache" / "next" / "default"
        pinned.mkdir(parents=True)
        pinned_payload = pinned / "build.bin"
        pinned_payload.write_bytes(b"preserve until target validation")

        with self.assertRaisesRegex(SystemExit, "Next cache alias target"):
            self._run_private_cleanup_guest(
                owner, group, control_root, backend_root, frontend_root,
            )

        self.assertTrue(wrong_alias.is_symlink())
        self.assertEqual(outside_payload.read_text(encoding="utf-8"), "preserve")
        self.assertEqual(pinned_payload.read_bytes(), b"preserve until target validation")

    def test_private_cleanup_receipt_validator_accepts_legacy_and_next_alias_receipts(self):
        profile = self._group_cache_profile()
        group = retirement._private_group_registry(
            self.control, self.layout,
            retirement._identity(self.control, self.layout), self.docker,
        )
        retained = {
            role: {key: [] for key in (
                "root_entries", "workspace_entries", "control_room_entries",
                "unknown_next_cache_entries",
            )}
            for role in ("backend", "frontend")
        }
        common = {
            "schema": retirement.PRIVATE_GROUP_CLEANUP_SCHEMA,
            "state": "succeeded",
            "plan_sha256": "a" * 64,
            "unit_key": profile["unit_key"],
            "registry_sha256": group["registry_sha256"],
            "owner_sha256": group["owner_sha256"],
            "retained": retained,
            "preserved": list(retirement._PRIVATE_PRESERVED),
        }
        legacy_leaves = {
            "backend/workspace/.fullmag-build": "cleared",
            "frontend/workspace/node_modules": "absent",
            "frontend/workspace/apps/control-room/node_modules": "absent",
            "frontend/workspace/apps/control-room/.next-control-room-8080": "cleared",
            "frontend/workspace/apps/control-room/.next": "absent",
        }
        current_leaves = {
            **legacy_leaves,
            "frontend/workspace/apps/control-room/.next": "unlinked",
            "frontend/workspace/apps/control-room/.next-control-room-8080": "absent",
            "frontend/cache/next/default": "cleared",
            "frontend/cache/next/dev-8080": "absent",
        }
        for leaves in (legacy_leaves, current_leaves):
            with self.subTest(leaf_keys=sorted(leaves)):
                self.assertTrue(retirement._valid_private_group_cleanup_receipt(
                    {**common, "leaves": leaves}, group, "a" * 64,
                ))

    def _helper_args(self, script, *, initialize=False):
        return ["docker", "run", "--rm", "-i", "--pull", "never", "--network", "none",
                "--read-only", "--cap-drop", "ALL",
                "--mount", "type=volume,src=" + self.control.volume + ",dst=/control,volume-nocopy",
                "--user", "0:0" if initialize else "65532:65532",
                *(["--cap-add", "CHOWN", "--cap-add", "FOWNER", "--cap-add", "DAC_OVERRIDE"]
                  if initialize else []),
                "--entrypoint", "/bin/bash", self.control.image, "-euo", "pipefail", "-c", script]

    def test_private_cleanup_helper_uses_readonly_control_and_only_backend_frontend_subpaths(self):
        self._group_cache_profile()
        identity = retirement._identity(self.control, self.layout)
        group = retirement._private_group_registry(self.control, self.layout, identity, self.docker)
        operation = {}
        helper_calls = []

        def helper_args(script, *, initialize=False):
            helper_calls.append(initialize)
            return self._helper_args(script, initialize=initialize)
        captured = {}

        def fake_capture(args, **kwargs):
            captured["args"] = list(args)
            leaves = {role + "/" + path: "absent" for role, paths in
                      retirement._PRIVATE_CACHE_LEAVES.items() for path in paths}
            leaves.update({"frontend/" + path: "absent"
                           for path in retirement._PRIVATE_NEXT_CACHE_ALIASES})
            leaves.update({"frontend/" + binding["cache"]: "absent"
                           for binding in retirement._PRIVATE_NEXT_CACHE_ALIASES.values()})
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

        with mock.patch.object(self.control, "helper_args", side_effect=helper_args, create=True):
            with mock.patch.object(self.control, "subpath", side_effect=lambda value: value, create=True):
                with mock.patch.object(retirement, "bounded_capture", side_effect=fake_capture):
                    receipt = retirement._clear_private_group_cache(
                        self.control, identity, group, operation, "a" * 64,
                    )
        args = captured["args"]
        self.assertEqual(helper_calls, [True])
        operand = args.index("--entrypoint") + 2
        self.assertEqual(args[operand - 1], "/bin/bash")
        self.assertEqual(args[operand], RUNTIME_IMAGE)
        self.assertNotIn(CUDA_BASE_IMAGE, args)
        self.assertEqual(args[args.index("--user") + 1], "0:0")
        self.assertEqual(args[args.index("--network") + 1], "none")
        self.assertEqual(args[args.index("--pull") + 1], "never")
        self.assertTrue(args[-1].startswith("python3 - <<'PY'\n"))
        mounts = [args[index + 1] for index, arg in enumerate(args[:-1]) if arg == "--mount"]
        self.assertTrue(any(item.startswith("type=volume,src=" + self.control.volume
                             + ",dst=/control,") and item.endswith(",readonly") for item in mounts))
        self.assertTrue(any("dst=/private-backend" in item and "volume-subpath=private/backend" in item
                            for item in mounts))
        self.assertTrue(any("dst=/private-frontend" in item and "volume-subpath=private/frontend" in item
                            for item in mounts))
        self.assertFalse(any("volume-subpath=private/ledger" in item for item in mounts))
        self.assertEqual(receipt["state"], "succeeded")

    def _refused_private_cleanup(self, group, message):
        identity = retirement._identity(self.control, self.layout)
        with mock.patch.object(self.control, "subpath", side_effect=lambda value: value, create=True):
            with mock.patch.object(retirement, "bounded_capture") as capture:
                with self.assertRaisesRegex(retirement.CacheRetirementError, message):
                    retirement._clear_private_group_cache(self.control, identity, group, {}, "a" * 64)
        capture.assert_not_called()
        self.assertNotIn(retirement.PRIVATE_GROUP_RESULT_PATH, self.control.records)

    def test_private_cleanup_helper_with_foreign_image_operand_refuses_before_daemon(self):
        self._group_cache_profile()
        identity = retirement._identity(self.control, self.layout)
        group = retirement._private_group_registry(self.control, self.layout, identity, self.docker)

        def foreign_image(script, *, initialize=False):
            args = self._helper_args(script, initialize=initialize)
            args[args.index(CUDA_BASE_IMAGE)] = "other@sha256:" + "d" * 64
            return args
        with mock.patch.object(self.control, "helper_args", side_effect=foreign_image, create=True):
            self._refused_private_cleanup(group, "image operand differs")

    def test_private_cleanup_refuses_registry_changed_after_plan(self):
        self._group_cache_profile()
        identity = retirement._identity(self.control, self.layout)
        group = retirement._private_group_registry(self.control, self.layout, identity, self.docker)
        registry = self.control.records[retirement.GROUP_STORAGE_REGISTRY_PATH]
        registry["profile"]["runtime_image_id"] = "sha256:" + "e" * 64
        with mock.patch.object(self.control, "helper_args", side_effect=self._helper_args, create=True):
            self._refused_private_cleanup(group, "registry changed before cache cleanup")

    def test_private_cleanup_refuses_unpinned_backend_image(self):
        self._group_cache_profile()
        identity = retirement._identity(self.control, self.layout)
        group = dict(retirement._private_group_registry(self.control, self.layout, identity, self.docker))
        registry = self.control.records[retirement.GROUP_STORAGE_REGISTRY_PATH]
        for image in ("fullmag-backend:latest", "sha256:" + "a" * 63, CUDA_BASE_IMAGE, None):
            with self.subTest(image=image):
                registry["profile"]["runtime_image_id"] = image
                group["registry_sha256"] = retirement.hashlib.sha256(
                    retirement._canonical(registry)).hexdigest()
                group["profile_sha256"] = retirement.hashlib.sha256(
                    retirement._canonical(registry["profile"])).hexdigest()
                with mock.patch.object(self.control, "helper_args", side_effect=self._helper_args,
                                       create=True):
                    self._refused_private_cleanup(group, "no immutable backend image")

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

    def _add_root_consumer(self, *, other, malformed=False, group_volume=False):
        worktree = "other-wt" if other else WORKTREE_ID
        source = self.root / worktree
        source.mkdir(exist_ok=True)
        compose = f"fullmag-worktree-{worktree}"
        profile = backend_cache._plan(
            {**self.layout, "project_id": self.cache_project_id,
             "worktree_id": worktree, "compose_project": compose},
            source, RUNTIME_IMAGE, self.storage_root, source_root=source,
            toolchain_image=TOOLCHAIN_IMAGE, cargo_profile="backend-dev",
            control_volume_name=bootstrap.control_volume_name(compose),
            control_namespace="", shared_packages=True, group_volume=group_volume,
        )
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
        if group_volume:
            environment = {
                **profile["environment"],
                "FULLMAG_SOURCE_HOST_ROOT": str(source),
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
