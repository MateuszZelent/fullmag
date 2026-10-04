#!/usr/bin/env python3
"""Publish and validate stable executable paths for a fresh Windows workspace startup.

The UUID runtime bundle remains the immutable provenance record. This helper
copies its verified executables to a per-worktree/profile path whose names stay
stable across launches. It does not replace executables in an active workspace.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import sys
import uuid
from typing import Any


_SCRIPTS_ROOT = Path(__file__).resolve().parents[1]
if str(_SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_ROOT))

import fullmag_storage as storage
from windows import runtime_bundle


LAUNCH_SCHEMA = "fullmag.native-runtime-launch.v1"
STAGING_SCHEMA = "fullmag.native-runtime-launch-staging.v1"
STATUS_NAME = "native-workspace-status.json"
PROFILE_RE = re.compile(r"^(dev|release)$")
NONCE_RE = re.compile(r"^[0-9a-f]{32}$")
STAGING_RE = re.compile(r"^\.staging-([0-9a-f]{32})$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class StableLaunchError(RuntimeError):
    """Input, ownership, or publication failed closed."""


def _profile(value: str) -> str:
    if not isinstance(value, str) or PROFILE_RE.fullmatch(value) is None:
        raise StableLaunchError(f"Unsupported native launch profile {value!r}; expected dev or release")
    return value


def _absolute_bundle_root(value: str | os.PathLike[str]) -> Path:
    try:
        return runtime_bundle._absolute_path(value, "runtime bundle root")
    except runtime_bundle.BundleError as error:
        raise StableLaunchError(str(error)) from error


def _resolve_layout(repo_root: str, profile: str) -> dict[str, Any]:
    try:
        workspace_profile = _profile(profile)
        storage_profile = storage.WINDOWS_WORKSPACE_STORAGE_PROFILES[workspace_profile]
        requested = runtime_bundle._absolute_path(repo_root, "repository root")
        layout = storage.resolve_layout(str(requested), profile=storage_profile)
    except (OSError, storage.StorageError, runtime_bundle.BundleError) as error:
        raise StableLaunchError(f"Could not resolve the Fullmag storage layout: {error}") from error
    if not runtime_bundle._same_path(Path(layout["repo_root"]), requested):
        raise StableLaunchError("Resolved repository root does not match the requested checkout")
    runtime_root = Path(layout["runtime_root"])
    try:
        runtime_bundle._require_directory(runtime_root, "resolved native runtime root")
    except runtime_bundle.BundleError as error:
        raise StableLaunchError(str(error)) from error
    return layout


def _runtime_root(layout: dict[str, Any]) -> Path:
    try:
        root = runtime_bundle._absolute_path(layout["runtime_root"], "resolved native runtime root")
        runtime_bundle._require_directory(root, "resolved native runtime root")
    except (KeyError, runtime_bundle.BundleError) as error:
        raise StableLaunchError(f"Invalid resolved native runtime root: {error}") from error
    return root


def _status_path(layout: dict[str, Any]) -> Path:
    runtime_root = _runtime_root(layout)
    try:
        raw_path = runtime_root / STATUS_NAME
        runtime_bundle._check_path_chain(raw_path, "native runtime status")
        path = storage.validate_path(raw_path, runtime_root, "native runtime status")
        if os.path.lexists(path):
            runtime_bundle._require_regular_file(path, "native runtime status", nonempty=True)
    except (OSError, storage.StorageError, runtime_bundle.BundleError) as error:
        raise StableLaunchError(f"Cannot safely inspect native runtime status: {error}") from error
    return Path(path)


def _validate_runtime_status(
    layout: dict[str, Any],
    expected_nonce: str,
    *,
    publishing: bool,
) -> dict[str, Any]:
    if NONCE_RE.fullmatch(expected_nonce) is None:
        raise StableLaunchError("Native runtime launch nonce must be 32 lowercase hexadecimal characters")

    status_path = _status_path(layout)
    try:
        status, _raw = runtime_bundle._read_json(status_path, "native runtime status")
    except runtime_bundle.BundleError as error:
        raise StableLaunchError(str(error)) from error

    repo_root = Path(layout["repo_root"])
    if (
        status.get("schema") != "fullmag_storage_v1"
        or status.get("state") != "starting"
        or status.get("worktree_id") != layout.get("worktree_id")
        or status.get("profile") != layout.get("profile")
        or not isinstance(status.get("repo_root"), str)
        or not runtime_bundle._same_path(Path(status["repo_root"]), repo_root)
        or status.get("launch_nonce") != expected_nonce
    ):
        raise StableLaunchError("Native runtime status does not belong to this starting workspace launch")

    manager_pid = status.get("manager_pid")
    launcher_pid = status.get("launcher_pid")
    if type(manager_pid) is not int or manager_pid <= 0 or not storage.process_alive(manager_pid):
        raise StableLaunchError("Native workspace runtime manager is not alive")
    if type(launcher_pid) is not int or launcher_pid <= 0:
        raise StableLaunchError("Native runtime status has no valid launcher process owner")

    if publishing:
        if os.environ.get("FULLMAG_NATIVE_RUNTIME_ACTIVE") != "1":
            raise StableLaunchError("Stable launch publication requires FULLMAG_NATIVE_RUNTIME_ACTIVE=1")
        if os.environ.get("FULLMAG_NATIVE_RUNTIME_NONCE") != expected_nonce:
            raise StableLaunchError("Native runtime status nonce does not match FULLMAG_NATIVE_RUNTIME_NONCE")
        if launcher_pid != os.getppid():
            raise StableLaunchError("Native runtime launcher PID does not match this publisher's parent")
    return status


def _validate_bundle(
    layout: dict[str, Any], bundle_root: str | os.PathLike[str], profile: str
) -> tuple[Path, dict[str, Any], dict[str, str], Path, str]:
    runtime_root = _runtime_root(layout)
    source_root = _absolute_bundle_root(bundle_root)
    try:
        bundle, checks = runtime_bundle.validate_bundle(source_root, runtime_root, profile)
    except runtime_bundle.BundleError as error:
        raise StableLaunchError(str(error)) from error

    namespace = bundle.get("source", {}).get("workspace_namespace")
    if not isinstance(namespace, str) or namespace != layout.get("worktree_id"):
        raise StableLaunchError("Sealed runtime bundle belongs to a different workspace namespace")

    source_manifest_sha256 = bundle["source"].get("manifest_sha256")
    if not isinstance(source_manifest_sha256, str) or SHA256_RE.fullmatch(source_manifest_sha256) is None:
        raise StableLaunchError("Sealed runtime bundle has no valid source manifest SHA-256")
    bundle_manifest_path = source_root / "manifest.json"
    try:
        manifest_sha256 = runtime_bundle._sha256_file(bundle_manifest_path)
    except runtime_bundle.BundleError as error:
        raise StableLaunchError(str(error)) from error
    return source_root, bundle, checks, bundle_manifest_path, manifest_sha256


def _launch_paths(layout: dict[str, Any], profile: str) -> tuple[Path, Path, Path, Path]:
    runtime_root = _runtime_root(layout)
    launch_parent = runtime_root / "native-launch"
    launch_root = launch_parent / profile
    bin_root = launch_root / "bin"
    manifest_path = launch_root / "launch-manifest.json"
    return launch_parent, launch_root, bin_root, manifest_path


def _ensure_directory(path: Path, label: str) -> None:
    try:
        runtime_bundle._check_path_chain(path, label, allow_missing=True)
        if not os.path.lexists(path):
            try:
                path.mkdir()
            except FileExistsError:
                pass
        runtime_bundle._require_directory(path, label)
    except (OSError, runtime_bundle.BundleError) as error:
        raise StableLaunchError(f"Cannot safely prepare {label}: {error}") from error


def _validate_staging_directory(path: Path, profile: str) -> None:
    match = STAGING_RE.fullmatch(path.name)
    if match is None:
        raise StableLaunchError(f"Unexpected native launch staging entry: {path.name}")
    try:
        runtime_bundle._require_directory(path, "prior stable launch staging directory")
        owner_path = path / ".owner.json"
        runtime_bundle._require_regular_file(owner_path, "stable launch staging owner", nonempty=True)
        owner, _raw = runtime_bundle._read_json(owner_path, "stable launch staging owner")
    except runtime_bundle.BundleError as error:
        raise StableLaunchError(str(error)) from error
    if (
        set(owner) != {"schema", "stage_id", "profile", "launch_nonce"}
        or owner.get("schema") != STAGING_SCHEMA
        or owner.get("stage_id") != match.group(1)
        or owner.get("profile") != profile
        or not isinstance(owner.get("launch_nonce"), str)
        or NONCE_RE.fullmatch(owner["launch_nonce"]) is None
    ):
        raise StableLaunchError(f"Prior launch staging directory has an invalid owner record: {path}")

    allowed = {".owner.json", "bin", "launch-manifest.json"}
    entries = list(path.iterdir())
    if any(entry.name not in allowed for entry in entries):
        raise StableLaunchError(f"Prior launch staging directory contains unexpected entries: {path}")
    for entry in entries:
        if entry.name == "bin":
            try:
                runtime_bundle._require_directory(entry, "prior staged launch binary directory")
            except runtime_bundle.BundleError as error:
                raise StableLaunchError(str(error)) from error
            for binary in entry.iterdir():
                if binary.name not in runtime_bundle.BINARY_NAMES:
                    raise StableLaunchError(f"Prior launch staging contains an unexpected executable: {binary}")
                try:
                    runtime_bundle._require_regular_file(binary, "prior staged executable", nonempty=True)
                except runtime_bundle.BundleError as error:
                    raise StableLaunchError(str(error)) from error
        elif entry.name == "launch-manifest.json":
            try:
                runtime_bundle._require_regular_file(entry, "prior staged launch manifest", nonempty=True)
            except runtime_bundle.BundleError as error:
                raise StableLaunchError(str(error)) from error


def _validate_launch_manifest_shape(value: dict[str, Any]) -> None:
    fields = {
        "schema",
        "profile",
        "bundle_root",
        "bundle_id",
        "workspace_namespace",
        "launch_nonce",
        "source_manifest_sha256",
        "binaries",
    }
    if set(value) != fields or value.get("schema") != LAUNCH_SCHEMA:
        raise StableLaunchError("Stable launch manifest has an unsupported schema or unexpected fields")
    if value.get("profile") not in ("dev", "release"):
        raise StableLaunchError("Stable launch manifest profile is invalid")
    if not isinstance(value.get("bundle_root"), str) or not value["bundle_root"]:
        raise StableLaunchError("Stable launch manifest bundle_root is invalid")
    if not isinstance(value.get("bundle_id"), str) or runtime_bundle.BUNDLE_ID_RE.fullmatch(value["bundle_id"]) is None:
        raise StableLaunchError("Stable launch manifest bundle_id is invalid")
    if not isinstance(value.get("workspace_namespace"), str) or not value["workspace_namespace"]:
        raise StableLaunchError("Stable launch manifest workspace_namespace is invalid")
    if not isinstance(value.get("launch_nonce"), str) or NONCE_RE.fullmatch(value["launch_nonce"]) is None:
        raise StableLaunchError("Stable launch manifest launch_nonce is invalid")
    digest = value.get("source_manifest_sha256")
    if not isinstance(digest, str) or SHA256_RE.fullmatch(digest) is None:
        raise StableLaunchError("Stable launch manifest source manifest digest is invalid")
    binaries = value.get("binaries")
    if not isinstance(binaries, dict) or set(binaries) != set(runtime_bundle.BINARY_NAMES):
        raise StableLaunchError("Stable launch manifest does not match the fixed executable allowlist")
    for name in runtime_bundle.BINARY_NAMES:
        record = binaries.get(name)
        if (
            not isinstance(record, dict)
            or set(record) != {"sha256", "size_bytes"}
            or not isinstance(record.get("sha256"), str)
            or SHA256_RE.fullmatch(record["sha256"]) is None
            or type(record.get("size_bytes")) is not int
            or record["size_bytes"] <= 0
        ):
            raise StableLaunchError(f"Stable launch manifest binary record is invalid for {name}")


def _validate_existing_profile_tree(
    launch_parent: Path, launch_root: Path, profile: str
) -> None:
    try:
        runtime_bundle._check_path_chain(launch_parent, "stable launch root", allow_missing=True)
        if os.path.lexists(launch_parent):
            runtime_bundle._require_directory(launch_parent, "stable launch root")
            for entry in launch_parent.iterdir():
                if entry.name not in ("dev", "release"):
                    raise StableLaunchError(f"Stable launch root contains an unexpected entry: {entry}")
                runtime_bundle._require_directory(entry, "stable launch profile directory")

        runtime_bundle._check_path_chain(launch_root, "stable launch profile root", allow_missing=True)
        if not os.path.lexists(launch_root):
            return
        runtime_bundle._require_directory(launch_root, "stable launch profile root")
        for entry in launch_root.iterdir():
            if entry.name == "bin":
                runtime_bundle._require_directory(entry, "stable launch binary directory")
                for binary in entry.iterdir():
                    if binary.name not in runtime_bundle.BINARY_NAMES:
                        raise StableLaunchError(f"Stable launch binary directory contains an unexpected entry: {binary}")
                    runtime_bundle._require_regular_file(binary, "stable launch executable", nonempty=True)
            elif entry.name == "launch-manifest.json":
                runtime_bundle._require_regular_file(entry, "stable launch manifest", nonempty=True)
                existing, _raw = runtime_bundle._read_json(entry, "stable launch manifest")
                _validate_launch_manifest_shape(existing)
            elif STAGING_RE.fullmatch(entry.name):
                _validate_staging_directory(entry, profile)
            else:
                raise StableLaunchError(f"Stable launch profile root contains an unexpected entry: {entry}")
    except (OSError, runtime_bundle.BundleError) as error:
        raise StableLaunchError(f"Cannot safely inspect stable launch paths: {error}") from error


def _launch_lock_path(layout: dict[str, Any]) -> Path:
    runtime_root = _runtime_root(layout)
    lock_path = runtime_root / "native-launch.lock"
    try:
        runtime_bundle._check_path_chain(lock_path, "stable launch lock", allow_missing=True)
        if os.path.lexists(lock_path):
            runtime_bundle._require_regular_file(lock_path, "stable launch lock")
    except runtime_bundle.BundleError as error:
        raise StableLaunchError(str(error)) from error
    return lock_path


def _launch_manifest(
    layout: dict[str, Any],
    source_root: Path,
    bundle: dict[str, Any],
    profile: str,
    nonce: str,
) -> dict[str, Any]:
    binaries: dict[str, dict[str, Any]] = {}
    records = bundle.get("binaries")
    if not isinstance(records, list) or len(records) != len(runtime_bundle.BINARY_NAMES):
        raise StableLaunchError("Sealed runtime bundle has an invalid executable inventory")
    for name, record in zip(runtime_bundle.BINARY_NAMES, records):
        if not isinstance(record, dict) or record.get("name") != name:
            raise StableLaunchError(f"Sealed runtime bundle record does not match {name}")
        binaries[name] = {
            "sha256": record["sha256"],
            "size_bytes": record["size_bytes"],
        }
    return {
        "schema": LAUNCH_SCHEMA,
        "profile": profile,
        "bundle_root": str(source_root),
        "bundle_id": bundle["bundle_id"],
        "workspace_namespace": layout["worktree_id"],
        "launch_nonce": nonce,
        "source_manifest_sha256": bundle["source"]["manifest_sha256"],
        "binaries": binaries,
    }


def _validate_published_files(
    launch_root: Path,
    bin_root: Path,
    manifest_path: Path,
    expected_manifest: dict[str, Any],
    checks: dict[str, str],
) -> None:
    try:
        runtime_bundle._require_directory(launch_root, "stable launch profile root")
        runtime_bundle._require_directory(bin_root, "stable launch binary directory")
        runtime_bundle._require_regular_file(manifest_path, "stable launch manifest", nonempty=True)
        manifest, _raw = runtime_bundle._read_json(manifest_path, "stable launch manifest")
        _validate_launch_manifest_shape(manifest)
    except runtime_bundle.BundleError as error:
        raise StableLaunchError(str(error)) from error
    if manifest != expected_manifest:
        raise StableLaunchError("Stable launch manifest does not match the requested immutable bundle and nonce")

    if {item.name for item in bin_root.iterdir()} != set(runtime_bundle.BINARY_NAMES):
        raise StableLaunchError("Stable launch binary directory is incomplete or contains unexpected entries")
    for name in runtime_bundle.BINARY_NAMES:
        path = bin_root / name
        try:
            info = runtime_bundle._require_regular_file(path, f"stable launch executable {name}", nonempty=True)
            digest = runtime_bundle._sha256_file(path)
        except runtime_bundle.BundleError as error:
            raise StableLaunchError(str(error)) from error
        expected = expected_manifest["binaries"][name]
        if info.st_size != expected["size_bytes"] or digest != expected["sha256"] or checks.get(f"bin/{name}") != digest:
            raise StableLaunchError(f"Stable launch executable does not match its immutable bundle: {name}")


def _copy_verified(
    source: Path,
    destination: Path,
    name: str,
    expected_digest: str,
    expected_size: int,
) -> None:
    try:
        source_info = runtime_bundle._require_regular_file(source, f"sealed bundle executable {name}", nonempty=True)
        if source_info.st_size != expected_size or runtime_bundle._sha256_file(source) != expected_digest:
            raise StableLaunchError(f"Sealed bundle executable changed before staging: {name}")
        shutil.copyfile(source, destination)
        source_after = runtime_bundle._require_regular_file(source, f"sealed bundle executable {name}", nonempty=True)
        staged_info = runtime_bundle._require_regular_file(destination, f"staged launch executable {name}", nonempty=True)
        source_hash_after = runtime_bundle._sha256_file(source)
        staged_hash = runtime_bundle._sha256_file(destination)
    except (OSError, runtime_bundle.BundleError) as error:
        raise StableLaunchError(f"Could not verify staged launch executable {name}: {error}") from error
    if (
        source_after.st_size != expected_size
        or source_hash_after != expected_digest
        or staged_info.st_size != expected_size
        or staged_hash != expected_digest
    ):
        raise StableLaunchError(f"Staged launch executable does not match its sealed source: {name}")


def _publish_launch_copy(
    layout: dict[str, Any], bundle_root: str, profile: str
) -> dict[str, str]:
    profile = _profile(profile)
    nonce = os.environ.get("FULLMAG_NATIVE_RUNTIME_NONCE", "")
    _validate_runtime_status(layout, nonce, publishing=True)
    source_root, bundle, checks, bundle_manifest_path, source_manifest_hash = _validate_bundle(
        layout, bundle_root, profile
    )
    launch_parent, launch_root, bin_root, manifest_path = _launch_paths(layout, profile)
    lock_path = _launch_lock_path(layout)

    try:
        lock_context = storage.file_lock(lock_path, f"stable native launch publication for {layout['worktree_id']}")
        with lock_context:
            _validate_runtime_status(layout, nonce, publishing=True)
            _validate_existing_profile_tree(launch_parent, launch_root, profile)
            _ensure_directory(launch_parent, "stable launch root")
            _ensure_directory(launch_root, "stable launch profile root")
            _validate_existing_profile_tree(launch_parent, launch_root, profile)

            stage_id = uuid.uuid4().hex
            stage_root = launch_root / f".staging-{stage_id}"
            stage_bin = stage_root / "bin"
            try:
                stage_root.mkdir()
                owner_path = stage_root / ".owner.json"
                storage.atomic_json(
                    owner_path,
                    {
                        "schema": STAGING_SCHEMA,
                        "stage_id": stage_id,
                        "profile": profile,
                        "launch_nonce": nonce,
                    },
                )
                stage_bin.mkdir()
                records = {item["name"]: item for item in bundle["binaries"]}
                for name in runtime_bundle.BINARY_NAMES:
                    expected = records[name]
                    _copy_verified(
                        source_root / "bin" / name,
                        stage_bin / name,
                        name,
                        expected["sha256"],
                        expected["size_bytes"],
                    )

                staged_manifest = _launch_manifest(layout, source_root, bundle, profile, nonce)
                stage_manifest = stage_root / "launch-manifest.json"
                storage.atomic_json(stage_manifest, staged_manifest)

                # The bundle and startup owner must still be the same at the commit boundary.
                _validate_runtime_status(layout, nonce, publishing=True)
                try:
                    current_bundle, current_checks = runtime_bundle.validate_bundle(
                        source_root, _runtime_root(layout), profile
                    )
                    current_bundle_manifest_hash = runtime_bundle._sha256_file(bundle_manifest_path)
                except runtime_bundle.BundleError as error:
                    raise StableLaunchError(f"Sealed runtime bundle changed during launch staging: {error}") from error
                if (
                    current_bundle != bundle
                    or current_checks != checks
                    or current_bundle_manifest_hash != source_manifest_hash
                ):
                    raise StableLaunchError("Sealed runtime bundle changed during launch staging")

                _validate_existing_profile_tree(launch_parent, launch_root, profile)
                _ensure_directory(bin_root, "stable launch binary directory")
                for name in runtime_bundle.BINARY_NAMES:
                    target = bin_root / name
                    try:
                        runtime_bundle._check_path_chain(target, f"stable launch executable {name}", allow_missing=True)
                        if os.path.lexists(target):
                            runtime_bundle._require_regular_file(target, f"stable launch executable {name}", nonempty=True)
                        os.replace(stage_bin / name, target)
                    except (OSError, runtime_bundle.BundleError) as error:
                        raise StableLaunchError(
                            f"Cannot publish stable executable {name}: {error}. "
                            "The target may be in use; no retry or process termination was attempted."
                        ) from error

                # Check all targets before the manifest makes this generation visible as complete.
                for name in runtime_bundle.BINARY_NAMES:
                    target = bin_root / name
                    expected = staged_manifest["binaries"][name]
                    try:
                        info = runtime_bundle._require_regular_file(target, f"stable launch executable {name}", nonempty=True)
                        digest = runtime_bundle._sha256_file(target)
                    except runtime_bundle.BundleError as error:
                        raise StableLaunchError(str(error)) from error
                    if info.st_size != expected["size_bytes"] or digest != expected["sha256"]:
                        raise StableLaunchError(f"Published stable executable failed verification: {name}")

                _validate_runtime_status(layout, nonce, publishing=True)
                try:
                    if os.path.lexists(manifest_path):
                        runtime_bundle._require_regular_file(manifest_path, "stable launch manifest", nonempty=True)
                    os.replace(stage_manifest, manifest_path)
                except (OSError, runtime_bundle.BundleError) as error:
                    raise StableLaunchError(f"Could not atomically publish the stable launch manifest: {error}") from error

                _validate_published_files(launch_root, bin_root, manifest_path, staged_manifest, checks)
                # A successful publication no longer needs its private staging files.
                # Failed staging trees are retained above for diagnosis.
                try:
                    runtime_bundle._check_path_chain(stage_root, "owned stable launch staging directory")
                    shutil.rmtree(stage_root)
                except (OSError, runtime_bundle.BundleError):
                    pass
            except StableLaunchError:
                raise
            except (OSError, storage.StorageError, runtime_bundle.BundleError) as error:
                raise StableLaunchError(f"Stable launch publication failed: {error}") from error
    except storage.StorageError as error:
        raise StableLaunchError(str(error)) from error

    return {
        "launch_root": str(launch_root),
        "fullmag_exe": str(bin_root / "fullmag.exe"),
        "manifest": str(manifest_path),
    }


def publish_launch_copy(repo_root: str, bundle_root: str, profile: str) -> dict[str, str]:
    """Publish a fresh startup's verified bundle to stable per-worktree paths."""
    layout = _resolve_layout(repo_root, profile)
    return _publish_launch_copy(layout, bundle_root, profile)


def _validate_launch_copy(
    layout: dict[str, Any], bundle_root: str, profile: str, expected_nonce: str
) -> dict[str, str]:
    profile = _profile(profile)
    if not isinstance(expected_nonce, str) or NONCE_RE.fullmatch(expected_nonce) is None:
        raise StableLaunchError("Expected native runtime launch nonce must be 32 lowercase hexadecimal characters")
    launch_parent, launch_root, bin_root, manifest_path = _launch_paths(layout, profile)
    lock_path = _launch_lock_path(layout)
    try:
        with storage.file_lock(lock_path, f"stable native launch validation for {layout['worktree_id']}"):
            _validate_runtime_status(layout, expected_nonce, publishing=False)
            source_root, bundle, checks, bundle_manifest_path, source_manifest_hash = _validate_bundle(
                layout, bundle_root, profile
            )
            _validate_existing_profile_tree(launch_parent, launch_root, profile)
            expected_manifest = _launch_manifest(layout, source_root, bundle, profile, expected_nonce)
            _validate_published_files(launch_root, bin_root, manifest_path, expected_manifest, checks)

            try:
                current_bundle, current_checks = runtime_bundle.validate_bundle(
                    source_root, _runtime_root(layout), profile
                )
                current_bundle_manifest_hash = runtime_bundle._sha256_file(bundle_manifest_path)
            except runtime_bundle.BundleError as error:
                raise StableLaunchError(f"Sealed runtime bundle changed during launch validation: {error}") from error
            if current_bundle != bundle or current_checks != checks or current_bundle_manifest_hash != source_manifest_hash:
                raise StableLaunchError("Sealed runtime bundle changed during launch validation")
            _validate_runtime_status(layout, expected_nonce, publishing=False)
    except storage.StorageError as error:
        raise StableLaunchError(str(error)) from error

    return {
        "launch_root": str(launch_root),
        "fullmag_exe": str(bin_root / "fullmag.exe"),
        "manifest": str(manifest_path),
    }


def validate_launch_copy(
    repo_root: str, bundle_root: str, profile: str, expected_nonce: str
) -> dict[str, str]:
    """Validate stable startup copies against their immutable bundle and lease."""
    layout = _resolve_layout(repo_root, profile)
    return _validate_launch_copy(layout, bundle_root, profile, expected_nonce)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", required=True, help="Resolved Fullmag checkout")
    parser.add_argument("--bundle-root", required=True, help="Published immutable UUID runtime bundle")
    parser.add_argument("--profile", choices=("dev", "release"), required=True)
    args = parser.parse_args(argv)
    try:
        result = publish_launch_copy(args.repo_root, args.bundle_root, args.profile)
    except (StableLaunchError, storage.StorageError, runtime_bundle.BundleError) as error:
        print(f"stable launch error: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
