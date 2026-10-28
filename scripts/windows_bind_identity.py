"""Read-only Windows physical identity pins for Docker/WSL bind sources.

The API deliberately accepts only absolute local drive paths.  On Windows it
opens every component with OPEN_REPARSE_POINT and without FILE_SHARE_DELETE,
then records the identity returned by native handles.  It does not prove that
a Docker daemon actually mounted a path; callers must separately attest that
their mount configuration uses this pinned source.
"""

from contextlib import contextmanager
from collections.abc import Mapping
import ctypes
import os
import re
import unicodedata
import uuid


FILE_ATTRIBUTE_DIRECTORY = 0x10
FILE_ATTRIBUTE_REPARSE_POINT = 0x400
DRIVE_FIXED = 3
DRIVE_REMOTE = 4

_FILE_READ_ATTRIBUTES = 0x80
_FILE_SHARE_READ = 0x1
_FILE_SHARE_WRITE = 0x2
_OPEN_EXISTING = 3
_FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
_FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
_FILE_ATTRIBUTE_TAG_INFO_CLASS = 9
_FILE_STANDARD_INFO_CLASS = 1
_FILE_ID_INFO_CLASS = 18
_FILE_NAME_NORMALIZED = 0x0
_VOLUME_NAME_GUID = 0x1

_MAX_PATH_CHARS = 4096
_MAX_COMPONENTS = 128
_MAX_COMPONENT_CHARS = 255
_MAX_REQUESTS = 32
_MAX_LABEL_CHARS = 64
_SUPPORTED_FILESYSTEMS = frozenset({"NTFS", "REFS"})
_RAW_IDENTITY_FIELDS = frozenset({
    "attributes", "reparse_tag", "final_path", "volume_serial", "file_id",
    "number_of_links", "is_directory", "delete_pending", "filesystem", "drive_type",
})
_LABEL_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\Z")
_VOLUME_GUID_PATH_RE = re.compile(
    r"\\\\\?\\Volume\{([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-"
    r"[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})\}\\(.*)\Z",
    re.DOTALL | re.IGNORECASE,
)
_INVALID_COMPONENT_CHARS = frozenset('<>:"|?*')
_DOS_DEVICE_BASES = frozenset({"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "CLOCK$"})
_DOS_DEVICE_NUMBER = re.compile(r"(?:COM|LPT)(?:[1-9]|[¹²³])\Z", re.IGNORECASE)


class WindowsBindIdentityError(ValueError):
    """A Windows bind path could not be safely pinned or verified."""


def canonical_drive_path(value: str) -> str:
    """Validate and normalize one absolute drive path without resolving it."""
    if not isinstance(value, str):
        raise ValueError("Windows path must be a string")
    if not value or len(value) > _MAX_PATH_CHARS:
        raise ValueError("Windows path is empty or exceeds the supported length")
    if any(unicodedata.category(char) in {"Cc", "Cf", "Cs", "Zl", "Zp"} for char in value):
        raise ValueError("Windows path contains a control character or surrogate")
    if len(value.encode("utf-16-le")) // 2 > _MAX_PATH_CHARS:
        raise ValueError("Windows path is empty or exceeds the supported length")

    normalized = value.replace("/", "\\")
    if (len(normalized) < 3 or not normalized[0].isascii()
            or not normalized[0].isalpha() or normalized[1:3] != ":\\"):
        raise ValueError("Windows path must be an absolute drive-letter path")

    drive = normalized[0].upper()
    remainder = normalized[3:]
    if not remainder:
        return f"{drive}:\\"
    components = remainder.split("\\")
    if len(components) > _MAX_COMPONENTS:
        raise ValueError("Windows path has too many components")
    for component in components:
        if not component or component in {".", ".."}:
            raise ValueError("Windows path contains an empty or relative component")
        if len(component.encode("utf-16-le")) // 2 > _MAX_COMPONENT_CHARS:
            raise ValueError("Windows path component exceeds the supported length")
        if component[-1] in {".", " "}:
            raise ValueError("Windows path components may not end in a dot or space")
        if any(char in _INVALID_COMPONENT_CHARS or ord(char) < 32 for char in component):
            raise ValueError("Windows path contains a forbidden component character")
        device_base = component.split(".", 1)[0].rstrip(" .").upper()
        if device_base in _DOS_DEVICE_BASES or _DOS_DEVICE_NUMBER.fullmatch(device_base):
            raise ValueError("Windows path contains a reserved DOS device name")
    return f"{drive}:\\" + "\\".join(components)


def _request_components(canonical_path: str) -> list[str]:
    if canonical_path.endswith("\\"):
        return []
    return canonical_path[3:].split("\\")


def _ancestor_paths(canonical_path: str) -> list[str]:
    components = _request_components(canonical_path)
    paths = [canonical_path[:3]]
    current = canonical_path[:3]
    for component in components:
        current = current + component if current.endswith("\\") else current + "\\" + component
        paths.append(current)
    return paths


def _inspect_identity(backend, handle, path, expected_kind, single_link):
    try:
        raw = backend.inspect(handle)
    except Exception as error:
        if isinstance(error, WindowsBindIdentityError):
            raise
        raise WindowsBindIdentityError("Could not inspect a pinned path component") from error
    return _identity_record(raw, path, expected_kind, single_link)


def _validate_requests(requests: list[dict]) -> list[dict]:
    if type(requests) is not list or not requests or len(requests) > _MAX_REQUESTS:
        raise ValueError("pin_paths requires a bounded non-empty list of requests")
    validated = []
    labels = set()
    paths = []
    required = {"label", "path", "kind", "single_link"}
    for request in requests:
        if not isinstance(request, Mapping) or set(request) != required:
            raise ValueError(
                "Each path request must contain exactly label, path, kind, and single_link"
            )
        label = request["label"]
        if (not isinstance(label, str) or len(label) > _MAX_LABEL_CHARS
                or not _LABEL_RE.fullmatch(label)):
            raise ValueError("Path request label is invalid")
        if label.casefold() in labels:
            raise ValueError("Path request labels must be unique")
        labels.add(label.casefold())
        kind = request["kind"]
        if not isinstance(kind, str) or kind not in {"file", "directory"}:
            raise ValueError("Path request kind must be file or directory")
        single_link = request["single_link"]
        if type(single_link) is not bool:
            raise ValueError("single_link must be a boolean")
        if kind == "directory" and single_link:
            raise ValueError("Directory pins cannot require a single hard link")
        canonical_path = canonical_drive_path(request["path"])
        folded = canonical_path.casefold().rstrip("\\")
        for other in paths:
            if (folded == other or folded.startswith(other + "\\")
                    or other.startswith(folded + "\\")):
                raise ValueError("Pinned paths must not overlap or alias by path")
        paths.append(folded)
        validated.append({
            "label": label,
            "canonical_input": canonical_path,
            "kind": kind,
            "single_link": single_link,
            "levels": _ancestor_paths(canonical_path),
        })
    return validated


def _volume_guid_and_relative(final_path: str) -> tuple[str, str, str]:
    if not isinstance(final_path, str):
        raise WindowsBindIdentityError("Native handle returned no normalized volume GUID path")
    match = _VOLUME_GUID_PATH_RE.fullmatch(final_path)
    if not match:
        raise WindowsBindIdentityError("Native handle path is not a volume-GUID path")
    try:
        guid = str(uuid.UUID(match.group(1)))
    except ValueError as error:
        raise WindowsBindIdentityError("Native handle returned an invalid volume GUID") from error
    relative = match.group(2)
    if relative and (relative.startswith("\\") or relative.endswith("\\")
                     or any(not part for part in relative.split("\\"))):
        raise WindowsBindIdentityError("Native handle returned an ambiguous normalized path")
    return guid, f"\\\\?\\Volume{{{guid}}}\\{relative}", relative


def _identity_record(raw: Mapping, canonical_input: str, expected_kind: str,
                     single_link: bool) -> dict:
    if not isinstance(raw, Mapping):
        raise WindowsBindIdentityError("Native handle identity response is malformed")
    if set(raw) != _RAW_IDENTITY_FIELDS:
        raise WindowsBindIdentityError(
            "Native handle identity fields are incomplete or unexpected"
        )
    attributes = raw["attributes"]
    reparse_tag = raw["reparse_tag"]
    final_path = raw["final_path"]
    volume_serial = raw["volume_serial"]
    file_id = raw["file_id"]
    links = raw["number_of_links"]
    is_directory = raw["is_directory"]
    delete_pending = raw["delete_pending"]
    filesystem = raw["filesystem"]
    drive_type = raw["drive_type"]
    if (type(attributes) is not int or type(reparse_tag) is not int
            or type(volume_serial) is not int or type(links) is not int
            or type(drive_type) is not int or type(is_directory) is not bool
            or type(delete_pending) is not bool or type(final_path) is not str
            or type(file_id) is not bytes or type(filesystem) is not str):
        raise WindowsBindIdentityError("Native handle identity fields have invalid types")
    if (not (0 <= attributes < (1 << 32)) or not (0 <= reparse_tag < (1 << 32))
            or not (0 <= links < (1 << 32))):
        raise WindowsBindIdentityError("Native handle identity fields are out of range")
    filesystem_code = filesystem.upper()

    no_reparse = not bool(attributes & FILE_ATTRIBUTE_REPARSE_POINT)
    if not no_reparse or reparse_tag != 0:
        raise WindowsBindIdentityError("Pinned path contains a reparse point")
    if delete_pending:
        raise WindowsBindIdentityError("Pinned path is pending deletion")
    directory_attribute = bool(attributes & FILE_ATTRIBUTE_DIRECTORY)
    if is_directory != directory_attribute:
        raise WindowsBindIdentityError("Native directory attributes disagree")
    kind = "directory" if is_directory else "file"
    if kind != expected_kind:
        raise WindowsBindIdentityError(f"Pinned path is not the expected {expected_kind}")
    if filesystem_code not in _SUPPORTED_FILESYSTEMS:
        raise WindowsBindIdentityError("Pinned path is not on a supported local NTFS/ReFS volume")
    if drive_type != DRIVE_FIXED:
        raise WindowsBindIdentityError("Pinned path is not on a native fixed drive")
    if not (0 <= volume_serial < (1 << 64)) or len(file_id) != 16 or not any(file_id):
        raise WindowsBindIdentityError("Native 128-bit file identity is unavailable")
    if links < 1 or (single_link and links != 1):
        raise WindowsBindIdentityError("Pinned file has an unsupported hard-link count")

    volume_guid, normalized_final_path, _ = _volume_guid_and_relative(final_path)
    return {
        "canonical_input": canonical_input,
        "final_path": normalized_final_path,
        "volume_guid": volume_guid,
        "volume_serial_hex": f"{volume_serial:016x}",
        "file_id_hex": file_id.hex(),
        "kind": kind,
        "number_of_links": links,
        "no_reparse": True,
        "filesystem": "NTFS" if filesystem_code == "NTFS" else "ReFS",
        "drive_type": drive_type,
    }


class _PinnedPaths:
    def __init__(self, requests: list[dict], backend):
        self._requests = requests
        self._backend = backend
        self._handles = []
        self._handle_records = []
        self._baseline = None

    def __enter__(self):
        try:
            baseline = {}
            for request in self._requests:
                handles = []
                identities = []
                for index, path in enumerate(request["levels"]):
                    handle = self._backend.open(path)
                    if handle is None or handle == 0:
                        raise WindowsBindIdentityError(
                            "Could not open a path component for identity pinning"
                        )
                    self._handles.append(handle)
                    handles.append((path, handle))
                    expected_kind = (
                        "directory" if index < len(request["levels"]) - 1
                        else request["kind"]
                    )
                    single_link = (
                        request["single_link"] if index == len(request["levels"]) - 1
                        else False
                    )
                    identities.append(_inspect_identity(
                        self._backend, handle, path, expected_kind, single_link
                    ))
                    self._validate_path_chain(identities)
                self._handle_records.append((request, handles))
                baseline[request["label"]] = _request_snapshot(request, identities)
            self._baseline = baseline
            return self
        except BaseException:
            self._close_handles(None)
            raise

    def snapshot(self) -> dict:
        if self._baseline is None:
            raise WindowsBindIdentityError("Path identity pin is not active")
        return _deepcopy(self._baseline)

    def verify_unchanged(self) -> dict:
        if self._baseline is None:
            raise WindowsBindIdentityError("Path identity pin is not active")
        current = self._collect_snapshot()
        if current != self._baseline:
            raise WindowsBindIdentityError(
                "Pinned Windows path identity changed during the operation"
            )
        return _deepcopy(current)

    def _collect_snapshot(self) -> dict:
        result = {}
        for request, handles in self._handle_records:
            identities = []
            for index, (path, handle) in enumerate(handles):
                expected_kind = "directory" if index < len(handles) - 1 else request["kind"]
                single_link = request["single_link"] if index == len(handles) - 1 else False
                identities.append(_inspect_identity(
                    self._backend, handle, path, expected_kind, single_link
                ))
            self._validate_path_chain(identities)
            result[request["label"]] = _request_snapshot(request, identities)
        return result

    @staticmethod
    def _validate_path_chain(identities: list[dict]) -> None:
        if not identities:
            raise WindowsBindIdentityError("Pinned path has no root component")
        root = identities[0]
        root_prefix = f"\\\\?\\Volume{{{root['volume_guid']}}}\\"
        if root["kind"] != "directory" or root["final_path"].casefold() != root_prefix.casefold():
            raise WindowsBindIdentityError(
                "Drive root resolves through a path alias or non-root mount"
            )
        parent = root
        for current in identities[1:]:
            if (current["volume_guid"] != root["volume_guid"]
                    or current["volume_serial_hex"] != root["volume_serial_hex"]):
                raise WindowsBindIdentityError(
                    "Pinned path crosses a volume boundary or mount point"
                )
            basename = current["canonical_input"].rsplit("\\", 1)[-1]
            expected = parent["final_path"].rstrip("\\") + "\\" + basename
            if current["final_path"].casefold() != expected.casefold():
                raise WindowsBindIdentityError(
                    "Pinned path component does not match its normalized parent"
                )
            parent = current

    def _close_handles(self, body_error):
        errors = []
        for handle in reversed(self._handles):
            try:
                closed = self._backend.close(handle)
                if closed is False:
                    raise WindowsBindIdentityError("Could not close a pinned Windows path handle")
            except BaseException as error:
                errors.append(error)
        self._handles.clear()
        if errors:
            if body_error is not None:
                add_note = getattr(body_error, "add_note", None)
                if add_note is not None:
                    add_note(f"Also failed to close {len(errors)} Windows identity handle(s)")
            else:
                raise WindowsBindIdentityError(
                    "Could not close all pinned Windows path handles"
                ) from errors[0]

    def __exit__(self, exc_type, exc, traceback):
        self._close_handles(exc)
        self._baseline = None
        self._handle_records.clear()
        return False


def _deepcopy(value):
    if isinstance(value, dict):
        return {key: _deepcopy(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_deepcopy(item) for item in value]
    return value


def _request_snapshot(request, identities):
    return {
        "label": request["label"],
        "canonical_input": request["canonical_input"],
        "kind": request["kind"],
        "single_link": request["single_link"],
        "target": identities[-1],
        "ancestors": identities[:-1],
    }


class _NativeWindowsBackend:
    def __init__(self):
        if os.name != "nt":
            raise WindowsBindIdentityError("Native Windows path identity is required")
        from ctypes import wintypes

        self._ctypes = ctypes
        self._wintypes = wintypes
        self._kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel = self._kernel
        kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                       ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD,
                                       wintypes.HANDLE]
        kernel.CreateFileW.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        kernel.GetFileInformationByHandleEx.argtypes = [
            wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD
        ]
        kernel.GetFileInformationByHandleEx.restype = wintypes.BOOL
        kernel.GetFinalPathNameByHandleW.argtypes = [
            wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD
        ]
        kernel.GetFinalPathNameByHandleW.restype = wintypes.DWORD
        kernel.GetVolumeInformationByHandleW.argtypes = [
            wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(wintypes.DWORD),
            ctypes.POINTER(wintypes.DWORD), wintypes.LPWSTR, wintypes.DWORD
        ]
        kernel.GetVolumeInformationByHandleW.restype = wintypes.BOOL
        kernel.GetDriveTypeW.argtypes = [wintypes.LPCWSTR]
        kernel.GetDriveTypeW.restype = wintypes.UINT

        class FileAttributeTagInfo(ctypes.Structure):
            _fields_ = [("attributes", wintypes.DWORD), ("tag", wintypes.DWORD)]

        class FileStandardInfo(ctypes.Structure):
            _fields_ = [
                ("allocation_size", ctypes.c_longlong),
                ("end_of_file", ctypes.c_longlong),
                ("number_of_links", wintypes.DWORD),
                ("delete_pending", wintypes.BOOLEAN),
                ("directory", wintypes.BOOLEAN),
            ]

        class FileIdInfo(ctypes.Structure):
            _fields_ = [("volume_serial_number", ctypes.c_uint64),
                        ("file_id", ctypes.c_ubyte * 16)]

        self._FileAttributeTagInfo = FileAttributeTagInfo
        self._FileStandardInfo = FileStandardInfo
        self._FileIdInfo = FileIdInfo

    def open(self, path: str):
        extended_path = "\\\\?\\" + path
        handle = self._kernel.CreateFileW(
            extended_path,
            _FILE_READ_ATTRIBUTES,
            _FILE_SHARE_READ | _FILE_SHARE_WRITE,
            None,
            _OPEN_EXISTING,
            _FILE_FLAG_BACKUP_SEMANTICS | _FILE_FLAG_OPEN_REPARSE_POINT,
            None,
        )
        invalid = ctypes.c_void_p(-1).value
        if handle == invalid or handle is None or handle == 0:
            self._raise_last_error("CreateFileW")
        return _NativeHandle(handle, path[:3])

    def inspect(self, handle):
        attribute_info = self._FileAttributeTagInfo()
        standard_info = self._FileStandardInfo()
        file_id_info = self._FileIdInfo()
        self._query(handle, _FILE_ATTRIBUTE_TAG_INFO_CLASS, attribute_info, "FileAttributeTagInfo")
        self._query(handle, _FILE_STANDARD_INFO_CLASS, standard_info, "FileStandardInfo")
        self._query(handle, _FILE_ID_INFO_CLASS, file_id_info, "FileIdInfo")

        final_path = self._final_path(handle)
        filesystem_buffer = ctypes.create_unicode_buffer(64)
        serial32 = self._wintypes.DWORD()
        max_component = self._wintypes.DWORD()
        filesystem_flags = self._wintypes.DWORD()
        volume_buffer = ctypes.create_unicode_buffer(64)
        if not self._kernel.GetVolumeInformationByHandleW(
                self._raw_handle(handle), volume_buffer, len(volume_buffer), ctypes.byref(serial32),
                ctypes.byref(max_component), ctypes.byref(filesystem_flags),
                filesystem_buffer, len(filesystem_buffer)):
            self._raise_last_error("GetVolumeInformationByHandleW")
        drive_type = self._kernel.GetDriveTypeW(handle._fullmag_drive_root)
        return {
            "attributes": int(attribute_info.attributes),
            "reparse_tag": int(attribute_info.tag),
            "final_path": final_path,
            "volume_serial": int(file_id_info.volume_serial_number),
            "file_id": bytes(file_id_info.file_id),
            "number_of_links": int(standard_info.number_of_links),
            "is_directory": bool(standard_info.directory),
            "delete_pending": bool(standard_info.delete_pending),
            "filesystem": filesystem_buffer.value,
            "drive_type": int(drive_type),
        }

    def close(self, handle):
        return bool(self._kernel.CloseHandle(self._raw_handle(handle)))

    def _query(self, handle, info_class, value, name):
        raw = self._raw_handle(handle)
        if not self._kernel.GetFileInformationByHandleEx(
                raw, info_class, ctypes.byref(value), ctypes.sizeof(value)):
            self._raise_last_error(f"GetFileInformationByHandleEx({name})")

    def _final_path(self, handle):
        raw = self._raw_handle(handle)
        flags = _FILE_NAME_NORMALIZED | _VOLUME_NAME_GUID
        size = 256
        for _ in range(6):
            if size > 32768:
                break
            buffer = ctypes.create_unicode_buffer(size)
            result = int(self._kernel.GetFinalPathNameByHandleW(raw, buffer, size, flags))
            if not result:
                self._raise_last_error("GetFinalPathNameByHandleW")
            if result < size:
                return buffer.value
            size = result + 1
        raise WindowsBindIdentityError("Native volume GUID path exceeds the supported length")

    @staticmethod
    def _raw_handle(handle):
        return handle.value if isinstance(handle, _NativeHandle) else handle

    @staticmethod
    def _raise_last_error(api_name):
        error = ctypes.WinError(ctypes.get_last_error())
        raise WindowsBindIdentityError(f"{api_name} failed: {error}") from error


class _NativeHandle:
    __slots__ = ("value", "_fullmag_drive_root")

    def __init__(self, value, drive_root):
        self.value = value
        self._fullmag_drive_root = drive_root


def _native_backend():
    return _NativeWindowsBackend()


@contextmanager
def pin_paths(requests: list[dict], *, backend=None):
    """Pin native Windows paths and yield read-only snapshot/verification access.

    ``backend`` is an internal seam for interpreted tests; production callers
    must omit it so native Windows handles supply all path identity evidence.
    ``snapshot`` returns the entry snapshot.  ``verify_unchanged`` freshly
    inspects the still-pinned handles and raises on any identity or policy drift.
    """
    validated = _validate_requests(requests)
    actual_backend = backend if backend is not None else _native_backend()
    if not all(callable(getattr(actual_backend, name, None))
               for name in ("open", "inspect", "close")):
        raise ValueError("Identity backend must implement open, inspect, and close")
    pinned = _PinnedPaths(validated, actual_backend)
    pinned.__enter__()
    try:
        yield pinned
    except BaseException as error:
        pinned._close_handles(error)
        pinned._baseline = None
        pinned._handle_records.clear()
        raise
    else:
        pinned.__exit__(None, None, None)
