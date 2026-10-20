"""Generate a hash-bound third-party notice inventory for the Fullmag installer.

The producer passes the exact archives which were consumed by the managed UI
build. This helper does not treat package metadata or license expressions as
license text: a package is admitted only when its delivered archive contains a
readable legal text file, or an explicitly hash-bound upstream fallback is
validated against the archive's metadata, and the archive bytes match the
producer's hash.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
from urllib.parse import urlparse
import zipfile
from typing import Any, Iterable
import xml.etree.ElementTree as ET


INPUT_SCHEMA = "fullmag.windows-installer-legal-input.v1"
INVENTORY_SCHEMA = "fullmag.windows-installer-third-party-inventory.v1"
FALLBACK_MANIFEST_SCHEMA = "fullmag.windows-installer-license-fallbacks.v1"
_SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
_COMMIT_RE = re.compile(r"^[0-9a-fA-F]{40}$")
_IDENTITY_RE = re.compile(r"^[A-Za-z0-9_.+\-]+$")
_REPOSITORY_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
_HTTPS_URL_RE = re.compile(r"^https://[^\s]+$")
_LICENSE_EXPRESSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.+()|&\- ]*$")
_LEGAL_PREFIXES = (
    "license",
    "licence",
    "notice",
    "copying",
    "copyright",
    "attribution",
    "third_party_notices",
    "third-party-notices",
)
_LEGAL_DIRECTORIES = {"license", "licenses", "licence", "licences", "legal", "notice", "notices"}
_EXCLUDED_NAMES = {"readme", "readme.txt", "readme.md", "readme.rst", "package.nuspec"}


class NoticeGenerationError(ValueError):
    """Raised when the legal input is not complete and hash-bound."""


def _fail(code: str, detail: str) -> NoticeGenerationError:
    return NoticeGenerationError(f"{code}: {detail}")


def _require_mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise _fail("invalid_input", f"{label} must be an object")
    return value


def _require_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise _fail("invalid_input", f"{label} must be a non-empty string")
    return value


def _require_sha256(value: Any, label: str) -> str:
    text = _require_string(value, label)
    if _SHA256_RE.fullmatch(text) is None:
        raise _fail("invalid_input", f"{label} must be a SHA-256 hex digest")
    return text.lower()


def _is_reparse_point(path: Path, metadata: os.stat_result) -> bool:
    """Return whether *path* is a link/reparse point rather than a plain path."""

    # Windows exposes junctions and other reparse points through this
    # attribute; Path.is_symlink() alone does not identify all of them.
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return path.is_symlink() or bool(getattr(metadata, "st_file_attributes", 0) & reparse_flag)


def _assert_no_reparse_ancestors(path: Path, label: str) -> None:
    """Reject links/reparse points in every existing ancestor of *path*."""

    probe = path
    while True:
        try:
            metadata = probe.lstat()
        except FileNotFoundError:
            parent = probe.parent
            if parent == probe:
                return
            probe = parent
            continue
        except OSError as exc:
            raise _fail("path_error", f"{label}: cannot inspect {probe}: {exc}") from exc
        if _is_reparse_point(probe, metadata):
            raise _fail("reparse_path", f"{label} contains a link/reparse point: {probe}")
        parent = probe.parent
        if parent == probe:
            return
        probe = parent


def _safe_regular_file(raw_path: Any, label: str) -> Path:
    raw = _require_string(raw_path, label)
    path = Path(raw)
    if not path.is_absolute():
        raise _fail("invalid_input", f"{label} must be absolute: {raw}")
    _assert_no_reparse_ancestors(path, label)
    try:
        metadata = path.lstat()
    except OSError as exc:
        raise _fail("missing_file", f"{label}: {raw}: {exc}") from exc
    if _is_reparse_point(path, metadata) or not stat.S_ISREG(metadata.st_mode):
        raise _fail("invalid_file", f"{label} must be a regular non-symlink file: {raw}")
    if metadata.st_size <= 0:
        raise _fail("invalid_file", f"{label} must be non-empty: {raw}")
    return path


def _sha256_file(path: Path) -> str:
    with path.open("rb") as stream:
        return _sha256_stream(stream)


def _sha256_stream(stream: Any) -> str:
    digest = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(chunk)
    return digest.hexdigest()


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _decode_legal_text(data: bytes, label: str) -> str:
    if not data:
        raise _fail("empty_legal_text", label)
    try:
        if data.startswith((b"\xff\xfe", b"\xfe\xff")):
            text = data.decode("utf-16")
        elif data.startswith(b"\xef\xbb\xbf"):
            text = data.decode("utf-8-sig")
        else:
            text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise _fail("invalid_legal_text_encoding", label) from exc
    if not text.strip() or "\x00" in text:
        raise _fail("invalid_legal_text", label)
    # Form-feed occurs in several upstream native NOTICE files as ordinary
    # document whitespace. Keep it byte-for-byte in the decoded text.
    if any(ord(char) < 32 and char not in "\r\n\t\f" for char in text):
        raise _fail("invalid_legal_text", f"control character in {label}")
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _normalise_member_name(name: str, archive_label: str) -> str:
    if not name or "\x00" in name:
        raise _fail("invalid_archive_member", f"empty/NUL member in {archive_label}")
    normalised = name.replace("\\", "/")
    if normalised.startswith("/") or re.match(r"^[A-Za-z]:/", normalised):
        raise _fail("archive_path_traversal", f"absolute member {name!r} in {archive_label}")
    parts = normalised.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise _fail("archive_path_traversal", f"unsafe member {name!r} in {archive_label}")
    return "/".join(parts)


def _is_legal_member(name: str) -> bool:
    lowered = name.lower()
    base = lowered.rsplit("/", 1)[-1]
    if base in _EXCLUDED_NAMES or base.endswith(".nuspec"):
        return False
    stem = base.rsplit(".", 1)[0] if "." in base else base
    if any(part in _LEGAL_DIRECTORIES for part in lowered.split("/")[:-1]):
        return True
    return any(stem == prefix or stem.startswith(prefix + "-") or stem.startswith(prefix + "_") for prefix in _LEGAL_PREFIXES)


def _validate_source_file(value: Any, label: str) -> str:
    source_file = _require_string(value, label).replace("\\", "/")
    if (
        source_file.startswith("/")
        or re.match(r"^[A-Za-z]:/", source_file)
        or any(part in ("", ".", "..") for part in source_file.split("/"))
    ):
        raise _fail("invalid_input", f"{label} must be a safe relative source file")
    return source_file


def _validate_fallback_license(value: Any, archive: dict[str, Any]) -> dict[str, Any] | None:
    if value is None:
        return None
    label = f"{archive['kind']} archive {archive['id']} {archive['version']} fallback_license"
    if archive["kind"] != "nuget":
        raise _fail("invalid_fallback_license", f"{label} is only admitted for NuGet archives")
    fallback = _require_mapping(value, label)
    path = _safe_regular_file(fallback.get("path"), f"{label}.path")
    expected_sha256 = _require_sha256(fallback.get("sha256"), f"{label}.sha256")
    repository = _require_string(fallback.get("repository"), f"{label}.repository")
    if _REPOSITORY_RE.fullmatch(repository) is None:
        raise _fail("invalid_fallback_license", f"{label}.repository is not owner/name")
    commit = _require_string(fallback.get("commit"), f"{label}.commit")
    if _COMMIT_RE.fullmatch(commit) is None:
        raise _fail("invalid_fallback_license", f"{label}.commit must be a full commit SHA")
    source_file = _validate_source_file(fallback.get("source_file"), f"{label}.source_file")
    source_url = _require_string(fallback.get("source_url"), f"{label}.source_url")
    if _HTTPS_URL_RE.fullmatch(source_url) is None:
        raise _fail("invalid_fallback_license", f"{label}.source_url must be an HTTPS URL")
    license_expression = _require_string(fallback.get("license_expression"), f"{label}.license_expression")
    if _LICENSE_EXPRESSION_RE.fullmatch(license_expression) is None:
        raise _fail("invalid_fallback_license", f"{label}.license_expression is not a valid SPDX expression")
    parsed_source_url = urlparse(source_url)
    source_parts = parsed_source_url.path.strip("/").split("/")
    if (
        parsed_source_url.netloc.lower() != "raw.githubusercontent.com"
        or len(source_parts) < 4
        or "/".join(source_parts[:2]).casefold() != repository.casefold()
        or source_parts[2].casefold() != commit.casefold()
        or "/".join(source_parts[3:]) != source_file
        or parsed_source_url.query
        or parsed_source_url.fragment
    ):
        raise _fail("invalid_fallback_license", f"{label}.source_url is not bound to repository/commit/source_file")
    return {
        "path": path,
        "sha256": expected_sha256,
        "repository": repository,
        "commit": commit.lower(),
        "source_file": source_file,
        "source_url": source_url,
        "license_expression": license_expression,
    }


def _fallback_legal_file(fallback: dict[str, Any], archive: dict[str, Any], label: str) -> dict[str, Any]:
    # Hash and decode the source text from one handle so a replaced fallback
    # pathname cannot make the recorded source differ from the bytes read.
    try:
        with fallback["path"].open("rb") as stream:
            size_bytes = stream.seek(0, os.SEEK_END)
            stream.seek(0)
            actual_sha256 = _sha256_stream(stream)
            if actual_sha256 != fallback["sha256"]:
                raise _fail("fallback_license_sha256_mismatch", label)
            stream.seek(0)
            data = stream.read()
    except OSError as exc:
        raise _fail("missing_fallback_license", f"{label}: {exc}") from exc
    text = _decode_legal_text(data, label)
    return {
        "member_path": f"fallback/{fallback['source_file']}",
        "size_bytes": size_bytes,
        "sha256": actual_sha256,
        "text_sha256": _sha256_bytes(text.encode("utf-8")),
        "text": text,
        "source": {
            "package_id": archive["id"],
            "package_version": archive["version"],
            "repository": fallback["repository"],
            "commit": fallback["commit"],
            "source_file": fallback["source_file"],
            "source_url": fallback["source_url"],
            "sha256": actual_sha256,
            "license_expression": fallback["license_expression"],
        },
    }


def _parse_nuspec_metadata(data: bytes, label: str) -> dict[str, str | None]:
    try:
        root = ET.fromstring(data)
    except ET.ParseError as exc:
        raise _fail("invalid_nuspec_metadata", label) from exc
    metadata: dict[str, str | None] = {
        "id": None,
        "version": None,
        "license_expression": None,
        "repository_url": None,
        "repository_commit": None,
    }
    for element in root.iter():
        tag = str(element.tag).rsplit("}", 1)[-1].lower()
        if tag in {"id", "version"} and metadata[tag] is None:
            value = (element.text or "").strip()
            if value:
                metadata[tag] = value
        elif tag == "license" and str(element.attrib.get("type", "")).lower() == "expression":
            if metadata["license_expression"] is None:
                value = (element.text or "").strip()
                if value:
                    metadata["license_expression"] = value
        elif tag == "repository":
            if metadata["repository_url"] is None:
                metadata["repository_url"] = str(element.attrib.get("url", "")).strip() or None
                metadata["repository_commit"] = str(element.attrib.get("commit", "")).strip() or None
    return metadata


def _normalise_repository_url(value: str, label: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme.lower() != "https" or parsed.netloc.lower() != "github.com" or parsed.query or parsed.fragment:
        raise _fail("invalid_nuspec_metadata", f"{label} repository URL is not an immutable GitHub HTTPS URL")
    repository = parsed.path.strip("/")
    if repository.lower().endswith(".git"):
        repository = repository[:-4]
    if _REPOSITORY_RE.fullmatch(repository) is None:
        raise _fail("invalid_nuspec_metadata", f"{label} repository URL has an invalid owner/name")
    return repository.lower()


def _validate_fallback_nuspec(metadata: dict[str, str | None], archive: dict[str, Any], label: str) -> None:
    fallback = archive["fallback_license"]
    if metadata["id"] is None or metadata["version"] is None:
        raise _fail("nuspec_identity_mismatch", label)
    if str(metadata["id"]).casefold() != str(archive["id"]).casefold() or str(metadata["version"]) != str(archive["version"]):
        raise _fail("nuspec_identity_mismatch", label)
    if str(metadata["license_expression"]).casefold() != str(fallback["license_expression"]).casefold():
        raise _fail("nuspec_license_expression_mismatch", label)
    if metadata["repository_url"] is None or metadata["repository_commit"] is None:
        raise _fail("nuspec_repository_mapping_missing", label)
    repository = _normalise_repository_url(str(metadata["repository_url"]), label)
    if repository != str(fallback["repository"]).casefold() or str(metadata["repository_commit"]).casefold() != str(fallback["commit"]).casefold():
        raise _fail("nuspec_repository_mapping_mismatch", label)


def _archive_legal_files(path: Path, archive: dict[str, Any]) -> tuple[str, int, list[dict[str, Any]]]:
    label = f"{archive['kind']} archive {archive['id']} {archive['version']}"
    fallback = archive.get("fallback_license")
    try:
        # Hash and parse through the same open handle. This binds the ZIP
        # entries to the bytes that were actually hashed if the pathname is
        # replaced concurrently while generation is in progress.
        with path.open("rb") as stream:
            archive_size = stream.seek(0, os.SEEK_END)
            stream.seek(0)
            actual_hash = _sha256_stream(stream)
            expected_hash = _require_sha256(archive["expected_sha256"], f"{label} sha256")
            if actual_hash != expected_hash:
                raise _fail("archive_sha256_mismatch", f"{archive['id']} {archive['version']}")
            stream.seek(0)
            with zipfile.ZipFile(stream, "r") as container:
                infos = container.infolist()
                seen: set[str] = set()
                seen_casefold: set[str] = set()
                selected: list[dict[str, Any]] = []
                has_license_expression = False
                nuspec_metadata: dict[str, str | None] | None = None
                for info in infos:
                    # ZIP UNIX mode 0120000 denotes a symlink. Check this
                    # before applying any directory handling to the entry.
                    unix_mode = (info.external_attr >> 16) & 0xFFFF
                    if unix_mode and (unix_mode & 0o170000) == 0o120000:
                        raise _fail("invalid_archive_member", f"symlink member {info.filename} in {label}")
                    is_directory = info.filename.endswith(("/", "\\"))
                    raw_name = info.filename.rstrip("/\\") if is_directory else info.filename
                    member = _normalise_member_name(raw_name, label)
                    member_casefold = member.casefold()
                    if member in seen or member_casefold in seen_casefold:
                        raise _fail("duplicate_archive_member", f"{member} in {label}")
                    seen.add(member)
                    seen_casefold.add(member_casefold)
                    if is_directory:
                        continue
                    if member.lower().endswith(".nuspec"):
                        nuspec = container.read(info)
                        if fallback is not None:
                            if nuspec_metadata is not None:
                                raise _fail("duplicate_nuspec", label)
                            nuspec_metadata = _parse_nuspec_metadata(nuspec, f"{label}/{member}")
                        if re.search(
                            rb"<license\b[^>]*\btype\s*=\s*(['\"])expression\1[^>]*>",
                            nuspec,
                            re.IGNORECASE,
                        ):
                            has_license_expression = True
                        continue
                    if not _is_legal_member(member):
                        continue
                    data = container.read(info)
                    text = _decode_legal_text(data, f"{label}/{member}")
                    selected.append(
                        {
                            "member_path": member,
                            "size_bytes": len(data),
                            "sha256": _sha256_bytes(data),
                            "text_sha256": _sha256_bytes(text.encode("utf-8")),
                            "text": text,
                        }
                    )
    except zipfile.BadZipFile as exc:
        raise _fail("invalid_archive", f"{label}: {exc}") from exc
    if not selected:
        if fallback is None:
            raise _fail("missing_legal_text", label)
        if not has_license_expression:
            raise _fail("fallback_requires_license_expression", label)
        if nuspec_metadata is None:
            raise _fail("fallback_requires_license_expression", label)
        _validate_fallback_nuspec(nuspec_metadata, archive, label)
        selected = [_fallback_legal_file(fallback, archive, label)]
    elif fallback is not None:
        raise _fail("fallback_license_unneeded", label)
    selected.sort(key=lambda item: str(item["member_path"]).lower())
    required_hash = archive.get("required_member_sha256")
    if required_hash is not None:
        required_hash = _require_sha256(required_hash, f"{label} required_member_sha256")
        if not any(item["sha256"] == required_hash for item in selected):
            raise _fail("required_member_hash_mismatch", f"{label}: {required_hash}")
    return actual_hash, archive_size, selected


def _validate_request(request: Any) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    root = _require_mapping(request, "request")
    if root.get("schema") != INPUT_SCHEMA:
        raise _fail("invalid_input", f"unsupported schema: {root.get('schema')!r}")
    root_notice = _require_mapping(root.get("root_notice"), "root_notice")
    root_notice_path = _safe_regular_file(root_notice.get("path"), "root_notice.path")
    expected_root_hash = _require_sha256(root_notice.get("sha256"), "root_notice.sha256")
    actual_root_hash = _sha256_file(root_notice_path)
    if actual_root_hash != expected_root_hash:
        raise _fail("root_notice_sha256_mismatch", str(root_notice_path))
    fallback_manifest = None
    raw_fallback_manifest = root.get("fallback_manifest")
    if raw_fallback_manifest is not None:
        manifest = _require_mapping(raw_fallback_manifest, "fallback_manifest")
        if manifest.get("schema") != FALLBACK_MANIFEST_SCHEMA:
            raise _fail("invalid_input", f"unsupported fallback manifest schema: {manifest.get('schema')!r}")
        fallback_manifest = {
            "schema": FALLBACK_MANIFEST_SCHEMA,
            "filename": _validate_source_file(manifest.get("filename"), "fallback_manifest.filename"),
            "sha256": _require_sha256(manifest.get("sha256"), "fallback_manifest.sha256"),
        }
    raw_archives = root.get("archives")
    if not isinstance(raw_archives, list) or not raw_archives:
        raise _fail("invalid_input", "archives must be a non-empty array")
    archives: list[dict[str, Any]] = []
    seen_identities: set[tuple[str, str, str]] = set()
    for index, raw_archive in enumerate(raw_archives):
        archive = _require_mapping(raw_archive, f"archives[{index}]")
        kind = _require_string(archive.get("kind"), f"archives[{index}].kind").lower()
        if kind not in {"nuget", "runtime_pack", "wix"}:
            raise _fail("invalid_input", f"archives[{index}].kind is not admitted: {kind}")
        package_id = _require_string(archive.get("id"), f"archives[{index}].id")
        version = _require_string(archive.get("version"), f"archives[{index}].version")
        if _IDENTITY_RE.fullmatch(package_id) is None or _IDENTITY_RE.fullmatch(version) is None:
            raise _fail("invalid_input", f"unsafe package identity at archives[{index}]")
        identity = (kind, package_id.lower(), version.lower())
        if identity in seen_identities:
            raise _fail("duplicate_archive_identity", f"{kind}/{package_id}/{version}")
        seen_identities.add(identity)
        archive_path = _safe_regular_file(archive.get("path"), f"archives[{index}].path")
        expected_hash = _require_sha256(archive.get("sha256"), f"archives[{index}].sha256")
        fallback_license = _validate_fallback_license(archive.get("fallback_license"), {
            "kind": kind,
            "id": package_id,
            "version": version,
        })
        if fallback_license is not None and fallback_manifest is None:
            raise _fail("invalid_fallback_license", f"{kind} archive {package_id} {version} has no fallback_manifest")
        archives.append(
            {
                "kind": kind,
                "id": package_id,
                "version": version,
                "path": archive_path,
                "expected_sha256": expected_hash,
                "required_member_sha256": archive.get("required_member_sha256"),
                "fallback_license": fallback_license,
            }
        )
    if fallback_manifest is not None and not any(archive["fallback_license"] is not None for archive in archives):
        raise _fail("unused_fallback_manifest", fallback_manifest["filename"])
    return {
        "path": root_notice_path,
        "sha256": actual_root_hash,
        "fallback_manifest": fallback_manifest,
    }, archives


def _notices_text(archives: Iterable[dict[str, Any]]) -> str:
    lines = [
        "Fullmag third-party notices",
        "Generated from the exact hash-bound archives listed in THIRD_PARTY_NOTICES.json.",
        "",
    ]
    for archive in archives:
        lines.extend(
            [
                f"Package: {archive['id']} {archive['version']}",
                f"Kind: {archive['kind']}",
                f"Archive SHA-256: {archive['archive_sha256']}",
                "",
            ]
        )
        for legal_file in archive["_legal_files"]:
            lines.extend(
                [
                    f"Legal file: {legal_file['member_path']}",
                    f"File SHA-256: {legal_file['sha256']}",
                    f"Text SHA-256: {legal_file['text_sha256']}",
                ]
            )
            source = legal_file.get("source")
            if source is not None:
                lines.extend(
                    [
                        f"License source repository: {source['repository']}",
                        f"License source commit: {source['commit']}",
                        f"License source file: {source['source_file']}",
                        f"License source URL: {source['source_url']}",
                        f"License source SHA-256: {source['sha256']}",
                        f"License expression: {source['license_expression']}",
                    ]
                )
            lines.extend(
                [
                    "----- BEGIN LEGAL TEXT -----",
                    legal_file["text"].rstrip("\n"),
                    "----- END LEGAL TEXT -----",
                    "",
                ]
            )
        lines.append("============================================================")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def generate(request: Any, input_manifest_sha256: str | None = None) -> tuple[str, dict[str, Any]]:
    """Return deterministic notice text and its hash-bound inventory."""

    root_notice, archives = _validate_request(request)
    if input_manifest_sha256 is not None:
        input_manifest_sha256 = _require_sha256(input_manifest_sha256, "input_manifest_sha256")
    inventory_archives: list[dict[str, Any]] = []
    for archive in archives:
        archive_sha256, archive_size, legal_files = _archive_legal_files(archive["path"], archive)
        inventory_archives.append(
            {
                "kind": archive["kind"],
                "id": archive["id"],
                "version": archive["version"],
                "archive_filename": archive["path"].name,
                "archive_sha256": archive_sha256,
                "archive_size_bytes": archive_size,
                "legal_files": [
                    {key: value for key, value in legal_file.items() if key != "text"}
                    for legal_file in legal_files
                ],
                "_legal_files": legal_files,
            }
        )
    inventory_archives.sort(key=lambda item: (item["kind"], item["id"].lower(), item["version"].lower()))
    notices = _notices_text(inventory_archives)
    public_archives = []
    for archive in inventory_archives:
        public_archives.append({key: value for key, value in archive.items() if key != "_legal_files"})
    inventory: dict[str, Any] = {
        "schema": INVENTORY_SCHEMA,
        "inventory_scope": "restored_dependency_superset+runtime_packs",
        "root_notice": {
            "filename": root_notice["path"].name,
            "sha256": root_notice["sha256"],
            "size_bytes": root_notice["path"].stat().st_size,
        },
        "archives": public_archives,
        "archive_count": len(public_archives),
        "legal_file_count": sum(len(item["legal_files"]) for item in public_archives),
        "third_party_notices_filename": "THIRD_PARTY_NOTICES",
        "third_party_notices_sha256": _sha256_bytes(notices.encode("utf-8")),
    }
    if root_notice["fallback_manifest"] is not None:
        inventory["fallback_manifest"] = root_notice["fallback_manifest"]
    if input_manifest_sha256 is not None:
        inventory["input_manifest_sha256"] = input_manifest_sha256
    return notices, inventory


def _write_new_file(path: Path, data: bytes) -> None:
    if not path.is_absolute():
        raise _fail("invalid_input", f"output must be absolute: {path}")
    _assert_no_reparse_ancestors(path, "output path")
    if path.exists() or path.is_symlink():
        raise _fail("output_exists", str(path))
    path.parent.mkdir(parents=True, exist_ok=True)
    _assert_no_reparse_ancestors(path, "output path")
    temporary = path.with_name(path.name + ".tmp")
    _assert_no_reparse_ancestors(temporary, "output temporary path")
    if temporary.exists() or temporary.is_symlink():
        raise _fail("output_exists", str(temporary))
    try:
        temporary.write_bytes(data)
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", required=True, type=Path)
    parser.add_argument("--notices-output", required=True, type=Path)
    parser.add_argument("--inventory-output", required=True, type=Path)
    parser.add_argument("--input-manifest-sha256", type=str)
    args = parser.parse_args(argv)
    try:
        request_path = _safe_regular_file(str(args.request), "request")
        request_bytes = request_path.read_bytes()
        request_sha256 = _sha256_bytes(request_bytes)
        if args.input_manifest_sha256 is not None and request_sha256 != _require_sha256(
            args.input_manifest_sha256, "input_manifest_sha256"
        ):
            raise _fail("input_manifest_sha256_mismatch", str(request_path))
        request = json.loads(request_bytes)
        notices, inventory = generate(request, request_sha256)
        _write_new_file(args.notices_output, notices.encode("utf-8"))
        _write_new_file(
            args.inventory_output,
            (json.dumps(inventory, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8"),
        )
    except (NoticeGenerationError, OSError, json.JSONDecodeError) as exc:
        print(f"third-party notices generation failed: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
