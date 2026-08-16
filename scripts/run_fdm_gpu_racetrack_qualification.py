#!/usr/bin/env python3
"""Run the frozen managed FDM/CUDA solved-current racetrack workload.

This launcher owns the expensive runtime step only.  It never invents gate
claims or a qualification manifest: the collector writes runtime evidence and
the separate assembler decides whether a complete manifest can be published.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from typing import Any, Mapping, Sequence


SCHEMA_VERSION = "fdm_gpu_solved_current_racetrack_workload_run.v1"
EXACT_AMPLITUDES = (-1.5e12, -1.0e12, -0.5e12, 0.5e12, 1.0e12, 1.5e12)
EXACT_AMPLITUDES_ENV = "-1.5e12,-1.0e12,-0.5e12,0.5e12,1.0e12,1.5e12"
EXACT_ENV = {
    "FULLMAG_RACETRACK_AMPLITUDES": EXACT_AMPLITUDES_ENV,
    "FULLMAG_RACETRACK_DRIVE_DURATION": "2.0e-9",
    "FULLMAG_RACETRACK_OUTPUT_PERIOD": "5.0e-12",
    "FULLMAG_RACETRACK_RELAX_MAX_STEPS": "50000",
    "FULLMAG_RACETRACK_RELAX_TOLT": "1.0e-6",
    "FULLMAG_FDM_EXECUTION": "gpu",
    "FULLMAG_FDM_PRECISION": "double",
    # The qualification workload uses the binary field store.  Keeping this
    # in the frozen environment makes the I/O policy part of the workload
    # identity instead of an implicit runner default.
    "FULLMAG_ARTIFACT_FIELD_STORAGE": "zarr",
}
GPU_LINE = re.compile(
    r"^(?P<uuid>[^,]+),\s*(?P<driver>[^,]+),\s*(?P<free>[0-9]+)\s*$"
)
CUDA_RELEASE = re.compile(r"release\s+([0-9]+(?:\.[0-9]+)+)", re.IGNORECASE)


class WorkloadError(RuntimeError):
    """The frozen workload cannot be run without changing its contract."""


def _canonical_json(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def _write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(_canonical_json(value))
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
    finally:
        if temporary.exists():
            temporary.unlink()


def build_workload_environment(
    base: Mapping[str, str] | None = None,
    *,
    build_root: Path | None = None,
) -> dict[str, str]:
    """Return an environment with every qualification control frozen.

    A conflicting inherited value is an error instead of being silently
    replaced.  This prevents a production run from looking complete while it
    actually used a shortened or asymmetric sweep.
    """

    environment = dict(base or os.environ)
    for key, expected in EXACT_ENV.items():
        inherited = environment.get(key)
        if inherited is not None and inherited != expected:
            raise WorkloadError(f"{key}_override_forbidden")
        environment[key] = expected
    if build_root is not None:
        native_fdm_root = build_root / "native" / "backends" / "fdm"
        if not native_fdm_root.is_dir():
            raise WorkloadError("native_fdm_library_dir_missing")
        existing_library_path = environment.get("LD_LIBRARY_PATH")
        environment["LD_LIBRARY_PATH"] = str(native_fdm_root) + (
            f":{existing_library_path}" if existing_library_path else ""
        )
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    return environment


def build_runtime_command(
    runtime_bin: Path,
    script: Path,
    output_root: Path,
    session_root: Path,
) -> list[str]:
    return [
        str(runtime_bin),
        "--headless",
        "--json",
        "--backend",
        "fdm",
        "--mode",
        "strict",
        "--precision",
        "double",
        "--output-dir",
        str(output_root),
        "--workspace-root",
        str(session_root),
        str(script),
    ]


def discover_session_root(history_root: Path) -> Path:
    candidates = [
        item
        for item in history_root.glob("session-*")
        if item.is_dir() and (item / "stages").is_dir()
    ]
    if not candidates:
        raise WorkloadError("session_root_missing")
    # Session IDs are monotonic millisecond timestamps in the runtime.  Using
    # the ID rather than filesystem mtimes keeps discovery deterministic on
    # CIFS/FUSE mounts whose directory mtimes may have coarse resolution.
    return max(candidates, key=lambda item: item.name)


def _run_capture(command: Sequence[str]) -> str:
    try:
        result = subprocess.run(
            list(command),
            check=True,
            text=True,
            capture_output=True,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        raise WorkloadError(f"runtime_identity_command_failed:{command[0]}") from error
    return result.stdout.strip()


def _cuda_runtime_version() -> str:
    for key in ("CUDA_RUNTIME_VERSION", "CUDA_VERSION"):
        value = os.environ.get(key)
        if value:
            return value
    try:
        output = _run_capture(("nvcc", "--version"))
    except WorkloadError:
        output = ""
    match = CUDA_RELEASE.search(output)
    if match is None:
        raise WorkloadError("cuda_runtime_version_missing")
    return match.group(1)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
    except OSError as error:
        raise WorkloadError(f"runtime_binary_unreadable:{path}") from error
    return digest.hexdigest()


def build_digest(runtime_bin: Path, build_root: Path | None) -> str:
    """Hash the executable and native FDM inputs used by the managed run."""

    entries: dict[str, str] = {"runtime-bin": sha256_file(runtime_bin)}
    if build_root is not None:
        native_root = build_root / "native" / "backends" / "fdm"
        if not native_root.is_dir():
            raise WorkloadError("native_fdm_build_root_missing")
        for path in sorted(
            path for path in native_root.rglob("*") if path.is_file() and not path.is_symlink()
        ):
            relative = path.relative_to(native_root).as_posix()
            entries[f"native/backends/fdm/{relative}"] = sha256_file(path)
    return hashlib.sha256(_canonical_json(entries)).hexdigest()


def capture_runtime_identity(
    runtime_bin: Path, build_root: Path | None = None
) -> dict[str, Any]:
    if os.environ.get("FULLMAG_MANAGED_CONTAINER") != "1":
        raise WorkloadError("managed_container_proof_missing")
    line = _run_capture(
        (
            "nvidia-smi",
            "--query-gpu=uuid,driver_version,memory.free",
            "--format=csv,noheader,nounits",
        )
    ).splitlines()
    if not line:
        raise WorkloadError("gpu_identity_missing")
    match = GPU_LINE.fullmatch(line[0].strip())
    if match is None:
        raise WorkloadError("gpu_identity_unparseable")
    return {
        "managed_container": True,
        "gpu_uuid": match.group("uuid").strip(),
        "cuda_driver": match.group("driver").strip(),
        "cuda_runtime": _cuda_runtime_version(),
        "build_digest": build_digest(runtime_bin, build_root),
        "free_memory_bytes": int(match.group("free")) * 1024 * 1024,
    }


def run_workload(
    *,
    runtime_bin: Path,
    script: Path,
    output_root: Path,
    session_history_root: Path,
    repo_root: Path,
    build_root: Path | None = None,
    runtime_identity_path: Path | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    output_root.mkdir(parents=True, exist_ok=True)
    session_history_root.mkdir(parents=True, exist_ok=True)
    command = build_runtime_command(runtime_bin, script, output_root, session_history_root)
    environment = build_workload_environment(build_root=build_root)
    if runtime_identity_path is None:
        runtime_identity = (
            None if dry_run else capture_runtime_identity(runtime_bin, build_root)
        )
    else:
        try:
            runtime_identity = json.loads(runtime_identity_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise WorkloadError("runtime_identity_input_invalid") from error
        if not isinstance(runtime_identity, dict):
            raise WorkloadError("runtime_identity_input_invalid")

    if runtime_identity is not None:
        _write_json(output_root / "runtime-identity.v1.json", runtime_identity)

    if dry_run:
        result = {
            "schema_version": SCHEMA_VERSION,
            "status": "dry_run",
            "command": command,
            "environment": {key: environment[key] for key in EXACT_ENV},
            "output_root": str(output_root),
            "session_history_root": str(session_history_root),
            "runtime_identity": runtime_identity,
        }
        _write_json(output_root / "workload-run.v1.json", result)
        return result

    run_log = output_root / "runtime.log"
    completed = subprocess.run(
        command,
        cwd=repo_root,
        env=environment,
        check=False,
        text=True,
        capture_output=True,
    )
    run_log.write_text(
        "=== stdout ===\n" + completed.stdout + "\n=== stderr ===\n" + completed.stderr,
        encoding="utf-8",
    )
    result: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "status": "completed" if completed.returncode == 0 else "failed",
        "returncode": completed.returncode,
        "command": command,
        "environment": {key: environment[key] for key in EXACT_ENV},
        "output_root": str(output_root),
        "session_history_root": str(session_history_root),
        "runtime_log": str(run_log),
        "runtime_identity": runtime_identity,
    }
    if completed.returncode != 0:
        _write_json(output_root / "workload-run.v1.json", result)
        return result

    try:
        session_root = discover_session_root(session_history_root)
    except WorkloadError as error:
        result["status"] = "blocked"
        result["reason_code"] = str(error)
        _write_json(output_root / "workload-run.v1.json", result)
        return result

    try:
        try:
            from scripts.collect_fdm_gpu_racetrack_evidence import collect_runtime_evidence
        except ModuleNotFoundError:
            from collect_fdm_gpu_racetrack_evidence import collect_runtime_evidence
        evidence = collect_runtime_evidence(
            session_root,
            output_root / "evidence",
            artifact_root=output_root,
        )
    except Exception as error:  # collector has its own fail-closed reason codes
        result["status"] = "blocked"
        result["reason_code"] = f"collector_failed:{error}"
        _write_json(output_root / "workload-run.v1.json", result)
        return result
    result["session_root"] = str(session_root)
    result["runtime_evidence"] = str(
        output_root / "evidence" / "fdm_gpu_solved_current_racetrack_runtime_evidence.v1.json"
    )
    result["status"] = "completed" if evidence.get("status") == "pass" else "blocked"
    result["reason_codes"] = evidence.get("reason_codes", [])
    _write_json(output_root / "workload-run.v1.json", result)
    return result


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-bin", type=Path, required=True)
    parser.add_argument(
        "--script",
        type=Path,
        default=Path("examples/fdm_gpu_solved_current_skyrmion_racetrack.py"),
    )
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--session-history-root", type=Path, required=True)
    parser.add_argument("--build-root", type=Path)
    parser.add_argument("--runtime-identity", type=Path)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    try:
        result = run_workload(
            runtime_bin=args.runtime_bin,
            script=args.script,
            output_root=args.output_root,
            session_history_root=args.session_history_root,
            repo_root=args.repo_root,
            build_root=args.build_root,
            runtime_identity_path=args.runtime_identity,
            dry_run=args.dry_run,
        )
    except WorkloadError as error:
        print(f"racetrack workload rejected: {error}")
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["status"] in {"completed", "dry_run"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
