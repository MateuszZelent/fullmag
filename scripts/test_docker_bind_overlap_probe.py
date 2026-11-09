"""Interpretive checks for read-only bind overlap proofs."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import stat
from types import SimpleNamespace
import tempfile
import unittest
from contextlib import ExitStack
from unittest.mock import patch

import docker_bind_overlap_probe as overlap
from docker_build_control import BuildControlError
from docker_foreign_bind_identity import WSL_ALIAS


def _line(mount_id, parent_id, device, root, mountpoint):
    def escaped(value):
        return value.replace("\\", "\\134").replace(" ", "\\040")

    return (f"{mount_id} {parent_id} {device} {escaped(root)} {escaped(mountpoint)} "
            "rw,relatime shared:1 - ext4 /dev/test rw")


def _mountinfo(*rows):
    return ("\n".join(rows) + "\n").encode("ascii")


def _proof_document(*, root_device, reference_root="/srv/fullmag/state",
                    candidate_roots=("/srv/other/state",), candidate_devices=None,
                    candidate_mountpoints=None, marker_sha=None, marker_size=23,
                    candidate_stat_before=None, candidate_stat_after=None):
    marker_sha = marker_sha or "a" * 64
    device = f"{os.major(root_device)}:{os.minor(root_device)}"
    candidate_devices = candidate_devices or [device] * len(candidate_roots)
    candidate_mountpoints = candidate_mountpoints or ["/candidate"] + [
        f"/candidate/mount{index}" for index in range(1, len(candidate_roots))
    ]
    candidate_stat = {
        "device": root_device, "inode": 300, "type": "directory", "nlink": 2,
        "size": 4096, "mode": stat.S_IFDIR | 0o755, "mtime_ns": 123, "ctime_ns": 456,
    }
    return {
        "schema": overlap.PROBE_SCHEMA,
        "decision": "disjoint",
        "reference_marker": {
            "sha256": marker_sha, "size": marker_size,
            "device": root_device, "inode": 200,
        },
        "reference_stat": {"device": root_device, "inode": 100},
        "reference_mount": {
            "mount_id": 10, "parent_id": 1, "device": device,
            "root": reference_root, "mountpoint": "/reference",
        },
        "candidate_mounts": [
            {"mount_id": 20 + index, "parent_id": 1, "device": device,
             "root": root, "mountpoint": mountpoint}
            for index, (root, device, mountpoint) in enumerate(
                zip(candidate_roots, candidate_devices, candidate_mountpoints))
        ],
        "candidate_stat_before": candidate_stat_before or candidate_stat,
        "candidate_stat_after": candidate_stat_after or candidate_stat,
        "mountinfo_sha256_before": "b" * 64,
        "mountinfo_sha256_after": "b" * 64,
    }


class BindOverlapProbeTests(unittest.TestCase):
    def _master_probe_backend(self, *, protected_type="volume"):
        return {
            "Id": "b" * 64,
            "Image": "sha256:" + "d" * 64,
            "Config": {"Labels": {
                "com.docker.compose.project": "fullmag-master",
                "com.docker.compose.service": "backend"}},
            "Mounts": [
                {"Type": "bind", "Source": WSL_ALIAS + "Ubuntu/master-state",
                 "Destination": "/state"},
                {"Type": protected_type, "Name": "master-control", "Source": "/control",
                 "Destination": "/opt/fullmag/control"},
                {"Type": protected_type, "Name": "master-ledger", "Source": "/ledger",
                 "Destination": "/host-ledger"},
            ],
        }

    def _foreign_probe_container(self, alias):
        return {
            "Id": "e" * 64,
            "Image": "sha256:" + "f" * 64,
            "Mounts": [{"Type": "bind", "Source": alias,
                        "Destination": "/etc/mongo.conf", "RW": False}],
            "HostConfig": {"Mounts": None, "Binds": [alias + ":/etc/mongo.conf:ro"]},
            "State": {"StartedAt": "2026-10-27T10:00:00Z", "Status": "running",
                      "Running": True, "Pid": 234},
        }

    def _probe_control(self, operation=None):
        writes = []
        documents = {}
        control = SimpleNamespace(project="fullmag-master", volume="master-control",
                                  _active_operation=operation, writes=writes, documents=documents)

        def read_bytes(path, *, optional=False, **_kwargs):
            if optional and path not in documents:
                return None
            if path not in documents:
                raise FileNotFoundError(path)
            return documents[path]

        def write_bytes(path, raw):
            writes.append(("bytes", path, bytes(raw)))
            documents[path] = bytes(raw)

        def write(path, value):
            writes.append(("json", path, json.dumps(value, sort_keys=True).encode()))
            documents[path] = writes[-1][2]

        control.read_bytes = read_bytes
        control.write_bytes = write_bytes
        control.write = write
        return control

    def _wrapper_inputs(self, root, alias, *, candidate_roots=("/srv/other/mongo.conf",)):
        marker_raw = b"accepted master owner marker"
        (root / overlap.OWNER_MARKER).write_bytes(marker_raw)
        marker_sha = hashlib.sha256(marker_raw).hexdigest()
        result = _proof_document(root_device=os.stat(root).st_dev,
                                 candidate_roots=candidate_roots,
                                 marker_sha=marker_sha, marker_size=len(marker_raw))
        foreign = self._foreign_probe_container(alias)
        return marker_sha, result, foreign

    def test_foreign_alias_wrapper_requires_disjoint_proof_and_archives_only_in_operation(self):
        alias = WSL_ALIAS + "Ubuntu2/mongo/mongod.conf"
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "state"
            root.mkdir()
            marker_sha, result, foreign = self._wrapper_inputs(root, alias)
            control = self._probe_control()
            backend = self._master_probe_backend()
            with patch.object(overlap, "bounded_capture", return_value=subprocess.CompletedProcess(
                    [], 0, json.dumps(result).encode(), b"")), \
                 patch.object(overlap, "docker_capture", return_value=subprocess.CompletedProcess(
                    [], 0, json.dumps([foreign]).encode(), b"")) as inspect:
                proof = overlap.prove_foreign_alias_disjoint(
                    control, backend, foreign, alias, root)
            self.assertEqual(proof["schema"], overlap.FOREIGN_PROOF_SCHEMA)
            self.assertEqual(proof["decision"], "disjoint")
            self.assertEqual(proof["container_id"], foreign["Id"])
            self.assertEqual(proof["candidate_alias_sha256"],
                             hashlib.sha256(alias.encode()).hexdigest())
            self.assertEqual(control.writes, [])
            inspect.assert_called_once_with("inspect", foreign["Id"], timeout=60)

            operation = {"root": "linux-host-readmission/attempts/" + "a" * 32,
                         "receipt": {"attempt": "a" * 32}}
            control = self._probe_control(operation)
            with patch.object(overlap, "bounded_capture", return_value=subprocess.CompletedProcess(
                    [], 0, json.dumps(result).encode(), b"")), \
                 patch.object(overlap, "docker_capture", return_value=subprocess.CompletedProcess(
                    [], 0, json.dumps([foreign]).encode(), b"")):
                archived = overlap.prove_foreign_alias_disjoint(
                    control, backend, foreign, alias, root)
            byte_writes = [write for write in control.writes if write[0] == "bytes"]
            receipt_writes = [write for write in control.writes if write[0] == "json"]
            self.assertEqual(len(byte_writes), 1)
            self.assertEqual(len(receipt_writes), 1)
            path = byte_writes[0][1]
            self.assertRegex(path, r"^linux-host-readmission/attempts/[0-9a-f]{32}/foreign-bind-proofs/[0-9a-f]{32}\.json$")
            self.assertEqual(json.loads(byte_writes[0][2]), archived)
            reference = control._active_operation["receipt"].get("foreign_bind_proofs")
            self.assertEqual(reference, [{"path": path,
                                         "sha256": hashlib.sha256(byte_writes[0][2]).hexdigest()}])
            self.assertTrue(receipt_writes[0][1].endswith("/receipt.json"))
            self.assertEqual(marker_sha, result["reference_marker"]["sha256"])

    def test_foreign_alias_wrapper_rejects_overlap_backend_protected_binds_and_container_drift(self):
        alias = WSL_ALIAS + "Ubuntu2/mongo/mongod.conf"
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "state"
            root.mkdir()
            _, result, foreign = self._wrapper_inputs(root, alias,
                                                       candidate_roots=("/srv/fullmag/state/runs/x",))
            control = self._probe_control()
            backend = self._master_probe_backend()
            with patch.object(overlap, "bounded_capture", return_value=subprocess.CompletedProcess(
                    [], 0, json.dumps(result).encode(), b"")), \
                 patch.object(overlap, "docker_capture") as inspect:
                with self.assertRaises(BuildControlError):
                    overlap.prove_foreign_alias_disjoint(control, backend, foreign, alias, root)
                inspect.assert_not_called()

            _, result, foreign = self._wrapper_inputs(root, alias)
            bind_backend = self._master_probe_backend(protected_type="bind")
            with patch.object(overlap, "bounded_capture") as probe:
                with self.assertRaisesRegex(BuildControlError, "protected mounts must be named volumes"):
                    overlap.prove_foreign_alias_disjoint(control, bind_backend, foreign, alias, root)
                probe.assert_not_called()

            _, result, foreign = self._wrapper_inputs(root, alias)
            changed_records = []
            changed_id = json.loads(json.dumps(foreign))
            changed_id["Id"] = "1" * 64
            changed_records.append(changed_id)
            changed_mount = json.loads(json.dumps(foreign))
            changed_mount["Mounts"][0]["RW"] = True
            changed_records.append(changed_mount)
            changed_host_mount = json.loads(json.dumps(foreign))
            changed_host_mount["HostConfig"]["Binds"].append("/other:/new:ro")
            changed_records.append(changed_host_mount)
            changed_lifecycle = json.loads(json.dumps(foreign))
            changed_lifecycle["State"]["StartedAt"] = "2026-10-27T10:01:00Z"
            changed_records.append(changed_lifecycle)
            for changed in changed_records:
                observations = [changed]
                if changed is changed_lifecycle:
                    # A one-off sibling transition can be re-proven. Keep
                    # rejecting a lifecycle that changes around EVERY proof.
                    observations = []
                    for index in range(overlap.MAX_FOREIGN_LIFECYCLE_PROOFS):
                        transition = json.loads(json.dumps(changed_lifecycle))
                        transition["State"]["StartedAt"] = f"2026-10-27T10:01:0{index}Z"
                        observations.append(transition)
                with self.subTest(changed=changed), \
                     patch.object(overlap, "bounded_capture", return_value=subprocess.CompletedProcess(
                        [], 0, json.dumps(result).encode(), b"")), \
                     patch.object(overlap, "docker_capture", side_effect=[subprocess.CompletedProcess(
                        [], 0, json.dumps([record]).encode(), b"") for record in observations]):
                    with self.assertRaisesRegex(BuildControlError, "identity changed|lifecycle remained unstable"):
                        overlap.prove_foreign_alias_disjoint(control, backend, foreign, alias, root)

    def test_embedded_immutable_python_probe_is_syntactically_valid(self):
        compile(overlap.PROBE_SOURCE, "<managed-bind-overlap-probe>", "exec")

    def test_mountinfo_same_device_disjoint_roots_are_proved(self):
        device = os.makedev(8, 1)
        document = _mountinfo(
            _line(1, 0, "8:1", "/", "/"),
            _line(10, 1, "8:1", "/srv/fullmag/state", "/reference"),
            _line(20, 1, "8:1", "/srv/containers_admin2/state", "/candidate"),
        )
        proof = overlap._classify_mountinfo(document, device)
        self.assertEqual(proof["decision"], "disjoint")
        self.assertEqual(proof["reference_mount"]["root"], "/srv/fullmag/state")
        self.assertEqual(proof["candidate_mounts"][0]["root"], "/srv/containers_admin2/state")

    def test_regular_file_bind_root_can_be_disjoint_from_reference_directory(self):
        device = os.makedev(8, 1)
        document = _mountinfo(
            _line(1, 0, "8:1", "/", "/"),
            _line(10, 1, "8:1", "/srv/fullmag/state", "/reference"),
            _line(20, 1, "8:1", "/srv/containers_admin2/mongo.conf", "/candidate"),
        )
        proof = overlap._classify_mountinfo(document, device)
        self.assertEqual(proof["decision"], "disjoint")
        self.assertEqual(proof["candidate_mounts"][0]["root"],
                         "/srv/containers_admin2/mongo.conf")

    def test_regular_file_bind_root_overlapping_reference_directory_is_rejected(self):
        device = os.makedev(8, 1)
        document = _mountinfo(
            _line(1, 0, "8:1", "/", "/"),
            _line(10, 1, "8:1", "/srv/fullmag/state", "/reference"),
            _line(20, 1, "8:1", "/srv/fullmag/state/mongo.conf", "/candidate"),
        )
        with self.assertRaisesRegex(ValueError, "overlap"):
            overlap._classify_mountinfo(document, device)

    def test_candidate_stat_accepts_only_directory_or_single_link_regular_file(self):
        device = os.makedev(8, 1)

        def metadata(mode, *, nlink=1):
            return SimpleNamespace(st_dev=device, st_ino=300, st_nlink=nlink,
                                   st_size=64, st_mode=mode, st_mtime_ns=123,
                                   st_ctime_ns=456)

        identity = overlap._candidate_stat_identity(metadata(stat.S_IFREG | 0o600), "8:1")
        self.assertEqual(identity["type"], "regular-file")
        self.assertEqual(identity["inode"], 300)
        with self.assertRaisesRegex(ValueError, "multiple links"):
            overlap._candidate_stat_identity(metadata(stat.S_IFREG | 0o600, nlink=2), "8:1")
        with self.assertRaisesRegex(ValueError, "neither a directory nor a regular file"):
            overlap._candidate_stat_identity(metadata(stat.S_IFLNK | 0o777), "8:1")
        with self.assertRaisesRegex(ValueError, "neither a directory nor a regular file"):
            overlap._candidate_stat_identity(metadata(stat.S_IFIFO | 0o600), "8:1")
        with self.assertRaisesRegex(ValueError, "differs from its kernel mountinfo"):
            overlap._candidate_stat_identity(metadata(stat.S_IFREG | 0o600), "8:2")

    def test_candidate_identity_uses_opath_metadata_without_reading_contents(self):
        device = os.makedev(8, 1)
        metadata = SimpleNamespace(st_dev=device, st_ino=300, st_nlink=1,
                                   st_size=64, st_mode=stat.S_IFREG | 0o600,
                                   st_mtime_ns=123, st_ctime_ns=456)
        with (patch.object(overlap.os, "open", return_value=91) as open_file,
              patch.object(overlap.os, "fstat", return_value=metadata),
              patch.object(overlap.os, "close") as close_file,
              patch.object(overlap.os, "read", side_effect=AssertionError("candidate contents read"))
              as read_file):
            identity = overlap._candidate_identity({"device": "8:1"})
        self.assertEqual(identity["type"], "regular-file")
        open_file.assert_called_once_with(
            "/candidate", os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC)
        close_file.assert_called_once_with(91)
        read_file.assert_not_called()

    def test_reference_submount_prevents_false_disjoint_proof(self):
        device = os.makedev(8, 1)
        document = _mountinfo(
            _line(1, 0, "8:1", "/", "/"),
            _line(10, 1, "8:1", "/master-state", "/reference"),
            _line(11, 10, "8:1", "/shared-results", "/reference/results"),
            _line(20, 1, "8:1", "/shared-results", "/candidate"),
        )
        with self.assertRaisesRegex(ValueError, "reference subtree has a nested mount"):
            overlap._classify_mountinfo(document, device)

    def test_same_parent_or_descendant_mount_roots_are_overlap(self):
        device = os.makedev(8, 1)
        for candidate_root in ("/", "/srv/fullmag", "/srv/fullmag/state",
                               "/srv/fullmag/state/runs"):
            with self.subTest(candidate_root=candidate_root):
                document = _mountinfo(
                    _line(1, 0, "8:1", "/", "/"),
                    _line(10, 1, "8:1", "/srv/fullmag/state", "/reference"),
                    _line(20, 1, "8:1", candidate_root, "/candidate"),
                )
                with self.assertRaisesRegex(ValueError, "overlap"):
                    overlap._classify_mountinfo(document, device)

    def test_nested_candidate_mount_that_overlaps_reference_is_rejected(self):
        device = os.makedev(8, 1)
        document = _mountinfo(
            _line(1, 0, "8:1", "/", "/"),
            _line(10, 1, "8:1", "/srv/fullmag/state", "/reference"),
            _line(20, 1, "8:1", "/srv/other/state", "/candidate"),
            _line(21, 20, "8:1", "/srv/fullmag/state/runs", "/candidate/runs"),
        )
        with self.assertRaisesRegex(ValueError, "overlap"):
            overlap._classify_mountinfo(document, device)

    def test_any_different_candidate_device_is_unknown(self):
        device = os.makedev(8, 1)
        documents = (
            _mountinfo(
                _line(1, 0, "8:1", "/", "/"),
                _line(10, 1, "8:1", "/srv/fullmag/state", "/reference"),
                _line(20, 1, "8:2", "/srv/other/state", "/candidate"),
            ),
            _mountinfo(
                _line(1, 0, "8:1", "/", "/"),
                _line(10, 1, "8:1", "/srv/fullmag/state", "/reference"),
                _line(20, 1, "8:1", "/srv/other/state", "/candidate"),
                _line(21, 20, "8:2", "/srv/other/cache", "/candidate/cache"),
            ),
        )
        for document in documents:
            with self.assertRaisesRegex(ValueError, "device differs"):
                overlap._classify_mountinfo(document, device)

    def test_mountinfo_rejects_malformed_escape_traversal_and_controls(self):
        device = os.makedev(8, 1)
        invalid_rows = (
            _line(20, 1, "8:x", "/srv/other", "/candidate"),
            "20 1 8:1 /srv/other/../state /candidate rw - ext4 /dev/test rw",
            "20 1 8:1 /srv/other\\011state /candidate rw - ext4 /dev/test rw",
            "20 1 8:1 /srv/other\\777state /candidate rw - ext4 /dev/test rw",
            "20 1 999999999999999999999:1 /srv/other /candidate rw - ext4 /dev/test rw",
        )
        invalid_rows += ("20 1 8:1 /srv/other\x01state /candidate rw - ext4 /dev/test rw",)
        for bad in invalid_rows:
            document = _mountinfo(
                _line(1, 0, "8:1", "/", "/"),
                _line(10, 1, "8:1", "/srv/fullmag/state", "/reference"),
                bad,
            )
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                overlap._classify_mountinfo(document, device)

    def test_reference_marker_drift_during_probe_fails_closed(self):
        with self.subTest("changed marker"):
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary) / "state"
                root.mkdir()
                marker = root / overlap.OWNER_MARKER
                marker.write_bytes(b"accepted owner marker bytes")
                original_sha = hashlib.sha256(marker.read_bytes()).hexdigest()
                result = _proof_document(root_device=os.stat(root).st_dev,
                                         marker_sha=original_sha,
                                         marker_size=len(marker.read_bytes()))

                def changed_marker(*_args, **_kwargs):
                    marker.write_bytes(b"mutated owner marker bytes")
                    return subprocess.CompletedProcess([], 0, json.dumps(result).encode(), b"")

                control = SimpleNamespace(project="fullmag-master")
                backend = {"Image": "sha256:" + "d" * 64,
                           "Config": {"Labels": {
                               "com.docker.compose.project": "fullmag-master",
                               "com.docker.compose.service": "backend"}}}
                with patch.object(overlap, "bounded_capture", side_effect=changed_marker):
                    with self.assertRaisesRegex(BuildControlError, "reference changed"):
                        overlap.prove_disjoint_bind(
                            control, backend, alias=WSL_ALIAS + "Ubuntu/hash/state",
                            reference_root=root, reference_marker_sha256=original_sha,
                        )

    def test_probe_result_and_helper_argv_are_strict_and_read_only(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "state"
            root.mkdir()
            marker = root / overlap.OWNER_MARKER
            marker.write_bytes(b"accepted owner marker bytes")
            marker_sha = hashlib.sha256(marker.read_bytes()).hexdigest()
            result = _proof_document(root_device=os.stat(root).st_dev,
                                     marker_sha=marker_sha,
                                     marker_size=len(marker.read_bytes()))
            captured = {}

            def fake_capture(command, *, data, timeout, maximum):
                captured.update(command=command, data=data, timeout=timeout, maximum=maximum)
                return subprocess.CompletedProcess(command, 0, json.dumps(result).encode(), b"")

            writes = []
            control = SimpleNamespace(project="fullmag-master", write=lambda *args: writes.append(args))
            backend = {"Image": "sha256:" + "d" * 64,
                       "Config": {"Labels": {
                           "com.docker.compose.project": "fullmag-master",
                           "com.docker.compose.service": "backend"}}}
            with patch.object(overlap, "bounded_capture", side_effect=fake_capture):
                proof = overlap.prove_disjoint_bind(
                    control, backend, alias=WSL_ALIAS + "Ubuntu/hash/state",
                    reference_root=root, reference_marker_sha256=marker_sha,
                )

            command = captured["command"]
            self.assertIn("run", command)
            self.assertIn("--pull", command)
            self.assertIn("never", command)
            self.assertIn("--network", command)
            self.assertIn("none", command)
            self.assertIn("--runtime", command)
            self.assertIn("runc", command)
            self.assertIn("--read-only", command)
            self.assertIn("--cap-drop", command)
            self.assertIn("ALL", command)
            self.assertIn("--security-opt", command)
            self.assertIn("no-new-privileges:true", command)
            self.assertIn("--pids-limit", command)
            self.assertIn("32", command)
            self.assertIn("--memory", command)
            self.assertIn("64m", command)
            self.assertIn("--cpus", command)
            self.assertIn("0.25", command)
            self.assertIn("NVIDIA_VISIBLE_DEVICES=void", command)
            self.assertIn("65532:65532", command)
            self.assertIn("--mount", command)
            self.assertTrue(any("type=bind,src=" + str(root) + ",dst=/reference,readonly" == item
                                for item in command))
            self.assertTrue(any("type=bind,src=" + WSL_ALIAS + "Ubuntu/hash/state,dst=/candidate,readonly" == item
                                for item in command))
            self.assertNotIn("--privileged", command)
            self.assertNotIn("--pid", command)
            self.assertNotIn("build", command)
            self.assertEqual(writes, [])
            self.assertEqual(proof["schema"], overlap.PROOF_SCHEMA)
            self.assertEqual(proof["decision"], "disjoint")
            self.assertEqual(proof["probe_schema"], overlap.PROBE_SCHEMA)
            self.assertEqual(proof["reference_marker_sha256"], marker_sha)
            self.assertEqual(proof["mountinfo_sha256"], "b" * 64)
            self.assertEqual(proof["candidate_alias_sha256"],
                             hashlib.sha256((WSL_ALIAS + "Ubuntu/hash/state").encode()).hexdigest())
            self.assertEqual(proof["candidate_stat"]["type"], "directory")

    def test_probe_result_pins_candidate_stat_and_rejects_drift_or_hardlinks(self):
        root_device = os.makedev(8, 1)
        result = _proof_document(root_device=root_device)
        parsed = overlap._validate_probe_result(json.dumps(result).encode(), "a" * 64, 23)
        self.assertEqual(parsed["candidate_stat"]["device"], root_device)
        self.assertEqual(parsed["candidate_stat"]["type"], "directory")

        changed = dict(result)
        changed["candidate_stat_after"] = dict(result["candidate_stat_after"], inode=301)
        with self.assertRaisesRegex(ValueError, "candidate stat changed"):
            overlap._validate_probe_result(json.dumps(changed).encode(), "a" * 64, 23)

        linked = dict(result)
        linked["candidate_stat_before"] = dict(result["candidate_stat_before"],
                                               type="regular-file", nlink=2,
                                               mode=stat.S_IFREG | 0o600)
        linked["candidate_stat_after"] = dict(linked["candidate_stat_before"])
        with self.assertRaisesRegex(ValueError, "multiple links"):
            overlap._validate_probe_result(json.dumps(linked).encode(), "a" * 64, 23)

    def test_unsafe_alias_and_malformed_probe_result_fail_before_proof(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "state"
            root.mkdir()
            marker = root / overlap.OWNER_MARKER
            marker.write_bytes(b"accepted owner marker bytes")
            marker_sha = hashlib.sha256(marker.read_bytes()).hexdigest()
            control = SimpleNamespace(project="fullmag-master")
            backend = {"Image": "sha256:" + "d" * 64,
                       "Config": {"Labels": {
                           "com.docker.compose.project": "fullmag-master",
                           "com.docker.compose.service": "backend"}}}
            with patch.object(overlap, "bounded_capture") as capture:
                with self.assertRaises(BuildControlError):
                    overlap.prove_disjoint_bind(
                        control, backend, alias="/run/desktop/other/state",
                        reference_root=root, reference_marker_sha256=marker_sha,
                    )
                capture.assert_not_called()

            result = _proof_document(root_device=os.stat(root).st_dev,
                                     marker_sha=marker_sha,
                                     marker_size=len(marker.read_bytes()))
            result["mountinfo_sha256_after"] = "c" * 64
            with patch.object(overlap, "bounded_capture", return_value=subprocess.CompletedProcess(
                    [], 0, json.dumps(result).encode(), b"")):
                with self.assertRaises(BuildControlError):
                    overlap.prove_disjoint_bind(
                        control, backend, alias=WSL_ALIAS + "Ubuntu/hash/state",
                        reference_root=root, reference_marker_sha256=marker_sha,
                    )

            with patch.object(overlap, "bounded_capture", return_value=subprocess.CompletedProcess(
                    [], 0, b'{"schema":"first","schema":"second"}', b"")):
                with self.assertRaises(BuildControlError):
                    overlap.prove_disjoint_bind(
                        control, backend, alias=WSL_ALIAS + "Ubuntu/hash/state",
                        reference_root=root, reference_marker_sha256=marker_sha,
                    )

    def test_owner_marker_symlink_is_rejected_before_probe(self):
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            root = parent / "state"
            root.mkdir()
            actual = parent / "actual-owner.json"
            actual.write_bytes(b"accepted owner marker bytes")
            (root / overlap.OWNER_MARKER).symlink_to(actual)
            marker_sha = hashlib.sha256(actual.read_bytes()).hexdigest()
            control = SimpleNamespace(project="fullmag-master")
            backend = {"Image": "sha256:" + "d" * 64,
                       "Config": {"Labels": {
                           "com.docker.compose.project": "fullmag-master",
                           "com.docker.compose.service": "backend"}}}
            with patch.object(overlap, "bounded_capture") as capture:
                with self.assertRaisesRegex(BuildControlError, "without following links"):
                    overlap.prove_disjoint_bind(
                        control, backend, alias=WSL_ALIAS + "Ubuntu/hash/state",
                        reference_root=root, reference_marker_sha256=marker_sha,
                    )
                capture.assert_not_called()

    def test_reference_symlink_is_rejected_without_launching_probe(self):
        with tempfile.TemporaryDirectory() as temporary:
            actual = Path(temporary) / "actual"
            actual.mkdir()
            (actual / overlap.OWNER_MARKER).write_bytes(b"accepted owner marker bytes")
            linked = Path(temporary) / "linked"
            linked.symlink_to(actual, target_is_directory=True)
            marker_sha = hashlib.sha256((actual / overlap.OWNER_MARKER).read_bytes()).hexdigest()
            control = SimpleNamespace(project="fullmag-master")
            backend = {"Image": "sha256:" + "d" * 64,
                       "Config": {"Labels": {
                           "com.docker.compose.project": "fullmag-master",
                           "com.docker.compose.service": "backend"}}}
            with patch.object(overlap, "bounded_capture") as capture:
                with self.assertRaisesRegex(BuildControlError, "symlink"):
                    overlap.prove_disjoint_bind(
                        control, backend, alias=WSL_ALIAS + "Ubuntu/hash/state",
                        reference_root=linked, reference_marker_sha256=marker_sha,
                    )
                capture.assert_not_called()


class WorktreeForeignAliasProbeTests(unittest.TestCase):
    def _worktree_inputs(self, parent, *, foreign_project="fullmag-master"):
        import docker_compose_identity
        import docker_backend_volume_cache
        import docker_group_ledger
        import linux_native_host
        from bootstrap_docker_toolchain import control_volume_name

        project = "fullmag-worktree-sp4-comparison-20261102"
        worktree_id = "sp4-comparison-20261102"
        source_root = parent / "source"
        source_root.mkdir()
        reference_root = parent / "state"
        reference_root.mkdir()
        state_alias = WSL_ALIAS + "Ubuntu/fullmag/state"
        candidate_alias = WSL_ALIAS + "Ubuntu2/mysql/conf.d"
        namespace = "namespaces/" + "a" * 32
        volume_name = control_volume_name(project)
        identity = {
            "project_name": project,
            "network_name": "fullmag-worktree-network",
            "project_id": "project-sp4",
            "worktree_id": worktree_id,
            "checkout_kind": "worktree",
            "source_root": str(source_root),
            "registered_name": worktree_id,
        }

        class Control(SimpleNamespace):
            @property
            def shared_labels(self):
                return self.labels

            def subpath(self, relative=""):
                return "/".join(value for value in (self.namespace, relative) if value)

        control = Control(project=project, identity=identity, volume=volume_name,
                          namespace=namespace, labels={
                              "com.docker.compose.project": project,
                              "org.fullmag.compose.project": project,
                              "org.fullmag.source.worktree-id": worktree_id,
                          }, _active_operation=None)
        image_id = "sha256:" + "d" * 64
        control_alias = docker_backend_volume_cache.COMPOSE_CONTROL_VOLUME
        ledger_subpath = namespace + "/private/ledger"
        ledger_profile = docker_group_ledger.profile(
            "e" * 64, project, volume_name, image_id,
            ledger_subpath=ledger_subpath,
        )
        source_labels = docker_compose_identity.source_labels(identity)
        control_mountpoint = "/var/lib/docker/volumes/" + volume_name + "/_data"
        control_source = control_mountpoint + "/" + namespace
        ledger_source = control_source + "/private/ledger"
        service_volumes = [
            {"type": "bind", "source": str(reference_root), "target": "/state",
             "read_only": False},
            {"type": "bind", "source": str(source_root), "target": "/opt/fullmag/source",
             "read_only": True},
            {"type": "volume", "source": control_alias, "target": "/opt/fullmag/control",
             "volume": {"nocopy": True, "subpath": namespace}},
            *ledger_profile["backend"]["volumes"],
        ]
        environment = {
            "FULLMAG_SESSION_STORAGE_PROFILE": linux_native_host.PROFILE,
            **ledger_profile["environment"],
        }
        compose = {
            "name": project,
            "x-fullmag-control-namespace": namespace,
            "services": {"backend": {
                "image": image_id,
                "entrypoint": ["/bin/sh"],
                "command": ["run"],
                "environment": environment,
                "labels": {**source_labels,
                           "com.docker.compose.project": project,
                           "com.docker.compose.service": "backend"},
                "volumes": service_volumes,
                "x-fullmag-daemon-binds": {"/state": state_alias},
            }},
            "volumes": {
                control_alias: {"name": volume_name, "external": True},
                docker_group_ledger.COMPOSE_VOLUME: ledger_profile["compose_volume"],
            },
        }
        backend = {
            "Id": "b" * 64,
            "Image": image_id,
            "Config": {
                "Image": image_id,
                "Labels": {**source_labels,
                           "com.docker.compose.project": project,
                           "com.docker.compose.service": "backend"},
                "Env": [key + "=" + value for key, value in environment.items()],
                "Entrypoint": ["/bin/sh"],
                "Cmd": ["run"],
            },
            "HostConfig": {
                "ReadonlyRootfs": True,
                "Privileged": False,
                "GroupAdd": [],
                "Tmpfs": {},
                "PidMode": "private",
                "IpcMode": "private",
                "NetworkMode": identity["network_name"],
                "Mounts": [{
                    "Type": "volume", "Source": volume_name, "Target": "/opt/fullmag/control",
                    "VolumeOptions": {"Subpath": namespace},
                }, {
                    "Type": "volume", "Source": volume_name, "Target": "/host-ledger",
                    "VolumeOptions": {"Subpath": ledger_subpath},
                }],
            },
            "State": {
                "Status": "exited", "Running": False, "Pid": 0, "ExitCode": 0,
                "Restarting": False, "Paused": False,
                "StartedAt": "2026-11-06T10:00:00Z",
                "FinishedAt": "2026-11-06T10:01:00Z",
            },
            "RestartCount": 0,
            "NetworkSettings": {"Networks": {identity["network_name"]: {}}},
            "Mounts": [
                {"Type": "bind", "Source": state_alias, "Destination": "/state", "RW": True},
                {"Type": "bind", "Source": str(source_root),
                 "Destination": "/opt/fullmag/source", "RW": False},
                {"Type": "volume", "Source": control_mountpoint, "Name": volume_name,
                 "Destination": "/opt/fullmag/control", "RW": True, "Driver": "local"},
                {"Type": "volume", "Source": ledger_source, "Name": volume_name,
                 "Destination": "/host-ledger", "RW": True, "Driver": "local"},
            ],
        }
        root_info = os.stat(reference_root)
        certificate = {
            "schema": linux_native_host.HOST_SCHEMA,
            "storage_profile": linux_native_host.PROFILE,
            "role": "session",
            "owner_scope": "docker-linux",
            "host_root": str(reference_root),
            "host_filesystem": "ext4",
            "host_platform": "linux",
            "host_device": root_info.st_dev,
            "host_root_no_reparse": True,
            "host_inode": root_info.st_ino,
            "engine_id": "test-docker-engine",
        }
        certificate_raw = json.dumps(certificate, sort_keys=True).encode()
        (reference_root / linux_native_host.CERTIFICATE_NAME).write_bytes(certificate_raw)
        marker_raw = certificate_raw
        (reference_root / linux_native_host.OWNER_NAME).write_bytes(marker_raw)

        foreign = {
            "Id": "e" * 64,
            "Image": "sha256:" + "f" * 64,
            "Config": {"Labels": {
                "com.docker.compose.project": foreign_project,
                "com.docker.compose.service": "backend",
                "org.fullmag.compose.project": foreign_project}},
            "Mounts": [{"Type": "bind", "Source": candidate_alias,
                        "Destination": "/etc/mysql/conf.d", "RW": False}],
            "HostConfig": {"Mounts": None,
                           "Binds": [candidate_alias + ":/etc/mysql/conf.d:ro"]},
            "State": {"StartedAt": "2026-11-06T10:00:00Z", "Status": "running",
                      "Running": True, "Pid": 234},
        }
        marker_sha = hashlib.sha256(marker_raw).hexdigest()
        kernel_result = _proof_document(
            root_device=root_info.st_dev,
            candidate_roots=("/srv/other-project/mysql",),
            marker_sha=marker_sha,
            marker_size=len(marker_raw),
        )
        kernel_result["reference_stat"] = {
            "device": root_info.st_dev, "inode": root_info.st_ino,
        }
        volume = {"Name": volume_name, "Driver": "local", "Options": {},
                  "Labels": control.shared_labels, "Mountpoint": control_mountpoint}
        image = {"Id": image_id, "Config": {"Entrypoint": ["/bin/sh"], "Cmd": ["run"]}}
        return {
            "control": control, "backend": backend, "compose": compose,
            "foreign": foreign, "source_root": source_root, "reference_root": reference_root,
            "state_alias": state_alias, "candidate_alias": candidate_alias,
            "kernel_result": kernel_result, "volume": volume, "image": image,
            "identity": identity, "control_mountpoint": control_mountpoint,
            "certificate": certificate,
        }

    def _patched_probe(self, values, *, foreign_observations=None,
                       backend_observations=None, probe_callback=None):
        import docker_volume_dev
        import fullmag_storage
        import docker_compose_identity
        import docker_development_inputs
        import docker_linux_native_readmission
        import linux_native_host

        foreign_observations = list(foreign_observations or [values["foreign"], values["foreign"]])
        backend_observations = list(backend_observations or [values["backend"]])
        capture_calls = {"foreign": 0, "backend": 0}

        def capture(*args, **_kwargs):
            if args[:2] == ("image", "inspect"):
                return subprocess.CompletedProcess(args, 0, json.dumps([values["image"]]).encode(), b"")
            if args[:2] == ("volume", "inspect"):
                return subprocess.CompletedProcess(args, 0, json.dumps([values["volume"]]).encode(), b"")
            if args[0] == "inspect" and args[1] == values["backend"]["Id"]:
                index = capture_calls["backend"]
                capture_calls["backend"] += 1
                record = backend_observations[min(index, len(backend_observations) - 1)]
                return subprocess.CompletedProcess(args, 0, json.dumps([record]).encode(), b"")
            if args[0] == "inspect" and args[1] == values["foreign"]["Id"]:
                index = capture_calls["foreign"]
                capture_calls["foreign"] += 1
                record = foreign_observations[min(index, len(foreign_observations) - 1)]
                return subprocess.CompletedProcess(args, 0, json.dumps([record]).encode(), b"")
            raise AssertionError("unexpected Docker observation: " + repr(args))

        def live_bind_path(path):
            if path == values["state_alias"]:
                return values["reference_root"]
            return Path(path)

        def bounded(command, *, data, timeout, maximum):
            if probe_callback is not None:
                probe_callback()
            return subprocess.CompletedProcess(command, 0,
                                               json.dumps(values["kernel_result"]).encode(), b"")

        stack = [
            patch.object(overlap, "docker_capture", side_effect=capture),
            patch.object(overlap, "bounded_capture", side_effect=bounded),
            patch.object(docker_development_inputs, "select_checkout",
                         return_value=values["source_root"]),
            patch.object(fullmag_storage, "resolve_layout", return_value={"selected": True}),
            patch.object(docker_compose_identity, "compose_project_identity",
                         return_value=values["identity"]),
            patch.object(docker_linux_native_readmission, "live_bind_path", side_effect=live_bind_path),
            patch.object(docker_volume_dev, "docker_text", return_value="test-docker-engine"),
            patch.object(docker_volume_dev, "local_volume", return_value={
                "host_root": str(values["reference_root"]), "host_filesystem": "ext4",
                "host_platform": "linux", "host_device": os.stat(values["reference_root"]).st_dev,
                "host_root_no_reparse": True,
            }),
        ]
        return stack

    def test_registered_worktree_context_proves_disjoint_master_consumer(self):
        with tempfile.TemporaryDirectory() as temporary:
            values = self._worktree_inputs(Path(temporary))
            with ExitStack() as stack:
                for patcher in self._patched_probe(values):
                    stack.enter_context(patcher)
                proof = overlap.prove_worktree_foreign_alias_disjoint(
                    values["control"], values["backend"], values["foreign"],
                    values["candidate_alias"], values["reference_root"],
                    compose=values["compose"],
                )
            self.assertEqual(proof["schema"], overlap.WORKTREE_FOREIGN_PROOF_SCHEMA)
            self.assertEqual(proof["decision"], "disjoint")
            self.assertEqual(proof["container_id"], values["foreign"]["Id"])
            self.assertEqual(proof["worktree_context"]["compose_project"],
                             values["control"].project)
            self.assertEqual(proof["worktree_context"]["control_namespace"],
                             values["control"].namespace)
            self.assertEqual(proof["worktree_context"]["ledger_subpath"],
                             values["control"].namespace + "/private/ledger")
            self.assertEqual(
                next(mount["source"] for mount in values["compose"]["services"]["backend"]["volumes"]
                     if mount.get("target") == "/opt/fullmag/control"),
                "backend-cache-control",
            )
            overlap.validate_foreign_alias_disjoint_proof(
                proof, alias=values["candidate_alias"], container_id=values["foreign"]["Id"])

    def test_worktree_probe_rejects_selected_project_container_before_launch(self):
        with tempfile.TemporaryDirectory() as temporary:
            selected_project = "fullmag-worktree-sp4-comparison-20261102"
            values = self._worktree_inputs(Path(temporary), foreign_project=selected_project)
            with ExitStack() as stack:
                for patcher in self._patched_probe(values):
                    stack.enter_context(patcher)
                with self.assertRaisesRegex(BuildControlError, "selected worktree project"):
                    overlap.prove_worktree_foreign_alias_disjoint(
                        values["control"], values["backend"], values["foreign"],
                        values["candidate_alias"], values["reference_root"],
                        compose=values["compose"],
                    )

    def test_worktree_probe_rejects_selected_org_project_label(self):
        with tempfile.TemporaryDirectory() as temporary:
            values = self._worktree_inputs(Path(temporary))
            values["foreign"]["Config"]["Labels"]["org.fullmag.compose.project"] = (
                values["control"].project)
            with ExitStack() as stack:
                for patcher in self._patched_probe(values):
                    stack.enter_context(patcher)
                with self.assertRaisesRegex(BuildControlError, "selected worktree project"):
                    overlap.prove_worktree_foreign_alias_disjoint(
                        values["control"], values["backend"], values["foreign"],
                        values["candidate_alias"], values["reference_root"],
                        compose=values["compose"],
                    )

    def test_worktree_probe_rejects_foreign_mount_change_after_kernel_proof(self):
        with tempfile.TemporaryDirectory() as temporary:
            values = self._worktree_inputs(Path(temporary))
            changed = json.loads(json.dumps(values["foreign"]))
            changed["Mounts"][0]["RW"] = True
            with ExitStack() as stack:
                for patcher in self._patched_probe(values,
                                                   foreign_observations=[values["foreign"], changed]):
                    stack.enter_context(patcher)
                with self.assertRaisesRegex(BuildControlError, "identity changed"):
                    overlap.prove_worktree_foreign_alias_disjoint(
                        values["control"], values["backend"], values["foreign"],
                        values["candidate_alias"], values["reference_root"],
                        compose=values["compose"],
                    )

    def test_worktree_probe_rejects_owner_marker_raw_byte_drift(self):
        import linux_native_host

        with tempfile.TemporaryDirectory() as temporary:
            values = self._worktree_inputs(Path(temporary))
            marker = values["reference_root"] / linux_native_host.OWNER_NAME

            def change_marker():
                marker.write_bytes(b"a changed owner marker")

            with ExitStack() as stack:
                for patcher in self._patched_probe(values, probe_callback=change_marker):
                    stack.enter_context(patcher)
                with self.assertRaisesRegex(BuildControlError, "marker|reference changed"):
                    overlap.prove_worktree_foreign_alias_disjoint(
                        values["control"], values["backend"], values["foreign"],
                        values["candidate_alias"], values["reference_root"],
                        compose=values["compose"],
                    )

    def test_worktree_probe_rejects_same_id_stopped_backend_restart(self):
        for changed_field in ("StartedAt", "RestartCount"):
            with self.subTest(changed_field=changed_field), tempfile.TemporaryDirectory() as temporary:
                values = self._worktree_inputs(Path(temporary))
                changed = json.loads(json.dumps(values["backend"]))
                if changed_field == "StartedAt":
                    changed["State"]["StartedAt"] = "2026-11-06T10:00:01Z"
                else:
                    changed["RestartCount"] = 1
                with ExitStack() as stack:
                    for patcher in self._patched_probe(values,
                                                       backend_observations=[values["backend"], changed]):
                        stack.enter_context(patcher)
                    with self.assertRaisesRegex(BuildControlError,
                                                "incarnation changed|lifecycle changed"):
                        overlap.prove_worktree_foreign_alias_disjoint(
                            values["control"], values["backend"], values["foreign"],
                            values["candidate_alias"], values["reference_root"],
                            compose=values["compose"],
                        )


if __name__ == "__main__":
    unittest.main()
