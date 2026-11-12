import copy
import unittest

from scripts import fullmag_data_volume_linux_request as linux_request


GIB = 1024**3


def valid_request():
    return {
        "schema": "fullmag.data-volume-linux-provision.v1",
        "volume_id": "a" * 32,
        "storage_root": "/srv/fullmag/storage",
        "mount_root": "/mnt/fullmag-data-volume",
        "capacity_bytes": 128 * GIB,
        "filesystem_uuid": "123e4567-e89b-12d3-a456-426614174000",
        "boot_id": "123e4567-e89b-12d3-a456-426614174001",
        "source_roots": {
            "user_data": {
                "canonical_root": "/srv/fullmag/storage/user-data/fixture",
                "device": 259,
                "inode": 101,
            },
            "state": {
                "canonical_root": "/srv/fullmag/storage/runtimes/fixture/attempt",
                "device": 259,
                "inode": 202,
            },
        },
        "baseline_sha256": "b" * 64,
        "attach_inputs_sha256": "c" * 64,
        "provision_request_sha256": "d" * 64,
        "created_receipt_sha256": "e" * 64,
        "attached_receipt_sha256": "f" * 64,
        "controller_sha256": "1" * 64,
    }


def valid_runtime_binding_request():
    value = valid_request()
    value["schema"] = "fullmag.data-volume-linux-provision.v2"
    value["runtime_binding_sha256"] = "2" * 64
    return value


class LinuxDataVolumeRequestTests(unittest.TestCase):
    def test_v2_accepts_exact_runtime_binding_sha256(self):
        value = valid_runtime_binding_request()
        before = copy.deepcopy(value)

        result = linux_request.validate_linux_request(value)

        self.assertEqual(result, before)
        self.assertEqual(value, before)
        self.assertIsNot(result, value)

    def test_v2_requires_a_nonzero_lowercase_sha256_binding(self):
        mutations = []

        missing = valid_runtime_binding_request()
        del missing["runtime_binding_sha256"]
        mutations.append(("missing", missing))

        for label, replacement in (
            ("null", None),
            ("boolean", True),
            ("uppercase", "A" * 64),
            ("wrong_length", "b" * 63),
            ("non_hex", "g" * 64),
        ):
            value = valid_runtime_binding_request()
            value["runtime_binding_sha256"] = replacement
            mutations.append((label, value))

        for label, value in mutations:
            with self.subTest(label=label), self.assertRaises(ValueError):
                linux_request.validate_linux_request(value)

    def test_v1_and_v2_remain_closed_around_runtime_binding_key(self):
        legacy_with_binding = valid_request()
        legacy_with_binding["runtime_binding_sha256"] = "2" * 64
        with self.assertRaises(ValueError):
            linux_request.validate_linux_request(legacy_with_binding)

        extended_v2 = valid_runtime_binding_request()
        extended_v2["authorization"] = True
        with self.assertRaises(ValueError):
            linux_request.validate_linux_request(extended_v2)

    def test_valid_request_returns_unchanged_independent_copy(self):
        value = valid_request()
        before = copy.deepcopy(value)

        result = linux_request.validate_linux_request(value)

        self.assertEqual(result, before)
        self.assertEqual(value, before)
        self.assertIsNot(result, value)
        self.assertIsNot(result["source_roots"], value["source_roots"])
        self.assertIsNot(
            result["source_roots"]["user_data"],
            value["source_roots"]["user_data"],
        )

    def test_valid_roots_may_share_device_but_have_distinct_inodes(self):
        value = valid_request()
        self.assertEqual(value["source_roots"]["user_data"]["device"],
                         value["source_roots"]["state"]["device"])
        self.assertNotEqual(value["source_roots"]["user_data"]["inode"],
                            value["source_roots"]["state"]["inode"])
        self.assertEqual(linux_request.validate_linux_request(value), value)

    def test_capacity_boundaries_are_valid(self):
        for capacity in (GIB, 1024**4):
            value = valid_request()
            value["capacity_bytes"] = capacity
            with self.subTest(capacity=capacity):
                self.assertEqual(linux_request.validate_linux_request(value), value)

    def test_mount_root_under_mnt_is_allowed_but_literal_mnt_is_not(self):
        value = valid_request()
        value["mount_root"] = "/mnt/new-volume"
        self.assertEqual(linux_request.validate_linux_request(value), value)

        value["mount_root"] = "/mnt"
        with self.assertRaises(ValueError):
            linux_request.validate_linux_request(value)

    def test_rejects_open_top_level_and_source_root_shapes(self):
        unknown_top = valid_request()
        unknown_top["device"] = "/dev/loop0"
        with self.assertRaises(ValueError):
            linux_request.validate_linux_request(unknown_top)

        missing = valid_request()
        del missing["controller_sha256"]
        with self.assertRaises(ValueError):
            linux_request.validate_linux_request(missing)

        wrong_schema = valid_request()
        wrong_schema["schema"] = "fullmag.data-volume-linux-provision.v2"
        with self.assertRaises(ValueError):
            linux_request.validate_linux_request(wrong_schema)

        unknown_role = valid_request()
        unknown_role["source_roots"]["cache"] = {
            "canonical_root": "/srv/fullmag/storage/cache",
            "device": 259,
            "inode": 303,
        }
        with self.assertRaises(ValueError):
            linux_request.validate_linux_request(unknown_role)

        missing_role = valid_request()
        del missing_role["source_roots"]["state"]
        with self.assertRaises(ValueError):
            linux_request.validate_linux_request(missing_role)

        unknown_dataset_key = valid_request()
        unknown_dataset_key["source_roots"]["state"]["device_path"] = "/dev/loop0"
        with self.assertRaises(ValueError):
            linux_request.validate_linux_request(unknown_dataset_key)

    def test_rejects_invalid_volume_token_hashes_and_capacity(self):
        mutations = (
            ("volume_id", "0" * 32),
            ("volume_id", "A" * 32),
            ("baseline_sha256", "g" * 64),
            ("attach_inputs_sha256", "C" * 64),
            ("provision_request_sha256", "short"),
            ("created_receipt_sha256", 7),
            ("attached_receipt_sha256", "0" * 63),
            ("controller_sha256", None),
            ("capacity_bytes", True),
            ("capacity_bytes", 0),
            ("capacity_bytes", GIB - 1),
            ("capacity_bytes", 1024**4 + 1),
            ("capacity_bytes", 128.0 * GIB),
        )
        for key, replacement in mutations:
            value = valid_request()
            value[key] = replacement
            with self.subTest(key=key, replacement=replacement), self.assertRaises(
                ValueError
            ):
                linux_request.validate_linux_request(value)

    def test_rejects_invalid_canonical_nonzero_uuids(self):
        for key, replacement in (
            ("filesystem_uuid", "00000000-0000-0000-0000-000000000000"),
            ("filesystem_uuid", "123E4567-E89B-12D3-A456-426614174000"),
            ("filesystem_uuid", "not-a-uuid"),
            ("boot_id", "00000000-0000-0000-0000-000000000000"),
            ("boot_id", "123e4567e89b12d3a456426614174001"),
        ):
            value = valid_request()
            value[key] = replacement
            with self.subTest(key=key, replacement=replacement), self.assertRaises(
                ValueError
            ):
                linux_request.validate_linux_request(value)

    def test_rejects_nonpositive_or_boolean_source_device_and_inode(self):
        for key, replacement in (
            ("device", True),
            ("device", 0),
            ("inode", False),
            ("inode", -1),
        ):
            value = valid_request()
            value["source_roots"]["state"][key] = replacement
            with self.subTest(key=key, replacement=replacement), self.assertRaises(
                ValueError
            ):
                linux_request.validate_linux_request(value)

    def test_rejects_noncanonical_or_nondurable_posix_paths(self):
        invalid_paths = (
            "/",
            "/mnt",
            "/tmp",
            "/tmp/fullmag",
            "/var/tmp/fullmag",
            "/run/fullmag",
            "/proc/fullmag",
            "/sys/fullmag",
            "/dev/fullmag",
            "relative/path",
            "C:\\fullmag\\storage",
            "\\\\server\\share\\storage",
            "//server/share/storage",
            "/srv/fullmag/../storage",
            "/srv/fullmag/./storage",
            "/srv//fullmag/storage",
            "/srv/fullmag/storage/",
            "/srv/fullmag/storage\x00bad",
        )
        for path in invalid_paths:
            for field in ("storage_root", "mount_root"):
                value = valid_request()
                value[field] = path
                with self.subTest(field=field, path=path), self.assertRaises(ValueError):
                    linux_request.validate_linux_request(value)

        value = valid_request()
        value["source_roots"]["user_data"]["canonical_root"] = "/run/fullmag/user"
        with self.assertRaises(ValueError):
            linux_request.validate_linux_request(value)

    def test_rejects_roots_outside_storage_or_overlapping_each_other(self):
        mutations = []

        outside = valid_request()
        outside["source_roots"]["state"]["canonical_root"] = "/srv/other/state"
        mutations.append(outside)

        same_roots = valid_request()
        same_roots["source_roots"]["state"]["canonical_root"] = same_roots[
            "source_roots"
        ]["user_data"]["canonical_root"]
        mutations.append(same_roots)

        nested_roots = valid_request()
        nested_roots["source_roots"]["state"]["canonical_root"] = (
            nested_roots["source_roots"]["user_data"]["canonical_root"] + "/nested"
        )
        mutations.append(nested_roots)

        aliased_roots = valid_request()
        aliased_roots["source_roots"]["state"]["device"] = aliased_roots[
            "source_roots"
        ]["user_data"]["device"]
        aliased_roots["source_roots"]["state"]["inode"] = aliased_roots[
            "source_roots"
        ]["user_data"]["inode"]
        mutations.append(aliased_roots)

        mount_under_storage = valid_request()
        mount_under_storage["mount_root"] = "/srv/fullmag/storage/mount"
        mutations.append(mount_under_storage)

        mount_ancestor = valid_request()
        mount_ancestor["mount_root"] = "/srv/fullmag"
        mutations.append(mount_ancestor)

        mount_overlaps_data = valid_request()
        mount_overlaps_data["mount_root"] = "/srv/fullmag/storage/user-data"
        mutations.append(mount_overlaps_data)

        for value in mutations:
            with self.subTest(value=value), self.assertRaises(ValueError):
                linux_request.validate_linux_request(value)

    def test_rejects_boolean_source_identity_values(self):
        value = valid_request()
        value["source_roots"]["user_data"]["inode"] = True
        with self.assertRaises(ValueError):
            linux_request.validate_linux_request(value)


if __name__ == "__main__":
    unittest.main()
