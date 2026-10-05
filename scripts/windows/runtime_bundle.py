#!/usr/bin/env python3
"""Stage a source-pinned set of native Windows executables outside Cargo's target tree."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


_SCRIPTS_ROOT = Path(__file__).resolve().parents[1]
if str(_SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_ROOT))


BUNDLE_SCHEMA = "fullmag.native-runtime-bundle.v1"
SOURCE_SCHEMA_VERSION = 1
COMPILER_PROFILES = {"dev": "backend-dev", "release": "release"}

# Keep this list aligned with the Cargo binary targets used by the native
# launcher. The openapi-codegen-only target is intentionally excluded.
BINARY_NAMES = (
    "fullmag.exe",
    "fullmag-api.exe",
    "fullmag-ui.exe",
    "fullmag-api-accepted-worker.exe",
    "fullmag-api-accepted-fem-preparer.exe",
    "fullmag-api-accepted-fem-preparation-supervisor.exe",
    "fullmag-api-accepted-fem-preparation-scheduler.exe",
    "fullmag-api-accepted-supervisor.exe",
    "fullmag-api-accepted-scheduler.exe",
    "fullmag-runtime-service.exe",
    "fullmag-api-resource-pool.exe",
    "fullmag-api-preparation-resource-pool.exe",
    "fullmag-api-preparation-retry.exe",
)
DECLARED_HASH_FIELDS = {
    "fullmag.exe": "binary_sha256",
    "fullmag-api.exe": "api_binary_sha256",
    "fullmag-ui.exe": "desktop_binary_sha256",
}
SOURCE_PATH_FIELDS = {
    "fullmag.exe": "binary",
    "fullmag-api.exe": "api_binary",
    "fullmag-ui.exe": "desktop_binary",
}
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
GIT_COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
SAFE_COMPONENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
BUNDLE_ID_RE = re.compile(r"^[0-9a-f]{32}$")


class BundleError(ValueError):
    """Input or bundle validation failed."""


def _is_reparse_point(path: Path, info: os.stat_result | None = None) -> bool:
    if info is None:
        try:
            info = path.lstat()
        except FileNotFoundError:
            return False
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0) & 0x400
    )


def _absolute_path(value: str | os.PathLike[str], label: str) -> Path:
    raw_path = Path(os.fspath(value))
    if not raw_path.is_absolute():
        raise BundleError(f"{label} must be absolute: {raw_path}")
    return Path(os.path.abspath(os.fspath(raw_path)))


def _check_path_chain(path: Path, label: str, *, allow_missing: bool = False) -> None:
    """Reject symlinks/junctions in every existing component of a path."""
    absolute = _absolute_path(path, label)
    components = list(reversed(absolute.parents)) + [absolute]
    previous = None
    for component in components:
        if not os.path.lexists(component):
            if allow_missing:
                previous = component
                continue
            raise BundleError(f"{label} path does not exist: {component}")
        try:
            info = component.lstat()
        except OSError as error:
            raise BundleError(f"Cannot inspect {label} path {component}: {error}") from error
        if _is_reparse_point(component, info):
            raise BundleError(f"{label} contains a symlink or reparse point: {component}")
        if previous is not None and not previous.exists():
            raise BundleError(f"{label} has a missing parent before {component}")
        if component != absolute and not stat.S_ISDIR(info.st_mode):
            raise BundleError(f"{label} ancestor is not a directory: {component}")
        previous = component


def _require_directory(value: str | os.PathLike[str], label: str, *, allow_missing: bool = False) -> Path:
    path = _absolute_path(value, label)
    _check_path_chain(path, label, allow_missing=allow_missing)
    if os.path.lexists(path) and not stat.S_ISDIR(path.lstat().st_mode):
        raise BundleError(f"{label} is not a directory: {path}")
    return path


def _require_regular_file(path: Path, label: str, *, nonempty: bool = False) -> os.stat_result:
    _check_path_chain(path, label)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise BundleError(f"{label} is not a regular file: {path}")
    if nonempty and info.st_size <= 0:
        raise BundleError(f"{label} is empty: {path}")
    return info


def _norm(path: Path) -> str:
    return os.path.normcase(os.path.abspath(os.fspath(path)))


def _is_within(path: Path, root: Path, *, allow_equal: bool = False) -> bool:
    candidate = _norm(path)
    parent = _norm(root)
    try:
        common = os.path.commonpath((candidate, parent))
    except ValueError:
        return False
    return common == parent and (allow_equal or candidate != parent)


def _same_path(left: Path, right: Path) -> bool:
    return _norm(left) == _norm(right)


def _duplicate_rejecting_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise BundleError(f"Manifest contains duplicate JSON key: {key}")
        result[key] = value
    return result


def _read_json(path: Path, label: str) -> tuple[dict[str, Any], bytes]:
    try:
        raw = path.read_bytes()
        data = json.loads(raw.decode("utf-8-sig"), object_pairs_hook=_duplicate_rejecting_object)
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise BundleError(f"Cannot read {label} {path}: {error}") from error
    if not isinstance(data, dict):
        raise BundleError(f"{label} must contain a JSON object: {path}")
    return data, raw


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
    except OSError as error:
        raise BundleError(f"Cannot hash file {path}: {error}") from error
    return digest.hexdigest()


def _is_sha256(value: Any) -> bool:
    return isinstance(value, str) and SHA256_RE.fullmatch(value) is not None


def _validate_profile(profile: str) -> str:
    try:
        return COMPILER_PROFILES[profile]
    except KeyError as error:
        raise BundleError(f"Unsupported profile {profile!r}; expected dev or release") from error


def _load_source_manifest(
    build_root_arg: str | os.PathLike[str],
    runtime_root_arg: str | os.PathLike[str],
    manifest_arg: str | os.PathLike[str],
    expected_profile: str,
) -> tuple[Path, Path, Path, dict[str, Any], bytes, Path, dict[str, Path], dict[str, str]]:
    compiler_profile = _validate_profile(expected_profile)
    build_root = _require_directory(build_root_arg, "build root")
    runtime_root = _require_directory(runtime_root_arg, "runtime root")
    manifest_path = _absolute_path(manifest_arg, "source manifest")
    _require_regular_file(manifest_path, "source manifest", nonempty=True)
    if not _is_within(manifest_path, build_root):
        raise BundleError(f"Source manifest must be inside build root: {manifest_path}")
    manifest, raw_manifest = _read_json(manifest_path, "source manifest")

    if type(manifest.get("schema_version")) is not int or manifest["schema_version"] != SOURCE_SCHEMA_VERSION:
        raise BundleError("Unsupported Windows build manifest schema_version")
    if manifest.get("compiler_profile") != compiler_profile:
        raise BundleError(
            f"Build manifest compiler_profile must be {compiler_profile!r}, "
            f"got {manifest.get('compiler_profile')!r}"
        )
    target_triple = manifest.get("target_triple")
    if not isinstance(target_triple, str) or not SAFE_COMPONENT_RE.fullmatch(target_triple):
        raise BundleError("Build manifest target_triple is missing or unsafe")
    if manifest.get("cuda") is not False:
        raise BundleError("Native runtime bundles currently accept CPU-only manifests (cuda must be false)")
    features = manifest.get("features")
    if not isinstance(features, list) or any(not isinstance(item, str) for item in features):
        raise BundleError("Build manifest features must be a string list")
    if any(item.casefold() == "cuda" for item in features):
        raise BundleError("Native runtime bundles do not accept CUDA-enabled manifests")
    if not isinstance(manifest.get("git_commit"), str) or not GIT_COMMIT_RE.fullmatch(manifest["git_commit"]):
        raise BundleError("Build manifest git_commit must be a full 40-character commit id")
    for field in ("source_snapshot_sha256", "backend_source_sha256", "dependency_source_sha256"):
        if not _is_sha256(manifest.get(field)):
            raise BundleError(f"Build manifest {field} must be a SHA-256 digest")
    if not isinstance(manifest.get("workspace_namespace"), str) or not manifest["workspace_namespace"]:
        raise BundleError("Build manifest workspace_namespace is missing")
    build_version = manifest.get("build_version")
    if not isinstance(build_version, dict):
        raise BundleError("Build manifest build_version record is missing")
    if (
        build_version.get("schema") != "fullmag.build-version.v1"
        or build_version.get("git_commit") != manifest["git_commit"]
        or build_version.get("source_snapshot_sha256") != manifest["source_snapshot_sha256"]
    ):
        raise BundleError("Build manifest build_version does not match its source identity")

    frozen = manifest.get("build_source_snapshot")
    if frozen is not None:
        from windows.build_snapshot import verify_snapshot
        if not isinstance(frozen, dict) or set(frozen) != {"record_path", "inventory_sha256", "source_root"}:
            raise BundleError("Invalid frozen source binding")
        checked = verify_snapshot(frozen["record_path"], build_root)
        if (checked["inventory_sha256"] != frozen["inventory_sha256"]
                or checked["source_root"] != frozen["source_root"]
                or checked["origin_worktree_id"] != manifest["workspace_namespace"]
                or checked["backend_source_sha256"] != manifest["backend_source_sha256"]
                or checked["dependency_source_sha256"] != manifest["dependency_source_sha256"]
                or checked["source_identity"]["head_commit_full"] != manifest["git_commit"]
                or checked["source_identity"]["source_snapshot_sha256"] != manifest["source_snapshot_sha256"]):
            raise BundleError("Build manifest differs from its frozen source binding")

    target_root_value = manifest.get("cargo_target_dir")
    if not isinstance(target_root_value, str) or not target_root_value:
        raise BundleError("Build manifest cargo_target_dir is missing")
    target_root = _absolute_path(target_root_value, "cargo_target_dir")
    _require_directory(target_root, "cargo_target_dir")
    if not _is_within(target_root, build_root, allow_equal=True):
        raise BundleError(f"cargo_target_dir must be inside build root: {target_root}")
    profile_dir = target_root / target_triple / compiler_profile
    _require_directory(profile_dir, "Cargo profile directory")
    if not _is_within(profile_dir, build_root):
        raise BundleError(f"Cargo profile directory must be inside build root: {profile_dir}")

    source_paths: dict[str, Path] = {}
    source_hashes: dict[str, str] = {}
    for name in BINARY_NAMES:
        if name in SOURCE_PATH_FIELDS:
            value = manifest.get(SOURCE_PATH_FIELDS[name])
            if not isinstance(value, str) or not value:
                raise BundleError(f"Build manifest is missing executable path for {name}")
            source_path = _absolute_path(value, f"manifest path for {name}")
        else:
            source_path = profile_dir / name
        expected_path = profile_dir / name
        if not _same_path(source_path, expected_path) or not _is_within(source_path, build_root):
            raise BundleError(f"Manifest executable path for {name} is outside its expected Cargo profile")
        _require_regular_file(source_path, f"source executable {name}", nonempty=True)
        digest = _sha256_file(source_path)
        declared_field = DECLARED_HASH_FIELDS.get(name)
        if declared_field:
            declared = manifest.get(declared_field)
            if not _is_sha256(declared) or declared != digest:
                raise BundleError(f"Build manifest {declared_field} does not match {name}")
        source_paths[name] = source_path
        source_hashes[name] = digest

    if "executable_sha256" in manifest:
        declared_executables = manifest["executable_sha256"]
        if not isinstance(declared_executables, dict) or set(declared_executables) != set(BINARY_NAMES):
            raise BundleError("Build manifest executable_sha256 must declare exactly the fixed executable allowlist")
        for name, digest in source_hashes.items():
            if not _is_sha256(declared_executables.get(name)) or declared_executables[name] != digest:
                raise BundleError(f"Build manifest executable_sha256 does not match {name}")

    return build_root, runtime_root, manifest_path, manifest, raw_manifest, target_root, source_paths, source_hashes


def _copy_verified(source: Path, destination: Path, expected_hash: str, name: str) -> dict[str, Any]:
    _require_regular_file(source, f"source executable {name}", nonempty=True)
    try:
        shutil.copyfile(source, destination)
    except OSError as error:
        raise BundleError(f"Could not copy source executable {name}: {error}") from error
    _require_regular_file(source, f"source executable {name}", nonempty=True)
    _require_regular_file(destination, f"staged executable {name}", nonempty=True)
    source_after = _sha256_file(source)
    destination_hash = _sha256_file(destination)
    if source_after != expected_hash:
        raise BundleError(f"Source executable changed while copying: {name}")
    if destination_hash != expected_hash:
        raise BundleError(f"Copied executable hash mismatch: {name}")
    try:
        destination.chmod(stat.S_IREAD)
    except OSError as error:
        raise BundleError(f"Could not mark staged executable read-only {name}: {error}") from error
    return {"name": name, "path": f"bin/{name}", "sha256": destination_hash, "size_bytes": destination.stat().st_size}


def _write_bundle_manifest(path: Path, value: dict[str, Any]) -> None:
    try:
        with path.open("x", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        path.chmod(stat.S_IREAD)
    except OSError as error:
        raise BundleError(f"Could not write staged bundle manifest {path}: {error}") from error


def create_bundle(
    build_root: str | os.PathLike[str],
    runtime_root: str | os.PathLike[str],
    manifest: str | os.PathLike[str],
    expected_profile: str = "dev",
) -> dict[str, str]:
    """Validate and copy only the fixed executable set into a UUID bundle."""
    (
        _build_root,
        runtime_root_path,
        source_manifest_path,
        source_manifest,
        raw_source_manifest,
        target_root,
        source_paths,
        source_hashes,
    ) = _load_source_manifest(build_root, runtime_root, manifest, expected_profile)
    compiler_profile = _validate_profile(expected_profile)

    bundles_root = runtime_root_path / "native-bundles"
    _check_path_chain(bundles_root, "native bundle root", allow_missing=True)
    if not os.path.lexists(bundles_root):
        try:
            bundles_root.mkdir()
        except FileExistsError:
            pass
    _require_directory(bundles_root, "native bundle root")

    bundle_id = uuid.uuid4().hex
    staging_root = bundles_root / f".staging-{bundle_id}"
    final_root = bundles_root / bundle_id
    try:
        staging_root.mkdir()
        _check_path_chain(staging_root, "bundle staging directory")
        bin_root = staging_root / "bin"
        bin_root.mkdir()
        _check_path_chain(bin_root, "bundle binary directory")
        copied = [
            _copy_verified(source_paths[name], bin_root / name, source_hashes[name], name)
            for name in BINARY_NAMES
        ]

        _require_regular_file(source_manifest_path, "source manifest", nonempty=True)
        if _sha256_file(source_manifest_path) != _sha256_bytes(raw_source_manifest):
            raise BundleError("Source manifest changed while staging the runtime bundle")

        source_record = {
            "manifest_path": str(source_manifest_path),
            "manifest_sha256": _sha256_bytes(raw_source_manifest),
            "git_commit": source_manifest["git_commit"],
            "source_snapshot_sha256": source_manifest["source_snapshot_sha256"],
            "backend_source_sha256": source_manifest["backend_source_sha256"],
            "dependency_source_sha256": source_manifest.get("dependency_source_sha256"),
            "workspace_namespace": source_manifest["workspace_namespace"],
            "worktree_state": source_manifest.get("worktree_state"),
            "source_identity_check": source_manifest.get("source_identity_check"),
            "source_commit_after": source_manifest.get("source_commit_after"),
            "source_snapshot_sha256_after": source_manifest.get("source_snapshot_sha256_after"),
            "build_version": dict(source_manifest["build_version"]),
            "target_triple": source_manifest["target_triple"],
            "compiler_profile": compiler_profile,
            "cargo_target_dir": str(target_root),
            "cuda": False,
            "features": list(source_manifest["features"]),
            "executable_sha256": dict(source_hashes),
        }
        if source_manifest.get("build_source_snapshot") is not None:
            source_record["build_source_snapshot"] = dict(source_manifest["build_source_snapshot"])
        bundle_manifest = {
            "schema": BUNDLE_SCHEMA,
            "schema_version": 1,
            "bundle_id": bundle_id,
            "created_at_utc": datetime.now(timezone.utc).isoformat(),
            "profile": expected_profile,
            "compiler_profile": compiler_profile,
            "qualification": "not_assessed",
            "source": source_record,
            "binaries": copied,
        }
        _write_bundle_manifest(staging_root / "manifest.json", bundle_manifest)

        _check_path_chain(staging_root, "bundle staging directory")
        if os.path.lexists(final_root):
            raise BundleError(f"Refusing to replace an existing runtime bundle: {final_root}")
        try:
            os.rename(staging_root, final_root)
        except OSError as error:
            raise BundleError(f"Could not atomically publish runtime bundle {final_root}: {error}") from error
    except BundleError:
        # Preserve every failed staging directory as evidence; never clean it here.
        raise
    except OSError as error:
        # Preserve every failed staging directory as evidence; never clean it here.
        raise BundleError(f"Could not stage native runtime bundle under {bundles_root}: {error}") from error

    validated_manifest, _checks = validate_bundle(final_root, runtime_root_path, expected_profile)
    del validated_manifest
    return {
        "bundle_root": str(final_root),
        "fullmag_exe": str(final_root / "bin" / "fullmag.exe"),
        "manifest": str(final_root / "manifest.json"),
    }


def validate_bundle(
    bundle_root: str | os.PathLike[str],
    runtime_root: str | os.PathLike[str],
    expected_profile: str,
) -> tuple[dict[str, Any], dict[str, str]]:
    """Validate a published bundle and return its manifest plus verified file hashes."""
    compiler_profile = _validate_profile(expected_profile)
    runtime_root_path = _require_directory(runtime_root, "runtime root")
    bundles_root = runtime_root_path / "native-bundles"
    _require_directory(bundles_root, "native bundle root")
    root = _require_directory(bundle_root, "bundle root")
    if not _same_path(root.parent, bundles_root):
        raise BundleError("Bundle root must be a direct child of runtime_root/native-bundles")
    if not BUNDLE_ID_RE.fullmatch(root.name):
        raise BundleError("Published bundle directory name must be a lowercase UUID")

    expected_entries = {"bin", "manifest.json"}
    if {item.name for item in root.iterdir()} != expected_entries:
        raise BundleError("Bundle contains unexpected or missing top-level entries")
    bin_root = root / "bin"
    _require_directory(bin_root, "bundle binary directory")
    if {item.name for item in bin_root.iterdir()} != set(BINARY_NAMES):
        raise BundleError("Bundle binary directory does not match the fixed executable allowlist")
    manifest_path = root / "manifest.json"
    _require_regular_file(manifest_path, "bundle manifest", nonempty=True)
    manifest, _raw = _read_json(manifest_path, "bundle manifest")
    if manifest.get("schema") != BUNDLE_SCHEMA or type(manifest.get("schema_version")) is not int or manifest["schema_version"] != 1:
        raise BundleError("Unsupported runtime bundle manifest schema")
    if manifest.get("bundle_id") != root.name:
        raise BundleError("Bundle directory name does not match manifest bundle_id")
    if manifest.get("profile") != expected_profile or manifest.get("compiler_profile") != compiler_profile:
        raise BundleError("Runtime bundle profile does not match the requested profile")
    if manifest.get("qualification") != "not_assessed":
        raise BundleError("Runtime bundle must remain explicitly unqualified")

    source = manifest.get("source")
    if not isinstance(source, dict):
        raise BundleError("Runtime bundle source metadata is missing")
    if source.get("compiler_profile") != compiler_profile or source.get("cuda") is not False:
        raise BundleError("Runtime bundle source profile or CPU-only metadata is invalid")
    if not isinstance(source.get("target_triple"), str) or not SAFE_COMPONENT_RE.fullmatch(source["target_triple"]):
        raise BundleError("Runtime bundle target_triple is missing or unsafe")
    if not isinstance(source.get("git_commit"), str) or not GIT_COMMIT_RE.fullmatch(source["git_commit"]):
        raise BundleError("Runtime bundle source git_commit is invalid")
    for field in ("source_snapshot_sha256", "backend_source_sha256", "dependency_source_sha256", "manifest_sha256"):
        if not _is_sha256(source.get(field)):
            raise BundleError(f"Runtime bundle source {field} is invalid")
    if not isinstance(source.get("workspace_namespace"), str) or not source["workspace_namespace"]:
        raise BundleError("Runtime bundle source workspace_namespace is missing")
    build_version = source.get("build_version")
    if (
        not isinstance(build_version, dict)
        or build_version.get("schema") != "fullmag.build-version.v1"
        or build_version.get("git_commit") != source["git_commit"]
        or build_version.get("source_snapshot_sha256") != source["source_snapshot_sha256"]
    ):
        raise BundleError("Runtime bundle build_version does not match the recorded source identity")
    if not isinstance(source.get("features"), list) or any(not isinstance(item, str) for item in source["features"]):
        raise BundleError("Runtime bundle source features are invalid")
    if any(item.casefold() == "cuda" for item in source["features"]):
        raise BundleError("Runtime bundle source metadata unexpectedly contains CUDA")

    records = manifest.get("binaries")
    if not isinstance(records, list) or len(records) != len(BINARY_NAMES):
        raise BundleError("Runtime bundle manifest does not describe the full executable allowlist")
    source_executables = source.get("executable_sha256")
    if not isinstance(source_executables, dict) or set(source_executables) != set(BINARY_NAMES):
        raise BundleError("Runtime bundle source executable_sha256 does not match the fixed allowlist")
    checks: dict[str, str] = {}
    for name, record in zip(BINARY_NAMES, records):
        if not isinstance(record, dict) or record.get("name") != name or record.get("path") != f"bin/{name}":
            raise BundleError(f"Runtime bundle manifest entry does not match the allowlist: {name}")
        if not _is_sha256(record.get("sha256")):
            raise BundleError(f"Runtime bundle manifest hash is invalid for {name}")
        if not _is_sha256(source_executables.get(name)) or source_executables[name] != record["sha256"]:
            raise BundleError(f"Runtime bundle source hash does not match its copied executable: {name}")
        path = bin_root / name
        info = _require_regular_file(path, f"bundled executable {name}", nonempty=True)
        if type(record.get("size_bytes")) is not int or record["size_bytes"] != info.st_size:
            raise BundleError(f"Runtime bundle size does not match for {name}")
        actual_hash = _sha256_file(path)
        if actual_hash != record["sha256"]:
            raise BundleError(f"Runtime bundle hash does not match for {name}")
        checks[f"bin/{name}"] = actual_hash
    return manifest, checks


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build-root", required=True, help="Resolved Fullmag per-worktree build root")
    parser.add_argument("--runtime-root", required=True, help="Resolved Fullmag per-worktree runtime root")
    parser.add_argument("--manifest", required=True, help="run_fullmag.ps1 schema-1 build manifest")
    parser.add_argument("--profile", choices=("dev", "release"), default="dev")
    args = parser.parse_args(argv)
    try:
        result = create_bundle(args.build_root, args.runtime_root, args.manifest, args.profile)
    except BundleError as error:
        print(f"runtime bundle error: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
