"""Read VHDX identity metadata without attaching or modifying the image.

This is a bounded metadata reader, not a VHDX log replayer and not an
attestation that a file is the disk currently backing a guest device.
"""

from __future__ import annotations

import hashlib
import json
import os
import stat
import struct
import uuid
from contextlib import contextmanager


class VHDXIdentityError(ValueError):
    """Raised when VHDX or SCSI VPD 83 identity evidence is malformed."""


_MAX_READ = 256 * 1024
_MIB = 1024 * 1024
_HEADER_SIZE = 4096
_REGION_TABLE_SIZE = 64 * 1024
_METADATA_TABLE_SIZE = 64 * 1024
_HEADER_OFFSETS = (64 * 1024, 128 * 1024)
_REGION_TABLE_OFFSETS = (192 * 1024, 256 * 1024)
_VHDX_SIGNATURE = b"vhdxfile"
_METADATA_REGION_ID = uuid.UUID("8b7ca206-4790-4b9a-b8fe-575f050f886e")
_BAT_REGION_ID = uuid.UUID("2dc27766-f623-4200-9d64-115e9bfd4a08")
_FILE_PARAMETERS_ID = uuid.UUID("caa16737-fa36-4d43-b3b6-33f0aa44e76b")
_VIRTUAL_DISK_SIZE_ID = uuid.UUID("2fa54224-cd1b-4876-b211-5dbed83bf4b8")
_VIRTUAL_DISK_ID = uuid.UUID("beca12ab-b2e6-4523-93ef-c309e000c746")
_LOGICAL_SECTOR_SIZE_ID = uuid.UUID("8141bf1d-a96f-4709-ba47-f233a8faab5f")
_PHYSICAL_SECTOR_SIZE_ID = uuid.UUID("cda348c7-445d-4471-9cc9-e9885251c556")
_PARENT_LOCATOR_ID = uuid.UUID("a8d35f2d-b30b-454d-abf7-d3d84834ab0c")
_STANDARD_METADATA = {
    _FILE_PARAMETERS_ID: (False, False, True, 8),
    _VIRTUAL_DISK_SIZE_ID: (False, True, True, 8),
    _VIRTUAL_DISK_ID: (False, True, True, 16),
    _LOGICAL_SECTOR_SIZE_ID: (False, True, True, 4),
    _PHYSICAL_SECTOR_SIZE_ID: (False, True, True, 4),
    _PARENT_LOCATOR_ID: (False, False, True, None),
}
_REQUIRED_COMMON_METADATA = (
    _FILE_PARAMETERS_ID,
    _VIRTUAL_DISK_SIZE_ID,
    _VIRTUAL_DISK_ID,
    _LOGICAL_SECTOR_SIZE_ID,
    _PHYSICAL_SECTOR_SIZE_ID,
)
_KNOWN_METADATA_IDS = set(_STANDARD_METADATA)
_REPARSE_POINT_ATTRIBUTE = 0x400
_DRIVE_FIXED = 3


def _make_crc32c_table():
    table = []
    for byte in range(256):
        value = byte
        for _ in range(8):
            value = (value >> 1) ^ (0x82F63B78 if value & 1 else 0)
        table.append(value)
    return tuple(table)


_CRC32C_TABLE = _make_crc32c_table()


def _crc32c(data: bytes) -> int:
    value = 0xFFFFFFFF
    for byte in data:
        value = (value >> 8) ^ _CRC32C_TABLE[(value ^ byte) & 0xFF]
    return value ^ 0xFFFFFFFF


def _checksum_matches(raw: bytes, checksum_offset: int = 4) -> bool:
    if checksum_offset < 0 or checksum_offset + 4 > len(raw):
        return False
    expected = struct.unpack_from("<I", raw, checksum_offset)[0]
    scratch = bytearray(raw)
    scratch[checksum_offset : checksum_offset + 4] = b"\0\0\0\0"
    return _crc32c(scratch) == expected


def _read_exact(fd: int, offset: int, length: int, file_size: int) -> bytes:
    if length < 0 or length > _MAX_READ:
        raise VHDXIdentityError("requested VHDX read exceeds the bounded read size")
    if offset < 0 or offset + length > file_size:
        raise VHDXIdentityError("VHDX structure lies outside the file")

    chunks = bytearray()
    position = offset
    while len(chunks) < length:
        os.lseek(fd, position, os.SEEK_SET)
        chunk = os.read(fd, min(length - len(chunks), _MAX_READ))
        if not chunk:
            raise VHDXIdentityError("VHDX structure is truncated")
        chunks.extend(chunk)
        position += len(chunk)
    return bytes(chunks)


def _uuid_from_vhdx(raw: bytes) -> uuid.UUID:
    if len(raw) != 16:
        raise VHDXIdentityError("VHDX GUID field must contain exactly 16 bytes")
    return uuid.UUID(bytes_le=raw)


def _parse_header(raw: bytes, offset: int, file_size: int):
    if len(raw) != _HEADER_SIZE or raw[:4] != b"head" or not _checksum_matches(raw):
        return None

    sequence = struct.unpack_from("<Q", raw, 8)[0]
    log_guid = _uuid_from_vhdx(raw[48:64])
    log_version, version = struct.unpack_from("<HH", raw, 64)
    log_length = struct.unpack_from("<I", raw, 68)[0]
    log_offset = struct.unpack_from("<Q", raw, 72)[0]

    if version != 1:
        raise VHDXIdentityError("unsupported VHDX header version")
    if log_version != 0 and log_guid.int != 0:
        raise VHDXIdentityError("nonzero VHDX log version with a nonempty log GUID")
    if any(raw[80:]):
        raise VHDXIdentityError("VHDX header reserved bytes are nonzero")
    if log_length % _MIB:
        raise VHDXIdentityError("VHDX log length is not MiB aligned")
    if log_length == 0:
        if log_offset != 0 or log_guid.int != 0:
            raise VHDXIdentityError("VHDX log fields are inconsistent")
        log_range = None
    else:
        if log_offset < _MIB or log_offset % _MIB:
            raise VHDXIdentityError("VHDX log offset is invalid or unaligned")
        if log_offset + log_length > file_size:
            raise VHDXIdentityError("VHDX log extends beyond the file")
        log_range = (log_offset, log_offset + log_length)

    return {
        "offset": offset,
        "sequence_number": sequence,
        "file_write_guid": str(_uuid_from_vhdx(raw[16:32])),
        "data_write_guid": str(_uuid_from_vhdx(raw[32:48])),
        "log_guid": str(log_guid),
        "log_guid_zero": log_guid.int == 0,
        "log_version": log_version,
        "log_offset": log_offset,
        "log_length": log_length,
        "log_range": log_range,
        "raw_sha256": hashlib.sha256(raw).hexdigest(),
    }


def _select_current_header(headers):
    valid = [header for header in headers if header is not None]
    if not valid:
        raise VHDXIdentityError("neither VHDX header has a valid signature and CRC-32C")
    if len(valid) == 1:
        return valid[0]
    left, right = valid
    if left["sequence_number"] == right["sequence_number"]:
        raise VHDXIdentityError("VHDX headers have a tied sequence number")
    return max(valid, key=lambda header: header["sequence_number"])


def _parse_region_table(raw: bytes, file_size: int, log_range):
    if len(raw) != _REGION_TABLE_SIZE or raw[:4] != b"regi":
        raise VHDXIdentityError("VHDX region table signature is invalid")
    if not _checksum_matches(raw):
        raise VHDXIdentityError("VHDX region table CRC-32C is invalid")
    count = struct.unpack_from("<I", raw, 8)[0]
    reserved = struct.unpack_from("<I", raw, 12)[0]
    if count > 2047 or 16 + count * 32 > len(raw):
        raise VHDXIdentityError("VHDX region table entry count is invalid")
    if reserved != 0:
        raise VHDXIdentityError("VHDX region table reserved field is nonzero")

    entries = []
    seen = set()
    ranges = []
    known_regions = {_METADATA_REGION_ID, _BAT_REGION_ID}
    for index in range(count):
        start = 16 + index * 32
        region_id = _uuid_from_vhdx(raw[start : start + 16])
        region_offset, length, required = struct.unpack_from("<QII", raw, start + 16)
        if region_id in seen:
            raise VHDXIdentityError("duplicate VHDX region identifier")
        seen.add(region_id)
        if required not in (0, 1):
            raise VHDXIdentityError("VHDX region Required field is invalid")
        if required and region_id not in known_regions:
            raise VHDXIdentityError("unknown required VHDX region")
        if region_offset < _MIB or region_offset % _MIB or length == 0 or length % _MIB:
            raise VHDXIdentityError("VHDX region offset or length is invalid")
        end = region_offset + length
        if end > file_size:
            raise VHDXIdentityError("VHDX region extends beyond the file")
        if log_range and region_offset < log_range[1] and log_range[0] < end:
            raise VHDXIdentityError("VHDX region overlaps the log")
        ranges.append((region_offset, end, region_id))
        entries.append((region_id, region_offset, length, required))

    ranges.sort(key=lambda item: item[0])
    for previous, current in zip(ranges, ranges[1:]):
        if previous[1] > current[0]:
            raise VHDXIdentityError("VHDX regions overlap")

    by_id = {entry[0]: entry for entry in entries}
    metadata = by_id.get(_METADATA_REGION_ID)
    bat = by_id.get(_BAT_REGION_ID)
    if metadata is None or metadata[3] != 1:
        raise VHDXIdentityError("required VHDX metadata region is missing")
    if bat is None or bat[3] != 1:
        raise VHDXIdentityError("required VHDX BAT region is missing")
    return entries, metadata


def _parse_metadata_table(raw: bytes, metadata_region_length: int):
    if len(raw) != _METADATA_TABLE_SIZE or raw[:8] != b"metadata":
        raise VHDXIdentityError("VHDX metadata table signature is invalid")
    reserved = struct.unpack_from("<H", raw, 8)[0]
    count = struct.unpack_from("<H", raw, 10)[0]
    if reserved != 0 or any(raw[12:32]):
        raise VHDXIdentityError("VHDX metadata table reserved bytes are nonzero")
    if count > 2047 or 32 + count * 32 > len(raw):
        raise VHDXIdentityError("VHDX metadata table entry count is invalid")

    entries = []
    seen_pairs = set()
    item_ranges = []
    user_count = 0
    for index in range(count):
        start = 32 + index * 32
        item_id = _uuid_from_vhdx(raw[start : start + 16])
        item_offset, item_length = struct.unpack_from("<II", raw, start + 16)
        flags = struct.unpack_from("<I", raw, start + 24)[0]
        reserved2 = struct.unpack_from("<I", raw, start + 28)[0]
        if flags & ~0x7 or reserved2 != 0:
            raise VHDXIdentityError("VHDX metadata item reserved bits are nonzero")
        is_user = bool(flags & 0x1)
        is_virtual_disk = bool(flags & 0x2)
        is_required = bool(flags & 0x4)
        if is_user:
            user_count += 1
            if user_count > 1024:
                raise VHDXIdentityError("VHDX metadata table has too many user items")
        pair = (item_id, is_user)
        if pair in seen_pairs:
            raise VHDXIdentityError("duplicate VHDX metadata item identifier")
        seen_pairs.add(pair)
        if item_length > 1024 * 1024:
            raise VHDXIdentityError("VHDX metadata item exceeds the specified length limit")
        if item_length == 0:
            if item_offset != 0:
                raise VHDXIdentityError("empty VHDX metadata item has a nonzero offset")
        else:
            if item_offset < _METADATA_TABLE_SIZE:
                raise VHDXIdentityError("VHDX metadata item overlaps its table")
            if item_offset + item_length > metadata_region_length:
                raise VHDXIdentityError("VHDX metadata item exceeds its region")
            item_ranges.append((item_offset, item_offset + item_length, item_id))
        if is_required and item_id not in _KNOWN_METADATA_IDS:
            raise VHDXIdentityError("unknown required VHDX metadata item")
        entries.append(
            {
                "id": item_id,
                "offset": item_offset,
                "length": item_length,
                "is_user": is_user,
                "is_virtual_disk": is_virtual_disk,
                "is_required": is_required,
            }
        )

    item_ranges.sort(key=lambda item: item[0])
    for previous, current in zip(item_ranges, item_ranges[1:]):
        if previous[1] > current[0]:
            raise VHDXIdentityError("VHDX metadata items overlap")
    return entries


def _validate_standard_metadata(entries):
    known = {}
    for entry in entries:
        item_id = entry["id"]
        expected = _STANDARD_METADATA.get(item_id)
        if expected is None:
            if entry["is_required"]:
                raise VHDXIdentityError("unknown required VHDX metadata item")
            continue
        if item_id in known:
            raise VHDXIdentityError("known VHDX metadata item is ambiguous")
        expected_user, expected_virtual_disk, expected_required, expected_length = expected
        if (
            entry["is_user"] != expected_user
            or entry["is_virtual_disk"] != expected_virtual_disk
            or entry["is_required"] != expected_required
        ):
            raise VHDXIdentityError("known VHDX metadata item flags are invalid")
        if expected_length is not None:
            if entry["length"] != expected_length:
                raise VHDXIdentityError("known VHDX metadata item length is invalid")
        elif entry["length"] < 20:
            raise VHDXIdentityError("VHDX parent locator metadata is truncated")
        known[item_id] = entry

    for item_id in _REQUIRED_COMMON_METADATA:
        if item_id not in known:
            raise VHDXIdentityError("required standard VHDX metadata item is missing")
    return known


def _find_known_item(entries, item_id, expected_length, expected_virtual_disk):
    matches = [entry for entry in entries if entry["id"] == item_id]
    if len(matches) != 1:
        raise VHDXIdentityError("required VHDX metadata item is missing or ambiguous")
    item = matches[0]
    if (
        item["is_user"]
        or item["is_virtual_disk"] != expected_virtual_disk
        or not item["is_required"]
        or item["length"] != expected_length
        or item["offset"] == 0
    ):
        raise VHDXIdentityError("required VHDX metadata item flags or length are invalid")
    return item


def _metadata_record(kind: str, offset: int, raw: bytes, item_id=None):
    record = {
        "kind": kind,
        "offset": offset,
        "length": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
    }
    if item_id is not None:
        record["item_id"] = str(item_id)
    return record


def _scan_once(fd: int, file_size: int):
    signature = _read_exact(fd, 0, 8, file_size)
    if signature != _VHDX_SIGNATURE:
        raise VHDXIdentityError("VHDX file identifier signature is invalid")

    header_bytes = [
        _read_exact(fd, offset, _HEADER_SIZE, file_size) for offset in _HEADER_OFFSETS
    ]
    headers = [
        _parse_header(raw, offset, file_size)
        for raw, offset in zip(header_bytes, _HEADER_OFFSETS)
    ]
    current_header = _select_current_header(headers)

    region_table_bytes = [
        _read_exact(fd, offset, _REGION_TABLE_SIZE, file_size)
        for offset in _REGION_TABLE_OFFSETS
    ]
    parsed_region_tables = [
        _parse_region_table(raw, file_size, current_header["log_range"])
        for raw in region_table_bytes
    ]
    if parsed_region_tables[0][0] != parsed_region_tables[1][0]:
        raise VHDXIdentityError("redundant VHDX region tables disagree")
    metadata_region = parsed_region_tables[0][1]
    _, metadata_offset, metadata_length, _ = metadata_region

    metadata_table = _read_exact(fd, metadata_offset, _METADATA_TABLE_SIZE, file_size)
    items = _parse_metadata_table(metadata_table, metadata_length)
    standard_items = _validate_standard_metadata(items)
    file_parameters = _find_known_item(
        items, _FILE_PARAMETERS_ID, 8, expected_virtual_disk=False
    )
    virtual_disk_id = _find_known_item(
        items, _VIRTUAL_DISK_ID, 16, expected_virtual_disk=True
    )
    virtual_disk_size = standard_items[_VIRTUAL_DISK_SIZE_ID]
    logical_sector_size = standard_items[_LOGICAL_SECTOR_SIZE_ID]
    physical_sector_size = standard_items[_PHYSICAL_SECTOR_SIZE_ID]
    if _PARENT_LOCATOR_ID in standard_items:
        raise VHDXIdentityError("parent locator metadata is not supported")

    file_parameters_raw = _read_exact(
        fd, metadata_offset + file_parameters["offset"], 8, file_size
    )
    virtual_disk_size_raw = _read_exact(
        fd, metadata_offset + virtual_disk_size["offset"], 8, file_size
    )
    virtual_disk_id_raw = _read_exact(
        fd, metadata_offset + virtual_disk_id["offset"], 16, file_size
    )
    logical_sector_size_raw = _read_exact(
        fd, metadata_offset + logical_sector_size["offset"], 4, file_size
    )
    physical_sector_size_raw = _read_exact(
        fd, metadata_offset + physical_sector_size["offset"], 4, file_size
    )

    block_size = struct.unpack_from("<I", file_parameters_raw, 0)[0]
    file_parameter_flags = struct.unpack_from("<I", file_parameters_raw, 4)[0]
    disk_size = struct.unpack_from("<Q", virtual_disk_size_raw, 0)[0]
    logical_sector = struct.unpack_from("<I", logical_sector_size_raw, 0)[0]
    physical_sector = struct.unpack_from("<I", physical_sector_size_raw, 0)[0]
    if block_size < _MIB or block_size > 256 * _MIB or block_size & (block_size - 1):
        raise VHDXIdentityError("VHDX file parameters contain an invalid block size")
    if file_parameter_flags & ~0x3:
        raise VHDXIdentityError("VHDX file parameters reserved bits are nonzero")
    if file_parameter_flags & 0x2:
        raise VHDXIdentityError("differencing VHDX files are not supported")
    if disk_size == 0 or disk_size > 64 * 1024**4:
        raise VHDXIdentityError("VHDX virtual disk size is invalid")
    if logical_sector not in (512, 4096) or disk_size % logical_sector:
        raise VHDXIdentityError("VHDX logical sector size or disk-size alignment is invalid")
    if physical_sector not in (512, 4096):
        raise VHDXIdentityError("VHDX physical sector size is invalid")

    metadata_hashes = [
        _metadata_record("metadata_table", metadata_offset, metadata_table),
        _metadata_record(
            "file_parameters",
            metadata_offset + file_parameters["offset"],
            file_parameters_raw,
            _FILE_PARAMETERS_ID,
        ),
        _metadata_record(
            "virtual_disk_id",
            metadata_offset + virtual_disk_id["offset"],
            virtual_disk_id_raw,
            _VIRTUAL_DISK_ID,
        ),
        _metadata_record(
            "virtual_disk_size",
            metadata_offset + virtual_disk_size["offset"],
            virtual_disk_size_raw,
            _VIRTUAL_DISK_SIZE_ID,
        ),
        _metadata_record(
            "logical_sector_size",
            metadata_offset + logical_sector_size["offset"],
            logical_sector_size_raw,
            _LOGICAL_SECTOR_SIZE_ID,
        ),
        _metadata_record(
            "physical_sector_size",
            metadata_offset + physical_sector_size["offset"],
            physical_sector_size_raw,
            _PHYSICAL_SECTOR_SIZE_ID,
        ),
    ]
    file_hashes = [
        _metadata_record("file_identifier", 0, signature),
        *[
            _metadata_record("header", offset, raw)
            for offset, raw in zip(_HEADER_OFFSETS, header_bytes)
        ],
        *[
            _metadata_record("region_table", offset, raw)
            for offset, raw in zip(_REGION_TABLE_OFFSETS, region_table_bytes)
        ],
    ]
    proof = {
        "virtual_disk_id": str(_uuid_from_vhdx(virtual_disk_id_raw)),
        "header": {
            key: value
            for key, value in current_header.items()
            if key != "log_range"
        },
        "region_entries": [
            {
                "id": str(region_id),
                "offset": offset,
                "length": length,
                "required": required,
            }
            for region_id, offset, length, required in parsed_region_tables[0][0]
        ],
        "metadata_properties": {
            "virtual_disk_size": disk_size,
            "logical_sector_size": logical_sector,
            "physical_sector_size": physical_sector,
            "block_size": block_size,
        },
        "metadata_sha256": metadata_hashes,
        "file_structure_sha256": file_hashes,
    }
    return proof


def _linux_object_identity(info):
    return info.st_dev, info.st_ino, stat.S_IFMT(info.st_mode), info.st_nlink


def _verify_native_fd_identity(raw, target):
    required = {
        "attributes", "reparse_tag", "final_path", "volume_serial", "file_id",
        "number_of_links", "is_directory", "delete_pending", "filesystem", "drive_type",
    }
    if not isinstance(raw, dict) or set(raw) != required:
        raise VHDXIdentityError("native VHDX handle identity is malformed")
    if (
        type(raw["attributes"]) is not int
        or type(raw["reparse_tag"]) is not int
        or type(raw["volume_serial"]) is not int
        or type(raw["number_of_links"]) is not int
        or type(raw["is_directory"]) is not bool
        or type(raw["delete_pending"]) is not bool
        or type(raw["drive_type"]) is not int
        or not isinstance(raw["file_id"], bytes)
        or not isinstance(raw["final_path"], str)
        or not isinstance(raw["filesystem"], str)
    ):
        raise VHDXIdentityError("native VHDX handle identity has invalid field types")
    if (
        raw["volume_serial"] != int(target["volume_serial_hex"], 16)
        or raw["file_id"].hex() != target["file_id_hex"]
        or raw["final_path"].casefold() != target["final_path"].casefold()
        or raw["number_of_links"] != target["number_of_links"]
        or raw["is_directory"] is not False
        or raw["delete_pending"] is not False
        or raw["attributes"] & _REPARSE_POINT_ATTRIBUTE
        or raw["reparse_tag"] != 0
        or raw["filesystem"].upper() != target["filesystem"].upper()
        or raw["drive_type"] != target["drive_type"]
        or raw["drive_type"] != _DRIVE_FIXED
        or len(raw["file_id"]) != 16
    ):
        raise VHDXIdentityError("opened VHDX data handle differs from its native path pin")


@contextmanager
def _open_readonly_regular(path):
    try:
        path_value = os.fspath(path)
    except TypeError as exc:
        raise VHDXIdentityError("VHDX path is not a filesystem path") from exc

    if os.name == "nt":
        if not isinstance(path_value, str):
            raise VHDXIdentityError("native Windows VHDX path must be text")
        try:
            import msvcrt
            import windows_bind_identity as bind_identity

            backend = bind_identity._native_backend()
            request = [{
                "label": "vhdx",
                "path": path_value,
                "kind": "file",
                "single_link": True,
            }]
            with bind_identity.pin_paths(request) as pins:
                fd = os.open(path_value, os.O_RDONLY | getattr(os, "O_BINARY", 0))
                try:
                    info = os.fstat(fd)
                    target = pins.snapshot()["vhdx"]["target"]

                    def verify_identity():
                        raw_handle = msvcrt.get_osfhandle(fd)
                        wrapper = bind_identity._NativeHandle(raw_handle, path_value[:3])
                        _verify_native_fd_identity(backend.inspect(wrapper), target)
                        pins.verify_unchanged()

                    verify_identity()
                    yield fd, info, verify_identity
                finally:
                    os.close(fd)
        except VHDXIdentityError:
            raise
        except Exception as exc:
            raise VHDXIdentityError("cannot pin and read the native Windows VHDX path") from exc
        return

    nofollow = getattr(os, "O_NOFOLLOW", 0)
    binary = getattr(os, "O_BINARY", 0)
    nonblocking = getattr(os, "O_NONBLOCK", 0)
    try:
        path_info = os.stat(path_value, follow_symlinks=False)
        if stat.S_ISLNK(path_info.st_mode) or getattr(
            path_info, "st_file_attributes", 0
        ) & _REPARSE_POINT_ATTRIBUTE:
            raise VHDXIdentityError("VHDX path is a symlink or reparse point")
        if not stat.S_ISREG(path_info.st_mode):
            raise VHDXIdentityError("VHDX path is not a regular file")
        fd = os.open(path_value, os.O_RDONLY | nofollow | binary | nonblocking)
    except VHDXIdentityError:
        raise
    except OSError as exc:
        raise VHDXIdentityError("cannot open VHDX path read-only") from exc

    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise VHDXIdentityError("VHDX path is not a regular file")
        baseline = _linux_object_identity(info)
        if baseline != _linux_object_identity(path_info):
            raise VHDXIdentityError("VHDX path changed while opening")

        def verify_identity():
            try:
                path_now = os.stat(path_value, follow_symlinks=False)
            except OSError as exc:
                raise VHDXIdentityError("VHDX path changed during identity inspection") from exc
            if (
                not stat.S_ISREG(path_now.st_mode)
                or stat.S_ISLNK(path_now.st_mode)
                or getattr(path_now, "st_file_attributes", 0) & _REPARSE_POINT_ATTRIBUTE
                or _linux_object_identity(os.fstat(fd)) != baseline
                or _linux_object_identity(path_now) != baseline
            ):
                raise VHDXIdentityError("VHDX file identity changed during inspection")

        yield fd, info, verify_identity
    finally:
        os.close(fd)


def read_vhdx_virtual_disk_id(path) -> dict:
    """Return the VHDX VirtualDiskId and hashes for bounded raw metadata reads.

    The file is opened read-only, only fixed headers/tables and two required
    metadata items are read, and the essential structures are sampled twice.
    A nonzero header LogGuid is reported but never replayed. Consequently this
    result is evidence about on-disk metadata only, not an active guest mapping.
    """

    with _open_readonly_regular(path) as (fd, initial_info, verify_identity):
        if initial_info.st_size < 320 * 1024:
            raise VHDXIdentityError("VHDX file is too small for its required tables")
        first = _scan_once(fd, initial_info.st_size)
        verify_identity()
        second = _scan_once(fd, initial_info.st_size)
        verify_identity()
        if json.dumps(first, sort_keys=True) != json.dumps(second, sort_keys=True):
            raise VHDXIdentityError("VHDX essential metadata changed between read passes")

    log_guid_zero = first["header"]["log_guid_zero"]
    return {
        "schema": "fullmag.windows-vhdx-identity.v1",
        "virtual_disk_id": first["virtual_disk_id"],
        "identity_scope": "raw-on-disk-metadata-only",
        "active_disk_attestation": False,
        "log_replayed": False,
        "log_state": (
            "header-log-guid-zero"
            if log_guid_zero
            else "nonzero-log-guid-unreplayed-metadata-may-be-stale"
        ),
        "stability_passes": 2,
        "file_size_at_open": initial_info.st_size,
        "metadata_sha256": first["metadata_sha256"],
        "file_structure_sha256": first["file_structure_sha256"],
        "metadata_properties": first["metadata_properties"],
        "header": first["header"],
        "regions": first["region_entries"],
        "limitations": [
            "The VHDX log is not replayed; a nonzero LogGuid may indicate newer "
            "metadata in the log.",
            "Only identity metadata is read; the file payload and BAT are not inspected or hashed.",
            "This does not prove that the VHDX backs any currently active guest device.",
        ],
    }


def _record_fields(value, expected, label):
    if type(value) is not dict or set(value) != expected:
        raise VHDXIdentityError(f"{label} has an unexpected shape")
    return value


def _record_int(value, minimum, maximum, label):
    if type(value) is not int or value < minimum or value > maximum:
        raise VHDXIdentityError(f"{label} must be an in-range integer")
    return value


def _record_guid(value, label, *, allow_zero=True):
    if type(value) is not str:
        raise VHDXIdentityError(f"{label} must be a canonical UUID string")
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError) as exc:
        raise VHDXIdentityError(f"{label} must be a canonical UUID string") from exc
    if str(parsed) != value or (not allow_zero and parsed.int == 0):
        raise VHDXIdentityError(f"{label} must be a canonical nonzero UUID")
    return parsed


def _record_sha256(value, label):
    if (
        type(value) is not str
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
        or value == "0" * 64
    ):
        raise VHDXIdentityError(f"{label} must be a lowercase SHA-256 digest")
    return value


def _validate_hash_record(record, *, kind, offset, length, item_id=None):
    fields = {"kind", "offset", "length", "sha256"}
    if item_id is not None:
        fields.add("item_id")
    _record_fields(record, fields, f"{kind} hash record")
    if type(record["kind"]) is not str or record["kind"] != kind:
        raise VHDXIdentityError(f"hash record kind must be {kind}")
    record_offset = _record_int(record["offset"], 0, (1 << 64) - 1, f"{kind} offset")
    if offset is not None and record_offset != offset:
        raise VHDXIdentityError(f"{kind} hash record offset is inconsistent")
    if _record_int(record["length"], 1, (1 << 32) - 1, f"{kind} length") != length:
        raise VHDXIdentityError(f"{kind} hash record length is inconsistent")
    if item_id is not None:
        record_item_id = _record_guid(record["item_id"], f"{kind} item id", allow_zero=False)
        if record_item_id != item_id:
            raise VHDXIdentityError(f"{kind} hash record item id is inconsistent")
    return _record_sha256(record["sha256"], f"{kind} SHA-256")


def validate_vhdx_identity_record(record: dict) -> dict:
    """Validate the serialized shape and internal bindings of a reader snapshot.

    This validates the snapshot contract, not the VHDX bytes. CRC-32C cannot be
    recomputed from SHA-256 records alone; callers must preserve the distinction
    between this shape validation and the reader's original file inspection.
    """

    top_keys = {
        "schema", "virtual_disk_id", "identity_scope", "active_disk_attestation",
        "log_replayed", "log_state", "stability_passes", "file_size_at_open",
        "metadata_sha256", "file_structure_sha256", "metadata_properties", "header",
        "regions", "limitations",
    }
    _record_fields(record, top_keys, "VHDX identity record")
    if (
        type(record["schema"]) is not str
        or record["schema"] != "fullmag.windows-vhdx-identity.v1"
    ):
        raise VHDXIdentityError("VHDX identity record schema is unsupported")
    if (
        type(record["identity_scope"]) is not str
        or record["identity_scope"] != "raw-on-disk-metadata-only"
    ):
        raise VHDXIdentityError("VHDX identity record scope is unsupported")
    if type(record["active_disk_attestation"]) is not bool or record["active_disk_attestation"]:
        raise VHDXIdentityError("VHDX metadata snapshot cannot attest an active disk")
    if type(record["log_replayed"]) is not bool or record["log_replayed"]:
        raise VHDXIdentityError("VHDX identity snapshot must not claim log replay")
    if _record_int(record["stability_passes"], 2, 2, "stability_passes") != 2:
        raise VHDXIdentityError("VHDX identity snapshot must have two stability passes")

    file_size = _record_int(
        record["file_size_at_open"], 320 * 1024, (1 << 64) - 1, "file_size_at_open"
    )
    virtual_disk_id = _record_guid(
        record["virtual_disk_id"], "virtual_disk_id", allow_zero=False
    )

    expected_limitations = [
        "The VHDX log is not replayed; a nonzero LogGuid may indicate newer "
        "metadata in the log.",
        "Only identity metadata is read; the file payload and BAT are not inspected or hashed.",
        "This does not prove that the VHDX backs any currently active guest device.",
    ]
    if type(record["limitations"]) is not list or record["limitations"] != expected_limitations:
        raise VHDXIdentityError("VHDX identity record limitations are inconsistent")

    header_keys = {
        "offset", "sequence_number", "file_write_guid", "data_write_guid", "log_guid",
        "log_guid_zero", "log_version", "log_offset", "log_length", "raw_sha256",
    }
    header = _record_fields(record["header"], header_keys, "header")
    header_offset = _record_int(header["offset"], 0, (1 << 64) - 1, "header offset")
    if header_offset not in _HEADER_OFFSETS:
        raise VHDXIdentityError("selected header offset is invalid")
    _record_int(header["sequence_number"], 0, (1 << 64) - 1, "header sequence number")
    _record_guid(header["file_write_guid"], "file_write_guid")
    _record_guid(header["data_write_guid"], "data_write_guid")
    log_guid = _record_guid(header["log_guid"], "log_guid")
    if type(header["log_guid_zero"]) is not bool or header["log_guid_zero"] != (log_guid.int == 0):
        raise VHDXIdentityError("header log GUID zero flag is inconsistent")
    log_version = _record_int(header["log_version"], 0, 0xFFFF, "log_version")
    log_offset = _record_int(header["log_offset"], 0, (1 << 64) - 1, "log_offset")
    log_length = _record_int(header["log_length"], 0, 0xFFFFFFFF, "log_length")
    _record_sha256(header["raw_sha256"], "header raw SHA-256")
    if log_version != 0 and not header["log_guid_zero"]:
        raise VHDXIdentityError("header log version and GUID are inconsistent")
    if log_length == 0:
        if log_offset != 0 or not header["log_guid_zero"]:
            raise VHDXIdentityError("empty log fields are inconsistent")
        log_range = None
    else:
        if log_length % _MIB or log_offset < _MIB or log_offset % _MIB:
            raise VHDXIdentityError("log bounds or alignment are invalid")
        if log_offset + log_length > file_size:
            raise VHDXIdentityError("log extends beyond the recorded file size")
        log_range = (log_offset, log_offset + log_length)
    expected_log_state = (
        "header-log-guid-zero"
        if header["log_guid_zero"]
        else "nonzero-log-guid-unreplayed-metadata-may-be-stale"
    )
    if type(record["log_state"]) is not str or record["log_state"] != expected_log_state:
        raise VHDXIdentityError("top-level log state disagrees with the header")

    properties_keys = {
        "virtual_disk_size", "logical_sector_size", "physical_sector_size", "block_size",
    }
    properties = _record_fields(record["metadata_properties"], properties_keys, "metadata_properties")
    disk_size = _record_int(properties["virtual_disk_size"], 1, 64 * 1024**4, "virtual_disk_size")
    logical_sector = _record_int(properties["logical_sector_size"], 1, 4096, "logical_sector_size")
    physical_sector = _record_int(properties["physical_sector_size"], 1, 4096, "physical_sector_size")
    block_size = _record_int(properties["block_size"], _MIB, 256 * _MIB, "block_size")
    if logical_sector not in (512, 4096) or disk_size % logical_sector:
        raise VHDXIdentityError("logical sector size and disk size are inconsistent")
    if physical_sector not in (512, 4096):
        raise VHDXIdentityError("physical sector size is invalid")
    if block_size & (block_size - 1):
        raise VHDXIdentityError("block size is not a power of two")

    regions = record["regions"]
    if type(regions) is not list or not 2 <= len(regions) <= 2047:
        raise VHDXIdentityError("regions must contain a bounded VHDX region list")
    region_ids = set()
    region_ranges = []
    region_by_id = {}
    region_fields = {"id", "offset", "length", "required"}
    for index, region in enumerate(regions):
        _record_fields(region, region_fields, f"region {index}")
        region_id = _record_guid(region["id"], f"region {index} id", allow_zero=False)
        if region_id in region_ids:
            raise VHDXIdentityError("region identifiers are duplicated")
        region_ids.add(region_id)
        offset = _record_int(region["offset"], _MIB, (1 << 64) - 1, "region offset")
        length = _record_int(region["length"], 1, 0xFFFFFFFF, "region length")
        required = _record_int(region["required"], 0, 1, "region required flag")
        if offset % _MIB or length % _MIB or offset + length > file_size:
            raise VHDXIdentityError("region bounds or alignment are invalid")
        if required and region_id not in {_METADATA_REGION_ID, _BAT_REGION_ID}:
            raise VHDXIdentityError("unknown required region is present in the snapshot")
        if log_range and offset < log_range[1] and log_range[0] < offset + length:
            raise VHDXIdentityError("region overlaps the VHDX log")
        region_by_id[region_id] = region
        region_ranges.append((offset, offset + length))
    region_ranges.sort()
    if any(left[1] > right[0] for left, right in zip(region_ranges, region_ranges[1:])):
        raise VHDXIdentityError("VHDX region ranges overlap")
    for region_id in (_METADATA_REGION_ID, _BAT_REGION_ID):
        region = region_by_id.get(region_id)
        if region is None or region["required"] != 1:
            raise VHDXIdentityError("required standard region is missing or optional")
    metadata_region = region_by_id[_METADATA_REGION_ID]
    metadata_base = metadata_region["offset"]
    metadata_end = metadata_base + metadata_region["length"]
    if metadata_region["length"] < _METADATA_TABLE_SIZE:
        raise VHDXIdentityError("metadata region is too short for its table")

    metadata_records = record["metadata_sha256"]
    metadata_layout = [
        ("metadata_table", None, _METADATA_TABLE_SIZE),
        ("file_parameters", _FILE_PARAMETERS_ID, 8),
        ("virtual_disk_id", _VIRTUAL_DISK_ID, 16),
        ("virtual_disk_size", _VIRTUAL_DISK_SIZE_ID, 8),
        ("logical_sector_size", _LOGICAL_SECTOR_SIZE_ID, 4),
        ("physical_sector_size", _PHYSICAL_SECTOR_SIZE_ID, 4),
    ]
    if type(metadata_records) is not list or len(metadata_records) != len(metadata_layout):
        raise VHDXIdentityError("metadata SHA records are incomplete")
    metadata_item_ranges = []
    metadata_hashes = {}
    for item, (kind, item_id, length) in zip(metadata_records, metadata_layout):
        digest = _validate_hash_record(
            item,
            kind=kind,
            offset=metadata_base if kind == "metadata_table" else None,
            length=length,
            item_id=item_id,
        )
        if kind == "metadata_table":
            if item["offset"] != metadata_base:
                raise VHDXIdentityError("metadata table hash record offset is inconsistent")
        else:
            item_offset = item["offset"]
            if item_offset < metadata_base + _METADATA_TABLE_SIZE:
                raise VHDXIdentityError("metadata item overlaps its table")
            if item_offset + length > metadata_end:
                raise VHDXIdentityError("metadata item exceeds its region")
            metadata_item_ranges.append((item_offset, item_offset + length))
        metadata_hashes[kind] = digest
    metadata_item_ranges.sort()
    if any(left[1] > right[0] for left, right in zip(metadata_item_ranges, metadata_item_ranges[1:])):
        raise VHDXIdentityError("metadata items overlap")

    expected_hashes = {
        "file_parameters": {
            hashlib.sha256(struct.pack("<II", block_size, 0)).hexdigest(),
            hashlib.sha256(struct.pack("<II", block_size, 1)).hexdigest(),
        },
        "virtual_disk_id": {hashlib.sha256(virtual_disk_id.bytes_le).hexdigest()},
        "virtual_disk_size": {hashlib.sha256(struct.pack("<Q", disk_size)).hexdigest()},
        "logical_sector_size": {hashlib.sha256(struct.pack("<I", logical_sector)).hexdigest()},
        "physical_sector_size": {hashlib.sha256(struct.pack("<I", physical_sector)).hexdigest()},
    }
    for kind, digests in expected_hashes.items():
        if metadata_hashes[kind] not in digests:
            raise VHDXIdentityError(f"{kind} hash does not bind its reported value")

    structure_records = record["file_structure_sha256"]
    structure_layout = [
        ("file_identifier", 0, 8),
        ("header", _HEADER_OFFSETS[0], _HEADER_SIZE),
        ("header", _HEADER_OFFSETS[1], _HEADER_SIZE),
        ("region_table", _REGION_TABLE_OFFSETS[0], _REGION_TABLE_SIZE),
        ("region_table", _REGION_TABLE_OFFSETS[1], _REGION_TABLE_SIZE),
    ]
    if type(structure_records) is not list or len(structure_records) != len(structure_layout):
        raise VHDXIdentityError("file structure SHA records are incomplete")
    structure_hashes = {}
    for item, (kind, offset, length) in zip(structure_records, structure_layout):
        digest = _validate_hash_record(item, kind=kind, offset=offset, length=length)
        structure_hashes[(kind, offset)] = digest
    if structure_hashes[("file_identifier", 0)] != hashlib.sha256(_VHDX_SIGNATURE).hexdigest():
        raise VHDXIdentityError("file identifier hash does not match the VHDX signature")
    if structure_hashes[("header", header_offset)] != header["raw_sha256"]:
        raise VHDXIdentityError("selected header hash does not match its file structure record")

    return record


def parse_msft_vpd83(raw: bytes) -> str:
    """Extract the GUID from exactly one binary T10 MSFT Page 83 descriptor.

    The matching descriptor must have bytes `01 01 00 18`: binary code set,
    logical-unit association, and T10 vendor ID type. Its payload must contain
    `MSFT    ` followed by a complete 16-byte GUID. Other well-formed VPD
    descriptors are ignored.
    """

    if not isinstance(raw, bytes) or len(raw) < 4:
        raise VHDXIdentityError("SCSI VPD page 83 data is truncated")
    if raw[1] != 0x83:
        raise VHDXIdentityError("SCSI VPD page code is not 0x83")
    page_length = struct.unpack_from(">H", raw, 2)[0]
    if page_length != len(raw) - 4:
        raise VHDXIdentityError("SCSI VPD page length does not match input")

    end = len(raw)
    cursor = 4
    identifiers = []
    while cursor < end:
        if end - cursor < 4:
            raise VHDXIdentityError("SCSI VPD identifier descriptor is truncated")
        descriptor_type = raw[cursor + 1] & 0x0F
        association = (raw[cursor + 1] >> 4) & 0x03
        length = raw[cursor + 3]
        descriptor_end = cursor + 4 + length
        if descriptor_end > end:
            raise VHDXIdentityError("SCSI VPD identifier length exceeds the page")
        payload = raw[cursor + 4 : descriptor_end]

        # T10 vendor identifiers are type 1, with association zero meaning the
        # logical unit. Treat any MSFT-looking descriptor with a noncanonical
        # code set, reserved byte, or length as malformed rather than ignoring it.
        if descriptor_type == 1 and association == 0 and payload.startswith(b"MSFT"):
            if (
                raw[cursor] != 1
                or raw[cursor + 1] != 1
                or raw[cursor + 2] != 0
                or length != 24
            ):
                raise VHDXIdentityError("MSFT VPD descriptor has invalid format or length")
            if payload[:8] != b"MSFT    ":
                raise VHDXIdentityError("MSFT VPD descriptor vendor field is malformed")
            identifiers.append(_uuid_from_vhdx(payload[8:24]))
        cursor = descriptor_end

    if len(identifiers) != 1:
        raise VHDXIdentityError("SCSI VPD page must contain exactly one MSFT GUID descriptor")
    return str(identifiers[0])
