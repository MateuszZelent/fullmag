"""Receipt identity checks for offline DE comparison, not solver qualification."""
from __future__ import annotations

import hashlib
import os
import re
import stat
from pathlib import Path, PurePosixPath


def read_required_artifact_bytes(result, run, pilot, relative_path):
    """Read one receipt-bound artifact from its exact contained case path."""
    artifacts = result.get("artifacts") if isinstance(result, dict) else None
    hashes = artifacts.get("required_artifact_hashes") if isinstance(artifacts, dict) else None
    entry = hashes.get(relative_path) if isinstance(hashes, dict) else None
    if not isinstance(entry, dict):
        raise ValueError(f"run-result does not bind required artifact {relative_path}")
    expected_size = entry.get("size")
    expected_sha256 = entry.get("sha256")
    if type(expected_size) is not int or expected_size <= 0:
        raise ValueError(f"run-result has an invalid size binding for {relative_path}")
    if (
        not isinstance(expected_sha256, str)
        or not re.fullmatch(r"[0-9a-f]{64}", expected_sha256)
    ):
        raise ValueError(f"run-result has an invalid SHA-256 binding for {relative_path}")

    if (
        not isinstance(pilot, str)
        or not pilot
        or "/" in pilot
        or "\\" in pilot
        or pilot in {".", ".."}
    ):
        raise ValueError("pilot artifact path is invalid")
    if not isinstance(relative_path, str) or "\\" in relative_path:
        raise ValueError("required artifact path is invalid")
    relative = PurePosixPath(relative_path)
    if (relative.is_absolute() or relative.as_posix() != relative_path or
            not relative.parts or any(part in {"", ".", ".."} for part in relative.parts)):
        raise ValueError("required artifact path must be a normalized relative path")

    try:
        run_root = Path(run).resolve(strict=True)
        if not run_root.is_dir():
            raise ValueError("run directory is missing")
        case_dir = run_root / pilot
        if case_dir.is_symlink():
            raise ValueError("pilot case directory must not be a symlink")
        case_root = case_dir.resolve(strict=True)
        if case_root != case_dir or not case_root.is_dir():
            raise ValueError("pilot case directory is not a contained directory")
        artifact = case_root.joinpath(*relative.parts)
        current = case_root
        for part in relative.parts:
            current = current / part
            if current.is_symlink():
                raise ValueError(f"required artifact path contains a symlink: {relative_path}")
        resolved_artifact = artifact.resolve(strict=True)
        try:
            resolved_artifact.relative_to(run_root)
        except ValueError as error:
            raise ValueError(f"required artifact escapes run directory: {relative_path}") from error
        if resolved_artifact != artifact:
            raise ValueError(f"required artifact path is not canonical: {relative_path}")

        with artifact.open("rb") as stream:
            opened = os.fstat(stream.fileno())
            if not stat.S_ISREG(opened.st_mode):
                raise ValueError(f"required artifact is not a regular file: {relative_path}")
            if opened.st_size != expected_size:
                raise ValueError(f"required artifact size differs from run-result: {relative_path}")
            payload = stream.read(expected_size + 1)
            if len(payload) != expected_size or stream.read(1):
                raise ValueError(f"required artifact changed size while reading: {relative_path}")
            finished = os.fstat(stream.fileno())
            if (finished.st_size != expected_size or
                    (opened.st_dev, opened.st_ino, opened.st_mtime_ns) !=
                    (finished.st_dev, finished.st_ino, finished.st_mtime_ns)):
                raise ValueError(f"required artifact changed while reading: {relative_path}")
    except OSError as error:
        raise ValueError(f"cannot read contained required artifact {relative_path}") from error

    actual_sha256 = hashlib.sha256(payload).hexdigest()
    if actual_sha256 != expected_sha256:
        raise ValueError(f"required artifact SHA-256 differs from run-result: {relative_path}")
    return payload


def validate_de_pilot_receipts(request, result, pilot):
    """Bind an accepted process result to its model, build and requested case."""
    schema = "de100-pilot" if pilot == "de100" else "de-smoke"
    if (not isinstance(request, dict) or not isinstance(result, dict) or
            request.get("schema") != f"fullmag.{schema}.request.v1" or
            result.get("schema") != f"fullmag.{schema}.result.v1" or
            result.get("status") != "completed_unqualified" or
            type(result.get("return_code")) is not int or result["return_code"] != 0):
        raise ValueError("Expected a completed managed numerical DE pilot")
    if result.get("pilot") != pilot:
        raise ValueError("Run identity mismatch: pilot")
    # Older receipts did not expose these case fields. If present they must
    # agree with the result; missing fields never supply model identity.
    for key, expected in (("cases", [pilot]), ("operation", pilot + "-numerical-pilot")):
        if key in request and request[key] != expected:
            raise ValueError(f"Run identity mismatch: {key}")
    for key in ("model_sha256", "job", "source"):
        if not request.get(key) or request[key] != result.get(key):
            raise ValueError(f"Run identity mismatch: {key}")
    # A separately pinned model is optional on the legacy capsule-owned route,
    # but one-sided or changed provenance must not silently fall back to it.
    if "model_source" in request or "model_source" in result:
        identity = request.get("model_source")
        if not isinstance(identity, dict) or not identity or identity != result.get("model_source"):
            raise ValueError("Run identity mismatch: model_source")
