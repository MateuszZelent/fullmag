import hashlib
import json
import struct
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

import windows_vhd_identity as vhd_identity


VIRTUAL_DISK_ID = uuid.UUID("a96ade57-4838-48ea-97a9-de02790adcb4")
VIRTUAL_DISK_ID_METADATA = uuid.UUID("beca12ab-b2e6-4523-93ef-c309e000c746")
FILE_PARAMETERS_METADATA = uuid.UUID("caa16737-fa36-4d43-b3b6-33f0aa44e76b")
VIRTUAL_DISK_SIZE_METADATA = uuid.UUID("2fa54224-cd1b-4876-b211-5dbed83bf4b8")
LOGICAL_SECTOR_SIZE_METADATA = uuid.UUID("8141bf1d-a96f-4709-ba47-f233a8faab5f")
PHYSICAL_SECTOR_SIZE_METADATA = uuid.UUID("cda348c7-445d-4471-9cc9-e9885251c556")
METADATA_REGION = uuid.UUID("8b7ca206-4790-4b9a-b8fe-575f050f886e")
BAT_REGION = uuid.UUID("2dc27766-f623-4200-9d64-115e9bfd4a08")
MIB = 1024 * 1024


def _crc32c(data):
    value = 0xFFFFFFFF
    for byte in data:
        value ^= byte
        for _ in range(8):
            value = (value >> 1) ^ (0x82F63B78 if value & 1 else 0)
    return value ^ 0xFFFFFFFF


def _region_table():
    table = bytearray(64 * 1024)
    table[:4] = b"regi"
    struct.pack_into("<I", table, 8, 2)
    struct.pack_into("<I", table, 12, 0)
    entries = [
        (METADATA_REGION, MIB, MIB, 1),
        (BAT_REGION, 2 * MIB, MIB, 1),
    ]
    for index, (region_id, offset, length, required) in enumerate(entries):
        start = 16 + index * 32
        table[start : start + 16] = region_id.bytes_le
        struct.pack_into("<QII", table, start + 16, offset, length, required)
    struct.pack_into("<I", table, 4, _crc32c(table))
    return bytes(table)


def _header(sequence, log_guid=None):
    header = bytearray(4096)
    header[:4] = b"head"
    struct.pack_into("<Q", header, 8, sequence)
    header[16:48] = bytes(32)
    log_guid = log_guid or uuid.UUID(int=0)
    header[48:64] = log_guid.bytes_le
    struct.pack_into(
        "<HHIQ",
        header,
        64,
        0,
        1,
        MIB if log_guid.int else 0,
        3 * MIB if log_guid.int else 0,
    )
    struct.pack_into("<I", header, 4, _crc32c(header))
    return bytes(header)


def _metadata_region(virtual_disk_id=VIRTUAL_DISK_ID, has_parent=False):
    region = bytearray(MIB)
    table = memoryview(region)[: 64 * 1024]
    table[:8] = b"metadata"
    struct.pack_into("<H", table, 8, 0)
    struct.pack_into("<H", table, 10, 5)
    table[12:32] = bytes(20)
    items = [
        (FILE_PARAMETERS_METADATA, 64 * 1024, 8, 4),
        (VIRTUAL_DISK_SIZE_METADATA, 64 * 1024 + 8, 8, 6),
        (VIRTUAL_DISK_ID_METADATA, 64 * 1024 + 16, 16, 6),
        (LOGICAL_SECTOR_SIZE_METADATA, 64 * 1024 + 32, 4, 6),
        (PHYSICAL_SECTOR_SIZE_METADATA, 64 * 1024 + 36, 4, 6),
    ]
    for index, (item_id, offset, length, flags) in enumerate(items):
        start = 32 + index * 32
        table[start : start + 16] = item_id.bytes_le
        struct.pack_into("<II", table, start + 16, offset, length)
        struct.pack_into("<I", table, start + 24, flags)
        struct.pack_into("<I", table, start + 28, 0)
    struct.pack_into("<I", region, 64 * 1024, 2 * MIB)
    struct.pack_into("<I", region, 64 * 1024 + 4, 2 if has_parent else 0)
    struct.pack_into("<Q", region, 64 * 1024 + 8, 512 * MIB)
    region[64 * 1024 + 16 : 64 * 1024 + 32] = virtual_disk_id.bytes_le
    struct.pack_into("<I", region, 64 * 1024 + 32, 512)
    struct.pack_into("<I", region, 64 * 1024 + 36, 4096)
    return bytes(region)


def _write_vhdx(
    path, *, virtual_disk_id=VIRTUAL_DISK_ID, has_parent=False, log_guid=None
):
    log_guid = log_guid or uuid.UUID(int=0)
    image = bytearray(4 * MIB)
    image[:8] = b"vhdxfile"
    image[64 * 1024 : 68 * 1024] = _header(1, log_guid)
    image[128 * 1024 : 132 * 1024] = _header(2, log_guid)
    table = _region_table()
    image[192 * 1024 : 256 * 1024] = table
    image[256 * 1024 : 320 * 1024] = table
    image[MIB : 2 * MIB] = _metadata_region(virtual_disk_id, has_parent)
    path.write_bytes(image)


def _msft_vpd83(guid=VIRTUAL_DISK_ID):
    t10 = b"\x01\x01\x00\x18" + b"MSFT    " + guid.bytes_le
    naa = b"\x01\x03\x00\x10" + bytes.fromhex(
        "6002248057de6aa93848de02790adcb4"
    )
    descriptors = t10 + naa
    return b"\x00\x83" + struct.pack(">H", len(descriptors)) + descriptors


class ParseMsftVpd83Tests(unittest.TestCase):
    def test_crc32c_uses_castagnoli_polynomial(self):
        self.assertEqual(vhd_identity._crc32c(b"123456789"), 0xE3069283)

    def test_extracts_full_guid_from_msft_descriptor(self):
        self.assertEqual(
            vhd_identity.parse_msft_vpd83(_msft_vpd83()),
            str(VIRTUAL_DISK_ID),
        )

    def test_rejects_truncated_page_and_descriptor(self):
        raw = _msft_vpd83()
        with self.assertRaises(vhd_identity.VHDXIdentityError):
            vhd_identity.parse_msft_vpd83(raw[:-1])
        malformed = raw[:4] + b"\x01\x01\x00\x18" + b"MSFT"
        malformed = malformed[:2] + struct.pack(">H", len(malformed) - 4) + malformed[4:]
        with self.assertRaises(vhd_identity.VHDXIdentityError):
            vhd_identity.parse_msft_vpd83(malformed)

    def test_rejects_missing_or_ambiguous_msft_identifier(self):
        payload = b"OTHER   " + VIRTUAL_DISK_ID.bytes_le
        descriptor = b"\x01\x01\x00\x18" + payload
        missing = b"\x00\x83" + struct.pack(">H", len(descriptor)) + descriptor
        with self.assertRaises(vhd_identity.VHDXIdentityError):
            vhd_identity.parse_msft_vpd83(missing)

        duplicate = _msft_vpd83()
        descriptors = duplicate[4:] + duplicate[4:32]
        ambiguous = b"\x00\x83" + struct.pack(">H", len(descriptors)) + descriptors
        with self.assertRaises(vhd_identity.VHDXIdentityError):
            vhd_identity.parse_msft_vpd83(ambiguous)

    def test_rejects_nonbinary_or_wrong_length_msft_descriptor(self):
        invalid = b"\x02\x01\x00\x18" + b"MSFT    " + VIRTUAL_DISK_ID.bytes_le
        page = b"\x00\x83" + struct.pack(">H", len(invalid)) + invalid
        with self.assertRaises(vhd_identity.VHDXIdentityError):
            vhd_identity.parse_msft_vpd83(page)

        invalid = b"\x01\x01\x00\x17" + b"MSFT    " + VIRTUAL_DISK_ID.bytes_le[:15]
        page = b"\x00\x83" + struct.pack(">H", len(invalid)) + invalid
        with self.assertRaises(vhd_identity.VHDXIdentityError):
            vhd_identity.parse_msft_vpd83(page)


class VhdxStructureLimitTests(unittest.TestCase):
    def _metadata_table_with_user_entries(self, count):
        table = bytearray(64 * 1024)
        table[:8] = b"metadata"
        struct.pack_into("<H", table, 10, count)
        for index in range(count):
            start = 32 + index * 32
            table[start : start + 16] = uuid.UUID(int=index + 1).bytes_le
            struct.pack_into("<II", table, start + 16, 0, 0)
            struct.pack_into("<I", table, start + 24, 1)
        return bytes(table)

    def test_allows_at_most_1024_user_metadata_items(self):
        entries = vhd_identity._parse_metadata_table(
            self._metadata_table_with_user_entries(1024), MIB
        )
        self.assertEqual(len(entries), 1024)
        with self.assertRaises(vhd_identity.VHDXIdentityError):
            vhd_identity._parse_metadata_table(
                self._metadata_table_with_user_entries(1025), MIB
            )


class VhdxHeaderSelectionTests(unittest.TestCase):
    def _parsed_header(self, raw, offset):
        return vhd_identity._parse_header(raw, offset, 4 * MIB)

    def test_equal_sequence_identical_headers_are_rejected(self):
        raw = _header(7)
        with self.assertRaises(vhd_identity.VHDXIdentityError):
            vhd_identity._select_current_header(
                [self._parsed_header(raw, 64 * 1024), self._parsed_header(raw, 128 * 1024)]
            )

    def test_equal_sequence_different_headers_are_rejected(self):
        first = bytearray(_header(7))
        second = bytearray(first)
        second[16] ^= 1
        struct.pack_into("<I", second, 4, 0)
        struct.pack_into("<I", second, 4, _crc32c(second))
        with self.assertRaises(vhd_identity.VHDXIdentityError):
            vhd_identity._select_current_header(
                [
                    self._parsed_header(bytes(first), 64 * 1024),
                    self._parsed_header(bytes(second), 128 * 1024),
                ]
            )


class ReadVhdxVirtualDiskIdTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.path = Path(self.tempdir.name) / "disk.vhdx"
        _write_vhdx(self.path)

    def tearDown(self):
        self.tempdir.cleanup()

    def test_reads_guid_and_returns_repeatable_raw_metadata_hashes(self):
        result = vhd_identity.read_vhdx_virtual_disk_id(self.path)
        self.assertEqual(result["virtual_disk_id"], str(VIRTUAL_DISK_ID))
        self.assertEqual(
            result["metadata_properties"],
            {
                "virtual_disk_size": 512 * MIB,
                "logical_sector_size": 512,
                "physical_sector_size": 4096,
                "block_size": 2 * MIB,
            },
        )
        self.assertFalse(result["log_replayed"])
        self.assertFalse(result["active_disk_attestation"])
        self.assertEqual(result["identity_scope"], "raw-on-disk-metadata-only")
        records = {record["kind"]: record for record in result["metadata_sha256"]}
        self.assertEqual(records["virtual_disk_id"]["length"], 16)
        self.assertEqual(
            records["virtual_disk_id"]["sha256"],
            hashlib.sha256(VIRTUAL_DISK_ID.bytes_le).hexdigest(),
        )
        self.assertIn("metadata_table", records)
        self.assertIn("virtual_disk_size", records)
        self.assertIn("logical_sector_size", records)
        self.assertIn("physical_sector_size", records)
        self.assertEqual(result["stability_passes"], 2)

    def test_rejects_truncated_vhdx_and_bad_region_crc(self):
        self.path.write_bytes(self.path.read_bytes()[: 320 * 1024])
        with self.assertRaises(vhd_identity.VHDXIdentityError):
            vhd_identity.read_vhdx_virtual_disk_id(self.path)

        _write_vhdx(self.path)
        with self.path.open("r+b") as stream:
            stream.seek(192 * 1024 + 40)
            byte = stream.read(1)
            stream.seek(192 * 1024 + 40)
            stream.write(bytes([byte[0] ^ 1]))
        with self.assertRaises(vhd_identity.VHDXIdentityError):
            vhd_identity.read_vhdx_virtual_disk_id(self.path)

    def test_rejects_differencing_disk(self):
        _write_vhdx(self.path, has_parent=True)
        with self.assertRaises(vhd_identity.VHDXIdentityError):
            vhd_identity.read_vhdx_virtual_disk_id(self.path)

    def test_rejects_nonregular_path(self):
        with self.assertRaises(vhd_identity.VHDXIdentityError):
            vhd_identity.read_vhdx_virtual_disk_id(self.tempdir.name)

    def test_nonzero_log_is_reported_without_replay_or_active_claim(self):
        _write_vhdx(self.path, log_guid=uuid.uuid4())
        result = vhd_identity.read_vhdx_virtual_disk_id(self.path)
        self.assertFalse(result["log_replayed"])
        self.assertFalse(result["active_disk_attestation"])
        self.assertEqual(
            result["log_state"],
            "nonzero-log-guid-unreplayed-metadata-may-be-stale",
        )

    def test_unrelated_payload_write_and_file_growth_do_not_invalidate_identity(self):
        original_scan = vhd_identity._scan_once
        calls = 0

        def scan_then_change_payload(fd, file_size):
            nonlocal calls
            result = original_scan(fd, file_size)
            calls += 1
            if calls == 1:
                with self.path.open("r+b") as stream:
                    stream.seek(3 * MIB + 4096)
                    stream.write(b"unrelated payload write")
                    stream.seek(5 * MIB)
                    stream.write(b"growth")
            return result

        with mock.patch.object(
            vhd_identity, "_scan_once", side_effect=scan_then_change_payload
        ):
            result = vhd_identity.read_vhdx_virtual_disk_id(self.path)
        self.assertEqual(result["virtual_disk_id"], str(VIRTUAL_DISK_ID))
        self.assertEqual(result["file_size_at_open"], 4 * MIB)

    def test_rejects_duplicate_metadata_item_and_bad_header_crc(self):
        image = bytearray(self.path.read_bytes())
        table_entry0 = MIB + 32
        table_entry1 = table_entry0 + 32
        image[table_entry1 : table_entry1 + 16] = image[table_entry0 : table_entry0 + 16]
        self.path.write_bytes(image)
        with self.assertRaises(vhd_identity.VHDXIdentityError):
            vhd_identity.read_vhdx_virtual_disk_id(self.path)

        _write_vhdx(self.path)
        with self.path.open("r+b") as stream:
            for offset in (64 * 1024 + 100, 128 * 1024 + 100):
                stream.seek(offset)
                byte = stream.read(1)
                stream.seek(offset)
                stream.write(bytes([byte[0] ^ 1]))
        with self.assertRaises(vhd_identity.VHDXIdentityError):
            vhd_identity.read_vhdx_virtual_disk_id(self.path)

    def test_rejects_unknown_required_and_malformed_standard_metadata(self):
        image = bytearray(self.path.read_bytes())
        table_offset = MIB
        struct.pack_into("<H", image, table_offset + 10, 6)
        extra = table_offset + 32 + 5 * 32
        image[extra : extra + 16] = uuid.uuid4().bytes_le
        struct.pack_into("<II", image, extra + 16, 64 * 1024 + 40, 4)
        struct.pack_into("<I", image, extra + 24, 4)
        self.path.write_bytes(image)
        with self.assertRaises(vhd_identity.VHDXIdentityError):
            vhd_identity.read_vhdx_virtual_disk_id(self.path)

        _write_vhdx(self.path)
        image = bytearray(self.path.read_bytes())
        struct.pack_into("<I", image, MIB + 84, 7)
        self.path.write_bytes(image)
        with self.assertRaises(vhd_identity.VHDXIdentityError):
            vhd_identity.read_vhdx_virtual_disk_id(self.path)

    def test_rejects_metadata_drift_between_stability_passes(self):
        original_scan = vhd_identity._scan_once
        calls = 0

        def scan_then_change(fd, file_size):
            nonlocal calls
            result = original_scan(fd, file_size)
            calls += 1
            if calls == 1:
                with self.path.open("r+b") as stream:
                    stream.seek(MIB + 64 * 1024 + 16)
                    stream.write(uuid.uuid4().bytes_le)
            return result

        with mock.patch.object(vhd_identity, "_scan_once", side_effect=scan_then_change):
            with self.assertRaises(vhd_identity.VHDXIdentityError):
                vhd_identity.read_vhdx_virtual_disk_id(self.path)


class ValidateVhdxIdentityRecordTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.path = Path(self.tempdir.name) / "disk.vhdx"
        _write_vhdx(self.path)
        self.record = json.loads(
            json.dumps(vhd_identity.read_vhdx_virtual_disk_id(self.path))
        )

    def tearDown(self):
        self.tempdir.cleanup()

    def test_round_trips_serialized_reader_record(self):
        self.assertEqual(
            vhd_identity.validate_vhdx_identity_record(self.record), self.record
        )

    def test_rejects_type_guid_hash_and_schema_tampering(self):
        cases = []
        wrong_type = json.loads(json.dumps(self.record))
        wrong_type["file_size_at_open"] = True
        cases.append(("integer is bool", wrong_type))

        wrong_guid = json.loads(json.dumps(self.record))
        wrong_guid["virtual_disk_id"] = "00000000-0000-0000-0000-000000000000"
        cases.append(("zero virtual disk id", wrong_guid))

        wrong_hash = json.loads(json.dumps(self.record))
        vdisk_record = next(
            item for item in wrong_hash["metadata_sha256"]
            if item["kind"] == "virtual_disk_id"
        )
        vdisk_record["sha256"] = hashlib.sha256(b"different bytes").hexdigest()
        cases.append(("mismatched metadata digest", wrong_hash))

        wrong_property = json.loads(json.dumps(self.record))
        wrong_property["metadata_properties"]["virtual_disk_size"] += 512
        cases.append(("size property not bound to its digest", wrong_property))

        wrong_schema = json.loads(json.dumps(self.record))
        wrong_schema["schema"] = "fullmag.windows-vhdx-identity.v2"
        cases.append(("schema", wrong_schema))

        for label, record in cases:
            with self.subTest(label=label):
                with self.assertRaises(vhd_identity.VHDXIdentityError):
                    vhd_identity.validate_vhdx_identity_record(record)

    def test_rejects_header_hash_and_region_policy_tampering(self):
        wrong_header_hash = json.loads(json.dumps(self.record))
        selected = wrong_header_hash["header"]["offset"]
        header_record = next(
            item for item in wrong_header_hash["file_structure_sha256"]
            if item["kind"] == "header" and item["offset"] == selected
        )
        header_record["sha256"] = hashlib.sha256(b"different header").hexdigest()

        wrong_region = json.loads(json.dumps(self.record))
        metadata_region = next(
            item for item in wrong_region["regions"]
            if item["id"] == str(METADATA_REGION)
        )
        metadata_region["required"] = 0

        for label, record in (("selected header hash", wrong_header_hash),
                              ("required metadata region", wrong_region)):
            with self.subTest(label=label):
                with self.assertRaises(vhd_identity.VHDXIdentityError):
                    vhd_identity.validate_vhdx_identity_record(record)

    def test_binds_nonzero_log_scope_without_claiming_replay(self):
        _write_vhdx(self.path, log_guid=uuid.uuid4())
        record = json.loads(
            json.dumps(vhd_identity.read_vhdx_virtual_disk_id(self.path))
        )
        self.assertEqual(
            vhd_identity.validate_vhdx_identity_record(record), record
        )
        record["log_state"] = "header-log-guid-zero"
        with self.assertRaises(vhd_identity.VHDXIdentityError):
            vhd_identity.validate_vhdx_identity_record(record)


class NativeFileIdentityTests(unittest.TestCase):
    def setUp(self):
        self.target = {
            "volume_serial_hex": "0123456789abcdef",
            "file_id_hex": "ab" * 16,
            "final_path": r"\\?\Volume{12345678-1234-5678-9abc-123456789abc}\data.vhdx",
            "number_of_links": 1,
            "filesystem": "NTFS",
            "drive_type": 3,
        }
        self.raw = {
            "attributes": 0x80,
            "reparse_tag": 0,
            "final_path": self.target["final_path"],
            "volume_serial": 0x0123456789ABCDEF,
            "file_id": bytes.fromhex("ab" * 16),
            "number_of_links": 1,
            "is_directory": False,
            "delete_pending": False,
            "filesystem": "NTFS",
            "drive_type": 3,
        }

    def test_compares_native_volume_serial_full_file_id_and_path(self):
        vhd_identity._verify_native_fd_identity(self.raw, self.target)
        changed_values = (
            ("file_id", bytes.fromhex("cd" * 16)),
            ("volume_serial", 2),
            (
                "final_path",
                r"\\?\Volume{87654321-1234-5678-9abc-123456789abc}\data.vhdx",
            ),
        )
        for field, changed in changed_values:
            raw = dict(self.raw)
            raw[field] = changed
            with self.subTest(field=field):
                with self.assertRaises(vhd_identity.VHDXIdentityError):
                    vhd_identity._verify_native_fd_identity(raw, self.target)


if __name__ == "__main__":
    unittest.main()
