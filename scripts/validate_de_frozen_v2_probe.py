"""Read-only native artifact validation for managed frozen-v2 DE probe runs."""
from __future__ import annotations

import csv
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import stat
from typing import Any, Mapping

import de_frozen_v2_runtime_adapter as adapter
import de_shifted_ksp_trial
import fem_equilibrium_field_replay
import fem_equilibrium_identity_replay
import fem_linearization_identity_replay
import freeze_signed_de_probe_inputs as freezer
import run_comsol_dispersion_benchmark as managed
import run_de_100nm_pilot as pilot
import validate_de_smoke_rows
import validate_parallel_execution_report
import verify_fem_frequency_domain_eigen_artifacts


REQUEST_SCHEMA = "fullmag.de.frozen_v2_probe.request.v2"
RESULT_SCHEMA = "fullmag.de.frozen_v2_probe.result.v2"
EXPECTED_SAMPLE_INDICES = (0, 1, 2)
EXPECTED_SOURCE_INDICES = (3, 11, 3)
EXPECTED_VECTORS = ((0.0, -1.0e7, 0.0), (0.0, 1.0e7, 0.0), (0.0, -1.0e7, 0.0))
REQUIRED_IDENTITY_FIELDS = (
    "equilibrium_artifact_sha256", "equilibrium_content_sha256",
    "source_mesh_topology_sha256", "modal_mesh_topology_fingerprint_v3",
)
_HEX64 = re.compile(r"[0-9a-f]{64}\Z")
_NATIVE_SHA = re.compile(r"sha256:[0-9a-f]{64}\Z")
_MAX_RECEIPT_BYTES = 32 * 1024 * 1024
_MAX_ARTIFACT_BYTES = 1024**3
_REQUIRED_CONSUMERS = (
    "scripts/run_de_frozen_v2_probe.py",
    "scripts/validate_de_frozen_v2_probe.py",
    "scripts/de_frozen_v2_runtime_adapter.py",
    "scripts/freeze_signed_de_probe_inputs.py",
    "scripts/run_comsol_dispersion_benchmark.py",
    "scripts/fullmag_storage.py",
    "scripts/run_de_100nm_pilot.py",
    "scripts/de_signed_state_closure.py",
    "scripts/validate_de_smoke_rows.py",
    "scripts/de_shifted_ksp_trial.py",
    "scripts/validate_de_physical_potential.py",
    "scripts/validate_parallel_execution_report.py",
    "scripts/fem_linearization_identity_replay.py",
    "scripts/fem_equilibrium_identity_replay.py",
    "scripts/fem_equilibrium_field_replay.py",
    "scripts/comsol_mesh_identity.py",
    "scripts/verify_fem_frequency_domain_eigen_artifacts.py",
    "packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py",
)


class ProbeValidationError(ValueError):
    """A durable receipt or its current native outputs failed validation."""


def _fail(message: str) -> None:
    raise ProbeValidationError(message)


def _reject_duplicate_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key {key!r}")
        result[key] = value
    return result


def _reject_constant(value: str) -> None:
    raise ValueError(f"non-finite JSON number {value}")


def _check_finite(value: Any, label: str, depth: int = 0) -> None:
    if depth > 128:
        raise ValueError(f"{label} exceeds JSON nesting limit")
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError(f"{label} contains a non-finite number")
    if isinstance(value, dict):
        for key, child in value.items():
            _check_finite(key, label, depth + 1)
            _check_finite(child, label, depth + 1)
    elif isinstance(value, list):
        for child in value:
            _check_finite(child, label, depth + 1)


def _strict_json(raw: bytes, label: str, limit: int = _MAX_RECEIPT_BYTES) -> dict[str, Any]:
    if type(raw) is not bytes or len(raw) > limit:
        _fail(f"{label} is absent or exceeds its byte limit")
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_reject_duplicate_pairs,
                           parse_constant=_reject_constant)
        _check_finite(value, label)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError) as error:
        raise ProbeValidationError(f"{label} is not strict finite JSON: {error}") from error
    if not isinstance(value, dict):
        _fail(f"{label} must be a JSON object")
    return value


def _file_identity(info: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        info.st_dev,
        info.st_ino,
        info.st_size,
        info.st_mtime_ns,
        info.st_ctime_ns,
    )


def _same_file_identity(left: os.stat_result, right: os.stat_result, *, compare_ctime: bool = True) -> bool:
    fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns")
    if compare_ctime:
        fields += ("st_ctime_ns",)
    return all(getattr(left, field) == getattr(right, field) for field in fields)


def _regular_file_stat(path: Path, label: str, *, max_bytes: int) -> os.stat_result:
    try:
        info = path.lstat()
    except OSError as error:
        raise ProbeValidationError(f"{label} is missing: {path}") from error
    reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    if (
        stat.S_ISLNK(info.st_mode)
        or getattr(info, "st_file_attributes", 0) & reparse
        or not stat.S_ISREG(info.st_mode)
    ):
        _fail(f"{label} is linked or not a regular file: {path}")
    if info.st_size < 0 or info.st_size > max_bytes:
        _fail(f"{label} exceeds its byte limit: {path}")
    return info


def _read_regular_file(path: Path, label: str, *, max_bytes: int) -> bytes:
    before = _regular_file_stat(path, label, max_bytes=max_bytes)
    try:
        with path.open("rb") as stream:
            opened = os.fstat(stream.fileno())
            if not _same_file_identity(opened, before, compare_ctime=False):
                _fail(f"{label} changed while opening: {path}")
            raw = stream.read(max_bytes + 1)
            after = os.fstat(stream.fileno())
    except OSError as error:
        raise ProbeValidationError(f"cannot read {label}: {path}") from error
    final = _regular_file_stat(path, label, max_bytes=max_bytes)
    if (
        len(raw) > max_bytes
        or len(raw) != before.st_size
        or _file_identity(after) != _file_identity(opened)
        or _file_identity(final) != _file_identity(before)
    ):
        _fail(f"{label} changed while reading: {path}")
    return raw


def _sha256_file(path: Path) -> tuple[int, str]:
    before = _regular_file_stat(path, "artifact", max_bytes=_MAX_ARTIFACT_BYTES)
    try:
        with path.open("rb") as stream:
            opened = os.fstat(stream.fileno())
            if not _same_file_identity(opened, before, compare_ctime=False):
                _fail(f"artifact changed while opening: {path}")
            digest = hashlib.sha256()
            size = 0
            while chunk := stream.read(1024 * 1024):
                size += len(chunk)
                if size > _MAX_ARTIFACT_BYTES:
                    _fail(f"artifact exceeds its byte limit while hashing: {path}")
                digest.update(chunk)
            after = os.fstat(stream.fileno())
    except OSError as error:
        raise ProbeValidationError(f"cannot hash artifact {path}: {error}") from error
    final = _regular_file_stat(path, "artifact", max_bytes=_MAX_ARTIFACT_BYTES)
    if (
        _file_identity(after) != _file_identity(opened)
        or _file_identity(final) != _file_identity(before)
        or size != before.st_size
    ):
        _fail(f"artifact changed while hashing: {path}")
    return size, digest.hexdigest()


def collect_probe_artifact_hashes(case_dir: str | Path) -> dict[str, dict[str, Any]]:
    """Hash the complete current case tree without following filesystem links."""
    root = Path(case_dir)
    reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    try:
        info = root.lstat()
    except OSError as error:
        raise ProbeValidationError(f"case output directory is missing: {root}") from error
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & reparse or not stat.S_ISDIR(info.st_mode):
        _fail("case output is linked or is not a regular directory")
    hashes: dict[str, dict[str, Any]] = {}
    def raise_walk_error(error: OSError) -> None:
        raise ProbeValidationError(f"cannot completely scan case output tree: {error}") from error

    try:
        for current, directories, filenames in os.walk(
            root, topdown=True, followlinks=False, onerror=raise_walk_error
        ):
            parent = Path(current)
            for name in tuple(directories):
                path = parent / name
                entry = path.lstat()
                if stat.S_ISLNK(entry.st_mode) or getattr(entry, "st_file_attributes", 0) & reparse or not stat.S_ISDIR(entry.st_mode):
                    _fail(f"case output contains a linked or invalid directory: {path}")
            for name in filenames:
                path = parent / name
                size, digest = _sha256_file(path)
                relative = path.relative_to(root).as_posix()
                if PurePosixPath(relative).is_absolute() or ".." in PurePosixPath(relative).parts:
                    _fail("case artifact path escapes its output directory")
                hashes[relative] = {"size": size, "sha256": digest}
    except OSError as error:
        raise ProbeValidationError(f"cannot completely scan case output tree: {error}") from error
    return dict(sorted(hashes.items()))


def _read_receipt(path: str | Path, label: str) -> tuple[Path, bytes, dict[str, Any]]:
    source = Path(path)
    raw = _read_regular_file(source, label, max_bytes=_MAX_RECEIPT_BYTES)
    return source, raw, _strict_json(raw, label)


def _map(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        _fail(f"{label} must be an object")
    return value


def _string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        _fail(f"{label} must be a non-empty string")
    return value


def _digest(value: Any, label: str, native: bool = False) -> str:
    pattern = _NATIVE_SHA if native else _HEX64
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        _fail(f"{label} has an invalid SHA-256 digest")
    return value


def _json_file(path: Path, label: str, limit: int = _MAX_RECEIPT_BYTES) -> dict[str, Any]:
    raw = _read_regular_file(path, f"required native artifact {label}", max_bytes=limit)
    return _strict_json(raw, label, limit)


def _require_receipt_binding(request: Mapping[str, Any], result: Mapping[str, Any], raw: bytes) -> None:
    if request.get("schema_version") != REQUEST_SCHEMA or request.get("status") != "prepared":
        _fail("run-request schema or prepared state is invalid")
    if result.get("schema_version") != RESULT_SCHEMA or result.get("status") != "completed_unqualified":
        _fail("run-result schema or runtime state is invalid")
    if result.get("qualification") != "NOT VERIFIED" or result.get("return_code") != 0:
        _fail("run-result qualification or native exit status is invalid")
    if result.get("request_sha256") != hashlib.sha256(raw).hexdigest():
        _fail("run-result request_sha256 does not bind current request bytes")
    if result.get("mode") != request.get("mode") or request.get("mode") not in {"serial", "adaptive"}:
        _fail("run-result mode differs from the prepared request")
    for field in ("job", "source", "bundle", "model", "numerics", "mode_policy"):
        if result.get(field) != request.get(field):
            _fail(f"run-result {field} differs from its prepared request")
    policy = _map(request.get("mode_policy"), "run-request.mode_policy")
    if policy.get("mode") != request.get("mode"):
        _fail("prepared mode policy does not bind its explicit mode")


def _verify_inventory(case_dir: Path, result: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    artifacts = _map(result.get("artifacts"), "run-result.artifacts")
    expected = _map(artifacts.get("case_artifact_hashes"), "run-result case artifact hashes")
    actual = collect_probe_artifact_hashes(case_dir)
    normalized = {}
    for relative, record in expected.items():
        if not isinstance(relative, str):
            _fail("run-result artifact path is invalid")
        record = _map(record, f"run-result artifact {relative}")
        if type(record.get("size")) is not int or record["size"] < 0:
            _fail(f"run-result artifact size is invalid: {relative}")
        normalized[relative] = {
            "size": record["size"],
            "sha256": _digest(record.get("sha256"), f"run-result artifact {relative}"),
        }
    if normalized != actual:
        changed = sorted(set(normalized) ^ set(actual))
        changed += [path for path in sorted(set(normalized) & set(actual)) if normalized[path] != actual[path]]
        _fail(f"current native artifact hash inventory mismatch at {changed[0] if changed else '<unknown>'}")
    return actual


def _case_artifact_path(case_dir: Path, value: Any, expected: str, label: str) -> Path:
    relative = _string(value, label)
    posix = PurePosixPath(relative)
    if (
        "\\" in relative
        or posix.is_absolute()
        or any(part in {"", ".", ".."} for part in posix.parts)
        or posix.as_posix() != relative
        or relative != expected
    ):
        _fail(f"{label} is not the canonical native sample path")
    path = case_dir.joinpath(*posix.parts)
    try:
        if not path.resolve(strict=True).is_relative_to(case_dir.resolve(strict=True)):
            _fail(f"{label} escapes the native case directory")
    except OSError as error:
        raise ProbeValidationError(f"{label} is missing: {relative}") from error
    return path


def _validate_consumer_build_identity(
    identity: Mapping[str, Any], native_identity: Mapping[str, Any], sample_index: int
) -> dict[str, Any]:
    expected_snapshot = _string(native_identity.get("source_snapshot_sha256"), "native source snapshot")
    expected_commit = _string(native_identity.get("head_commit_full"), "native source commit")
    consumer = _map(identity.get("consumer_build_identity"), f"native sample {sample_index} consumer build identity")
    if (
        identity.get("consumer_source_snapshot_sha256") != expected_snapshot
        or consumer.get("source_snapshot_sha256") != expected_snapshot
        or consumer.get("git_commit") != expected_commit
    ):
        _fail(f"native sample {sample_index} consumer build identity differs from the managed runtime")
    return {"source_snapshot_sha256": expected_snapshot, "git_commit": expected_commit}


def _validate_managed_runtime_identity(request: Mapping[str, Any]) -> dict[str, Any]:
    root = Path(_string(request.get("repo_root"), "run-request.repo_root")).resolve(strict=True)
    layout = managed.fullmag_storage.resolve_layout(root, "windows-native")
    if Path(layout["repo_root"]).resolve(strict=True) != root:
        _fail("managed storage resolver selected a different worktree")
    job_binding = _map(request.get("job"), "run-request.job")
    job = managed._read_job(layout, _string(job_binding.get("job_id"), "run-request job id"))
    if (
        job.get("state") != "succeeded"
        or job.get("exit_code") != 0
        or job.get("profile") != managed.CPU_ABI_RUNTIME_PROFILE
        or job.get("source_digest") != job_binding.get("source_digest")
        or job.get("worktree_id") != job_binding.get("worktree_id")
    ):
        _fail("current managed job receipt differs from the frozen-v2 run request")
    try:
        context = managed._validate_build_context(layout, job)
        managed.bind_identity(context.native_identity, context.manifest)
    except (managed.BenchmarkError, OSError, ValueError, KeyError, TypeError) as error:
        raise ProbeValidationError(f"current managed runtime identity failed revalidation: {error}") from error
    source = _map(request.get("source"), "run-request.source")
    expected_identity = _map(source.get("native_source_identity"), "run-request native source identity")
    if dict(context.native_identity) != dict(expected_identity):
        _fail("run-request native source identity differs from the current managed build")
    if source.get("source_snapshot_sha256") != context.native_identity.get("source_snapshot_sha256"):
        _fail("run-request source snapshot differs from the current managed build")
    actual_identity_sha = hashlib.sha256(managed.canonical(context.native_identity)).hexdigest()
    if source.get("native_source_identity_sha256") != actual_identity_sha:
        _fail("run-request native source identity hash is invalid")
    return dict(context.native_identity)


def _validate_linked_linearization_state(
    case_dir: Path, identity: Mapping[str, Any], sample_index: int, equilibrium: Mapping[str, Any]
) -> dict[str, str]:
    state_schema = identity.get("linearization_state_schema")
    state_filename = {
        "LinearizationState.v6": "linearization_state.v6.json",
        "LinearizationState.v7": "linearization_state.v7.json",
    }.get(state_schema)
    equilibrium_schema = equilibrium.get("schema_version")
    if state_filename is None or equilibrium_schema not in {"equilibrium_artifact.v7", "equilibrium_artifact.v8"}:
        _fail(f"native sample {sample_index} has an unsupported EQ/LinearizationState schema")
    state_relative = f"eigen/metadata/sample_{sample_index:04d}/{state_filename}"
    state_path = _case_artifact_path(case_dir, identity.get("linearization_state_path"), state_relative, "native LIN path")
    state_raw = _read_regular_file(state_path, f"native sample {sample_index} LinearizationState", max_bytes=256 * 1024**2)
    state = _strict_json(state_raw, f"native sample {sample_index} LinearizationState", 256 * 1024**2)
    state_sha = _digest(identity.get("linearization_state_sha256"), f"native sample {sample_index} LIN hash", native=True)
    if state.get("schema_version") != state_schema or state.get("content_sha256") != state_sha:
        _fail(f"native sample {sample_index} LIN payload does not match its identity digest/schema")
    try:
        if state_schema == "LinearizationState.v6":
            if equilibrium_schema != "equilibrium_artifact.v7":
                _fail(f"native sample {sample_index} LinearizationState.v6 requires equilibrium v7")
            verify_fem_frequency_domain_eigen_artifacts.validate_linearization_state_v6_payload(
                state, dict(equilibrium), state_sha
            )
        else:
            if equilibrium_schema != "equilibrium_artifact.v8":
                _fail(f"native sample {sample_index} LinearizationState.v7 requires equilibrium v8")
            verify_fem_frequency_domain_eigen_artifacts.validate_linearization_state_v7_payload(
                state, dict(equilibrium), state_sha
            )
    except SystemExit as error:
        _fail(f"native sample {sample_index} linked LinearizationState validation failed: {error}")
    return {"path": state_relative, "sha256": state_sha}


def _validate_native_equilibrium_binding(
    case_dir: Path,
    identity: Mapping[str, Any],
    sample_index: int,
    bundle: Mapping[str, Any],
    expected_content_sha256: str,
) -> tuple[dict[str, Any], dict[str, str]]:
    """Replay the frozen source EQ and its canonical sample-local native copy."""
    bundle_path = Path(_string(bundle.get("path"), "bundle path"))
    selected = _string(bundle.get("selected_equilibrium_bundle_path"), "selected source EQ path")
    selected_posix = PurePosixPath(selected)
    if (
        "\\" in selected
        or selected_posix.is_absolute()
        or any(part in {"", ".", ".."} for part in selected_posix.parts)
        or selected_posix.as_posix() != selected
    ):
        _fail("selected frozen source equilibrium path is not canonical")
    try:
        source_path = adapter._bundle_file_path(bundle_path, selected)
    except (OSError, ValueError) as error:
        raise ProbeValidationError(f"frozen source equilibrium path is invalid: {error}") from error
    source_raw = _read_regular_file(
        source_path, f"frozen source equilibrium sample {sample_index}", max_bytes=256 * 1024**2
    )
    source_raw_sha256 = hashlib.sha256(source_raw).hexdigest()
    expected_source_raw_sha256 = _digest(
        bundle.get("selected_equilibrium_raw_sha256"), "frozen source EQ raw hash"
    )
    if source_raw_sha256 != expected_source_raw_sha256:
        _fail(f"frozen source equilibrium sample {sample_index} raw bytes differ from the request")
    source_equilibrium = _strict_json(
        source_raw, f"frozen source equilibrium sample {sample_index}", 256 * 1024**2
    )
    source_schema = source_equilibrium.get("schema_version")
    if source_schema not in {"equilibrium_artifact.v7", "equilibrium_artifact.v8"}:
        _fail(f"frozen source equilibrium sample {sample_index} has an unsupported schema")
    if source_equilibrium.get("content_sha256") != expected_content_sha256:
        _fail(f"frozen source equilibrium sample {sample_index} content hash differs from the bundle identity")
    try:
        if source_schema == "equilibrium_artifact.v7":
            verify_fem_frequency_domain_eigen_artifacts.validate_equilibrium_artifact_v7_payload(
                source_equilibrium, expected_content_sha256
            )
        else:
            verify_fem_frequency_domain_eigen_artifacts.validate_equilibrium_artifact_v8_payload(
                source_equilibrium, expected_content_sha256
            )
    except SystemExit as error:
        _fail(f"frozen source equilibrium sample {sample_index} failed native payload validation: {error}")

    filename = "equilibrium_artifact.v7.json" if source_schema == "equilibrium_artifact.v7" else "equilibrium_artifact.v8.json"
    output_relative = f"eigen/metadata/sample_{sample_index:04d}/{filename}"
    if identity.get("equilibrium_artifact_path") != output_relative:
        _fail(f"native sample {sample_index} equilibrium artifact path is not its canonical output sidecar path")
    if (
        identity.get("equilibrium_artifact_schema") != source_schema
        or identity.get("equilibrium_artifact_sha256") != expected_content_sha256
        or identity.get("equilibrium_content_sha256") != expected_content_sha256
    ):
        _fail(f"native sample {sample_index} equilibrium identity differs from frozen source EQ")
    output_path = _case_artifact_path(
        case_dir, identity.get("equilibrium_artifact_path"), output_relative,
        f"native sample {sample_index} equilibrium artifact path",
    )
    output_raw = _read_regular_file(
        output_path, f"native equilibrium sidecar sample {sample_index}", max_bytes=256 * 1024**2
    )
    output_equilibrium = _strict_json(
        output_raw, f"native equilibrium sidecar sample {sample_index}", 256 * 1024**2
    )
    if output_equilibrium.get("schema_version") != source_schema:
        _fail(f"native equilibrium sidecar sample {sample_index} schema differs from frozen source EQ")
    try:
        if source_schema == "equilibrium_artifact.v7":
            verify_fem_frequency_domain_eigen_artifacts.validate_equilibrium_artifact_v7_payload(
                output_equilibrium, expected_content_sha256
            )
        else:
            verify_fem_frequency_domain_eigen_artifacts.validate_equilibrium_artifact_v8_payload(
                output_equilibrium, expected_content_sha256
            )
    except SystemExit as error:
        _fail(f"native equilibrium sidecar sample {sample_index} failed content-digest replay: {error}")
    if output_equilibrium != source_equilibrium:
        _fail(f"native equilibrium sidecar sample {sample_index} is not bound to the frozen source EQ payload")
    return output_equilibrium, {
        "path": output_relative,
        "source_bundle_path": selected,
        "source_raw_sha256": source_raw_sha256,
        "native_raw_sha256": hashlib.sha256(output_raw).hexdigest(),
        "content_sha256": expected_content_sha256,
    }


def _validate_linked_native_payloads(
    case_dir: Path,
    identity: Mapping[str, Any],
    sample_index: int,
    bundle: Mapping[str, Any],
    eq_sha: str,
    source_mesh: str,
) -> dict[str, Any]:
    equilibrium, equilibrium_binding = _validate_native_equilibrium_binding(
        case_dir, identity, sample_index, bundle, eq_sha
    )
    state_binding = _validate_linked_linearization_state(case_dir, identity, sample_index, equilibrium)

    field_schema = _string(identity.get("accepted_fields_schema"), "accepted fields schema")
    field_suffix = "v1" if field_schema == "CertifiedFemEquilibriumFields.v1" else "v2" if field_schema == "CertifiedFemEquilibriumFields.v2" else None
    if field_suffix is None or identity.get("certified_fields_schema") != field_schema:
        _fail(f"native sample {sample_index} has unsupported accepted/certified field schemas")
    sample_root = f"eigen/metadata/sample_{sample_index:04d}"
    linked = (
        ("accepted_fields_path", f"{sample_root}/accepted_fem_equilibrium_fields.{field_suffix}.json", "accepted_fields_bytes_sha256", "accepted_fields_content_sha256"),
        ("certified_fields_path", f"{sample_root}/certified_fem_equilibrium_fields.{field_suffix}.json", "certified_fields_bytes_sha256", "certified_fields_content_sha256"),
    )
    field_payloads: dict[str, Any] = {}
    for path_key, relative, bytes_key, content_key in linked:
        path = _case_artifact_path(case_dir, identity.get(path_key), relative, path_key)
        raw = _read_regular_file(path, f"native sample {sample_index} {path_key}", max_bytes=256 * 1024**2)
        value = _strict_json(raw, f"native sample {sample_index} {path_key}", 256 * 1024**2)
        raw_sha = "sha256:" + hashlib.sha256(raw).hexdigest()
        if raw_sha != _digest(identity.get(bytes_key), f"native sample {sample_index} {bytes_key}", native=True):
            _fail(f"native sample {sample_index} linked {path_key} bytes differ from identity")
        if value.get("schema_version") != field_schema or value.get("content_sha256") != identity.get(content_key):
            _fail(f"native sample {sample_index} linked {path_key} schema/content differs from identity")
        field_payloads[path_key] = value

    certificate_schema = "RecomputedFemLinearizationCertificate." + field_suffix
    cert_relative = f"{sample_root}/recomputed_fem_linearization_certificate.{field_suffix}.json"
    cert_path = _case_artifact_path(case_dir, identity.get("recomputed_certificate_path"), cert_relative, "recomputed certificate path")
    cert_raw = _read_regular_file(cert_path, f"native sample {sample_index} recomputed certificate", max_bytes=32 * 1024**2)
    certificate = _strict_json(cert_raw, f"native sample {sample_index} recomputed certificate", 32 * 1024**2)
    if (
        identity.get("recomputed_certificate_schema") != certificate_schema
        or certificate.get("schema_version") != certificate_schema
        or "sha256:" + hashlib.sha256(cert_raw).hexdigest()
        != _digest(identity.get("recomputed_certificate_bytes_sha256"), f"native sample {sample_index} certificate bytes hash", native=True)
        or certificate.get("content_sha256") != identity.get("recomputed_certificate_content_sha256")
    ):
        _fail(f"native sample {sample_index} linked recomputed certificate differs from identity")
    certificate_preimage = _string(identity.get("recomputed_certificate_preimage_json"), "certificate exact preimage").encode("utf-8")
    if "sha256:" + hashlib.sha256(certificate_preimage).hexdigest() != _digest(
        identity.get("recomputed_certificate_preimage_sha256"), "certificate preimage SHA", native=True
    ):
        _fail(f"native sample {sample_index} recomputed certificate preimage hash is invalid")
    try:
        field_replay = fem_equilibrium_field_replay.replay_accepted_recomputed_fields(
            field_payloads["accepted_fields_path"],
            field_payloads["certified_fields_path"],
            certificate,
            node_count=identity.get("node_count"),
            certificate_preimage=certificate_preimage,
            expected_mesh_topology_sha256=source_mesh,
            expected_identity_signatures={
                key: identity.get(key)
                for key in (
                    "equilibrium_material_signature",
                    "equilibrium_static_physics_signature",
                    "equilibrium_boundary_signature",
                )
            },
        )
    except (ValueError, TypeError, KeyError) as error:
        _fail(f"native sample {sample_index} accepted/certified field replay failed: {error}")
    if not field_replay.field_replay_verified or field_replay.certificate_content_digest_status != "verified_exact_preimage":
        _fail(f"native sample {sample_index} accepted/certified field replay is incomplete")
    return {
        "equilibrium_artifact_path": equilibrium_binding["path"],
        "source_equilibrium_bundle_path": equilibrium_binding["source_bundle_path"],
        "source_equilibrium_raw_sha256": equilibrium_binding["source_raw_sha256"],
        "native_equilibrium_raw_sha256": equilibrium_binding["native_raw_sha256"],
        "equilibrium_content_sha256": equilibrium_binding["content_sha256"],
        "linearization_state_path": state_binding["path"],
        "linearization_state_sha256": state_binding["sha256"],
        "accepted_fields_sha256": identity["accepted_fields_bytes_sha256"],
        "certified_fields_sha256": identity["certified_fields_bytes_sha256"],
        "recomputed_certificate_sha256": identity["recomputed_certificate_bytes_sha256"],
        "field_replay_verified": True,
    }


def _certificate_preimage_has_consumer_plan(value: Any) -> bool:
    if isinstance(value, Mapping):
        for key, child in value.items():
            normalized_key = str(key).lower().replace("_", "")
            if "consumerplan" in normalized_key or _certificate_preimage_has_consumer_plan(child):
                return True
    elif isinstance(value, list):
        return any(_certificate_preimage_has_consumer_plan(child) for child in value)
    return False


def immutable_physical_identity(identity: Mapping[str, Any], sample_index: int) -> dict[str, Any]:
    """Project cross-mode physical/build provenance, excluding consumer policy and its digest."""
    certificate_preimage = _string(
        identity.get("recomputed_certificate_preimage_json"),
        f"native sample {sample_index} exact certificate preimage",
    ).encode("utf-8")
    certificate = _strict_json(
        certificate_preimage,
        f"native sample {sample_index} exact certificate preimage",
        32 * 1024**2,
    )
    if _certificate_preimage_has_consumer_plan(certificate):
        _fail(f"native sample {sample_index} certificate preimage includes consumer_plan and cannot bind cross-mode identity")
    excluded = {"consumer_plan_snapshot_sha256", "content_sha256"}
    fields = fem_linearization_identity_replay.IDENTITY_FIELDS - excluded
    if set(identity) != fem_linearization_identity_replay.IDENTITY_FIELDS:
        _fail(f"native sample {sample_index} immutable identity projection has an unsupported field set")
    return {key: identity[key] for key in sorted(fields)}


def _validate_native_input_bindings(
    case_dir: Path, request: Mapping[str, Any], native_identity: Mapping[str, Any]
) -> list[dict[str, Any]]:
    bundle = _map(request.get("bundle"), "run-request.bundle")
    eq_sha = _digest(bundle.get("selected_equilibrium_native_content_sha256"), "bundle EQ native hash", native=True)
    source_mesh = _digest(bundle.get("source_mesh_topology_sha256"), "bundle source mesh hash", native=True)
    modal_mesh = _digest(bundle.get("modal_mesh_topology_fingerprint_v3"), "bundle modal mesh hash", native=True)
    source_bundle = _map(request.get("bundle"), "run-request.bundle")
    identities = sorted(case_dir.glob("eigen/metadata/sample_*/linearization_identity.v2.json"))
    expected_paths = [
        case_dir / f"eigen/metadata/sample_{index:04d}/linearization_identity.v2.json"
        for index in EXPECTED_SAMPLE_INDICES
    ]
    if set(identities) != set(expected_paths):
        missing = next((i for i, path in enumerate(expected_paths) if path not in identities), None)
        if missing is not None:
            _fail(f"native EQ/source/modal binding missing for sample {missing}: identity file absent")
        _fail("native linearization identities do not cover exactly samples 0, 1, and 2")
    reports = []
    state_paths = set()
    expected = {
        "equilibrium_artifact_sha256": eq_sha,
        "equilibrium_content_sha256": eq_sha,
        "source_mesh_topology_sha256": source_mesh,
        "modal_mesh_topology_fingerprint_v3": modal_mesh,
    }
    for sample_index, identity_path in enumerate(expected_paths):
        preimage_path = identity_path.with_name("linearization_identity_preimage.v1.json")
        identity_raw = _read_regular_file(identity_path, f"native sample {sample_index} identity", max_bytes=8 * 1024**2)
        preimage_raw = _read_regular_file(preimage_path, f"native sample {sample_index} identity preimage", max_bytes=8 * 1024**2)
        try:
            identity = fem_linearization_identity_replay.strict_json_object(
                identity_raw, f"native sample {sample_index} identity"
            )
            identity_content = fem_linearization_identity_replay.replay_identity_preimage(
                identity_raw, preimage_raw
            )
            fem_equilibrium_identity_replay.replay_equilibrium_identity_preimages(identity_raw)
        except fem_linearization_identity_replay.IdentityReplayError as error:
            _fail(f"native sample {sample_index} identity exact-byte replay failed: {error}")
        except fem_equilibrium_identity_replay.EquilibriumIdentityReplayError as error:
            _fail(f"native sample {sample_index} EQ preimage replay failed: {error}")
        if type(identity.get("sample_index")) is not int or identity["sample_index"] != sample_index:
            _fail(f"native sample {sample_index} identity path/index binding is invalid")
        if {key: identity.get(key) for key in REQUIRED_IDENTITY_FIELDS} != expected:
            _fail(f"native sample {sample_index} EQ/source/modal identity differs from frozen input")
        consumer_build = _validate_consumer_build_identity(identity, native_identity, sample_index)
        linearization_path = _string(
            identity.get("linearization_state_path"), f"native sample {sample_index} LIN path"
        )
        if not linearization_path.startswith(f"eigen/metadata/sample_{sample_index:04d}/"):
            _fail(f"native sample {sample_index} LinearizationState path is not sample-local")
        if linearization_path in state_paths:
            _fail("native output reuses one LinearizationState path across k samples")
        state_paths.add(linearization_path)
        lin_sha = _digest(identity.get("linearization_state_sha256"),
                          f"native sample {sample_index} LIN hash", native=True)
        linked_payloads = _validate_linked_native_payloads(
            case_dir, identity, sample_index, source_bundle, eq_sha, source_mesh
        )
        physical_identity = immutable_physical_identity(identity, sample_index)
        reports.append({
            "sample_index": sample_index,
            "identity_sha256": "sha256:" + hashlib.sha256(identity_raw).hexdigest(),
            "identity_content_sha256": identity_content,
            "consumer_plan_snapshot_sha256": identity["consumer_plan_snapshot_sha256"],
            "immutable_physical_identity": physical_identity,
            "immutable_physical_identity_sha256": "sha256:" + hashlib.sha256(json.dumps(
                physical_identity, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
            ).encode("utf-8")).hexdigest(),
            "equilibrium_content_sha256": eq_sha,
            "source_mesh_topology_sha256": source_mesh,
            "modal_mesh_topology_fingerprint_v3": modal_mesh,
            **consumer_build,
            **linked_payloads,
        })
    preimages = sorted(case_dir.glob("eigen/metadata/sample_*/linearization_identity_preimage.v1.json"))
    expected_preimages = [path.with_name("linearization_identity_preimage.v1.json") for path in expected_paths]
    if set(preimages) != set(expected_preimages):
        _fail("native identity exact preimages do not cover exactly samples 0, 1, and 2")
    return reports


def _source_parameters(bundle_path: Path, manifest: Mapping[str, Any], model_sha: str) -> dict[str, Any]:
    provenance = bundle_path / "provenance"
    source_request_path = provenance / "run-request.json"
    source_result_path = provenance / "run-result.json"
    source_request_raw = _read_regular_file(
        source_request_path, "frozen source run-request", max_bytes=_MAX_RECEIPT_BYTES
    )
    source_result_raw = _read_regular_file(
        source_result_path, "frozen source run-result", max_bytes=_MAX_RECEIPT_BYTES
    )
    source_request = _strict_json(source_request_raw, "frozen source run-request")
    source_result = _strict_json(source_result_raw, "frozen source run-result")
    if (
        source_request.get("schema") != "fullmag.de-smoke.request.v1"
        or source_request.get("sampling") != "signed-fifteen"
        or source_request.get("cases") != [pilot.SIGNED_FIFTEEN_PILOT]
        or source_result.get("schema") != "fullmag.de-smoke.result.v1"
        or source_result.get("pilot") != pilot.SIGNED_FIFTEEN_PILOT
        or source_result.get("status") != "completed_unqualified"
        or source_result.get("return_code") != 0
    ):
        _fail("frozen source receipts are not a completed signed-fifteen campaign")
    if source_request.get("model_sha256") != model_sha or source_result.get("model_sha256") != model_sha:
        _fail("frozen source request/result model hash differs from accepted source model")
    source_model = _map(source_request.get("model_source"), "source request.model_source")
    if source_result.get("model_source") != source_model:
        _fail("frozen source request/result model identity differs")
    values = {
        "eps_prefilter": source_request.get("eps_prefilter_diagnostic_requested"),
        "shifted_ksp_rtol": source_request.get("shifted_ksp_rtol_diagnostic_requested"),
        "gmres_restart": source_request.get("gmres_restart_diagnostic_requested"),
        "shifted_ksp_type": source_request.get("shifted_ksp_type_diagnostic_requested"),
    }
    if values != {
        "eps_prefilter": "1e-9", "shifted_ksp_rtol": "1e-9",
        "gmres_restart": "8", "shifted_ksp_type": "fgmres",
    }:
        _fail("source request lacks receipt-bound EPS/KSP/restart/FGMRES settings")
    if source_result.get("shifted_ksp_type_diagnostic_requested") != values["shifted_ksp_type"]:
        _fail("source run-result does not bind the requested shifted KSP type")
    artifacts = _map(source_result.get("artifacts"), "source run-result.artifacts")
    trial = _map(artifacts.get("shifted_ksp_trial"), "source shifted KSP trial")
    if (
        trial.get("status") != "pass" or trial.get("qualification") != "NOT VERIFIED"
        or trial.get("requested_type") != values["shifted_ksp_type"]
        or trial.get("requested_rtol") != float(values["shifted_ksp_rtol"])
    ):
        _fail("source run-result shifted KSP trial does not bind requested native settings")
    required = _map(artifacts.get("required_artifact_hashes"), "source artifact hashes")
    solver_record = _map(required.get("eigen/diagnostics/solver.v1.json"), "source solver diagnostics hash")
    if type(solver_record.get("size")) is not int or solver_record["size"] <= 0:
        _fail("source native solver diagnostics receipt is empty")
    _digest(solver_record.get("sha256"), "source solver diagnostics hash")
    numerical = _map(manifest.get("numerical_settings"), "bundle numerical settings")
    model_metadata = _map(numerical.get("model_metadata"), "source model metadata")
    frequency = numerical.get("frequency_window_hz")
    if (
        not isinstance(frequency, list) or len(frequency) != 2
        or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in frequency)
        or frequency != [8.5e9, 16.0e9] or model_metadata.get("frequency_window_hz") != frequency
    ):
        _fail("accepted source does not preserve the complete [8.5, 16] GHz window")
    return {
        **values, "frequency_window_hz": list(frequency),
        "model_metadata": dict(model_metadata),
        "validated_parameters": numerical.get("validated_parameters"),
        "source_shifted_ksp_trial": dict(trial),
        "source_solver_diagnostics_sha256": solver_record["sha256"],
        "source_run_request_sha256": hashlib.sha256(source_request_raw).hexdigest(),
        "source_run_result_sha256": hashlib.sha256(source_result_raw).hexdigest(),
    }


def _revalidate_bundle(request: Mapping[str, Any]) -> tuple[adapter.PreparedFrozenV2Probe, dict[str, Any]]:
    binding = _map(request.get("bundle"), "run-request.bundle")
    bundle_path = Path(_string(binding.get("path"), "bundle.path"))
    storage = Path(_string(binding.get("storage_root"), "bundle.storage_root"))
    try:
        manifest = freezer.validate_bundle(bundle_path, storage)
        prepared = adapter.prepare_frozen_v2_probe(bundle_path, storage)
        launch_check = adapter.verify_bundle_for_launch(prepared, storage)
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise ProbeValidationError(f"current frozen bundle failed revalidation: {error}") from error
    expected = {
        "manifest_sha256": prepared.manifest_sha256,
        "file_table_sha256": prepared.closure_file_table_sha256,
        "run_request_sha256": prepared.run_request_sha256,
        "run_result_sha256": prepared.run_result_sha256,
        "metadata_raw_sha256": prepared.metadata_raw_sha256,
        "mesh_ir_raw_sha256": prepared.mesh_ir_raw_sha256,
        "selected_equilibrium_raw_sha256": prepared.selected_equilibrium_raw_sha256,
        "selected_equilibrium_native_content_sha256": prepared.selected_equilibrium_native_content_sha256,
        "source_mesh_topology_sha256": prepared.source_mesh_topology_sha256,
        "modal_mesh_topology_fingerprint_v3": prepared.modal_mesh_topology_fingerprint_v3,
        "selected_equilibrium_bundle_path": prepared.selected_equilibrium_bundle_path,
        "container_input_root": prepared.container_input_root,
        "source_sample_indices": list(prepared.source_sample_indices),
        "k_vectors_rad_per_m": [list(v) for v in prepared.k_vectors_rad_per_m],
    }
    if any(binding.get(key) != value for key, value in expected.items()):
        _fail("run-request frozen bundle identity differs from current bundle")
    model = _map(request.get("model"), "run-request.model")
    if model.get("original") != {
        "commit": prepared.model_source_commit, "path": prepared.model_source_path,
        "sha256": prepared.source_model_sha256,
    } or model.get("derived_script_sha256") != prepared.runtime_script_sha256:
        _fail("run-request original/derived model identity differs from frozen bundle")
    if model.get("derived_script_path"):
        path = Path(_string(model["derived_script_path"], "derived script path"))
        size, digest = _sha256_file(path)
        if size != len(prepared.runtime_script_bytes) or digest != prepared.runtime_script_sha256:
            _fail("current derived model bytes differ from frozen adapter output")
    numerics = _source_parameters(bundle_path, manifest, prepared.source_model_sha256)
    if request.get("numerics") != numerics:
        _fail("run-request numeric settings differ from accepted source receipts")
    policy = _map(manifest.get("parallel_campaign"), "bundle parallel campaign")
    model_identity = {
        "kind": "versioned_standalone_input",
        "commit": prepared.model_source_commit,
        "sha256": prepared.source_model_sha256,
    }
    expected_policy = pilot.signed_fifteen_campaign_identity(model_identity, request.get("mode"))
    source_policy = dict(policy)
    source_policy["mode"] = request.get("mode")
    if source_policy != expected_policy or request.get("mode_policy") != expected_policy:
        _fail("run-request policy differs from accepted signed-fifteen source policy")
    if launch_check.get("status") != "hash_bindings_revalidated; runtime_not_executed; science_not_qualified":
        _fail("frozen input adapter returned an unsupported revalidation state")
    return prepared, manifest

def _validate_consumers(request: Mapping[str, Any]) -> dict[str, str]:
    root = Path(_string(request.get("repo_root"), "run-request.repo_root")).resolve(strict=True)
    consumers = _map(request.get("consumer_hashes"), "run-request.consumer_hashes")
    missing = [path for path in _REQUIRED_CONSUMERS if path not in consumers]
    if missing:
        _fail(f"run-request omits host consumer hash: {missing[0]}")
    actual = {}
    for relative, expected in consumers.items():
        if not isinstance(relative, str) or PurePosixPath(relative).is_absolute() or ".." in PurePosixPath(relative).parts:
            _fail("run-request consumer path escapes source checkout")
        _digest(expected, f"consumer hash {relative}")
        path = root.joinpath(*PurePosixPath(relative).parts)
        if not path.resolve(strict=True).is_relative_to(root):
            _fail(f"consumer path escapes source checkout: {relative}")
        _, found = _sha256_file(path)
        if found != expected:
            _fail(f"host consumer hash changed since launch: {relative}")
        actual[relative] = found
    return dict(sorted(actual.items()))


def _validate_output_metadata(
    case_dir: Path, request: Mapping[str, Any],
    prepared: adapter.PreparedFrozenV2Probe, numerics: Mapping[str, Any],
) -> dict[str, Any]:
    metadata = _json_file(case_dir / "metadata.json", "native run metadata")
    runtime = metadata.get("problem_meta", {}).get("runtime_metadata", {})
    model = runtime.get("de_smoke") if isinstance(runtime, Mapping) else None
    if not isinstance(model, dict):
        _fail("native metadata omits DE-SMOKE model descriptor")
    source_model = _map(numerics.get("model_metadata"), "request source model metadata")
    allowed = {
        "sampling", "kx_rad_per_m", "ky_rad_per_m", "k_vectors_rad_per_m",
        "modal_target", "selection_scope", "window_complete",
    }
    for key, value in source_model.items():
        if key not in allowed and model.get(key) != value:
            _fail(f"native physical or numerical setting changed from source: {key}")
    if (
        model.get("sampling") != "signed-fifteen"
        or model.get("modal_target") != "frequency_window"
        or model.get("selection_scope") != "frequency_window"
        or model.get("requested_mode_count") != 1
        or model.get("frequency_window_hz") != numerics.get("frequency_window_hz")
        or model.get("k_vectors_rad_per_m") != [list(v) for v in EXPECTED_VECTORS]
    ):
        _fail("native metadata does not describe the exact three-point full-window probe")
    source_hash = prepared.runtime_script_sha256
    problem = metadata.get("problem_meta")
    if (
        metadata.get("source_hash") != source_hash
        or not isinstance(problem, Mapping)
        or problem.get("source_hash") != source_hash
    ):
        _fail("native metadata does not bind the derived probe script hash")
    try:
        mesh = metadata["execution_plan"]["backend_plan"]["mesh"]
        from comsol_mesh_identity import mesh_topology_fingerprint_v3
        modal_mesh = mesh_topology_fingerprint_v3(mesh)
    except (ImportError, KeyError, TypeError, ValueError, OverflowError) as error:
        raise ProbeValidationError(f"native modal MeshIR cannot be recomputed: {error}") from error
    if modal_mesh != prepared.modal_mesh_topology_fingerprint_v3:
        _fail("native output modal mesh identity differs from frozen MeshIR")
    selection = runtime.get("runtime_selection") if isinstance(runtime, Mapping) else None
    parallel = selection.get("parallel_execution") if isinstance(selection, Mapping) else None
    if not isinstance(parallel, Mapping) or parallel.get("mode") != request.get("mode"):
        _fail("native metadata does not bind the explicit execution mode")
    policy = _map(request.get("mode_policy"), "request mode policy")
    for key in ("max_cpu_percent", "max_memory_percent", "memory_reserve_bytes",
                "max_workers", "threads_per_worker"):
        if parallel.get(key) != policy.get(key):
            _fail(f"native metadata execution policy differs from request: {key}")
    return {
        "source_hash": source_hash,
        "runtime_mode": parallel["mode"],
        "modal_mesh_topology_fingerprint_v3": modal_mesh,
        "physical_settings_match": True,
        "frequency_window_hz": model["frequency_window_hz"],
    }


def _validate_csv_spectrum(case_dir: Path, request: Mapping[str, Any]) -> dict[str, Any]:
    spectrum_path = case_dir / "eigen/spectrum.v3.json"
    spectrum = _json_file(spectrum_path, "native eigen_spectrum.v3")
    native_modes = validate_de_smoke_rows.load_spectrum_v3_modes(spectrum_path)
    if set(native_modes) != {(i, 0) for i in EXPECTED_SAMPLE_INDICES}:
        _fail("native spectrum must contain one mode at each of the three probe samples")
    samples = spectrum.get("samples")
    if not isinstance(samples, list) or len(samples) != 3:
        _fail("native spectrum must contain exactly three ordered samples")
    window = request.get("numerics", {}).get("frequency_window_hz")
    if not isinstance(window, list) or len(window) != 2:
        _fail("request omits the source frequency window")
    try:
        with (case_dir / "eigen/dispersion.csv").open("r", encoding="utf-8-sig", newline="") as stream:
            reader = csv.DictReader(stream)
            required = {"sample_index", "raw_mode_index", "kx_rad_per_m", "ky_rad_per_m", "kz_rad_per_m", "frequency_hz"}
            if reader.fieldnames is None or not required.issubset(reader.fieldnames):
                _fail("native dispersion CSV omits required row/vector/frequency columns")
            rows = list(reader)
    except OSError as error:
        raise ProbeValidationError("native dispersion CSV is missing") from error
    if len(rows) != 3:
        _fail("native dispersion CSV must contain exactly three rows")
    summaries = []
    for position, (row, sample) in enumerate(zip(rows, samples)):
        try:
            sample_index = int(row["sample_index"])
            mode_index = int(row["raw_mode_index"])
            vector = tuple(float(row[k]) for k in ("kx_rad_per_m", "ky_rad_per_m", "kz_rad_per_m"))
            frequency = float(row["frequency_hz"])
        except (KeyError, TypeError, ValueError, OverflowError) as error:
            raise ProbeValidationError(f"native dispersion CSV row {position} is malformed") from error
        if sample_index != position or sample.get("sample_index") != position or mode_index != 0:
            _fail("native CSV and spectrum sample order/mode identity disagree")
        if vector != EXPECTED_VECTORS[position] or sample.get("k_vector") != list(EXPECTED_VECTORS[position]):
            _fail(f"native sample {position} k vector differs from frozen probe")
        mode = native_modes[(position, 0)]
        if not math.isfinite(frequency) or frequency <= 0 or not window[0] <= frequency <= window[1]:
            _fail(f"native sample {position} frequency is invalid or outside the original window")
        if not math.isclose(frequency, mode["frequency_hz"], rel_tol=1e-12, abs_tol=1e-6):
            _fail(f"native CSV frequency does not bind spectrum sample {position}")
        if mode["residual_scope"] != "full_projected_weak_form_and_periodic_seams" or mode["full_descriptor_certified"] is not True:
            _fail(f"native sample {position} lacks the full projected weak-form/seam certificate")
        if mode["residual_relative_l2"] > validate_de_smoke_rows.DENSE_CERTIFICATION_TOLERANCE:
            _fail(f"native sample {position} physical residual exceeds the pinned tolerance")
        summaries.append({
            "sample_index": position, "source_sample_index": EXPECTED_SOURCE_INDICES[position],
            "k_vector_rad_per_m": list(vector), "frequency_hz": frequency,
            "residual_relative_l2": mode["residual_relative_l2"],
            "residual_scope": mode["residual_scope"],
        })
    return {
        "sample_count": 3, "samples": summaries,
        "frequency_window_hz": list(window),
        "csv_spectrum_binding": True, "full_projected_weak_form_and_seams": True,
    }

def _validate_adaptive_report(case_dir: Path, request: Mapping[str, Any], eq_sha: str) -> dict[str, Any]:
    path = case_dir / "eigen/parallel_execution.v1.json"
    if request.get("mode") == "serial":
        if path.exists():
            _fail("serial probe unexpectedly published an adaptive execution report")
        return {"status": "not_applicable", "qualification": "NOT VERIFIED"}
    raw = _json_file(path, "adaptive native process-pool report", 4 * 1024 * 1024)
    try:
        validation = validate_parallel_execution_report.validate_parallel_execution_report(
            path, expected_mode="adaptive", expected_sample_count=3, require_concurrency=False
        )
    except validate_parallel_execution_report.ValidationError as error:
        raise ProbeValidationError(f"adaptive report validation failed: {error}") from error
    if (
        validation.get("status") != "pass" or validation.get("terminal_state") != "completed"
        or validation.get("events_truncated") is not False
        or validation.get("resolved_mode") != "adaptive_processes"
    ):
        _fail("adaptive report is incomplete or does not prove adaptive workers")
    report = raw.get("report") if raw.get("schema_version") == validate_parallel_execution_report.ADMISSION_JOURNAL_SCHEMA else raw
    if not isinstance(report, Mapping) or report.get("policy") != request.get("mode_policy"):
        _fail("adaptive report policy differs from immutable run request")
    inputs = report.get("inputs")
    indices = [item.get("sample_index") for item in inputs if isinstance(item, Mapping)] if isinstance(inputs, list) else []
    if indices != list(EXPECTED_SAMPLE_INDICES):
        _fail("adaptive report does not cover all three probe samples in order")
    for index, item in enumerate(inputs):
        if not isinstance(item, Mapping) or item.get("equilibrium_artifact_sha256") != eq_sha:
            _fail(f"adaptive report sample {index} does not bind frozen equilibrium")
    counts = _map(validation.get("counts"), "adaptive report validation counts")
    if counts.get("input_samples") != 3:
        _fail("adaptive report validator did not confirm all three input samples")
    concurrency = _map(validation.get("concurrency"), "adaptive concurrency evidence")
    resource_quality = _map(validation.get("resource_quality"), "adaptive resource quality")
    return {
        "status": "pass", "qualification": "NOT VERIFIED",
        "terminal_state": validation["terminal_state"],
        "resolved_mode": validation["resolved_mode"],
        "sample_count": counts["input_samples"],
        "concurrency": dict(concurrency),
        "resource_quality": dict(resource_quality),
        "equilibrium_content_sha256": eq_sha,
        "policy": dict(request["mode_policy"]),
    }


def _validate_resource_allocation(case_dir: Path, request: Mapping[str, Any]) -> dict[str, Any]:
    path = case_dir / "validation" / "resource_allocation.v1.json"
    value = _json_file(path, "native cgroup resource allocation evidence", 1024 * 1024)
    if value.get("schema_version") != "fullmag.de.frozen_v2_probe.resource_allocation.v1":
        _fail("native resource allocation evidence schema is unsupported")
    if value.get("status") != "pass" or value.get("qualification") != "NOT VERIFIED":
        _fail("native resource allocation evidence is incomplete")
    runtime = _map(request.get("runtime"), "run-request.runtime")
    allocation = _map(runtime.get("resource_allocation"), "run-request resource allocation")
    expected_cpu = allocation.get("cpu_cores")
    expected_memory = allocation.get("memory_bytes")
    if expected_cpu != 4.0 or expected_memory != 8 * 1024**3:
        _fail("run-request resource allocation differs from the managed probe contract")
    if value.get("requested_cpu_cores") != expected_cpu or value.get("requested_memory_bytes") != expected_memory:
        _fail("native resource evidence differs from the managed Compose allocation")
    effective_cpu = value.get("effective_cpu_cores")
    memory_max = value.get("memory_max_bytes")
    if (
        isinstance(effective_cpu, bool) or not isinstance(effective_cpu, (int, float))
        or not math.isfinite(effective_cpu) or effective_cpu < expected_cpu
        or type(memory_max) is not int or memory_max < expected_memory
    ):
        _fail("native cgroup allocation is below four CPU cores or 8 GiB")
    return {
        "status": "pass", "qualification": "NOT VERIFIED",
        "effective_cpu_cores": effective_cpu,
        "memory_max_bytes": memory_max,
        "allocation_sources": value.get("allocation_sources"),
    }


def _validate_consumer_plan_replay(
    sidecars: Mapping[str, Any], native_bindings: list[Mapping[str, Any]]
) -> dict[str, Any]:
    replay = _map(sidecars.get("consumer_plan_replay"), "native consumer plan replay")
    if replay.get("status") != "consumer_plan_exact_bytes_replayed":
        _fail("native consumer plan bytes were not exactly replayed for every sample")
    digest_map = _map(replay.get("raw_sha256_by_sample"), "native consumer plan digests")
    expected = {
        str(item.get("sample_index")): item.get("consumer_plan_snapshot_sha256")
        for item in native_bindings
    }
    if set(expected) != {str(index) for index in EXPECTED_SAMPLE_INDICES} or dict(digest_map) != expected:
        _fail("native consumer plan replay does not cover and bind samples 0, 1, and 2")
    for sample_index, digest in expected.items():
        _digest(digest, f"native sample {sample_index} consumer plan digest", native=True)
    return dict(replay)


def _validate_loaded(
    case_dir: Path, request_path: Path, request_raw: bytes,
    request: Mapping[str, Any], result: Mapping[str, Any],
) -> dict[str, Any]:
    _require_receipt_binding(request, result, request_raw)
    current_hashes = _verify_inventory(case_dir, result)
    native_identity = _validate_managed_runtime_identity(request)
    native_bindings = _validate_native_input_bindings(case_dir, request, native_identity)
    manifest_path = case_dir / "frequency_domain" / "manifest.v1.json"
    solver_path = case_dir / "eigen" / "diagnostics" / "solver.v1.json"
    manifest = _json_file(manifest_path, "native frequency-domain manifest")
    solver_diagnostics = _json_file(solver_path, "native solver diagnostics")
    try:
        sidecars = verify_fem_frequency_domain_eigen_artifacts.validate_equilibrium_artifacts(
            case_dir,
            manifest,
            solver_diagnostics,
            computed_sample_indices=set(EXPECTED_SAMPLE_INDICES),
        )
    except SystemExit as error:
        _fail(f"native linked EQ/LIN sidecar validation failed: {error}")
    if (
        sidecars.get("accepted_sample_indices") != list(EXPECTED_SAMPLE_INDICES)
        or sidecars.get("identity_sample_indices") != list(EXPECTED_SAMPLE_INDICES)
        or sidecars.get("computed_sample_indices") != list(EXPECTED_SAMPLE_INDICES)
        or sidecars.get("identity_content_digest_status") != "verified_exact_preimage"
        or sidecars.get("missing_recomputed_keys")
    ):
        _fail("native manifest does not bind complete accepted/certified/recomputed sample sidecars")
    consumer_plan_replay = _validate_consumer_plan_replay(sidecars, native_bindings)
    prepared, manifest = _revalidate_bundle(request)
    numerics = _source_parameters(prepared.bundle_path, manifest, prepared.source_model_sha256)
    if request.get("numerics") != numerics:
        _fail("request numeric contract differs from current accepted source receipts")
    consumer_hashes = _validate_consumers(request)
    metadata = _validate_output_metadata(case_dir, request, prepared, numerics)
    samples = _validate_csv_spectrum(case_dir, request)
    resource_allocation = _validate_resource_allocation(case_dir, request)
    try:
        solver = validate_de_smoke_rows.validate_parallel_probe_solver_artifacts(
            case_dir,
            requested_eps_prefilter=numerics["eps_prefilter"],
            requested_shifted_ksp_rtol=numerics["shifted_ksp_rtol"],
            requested_gmres_restart=numerics["gmres_restart"],
            expected_sample_count=3,
            physical_residual_tolerance=validate_de_smoke_rows.DENSE_CERTIFICATION_TOLERANCE,
        )
        shifted = de_shifted_ksp_trial.validate_shifted_ksp_trial(
            case_dir, "parallel-probe", numerics["shifted_ksp_type"], numerics["shifted_ksp_rtol"]
        )
        demag = validate_de_smoke_rows.validate_dynamic_demag_probes(
            case_dir / "eigen/diagnostics/solver.v1.json", EXPECTED_SAMPLE_INDICES
        )
        potential = pilot.validate_smoke_potential_fields(case_dir, expected_sample_count=3)
    except (OSError, ValueError, KeyError, TypeError, pilot.managed.BenchmarkError) as error:
        raise ProbeValidationError(f"native modal/KSP/demag/potential gate failed: {error}") from error
    if solver.get("qualification") != "NOT VERIFIED" or shifted.get("qualification") != "NOT VERIFIED":
        _fail("native solver helper overclaimed qualification")
    if potential.get("mode_count") != 3 or potential.get("qualification") != "NOT VERIFIED":
        _fail("native potential/source-mesh/mode binding is incomplete")
    report = _validate_adaptive_report(case_dir, request, prepared.selected_equilibrium_native_content_sha256)
    return {
        "schema_version": "fullmag.de.frozen_v2_probe.artifact_validation.v2",
        "status": "passed_artifact_preflight", "qualification": "NOT VERIFIED",
        "native_bindings_by_sample": native_bindings, "native_metadata": metadata,
        "native_sidecar_validation": sidecars,
        "consumer_plan_replay": consumer_plan_replay,
        "samples": samples, "solver": solver, "shifted_ksp": shifted,
        "dynamic_demag": demag, "potential": potential, "adaptive_report": report,
        "resource_allocation": resource_allocation,
        "case_artifact_file_count": len(current_hashes),
        "case_artifact_hashes_sha256": hashlib.sha256(json.dumps(
            current_hashes, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")).hexdigest(),
        "consumer_hash_count": len(consumer_hashes),
        "consumer_hashes_sha256": hashlib.sha256(json.dumps(
            consumer_hashes, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")).hexdigest(),
        "pending_requirements": [
            "serial/adaptive frequency and residual parity",
            "managed runtime receipt review",
            "mesh, airbox and mode-count convergence",
            "scientific qualification",
        ],
    }


def validate_probe_artifacts(case_dir: str | Path, request_path: str | Path, result_path: str | Path) -> dict[str, Any]:
    """Re-read durable receipts and revalidate current native outputs on every call."""
    request_file, request_raw, request = _read_receipt(request_path, "run-request")
    _, _, result = _read_receipt(result_path, "run-result")
    return _validate_loaded(Path(case_dir), request_file, request_raw, request, result)


def validate_probe_artifacts_from_values(
    case_dir: str | Path, request_path: str | Path, request_raw: bytes,
    request: Mapping[str, Any], result: Mapping[str, Any],
) -> dict[str, Any]:
    """Validate a not-yet-persisted result mapping before exclusive receipt write."""
    return _validate_loaded(Path(case_dir), Path(request_path), request_raw, request, result)
