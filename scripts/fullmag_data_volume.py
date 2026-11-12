"""Pure validators for registered Fullmag user-data volumes.

This module intentionally performs no filesystem, Docker, or platform I/O.
Callers provide a closed registration object and independently collected mount
observations; this module checks their shape and internal consistency only.
"""

from copy import deepcopy
import re
import unicodedata
from uuid import UUID


_REGISTRATION_KEYS = frozenset(
    {
        "schema",
        "project_id",
        "worktree_id",
        "compose_project",
        "volume_id",
        "backing_file_windows",
        "backing_file_wsl",
        "filesystem_uuid",
        "mount_root",
        "datasets",
        "migration_receipt_sha256",
        "state",
    }
)
_DATASET_KEYS = frozenset({"role", "canonical_root", "relative_root"})
_MOUNT_OBSERVATION_KEYS = frozenset({"volume", "user_data", "state"})
_VOLUME_KEYS = frozenset(
    {"target", "filesystem", "filesystem_uuid", "device", "inode"}
)
_DATASET_OBSERVATION_KEYS = frozenset(
    {
        "canonical_root",
        "volume_root",
        "filesystem",
        "filesystem_uuid",
        "canonical_device",
        "canonical_inode",
        "volume_device",
        "volume_inode",
    }
)

_IDENTIFIER_RE = re.compile(r"[a-z0-9_][a-z0-9._-]{0,127}\Z", re.ASCII)
_PROJECT_ID_RE = re.compile(r"[a-z0-9_][a-z0-9._-]{0,31}-[0-9a-f]{16}\Z", re.ASCII)
_VOLUME_ID_RE = re.compile(r"[0-9a-f]{32}\Z", re.ASCII)
_SHA256_RE = re.compile(r"[0-9a-f]{64}\Z", re.ASCII)
_WINDOWS_LOCAL_PATH_RE = re.compile(r"([A-Za-z]):\\(.+)\Z", re.ASCII)
_WINDOWS_RESERVED_COMPONENT_RE = re.compile(
    r"(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\..*)?\Z",
    re.IGNORECASE | re.ASCII,
)
_WINDOWS_INVALID_COMPONENT_CHARACTERS = frozenset('<>:"/\\|?*')
_DURABLE_PATH_EXCLUDED_ROOTS = (
    "/tmp",
    "/run",
    "/proc",
    "/dev",
    "/sys",
    "/var/tmp",
)


def _fail(message: str) -> None:
    raise ValueError(message)


def _require_exact_dict(value, expected_keys, label: str) -> dict:
    if type(value) is not dict:
        _fail(f"{label} must be an object")
    if any(type(key) is not str for key in value):
        _fail(f"{label} keys must be strings")
    if frozenset(value) != expected_keys:
        missing = sorted(expected_keys - frozenset(value))
        unknown = sorted(frozenset(value) - expected_keys)
        _fail(f"{label} keys are not closed (missing={missing}, unknown={unknown})")
    return value


def _require_string(value, label: str) -> str:
    if type(value) is not str or not value:
        _fail(f"{label} must be a nonempty string")
    return value


def _contains_control(value: str) -> bool:
    return any(unicodedata.category(character) == "Cc" for character in value)


def _require_no_controls(value: str, label: str) -> None:
    if _contains_control(value):
        _fail(f"{label} must not contain control characters")


def _require_durable_posix_absolute(path, label: str) -> tuple[str, ...]:
    path = _require_string(path, label)
    _require_no_controls(path, label)
    if not path.startswith("/") or path.startswith("//"):
        _fail(f"{label} must be an absolute POSIX path")
    if path == "/" or path == "/mnt":
        _fail(f"{label} must identify a durable directory below its root")
    for excluded_root in _DURABLE_PATH_EXCLUDED_ROOTS:
        if path == excluded_root or path.startswith(excluded_root + "/"):
            _fail(f"{label} must not be under {excluded_root}")

    components = path[1:].split("/")
    if any(component in {"", ".", ".."} for component in components):
        _fail(f"{label} must not contain empty, dot, or parent components")
    return tuple(components)


def _components_overlap(left: tuple[str, ...], right: tuple[str, ...]) -> bool:
    shorter, longer = (left, right) if len(left) <= len(right) else (right, left)
    return longer[: len(shorter)] == shorter


def _validate_relative_payload_path(path, label: str) -> tuple[str, ...]:
    path = _require_string(path, label)
    _require_no_controls(path, label)
    if "\\" in path or path.startswith("/"):
        _fail(f"{label} must be a relative POSIX path")
    components = path.split("/")
    if (
        len(components) < 2
        or components[0] != "payload"
        or any(component in {"", ".."} for component in components)
    ):
        _fail(f"{label} must be a nonempty path below payload/")
    # A dot component stays in the same directory. Ignore it for overlap checks
    # while preserving the caller's exact string in the validated registration.
    normalized = tuple(component for component in components if component != ".")
    return normalized


def _windows_components(path) -> tuple[str, tuple[str, ...]]:
    path = _require_string(path, "backing_file_windows")
    _require_no_controls(path, "backing_file_windows")
    match = _WINDOWS_LOCAL_PATH_RE.fullmatch(path)
    if match is None:
        _fail("backing_file_windows must be an absolute local-drive path")

    drive = match.group(1).lower()
    components = tuple(match.group(2).split("\\"))
    if any(component in {"", ".", ".."} for component in components):
        _fail("backing_file_windows must not contain empty, dot, or parent components")
    for component in components:
        if component[-1] in {".", " "}:
            _fail("backing_file_windows components must not end in dot or space")
        if any(character in _WINDOWS_INVALID_COMPONENT_CHARACTERS for character in component):
            _fail("backing_file_windows contains an invalid Windows component")
        if _WINDOWS_RESERVED_COMPONENT_RE.fullmatch(component):
            _fail("backing_file_windows contains a reserved Windows component")
    if not components[-1].lower().endswith(".vhdx"):
        _fail("backing_file_windows must have a .vhdx suffix")
    return drive, components


def _validate_backing_file_mapping(windows_path, wsl_path) -> None:
    drive, components = _windows_components(windows_path)
    wsl_path = _require_string(wsl_path, "backing_file_wsl")
    _require_durable_posix_absolute(wsl_path, "backing_file_wsl")
    expected = "/mnt/" + drive + "/" + "/".join(components)
    if wsl_path != expected:
        _fail("backing_file_wsl does not exactly map backing_file_windows")


def _validate_filesystem_uuid(value, label: str) -> None:
    value = _require_string(value, label)
    try:
        parsed = UUID(value)
    except (AttributeError, TypeError, ValueError) as error:
        raise ValueError(f"{label} must be a canonical lower-case UUID") from error
    if str(parsed) != value or parsed.int == 0:
        _fail(f"{label} must be a canonical nonzero lower-case UUID")


def _validate_registration(value: dict) -> dict:
    value = _require_exact_dict(value, _REGISTRATION_KEYS, "registration")

    if value["schema"] != "fullmag.user-data-volume.v1":
        _fail("registration has an unsupported schema")
    if value["state"] != "committed":
        _fail("registration state must be committed")

    project_id = _require_string(value["project_id"], "project_id")
    if _PROJECT_ID_RE.fullmatch(project_id) is None:
        _fail("project_id must match the resolver's bounded slug and 16 hexadecimal characters")

    worktree_id = _require_string(value["worktree_id"], "worktree_id")
    if _IDENTIFIER_RE.fullmatch(worktree_id) is None:
        _fail("worktree_id must use bounded lowercase ASCII identifier characters")

    compose_project = _require_string(value["compose_project"], "compose_project")
    compose_segment = re.sub(r"[^a-z0-9_-]+", "-", worktree_id).strip("-")
    if compose_project not in {
        "fullmag-master",
        f"fullmag-worktree-{compose_segment}",
    }:
        _fail("compose_project does not match the registered worktree")

    volume_id = _require_string(value["volume_id"], "volume_id")
    if _VOLUME_ID_RE.fullmatch(volume_id) is None or volume_id == "0" * 32:
        _fail("volume_id must be a nonzero 32-character lowercase hexadecimal value")

    receipt = _require_string(
        value["migration_receipt_sha256"], "migration_receipt_sha256"
    )
    if _SHA256_RE.fullmatch(receipt) is None:
        _fail("migration_receipt_sha256 must be a lowercase SHA-256 digest")

    _validate_filesystem_uuid(value["filesystem_uuid"], "filesystem_uuid")
    _validate_backing_file_mapping(
        value["backing_file_windows"], value["backing_file_wsl"]
    )
    _require_durable_posix_absolute(value["mount_root"], "mount_root")

    datasets = value["datasets"]
    if type(datasets) is not list or len(datasets) != 2:
        _fail("datasets must contain exactly the user_data and state records")

    roles = set()
    canonical_roots = {}
    relative_roots = {}
    for index, dataset in enumerate(datasets):
        dataset = _require_exact_dict(dataset, _DATASET_KEYS, f"datasets[{index}]")
        role = _require_string(dataset["role"], f"datasets[{index}].role")
        if role not in {"user_data", "state"} or role in roles:
            _fail("datasets must contain user_data and state exactly once")
        roles.add(role)

        canonical_path = dataset["canonical_root"]
        canonical_roots[role] = _require_durable_posix_absolute(
            canonical_path, f"datasets[{index}].canonical_root"
        )
        relative_roots[role] = _validate_relative_payload_path(
            dataset["relative_root"], f"datasets[{index}].relative_root"
        )

    if roles != {"user_data", "state"}:
        _fail("datasets must contain user_data and state exactly once")
    if _components_overlap(canonical_roots["user_data"], canonical_roots["state"]):
        _fail("dataset canonical roots must not overlap")
    if _components_overlap(relative_roots["user_data"], relative_roots["state"]):
        _fail("dataset volume-relative roots must not overlap")

    return deepcopy(value)


def validate_registration(value: dict) -> dict:
    """Validate a closed v1 registration and return an unchanged deep copy."""

    return _validate_registration(value)


def _positive_int(value, label: str) -> int:
    if type(value) is not int or value <= 0:
        _fail(f"{label} must be a positive integer")
    return value


def validate_mount_evidence(registration: dict, observations: dict) -> dict:
    """Validate observed ext4 mount/bind identities against a registration."""

    registration = _validate_registration(registration)
    observations = _require_exact_dict(
        observations, _MOUNT_OBSERVATION_KEYS, "mount observations"
    )

    volume = _require_exact_dict(observations["volume"], _VOLUME_KEYS, "volume")
    if volume["target"] != registration["mount_root"]:
        _fail("observed volume target differs from mount_root")
    if volume["filesystem"] != "ext4":
        _fail("observed volume filesystem must be ext4")
    if volume["filesystem_uuid"] != registration["filesystem_uuid"]:
        _fail("observed volume UUID differs from the registration")
    volume_device = _positive_int(volume["device"], "volume.device")
    _positive_int(volume["inode"], "volume.inode")

    datasets_by_role = {dataset["role"]: dataset for dataset in registration["datasets"]}
    physical_identities = {}
    for role in ("user_data", "state"):
        observed = _require_exact_dict(
            observations[role], _DATASET_OBSERVATION_KEYS, f"{role} observation"
        )
        registered = datasets_by_role[role]
        expected_volume_root = (
            registration["mount_root"] + "/" + registered["relative_root"]
        )
        if observed["canonical_root"] != registered["canonical_root"]:
            _fail(f"{role} canonical_root differs from the registration")
        if observed["volume_root"] != expected_volume_root:
            _fail(f"{role} volume_root differs from the registration")
        if observed["filesystem"] != "ext4":
            _fail(f"{role} filesystem must be ext4")
        if observed["filesystem_uuid"] != registration["filesystem_uuid"]:
            _fail(f"{role} filesystem UUID differs from the registration")

        canonical_device = _positive_int(
            observed["canonical_device"], f"{role}.canonical_device"
        )
        canonical_inode = _positive_int(
            observed["canonical_inode"], f"{role}.canonical_inode"
        )
        bind_device = _positive_int(observed["volume_device"], f"{role}.volume_device")
        bind_inode = _positive_int(observed["volume_inode"], f"{role}.volume_inode")
        if canonical_device != volume_device or bind_device != volume_device:
            _fail(f"{role} canonical and volume paths are not on the registered device")
        if canonical_inode != bind_inode:
            _fail(f"{role} canonical and volume paths have different inodes")
        physical_identity = (canonical_device, canonical_inode)
        if physical_identity in physical_identities.values():
            _fail("user_data and state must identify physically distinct directories")
        physical_identities[role] = physical_identity

    return {
        "schema": "fullmag.user-data-volume-mounts.v1",
        "state": "verified",
        "volume_id": registration["volume_id"],
        "filesystem_uuid": registration["filesystem_uuid"],
        "datasets": ["user_data", "state"],
    }
