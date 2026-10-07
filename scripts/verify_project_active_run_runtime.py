#!/usr/bin/env python3
"""Run a managed active-run WebSocket reconnect smoke on Windows.

The default route builds ``fullmag-api`` and ``fullmag`` from one captured
source identity. ``--frozen-native-build-id`` instead verifies and reuses an
existing native package and its frozen Python source binding without Cargo.
Both routes start an isolated FDM CPU relaxation, disconnect the realtime
transport while the solver is running, and verify the same session/run and
monotonic HTTP resource revisions after reconnect. This is runtime recovery
evidence, not physics or release qualification.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import time
import uuid

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import capture_source_snapshot_identity as source_identity  # noqa: E402
import fullmag_storage as storage  # noqa: E402
from verify_project_api_runtime import json_request, wait_for_health  # noqa: E402
from verify_session_persistence import toolchain_identity  # noqa: E402
from windows import build_snapshot, runtime_bundle  # noqa: E402
from windows.development_status import verified_build_identity  # noqa: E402


PROFILE = "windows-project-active-run-runtime"
NATIVE_PROFILE = "windows-native-fdm-cpu-dev"
RECEIPT_SCHEMA = "fullmag_project_active_run_runtime_v1"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
MAX_OBSERVER_SCRIPT_BYTES = 256 * 1024
PYTHON_BINDING_PROBE = r"""
import importlib.machinery
import importlib.metadata
import json
import platform
import sys
import sysconfig
import fullmag

print(json.dumps({
    "executable": str(__import__("pathlib").Path(sys.executable).resolve()),
    "implementation": sys.implementation.name,
    "version": [sys.version_info.major, sys.version_info.minor],
    "cache_tag": sys.implementation.cache_tag,
    "soabi": sysconfig.get_config_var("SOABI"),
    "ext_suffix": sysconfig.get_config_var("EXT_SUFFIX"),
    "extension_suffixes": importlib.machinery.EXTENSION_SUFFIXES,
    "platform": sysconfig.get_platform(),
    "machine": platform.machine(),
    "fullmag_file": str(__import__("pathlib").Path(fullmag.__file__).resolve()),
    "fullmag_version": importlib.metadata.version("fullmag"),
}, sort_keys=True))
"""


class ActiveRunRuntimeError(RuntimeError):
    """A managed active-run preflight, process, or contract failure."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, indent=2, ensure_ascii=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def contained_paths(layout: dict[str, object], run_id: str) -> dict[str, Path]:
    build_storage = Path(str(layout["build_storage_root"]))
    build_root = Path(str(layout["build_root"]))
    temp_root = Path(str(layout["temp_root"]))
    cache_root = Path(str(layout["cache_root"]))
    run_root = storage.validate_path(
        build_root / PROFILE / run_id, build_storage, "active-run runtime root"
    )
    return {
        "run_root": run_root,
        "temp_root": storage.validate_path(temp_root / PROFILE / run_id, build_storage, "active-run temp root"),
        "state_root": storage.validate_path(run_root / "state", build_storage, "active-run state root"),
        "target_dir": storage.validate_path(run_root / "cargo-target", build_storage, "active-run target"),
        # Share the already managed, validated Cargo/Rustup caches with the
        # existing project API routes. A fresh per-smoke cache cannot resolve
        # the offline workspace index and would make the receipt depend on
        # an accidental network fetch.
        "cargo_home": storage.validate_path(cache_root / "cargo", cache_root, "active-run Cargo home"),
        "rustup_home": storage.validate_path(cache_root / "rustup", cache_root, "active-run Rustup home"),
        "receipt": storage.validate_path(run_root / "receipt.json", build_storage, "active-run receipt"),
        "cargo_log": storage.validate_path(run_root / "cargo.log", build_storage, "active-run Cargo log"),
        "api_log": storage.validate_path(run_root / "api.log", build_storage, "active-run API log"),
        "cli_log": storage.validate_path(run_root / "cli.log", build_storage, "active-run CLI log"),
        "probe_log": storage.validate_path(run_root / "active-run-ws.log", build_storage, "active-run probe log"),
        "fixture": storage.validate_path(run_root / "active-run.py", build_storage, "active-run fixture"),
        "source_snapshot": storage.validate_path(run_root / "source-snapshot.v2.json", build_storage, "active-run source snapshot"),
        "source_snapshot_after": storage.validate_path(run_root / "source-snapshot-after.v2.json", build_storage, "active-run post-run source snapshot"),
    }


def child_environment(
    layout: dict[str, object],
    paths: dict[str, Path],
    tools: dict[str, Path] | None,
    identity: dict[str, object],
    repo_root: Path,
    *,
    python_executable: Path | None = None,
    python_source_path: Path | None = None,
) -> dict[str, str]:
    env = {str(key): str(value) for key, value in os.environ.items()}
    env.update({str(key): str(value) for key, value in layout["env"].items()})
    env.update(
        {
            "FULLMAG_STORAGE_PROFILE": PROFILE,
            "TMPDIR": str(paths["temp_root"]),
            "TEMP": str(paths["temp_root"]),
            "TMP": str(paths["temp_root"]),
            "FULLMAG_SOURCE_GIT_COMMIT": str(identity["head_commit_full"]),
            "FULLMAG_SOURCE_WORKTREE_STATE": "dirty" if identity["source_snapshot_dirty"] else "clean",
            "FULLMAG_SOURCE_SNAPSHOT_SHA256": str(identity["source_snapshot_sha256"]),
            "FULLMAG_PYTHON": str(python_executable or sys.executable),
            "PYTHONPATH": str(python_source_path or (repo_root / "packages" / "fullmag-py" / "src")),
            "PYTHONNOUSERSITE": "1",
        }
    )
    if tools is not None:
        env.update(
            {
                "CARGO_TARGET_DIR": str(paths["target_dir"]),
                "FULLMAG_CARGO_TARGET_DIR": str(paths["target_dir"]),
                "FULLMAG_CARGO_TARGET_ROOT": str(paths["target_dir"]),
                "CARGO_HOME": str(paths["cargo_home"]),
                "RUSTUP_HOME": str(paths["rustup_home"]),
                "RUSTC": str(tools["rustc"]),
                "CARGO_BUILD_JOBS": "1",
            }
        )
        bins = [str(Path(tools["cargo"]).parent), str(Path(tools["rustc"]).parent)]
        old_path = env.get("PATH", "")
        env["PATH"] = os.pathsep.join(bins + ([old_path] if old_path else []))
        env.pop("RUSTUP_TOOLCHAIN", None)
    else:
        for key in (
            "CARGO_TARGET_DIR", "FULLMAG_CARGO_TARGET_DIR", "FULLMAG_CARGO_TARGET_ROOT",
            "CARGO_HOME", "RUSTUP_HOME", "RUSTC", "CARGO_BUILD_JOBS", "RUSTUP_TOOLCHAIN",
        ):
            env.pop(key, None)
        env.pop("PYTHONHOME", None)
        env["PYTHONDONTWRITEBYTECODE"] = "1"
    return env


def verify_frozen_native_package(repo_root: Path, build_id: str) -> dict[str, object]:
    """Verify a pre-existing native package and its frozen Python source binding without writing."""
    if not isinstance(build_id, str) or SHA256_RE.fullmatch(build_id) is None:
        raise ActiveRunRuntimeError("Frozen native build ID must be a lowercase SHA-256")
    native = storage.resolve_layout(repo_root, NATIVE_PROFILE)
    build_root = Path(str(native["build_root"]))
    runtime_root = Path(str(native["runtime_root"]))
    storage_root = Path(str(native["storage_root"]))
    manifest_path = storage.validate_path(
        build_root / "windows-runtime" / "build-manifest.json",
        storage_root,
        "frozen native build manifest",
    )
    runtime_bundle._require_regular_file(manifest_path, "frozen native build manifest", nonempty=True)
    manifest, raw_manifest = runtime_bundle._read_json(manifest_path, "frozen native build manifest")
    actual_build_id = runtime_bundle._sha256_bytes(raw_manifest)
    if actual_build_id != build_id:
        raise ActiveRunRuntimeError("Frozen native build ID does not match the canonical build manifest")
    try:
        verified = verified_build_identity(
            build_root,
            runtime_root,
            manifest_path,
            expected_source_sha256=None,
            expected_manifest_sha256=build_id,
        )
    except Exception as error:
        raise ActiveRunRuntimeError("Frozen native build manifest or binaries failed verification") from error
    if verified["ready_build_id"] != build_id:
        raise ActiveRunRuntimeError("Verified native build identity differs from the requested build ID")

    snapshot_record = manifest.get("build_source_snapshot")
    if not isinstance(snapshot_record, dict):
        raise ActiveRunRuntimeError("Frozen native package has no verified source snapshot")
    try:
        snapshot_record_path = snapshot_record.get("record_path")
        if not isinstance(snapshot_record_path, str) or not snapshot_record_path:
            raise ActiveRunRuntimeError("Frozen native source binding has no snapshot record path")
        snapshot = build_snapshot.verify_snapshot(
            snapshot_record_path, build_root, force_verify=True
        )
    except Exception as error:
        detail = f"{type(error).__name__}: {error}"[:240]
        raise ActiveRunRuntimeError(
            f"Frozen native source snapshot failed verification ({detail})"
        ) from error
    snapshot_identity = snapshot.get("source_identity") if isinstance(snapshot, dict) else None
    if not isinstance(snapshot, dict) or not isinstance(snapshot_identity, dict):
        raise ActiveRunRuntimeError("Verified frozen source snapshot has no source identity")
    if (
        snapshot.get("inventory_sha256") != snapshot_record.get("inventory_sha256")
        or snapshot.get("source_root") != snapshot_record.get("source_root")
        or snapshot.get("origin_worktree_id") != manifest.get("workspace_namespace")
        or snapshot.get("backend_source_sha256") != manifest.get("backend_source_sha256")
        or snapshot.get("dependency_source_sha256") != manifest.get("dependency_source_sha256")
        or snapshot_identity.get("head_commit_full") != manifest.get("git_commit")
        or snapshot_identity.get("source_snapshot_sha256") != manifest.get("source_snapshot_sha256")
    ):
        raise ActiveRunRuntimeError("Verified frozen source snapshot differs from its compact native manifest binding")
    source_root = storage.validate_path(
        Path(snapshot["source_root"]), build_root, "frozen native source root"
    )
    frozen_python_source = storage.validate_path(
        source_root / "packages" / "fullmag-py" / "src",
        source_root,
        "frozen Fullmag Python source",
    )
    runtime_bundle._require_directory(frozen_python_source, "frozen Fullmag Python source")
    module_init = frozen_python_source / "fullmag" / "__init__.py"
    runtime_bundle._require_regular_file(module_init, "frozen Fullmag Python package", nonempty=True)

    source_identity = snapshot.get("source_identity")
    if not isinstance(source_identity, dict):
        raise ActiveRunRuntimeError("Frozen native source snapshot has no source identity")
    source_snapshot_sha256 = manifest.get("source_snapshot_sha256")
    backend_source_sha256 = manifest.get("backend_source_sha256")
    git_commit = manifest.get("git_commit")
    worktree_state = manifest.get("worktree_state")
    if (
        source_snapshot_sha256 != source_identity.get("source_snapshot_sha256")
        or git_commit != source_identity.get("head_commit_full")
        or worktree_state != ("dirty" if source_identity.get("source_snapshot_dirty") else "clean")
        or backend_source_sha256 != verified["ready_source_sha256"]
    ):
        raise ActiveRunRuntimeError("Frozen native source identity disagrees with its verified manifest")

    target_triple = manifest.get("target_triple")
    expected_abi = {
        "x86_64-pc-windows-msvc": ("cp312-win_amd64", "win-amd64", "AMD64"),
        "aarch64-pc-windows-msvc": ("cp312-win_arm64", "win-arm64", "ARM64"),
    }.get(target_triple)
    if expected_abi is None:
        raise ActiveRunRuntimeError("Frozen native target has no supported Windows Python ABI binding")
    python_executable = storage.validate_path(
        build_root / "python" / "fullmag" / "Scripts" / "python.exe",
        build_root,
        "frozen native Python interpreter",
    )
    runtime_bundle._require_regular_file(python_executable, "frozen native Python interpreter", nonempty=True)
    python_sha256 = runtime_bundle._sha256_file(python_executable)
    expected_version = manifest.get("installed_python_version")
    python_sync_required = manifest.get("python_sync_required")
    build_version = manifest.get("build_version")
    package_version = build_version.get("pep440_version") if isinstance(build_version, dict) else None
    if type(python_sync_required) is not bool or not isinstance(package_version, str) or not package_version:
        raise ActiveRunRuntimeError("Frozen native manifest has incomplete Python version provenance")
    if not isinstance(expected_version, str) or not expected_version:
        raise ActiveRunRuntimeError("Frozen native manifest has no installed Fullmag Python package version")
    return {
        "native_layout": native,
        "build_root": build_root,
        "runtime_root": runtime_root,
        "manifest_path": manifest_path,
        "manifest": manifest,
        "manifest_sha256": actual_build_id,
        "source_root": source_root,
        "source_identity": source_identity,
        "frozen_python_source": frozen_python_source,
        "python_executable": python_executable,
        "python_sha256": python_sha256,
        "python_binding": None,
        "expected_python_abi": expected_abi,
        "expected_python_version": expected_version,
        "build_python_package_version": package_version,
        "python_sync_required": python_sync_required,
        "python_process": None,
        "historical_python_hash_binding": "unavailable: build manifest does not record Python executable SHA-256; measured hash is runtime evidence only",
    }


def measure_frozen_python_binding(
    package: dict[str, object], receipt: dict[str, object]
) -> dict[str, object]:
    """Import the frozen DSL with the managed interpreter and preserve its process evidence."""
    python_executable = package["python_executable"]
    frozen_python_source = package["frozen_python_source"]
    source_root = package["source_root"]
    probe_env = {str(key): str(value) for key, value in os.environ.items()}
    probe_env.update(
        PYTHONPATH=str(frozen_python_source),
        PYTHONNOUSERSITE="1",
        PYTHONDONTWRITEBYTECODE="1",
    )
    for key in ("PYTHONHOME", "PYTHONUSERBASE", "PYTHONSTARTUP", "PYTHONEXECUTABLE", "FULLMAG_PYTHON"):
        probe_env.pop(key, None)
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
    try:
        process = subprocess.Popen(
            [str(python_executable), "-c", PYTHON_BINDING_PROBE],
            cwd=source_root,
            env=probe_env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            creationflags=creationflags,
        )
    except OSError as error:
        raise ActiveRunRuntimeError("Frozen native Python binding probe could not start") from error

    def preserve_process_evidence(exit_code: int | None, *, output_drained: bool) -> dict[str, object]:
        evidence = process_evidence("frozen-python-binding-probe", process, exit_code)
        evidence["output_drained"] = output_drained
        package["python_process"] = evidence
        record_process_evidence(receipt, "frozen-python-binding-probe", process, exit_code)
        records = receipt.get("processes")
        if isinstance(records, list):
            for item in records:
                if isinstance(item, dict) and item.get("pid") == process.pid:
                    item["output_drained"] = output_drained
        python_receipt = receipt.get("frozen_python_binding")
        if isinstance(python_receipt, dict):
            python_receipt["binding_probe_process"] = evidence
        return evidence

    def stop_and_record_probe() -> dict[str, object]:
        exit_code: int | None
        try:
            exit_code = terminate(process)
        except BaseException:
            try:
                if process.poll() is None:
                    process.kill()
            except BaseException:
                pass
            try:
                process.wait(timeout=5)
            except BaseException:
                pass
            exit_code = process.returncode
        output_drained = False
        try:
            process.communicate(timeout=5)
            output_drained = True
        except BaseException:
            try:
                if process.poll() is None:
                    process.kill()
            except BaseException:
                pass
            try:
                process.wait(timeout=5)
            except BaseException:
                pass
            try:
                process.communicate(timeout=5)
                output_drained = True
            except BaseException:
                pass
            if exit_code is None:
                exit_code = process.returncode
        return preserve_process_evidence(exit_code, output_drained=output_drained)

    try:
        stdout, stderr = process.communicate(timeout=20)
    except subprocess.TimeoutExpired as error:
        evidence = stop_and_record_probe()
        if evidence["exit_code"] is None or evidence["waited"] is not True or evidence["output_drained"] is not True:
            raise ActiveRunRuntimeError(
                f"Frozen Python binding probe cleanup is unconfirmed for PID {process.pid}"
            ) from error
        raise ActiveRunRuntimeError(
            f"Frozen Python binding probe timed out; PID {process.pid} exited {evidence['exit_code']}"
        ) from error
    except BaseException:
        stop_and_record_probe()
        raise

    evidence = preserve_process_evidence(process.returncode, output_drained=True)
    python_receipt = receipt.get("frozen_python_binding")
    if isinstance(python_receipt, dict):
        python_receipt["binding_probe_process"] = evidence
    if process.returncode != 0 or evidence["waited"] is not True:
        raise ActiveRunRuntimeError("Frozen native Python binding probe failed")
    if len(stdout.encode("utf-8")) > 16 * 1024 or len(stderr.encode("utf-8")) > 16 * 1024:
        raise ActiveRunRuntimeError("Frozen native Python binding probe exceeded its output limit")
    try:
        binding = json.loads(stdout)
    except json.JSONDecodeError as error:
        raise ActiveRunRuntimeError("Frozen native Python binding probe returned invalid JSON") from error
    if not isinstance(binding, dict) or set(binding) != {
        "executable", "implementation", "version", "cache_tag", "soabi", "ext_suffix",
        "extension_suffixes", "platform", "machine", "fullmag_file", "fullmag_version",
    }:
        raise ActiveRunRuntimeError("Frozen native Python binding probe returned an unexpected shape")
    package["python_binding"] = binding
    if isinstance(python_receipt, dict):
        python_receipt["binding_probe"] = binding
    expected_executable = os.path.normcase(os.path.abspath(python_executable))
    actual_executable = (
        os.path.normcase(os.path.abspath(binding["executable"]))
        if isinstance(binding["executable"], str)
        else ""
    )
    package_root = (frozen_python_source / "fullmag").resolve()
    module_within_frozen_source = False
    try:
        Path(str(binding["fullmag_file"])).relative_to(package_root)
        module_within_frozen_source = True
    except (TypeError, ValueError):
        pass
    expected_abi = package["expected_python_abi"]
    mismatch_fields = []
    if actual_executable != expected_executable:
        mismatch_fields.append("executable")
    if binding["implementation"] != "cpython":
        mismatch_fields.append("implementation")
    if binding["version"] != [3, 12]:
        mismatch_fields.append("version")
    if binding["cache_tag"] != "cpython-312":
        mismatch_fields.append("cache_tag")
    expected_extension_suffix = f".{expected_abi[0]}.pyd"
    if binding["soabi"] is not None and binding["soabi"] != expected_abi[0]:
        mismatch_fields.append("soabi")
    if binding["ext_suffix"] != expected_extension_suffix:
        mismatch_fields.append("ext_suffix")
    suffixes = binding["extension_suffixes"]
    if (not isinstance(suffixes, list) or any(not isinstance(suffix, str) for suffix in suffixes)
            or expected_extension_suffix not in suffixes):
        mismatch_fields.append("extension_suffixes")
    if binding["platform"] != expected_abi[1]:
        mismatch_fields.append("platform")
    if binding["machine"] != expected_abi[2]:
        mismatch_fields.append("machine")
    if not module_within_frozen_source:
        mismatch_fields.append("fullmag_file")
    if binding["fullmag_version"] != package["expected_python_version"]:
        mismatch_fields.append("fullmag_version")
    if (
        not package["python_sync_required"]
        and package["expected_python_version"] != package["build_python_package_version"]
    ):
        mismatch_fields.append("build_python_package_version")
    if mismatch_fields:
        if isinstance(python_receipt, dict):
            python_receipt["binding_mismatch_fields"] = mismatch_fields
        raise ActiveRunRuntimeError(
            "Frozen native Python binding mismatch: " + ", ".join(mismatch_fields)
        )
    if runtime_bundle._sha256_file(python_executable) != package["python_sha256"]:
        raise ActiveRunRuntimeError("Frozen native Python interpreter changed during its binding probe")
    if isinstance(python_receipt, dict):
        python_receipt["binding_mismatch_fields"] = []
    return binding


def seal_frozen_native_package(package: dict[str, object]) -> dict[str, object]:
    """Copy verified package executables to an immutable runtime bundle before launch."""
    try:
        with storage.build_lock(package["native_layout"]):
            if runtime_bundle._sha256_file(package["manifest_path"]) != package["manifest_sha256"]:
                raise ActiveRunRuntimeError("Pinned native build manifest changed before package sealing")
            verified_build_identity(
                package["build_root"],
                package["runtime_root"],
                package["manifest_path"],
                expected_source_sha256=None,
                expected_manifest_sha256=package["manifest_sha256"],
            )
            bundle = runtime_bundle.create_bundle(
                package["build_root"],
                package["runtime_root"],
                package["manifest_path"],
                "dev",
            )
        bundle_root = Path(str(bundle["bundle_root"]))
        manifest, hashes = runtime_bundle.validate_bundle(bundle_root, package["runtime_root"], "dev")
    except Exception as error:
        raise ActiveRunRuntimeError("Could not seal the verified native package for the active-run fixture") from error
    source = manifest.get("source")
    if (
        manifest.get("qualification") != "not_assessed"
        or not isinstance(source, dict)
        or source.get("manifest_sha256") != package["manifest_sha256"]
        or source.get("backend_source_sha256") != package["manifest"].get("backend_source_sha256")
        or source.get("source_snapshot_sha256") != package["manifest"].get("source_snapshot_sha256")
    ):
        raise ActiveRunRuntimeError("Sealed runtime bundle does not match the pinned native build")
    binary_root = bundle_root / "bin"
    api_binary = runtime_bundle._require_regular_file(
        binary_root / "fullmag-api.exe", "frozen API executable", nonempty=True
    )
    cli_binary = runtime_bundle._require_regular_file(
        binary_root / "fullmag.exe", "frozen CLI executable", nonempty=True
    )
    return {
        "bundle_root": bundle_root,
        "bundle_manifest": bundle_root / "manifest.json",
        "bundle_manifest_sha256": runtime_bundle._sha256_file(bundle_root / "manifest.json"),
        "api_binary": binary_root / "fullmag-api.exe",
        "api_binary_sha256": hashes["bin/fullmag-api.exe"],
        "cli_binary": binary_root / "fullmag.exe",
        "cli_binary_sha256": hashes["bin/fullmag.exe"],
        "bundle_id": manifest.get("bundle_id"),
        "qualification": manifest.get("qualification"),
        "api_size_bytes": api_binary.st_size,
        "cli_size_bytes": cli_binary.st_size,
    }


def write_fixture(path: Path) -> None:
    path.write_text(
        """import fullmag as fm

study = fm.study("managed_active_run_reconnect")
study.engine("fdm")
study.device("cpu", precision="double")
study.universe(mode="manual", size=(80e-9, 160e-9, 10e-9), center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
study.cell(5e-9, 5e-9, 5e-9)
film = study.geometry(fm.Box(size=(40e-9, 120e-9, 10e-9), name="managed_smoke_box"), name="managed_smoke_box")
film.Ms = 752000.0
film.Aex = 1.55e-11
film.alpha = 0.1
film.m = fm.texture.uniform(0.0, 1.0, 0.0)
study.demag()
study.b_ext(0.0, 0.0, 1e-3)
study.solver(fix_dt=1e-13, g=2.115)
study.stages.add_relax(algorithm="llg_overdamped", dt=1e-13, tolA=1e-4, max_steps=100000).tableautosave(every_steps=50, quantities=["step", "t", "dt", "mx", "my", "mz", "E_total"])
""",
        encoding="utf-8",
        newline="\n",
    )


def snapshot_active_run_observer(destination: Path) -> dict[str, str]:
    """Seal the standalone observer used by a frozen-package run."""
    source = SCRIPT_DIR / "probe_active_run_ws.mjs"
    try:
        source_info = runtime_bundle._require_regular_file(
            source, "active-run observer source", nonempty=True
        )
        if source_info.st_size > MAX_OBSERVER_SCRIPT_BYTES:
            raise ActiveRunRuntimeError("Active-run observer source exceeds its size limit")
        source_hash_before = runtime_bundle._sha256_file(source)
        source_bytes = source.read_bytes()
        source_hash = hashlib.sha256(source_bytes).hexdigest()
        source_hash_after = runtime_bundle._sha256_file(source)
    except Exception as error:
        raise ActiveRunRuntimeError("Could not verify the active-run observer source") from error
    if (len(source_bytes) > MAX_OBSERVER_SCRIPT_BYTES
            or source_hash_before != source_hash
            or source_hash_after != source_hash):
        raise ActiveRunRuntimeError("Active-run observer source changed while being snapshotted")
    if os.path.lexists(destination):
        raise ActiveRunRuntimeError("Refusing to replace an existing active-run observer snapshot")
    try:
        with destination.open("xb") as stream:
            stream.write(source_bytes)
            stream.flush()
            os.fsync(stream.fileno())
        runtime_bundle._require_regular_file(
            destination, "active-run observer snapshot", nonempty=True
        )
        executed_hash = runtime_bundle._sha256_file(destination)
    except Exception as error:
        raise ActiveRunRuntimeError("Could not seal the active-run observer snapshot") from error
    if executed_hash != source_hash:
        raise ActiveRunRuntimeError("Active-run observer snapshot differs from the captured source")
    return {
        "source_path": str(source),
        "executed_snapshot_path": str(destination),
        "sha256": executed_hash,
    }


def verify_observer_snapshot(binding: dict[str, str]) -> None:
    snapshot = Path(binding["executed_snapshot_path"])
    runtime_bundle._require_regular_file(
        snapshot, "active-run observer snapshot", nonempty=True
    )
    if runtime_bundle._sha256_file(snapshot) != binding["sha256"]:
        raise ActiveRunRuntimeError("Active-run observer snapshot changed during execution")


def terminate(process: subprocess.Popen[bytes] | None) -> int | None:
    if process is None:
        return None
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                return None
    return process.returncode


def process_evidence(name: str, process: subprocess.Popen[bytes], exit_code: int | None) -> dict[str, object]:
    return {
        "name": name,
        "pid": process.pid,
        "waited": process.poll() is not None,
        "exit_code": exit_code if type(exit_code) is int else process.returncode,
    }


def record_process_evidence(
    receipt: dict[str, object], name: str, process: subprocess.Popen[bytes], exit_code: int | None
) -> None:
    records = receipt.setdefault("processes", [])
    evidence = process_evidence(name, process, exit_code)
    for index, existing in enumerate(records):
        if isinstance(existing, dict) and existing.get("pid") == process.pid:
            records[index] = evidence
            return
    records.append(evidence)


def run(repo_root: Path, *, frozen_native_build_id: str | None = None) -> tuple[int, dict[str, object]]:
    if os.name != "nt":
        raise ActiveRunRuntimeError("managed active-run route is supported only on Windows")
    # Verify the pin and its source/Python binding before storage writes or API/CLI launch.
    frozen_package = (
        verify_frozen_native_package(repo_root, frozen_native_build_id)
        if frozen_native_build_id is not None
        else None
    )
    layout = storage.resolve_layout(repo_root, PROFILE)
    storage.initialize(layout)
    with storage.build_lock(layout):
        run_id = uuid.uuid4().hex
        paths = contained_paths(layout, run_id)
        if frozen_package is not None:
            paths["probe_snapshot"] = storage.validate_path(
                Path(paths["run_root"]) / "active-run-ws-probe.mjs",
                Path(str(layout["build_storage_root"])),
                "active-run observer snapshot",
            )
        directory_keys = ["run_root", "temp_root", "state_root"]
        if frozen_package is None:
            directory_keys.extend(("target_dir", "cargo_home", "rustup_home"))
        for key in directory_keys:
            paths[key].mkdir(parents=True, exist_ok=True)
        receipt: dict[str, object] = {
            "schema": RECEIPT_SCHEMA,
            "route": "project-active-run-runtime",
            "profile": PROFILE,
            "run_id": run_id,
            "worktree_id": layout["worktree_id"],
            "repo_root": str(repo_root),
            "started_at": utc_now(),
            "state": "preflight",
            "paths": {key: str(value) for key, value in paths.items()},
            "build_command": [] if frozen_package is not None else ["cargo", "build", "--locked", "--offline", "-p", "fullmag-api", "-p", "fullmag-cli"],
            "build_skipped": frozen_package is not None,
            "runtime_scope": [
                "FDM CPU flat_relax active run",
                "fullmag.live.v1 hello → client-controlled disconnect → after_seq reconnect",
                "HTTP run/stages/solver/commands continuity",
            ],
            "runtime_mutations": ["isolated scratch active run only"],
        }
        api_process: subprocess.Popen[bytes] | None = None
        cli_process: subprocess.Popen[bytes] | None = None
        api_log_handle = None
        cli_log_handle = None
        sealed_package: dict[str, object] | None = None
        return_code = 2
        try:
            current_checkout_identity = source_identity.capture(repo_root, ignore_non_runtime_dirty=True)
            write_atomic_json(paths["source_snapshot"], current_checkout_identity)
            receipt["current_checkout_identity_before"] = current_checkout_identity
            if frozen_package is not None:
                package_manifest = frozen_package["manifest"]
                identity = {
                    "head_commit_full": package_manifest["git_commit"],
                    "source_snapshot_dirty": package_manifest["worktree_state"] == "dirty",
                    "source_snapshot_sha256": package_manifest["source_snapshot_sha256"],
                }
                receipt["source_identity"] = frozen_package["source_identity"]
                receipt["source_binding"] = "verified_frozen_native_package"
                receipt["frozen_native_build_id"] = frozen_package["manifest_sha256"]
                receipt["frozen_native_manifest"] = str(frozen_package["manifest_path"])
                receipt["frozen_native_source_root"] = str(frozen_package["source_root"])
                receipt["frozen_native_source_identity"] = frozen_package["source_identity"]
                receipt["frozen_python_binding"] = {
                    "interpreter": str(frozen_package["python_executable"]),
                    "interpreter_sha256_before": frozen_package["python_sha256"],
                    "expected_abi": frozen_package["expected_python_abi"],
                    "expected_package_version": frozen_package["expected_python_version"],
                    "build_python_package_version": frozen_package["build_python_package_version"],
                    "python_sync_required": frozen_package["python_sync_required"],
                    "historical_python_hash_binding": frozen_package["historical_python_hash_binding"],
                }
                receipt["processes"] = []
                env = child_environment(
                    layout,
                    paths,
                    None,
                    identity,
                    repo_root,
                    python_executable=frozen_package["python_executable"],
                    python_source_path=frozen_package["frozen_python_source"],
                )
            else:
                identity = current_checkout_identity
                receipt["source_identity"] = identity
                toolchain, tools = toolchain_identity()
                receipt["toolchain"] = toolchain
                env = child_environment(layout, paths, tools, identity, repo_root)
            if frozen_package is not None:
                measure_frozen_python_binding(frozen_package, receipt)
                write_atomic_json(paths["receipt"], receipt)
            api_port = free_port()
            env["FULLMAG_API_PORT"] = str(api_port)
            env["FULLMAG_STATE_ROOT"] = str(paths["state_root"] / "api")
            receipt["api_port"] = api_port
            paths["fixture"].parent.mkdir(parents=True, exist_ok=True)
            write_fixture(paths["fixture"])
            observer_binding = None
            if frozen_package is not None:
                observer_binding = snapshot_active_run_observer(paths["probe_snapshot"])
                receipt["observer_script_binding"] = observer_binding
                write_atomic_json(paths["receipt"], receipt)
            if frozen_package is None:
                with paths["cargo_log"].open("w", encoding="utf-8", newline="\n") as cargo_log:
                    receipt["state"] = "building"
                    write_atomic_json(paths["receipt"], receipt)
                    build = subprocess.run(
                        [str(tools["cargo"]), "build", "--locked", "--offline", "-p", "fullmag-api", "-p", "fullmag-cli"],
                        cwd=repo_root, env=env, stdout=cargo_log, stderr=subprocess.STDOUT, text=True, check=False,
                    )
                receipt["build_exit_code"] = build.returncode
                if build.returncode != 0:
                    raise ActiveRunRuntimeError(f"fullmag API/CLI build failed with code {build.returncode}")
                api_name = "fullmag-api.exe" if os.name == "nt" else "fullmag-api"
                cli_name = "fullmag.exe" if os.name == "nt" else "fullmag"
                api_binary = paths["target_dir"] / "debug" / api_name
                cli_binary = paths["target_dir"] / "debug" / cli_name
                for label, binary in (("API", api_binary), ("CLI", cli_binary)):
                    if not binary.is_file() or binary.stat().st_size == 0:
                        raise ActiveRunRuntimeError(f"fullmag {label} binary is missing or empty: {binary}")
                receipt["binaries"] = {
                    "api": {"path": str(api_binary), "sha256": hashlib.sha256(api_binary.read_bytes()).hexdigest()},
                    "cli": {"path": str(cli_binary), "sha256": hashlib.sha256(cli_binary.read_bytes()).hexdigest()},
                }
            else:
                receipt["state"] = "sealing_frozen_package"
                write_atomic_json(paths["receipt"], receipt)
                sealed_package = seal_frozen_native_package(frozen_package)
                api_binary = sealed_package["api_binary"]
                cli_binary = sealed_package["cli_binary"]
                receipt["frozen_runtime_bundle"] = {
                    key: str(value) if isinstance(value, Path) else value
                    for key, value in sealed_package.items()
                }
                receipt["binaries"] = {
                    "api": {"path": str(api_binary), "sha256": sealed_package["api_binary_sha256"]},
                    "cli": {"path": str(cli_binary), "sha256": sealed_package["cli_binary_sha256"]},
                }
            paths["api_log"].parent.mkdir(parents=True, exist_ok=True)
            api_log_handle = paths["api_log"].open("w", encoding="utf-8", newline="\n")
            api_process = subprocess.Popen([str(api_binary)], cwd=repo_root, env=env, stdout=api_log_handle, stderr=subprocess.STDOUT)
            base_url = f"http://127.0.0.1:{api_port}"
            health = wait_for_health(base_url, api_process)
            _, openapi = json_request(f"{base_url}/v2/platform/openapi.json")
            remote_identity = openapi.get("x-fullmag-build-identity") if isinstance(openapi, dict) else None
            expected_identity = {
                "git_commit": identity["head_commit_full"],
                "source_snapshot_sha256": identity["source_snapshot_sha256"],
                "worktree_state": "dirty" if identity["source_snapshot_dirty"] else "clean",
            }
            if not isinstance(remote_identity, dict) or any(remote_identity.get(key) != value for key, value in expected_identity.items()):
                raise ActiveRunRuntimeError(f"API build identity mismatch: {remote_identity!r} != {expected_identity!r}")
            cli_env = dict(env)
            cli_env["FULLMAG_STATE_ROOT"] = str(paths["state_root"] / "cli")
            cli_env["FULLMAG_SKIP_CONTROL_ROOM"] = "1"
            cli_env["FULLMAG_FDM_EXECUTION"] = "cpu"
            cli_env.pop("FULLMAG_ATTACHED_SESSION_ID", None)
            cli_log_handle = paths["cli_log"].open("w", encoding="utf-8", newline="\n")
            cli_process = subprocess.Popen(
                [str(cli_binary), "-i", str(paths["fixture"]), "--backend", "fdm"],
                cwd=repo_root, env=cli_env, stdout=cli_log_handle, stderr=subprocess.STDOUT,
            )
            deadline = time.monotonic() + 60
            latest: object = None
            while time.monotonic() < deadline:
                if cli_process.poll() is not None:
                    raise ActiveRunRuntimeError(f"fullmag CLI exited before active run with code {cli_process.returncode}")
                try:
                    _, latest = json_request(f"{base_url}/v2/sessions/current/status", timeout=2.0)
                    if isinstance(latest, dict) and latest.get("run", {}).get("run_id") and latest.get("run", {}).get("solver_steps", 0) >= 1 and latest.get("solver", {}).get("state") in {"materializing_script", "preparing", "running", "paused"}:
                        break
                except Exception:
                    pass
                time.sleep(0.25)
            else:
                raise ActiveRunRuntimeError(f"active run did not become observable: {latest!r}")
            node = shutil.which("node", path=cli_env.get("PATH"))
            if not node:
                raise ActiveRunRuntimeError("node is required for the active-run websocket probe")
            probe = (
                Path(observer_binding["executed_snapshot_path"])
                if observer_binding is not None
                else SCRIPT_DIR / "probe_active_run_ws.mjs"
            )
            if observer_binding is not None:
                verify_observer_snapshot(observer_binding)
            probe_result = subprocess.run([node, str(probe), base_url], cwd=repo_root, env=cli_env, capture_output=True, text=True, timeout=90, check=False)
            if observer_binding is not None:
                verify_observer_snapshot(observer_binding)
            paths["probe_log"].write_text(f"$ {node} {probe} {base_url}\nexit_code={probe_result.returncode}\nstdout:\n{probe_result.stdout}\nstderr:\n{probe_result.stderr}\n", encoding="utf-8", newline="\n")
            if probe_result.returncode != 0:
                raise ActiveRunRuntimeError(f"active-run websocket probe failed: {probe_result.stderr.strip()[-700:]}")
            try:
                probe_payload = json.loads(probe_result.stdout)
            except json.JSONDecodeError as error:
                raise ActiveRunRuntimeError("active-run probe did not emit JSON") from error
            if not isinstance(probe_payload, dict) or probe_payload.get("state") != "passed":
                raise ActiveRunRuntimeError("active-run probe returned an invalid result")
            receipt["health"] = health
            receipt["active_run_probe"] = probe_payload
            receipt["cli_exit_code_before_cleanup"] = cli_process.poll()
            receipt["cli_exit_code"] = terminate(cli_process)
            if frozen_package is not None:
                record_process_evidence(receipt, "fullmag-cli", cli_process, receipt["cli_exit_code"])
            if receipt["cli_exit_code"] is None:
                raise ActiveRunRuntimeError("Owned fullmag CLI exit remains unknown after bounded cleanup")
            cli_process = None
            receipt["api_exit_code"] = terminate(api_process)
            if frozen_package is not None:
                record_process_evidence(receipt, "fullmag-api", api_process, receipt["api_exit_code"])
            if receipt["api_exit_code"] is None:
                raise ActiveRunRuntimeError("Owned fullmag API exit remains unknown after bounded cleanup")
            api_process = None
            if cli_log_handle is not None:
                cli_log_handle.close()
                cli_log_handle = None
            if api_log_handle is not None:
                api_log_handle.close()
                api_log_handle = None
            receipt["fixture_sha256"] = hashlib.sha256(paths["fixture"].read_bytes()).hexdigest()
            source_after = source_identity.capture(repo_root, ignore_non_runtime_dirty=True)
            write_atomic_json(paths["source_snapshot_after"], source_after)
            receipt["source_identity_after"] = (
                frozen_package["source_identity"] if frozen_package is not None else source_after
            )
            receipt["current_checkout_identity_after"] = source_after
            checkout_changed = (
                source_after["source_snapshot_sha256"]
                != current_checkout_identity["source_snapshot_sha256"]
            )
            receipt["current_checkout_source_changed_during_run"] = checkout_changed
            receipt["source_changed_during_run"] = checkout_changed if frozen_package is None else False
            if checkout_changed and frozen_package is None:
                raise ActiveRunRuntimeError("source identity changed during active-run runtime smoke")
            if frozen_package is not None:
                if runtime_bundle._sha256_file(frozen_package["python_executable"]) != frozen_package["python_sha256"]:
                    raise ActiveRunRuntimeError("Frozen Python interpreter changed during active-run runtime smoke")
                if sealed_package is None:
                    raise ActiveRunRuntimeError("Frozen runtime bundle was not sealed")
                bundle_manifest, bundle_hashes = runtime_bundle.validate_bundle(
                    sealed_package["bundle_root"], frozen_package["runtime_root"], "dev"
                )
                if (bundle_manifest.get("bundle_id") != sealed_package["bundle_id"]
                        or bundle_hashes["bin/fullmag-api.exe"] != sealed_package["api_binary_sha256"]
                        or bundle_hashes["bin/fullmag.exe"] != sealed_package["cli_binary_sha256"]):
                    raise ActiveRunRuntimeError("Frozen native runtime bundle changed during active-run smoke")
                try:
                    final_verified = verified_build_identity(
                        frozen_package["build_root"],
                        frozen_package["runtime_root"],
                        frozen_package["manifest_path"],
                        expected_source_sha256=None,
                        expected_manifest_sha256=frozen_package["manifest_sha256"],
                    )
                except Exception as error:
                    raise ActiveRunRuntimeError("Frozen native build changed during active-run smoke") from error
                if final_verified["ready_build_id"] != frozen_package["manifest_sha256"]:
                    raise ActiveRunRuntimeError("Frozen native build identity changed during active-run smoke")
            receipt["state"] = "passed"
            return_code = 0
        except BaseException as error:
            receipt["state"] = "failed"
            receipt["error"] = f"{type(error).__name__}: {error}"
            return_code = 1
        finally:
            if cli_process is not None:
                receipt["cli_exit_code"] = terminate(cli_process)
                if frozen_package is not None:
                    record_process_evidence(receipt, "fullmag-cli", cli_process, receipt["cli_exit_code"])
            if api_process is not None:
                receipt["api_exit_code"] = terminate(api_process)
                if frozen_package is not None:
                    record_process_evidence(receipt, "fullmag-api", api_process, receipt["api_exit_code"])
            if cli_log_handle is not None:
                cli_log_handle.close()
            if api_log_handle is not None:
                api_log_handle.close()
            receipt["finished_at"] = utc_now()
            receipt["exit_code"] = return_code
            write_atomic_json(paths["receipt"], receipt)
        # The managed Windows runner may expose a legacy console code page.
        # Keep the frozen route's stdout small; its complete evidence is in the receipt.
        if frozen_package is not None:
            error = receipt.get("error")
            processes = receipt.get("processes")
            summary = {
                "receipt": str(paths["receipt"]),
                "state": receipt["state"],
                "exit_code": receipt["exit_code"],
                "run_id": run_id,
                "process_count": len(processes) if isinstance(processes, list) else 0,
                "error": str(error)[:500] if error is not None else None,
            }
            print(json.dumps(summary, ensure_ascii=True))
        else:
            print(json.dumps(receipt, indent=2, ensure_ascii=True))
        return return_code, receipt


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--frozen-native-build-id")
    args = parser.parse_args(argv)
    try:
        return run(args.repo_root.resolve(), frozen_native_build_id=args.frozen_native_build_id)[0]
    except Exception as error:
        print(f"project active-run runtime smoke failed before receipt: {type(error).__name__}: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
