"""Pure closed-shape validation for Linux data-volume provisioning requests."""
from copy import deepcopy
import re
import unicodedata
from pathlib import PurePosixPath
from uuid import UUID


SCHEMA = "fullmag.data-volume-linux-provision.v1"
SCHEMA_WITH_RUNTIME_BINDING = "fullmag.data-volume-linux-provision.v2"
MIN_CAPACITY_BYTES = 1024**3
MAX_CAPACITY_BYTES = 1024**4

_REQUEST_KEYS = frozenset(
    {
        "schema",
        "volume_id",
        "storage_root",
        "mount_root",
        "capacity_bytes",
        "filesystem_uuid",
        "boot_id",
        "source_roots",
        "baseline_sha256",
        "attach_inputs_sha256",
        "provision_request_sha256",
        "created_receipt_sha256",
        "attached_receipt_sha256",
        "controller_sha256",
    }
)
_SOURCE_ROOT_KEYS = frozenset({"user_data", "state"})
_SOURCE_ENTRY_KEYS = frozenset({"canonical_root", "device", "inode"})
_HEX32 = re.compile(r"[0-9a-f]{32}\Z", re.ASCII)
_HEX64 = re.compile(r"[0-9a-f]{64}\Z", re.ASCII)
_TRANSIENT_ROOTS = ("/tmp", "/var/tmp", "/run", "/proc", "/sys", "/dev")


def _fail(message: str) -> None:
    raise ValueError(message)


def _exact_dict(value, keys, label: str) -> dict:
    if type(value) is not dict or any(type(key) is not str for key in value):
        _fail(f"{label} must be an object with string keys")
    if frozenset(value) != keys:
        _fail(f"{label} has missing or unknown keys")
    return value


def _digest(value, label: str) -> str:
    if type(value) is not str or _HEX64.fullmatch(value) is None:
        _fail(f"{label} must be a 64-character lowercase hexadecimal digest")
    return value


def _canonical_nonzero_uuid(value, label: str) -> str:
    if type(value) is not str:
        _fail(f"{label} must be a canonical nonzero UUID")
    try:
        parsed = UUID(value)
    except (AttributeError, TypeError, ValueError) as error:
        raise ValueError(f"{label} must be a canonical nonzero UUID") from error
    if str(parsed) != value or parsed.int == 0:
        _fail(f"{label} must be a canonical nonzero UUID")
    return value


def _path(value, label: str) -> PurePosixPath:
    if type(value) is not str or not value:
        _fail(f"{label} must be a nonempty absolute POSIX path")
    if any(unicodedata.category(character) == "Cc" for character in value):
        _fail(f"{label} must not contain control characters")
    path = PurePosixPath(value)
    if (
        not path.is_absolute()
        or str(path) != value
        or value.startswith("//")
        or any(component in {".", ".."} for component in path.parts[1:])
    ):
        _fail(f"{label} must use canonical absolute POSIX spelling without traversal")
    if value in {"/", "/mnt"}:
        _fail(f"{label} must not be a filesystem root")
    for transient_root in _TRANSIENT_ROOTS:
        if value == transient_root or value.startswith(transient_root + "/"):
            _fail(f"{label} must not be under transient root {transient_root}")
    return path


def _components(path: PurePosixPath) -> tuple[str, ...]:
    return path.parts[1:]


def _overlaps(left: PurePosixPath, right: PurePosixPath) -> bool:
    left_parts = _components(left)
    right_parts = _components(right)
    shorter, longer = (
        (left_parts, right_parts)
        if len(left_parts) <= len(right_parts)
        else (right_parts, left_parts)
    )
    return longer[: len(shorter)] == shorter


def _strict_descendant(path: PurePosixPath, root: PurePosixPath) -> bool:
    return path != root and _overlaps(path, root) and len(path.parts) > len(root.parts)


def validate_linux_request(value: dict) -> dict:
    """Validate a Linux provision request and return an unchanged deep copy."""

    if type(value) is not dict:
        _fail("Linux request must be an object with string keys")
    bound = value.get("schema") == SCHEMA_WITH_RUNTIME_BINDING
    value = _exact_dict(value, _REQUEST_KEYS | {"runtime_binding_sha256"} if bound else _REQUEST_KEYS, "Linux request")
    if value["schema"] not in (SCHEMA, SCHEMA_WITH_RUNTIME_BINDING):
        _fail("Linux request has an unsupported schema")
    if bound:
        _digest(value["runtime_binding_sha256"], "runtime_binding_sha256")

    volume_id = value["volume_id"]
    if (
        type(volume_id) is not str
        or _HEX32.fullmatch(volume_id) is None
        or volume_id == "0" * 32
    ):
        _fail("volume_id must be a nonzero 32-character lowercase hexadecimal token")

    storage_root = _path(value["storage_root"], "storage_root")
    mount_root = _path(value["mount_root"], "mount_root")
    if _overlaps(storage_root, mount_root):
        _fail("mount_root must be disjoint from storage_root")

    capacity = value["capacity_bytes"]
    if (
        type(capacity) is not int
        or capacity < MIN_CAPACITY_BYTES
        or capacity > MAX_CAPACITY_BYTES
    ):
        _fail("capacity_bytes must be an integer between 1 GiB and 1 TiB")

    _canonical_nonzero_uuid(value["filesystem_uuid"], "filesystem_uuid")
    _canonical_nonzero_uuid(value["boot_id"], "boot_id")

    source_roots = _exact_dict(value["source_roots"], _SOURCE_ROOT_KEYS, "source_roots")
    parsed_roots = {}
    identities = {}
    for role in ("user_data", "state"):
        entry = _exact_dict(
            source_roots[role], _SOURCE_ENTRY_KEYS, f"source_roots.{role}"
        )
        canonical_root = _path(
            entry["canonical_root"], f"source_roots.{role}.canonical_root"
        )
        if not _strict_descendant(canonical_root, storage_root):
            _fail(f"source_roots.{role} must be a strict descendant of storage_root")
        for identity_key in ("device", "inode"):
            identity_value = entry[identity_key]
            if type(identity_value) is not int or identity_value <= 0:
                _fail(f"source_roots.{role}.{identity_key} must be a positive integer")
        parsed_roots[role] = canonical_root
        identities[role] = (entry["device"], entry["inode"])

    if _overlaps(parsed_roots["user_data"], parsed_roots["state"]):
        _fail("user_data and state source roots must be mutually disjoint")
    if identities["user_data"] == identities["state"]:
        _fail("user_data and state source roots must have distinct device/inode identities")
    if any(_overlaps(mount_root, root) for root in parsed_roots.values()):
        _fail("mount_root must be disjoint from both source roots")

    _digest(value["baseline_sha256"], "baseline_sha256")
    _digest(value["attach_inputs_sha256"], "attach_inputs_sha256")
    _digest(value["provision_request_sha256"], "provision_request_sha256")
    _digest(value["created_receipt_sha256"], "created_receipt_sha256")
    _digest(value["attached_receipt_sha256"], "attached_receipt_sha256")
    _digest(value["controller_sha256"], "controller_sha256")

    return deepcopy(value)
