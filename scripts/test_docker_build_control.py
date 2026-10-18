from __future__ import annotations

import base64
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

CONTROL_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(CONTROL_ROOT / "scripts"))
sys.path.insert(0, str(CONTROL_ROOT / "docker" / "all-in-one"))

import docker_build_control as host  # noqa: E402
import build_control as guest  # noqa: E402


IMAGE_ID = "sha256:" + "9" * 64


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


class FakeDocker:
    def __init__(self, *, existing=False, marker=True, race_creation=False, timeout=False,
                 capacity=(8_000_000_000, 6_000_000_000)):
        self.volume = None
        self.existing = existing
        self.marker = marker
        self.calls = []
        self.files = {}
        self.created = False
        self.race_creation = race_creation
        self.timeout = timeout
        self.capacity = capacity
        self.marker_creation_id = None

    def __call__(self, argv, **kwargs):
        raw_argv = list(argv)
        self.calls.append((raw_argv, kwargs))
        if raw_argv[:3] != ["docker", "--context", "desktop-linux"]:
            raise AssertionError("Docker command must pin the Linux Desktop context")
        argv = [raw_argv[0], *raw_argv[3:]]
        if self.timeout:
            raise subprocess.TimeoutExpired(argv, kwargs.get("timeout"))
        if argv[:3] == ["docker", "volume", "inspect"]:
            if self.volume is None:
                return subprocess.CompletedProcess(
                    argv, 1, b"", b"Error response from daemon: no such volume"
                )
            return subprocess.CompletedProcess(argv, 0, _canonical(self.volume), b"")
        if argv[:3] == ["docker", "volume", "create"]:
            environment = kwargs["env"]
            labels = {}
            index = 3
            while index < len(argv) - 1:
                if argv[index] == "--driver":
                    if argv[index + 1] != "local":
                        raise AssertionError("control volume must use the local driver")
                    index += 2
                    continue
                if argv[index] != "--label":
                    raise AssertionError(f"unexpected volume-create argument: {argv[index]}")
                key, value = argv[index + 1].split("=", 1)
                labels[key] = value
                index += 2
            if self.race_creation:
                labels[host.LABEL_CREATION] = "f" * 64
            name = argv[-1]
            self.volume = {
                "Name": name,
                "Driver": "local",
                "Options": {},
                "Scope": "local",
                "Mountpoint": f"/var/lib/docker/volumes/{name}/_data",
                "Labels": labels,
            }
            self.created = True
            return subprocess.CompletedProcess(argv, 0, (name + "\n").encode(), b"")
        if argv[:2] == ["docker", "compose"]:
            request = json.loads(kwargs["input"])
            operation = request["operation"]
            root_init = "0:0" in argv
            if operation == "initialize":
                if not root_init or not self.created:
                    return subprocess.CompletedProcess(argv, 2, b"", b"invalid init")
                self.marker = True
                self.marker_creation_id = request["identity"]["creation_id"]
                result = {
                    "owner_id": request["identity"]["owner_id"],
                    "creation_id": request["identity"]["creation_id"],
                    "uid": 65532,
                    "gid": 65532,
                }
            elif not self.marker:
                return subprocess.CompletedProcess(argv, 2, b"", b"owner marker missing")
            elif (self.marker_creation_id is not None
                    and self.marker_creation_id != request["identity"]["creation_id"]):
                return subprocess.CompletedProcess(argv, 2, b"", b"owner marker creation identity mismatch")
            elif operation == "verify":
                result = {
                    "owner_id": request["identity"]["owner_id"],
                    "creation_id": request["identity"]["creation_id"],
                    "uid": 65532,
                    "gid": 65532,
                }
            elif operation == "capacity":
                if set(request) != {"schema", "operation", "identity"}:
                    raise AssertionError("capacity RPC must be pathless")
                result = {"total_bytes": self.capacity[0], "available_bytes": self.capacity[1]}
            elif operation == "write_json":
                content = _canonical(request["document"])
                self.files[request["relative_path"]] = content
                result = {"size_bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}
            elif operation == "read_json":
                content = self.files[request["relative_path"]]
                document = json.loads(content)
                result = {"document": document, "size_bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}
            elif operation == "write_bytes":
                content = base64.b64decode(request["data_base64"], validate=True)
                self.files[request["relative_path"]] = content
                result = {"size_bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}
            elif operation == "read_bytes":
                content = self.files[request["relative_path"]]
                result = {
                    "data_base64": base64.b64encode(content).decode("ascii"),
                    "size_bytes": len(content),
                    "sha256": hashlib.sha256(content).hexdigest(),
                }
            elif operation == "stat":
                content = self.files.get(request["relative_path"])
                if content is None:
                    result = {"exists": False}
                else:
                    result = {
                        "exists": True,
                        "size_bytes": len(content),
                        "sha256": hashlib.sha256(content).hexdigest(),
                    }
            else:
                raise AssertionError(operation)
            response = {
                "schema": host.RESPONSE_SCHEMA,
                "ok": True,
                "operation": operation,
                "result": result,
            }
            return subprocess.CompletedProcess(argv, 0, _canonical(response), b"")
        raise AssertionError(f"unexpected Docker command: {argv!r}")


class DockerBuildControlHostTests(unittest.TestCase):
    def _store(self, root, docker, *, project="fullmag-test", worktree="wt-1", image=IMAGE_ID):
        return host.BuildControlStore(
            project,
            worktree,
            root,
            image,
            _docker_runner=docker,
        )

    def _source(self, root):
        (root / "docker" / "all-in-one").mkdir(parents=True)
        (root / "compose.build-control.yaml").write_text("services: {}\n", encoding="utf-8")
        (root / "docker" / "all-in-one" / "build_control.py").write_text("# fixture\n", encoding="utf-8")

    def test_volume_identity_is_deterministic_and_scoped_to_project_and_worktree(self):
        first = host.volume_identity("fullmag-test", "wt-1")
        self.assertEqual(first, host.volume_identity("fullmag-test", "wt-1"))
        self.assertNotEqual(first["volume_name"], host.volume_identity("fullmag-test", "wt-2")["volume_name"])
        self.assertNotEqual(first["volume_name"], host.volume_identity("fullmag-other", "wt-1")["volume_name"])
        self.assertEqual(first["labels"][host.LABEL_PROJECT], "fullmag-test")
        self.assertEqual(first["labels"][host.LABEL_WORKTREE], "wt-1")
        self.assertEqual(first["labels"][host.LABEL_ROLE], "control")
        self.assertEqual(first["labels"][host.LABEL_SCHEMA], host.SCHEMA)

    def test_canonical_long_compose_project_name_is_accepted_without_truncation(self):
        project = "fullmag-worktree-eigensolve-dispersion-plan-20260-c5dfad6d7f548079"
        self.assertGreater(len(project), 63)
        identity = host.volume_identity(project, "wt-1")
        self.assertEqual(identity["project"], project)
        self.assertEqual(identity["labels"][host.LABEL_PROJECT], project)

    def test_creation_nonce_rejects_a_concurrent_volume_creator_before_root_init(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._source(root)
            docker = FakeDocker(race_creation=True)
            store = self._store(root, docker)
            with self.assertRaises(host.DockerBuildControlError):
                store.ensure()
            self.assertTrue(docker.created)
            self.assertFalse(any(call[0][3:4] == ["compose"] for call in docker.calls))

    def test_docker_timeout_is_reported_as_unknown_and_is_not_retried(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._source(root)
            docker = FakeDocker(timeout=True)
            store = self._store(root, docker)
            with self.assertRaisesRegex(
                    host.DockerBuildControlError,
                    "outcome is unknown and named-volume resources were retained"):
                store.ensure()
            self.assertEqual(len(docker.calls), 1)

    def test_existing_volume_adopts_its_marker_nonce_without_reinitialization(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._source(root)
            docker = FakeDocker()
            first = self._store(root, docker)
            created = first.ensure()
            calls_before_reopen = len(docker.calls)
            second = self._store(root, docker)
            reopened = second.ensure()
            self.assertEqual(reopened["creation_id"], created["creation_id"])
            added_compose_calls = [
                argv for argv, _kwargs in docker.calls[calls_before_reopen:]
                if argv[3:4] == ["compose"]
            ]
            self.assertEqual(len(added_compose_calls), 1)
            self.assertNotIn("0:0", added_compose_calls[0])

    def test_uri_is_pure_and_missing_stat_is_only_reported_as_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._source(root)
            docker = FakeDocker()
            store = self._store(root, docker)
            self.assertEqual(
                store.uri("runs/run-1/input.json"),
                f"docker-volume://{store.volume_name}/runs/run-1/input.json",
            )
            self.assertEqual(docker.calls, [])
            store.ensure()
            self.assertIsNone(store.stat("runs/missing/input.json"))

    def test_capacity_reads_bounded_docker_volume_space_without_a_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._source(root)
            docker = FakeDocker(capacity=(8_000_000_000, 6_000_000_000))
            store = self._store(root, docker)
            self.assertEqual(
                store.capacity(),
                host.VolumeCapacity(total_bytes=8_000_000_000, available_bytes=6_000_000_000),
            )
            capacity_requests = [
                json.loads(kwargs["input"])
                for argv, kwargs in docker.calls
                if argv[3:4] == ["compose"] and kwargs.get("input")
                and json.loads(kwargs["input"]).get("operation") == "capacity"
            ]
            self.assertEqual(len(capacity_requests), 1)
            self.assertEqual(set(capacity_requests[0]), {"schema", "operation", "identity"})

    def test_capacity_rejects_non_integer_or_inconsistent_bounds(self):
        for capacity in ((100, 101), (True, 1), (100, False), (0, 0), (-1, 0), (100, -1)):
            with self.subTest(capacity=capacity), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                self._source(root)
                docker = FakeDocker(capacity=capacity)
                store = self._store(root, docker)
                with self.assertRaises(host.DockerBuildControlError):
                    store.capacity()

    def test_control_rpc_is_compose_run_and_keeps_process_environment_local(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._source(root)
            docker = FakeDocker()
            store = self._store(root, docker)
            prior = os.environ.get("FULLMAG_BUILD_CONTROL_VOLUME")
            ensured = store.ensure()
            self.assertRegex(ensured["creation_id"], r"^[0-9a-f]{64}$")
            self.assertEqual(ensured["creation_id"], store.labels[host.LABEL_CREATION])
            payload = {"run_id": "run-1", "inputs": ["mesh.json", "parameters.json"]}
            observation = store.write_json("runs/run-1/development-inputs.json", payload)
            self.assertEqual(store.read_json("runs/run-1/development-inputs.json"), payload)
            self.assertEqual(observation.sha256, hashlib.sha256(_canonical(payload)).hexdigest())
            self.assertEqual(store.stat("runs/run-1/development-inputs.json"), observation)
            self.assertEqual(store.uri("runs/run-1/development-inputs.json"), observation.uri)
            binary = b"receipt\x00bytes"
            binary_observation = store.write_bytes("runs/run-1/receipt.bin", binary)
            self.assertEqual(store.read_bytes("runs/run-1/receipt.bin"), binary)
            self.assertEqual(binary_observation.sha256, hashlib.sha256(binary).hexdigest())
            self.assertEqual(os.environ.get("FULLMAG_BUILD_CONTROL_VOLUME"), prior)

            helper_calls = [call for call in docker.calls if call[0][3:4] == ["compose"]]
            self.assertGreaterEqual(len(helper_calls), 5)
            for argv, kwargs in helper_calls:
                self.assertEqual(argv[0:4], ["docker", "--context", "desktop-linux", "compose"])
                self.assertEqual(argv[4:6], ["--project-name", "fullmag-test"])
                self.assertIn("-f", argv)
                self.assertEqual(argv[-1], "build-control")
                self.assertIn("--rm", argv)
                self.assertIn("--no-deps", argv)
                self.assertIn("-T", argv)
                self.assertEqual(kwargs["env"]["FULLMAG_BUILD_CONTROL_IMAGE_ID"], IMAGE_ID)
                self.assertEqual(kwargs["env"]["FULLMAG_BUILD_CONTROL_VOLUME"], store.volume_name)
                self.assertRegex(kwargs["env"]["FULLMAG_BUILD_CONTROL_CREATION_ID"], r"^[0-9a-f]{64}$")
                self.assertNotIn("DOCKER_CONTEXT", kwargs["env"])
                self.assertNotIn("DOCKER_HOST", kwargs["env"])
            init_calls = [argv for argv, _kwargs in helper_calls if "0:0" in argv]
            self.assertEqual(len(init_calls), 1)
            self.assertIn("--cap-add", init_calls[0])
            self.assertIn("CHOWN", init_calls[0])

    def test_compose_definition_is_one_ephemeral_offline_readonly_helper(self):
        compose = (CONTROL_ROOT / "compose.build-control.yaml").read_text(encoding="utf-8")
        self.assertIn('image: "${FULLMAG_BUILD_CONTROL_IMAGE_ID:', compose)
        self.assertIn("pull_policy: never", compose)
        self.assertIn("read_only: true", compose)
        self.assertIn("cap_drop: [ALL]", compose)
        self.assertIn("network_mode: none", compose)
        self.assertIn("mem_limit: 256m", compose)
        self.assertIn("external: true", compose)
        self.assertIn("nocopy: true", compose)
        self.assertIn("FULLMAG_BUILD_CONTROL_CREATION_ID", compose)
        self.assertIn("com.fullmag.build-control.creation-id", compose)
        self.assertIn("create_host_path: false", compose)
        self.assertNotIn("/var/run/docker.sock", compose)
        self.assertNotRegex(compose, r"(?m)^\s+build\s*:")

    def test_existing_foreign_volume_is_rejected_without_helper_or_recreation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._source(root)
            docker = FakeDocker()
            store = self._store(root, docker)
            docker.volume = {
                "Name": store.volume_name,
                "Driver": "local",
                "Options": {},
                "Scope": "local",
                "Mountpoint": "/var/lib/docker/volumes/foreign/_data",
                "Labels": {**store.labels, host.LABEL_WORKTREE: "other-worktree"},
            }
            with self.assertRaises(host.DockerBuildControlError):
                store.ensure()
            self.assertFalse(any(call[0][3:4] == ["compose"] for call in docker.calls))
            self.assertFalse(any(call[0][3:5] == ["volume", "create"] for call in docker.calls))

    def test_existing_markerless_volume_never_gets_root_initialization(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._source(root)
            docker = FakeDocker(marker=False)
            store = self._store(root, docker)
            docker.volume = {
                "Name": store.volume_name,
                "Driver": "local",
                "Options": {},
                "Scope": "local",
                "Mountpoint": f"/var/lib/docker/volumes/{store.volume_name}/_data",
                "Labels": {**store.labels, host.LABEL_CREATION: "e" * 64},
            }
            with self.assertRaises(host.DockerBuildControlError):
                store.ensure()
            helper_calls = [argv for argv, _kwargs in docker.calls if argv[3:4] == ["compose"]]
            self.assertEqual(len(helper_calls), 1)
            self.assertNotIn("0:0", helper_calls[0])

    def test_invalid_image_and_traversal_fail_before_docker_side_effects(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._source(root)
            docker = FakeDocker()
            with self.assertRaises(host.DockerBuildControlError):
                self._store(root, docker, image="latest")
            store = self._store(root, docker)
            with self.assertRaises(host.DockerBuildControlError):
                store.write_bytes("../outside", b"secret")
            self.assertEqual(docker.calls, [])


class DockerBuildControlGuestTests(unittest.TestCase):
    def _identity(self, root):
        project = "fullmag-test"
        worktree = "wt-1"
        seed = {
            "schema": guest.OWNER_SCHEMA,
            "project": project,
            "worktree_id": worktree,
            "role": guest.ROLE,
        }
        canonical = guest._canonical(seed, limit=4096, label="test")
        return {
            "schema": guest.OWNER_SCHEMA,
            "project": project,
            "worktree_id": worktree,
            "role": guest.ROLE,
            "owner_id": hashlib.sha256(canonical).hexdigest(),
            "creation_id": "a" * 64,
            "volume_name": guest.VOLUME_PREFIX + hashlib.sha256(
                b"fullmag.build-control.volume.v1\0" + canonical
            ).hexdigest()[:32],
        }

    def _request(self, identity, operation, **fields):
        return {
            "schema": guest.REQUEST_SCHEMA,
            "operation": operation,
            "identity": {
                key: identity[key]
                for key in ("project", "worktree_id", "role", "owner_id", "creation_id", "volume_name")
            },
            **fields,
        }

    def _ready_volume(self, root, identity):
        root.mkdir()
        root.chmod(0o750)
        marker = root / guest.OWNER_FILE
        marker.write_bytes(guest._canonical(identity, limit=64 * 1024, label="marker"))
        marker.chmod(0o444)
        return guest.ControlVolume(
            identity,
            root=str(root),
            uid=os.geteuid(),
            gid=os.getegid(),
        )

    def test_guest_rejects_duplicate_json_and_unsafe_relative_paths(self):
        with self.assertRaises(guest.BuildControlError):
            guest._loads(b'{"operation":"read","operation":"write"}', label="request", limit=100)
        for path in ("../escape", "/absolute", "a//b", "a\\b", ".fullmag-build-control-owner.json"):
            with self.assertRaises(guest.BuildControlError):
                guest._safe_parts(path)

    def test_guest_roundtrips_canonical_json_and_bounded_bytes_with_hashes(self):
        with tempfile.TemporaryDirectory() as tmp:
            identity = self._identity(Path(tmp))
            store = self._ready_volume(Path(tmp) / "volume", identity)
            document = {"source": "input", "revision": 7}
            write_json = store.dispatch(
                "write_json",
                self._request(identity, "write_json", relative_path="runs/r1/inputs.json", document=document),
            )
            expected_json = _canonical(document)
            self.assertEqual(write_json, {"size_bytes": len(expected_json), "sha256": hashlib.sha256(expected_json).hexdigest()})
            self.assertEqual(
                store.dispatch("read_json", self._request(identity, "read_json", relative_path="runs/r1/inputs.json")),
                {"document": document, "size_bytes": len(expected_json), "sha256": hashlib.sha256(expected_json).hexdigest()},
            )
            content = b"binary-receipt\x00payload"
            written = store.dispatch(
                "write_bytes",
                self._request(identity, "write_bytes", relative_path="runs/r1/receipt.bin", data_base64=base64.b64encode(content).decode("ascii")),
            )
            self.assertEqual(written["sha256"], hashlib.sha256(content).hexdigest())
            self.assertEqual(
                store.dispatch("read_bytes", self._request(identity, "read_bytes", relative_path="runs/r1/receipt.bin"))["data_base64"],
                base64.b64encode(content).decode("ascii"),
            )
            self.assertEqual(
                store.dispatch("stat", self._request(identity, "stat", relative_path="runs/r1/receipt.bin")),
                {"exists": True, **written},
            )
            self.assertEqual(
                store.dispatch("stat", self._request(identity, "stat", relative_path="runs/missing/receipt.bin")),
                {"exists": False},
            )

    def test_guest_capacity_is_pathless_and_uses_fstatvfs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "volume"
            identity = self._identity(root)
            store = self._ready_volume(root, identity)
            verified = store.dispatch("verify", self._request(identity, "verify"))
            self.assertEqual(verified, {
                "owner_id": identity["owner_id"],
                "creation_id": identity["creation_id"],
                "uid": os.geteuid(),
                "gid": os.getegid(),
            })
            fake_stat = SimpleNamespace(f_blocks=8_000_000, f_frsize=4096, f_bavail=6_000_000)
            with patch.object(guest.os, "fstatvfs", return_value=fake_stat) as fstatvfs:
                result = store.dispatch("capacity", self._request(identity, "capacity"))
            fstatvfs.assert_called_once()
            self.assertEqual(len(fstatvfs.call_args.args), 1)
            self.assertEqual(result, {
                "total_bytes": 8_000_000 * 4096,
                "available_bytes": 6_000_000 * 4096,
            })
            with self.assertRaises(guest.BuildControlError):
                store.dispatch(
                    "capacity",
                    self._request(identity, "capacity", relative_path="forbidden"),
                )
            with patch.object(
                    guest.os, "fstatvfs",
                    return_value=SimpleNamespace(f_blocks=1, f_frsize=1, f_bavail=2)):
                with self.assertRaises(guest.BuildControlError):
                    store.dispatch("capacity", self._request(identity, "capacity"))

    def test_root_initialization_sets_modes_before_chowning_filesystem_entries(self):
        with tempfile.TemporaryDirectory() as tmp:
            identity = self._identity(Path(tmp))
            root = Path(tmp) / "new-volume"
            root.mkdir()
            volume = guest.ControlVolume(identity, root=str(root), uid=65532, gid=65532)
            events = []
            original_fchmod = os.fchmod

            def record_fchmod(fd, mode):
                events.append(("chmod", mode))
                return original_fchmod(fd, mode)

            def record_fchown(fd, uid, gid):
                events.append(("chown", uid, gid))

            with patch.object(guest.os, "geteuid", return_value=0), \
                    patch.object(guest.os, "fchmod", side_effect=record_fchmod), \
                    patch.object(guest.os, "fchown", side_effect=record_fchown):
                volume.initialize()

            self.assertEqual([event[0] for event in events], ["chmod", "chown", "chmod", "chown"])
            self.assertEqual(events[0], ("chmod", 0o444))
            self.assertEqual(events[2], ("chmod", 0o750))

    def test_guest_rejects_symlink_parent_and_duplicate_stored_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "volume"
            identity = self._identity(root)
            store = self._ready_volume(root, identity)
            outside = Path(tmp) / "outside"
            outside.mkdir()
            try:
                (root / "linked").symlink_to(outside, target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest("symlink creation is unavailable on this test host")
            with self.assertRaises((OSError, guest.BuildControlError)):
                store.dispatch(
                    "write_bytes",
                    self._request(identity, "write_bytes", relative_path="linked/escape", data_base64="eA=="),
                )
            duplicate = root / "duplicate.json"
            duplicate.write_text('{"a":1,"a":2}', encoding="utf-8")
            duplicate.chmod(0o640)
            with self.assertRaises(guest.BuildControlError):
                store.dispatch("read_json", self._request(identity, "read_json", relative_path="duplicate.json"))


if __name__ == "__main__":
    unittest.main()
