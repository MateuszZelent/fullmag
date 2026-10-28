"""Interpreted rejection tests for the Windows/WSL adapter boundary."""
import copy
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import patch

import docker_windows_bind_identity as adapter
import docker_windows_bind_probe as kernel_probe
import test_docker_windows_bind_probe as kernel_fixtures
import test_windows_bind_identity as windows_path_fixtures
import test_windows_vhd_identity as vhd_fixtures
import windows_bind_identity as windows_path_identity
import windows_vhd_identity as vhd_identity


class WindowsSourceTests(unittest.TestCase):
    def test_drive_and_desktop_alias_forms_only_propose_one_native_path(self):
        for raw in (r'C:\git\task/src', '/run/desktop/mnt/host/c/git/task/src', '/host_mnt/c/git/task/src'):
            self.assertTrue(adapter.is_windows_bind_source(raw))
            self.assertEqual(adapter.canonical_windows_source(raw), r'C:\git\task\src')

    def test_opaque_wsl_alias_is_not_a_windows_drive(self):
        self.assertFalse(adapter.is_windows_bind_source('/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu2/abc'))
        with self.assertRaises(ValueError):
            adapter.canonical_windows_source('/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu2/abc')

    def test_unknown_and_traversal_forms_cannot_fall_back_to_lexical_posix(self):
        for raw in ('C:relative', 'C:/git/../storage', '/run/desktop/mnt/host/c/git/../storage',
                    '/run/desktop/mnt/host/c//git', '/host_mnt/network/data', '/mnt/c/git',
                    '//server/share', r'C:\git\a:stream', 'C:/git/foo,readonly'):
            with self.subTest(raw=raw):
                # Commas must be rejected before constructing a Docker mount.
                with self.assertRaises(ValueError):
                    adapter.canonical_windows_source(raw)

    def test_root_drive_remains_a_candidate_for_overlap_rejection(self):
        self.assertEqual(adapter.canonical_windows_source('/run/desktop/mnt/host/c'), 'C:\\')

    def test_duplicate_or_non_json_values_rejected(self):
        for raw in (b'{"a":1,"a":2}', b'{"a":NaN}', b''):
            with self.assertRaises(ValueError):
                adapter._parse(raw)


class ForeignIsolationTests(unittest.TestCase):
    def foreign(self):
        cid = 'a' * 64
        source = r'C:\git\task'
        container = {'Id': cid, 'Image': 'sha256:' + 'b' * 64,
                     'Config': {'User': '65532:65532', 'Labels': {}},
                     'State': {'Running': True, 'Status': 'running', 'Pid': 100,
                               'StartedAt': '2026-10-28T00:00:00Z'},
                     'Mounts': [{'Type': 'bind', 'Source': source, 'Destination': '/state',
                                 'RW': True, 'Propagation': 'rprivate'}],
                     'HostConfig': {'Mounts': [], 'Binds': [], 'Privileged': False,
                                    'PidMode': '', 'UsernsMode': '', 'CapAdd': None,
                                    'CapDrop': ['ALL'], 'ReadonlyRootfs': True,
                                    'SecurityOpt': ['no-new-privileges:true']}}
        return container, source

    def test_writable_foreign_data_mount_still_requires_full_proof(self):
        container, source = self.foreign()
        pin = adapter._foreign_pin(container, source)
        self.assertEqual(pin['destination'], '/state')
        self.assertTrue(pin['mounts'][0]['RW'])
        self.assertEqual(pin['uid'], 65532)

    def test_privilege_namespace_and_user_ambiguities_are_rejected(self):
        for path, value in ((('HostConfig', 'Privileged'), True),
                            (('HostConfig', 'CapAdd'), ['SYS_PTRACE']),
                            (('HostConfig', 'CapDrop'), []),
                            (('HostConfig', 'PidMode'), 'host'),
                            (('HostConfig', 'UsernsMode'), 'host'),
                            (('Config', 'User'), 'root'),
                            (('Config', 'User'), '0:0'),
                            (('State', 'Running'), False)):
            container, source = self.foreign()
            container[path[0]][path[1]] = value
            with self.subTest(path=path, value=value), self.assertRaises(ValueError):
                adapter._foreign_pin(container, source)

    def test_exact_source_and_unique_destination_are_required(self):
        container, source = self.foreign()
        container['Mounts'].append(copy.deepcopy(container['Mounts'][0]))
        with self.assertRaises(ValueError):
            adapter._foreign_pin(container, source)

    def test_isolation_drift_changes_incarnation_pin(self):
        container, source = self.foreign()
        first = adapter._foreign_pin(container, source)
        container['HostConfig']['Devices'] = [{'PathOnHost': '/dev/sda'}]
        with self.assertRaises(ValueError):
            adapter._foreign_pin(container, source)


def _complete_serialized_proof(directory, *, nested=False):
    source = r"C:\git\task"
    raw_foreign, _ = ForeignIsolationTests().foreign()
    request_template = (kernel_fixtures.NESTED_REQUEST if nested
                        else kernel_fixtures.REQUEST)
    destination = request_template["destination"]
    raw_foreign["Mounts"][0]["Destination"] = destination
    if nested:
        raw_foreign["Mounts"].append({
            "Type": "volume",
            "Source": kernel_fixtures.NESTED_SOURCE,
            "Destination": kernel_fixtures.NESTED_MOUNT["destination"],
            "RW": True,
            "Name": "fullmag_runtime_services",
            "Driver": "local",
            "Propagation": "rprivate",
        })
    foreign = adapter._foreign_pin(raw_foreign, source)
    nested_mounts = adapter._nested_mounts(foreign)

    wsl_disk_id = vhd_fixtures.VIRTUAL_DISK_ID
    docker_data_disk_id = uuid.UUID("145f0d67-58a0-4b28-8b03-22a3e0b37c19")
    disk_paths = {
        "wsl": directory / "wsl.vhdx",
        "docker_data": directory / "docker_data.vhdx",
    }
    vhd_fixtures._write_vhdx(disk_paths["wsl"], virtual_disk_id=wsl_disk_id)
    vhd_fixtures._write_vhdx(disk_paths["docker_data"], virtual_disk_id=docker_data_disk_id)
    disks = {name: vhd_identity.read_vhdx_virtual_disk_id(path)
             for name, path in disk_paths.items()}

    distro = "Ubuntu2"
    wsl_base = r"C:\WSL\Ubuntu2"
    docker_wsl_root = r"D:\DockerDesktop\wsl\data"
    wsl_path = wsl_base + r"\ext4.vhdx"
    docker_data_path = docker_wsl_root + r"\disk\docker_data.vhdx"
    configuration = {
        "distro": distro,
        "registrations": {
            distro: {"registry_key": "{11111111-1111-4111-8111-111111111111}",
                     "version": 2, "base": wsl_base, "vhd_name": "ext4.vhdx"},
            "docker-desktop": {"registry_key": "{22222222-2222-4222-8222-222222222222}",
                               "version": 2, "base": r"D:\DockerDesktop\wsl\distro",
                               "vhd_name": "ext4.vhdx"},
        },
        "docker_wsl_root": docker_wsl_root,
        "vhd_paths": {"wsl": wsl_path, "docker_data": docker_data_path},
        "settings_path": r"C:\Users\Mateusz\AppData\Roaming\Docker\settings-store.json",
        "settings_sha256": "8" * 64,
        "running_selected": sorted((distro, "docker-desktop")),
    }

    path_backend = windows_path_fixtures.FakeBackend()
    for directory_path in (source, wsl_path.rsplit("\\", 1)[0],
                            docker_data_path.rsplit("\\", 1)[0]):
        _mark_path_directories(path_backend, directory_path)
    path_requests = [
        {"label": "candidate", "path": source, "kind": "directory", "single_link": False},
        {"label": "wsl", "path": wsl_path, "kind": "file", "single_link": True},
        {"label": "docker_data", "path": docker_data_path, "kind": "file", "single_link": True},
    ]
    with windows_path_identity.pin_paths(path_requests, backend=path_backend) as pins:
        native_paths = adapter._validate_snapshot(pins.snapshot())
        pins.verify_unchanged()

    kernel = copy.deepcopy(kernel_fixtures._valid_nested_result() if nested
                           else kernel_fixtures._valid_result())
    observed = kernel["request"]
    observed.update({
        "container_id": foreign["id"],
        "pid": foreign["state"]["Pid"],
        "uid": foreign["uid"],
        "gid": foreign["gid"],
        "destination": foreign["destination"],
        "reference_device": 2049,
        "reference_inode": 100,
        "reference_marker_sha256": "b" * 64,
        "nested_mounts": nested_mounts,
    })
    for key, value in (("status_uid_before", foreign["uid"]),
                       ("status_uid_after", foreign["uid"]),
                       ("status_gid_before", foreign["gid"]),
                       ("status_gid_after", foreign["gid"])):
        kernel["process"][key] = [value] * 4
    kernel["process"]["cgroup_lines_before"] = [f"0::/../{foreign['id']}"]
    kernel["process"]["cgroup_lines_after"] = [f"0::/../{foreign['id']}"]
    kernel["mounts"]["target_destination"]["mountpoint"] = foreign["destination"]
    kernel["protected"]["reference"]["vpd83_hex"] = vhd_fixtures._msft_vpd83(wsl_disk_id).hex()
    for role in ("control", "ledger"):
        kernel["protected"][role]["vpd83_hex"] = vhd_fixtures._msft_vpd83(docker_data_disk_id).hex()
    kernel_probe.validate_probe_result(
        adapter._canonical(kernel), container_id=observed["container_id"], pid=observed["pid"],
        uid=observed["uid"], gid=observed["gid"], destination=observed["destination"],
        reference_device=observed["reference_device"], reference_inode=observed["reference_inode"],
        reference_marker_sha256=observed["reference_marker_sha256"], nested_mounts=nested_mounts)

    native_nested = {}
    if nested:
        volume_name = nested_mounts[0]["name"]
        native_nested[volume_name] = {
            "Name": volume_name,
            "Driver": "local",
            "Options": None,
            "Mountpoint": nested_mounts[0]["source"],
            "Scope": "local",
            "CreatedAt": "2026-10-28T00:00:00Z",
        }
    proof = {
        "schema": adapter.SCHEMA,
        "decision": "disjoint",
        "proof_scope": "existing-live-bind-and-enumerated-nested-volumes",
        "source": source,
        "container_id": foreign["id"],
        "image_id": foreign["image"],
        "started_at": foreign["state"]["StartedAt"],
        "pid": foreign["state"]["Pid"],
        "inspection_sha256": foreign["sha256"],
        "engine_id": "docker-desktop-engine",
        "reference_root": "/mnt/fullmag/state",
        "reference_identity": {"device": 2049, "inode": 100},
        "reference_marker_sha256": "b" * 64,
        "reference_certificate_sha256": "c" * 64,
        "control_volume": "fullmag_control_v1",
        "ledger_volume": "fullmag_ledger_v1",
        "native": {
            "configuration": configuration,
            "paths": native_paths,
            "disks": disks,
            "endpoint": "npipe:////./pipe/dockerDesktopLinuxEngine",
            "nested_volumes": native_nested,
        },
        "kernel": kernel,
        "foreign_inspection": foreign,
    }
    return _parse_serialized(proof)


def _parse_serialized(value):
    return adapter._parse(adapter._canonical(value))


def _validate_complete_proof(proof, **overrides):
    expected = {
        "source": proof["source"],
        "container_id": proof["container_id"],
        "reference_root": proof["reference_root"],
        "control_volume": proof["control_volume"],
        "ledger_volume": proof["ledger_volume"],
        "engine_id": proof["engine_id"],
    }
    expected.update(overrides)
    return adapter._validate_foreign_windows_bind_disjoint_proof(
        _parse_serialized(proof), **expected)


def _refresh_foreign_pin(proof):
    foreign = proof["foreign_inspection"]
    foreign["sha256"] = adapter._digest(adapter._canonical(
        {key: value for key, value in foreign.items() if key != "sha256"}))
    proof["inspection_sha256"] = foreign["sha256"]


def _replacement_candidate_pin(path):
    backend = windows_path_fixtures.FakeBackend()
    _mark_path_directories(backend, path)
    request = {"label": "candidate", "path": path, "kind": "directory", "single_link": False}
    with windows_path_identity.pin_paths([request], backend=backend) as pins:
        result = pins.snapshot()["candidate"]
        pins.verify_unchanged()
        return result


def _mark_path_directories(backend, path):
    drive = path[:2]
    current = drive + "\\"
    for component in path[3:].split("\\"):
        current = current.rstrip("\\") + "\\" + component
        backend.overrides[current] = {
            "attributes": windows_path_identity.FILE_ATTRIBUTE_DIRECTORY,
            "is_directory": True,
        }


class CompleteSerializedProofTests(unittest.TestCase):
    def _proof(self, directory, *, nested=False):
        return _complete_serialized_proof(Path(directory), nested=nested)

    def test_correlated_native_and_kernel_ids_never_authorize_recovery(self):
        with tempfile.TemporaryDirectory() as directory:
            proof = self._proof(directory)
            # The complete metadata record can be coherent for a detached
            # clone. Public validation requires active attachment evidence.
            with self.assertRaisesRegex(ValueError, "Active VM backing-file"):
                adapter.validate_foreign_windows_bind_disjoint_proof(
                    proof, source=proof["source"], container_id=proof["container_id"],
                    reference_root=proof["reference_root"], control_volume=proof["control_volume"],
                    ledger_volume=proof["ledger_volume"], engine_id=proof["engine_id"])
            from docker_build_control import BuildControlError
            with patch.object(adapter, "_capture", side_effect=AssertionError("must not launch a helper")):
                with self.assertRaisesRegex(BuildControlError, "Active VM backing-file"):
                    adapter.prove_foreign_windows_bind_disjoint(None, None, None, None, None)

    def test_complete_serialized_proof_without_nested_volume_passes_real_validators(self):
        with tempfile.TemporaryDirectory() as directory:
            proof = self._proof(directory)
            self.assertEqual(_validate_complete_proof(proof), proof)

    def test_complete_serialized_proof_with_named_runtime_services_volume_passes(self):
        with tempfile.TemporaryDirectory() as directory:
            proof = self._proof(directory, nested=True)
            self.assertEqual(_validate_complete_proof(proof), proof)

    def test_resource_candidate_and_native_backing_mappings_are_bound(self):
        with tempfile.TemporaryDirectory() as directory:
            base = self._proof(directory)
            with self.assertRaises(ValueError):
                _validate_complete_proof(base, reference_root="/mnt/other/state")
            changed = copy.deepcopy(base)
            changed["reference_identity"]["inode"] += 1
            with self.assertRaises(ValueError):
                _validate_complete_proof(changed)

            changed = copy.deepcopy(base)
            changed["native"]["paths"]["candidate"] = _replacement_candidate_pin(
                r"C:\other\task")
            with self.assertRaises(ValueError):
                _validate_complete_proof(changed)

            changed = copy.deepcopy(base)
            changed["native"]["configuration"]["vhd_paths"]["wsl"] = r"C:\wrong\ext4.vhdx"
            with self.assertRaises(ValueError):
                _validate_complete_proof(changed)
            changed = copy.deepcopy(base)
            changed["native"]["configuration"]["docker_wsl_root"] = r"E:\wrong\data"
            with self.assertRaises(ValueError):
                _validate_complete_proof(changed)

    def test_foreign_uid_destination_image_start_and_pid_must_match_the_proof(self):
        with tempfile.TemporaryDirectory() as directory:
            base = self._proof(directory)
            mutators = (
                lambda p: p["foreign_inspection"].update(uid=70001),
                lambda p: (p["foreign_inspection"].update(destination="/other/state"),
                           p["foreign_inspection"]["mounts"][0].update(Destination="/other/state")),
                lambda p: p["foreign_inspection"].update(image="sha256:" + "d" * 64),
                lambda p: p["foreign_inspection"]["state"].update(StartedAt="2026-10-29T00:00:00Z"),
                lambda p: p["foreign_inspection"]["state"].update(Pid=101),
            )
            for mutate in mutators:
                changed = copy.deepcopy(base)
                mutate(changed)
                _refresh_foreign_pin(changed)
                with self.subTest(foreign=changed["foreign_inspection"]), self.assertRaises(ValueError):
                    _validate_complete_proof(changed)

    def test_foreign_target_access_mode_must_match_full_inspection(self):
        with tempfile.TemporaryDirectory() as directory:
            base = self._proof(directory)
            changed = copy.deepcopy(base)
            changed["kernel"]["mounts"]["target_destination"]["options"] = "ro,relatime"
            with self.assertRaises(ValueError):
                _validate_complete_proof(changed)
            changed = copy.deepcopy(base)
            changed["foreign_inspection"]["mounts"][0]["RW"] = False
            _refresh_foreign_pin(changed)
            with self.assertRaises(ValueError):
                _validate_complete_proof(changed)

    def test_nested_omission_extra_protected_volume_and_device_drift_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            base = self._proof(directory, nested=True)
            changed = copy.deepcopy(base)
            changed["native"]["nested_volumes"] = {}
            with self.assertRaises(ValueError):
                _validate_complete_proof(changed)
            changed = copy.deepcopy(base)
            changed["native"]["nested_volumes"]["unexpected_extra"] = copy.deepcopy(
                next(iter(changed["native"]["nested_volumes"].values())))
            with self.assertRaises(ValueError):
                _validate_complete_proof(changed)
            changed = copy.deepcopy(base)
            changed["kernel"]["request"]["nested_mounts"] = []
            with self.assertRaises(ValueError):
                _validate_complete_proof(changed)
            changed = copy.deepcopy(base)
            item = changed["foreign_inspection"]["mounts"][1]
            old_name = item["Name"]
            item["Name"] = changed["control_volume"]
            _refresh_foreign_pin(changed)
            nested = adapter._nested_mounts(changed["foreign_inspection"])
            changed["kernel"]["request"]["nested_mounts"] = nested
            changed["kernel"]["nested_evidence"][0]["mount"] = copy.deepcopy(nested[0])
            record = changed["native"]["nested_volumes"].pop(old_name)
            record["Name"] = changed["control_volume"]
            changed["native"]["nested_volumes"][changed["control_volume"]] = record
            with self.assertRaises(ValueError):
                _validate_complete_proof(changed)

            changed = copy.deepcopy(base)
            changed["kernel"]["nested_evidence"][0]["actual_stat_before"]["device"] += 1
            with self.assertRaises(ValueError):
                _validate_complete_proof(changed)

    def test_vhd_guid_hash_schema_and_file_growth_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            base = self._proof(directory)
            grown = copy.deepcopy(base)
            grown["native"]["disks"]["wsl"]["file_size_at_open"] += 64 * 1024
            self.assertEqual(set(adapter._stable_disk_record(grown["native"]["disks"]["wsl"])),
                             set(base["native"]["disks"]["wsl"]) - {"file_size_at_open"})
            self.assertEqual(adapter._stable_disk_record(grown["native"]["disks"]["wsl"]),
                             adapter._stable_disk_record(base["native"]["disks"]["wsl"]))
            self.assertEqual(_validate_complete_proof(grown), grown)

            changed = copy.deepcopy(base)
            changed["native"]["disks"]["wsl"]["virtual_disk_id"] = str(
                uuid.UUID("af3f55e4-7d94-437c-9f0e-3180d7399f53"))
            with self.assertRaises(ValueError):
                _validate_complete_proof(changed)
            changed = copy.deepcopy(base)
            changed["native"]["disks"]["wsl"]["metadata_sha256"][0]["sha256"] = "0" * 64
            with self.assertRaises(ValueError):
                _validate_complete_proof(changed)
            changed = copy.deepcopy(base)
            del changed["native"]["disks"]["wsl"]["metadata_sha256"]
            with self.assertRaises(ValueError):
                _validate_complete_proof(changed)
            changed = copy.deepcopy(base)
            changed["native"]["disks"]["wsl"]["unrecognized"] = True
            with self.assertRaises(ValueError):
                _validate_complete_proof(changed)
            changed = copy.deepcopy(base)
            changed["proof_scope"] = "candidate-only"
            with self.assertRaises(ValueError):
                _validate_complete_proof(changed)


class ProofBoundaryTests(unittest.TestCase):
    def test_truthy_or_wrong_schema_proofs_never_authorize_skipping_a_bind(self):
        for proof in (True, {'decision': 'disjoint'}, {'schema': adapter.SCHEMA, 'decision': 'disjoint'}):
            with self.assertRaises(ValueError):
                adapter.validate_foreign_windows_bind_disjoint_proof(proof, source='C:/git',
                    container_id='a' * 64, reference_root='/data/state', control_volume='control',
                    ledger_volume='ledger', engine_id='engine')

    def test_native_worker_is_not_available_on_linux(self):
        with patch.object(adapter.os, 'name', 'posix'):
            with self.assertRaises(ValueError):
                adapter._native_worker({})


if __name__ == '__main__':
    unittest.main()
