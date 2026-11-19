"""Source/contract checks for the per-group DEV ledger (ADR 0067 point 1)."""
import copy
import hashlib
import importlib.util
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from bootstrap_docker_toolchain import control_volume_name
import docker_group_ledger as group_ledger

DAEMON = "d" * 64
PROJECT = "fullmag-worktree-alpha-0123456789abcdef"


def load_service():
    path = Path(__file__).resolve().parents[1] / "docker/all-in-one/runtime_service.py"
    spec = importlib.util.spec_from_file_location("group_ledger_runtime_service_test", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def inspect_document(profile, **overrides):
    environment = {**profile["environment"], "FULLMAG_DOCKER_DEVICE_ACCESS": "gpu"}
    document = {
        "Id": "c" * 64, "Image": profile["image_id"],
        "Config": {"User": "65532:65532", "Env": [k + "=" + v for k, v in environment.items()],
                   "Labels": {"com.docker.compose.project": PROJECT,
                              "com.docker.compose.service": "backend"}},
        "HostConfig": {"Privileged": False},
        "Mounts": [{"Type": "volume", "Name": profile["volume_name"], "Driver": "local",
                    "Destination": "/host-ledger", "RW": True}],
    }
    document.update(overrides)
    return document


class GroupLedgerIdentityTest(unittest.TestCase):
    def test_host_id_is_stable_and_private_to_one_group(self):
        first = group_ledger.host_id(DAEMON, PROJECT)
        self.assertEqual(first, group_ledger.host_id(DAEMON, PROJECT))
        self.assertNotEqual(first, group_ledger.host_id(DAEMON, PROJECT + "-b"))
        self.assertNotEqual(first, group_ledger.host_id("e" * 64, PROJECT))
        self.assertNotEqual(first, DAEMON)
        self.assertRegex(first, r"^[0-9a-f]{64}$")

    def test_identity_rejects_unverified_daemon_and_project(self):
        for daemon, project in (("D" * 64, PROJECT), ("d" * 63, PROJECT), (DAEMON, "Bad/Project")):
            with self.assertRaises(group_ledger.GroupLedgerError):
                group_ledger.host_id(daemon, project)

    def test_profile_keeps_daemon_identity_and_never_binds_global_fields(self):
        volume = group_ledger.VOLUME_PREFIX + "0" * 24
        profile = group_ledger.profile(DAEMON, PROJECT, volume, "sha256:" + "1" * 64)
        environment = profile["environment"]
        self.assertEqual(environment["FULLMAG_DOCKER_HOST_ID"], DAEMON)
        self.assertEqual(environment["FULLMAG_HOST_LEDGER_PROFILE"], "group-ledger-v1")
        self.assertEqual(environment["FULLMAG_HOST_LEDGER_ROOT"], "/host-ledger/ledger")
        self.assertEqual(environment[group_ledger.HOST_ID_ENV], group_ledger.host_id(DAEMON, PROJECT))
        self.assertFalse(group_ledger.GLOBAL_ONLY_ENVIRONMENT & set(environment))
        self.assertEqual(profile["backend"]["volumes"], [{
            "type": "volume", "source": "group-ledger", "target": "/host-ledger",
            "volume": {"nocopy": True}}])
        with self.assertRaises(group_ledger.GroupLedgerError):
            group_ledger.profile(DAEMON, PROJECT, "fullmag-dev-frontend-v1-x", "sha256:" + "1" * 64)

    def test_private_group_profile_uses_one_canonical_volume_and_ledger_subpath(self):
        volume = control_volume_name(PROJECT)
        current = group_ledger.profile(
            DAEMON, PROJECT, volume, "sha256:" + "1" * 64, ledger_subpath="private/ledger")
        other_generation = group_ledger.profile(
            "e" * 64, PROJECT, volume, "sha256:" + "2" * 64,
            ledger_subpath="private/ledger")
        self.assertEqual(current["volume_name"], volume)
        self.assertEqual(other_generation["volume_name"], volume)
        self.assertEqual(current["ledger_subpath"], "private/ledger")
        self.assertEqual(current["environment"]["FULLMAG_PRIVATE_GROUP_STORAGE"], "group-volume-v1")
        self.assertEqual(current["environment"]["FULLMAG_HOST_LEDGER_PROFILE"], "group-ledger-v1")
        self.assertEqual(current["backend"]["volumes"], [{
            "type": "volume", "source": "group-ledger", "target": "/host-ledger",
            "volume": {"nocopy": True, "subpath": "private/ledger"},
        }])
        self.assertEqual(current["compose_volume"], {"name": volume, "external": True})

    def test_private_group_profile_rejects_wrong_volume_and_unsafe_role_paths(self):
        image = "sha256:" + "1" * 64
        for volume, subpath in (
            ("fullmag-dev-group-ledger-v1-" + "0" * 24, "private/ledger"),
            (control_volume_name(PROJECT + "-other"), "private/ledger"),
            (control_volume_name(PROJECT), ""),
            (control_volume_name(PROJECT), "/"),
            (control_volume_name(PROJECT), "private/../backend"),
            (control_volume_name(PROJECT), "private/backend"),
            (control_volume_name(PROJECT), "namespaces/" + "a" * 32 + "/private/ledger/../backend"),
        ):
            with self.subTest(volume=volume, subpath=subpath), self.assertRaises(group_ledger.GroupLedgerError):
                group_ledger.profile(DAEMON, PROJECT, volume, image, ledger_subpath=subpath)

    def test_private_namespace_subpath_is_retained_exactly(self):
        volume = control_volume_name(PROJECT)
        subpath = "namespaces/" + "a" * 32 + "/private/ledger"
        profile = group_ledger.profile(
            DAEMON, PROJECT, volume, "sha256:" + "1" * 64, ledger_subpath=subpath)
        document = {
            "name": PROJECT,
            "services": {"backend": {"environment": dict(profile["environment"]),
                                     "volumes": profile["backend"]["volumes"]}},
            "volumes": {"group-ledger": {"name": volume, "external": True}},
        }
        self.assertEqual(group_ledger.retained_profile(document, profile["image_id"]), profile)
        document["services"]["backend"]["volumes"][0]["volume"]["subpath"] = "private/ledger"
        moved = group_ledger.retained_profile(document, profile["image_id"])
        self.assertEqual(moved["ledger_subpath"], "private/ledger")
        self.assertNotEqual(moved, profile)

    def test_retained_profile_requires_the_projects_own_identity(self):
        volume = group_ledger.VOLUME_PREFIX + "0" * 24
        profile = group_ledger.profile(DAEMON, PROJECT, volume, "sha256:" + "1" * 64)
        document = {"name": PROJECT,
                    "services": {"backend": {"environment": dict(profile["environment"]),
                                               "volumes": profile["backend"]["volumes"]}},
                    "volumes": {"group-ledger": {"name": volume, "external": True}}}
        self.assertEqual(group_ledger.retained_profile(document, profile["image_id"]), profile)
        moved = copy.deepcopy(document)
        moved["name"] = PROJECT + "-other"
        with self.assertRaisesRegex(group_ledger.GroupLedgerError, "project identity"):
            group_ledger.retained_profile(moved, profile["image_id"])


class GroupLedgerContainerTest(unittest.TestCase):
    def setUp(self):
        self.profile = group_ledger.profile(
            DAEMON, PROJECT, group_ledger.VOLUME_PREFIX + "0" * 24, "sha256:" + "1" * 64)
        self.calls = []

    def docker_text(self, *args, **_kwargs):
        self.calls.append(args)
        if args[:2] == ("volume", "inspect"):
            name = args[2]
            return json.dumps([{
                "Name": name, "Driver": "local", "Options": None,
                "Mountpoint": f"/var/lib/docker/volumes/{name}/_data",
                "Labels": {"com.fullmag.compose.project": PROJECT,
                           "com.fullmag.toolchain.control.schema": "fullmag.docker-toolchain-control.v1",
                           "com.fullmag.toolchain.control.mount": "/opt/fullmag/control",
                           "com.fullmag.toolchain.control.project": PROJECT},
            }])
        return ""

    def test_attests_own_writable_volume(self):
        attestation = group_ledger.validate_container(
            inspect_document(self.profile), self.profile, self.docker_text)
        self.assertEqual(attestation["schema"], group_ledger.ATTESTATION_SCHEMA)
        self.assertEqual(attestation["volume_name"], self.profile["volume_name"])
        self.assertEqual(self.calls[0][:2], ("exec", "c" * 64))

    def test_rejects_foreign_volume_bind_global_field_and_privilege(self):
        foreign = inspect_document(self.profile)
        foreign["Mounts"][0]["Name"] = group_ledger.VOLUME_PREFIX + "1" * 24
        bind = inspect_document(self.profile)
        bind["Mounts"][0] = {"Type": "bind", "Source": "/mnt/fullmag-host-ledger-x",
                             "Destination": "/host-ledger", "RW": True}
        leaked = inspect_document(self.profile)
        leaked["Config"]["Env"].append("FULLMAG_HOST_LEDGER_MOUNT_ROOT=/mnt/fullmag-host-ledger-x")
        privileged = inspect_document(self.profile, HostConfig={"Privileged": True})
        for document in (foreign, bind, leaked, privileged):
            with self.assertRaises(group_ledger.GroupLedgerError):
                group_ledger.validate_container(document, self.profile, self.docker_text)
        self.assertEqual(self.calls, [])

    def test_global_consumer_classification(self):
        self.assertTrue(group_ledger.is_group_ledger_mount(inspect_document(self.profile)["Mounts"][0]))
        control_volume = control_volume_name(PROJECT)
        self.assertTrue(group_ledger.is_group_ledger_mount({
            "Type": "volume", "Name": control_volume, "Destination": "/host-ledger",
        }))
        self.assertFalse(group_ledger.is_group_ledger_mount({
            "Type": "volume", "Name": "fullmag-build-control-not-canonical",
            "Destination": "/host-ledger",
        }))
        self.assertFalse(group_ledger.is_group_ledger_mount(
            {"Type": "bind", "Source": "/mnt/fullmag-host-ledger-p", "Destination": "/host-ledger"}))
        self.assertFalse(group_ledger.is_group_ledger_mount(
            {"Type": "volume", "Name": "fullmag-host-ledger-v1-p", "Destination": "/host-ledger"}))

    def test_private_group_container_attestation_requires_exact_subpath(self):
        private = group_ledger.profile(
            DAEMON, PROJECT, control_volume_name(PROJECT), "sha256:" + "1" * 64,
            ledger_subpath="private/ledger")
        document = inspect_document(private)
        document["HostConfig"]["Mounts"] = [{
            "Type": "volume", "Source": private["volume_name"], "Target": "/host-ledger",
            "VolumeOptions": {"NoCopy": True, "Subpath": "private/ledger"},
        }]
        attestation = group_ledger.validate_container(document, private, self.docker_text)
        self.assertEqual(attestation["ledger_subpath"], "private/ledger")
        self.assertEqual(self.calls[0][:2], ("exec", "c" * 64))

        wrong = copy.deepcopy(document)
        wrong["HostConfig"]["Mounts"][0]["VolumeOptions"]["Subpath"] = "private/backend"
        with self.assertRaises(group_ledger.GroupLedgerError):
            group_ledger.validate_container(wrong, private, self.docker_text)

        unknown = copy.deepcopy(document)
        unknown["HostConfig"]["Mounts"][0]["VolumeOptions"].pop("Subpath")
        unknown["Mounts"][0].pop("Source", None)
        with self.assertRaises(group_ledger.GroupLedgerError):
            group_ledger.validate_container(unknown, private, self.docker_text)

    def test_private_group_container_can_prove_subpath_from_validated_mountpoint(self):
        private = group_ledger.profile(
            DAEMON, PROJECT, control_volume_name(PROJECT), "sha256:" + "1" * 64,
            ledger_subpath="private/ledger")
        document = inspect_document(private)
        document["HostConfig"]["Mounts"] = [{
            "Type": "volume", "Source": private["volume_name"], "Target": "/host-ledger",
            "VolumeOptions": {"NoCopy": True},
        }]
        mountpoint = f"/var/lib/docker/volumes/{private['volume_name']}/_data"
        document["Mounts"][0]["Source"] = mountpoint + "/private/ledger"
        attestation = group_ledger.validate_container(document, private, self.docker_text)
        self.assertEqual(attestation["ledger_subpath"], "private/ledger")
        self.assertEqual(self.calls[0], ("volume", "inspect", private["volume_name"]))
        self.assertEqual(self.calls[1][:2], ("exec", "c" * 64))


class LedgerProfileSelectionTest(unittest.TestCase):
    class Control:
        def __init__(self, records=None):
            self.records = records or {}

        def read(self, relative, optional=False):
            return self.records.get(relative)

    def select(self, receipt, *, new_render, records=None):
        import docker_volume_dev as dev
        return dev._uses_group_ledger(self.Control(records), {"receipt": receipt, "root": "r"},
                                      new_render=new_render)

    def test_new_render_and_unpinned_fresh_operation_use_group_ledger(self):
        self.assertTrue(self.select({}, new_render=True))
        self.assertTrue(self.select({"ledger_profile": "host-ledger-v1"}, new_render=True))
        self.assertTrue(self.select({}, new_render=False))

    def test_supplied_operation_keeps_its_pinned_or_rendered_global_ledger(self):
        self.assertFalse(self.select({"ledger_profile": "host-ledger-v1"}, new_render=False))
        self.assertTrue(self.select({"ledger_profile": "group-ledger-v1"}, new_render=False))
        self.assertFalse(self.select({"host_capacity_scope": "docker_vm_root"}, new_render=False))
        self.assertFalse(self.select({}, new_render=False,
                                     records={"r/ledger-maintenance-compose.json": {}}))

    def test_unknown_pin_is_rejected(self):
        import docker_volume_dev as dev
        with self.assertRaises(dev.BuildControlError):
            self.select({"ledger_profile": "other"}, new_render=False)


class GlobalMigrationQuiescenceTest(unittest.TestCase):
    def run_check(self, records):
        import docker_volume_dev as dev

        class Result:
            def __init__(self, stdout):
                self.returncode, self.stdout = 0, stdout

        identifiers = [record["Id"] for record in records]

        def capture(argv, **_kwargs):
            if "ps" in argv:
                return Result("\n".join(identifiers).encode("ascii"))
            return Result(json.dumps(records).encode("utf-8"))

        with patch.object(dev, "bounded_capture", side_effect=capture), \
                patch.object(dev, "docker_argv", side_effect=lambda *args: list(args)):
            dev._assert_host_capacity_migration_quiescent()

    def test_running_group_ledger_backend_does_not_block_global_migration(self):
        group = {"Id": "a" * 64, "Name": "/group-backend", "State": {"Running": True},
                 "Mounts": [{"Type": "volume", "Name": group_ledger.VOLUME_PREFIX + "0" * 24,
                             "Destination": "/host-ledger"}]}
        self.run_check([group])

    def test_running_global_consumer_still_blocks(self):
        import docker_volume_dev as dev
        global_consumer = {"Id": "b" * 64, "Name": "/release-backend", "State": {"Running": True},
                           "Mounts": [{"Type": "bind", "Source": "/mnt/fullmag-host-ledger-p",
                                       "Destination": "/host-ledger"}]}
        with self.assertRaisesRegex(dev.BuildControlError, "coordinated stop"):
            self.run_check([global_consumer])


class RuntimeServiceGroupLedgerTest(unittest.TestCase):
    def setUp(self):
        self.service = load_service()
        self.group_host_id = group_ledger.host_id(DAEMON, PROJECT)
        self.environment = {"FULLMAG_DOCKER_HOST_ID": DAEMON,
                            "FULLMAG_HOST_LEDGER_PROFILE": "group-ledger-v1",
                            "FULLMAG_GROUP_LEDGER_HOST_ID": self.group_host_id}

    def test_group_profile_returns_group_host_id(self):
        with patch.dict(os.environ, self.environment, clear=True):
            self.assertEqual(self.service._validated_docker_host_id(), self.group_host_id)
        with patch.dict(os.environ, {**self.environment,
                                     "FULLMAG_HOST_LEDGER_PROFILE": "host-ledger-v1"}, clear=True):
            self.assertEqual(self.service._validated_docker_host_id(), DAEMON)

    def test_group_profile_rejects_capacity_and_reused_daemon_id(self):
        for extra in ({"FULLMAG_DOCKER_HOST_CAPACITY_SHA256": "a" * 64},
                      {"FULLMAG_GROUP_LEDGER_HOST_ID": DAEMON},
                      {"FULLMAG_GROUP_LEDGER_HOST_ID": "X" * 64}):
            with patch.dict(os.environ, {**self.environment, **extra}, clear=True):
                with self.assertRaises(self.service.RuntimeServiceError):
                    self.service._validated_docker_host_id()

    def configs(self):
        cpu = {"resource_id": "docker-all.compute.cpu", "kind": "cpu",
               "budget": {"cpu_millis": 3000, "memory_bytes": 6, "gpu_memory_bytes": 0,
                          "storage_bytes": 1}}
        preparation = {"resource_id": "docker-all.preparation.cpu",
                       "budget": {"cpu_millis": 1000, "memory_bytes": 1, "gpu_memory_bytes": 0,
                                  "storage_bytes": 1}}
        current = {
            "schema_version": "runtime_service_config.v2", "store_root": "/state/x",
            "compute_resources": [cpu], "preparation_resources": [preparation],
            "host_execution": {
                "schema_version": "runtime_service_host_execution.v1",
                "ledger_root": "/host-ledger/ledger", "runtime_generation_sha256": "1" * 64,
                "compute_max_concurrency": 1, "preparation_max_concurrency": 1,
                "policy": {"host_id": DAEMON, "total_budget": {"cpu_millis": 16000}},
                "compute_placements": {"docker-all.compute.cpu": {"cpu_ids": [0, 1, 2],
                                                                  "gpu_uuid": None}},
                "preparation_cpu_ids": {"docker-all.preparation.cpu": [3]},
            },
        }
        expected = copy.deepcopy(current)
        expected["host_execution"]["runtime_generation_sha256"] = "2" * 64
        expected["host_execution"]["policy"] = {"host_id": self.group_host_id,
                                                "total_budget": {"cpu_millis": 4000}}
        expected["host_execution"]["compute_placements"]["docker-all.compute.cpu"]["cpu_ids"] = [4, 5, 6]
        expected["compute_resources"][0]["budget"]["cpu_millis"] = 2000
        return current, expected

    def test_one_way_transition_from_global_ledger(self):
        current, expected = self.configs()
        allowed = self.service._group_ledger_transition_allowed
        with patch.dict(os.environ, self.environment, clear=True):
            self.assertTrue(allowed(current, expected))
            # Already bound to this group: a later policy change is not a transition.
            self.assertFalse(allowed(expected, copy.deepcopy(expected)))
            legacy = copy.deepcopy(current)
            legacy["host_execution"]["policy"]["host_id"] = "docker-all-host"
            self.assertTrue(allowed(legacy, expected))
            # A configuration bound to another group never re-binds here.
            foreign = copy.deepcopy(current)
            foreign["host_execution"]["policy"]["host_id"] = group_ledger.host_id("e" * 64, PROJECT)
            self.assertFalse(allowed(foreign, expected))
            moved = copy.deepcopy(expected)
            moved["host_execution"]["ledger_root"] = "/state/shared-ledger"
            self.assertFalse(allowed(current, moved))
            regrouped = copy.deepcopy(expected)
            regrouped["host_execution"]["compute_max_concurrency"] = 2
            self.assertFalse(allowed(current, regrouped))
            storage = copy.deepcopy(expected)
            storage["compute_resources"][0]["budget"]["storage_bytes"] = 2
            self.assertFalse(allowed(current, storage))
        with patch.dict(os.environ, {**self.environment,
                                     "FULLMAG_HOST_LEDGER_PROFILE": "host-ledger-v1"}, clear=True):
            self.assertFalse(allowed(current, expected))

    @unittest.skipIf(os.name == "nt", "directory fsync is part of the Linux runtime contract")
    def test_rotation_publishes_transition_and_keeps_previous_bytes(self):
        import tempfile
        from dataclasses import replace
        current, expected = self.configs()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = replace(self.service.RuntimePaths(), config=root / "docker-all.json")
            self.service._atomic_json(paths.config, current, "fixture")
            raw = paths.config.read_bytes()
            previous = hashlib.sha256(raw).hexdigest()
            with patch.dict(os.environ, self.environment, clear=True):
                self.service._rotate_configuration_generation(paths, current, expected, previous)
            self.assertEqual(json.loads(paths.config.read_text()), expected)
            self.assertEqual((root / f"docker-all.previous-{previous}.json").read_bytes(), raw)
            with patch.dict(os.environ, {**self.environment,
                                         "FULLMAG_HOST_LEDGER_PROFILE": "host-ledger-v1"}, clear=True):
                self.service._atomic_json(paths.config, current, "fixture")
                with self.assertRaisesRegex(self.service.RuntimeServiceError, "operator profile"):
                    self.service._rotate_configuration_generation(paths, current, expected, previous)


if __name__ == "__main__":
    unittest.main()
