import copy
import unittest

from scripts import fullmag_data_volume as data_volume


MOUNT_ROOT = "/mnt/fullmag-sp4-data"
FILESYSTEM_UUID = "123e4567-e89b-12d3-a456-426614174000"


def registration_fixture():
    return {
        "schema": "fullmag.user-data-volume.v1",
        "project_id": "fullmag-0123456789abcdef",
        "worktree_id": "sp4-compare_20261112",
        "compose_project": "fullmag-worktree-sp4-compare_20261112",
        "volume_id": "a" * 32,
        "backing_file_windows": r"E:\git\storage\fullmag-sp4-data.vhdx",
        "backing_file_wsl": "/mnt/e/git/storage/fullmag-sp4-data.vhdx",
        "filesystem_uuid": FILESYSTEM_UUID,
        "mount_root": MOUNT_ROOT,
        "datasets": [
            {
                "role": "user_data",
                "canonical_root": "/srv/fullmag/storage/user-data/fixture",
                "relative_root": "payload/user-data",
            },
            {
                "role": "state",
                "canonical_root": "/srv/fullmag/storage/runtimes/fixture/attempt",
                "relative_root": "payload/state-root",
            },
        ],
        "migration_receipt_sha256": "b" * 64,
        "state": "committed",
    }


def mount_observations(registration=None):
    registration = registration or registration_fixture()
    device = 259
    volume_inode = 9001
    volume = {
        "target": registration["mount_root"],
        "filesystem": "ext4",
        "filesystem_uuid": registration["filesystem_uuid"],
        "device": device,
        "inode": volume_inode,
    }
    datasets = []
    for index, dataset in enumerate(registration["datasets"], start=1):
        inode = 1000 + index
        datasets.append(
            {
                "canonical_root": dataset["canonical_root"],
                "volume_root": (
                    registration["mount_root"] + "/" + dataset["relative_root"]
                ),
                "filesystem": "ext4",
                "filesystem_uuid": registration["filesystem_uuid"],
                "canonical_device": device,
                "canonical_inode": inode,
                "volume_device": device,
                "volume_inode": inode,
            }
        )
    return {"volume": volume, "user_data": datasets[0], "state": datasets[1]}


class RegistrationValidationTests(unittest.TestCase):
    def test_valid_registration_is_an_unchanged_independent_copy(self):
        value = registration_fixture()
        before = copy.deepcopy(value)

        result = data_volume.validate_registration(value)

        self.assertEqual(result, before)
        self.assertEqual(value, before)
        self.assertIsNot(result, value)
        self.assertIsNot(result["datasets"], value["datasets"])
        self.assertIsNot(result["datasets"][0], value["datasets"][0])

    def test_registration_rejects_non_object_and_open_top_level_shapes(self):
        for value in (None, [], "registration"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                data_volume.validate_registration(value)

        unknown = registration_fixture()
        unknown["unexpected"] = "value"
        with self.assertRaises(ValueError):
            data_volume.validate_registration(unknown)

        missing = registration_fixture()
        del missing["migration_receipt_sha256"]
        with self.assertRaises(ValueError):
            data_volume.validate_registration(missing)

    def test_registration_rejects_invalid_schema_state_and_identities(self):
        mutations = (
            ("schema", "fullmag.user-data-volume.v2"),
            ("state", "prepared"),
            ("project_id", "fullmag-0123456789ABCDEf"),
            ("worktree_id", "UPPERCASE"),
            ("compose_project", "fullmag-worktree-other"),
            ("volume_id", "0" * 32),
            ("migration_receipt_sha256", "B" * 64),
            ("filesystem_uuid", "00000000-0000-0000-0000-000000000000"),
            ("filesystem_uuid", "123E4567-E89B-12D3-A456-426614174000"),
        )
        for key, replacement in mutations:
            value = registration_fixture()
            value[key] = replacement
            with self.subTest(key=key, replacement=replacement), self.assertRaises(
                ValueError
            ):
                data_volume.validate_registration(value)

        bad_worktree = registration_fixture()
        bad_worktree["worktree_id"] = "x" * 129
        with self.assertRaises(ValueError):
            data_volume.validate_registration(bad_worktree)

    def test_registration_accepts_non_e_local_drive_with_exact_wsl_mapping(self):
        value = registration_fixture()
        value["backing_file_windows"] = r"D:\archive\sp4.vhdx"
        value["backing_file_wsl"] = "/mnt/d/archive/sp4.vhdx"

        self.assertEqual(data_volume.validate_registration(value), value)

    def test_registration_rejects_unc_traversal_bad_components_and_mapping_drift(self):
        mutations = (
            ("backing_file_windows", r"\\server\share\image.vhdx"),
            ("backing_file_windows", r"E:\git\..\image.vhdx"),
            ("backing_file_windows", r"E:\git\CON.vhdx"),
            ("backing_file_windows", r"E:\git\bad.\image.vhdx"),
            ("backing_file_windows", "E:/git/storage/image.vhdx"),
            ("backing_file_windows", r"E:\git\storage\image.img"),
            ("backing_file_wsl", "/mnt/f/git/storage/fullmag-sp4-data.vhdx"),
            ("backing_file_wsl", "/mnt/e/git/../storage/fullmag-sp4-data.vhdx"),
            ("backing_file_wsl", r"\mnt\e\git\storage\fullmag-sp4-data.vhdx"),
        )
        for key, replacement in mutations:
            value = registration_fixture()
            value[key] = replacement
            with self.subTest(key=key, replacement=replacement), self.assertRaises(
                ValueError
            ):
                data_volume.validate_registration(value)

    def test_registration_rejects_non_durable_or_noncanonical_paths(self):
        for mount_root in (
            "/",
            "/mnt",
            "/tmp/sp4",
            "/run/fullmag",
            "/proc/data",
            "/dev/volume",
            "/sys/storage",
            "/var/tmp/fullmag",
            "relative/path",
            "/mnt/fullmag/../data",
            "/mnt//fullmag",
            "/mnt/fullmag\x00data",
        ):
            value = registration_fixture()
            value["mount_root"] = mount_root
            with self.subTest(mount_root=mount_root), self.assertRaises(ValueError):
                data_volume.validate_registration(value)

    def test_registration_requires_exact_unique_nonoverlapping_dataset_roles(self):
        mutations = []

        missing = registration_fixture()
        missing["datasets"].pop()
        mutations.append(("missing", missing))

        duplicate = registration_fixture()
        duplicate["datasets"][1]["role"] = "user_data"
        mutations.append(("duplicate role", duplicate))

        unknown_role = registration_fixture()
        unknown_role["datasets"][1]["role"] = "cache"
        mutations.append(("unknown role", unknown_role))

        unknown_key = registration_fixture()
        unknown_key["datasets"][0]["extra"] = "no"
        mutations.append(("unknown dataset key", unknown_key))

        overlapping_canonical = registration_fixture()
        overlapping_canonical["datasets"][1]["canonical_root"] = (
            overlapping_canonical["datasets"][0]["canonical_root"] + "/state"
        )
        mutations.append(("overlapping canonical roots", overlapping_canonical))

        overlapping_relative = registration_fixture()
        overlapping_relative["datasets"][1]["relative_root"] = (
            overlapping_relative["datasets"][0]["relative_root"] + "/state"
        )
        mutations.append(("overlapping payload roots", overlapping_relative))

        for name, value in mutations:
            with self.subTest(name=name), self.assertRaises(ValueError):
                data_volume.validate_registration(value)

    def test_dataset_paths_must_be_absolute_durable_and_payload_relative(self):
        bad_canonical = ("relative/path", "/", "/var/tmp/fullmag", "/home/../etc")
        for path in bad_canonical:
            value = registration_fixture()
            value["datasets"][0]["canonical_root"] = path
            with self.subTest(path=path), self.assertRaises(ValueError):
                data_volume.validate_registration(value)

        bad_relative = (
            "payload",
            "payload/../state",
            "payload//state",
            "payload\\state",
            "elsewhere/state",
            "payload/state\n",
        )
        for path in bad_relative:
            value = registration_fixture()
            value["datasets"][0]["relative_root"] = path
            with self.subTest(path=path), self.assertRaises(ValueError):
                data_volume.validate_registration(value)


class MountEvidenceValidationTests(unittest.TestCase):
    def test_valid_mount_evidence_returns_canonical_summary_without_mutation(self):
        registration = registration_fixture()
        observations = mount_observations(registration)
        registration_before = copy.deepcopy(registration)
        observations_before = copy.deepcopy(observations)

        result = data_volume.validate_mount_evidence(registration, observations)

        self.assertEqual(
            result,
            {
                "schema": "fullmag.user-data-volume-mounts.v1",
                "state": "verified",
                "volume_id": registration["volume_id"],
                "filesystem_uuid": registration["filesystem_uuid"],
                "datasets": ["user_data", "state"],
            },
        )
        self.assertEqual(registration, registration_before)
        self.assertEqual(observations, observations_before)

    def test_mount_evidence_rejects_open_or_missing_observation_shapes(self):
        registration = registration_fixture()
        observations = mount_observations(registration)
        del observations["state"]
        with self.assertRaises(ValueError):
            data_volume.validate_mount_evidence(registration, observations)

        observations = mount_observations(registration)
        observations["extra"] = {}
        with self.assertRaises(ValueError):
            data_volume.validate_mount_evidence(registration, observations)

        observations = mount_observations(registration)
        observations["volume"]["extra"] = "value"
        with self.assertRaises(ValueError):
            data_volume.validate_mount_evidence(registration, observations)

    def test_mount_evidence_rejects_volume_identity_and_integer_drift(self):
        mutations = (
            ("target", "/mnt/other"),
            ("filesystem", "xfs"),
            ("filesystem_uuid", "123e4567-e89b-12d3-a456-426614174001"),
            ("device", True),
            ("device", 0),
            ("inode", False),
        )
        for key, replacement in mutations:
            observations = mount_observations()
            observations["volume"][key] = replacement
            with self.subTest(key=key, replacement=replacement), self.assertRaises(
                ValueError
            ):
                data_volume.validate_mount_evidence(registration_fixture(), observations)

    def test_mount_evidence_rejects_dataset_path_filesystem_or_uuid_drift(self):
        mutations = (
            ("canonical_root", "/other/root"),
            ("volume_root", MOUNT_ROOT + "/payload/other"),
            ("filesystem", "xfs"),
            ("filesystem_uuid", "123e4567-e89b-12d3-a456-426614174001"),
        )
        for key, replacement in mutations:
            observations = mount_observations()
            observations["user_data"][key] = replacement
            with self.subTest(key=key, replacement=replacement), self.assertRaises(
                ValueError
            ):
                data_volume.validate_mount_evidence(registration_fixture(), observations)

    def test_mount_evidence_rejects_split_devices_and_bind_inode_mismatch(self):
        mutations = (
            ("canonical_device", 260),
            ("volume_device", 260),
            ("canonical_inode", 2001),
            ("volume_inode", 2001),
            ("canonical_inode", True),
            ("volume_inode", 0),
        )
        for key, replacement in mutations:
            observations = mount_observations()
            observations["state"][key] = replacement
            with self.subTest(key=key, replacement=replacement), self.assertRaises(
                ValueError
            ):
                data_volume.validate_mount_evidence(registration_fixture(), observations)

    def test_mount_evidence_rejects_cross_role_physical_alias(self):
        registration = registration_fixture()
        observations = mount_observations(registration)
        aliased_inode = observations["user_data"]["canonical_inode"]
        observations["state"]["canonical_inode"] = aliased_inode
        observations["state"]["volume_inode"] = aliased_inode

        with self.assertRaises(ValueError):
            data_volume.validate_mount_evidence(registration, observations)


if __name__ == "__main__":
    unittest.main()
