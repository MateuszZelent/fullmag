"""Byte-verified reader for frequency-domain artifact generations.

This stdlib-only module mirrors crates/fullmag-runner's v1/v2 generation
contract. A capture binds marker bytes, producer and declared logical members;
it never discovers members by scanning the artifact tree.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
from types import MappingProxyType
from typing import Any, BinaryIO, Mapping


COMMIT_PATH = "frequency_domain/generation.v1.json"
IMMUTABLE_COMMIT_PATH = "frequency_domain/generation.v2.json"
GENERATION_DIRECTORY = "frequency_domain/generations"
SCHEMA_V1 = "frequency_domain_artifact_generation.v1"
SCHEMA_V2 = "frequency_domain_artifact_generation.v2"
MAX_COMMIT_BYTES = 4 * 1024 * 1024
DEFAULT_MAX_JSON_BYTES = 4 * 1024 * 1024
_HASH_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
_RESERVED_MEMBER_PATHS = (
    COMMIT_PATH,
    IMMUTABLE_COMMIT_PATH,
    "WRITER.owner.json",
    GENERATION_DIRECTORY,
)
_REPARSE_POINT_ATTRIBUTE = 0x400
_READ_CHUNK_BYTES = 1024 * 1024


class GenerationError(ValueError):
    """A marker or member does not satisfy the generation contract."""


@dataclass(frozen=True)
class PublicationOwner:
    run_id: str
    stage_id: str
    stage_kind: str


@dataclass(frozen=True)
class GenerationMember:
    byte_length: int
    sha256: str


@dataclass(frozen=True)
class GenerationCapture:
    """Captured selector. A v1 capture is byte-verified but remains mutable."""

    root: Path
    marker_path: str
    marker_sha256: str
    generation_id: str
    schema_version: str
    producer: PublicationOwner | None
    members: Mapping[str, GenerationMember]
    _source_root: Path = field(repr=False, compare=False)

    def is_immutable(self) -> bool:
        return self.schema_version == SCHEMA_V2

    @property
    def member_root(self) -> Path:
        """Physical tree for logical paths; use read_member for verified bytes."""
        if self.is_immutable():
            return self.root / GENERATION_DIRECTORY / self.generation_id[7:]
        return self.root

    def iter_members(self, prefix: str | None = None) -> tuple[str, ...]:
        """Return declared logical members only; this never scans the filesystem."""
        if prefix is None:
            return tuple(sorted(self.members))
        if not isinstance(prefix, str):
            raise GenerationError("member prefix must be a string")
        normalized = prefix[:-1] if prefix.endswith("/") else prefix
        _validate_member_path(normalized)
        return tuple(
            name for name in sorted(self.members)
            if name == normalized or name.startswith(normalized + "/")
        )

    def ensure_current(self) -> None:
        current = capture(self._source_root)
        if (
            current is None
            or current.marker_sha256 != self.marker_sha256
            or current.generation_id != self.generation_id
            or current.schema_version != self.schema_version
            or current.root != self.root
        ):
            raise GenerationError("frequency-domain generation changed")

    def _expected_member(self, relative: str) -> GenerationMember:
        _validate_member_path(relative)
        expected = self.members.get(relative)
        if expected is None:
            raise GenerationError("artifact is not a member of the captured generation")
        return expected

    def _physical_member_path(self, relative: str) -> Path:
        self._expected_member(relative)
        if self.is_immutable():
            physical = f"{GENERATION_DIRECTORY}/{self.generation_id[7:]}/{relative}"
        else:
            physical = relative
        path = _checked_path(self.root, physical, allow_missing=False)
        assert path is not None
        return path

    def _open_member(self, relative: str, expected: GenerationMember) -> BinaryIO:
        path = self._physical_member_path(relative)
        descriptor: int | None = None
        try:
            before = os.lstat(path)
            _reject_link_or_reparse(before, "generation member")
            if not stat.S_ISREG(before.st_mode):
                raise GenerationError("generation member is not a regular file")
            flags = os.O_RDONLY | getattr(os, "O_BINARY", 0)
            flags |= getattr(os, "O_NOFOLLOW", 0)
            descriptor = os.open(path, flags)
            opened = os.fstat(descriptor)
            if (
                not stat.S_ISREG(opened.st_mode)
                or not os.path.samestat(before, opened)
            ):
                raise GenerationError("generation member changed while opening")
            if opened.st_size != expected.byte_length:
                raise GenerationError("generation member length changed")
            stream = os.fdopen(descriptor, "rb")
            descriptor = None  # The stream now owns the descriptor.
            return stream
        except GenerationError:
            raise
        except OSError as error:
            raise GenerationError(f"cannot open generation member: {error}") from error
        finally:
            if descriptor is not None:
                try:
                    os.close(descriptor)
                except OSError:
                    pass

    def verify_member(self, relative: str) -> GenerationMember:
        """Stream-hash a member without retaining a large duplicate buffer."""
        expected = self._expected_member(relative)
        measured_hash = hashlib.sha256()
        measured_length = 0
        with self._open_member(relative, expected) as stream:
            while True:
                remaining = expected.byte_length - measured_length
                chunk = stream.read(min(_READ_CHUNK_BYTES, remaining + 1))
                if not chunk:
                    break
                measured_length += len(chunk)
                if measured_length > expected.byte_length:
                    raise GenerationError("generation member length changed")
                measured_hash.update(chunk)
        actual_digest = "sha256:" + measured_hash.hexdigest()
        if measured_length != expected.byte_length or actual_digest != expected.sha256:
            raise GenerationError("frequency-domain generation member changed")
        self.ensure_current()
        return expected

    def read_member(
        self,
        relative: str,
        maximum_bytes: int | None = None,
    ) -> bytes:
        """Return the exact bytes whose length/hash were verified, then fence current."""
        expected = self._expected_member(relative)
        if maximum_bytes is not None:
            if (
                isinstance(maximum_bytes, bool)
                or not isinstance(maximum_bytes, int)
                or maximum_bytes < 0
            ):
                raise GenerationError("member read bound must be a nonnegative integer")
            if expected.byte_length > maximum_bytes:
                raise GenerationError("generation member exceeds reader byte budget")
        if expected.byte_length > sys.maxsize - 1:
            raise GenerationError("generation member exceeds addressable memory")
        with self._open_member(relative, expected) as stream:
            data = stream.read(expected.byte_length + 1)
        if (
            len(data) != expected.byte_length
            or "sha256:" + hashlib.sha256(data).hexdigest() != expected.sha256
        ):
            raise GenerationError("frequency-domain generation member changed")
        self.ensure_current()
        return data

    def read_json_member(
        self,
        relative: str,
        maximum_bytes: int = DEFAULT_MAX_JSON_BYTES,
    ) -> Any:
        """Read bounded UTF-8 JSON, rejecting duplicate keys and nonstandard constants."""
        if (
            isinstance(maximum_bytes, bool)
            or not isinstance(maximum_bytes, int)
            or maximum_bytes < 0
        ):
            raise GenerationError("JSON byte bound must be a nonnegative integer")
        raw = self.read_member(relative, maximum_bytes=maximum_bytes)
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as error:
            raise GenerationError("generation JSON member is not UTF-8") from error
        return _decode_json(text, f"generation member {relative}")


def _reject_link_or_reparse(metadata: os.stat_result, label: str) -> None:
    if stat.S_ISLNK(metadata.st_mode) or (
        getattr(metadata, "st_file_attributes", 0) & _REPARSE_POINT_ATTRIBUTE
    ):
        raise GenerationError(f"{label} contains a symlink or reparse point")


def _checked_root(root: os.PathLike[str] | str) -> Path | None:
    try:
        absolute = Path(os.path.abspath(os.fspath(root)))
    except (TypeError, ValueError, OSError) as error:
        raise GenerationError(f"invalid generation root: {error}") from error
    parts = absolute.parts
    if not parts:
        raise GenerationError("generation root is empty")
    current = Path(parts[0])
    try:
        metadata = os.lstat(current)
    except FileNotFoundError:
        return None
    except OSError as error:
        raise GenerationError(f"cannot inspect generation root: {error}") from error
    _reject_link_or_reparse(metadata, "generation root")
    if not stat.S_ISDIR(metadata.st_mode):
        raise GenerationError("generation root is not a directory")
    for part in parts[1:]:
        current = current / part
        try:
            metadata = os.lstat(current)
        except FileNotFoundError:
            return None
        except OSError as error:
            raise GenerationError(f"cannot inspect generation root: {error}") from error
        _reject_link_or_reparse(metadata, "generation root")
        if not stat.S_ISDIR(metadata.st_mode):
            raise GenerationError("generation root traverses a non-directory")
    try:
        return absolute.resolve(strict=True)
    except OSError as error:
        raise GenerationError(f"cannot resolve generation root: {error}") from error


def _checked_path(
    root: Path,
    relative: str,
    *,
    allow_missing: bool,
) -> Path | None:
    parts = relative.split("/")
    current = root
    for index, part in enumerate(parts):
        current = current / part
        try:
            metadata = os.lstat(current)
        except FileNotFoundError:
            if allow_missing:
                return None
            raise GenerationError(f"generation path is missing: {relative}")
        except OSError as error:
            raise GenerationError(f"cannot inspect generation path: {error}") from error
        _reject_link_or_reparse(metadata, "generation path")
        final = index == len(parts) - 1
        if final:
            if not stat.S_ISREG(metadata.st_mode):
                raise GenerationError("generation path is not a regular file")
        elif not stat.S_ISDIR(metadata.st_mode):
            raise GenerationError("generation path contains a non-directory")
    return current


def _validate_relative_path(relative: str) -> None:
    if (
        not relative
        or "\\" in relative
        or ":" in relative
        or "\x00" in relative
        or relative.startswith("/")
    ):
        raise GenerationError("generation member path is not canonical relative")
    parts = relative.split("/")
    if any(not part or part in (".", "..") for part in parts):
        raise GenerationError("generation member path escapes its publication")


def _validate_member_path(relative: str) -> None:
    if not isinstance(relative, str):
        raise GenerationError("generation member path must be a string")
    _validate_relative_path(relative)
    if any(
        relative == reserved or relative.startswith(reserved + "/")
        for reserved in _RESERVED_MEMBER_PATHS
    ):
        raise GenerationError("generation member uses a reserved publication path")


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise GenerationError(f"duplicate JSON object key: {key}")
        result[key] = value
    return result


def _reject_json_constant(value: str) -> None:
    raise GenerationError(f"nonstandard JSON constant: {value}")


def _decode_json(text: str, label: str) -> Any:
    try:
        return json.loads(
            text,
            object_pairs_hook=_unique_object,
            parse_constant=_reject_json_constant,
        )
    except GenerationError:
        raise
    except (json.JSONDecodeError, UnicodeError, ValueError) as error:
        raise GenerationError(f"invalid JSON in {label}: {error}") from error


def _valid_digest(value: Any) -> bool:
    return isinstance(value, str) and _HASH_PATTERN.fullmatch(value) is not None


def _canonical_content(
    schema_version: str,
    producer: PublicationOwner | None,
    members: Mapping[str, GenerationMember],
) -> dict[str, Any]:
    if producer is None:
        producer_value = None
    else:
        producer_value = {
            "run_id": producer.run_id,
            "stage_id": producer.stage_id,
            "stage_kind": producer.stage_kind,
        }
    member_values = {
        path: {"byte_length": members[path].byte_length, "sha256": members[path].sha256}
        for path in sorted(members)
    }
    return {
        "schema_version": schema_version,
        "producer": producer_value,
        "members": member_values,
    }


def _sha256_json(value: Any, *, pretty: bool) -> bytes:
    try:
        if pretty:
            text = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False)
        else:
            text = json.dumps(
                value,
                ensure_ascii=False,
                separators=(",", ":"),
                allow_nan=False,
            )
        return text.encode("utf-8")
    except (TypeError, ValueError, UnicodeError) as error:
        raise GenerationError(f"cannot serialize canonical generation JSON: {error}") from error


def _parse_commit(
    raw: bytes,
    *,
    expected_schema: str,
) -> tuple[str, PublicationOwner | None, Mapping[str, GenerationMember]]:
    if len(raw) > MAX_COMMIT_BYTES:
        raise GenerationError("generation commit exceeds control-plane bound")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise GenerationError("generation commit is not UTF-8") from error
    value = _decode_json(text, "generation commit")
    if not isinstance(value, dict) or set(value) != {"generation_id", "content"}:
        raise GenerationError("invalid generation commit fields")
    generation_id = value["generation_id"]
    content_value = value["content"]
    if not _valid_digest(generation_id):
        raise GenerationError("generation ID is not a canonical SHA-256 digest")
    if not isinstance(content_value, dict) or set(content_value) != {
        "schema_version", "producer", "members"
    }:
        raise GenerationError("invalid generation body fields")
    schema_version = content_value["schema_version"]
    if schema_version != expected_schema:
        raise GenerationError("generation schema does not match its marker")

    producer_value = content_value["producer"]
    producer: PublicationOwner | None
    if producer_value is None:
        producer = None
    else:
        if not isinstance(producer_value, dict) or set(producer_value) != {
            "run_id", "stage_id", "stage_kind"
        }:
            raise GenerationError("invalid generation producer fields")
        fields = (
            producer_value["run_id"],
            producer_value["stage_id"],
            producer_value["stage_kind"],
        )
        if any(not isinstance(item, str) or not item.strip() for item in fields):
            raise GenerationError("incomplete generation producer identity")
        producer = PublicationOwner(*fields)

    raw_members = content_value["members"]
    if not isinstance(raw_members, dict) or not raw_members:
        raise GenerationError("generation member map must be a nonempty object")
    members: dict[str, GenerationMember] = {}
    for path, member_value in raw_members.items():
        _validate_member_path(path)
        if not isinstance(member_value, dict) or set(member_value) != {
            "byte_length", "sha256"
        }:
            raise GenerationError("invalid generation member fields")
        byte_length = member_value["byte_length"]
        member_digest = member_value["sha256"]
        if (
            isinstance(byte_length, bool)
            or not isinstance(byte_length, int)
            or byte_length < 0
            or byte_length > (1 << 64) - 1
        ):
            raise GenerationError("generation member length is not a u64")
        if not _valid_digest(member_digest):
            raise GenerationError("generation member SHA-256 is invalid")
        members[path] = GenerationMember(byte_length, member_digest)

    canonical_content = _canonical_content(schema_version, producer, members)
    body_bytes = _sha256_json(canonical_content, pretty=False)
    actual_generation_id = "sha256:" + hashlib.sha256(body_bytes).hexdigest()
    if actual_generation_id != generation_id:
        raise GenerationError("generation ID does not match its body")
    canonical_marker = _sha256_json(
        {"generation_id": generation_id, "content": canonical_content},
        pretty=True,
    )
    if canonical_marker != raw:
        raise GenerationError("generation commit is not canonical")
    return generation_id, producer, MappingProxyType(dict(sorted(members.items())))


def _read_marker(root: Path, relative: str) -> bytes | None:
    marker = _checked_path(root, relative, allow_missing=True)
    if marker is None:
        return None
    descriptor: int | None = None
    try:
        before = os.lstat(marker)
        _reject_link_or_reparse(before, "generation commit")
        if not stat.S_ISREG(before.st_mode):
            raise GenerationError("generation commit is not a regular file")
        if before.st_size > MAX_COMMIT_BYTES:
            raise GenerationError("generation commit exceeds control-plane bound")
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(marker, flags)
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened.st_mode)
            or not os.path.samestat(before, opened)
            or opened.st_size > MAX_COMMIT_BYTES
        ):
            raise GenerationError("generation commit changed while opening")
        stream = os.fdopen(descriptor, "rb")
        descriptor = None  # The stream now owns the descriptor.
        with stream:
            raw = stream.read(MAX_COMMIT_BYTES + 1)
    except GenerationError:
        raise
    except OSError as error:
        raise GenerationError(f"cannot read generation commit: {error}") from error
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
    if len(raw) > MAX_COMMIT_BYTES:
        raise GenerationError("generation commit exceeds control-plane bound")
    if len(raw) != before.st_size:
        raise GenerationError("generation commit changed while reading")
    return raw


def capture(root: os.PathLike[str] | str) -> GenerationCapture | None:
    """Capture v2 first, then v1. A present malformed v2 always fails closed."""
    checked_root = _checked_root(root)
    if checked_root is None:
        return None
    marker_bytes = _read_marker(checked_root, IMMUTABLE_COMMIT_PATH)
    if marker_bytes is not None:
        marker_path = IMMUTABLE_COMMIT_PATH
        expected_schema = SCHEMA_V2
    else:
        marker_bytes = _read_marker(checked_root, COMMIT_PATH)
        if marker_bytes is None:
            return None
        marker_path = COMMIT_PATH
        expected_schema = SCHEMA_V1
    generation_id, producer, members = _parse_commit(
        marker_bytes,
        expected_schema=expected_schema,
    )
    return GenerationCapture(
        root=checked_root,
        marker_path=marker_path,
        marker_sha256="sha256:" + hashlib.sha256(marker_bytes).hexdigest(),
        generation_id=generation_id,
        schema_version=expected_schema,
        producer=producer,
        members=members,
        _source_root=Path(os.path.abspath(os.fspath(root))),
    )
