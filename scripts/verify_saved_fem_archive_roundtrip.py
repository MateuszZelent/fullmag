#!/usr/bin/env python3
"""Cold archive qualification using an existing managed production CLI.

No build or solver launch. The original store is read only; export, import and
deliberate corruption operate on private copies retained beside the receipt.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager, ExitStack
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import uuid

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
import fullmag_storage as storage
from local_runner.build_executor import validate_build_receipt

SCHEMA = "fullmag.saved_fem_archive_roundtrip.v1"
MAX_STORE_BYTES = 1024 ** 3
MAX_FILES = 50_000
OPERATIONAL_FILES = {"WRITER.lock", "WRITER.owner.json"}
ARCHIVE_PROJECT_LEAFS = {"main.py", "problem_ir.json", "scene_document.json",
                         "script_builder.json", "model_builder_graph.json", "ui_state.json"}


@contextmanager
def source_read_lock(root: Path):
    """Hold the existing native descriptor without changing its data/owner."""
    path = storage.validate_path(root / "WRITER.lock", root, "source lock descriptor")
    with path.open("r+b") as stream:
        descriptor = b"fullmag.writer.lock.v1\n"
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size != len(descriptor) or stream.read(len(descriptor)) != descriptor:
            raise ValueError("source native lock descriptor is missing or unsupported")
        stream.seek(0)
        if os.name == "nt":
            import ctypes
            from ctypes import wintypes
            import msvcrt
            class Overlapped(ctypes.Structure):
                _fields_ = [("Internal", ctypes.c_size_t), ("InternalHigh", ctypes.c_size_t),
                            ("Offset", wintypes.DWORD), ("OffsetHigh", wintypes.DWORD), ("hEvent", wintypes.HANDLE)]
            kernel = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.LockFileEx.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD,
                                         wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(Overlapped)]
            kernel.LockFileEx.restype = wintypes.BOOL
            kernel.UnlockFileEx.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD,
                                           wintypes.DWORD, ctypes.POINTER(Overlapped)]
            kernel.UnlockFileEx.restype = wintypes.BOOL
            handle = wintypes.HANDLE(msvcrt.get_osfhandle(stream.fileno()))
            overlapped = Overlapped()
            # Shared native lease: permit inventory reads, refuse any exclusive
            # Rust writer lock. FAIL_IMMEDIATELY prevents observation waits.
            if not kernel.LockFileEx(handle, 1, 0, 0xffffffff, 0xffffffff, ctypes.byref(overlapped)):
                raise ctypes.WinError(ctypes.get_last_error())
        else:
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_SH | fcntl.LOCK_NB)
        lease = {"acquired": True, "released": False, "owner_document_modified": False,
                 "scope": "entire_copy_export_import_observation"}
        try:
            yield lease
        finally:
            stream.seek(0)
            if os.name == "nt":
                if not kernel.UnlockFileEx(handle, 0, 0xffffffff, 0xffffffff, ctypes.byref(overlapped)):
                    raise ctypes.WinError(ctypes.get_last_error())
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
            lease["released"] = True


def check_archive_source(root: Path, files: dict, pinned: dict) -> dict:
    unsupported = sorted(name for name in files if name.startswith("project/")
                         and name.removeprefix("project/") not in ARCHIVE_PROJECT_LEAFS)
    if unsupported:
        raise ValueError(f"archive reachability is not qualified for project documents: {unsupported}; no files removed")
    if not files.get("project/main.py", {}).get("size"):
        raise ValueError("archive qualification requires nonempty project/main.py")
    with (root / "CURRENT").open("rb") as stream:
        current_bytes = stream.read(4097)
    if len(current_bytes) > 4096:
        raise ValueError("CURRENT exceeds metadata budget")
    current = current_bytes.decode("utf-8").strip()
    if current in {".", ".."} or not re.fullmatch(r"[A-Za-z0-9._-]{1,200}", current):
        raise ValueError("invalid CURRENT generation")
    session_path = storage.validate_path(root / "manifests" / f"{current}.json", root)
    session = read_json(session_path, 1024 * 1024)
    run_id = pinned.get("run_id", "")
    if not isinstance(run_id, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,200}", run_id) or run_id in {".", ".."}:
        raise ValueError("invalid pinned run id")
    run_ref = f"runs/{run_id}/run_manifest.json"
    if session.get("format") != "fullmag.session.v1" or run_ref not in session.get("run_refs", []) \
            or run_ref not in files or f"runs/{run_id}/artifact_catalog.json" not in files:
        raise ValueError("CURRENT does not include pinned run manifest and artifact catalog")
    return {"current_generation": current, "manifest_sha256": digest(session_path),
            "pinned_run_ref": run_ref, "project_documents": sorted(name for name in files if name.startswith("project/"))}


def read_json(path: Path, limit: int = 16 * 1024) -> dict:
    with path.open("rb") as stream:
        raw = stream.read(limit + 1)
    if len(raw) > limit:
        raise ValueError(f"metadata budget exceeded: {path}")
    result = json.loads(raw)
    if not isinstance(result, dict):
        raise ValueError(f"expected a JSON object: {path}")
    return result


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def driver_identity() -> dict:
    return {name: digest(SCRIPT_DIR / name) for name in (
        "verify_saved_fem_archive_roundtrip.py", "fullmag_storage.py",
        "local_runner/build_executor.py", "local_runner/worker_entrypoint.py")}


def inventory(root: Path) -> dict[str, dict]:
    """Reject links, devices and unbounded inputs before copying any data."""
    storage.absolute(root, "store root")
    result = {}
    size = 0
    seen = 0
    def scan_error(error):
        raise error
    for current, directories, files in os.walk(root, followlinks=False, onerror=scan_error):
        for name in directories + files:
            seen += 1
            if seen > MAX_FILES:
                raise ValueError("store exceeds qualification member budget")
            path = Path(current) / name
            storage.absolute(path, "store member")
            info = path.lstat()
            if stat.S_ISDIR(info.st_mode):
                continue
            if not stat.S_ISREG(info.st_mode):
                raise ValueError(f"store contains a non-regular member: {path}")
            size += info.st_size
            if size > MAX_STORE_BYTES or len(result) >= MAX_FILES:
                raise ValueError("store exceeds qualification copy budget")
            result[path.relative_to(root).as_posix()] = {"size": info.st_size, "sha256": digest(path)}
    return result


def copy_store(source: Path, destination: Path, expected: dict) -> None:
    if destination.exists():
        raise ValueError("qualification destination already exists")
    # Native lock descriptors/owner records are process state, never copied to
    # another repository. All durable documents and CAS bytes remain identical.
    def ignore(directory, names):
        return OPERATIONAL_FILES.intersection(names) if Path(directory) == source else set()
    shutil.copytree(source, destination, ignore=ignore, symlinks=True)
    copied = inventory(destination)
    durable = {name: entry for name, entry in expected.items() if name not in OPERATIONAL_FILES}
    if copied != durable or inventory(source) != expected:
        raise ValueError("store changed during qualification copy")


def check_stamp(stderr: str, commit: str, snapshot: str) -> None:
    stamps = [line for line in stderr.splitlines() if line.startswith("[fullmag] build:")]
    match = re.fullmatch(r"\[fullmag\] build: [^|\r\n]+ \| commit: ([0-9a-f]{40}) \| (clean|dirty) \| source snapshot: ([0-9a-f]{64})",
                         stamps[0]) if len(stamps) == 1 else None
    if match is None or match.groups() != (commit, "clean", snapshot):
        raise ValueError("CLI startup identity differs from exact managed build")


def check_integrity_result(payload: dict, pinned: dict, artifact_id: str) -> dict:
    if payload.get("schema") != "fullmag.saved_native_fem_snapshot_integrity.v1" \
            or payload.get("status") != "pass" or payload.get("source") != pinned \
            or payload.get("source_artifact_id") != artifact_id \
            or payload.get("scientific_qualification") != "not_verified" \
            or payload.get("archive_roundtrip") != "not_verified":
        raise ValueError("saved snapshot result does not identify the requested source")
    receipt = payload.get("native_snapshot_receipt")
    if not isinstance(receipt, dict) or any(
        not isinstance(receipt.get(key), str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", receipt[key])
        for key in ("values_sha256", "native_node_map_sha256", "native_indexed_geometry_sha256")
    ):
        raise ValueError("saved snapshot result has incomplete native integrity receipts")
    return receipt


def run(repo_root: Path, config_path: Path) -> tuple[int, dict]:
    profile = "windows-saved-fem-archive-roundtrip" if os.name == "nt" else "linux-saved-fem-archive-roundtrip"
    layout = storage.resolve_layout(repo_root, profile)
    storage.initialize(layout)
    base = Path(layout["storage_root"])
    run_root = storage.validate_path(Path(layout["build_root"]) / "runs" / uuid.uuid4().hex,
                                    Path(layout["build_storage_root"]))
    run_root.mkdir(parents=True, exist_ok=False)
    receipt = {"schema": SCHEMA, "state": "running", "qualification": "NOT VERIFIED",
               "run_root": str(run_root), "driver_sources": driver_identity(), "profile": profile,
               "python": sys.version, "platform": sys.platform}
    receipt_path = run_root / "receipt.json"
    command_records = []
    receipt["commands"] = command_records
    storage.atomic_json(receipt_path, receipt)
    result_code = 2
    try:
        with storage.file_lock(run_root / "qualification.lock", str(run_root)), ExitStack() as resources:
            config_path = storage.validate_path(config_path, base, "qualification config")
            config = read_json(config_path)
            required = {"build_run_root", "store", "pinned_source", "source_artifact_id",
                        "expected_commit", "expected_native_source_snapshot_sha256"}
            if set(config) != required or not all(isinstance(value, str) for value in config.values()):
                raise ValueError("qualification config has missing or unknown fields")
            if not re.fullmatch(r"[0-9a-f]{40}", config["expected_commit"]) \
                    or not re.fullmatch(r"[0-9a-f]{64}", config["expected_native_source_snapshot_sha256"]):
                raise ValueError("qualification requires full canonical source identities")
            build_root = storage.validate_path(Path(config["build_run_root"]), base, "managed build root")
            journal = read_json(build_root / "receipt.json", 64 * 1024)
            context = read_json(build_root / "trusted/context.json", 64 * 1024)
            if build_root.name != context.get("job_id") or any(
                journal.get(key) != context.get(key)
                for key in ("job_id", "profile", "source_digest", "image_digest")
            ):
                raise ValueError("managed coordinator and execution context identities differ")
            if journal.get("phase") != "terminal" or journal.get("state") != "succeeded" \
                    or journal.get("exit_code") != 0 or journal.get("profile") != "fem-cpu-release":
                raise ValueError("managed FEM CPU build is not terminal and successful")
            for name, expected in journal.get("trusted_hashes", {}).items():
                member = storage.validate_path(build_root / "trusted" / name, build_root / "trusted")
                if digest(member) != expected:
                    raise ValueError("managed trusted execution document hash mismatch")
            if set(journal.get("trusted_hashes", {})) != {"context.json", "build_entrypoint.py", "worker_entrypoint.py"}:
                raise ValueError("managed build trusted documents are incomplete")
            native = context.get("native_source_identity", {})
            if native.get("head_commit_full") != config["expected_commit"] \
                    or native.get("source_snapshot_sha256") != config["expected_native_source_snapshot_sha256"] \
                    or native.get("source_snapshot_dirty") is not False:
                raise ValueError("managed build source identity differs from qualification request")
            job = {"job_id": context["job_id"], "source_digest": context["source_digest"],
                   "profile": context["profile"], "payload": {"native_source_identity": native}}
            built = validate_build_receipt(build_root / "artifacts", job, journal)
            binary_relative = "outputs/.fullmag/local/bin/fullmag-bin"
            binary = storage.validate_path(build_root / "artifacts" / binary_relative, build_root / "artifacts")
            entry = next((entry for entry in built["artifacts"] if entry["path"] == binary_relative), None)
            if entry is None or entry["size"] == 0:
                raise ValueError("managed production CLI artifact is missing")
            source = storage.validate_path(Path(config["store"]), base, "source qualification store")
            if not source.is_dir() or storage.inside(run_root, source) or storage.inside(source, run_root):
                raise ValueError("source store is missing or overlaps qualification output")
            receipt["source_native_read_lock"] = resources.enter_context(source_read_lock(source))
            before = inventory(source)
            if "LOCK" in before:
                raise ValueError("legacy store lock requires explicit recovery outside qualification")
            if "WRITER.owner.json" in before:
                owner = read_json(source / "WRITER.owner.json")
                if owner.get("schema") != "fullmag.writer.v1" or owner.get("released") is not True:
                    raise ValueError("qualification requires a cold store with released writer record")
            pinned_path = storage.validate_path(Path(config["pinned_source"]), base, "pinned source file")
            pinned = read_json(pinned_path)
            receipt["pinned_source_file_sha256"] = digest(pinned_path)
            receipt["archive_source_preflight"] = check_archive_source(source, before, pinned)
            storage.atomic_json(run_root / "pinned-source.json", pinned)
            pinned_path = run_root / "pinned-source.json"
            bytes_total = sum(entry["size"] for entry in before.values())
            if shutil.disk_usage(run_root).free < bytes_total * 6 + 512 * 1024 ** 2:
                raise ValueError("insufficient capacity for retained archive qualification copies")
            source_state = run_root / "source-state"
            cloned = source_state / "local-live/session-store"
            copy_store(source, cloned, before)
            env = os.environ.copy()
            env["FULLMAG_REPO_ROOT"] = str(repo_root)
            library_root = binary.parent.parent / "lib"
            env["LD_LIBRARY_PATH"] = str(library_root) + os.pathsep + env.get("LD_LIBRARY_PATH", "")
            env["PYTHONDONTWRITEBYTECODE"] = "1"
            def execute(label, state_root, args, *, reject_corruption=False):
                command_env = dict(env, FULLMAG_STATE_ROOT=str(state_root))
                out = run_root / f"{label}.stdout.log"
                err = run_root / f"{label}.stderr.log"
                record = {"label": label, "state": "observing", "stdout": str(out), "stderr": str(err)}
                command_records.append(record)
                with out.open("wb") as stdout, err.open("wb") as stderr:
                    process = subprocess.Popen([str(binary), *map(str, args)], cwd=repo_root,
                                               env=command_env, stdout=stdout, stderr=stderr)
                    record["pid"] = process.pid
                    storage.atomic_json(receipt_path, receipt)
                    try:
                        process.wait(timeout=300)
                    except subprocess.TimeoutExpired:
                        record["state"] = "observation_timeout_process_retained"
                        raise ValueError(f"observation timeout; process retained pid={process.pid}; see {err}")
                stdout_text = out.read_text(encoding="utf-8")
                stderr_text = err.read_text(encoding="utf-8")
                record.update(state="terminal", exit_code=process.returncode,
                              stdout_sha256=digest(out), stderr_sha256=digest(err))
                check_stamp(stderr_text, config["expected_commit"], config["expected_native_source_snapshot_sha256"])
                if reject_corruption:
                    if process.returncode == 0 or "CAS integrity error" not in stderr_text:
                        raise ValueError("corrupt CAS field chunk was not rejected for integrity failure")
                elif process.returncode != 0:
                    raise ValueError(f"qualification command failed: {label}, see {err}")
                return stdout_text

            def verify(label, state_root, store):
                raw = execute(label, state_root, ["runtime", "verify-saved-fem-snapshot", "--store", store,
                              "--source", pinned_path, "--source-artifact-id", config["source_artifact_id"]])
                return check_integrity_result(json.loads(raw), pinned, config["source_artifact_id"])

            first = verify("before-export", source_state, cloned)
            archive = run_root / "snapshot.fms"
            execute("export", source_state, ["session", "save", archive, "--profile", "archive"])
            import_state = run_root / "import-state"
            execute("import", import_state, ["session", "open", archive])
            imported = import_state / "local-live/session-store"
            second = verify("after-import", import_state, imported)
            if first != second:
                raise ValueError("native snapshot receipt changed across archive roundtrip")
            damaged_state = run_root / "damaged-state"
            damaged = damaged_state / "local-live/session-store"
            copy_store(imported, damaged, inventory(imported))
            tensor_ref = pinned.get("tensor_object_ref", "")
            if not re.fullmatch(r"[0-9a-f]{64}", tensor_ref):
                raise ValueError("invalid pinned tensor hash")
            tensor = read_json(damaged / "objects/sha256" / tensor_ref, 4 * 1024 ** 2)
            chunks = tensor.get("chunks", [])
            chunk_ref = chunks[0].get("object_ref", "") if chunks else ""
            if not re.fullmatch(r"[0-9a-f]{64}", chunk_ref):
                raise ValueError("saved tensor has no canonical field chunk")
            corrupt_path = storage.validate_path(damaged / "objects/sha256" / chunk_ref, damaged)
            with corrupt_path.open("r+b") as stream:
                original = stream.read(1)
                if not original:
                    raise ValueError("cannot corrupt an empty field chunk")
                stream.seek(0)
                stream.write(bytes([original[0] ^ 1]))
            execute("reject-corrupt-field", damaged_state, ["runtime", "verify-saved-fem-snapshot", "--store", damaged,
                    "--source", pinned_path, "--source-artifact-id", config["source_artifact_id"]], reject_corruption=True)
            if inventory(source) != before or digest(binary) != entry["sha256"]:
                raise ValueError("original store or production binary changed during qualification")
            if driver_identity() != receipt["driver_sources"]:
                raise ValueError("qualification driver sources changed during observation")
            receipt.update(state="passed", exit_code=0, source=pinned, native_snapshot_receipt=second,
                           commands=command_records, build_job_id=context["job_id"],
                           build_source=native, binary_sha256=entry["sha256"],
                           archive={"path": str(archive), "sha256": digest(archive), "bytes": archive.stat().st_size},
                           original_store_unchanged=True, corrupted_chunk_rejected=chunk_ref,
                           qualification="archive_integrity_only", scientific_qualification="NOT VERIFIED")
            result_code = 0
    except Exception as error:
        pending = any(command.get("state") == "observation_timeout_process_retained" for command in command_records)
        receipt.update(state="observation_pending" if pending else "failed", exit_code=2,
                       error=f"{type(error).__name__}: {error}")
    finally:
        storage.atomic_json(receipt_path, receipt)
    print(json.dumps({"receipt": str(receipt_path), "state": receipt["state"], "error": receipt.get("error")}))
    return result_code, receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=SCRIPT_DIR.parent)
    args = parser.parse_args()
    config = os.environ.get("FULLMAG_SAVED_FEM_ROUNDTRIP_CONFIG")
    if not config:
        parser.error("FULLMAG_SAVED_FEM_ROUNDTRIP_CONFIG must name a managed-storage JSON config")
    return run(args.repo_root.resolve(), Path(config))[0]


if __name__ == "__main__":
    raise SystemExit(main())
