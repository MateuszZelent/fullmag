"""Interpretive checks for read-only bind overlap proofs."""
from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import stat
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

import docker_bind_overlap_probe as overlap
import docker_compose_identity
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

    def _worktree_identity(self):
        return {
            "project_name": "fullmag-worktree-results-snapshot-inspector",
            "network_name": "fullmag-worktree-results-snapshot-inspector_fullmag",
            "project_id": "fullmag",
            "worktree_id": "results-snapshot-inspector",
            "checkout_kind": "worktree",
            "source_root": "/checkout/worktrees/results-snapshot-inspector",
            "registered_name": "results-snapshot-inspector",
        }

    def _worktree_probe_backend(self, identity, *, source_label_overrides=None):
        backend = self._master_probe_backend()
        labels = backend["Config"]["Labels"]
        labels["com.docker.compose.project"] = identity["project_name"]
        labels.update(docker_compose_identity.source_labels(identity))
        labels.update(source_label_overrides or {})
        backend["Mounts"][0]["Source"] = WSL_ALIAS + "Ubuntu/worktree-state"
        backend["Mounts"][1]["Name"] = "worktree-control"
        backend["Mounts"][2]["Name"] = "worktree-ledger"
        return backend

    def _foreign_probe_container(self, alias, *, project=None, service=None,
                                 extra_mounts=()):
        container = {
            "Id": "e" * 64,
            "Image": "sha256:" + "f" * 64,
            "Mounts": [{"Type": "bind", "Source": alias,
                        "Destination": "/etc/mongo.conf", "RW": False},
                       *extra_mounts],
            "HostConfig": {"Mounts": None, "Binds": [alias + ":/etc/mongo.conf:ro"]},
            "State": {"StartedAt": "2026-10-27T10:00:00Z", "Status": "running",
                      "Running": True, "Pid": 234},
        }
        if project is not None or service is not None:
            container["Config"] = {"Labels": {
                "com.docker.compose.project": project,
                "com.docker.compose.service": service,
            }}
        return container

    def _probe_control(self, operation=None, *, project="fullmag-master",
                       volume="master-control", identity=None):
        writes = []
        documents = {}
        control = SimpleNamespace(project=project, volume=volume, identity=identity,
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

    def test_docker_omitted_optional_host_mounts_keeps_required_effective_mount_pins(self):
        alias = WSL_ALIAS + "Ubuntu2/binds-only/config"
        foreign = self._foreign_probe_container(alias)
        explicit = overlap._foreign_container_pin(foreign, alias)
        foreign["HostConfig"].pop("Mounts")
        self.assertEqual(overlap._foreign_container_pin(foreign, alias), explicit)
        for malformed in ({"Binds": [], "Mounts": {}}, {"Mounts": None}, None):
            bad = copy.deepcopy(foreign)
            bad["HostConfig"] = malformed
            with self.subTest(host_config=malformed), self.assertRaises(BuildControlError):
                overlap._foreign_container_pin(bad, alias)
        foreign["Mounts"] = []
        with self.assertRaisesRegex(BuildControlError, "alias is absent"):
            overlap._foreign_container_pin(foreign, alias)

    def test_foreign_alias_wrapper_supports_docker_binds_only_inspection(self):
        alias = WSL_ALIAS + "Ubuntu2/binds-only/config"
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "state"
            root.mkdir()
            _, result, foreign = self._wrapper_inputs(root, alias)
            foreign["HostConfig"].pop("Mounts")
            control = self._probe_control()
            backend = self._master_probe_backend()
            with patch.object(overlap, "bounded_capture", return_value=subprocess.CompletedProcess(
                    [], 0, json.dumps(result).encode(), b"")), \
                 patch.object(overlap, "docker_capture", return_value=subprocess.CompletedProcess(
                    [], 0, json.dumps([foreign]).encode(), b"")):
                proof = overlap.prove_foreign_alias_disjoint(control, backend, foreign, alias, root)
            self.assertEqual(proof["decision"], "disjoint")
            self.assertEqual(control.writes, [])

    def test_worktree_backend_identity_proves_foreign_group_alias(self):
        alias = WSL_ALIAS + "Ubuntu2/mongo/mongod.conf"
        identity = self._worktree_identity()
        project = identity["project_name"]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "state"
            root.mkdir()
            _, result, foreign = self._wrapper_inputs(root, alias)
            # A different Compose group is still proved by the kernel; its label alone is not
            # treated as permission to skip the alias.
            foreign["Config"] = {"Labels": {
                "com.docker.compose.project": "fullmag-worktree-another-group",
                "com.docker.compose.service": "backend",
            }}
            control = self._probe_control(project=project, volume="worktree-control",
                                          identity=identity)
            backend = self._worktree_probe_backend(identity)
            with patch.object(overlap, "bounded_capture", return_value=subprocess.CompletedProcess(
                    [], 0, json.dumps(result).encode(), b"")) as probe, \
                 patch.object(overlap, "docker_capture", return_value=subprocess.CompletedProcess(
                    [], 0, json.dumps([foreign]).encode(), b"")) as inspect:
                proof = overlap.prove_foreign_alias_disjoint(
                    control, backend, foreign, alias, root)
            self.assertEqual(proof["decision"], "disjoint")
            probe.assert_called_once()
            inspect.assert_called_once_with("inspect", foreign["Id"], timeout=60)
            command = probe.call_args.args[0]
            self.assertIn("--label", command)
            self.assertIn("com.docker.compose.project=" + project, command)

    def test_worktree_identity_and_source_labels_are_required_before_probe(self):
        alias = WSL_ALIAS + "Ubuntu2/mongo/mongod.conf"
        identity = self._worktree_identity()
        project = identity["project_name"]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "state"
            root.mkdir()
            (root / overlap.OWNER_MARKER).write_bytes(b"accepted worktree owner marker")
            backend = self._worktree_probe_backend(identity)
            bad_backend = self._worktree_probe_backend(
                identity, source_label_overrides={"org.fullmag.source.worktree-id": "other"})
            wrong_project_backend = self._worktree_probe_backend(identity)
            wrong_project_backend["Config"]["Labels"]["com.docker.compose.project"] = "fullmag-worktree-other"
            wrong_service_backend = self._worktree_probe_backend(identity)
            wrong_service_backend["Config"]["Labels"]["com.docker.compose.service"] = "frontend"
            cases = (
                (self._probe_control(project=project, volume="worktree-control"), backend),
                (self._probe_control(project=project, volume="worktree-control",
                                     identity={**identity, "project_name": "fullmag-worktree-other"}),
                 backend),
                (self._probe_control(project=project, volume="worktree-control",
                                     identity={**identity, "checkout_kind": "main-checkout"}),
                 backend),
                (self._probe_control(project=project, volume="worktree-control",
                                     identity={key: value for key, value in identity.items()
                                               if key != "project_id"}), backend),
                (self._probe_control(project=project, volume="worktree-control",
                                     identity=identity), bad_backend),
                (self._probe_control(project=project, volume="worktree-control",
                                     identity=identity), wrong_project_backend),
                (self._probe_control(project=project, volume="worktree-control",
                                     identity=identity), wrong_service_backend),
            )
            for control, candidate in cases:
                with self.subTest(identity=control.identity, labels=candidate["Config"]["Labels"]), \
                     patch.object(overlap, "bounded_capture") as probe:
                    with self.assertRaises(BuildControlError):
                        overlap.prove_disjoint_bind(
                            control, candidate, alias=alias, reference_root=root,
                            reference_marker_sha256="a" * 64)
                    probe.assert_not_called()

    def test_selected_worktree_application_containers_and_shared_volumes_are_not_foreign(self):
        alias = WSL_ALIAS + "Ubuntu2/mongo/mongod.conf"
        identity = self._worktree_identity()
        project = identity["project_name"]
        control = self._probe_control(project=project, volume="worktree-control",
                                      identity=identity)
        backend = self._worktree_probe_backend(identity)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "state"
            root.mkdir()
            (root / overlap.OWNER_MARKER).write_bytes(b"accepted worktree owner marker")
            candidates = [
                self._foreign_probe_container(alias, project=project, service=service)
                for service in ("backend", "frontend")
            ]
            for volume in ("worktree-control", "worktree-ledger"):
                candidates.append(self._foreign_probe_container(
                    alias, project="fullmag-worktree-another-group", service="backend",
                    extra_mounts=[{"Type": "volume", "Name": volume,
                                   "Destination": "/foreign/protected"}]))
            for foreign in candidates:
                with self.subTest(foreign=foreign), \
                     patch.object(overlap, "bounded_capture") as probe, \
                     patch.object(overlap, "docker_capture") as inspect:
                    with self.assertRaises(BuildControlError):
                        overlap.prove_foreign_alias_disjoint(
                            control, backend, foreign, alias, root)
                    probe.assert_not_called()
                    inspect.assert_not_called()

    def test_worktree_foreign_reinspection_cannot_become_selected_application_container(self):
        alias = WSL_ALIAS + "Ubuntu2/mongo/mongod.conf"
        identity = self._worktree_identity()
        project = identity["project_name"]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "state"
            root.mkdir()
            _, result, foreign = self._wrapper_inputs(root, alias)
            foreign["Config"] = {"Labels": {
                "com.docker.compose.project": "fullmag-worktree-another-group",
                "com.docker.compose.service": "backend",
            }}
            changed = json.loads(json.dumps(foreign))
            changed["Config"]["Labels"]["com.docker.compose.project"] = project
            changed["Config"]["Labels"]["com.docker.compose.service"] = "frontend"
            control = self._probe_control(project=project, volume="worktree-control",
                                          identity=identity)
            backend = self._worktree_probe_backend(identity)
            with patch.object(overlap, "bounded_capture", return_value=subprocess.CompletedProcess(
                    [], 0, json.dumps(result).encode(), b"")) as probe, \
                 patch.object(overlap, "docker_capture", return_value=subprocess.CompletedProcess(
                    [], 0, json.dumps([changed]).encode(), b"")) as inspect:
                with self.assertRaisesRegex(BuildControlError, "selected application container"):
                    overlap.prove_foreign_alias_disjoint(
                        control, backend, foreign, alias, root)
            probe.assert_called_once()
            inspect.assert_called_once_with("inspect", foreign["Id"], timeout=60)

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


if __name__ == "__main__":
    unittest.main()
