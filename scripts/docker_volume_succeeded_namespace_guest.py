#!/usr/bin/env python3
"""Diagnostic PID1 and one explicit, proof-fenced succeeded-namespace handoff.

No build, solver, owner initialization, or automatic recovery is performed.
The candidate native verifier owns task/lease/proof semantics; this guest
rechecks its exact file snapshot under the same final kernel fences.
"""
from __future__ import annotations

import argparse
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
import fcntl
import hashlib
import importlib
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import sys
import threading
import time
import uuid

CONTROL = Path("/opt/fullmag/control")
PACKAGE = Path("/opt/fullmag/package")
IMAGE = Path("/opt/fullmag")
SOURCE = Path("/opt/fullmag/source")
HOST_LEDGER = Path("/host-ledger")
SCHEMA = "fullmag.succeeded-namespace-guest.v1"
RESUME_SCHEMA = "fullmag.succeeded-namespace-resume.v1"
MAX_JSON = 8 * 1024 * 1024
MAX_FILE = 64 * 1024 * 1024 * 1024
MAX_GUARDED_FILES = 65_536
REQUEST_FIELDS = frozenset({"schema", "request_id", "teardown", "teardown_request_sha256",
    "teardown_intent_sha256", "candidate_path", "candidate_marker_sha256", "candidate_receipt_sha256",
    "candidate_api_sha256", "candidate_native_sha256", "source_snapshot_sha256", "config_path",
    "config_sha256", "runtime_service_sha256", "backend_dev_sha256", "entrypoint_sha256", "guest_sha256",
    "old_current_receipt_sha256", "status_path", "resume_intent_path", "fms_archive_path", "fms_archive_sha256"})
RESUME_FIELDS = frozenset({"schema", "guest_request_sha256", "native_request_path", "native_request_sha256",
    "native_completion_path", "native_completion_sha256", "fms_archive_sha256", "solve_replay"})


class GuestError(RuntimeError):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()


def sha(value):
    return hashlib.sha256(value).hexdigest()


def digest(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
        raise GuestError("invalid SHA-256 pin")
    return value


def absolute(value):
    if not isinstance(value, str) or not value or value != os.path.normpath(value):
        raise GuestError("path is not normalized")
    path = Path(value)
    if not path.is_absolute() or ".." in path.parts:
        raise GuestError("path must be absolute")
    return path


def control_path(value):
    path = absolute(value)
    if not path.is_relative_to(CONTROL / "verification"):
        raise GuestError("operational document is outside group verification")
    return path


def no_links(path):
    for part in [*reversed(path.parents), path]:
        metadata = part.lstat()
        if stat.S_ISLNK(metadata.st_mode):
            raise GuestError("symlink in recovery evidence path")


@contextmanager
def regular(path):
    no_links(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise GuestError("evidence is not one regular file")
        yield fd, before
        after = os.fstat(fd)
        named = path.lstat()
        signature = lambda item: (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns, item.st_ctime_ns)
        if signature(before) != signature(after) or signature(after) != signature(named):
            raise GuestError("recovery evidence changed while reading")
    finally:
        os.close(fd)


def file_hash(path, maximum=MAX_FILE):
    with regular(path) as (fd, metadata):
        if metadata.st_size > maximum:
            raise GuestError("evidence exceeds its byte budget")
        checksum = hashlib.sha256()
        count = 0
        while block := os.read(fd, 1024 * 1024):
            count += len(block)
            if count > maximum:
                raise GuestError("evidence grew beyond its byte budget")
            checksum.update(block)
        if count != metadata.st_size:
            raise GuestError("evidence length changed")
        return checksum.hexdigest()


def read_bytes(path, maximum=MAX_JSON):
    with regular(path) as (fd, metadata):
        if metadata.st_size > maximum:
            raise GuestError("JSON evidence exceeds its byte budget")
        data = bytearray()
        while block := os.read(fd, min(65536, maximum + 1 - len(data))):
            data.extend(block)
            if len(data) > maximum:
                raise GuestError("JSON evidence grew beyond its byte budget")
        if len(data) != metadata.st_size:
            raise GuestError("JSON evidence length changed")
        return bytes(data)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise GuestError("duplicate JSON field")
        result[key] = value
    return result


def read_json(path, pin=None):
    raw = read_bytes(path)
    if pin is not None and sha(raw) != digest(pin):
        raise GuestError("JSON evidence pin changed")
    value = json.loads(raw, object_pairs_hook=unique_object,
        parse_constant=lambda _: (_ for _ in ()).throw(GuestError("nonfinite JSON value")))
    if not isinstance(value, dict):
        raise GuestError("JSON evidence must be an object")
    return value, raw


def immutable(path, value):
    raw = canonical(value) + b"\n"
    no_links(path.parent)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    except FileExistsError:
        # Exact replay must finish both durability barriers as well: a prior
        # process may have stopped after write but before either fsync.
        with regular(path) as (existing, metadata):
            if metadata.st_size != len(raw) or os.read(existing, len(raw) + 1) != raw:
                raise GuestError("immutable guest record already differs")
            os.fsync(existing)
        fd = None
    if fd is not None:
        try:
            view = memoryview(raw)
            while view:
                count = os.write(fd, view)
                if count <= 0:
                    raise GuestError("short immutable guest publication")
                view = view[count:]
            os.fsync(fd)
        finally:
            os.close(fd)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    return sha(raw)


def forbid_startup(environment):
    for key, value in environment.items():
        if key.startswith("FULLMAG_STARTUP_") and not (key == "FULLMAG_STARTUP_ENABLED" and value == "0"):
            raise GuestError("startup script configuration is forbidden in namespace recovery")


def validate_request(value, request_path):
    if set(value) != REQUEST_FIELDS or value["schema"] != SCHEMA:
        raise GuestError("invalid guest request schema or fields")
    identifier = uuid.UUID(value["request_id"])
    if identifier.int == 0 or str(identifier) != value["request_id"]:
        raise GuestError("guest request ID is not canonical")
    for key in REQUEST_FIELDS:
        if key.endswith("sha256"):
            digest(value[key])
    teardown = value["teardown"]
    if not isinstance(teardown, dict) or teardown.get("schema_version") != "host_succeeded_worker_namespace_teardown_request.v1" \
            or teardown.get("request_id") != value["request_id"] or sha(canonical(teardown)) != value["teardown_request_sha256"] \
            or teardown.get("config_sha256") != value["config_sha256"]:
        raise GuestError("guest request differs from its immutable teardown")
    intent = {"schema_version":"host_succeeded_worker_namespace_teardown_intent.v1",
        "request_sha256":value["teardown_request_sha256"], "request":teardown}
    if sha(canonical(intent)) != value["teardown_intent_sha256"]:
        raise GuestError("guest request differs from its immutable intent")
    candidate = absolute(value["candidate_path"])
    if candidate.parent != PACKAGE / ".development/candidates" or not re.fullmatch(r"\.backend-package-candidate-[A-Za-z0-9._-]+", candidate.name):
        raise GuestError("guest API must use the exact unpublished candidate")
    for key in ("status_path", "resume_intent_path"):
        if control_path(value[key]).parent != request_path.parent:
            raise GuestError("guest operational paths differ from the request directory")
    if len({request_path, control_path(value["status_path"]), control_path(value["resume_intent_path"])}) != 3:
        raise GuestError("guest operational paths overlap")
    absolute(value["config_path"])
    archive = absolute(value["fms_archive_path"])
    if not archive.is_relative_to(Path("/state")) or archive.suffix != ".fms":
        raise GuestError("guest archive must be preserved user FMS data")
    return value


def image_modules(request):
    for name, pin in [("runtime_service", "runtime_service_sha256"), ("backend_dev", "backend_dev_sha256"), ("entrypoint", "entrypoint_sha256")]:
        if file_hash(IMAGE / (name + ".py"), MAX_JSON) != request[pin]:
            raise GuestError("image runtime helper changed")
    if file_hash(Path(__file__), MAX_JSON) != request["guest_sha256"]:
        raise GuestError("guest source helper changed")
    sys.path.insert(0, str(IMAGE))
    return importlib.import_module("runtime_service"), importlib.import_module("backend_dev")


def validate_package(request, backend):
    candidate = Path(request["candidate_path"])
    marker = backend._validate_candidate_marker(candidate, PACKAGE, Path("/build"), state="ready")
    receipt, raw, _ = backend._validated_package(candidate, "namespace recovery candidate", exclude_candidate_marker=True)
    if sha(raw) != request["candidate_receipt_sha256"] \
            or file_hash(candidate / ".candidate-owner.json", MAX_JSON) != request["candidate_marker_sha256"] \
            or receipt.get("source", {}).get("source_snapshot_sha256") != request["source_snapshot_sha256"] \
            or marker.get("artifact_inventory_sha256") != sha(backend._canonical(receipt["artifacts"])):
        raise GuestError("ready candidate identity changed")
    for name, key in [("fullmag-api", "candidate_api_sha256"), ("fullmag-runtime-service", "candidate_native_sha256")]:
        if file_hash(candidate / "bin" / name) != request[key]:
            raise GuestError("candidate executable changed")
    if file_hash(PACKAGE / "backend-build-receipt.json", MAX_JSON) != request["old_current_receipt_sha256"]:
        raise GuestError("old current package changed before authorized promotion")
    return receipt, raw


def container_identity():
    matches = []
    for line in proc_bytes(Path(f"/proc/{os.getpid()}/mountinfo"), MAX_JSON).decode().splitlines():
        fields = line.split()
        if len(fields) >= 6 and fields[4] == "/etc/hostname":
            match = re.search(r"/containers/([0-9a-f]{64})/hostname$", fields[3])
            if not match or "ro" not in fields[5].split(","):
                raise GuestError("container hostname mount is not kernel-bound")
            matches.append(match.group(1))
    if len(matches) != 1:
        raise GuestError("guest requires one exact kernel container identity")
    return matches[0], os.readlink("/proc/self/ns/pid")


def proc_bytes(path, maximum):
    # Kernel pseudo-files report size zero; never apply durable-file length rules.
    with path.open("rb") as stream:
        raw = stream.read(maximum + 1)
    if len(raw) > maximum:
        raise GuestError("kernel observation exceeds its byte budget")
    return raw


def start_token(pid):
    raw = proc_bytes(Path(f"/proc/{pid}/stat"), 16384).decode()
    fields = raw.rsplit(")", 1)[1].split()
    return "linux-starttime-" + str(int(fields[19]))


@dataclass
class Child:
    process: subprocess.Popen
    token: str | None
    executable: Path
    executable_sha256: str
    signalled: bool = False


def own_child(process, executable, pin, children):
    # Register the unreaped direct child before any fallible procfs lookup.
    # A missing token never turns a spawned process into an unowned descendant.
    child = Child(process, None, executable, pin)
    children.append(child)
    child.token = start_token(process.pid)
    return child


def assert_child(child):
    if child.process.poll() is not None:
        raise GuestError("owned recovery child exited")
    if start_token(child.process.pid) != child.token or Path(os.readlink(f"/proc/{child.process.pid}/exe")) != child.executable \
            or file_hash(child.executable) != child.executable_sha256:
        raise GuestError("owned child identity changed")


def stop_child(child):
    if child.process.poll() is not None:
        return
    if child.token is not None:
        assert_child(child)
    # Popen still owns an unreaped direct child when capture failed. poll()
    # above proves it has not been reaped, so its PID cannot have been reused.
    if not child.signalled:
        child.process.terminate()
        child.signalled = True
    try:
        child.process.wait(timeout=10)
    except subprocess.TimeoutExpired as error:
        raise GuestError("owned child SIGTERM completion is unconfirmed; no escalation") from error


def no_other_consumers(allowed):
    count = 0
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        count += 1
        if count > MAX_GUARDED_FILES:
            raise GuestError("process inventory exceeds its bound")
        if int(entry.name) in allowed:
            continue
        try:
            with (entry / "cmdline").open("rb") as stream:
                command = stream.read(16385)
        except FileNotFoundError:
            continue
        if len(command) > 16384:
            raise GuestError("process command exceeds its bound")
        name = Path(os.fsdecode(command.split(b"\0", 1)[0])).name
        if name.startswith("fullmag") or name in {"cargo","rustc","make","cmake","ninja","nvcc","cc1","cc1plus"}:
            raise GuestError("another runtime or build consumer is present")


@contextmanager
def existing_lock(path, descriptor=None):
    no_links(path)
    fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        held = os.fstat(fd)
        if not stat.S_ISREG(held.st_mode) or held.st_nlink != 1:
            raise GuestError("recovery fence is not one regular file")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        named = path.lstat()
        if (held.st_dev, held.st_ino) != (named.st_dev, named.st_ino):
            raise GuestError("recovery fence inode changed")
        if descriptor is not None and os.read(fd, len(descriptor) + 1) != descriptor:
            raise GuestError("recovery fence descriptor differs")
        yield
        named = path.lstat()
        if (held.st_dev, held.st_ino) != (named.st_dev, named.st_ino):
            raise GuestError("recovery fence inode changed during handoff")
    finally:
        os.close(fd)


def collect_native(child, stopping, timeout=900):
    result = {"stdout":bytearray(), "stderr":bytearray()}
    deadline = time.monotonic() + timeout
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(child.process.stdout, selectors.EVENT_READ, "stdout")
            selector.register(child.process.stderr, selectors.EVENT_READ, "stderr")
            while selector.get_map():
                if stopping.is_set() or time.monotonic() >= deadline:
                    raise GuestError("native handoff preview was interrupted or timed out")
                for key, _ in selector.select(0.5):
                    block = os.read(key.fileobj.fileno(), 65536)
                    if not block:
                        selector.unregister(key.fileobj)
                        continue
                    output = result[key.data]
                    output.extend(block)
                    if len(output) > (MAX_JSON if key.data == "stdout" else 65536):
                        raise GuestError("native handoff preview exceeded its output budget")
        code = child.process.wait(timeout=10)
        if code != 0:
            raise GuestError("native handoff preview refused; no automatic retry")
        return json.loads(result["stdout"], object_pairs_hook=unique_object)
    except BaseException:
        stop_child(child)
        raise
    finally:
        child.process.stdout.close()
        child.process.stderr.close()


def validate_resume(resume, request, guest_pin):
    if set(resume) != RESUME_FIELDS or resume["schema"] != RESUME_SCHEMA \
            or resume["guest_request_sha256"] != guest_pin or resume["solve_replay"] is not False \
            or resume["fms_archive_sha256"] != request["fms_archive_sha256"]:
        raise GuestError("resume intent differs from this one explicit guest operation")
    for key in RESUME_FIELDS:
        if key.endswith("sha256"):
            digest(resume[key])
    for key in ("native_request_path", "native_completion_path"):
        control_path(resume[key])
    root, _ = read_json(Path(resume["native_request_path"]), resume["native_request_sha256"])
    if root.get("schema_version") != "runtime_service_succeeded_namespace_recovery.v1" \
            or root.get("teardown") != request["teardown"] \
            or root.get("request_id") != request["request_id"] \
            or root.get("config_sha256") != request["config_sha256"] \
            or root.get("source_snapshot_sha256") != request["source_snapshot_sha256"] \
            or root.get("package_receipt_sha256") != request["candidate_receipt_sha256"] \
            or root.get("executable_sha256") != request["candidate_native_sha256"]:
        raise GuestError("resume root request changes the approved core or candidate")
    complete, _ = read_json(Path(resume["native_completion_path"]), resume["native_completion_sha256"])
    if complete.get("schema_version") != root["schema_version"] or complete.get("status") != "released" \
            or complete.get("request_sha256") != resume["native_request_sha256"] \
            or complete.get("teardown_request_sha256") != request["teardown_request_sha256"] \
            or complete.get("task_outcome") != "succeeded" or complete.get("process_exit_status") != "unknown" \
            or complete.get("solve_replayed") is not False:
        raise GuestError("resume requires the exact native release completion receipt")
    control_path(root.get("attestation_path"))
    digest(root.get("attestation_sha256"))
    return root


def validate_guarded_files(files, required, paths):
    if not isinstance(files, dict) or not 1 <= len(files) <= MAX_GUARDED_FILES:
        raise GuestError("native handoff guarded-file inventory is absent or unbounded")
    if not {str(path) for path in required}.issubset(files):
        raise GuestError("native handoff omitted a required authority file")
    allowed = (paths.store, paths.state_root, CONTROL, HOST_LEDGER, PACKAGE, SOURCE)
    total = 0
    for value, expected in files.items():
        path = absolute(value)
        if not any(path.is_relative_to(root) for root in allowed):
            raise GuestError("native handoff path is outside bound authorities")
        digest(expected)
        size = path.lstat().st_size
        total += size
        if total > MAX_FILE or file_hash(path) != expected:
            raise GuestError("native authority changed before promotion")


def final_fences(backend, paths, ledger_root):
    stack = ExitStack()
    try:
        stack.enter_context(backend._runtime_build_lock(Path("/build")))
        for path, descriptor in [
            (paths.store / "runtime-services/STARTUP-GATE.lock", b"fullmag.runtime-service-startup-gate.v1\n"),
            (paths.store / "runtime-services/LAUNCH.lock", None),
            (paths.store / "runtime-services/OWNER.lock", b"fullmag.runtime-service-owner.lock.v1\n"),
            (ledger_root / "WRITER.lock", b"fullmag.writer.lock.v1\n"),
            (ledger_root / "HOST_INVENTORY_OWNER.lock", b"fullmag.host-inventory-owner.lock.v1\n"),
            (paths.store / "WRITER.lock", b"fullmag.writer.lock.v1\n"),
        ]:
            stack.enter_context(existing_lock(path, descriptor))
        return stack
    except BaseException:
        stack.close()
        raise


def handoff(request, request_path, guest_pin, resume, api, children, service, backend, paths, stopping):
    observed_resume, resume_raw = read_json(Path(request["resume_intent_path"]))
    if observed_resume != resume:
        raise GuestError("resume intent changed before native preview")
    resume_pin = sha(resume_raw)
    root = validate_resume(resume, request, guest_pin)
    cid, namespace = container_identity()
    if root.get("execution_container_id") != cid or root.get("execution_pid_namespace") != namespace \
            or root.get("diagnostic_api_pid") != api.process.pid or root.get("diagnostic_api_start_token") != api.token \
            or root.get("diagnostic_api_executable_sha256") != request["candidate_api_sha256"]:
        raise GuestError("resume diagnostic process or current namespace differs")
    assert_child(api)
    candidate = Path(request["candidate_path"])
    native = candidate / "bin/fullmag-runtime-service"
    environment = service.process_environment(paths, service=True)
    environment["LD_LIBRARY_PATH"] = str(candidate / "lib") + ":" + environment.get("LD_LIBRARY_PATH", "")
    command = [str(native), "--recover-succeeded-namespace", "--config", request["config_path"],
        "--request", resume["native_request_path"], "--request-sha256", resume["native_request_sha256"],
        "--attestation", root["attestation_path"], "--attestation-sha256", root["attestation_sha256"],
        "--verify-only", "--handoff-preview"]
    process = subprocess.Popen(command, env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    child = own_child(process, native, request["candidate_native_sha256"], children)
    verified = collect_native(child, stopping)
    if not isinstance(verified, dict) or verified.get("status") != "handoff-verified" \
            or verified.get("schema_version") != root["schema_version"] \
            or verified.get("request_sha256") != resume["native_request_sha256"] \
            or verified.get("teardown_request_sha256") != request["teardown_request_sha256"] \
            or verified.get("task_outcome") != "succeeded" or verified.get("process_exit_status") != "unknown" \
            or verified.get("solve_replayed") is not False or verified.get("mutations_applied") is not False:
        raise GuestError("native handoff preview did not verify the exact successful release")
    immutable(Path(request["status_path"]).with_suffix(".native-preview.json"), verified)
    assert_child(api)
    # Drain only this guest's read-only child before acquiring store WRITER.
    stop_child(api)
    config, _ = read_json(Path(request["config_path"]), request["config_sha256"])
    ledger_root = absolute(config.get("host_execution", {}).get("ledger_root"))
    if not ledger_root.is_relative_to(HOST_LEDGER):
        raise GuestError("final handoff ledger is outside the private group mount")
    identity = request["teardown"]["identity"]
    lease = paths.store / "runs" / identity["run_id"] / "resource_leases" / identity["resource_id"] / (identity["lease_token"] + ".json")
    required = [Path(request["config_path"]), Path(resume["native_request_path"]), ledger_root / "HOST_RESOURCE_LEDGER.json",
        paths.store / "runtime-services/OWNER.json", lease]
    with final_fences(backend, paths, ledger_root):
        if stopping.is_set() or container_identity() != (cid, namespace):
            raise GuestError("guest handoff context changed")
        no_other_consumers({os.getpid()})
        forbid_startup(os.environ)
        # Do not reinterpret v3 proof JSON in Python: preserve the native decision's exact snapshot.
        validate_guarded_files(verified.get("handoff_guarded_files"), required, paths)
        read_json(request_path, guest_pin)
        read_json(Path(request["resume_intent_path"]), resume_pin)
        validate_resume(resume, request, guest_pin)
        if file_hash(Path(request["fms_archive_path"])) != request["fms_archive_sha256"]:
            raise GuestError("preserved FMS archive changed")
        image_modules(request)
        _, candidate_receipt = validate_package(request, backend)
        previous, previous_raw, previous_children = backend._validated_package(PACKAGE, "retained previous package", exclude_development_control=True)
        if sha(previous_raw) != request["old_current_receipt_sha256"]:
            raise GuestError("previous package changed under promotion fence")
        control = backend._ensure_package_development_root(PACKAGE)
        rotation = backend._rotate_package(PACKAGE, candidate, control, previous_children, previous_raw, candidate_receipt)
        # No exception path invokes the old runtime. Rotation failures preserve
        # helper recovery evidence and require explicit operator continuation.
        backend._publish_runtime_provenance(PACKAGE)
        backend._validated_package(PACKAGE, "promoted succeeded-namespace package", exclude_development_control=True)
        backend._finalize_published_candidate(candidate, rotation)
        backend._clear_rotation_journal(rotation)
        provenance_path = Path("/opt/fullmag/control/backend/runtime-provenance.json")
        immutable(Path(request["status_path"]).with_suffix(".handoff-committed.json"), {
            "schema":"fullmag.succeeded-namespace-handoff.v1", "guest_request_sha256":guest_pin,
            "execution_container_id":cid, "resume_intent_sha256":resume_pin,
            "native_request_sha256":resume["native_request_sha256"], "native_completion_sha256":resume["native_completion_sha256"],
            "package_receipt_sha256":request["candidate_receipt_sha256"], "provenance_sha256":file_hash(provenance_path, MAX_JSON),
            "fms_archive_sha256":request["fms_archive_sha256"], "solve_replay":False,
        })
        environment = dict(os.environ)
        environment.pop("FULLMAG_API_RUNTIME_FAILURE_FENCE", None)
        forbid_startup(environment)
        # Fences are O_CLOEXEC. They cover promotion and the same-PID exec boundary.
        os.execvpe("/usr/local/bin/python3", ["/usr/local/bin/python3", "-B", "/opt/fullmag/entrypoint.py", "backend"], environment)
        raise GuestError("normal entrypoint exec returned unexpectedly")


def committed_handoff(request, request_path, guest_pin, service, backend, paths):
    """A Docker restart may repeat normal startup, never the recovery operation."""
    record_path = Path(request["status_path"]).with_suffix(".handoff-committed.json")
    if not record_path.exists() and not record_path.is_symlink():
        return False
    record, _ = read_json(record_path)
    fields = {"schema", "guest_request_sha256", "execution_container_id", "resume_intent_sha256",
        "native_request_sha256", "native_completion_sha256", "package_receipt_sha256",
        "provenance_sha256", "fms_archive_sha256", "solve_replay"}
    if set(record) != fields or record["schema"] != "fullmag.succeeded-namespace-handoff.v1" \
            or record["guest_request_sha256"] != guest_pin or record["solve_replay"] is not False \
            or record["package_receipt_sha256"] != request["candidate_receipt_sha256"] \
            or record["fms_archive_sha256"] != request["fms_archive_sha256"]:
        raise GuestError("committed handoff does not match this guest request")
    cid, _ = container_identity()
    if record["execution_container_id"] != cid or cid == request["teardown"]["old_container_id"]:
        raise GuestError("committed handoff belongs to another full container ID")
    config, _ = read_json(Path(request["config_path"]), request["config_sha256"])
    ledger_root = absolute(config.get("host_execution", {}).get("ledger_root"))
    if Path(request["config_path"]) != paths.config or config.get("store_root") != str(paths.store) \
            or not ledger_root.is_relative_to(HOST_LEDGER):
        raise GuestError("committed handoff configuration differs")
    with final_fences(backend, paths, ledger_root):
        no_other_consumers({os.getpid()})
        forbid_startup(os.environ)
        read_json(request_path, guest_pin)
        resume, _ = read_json(Path(request["resume_intent_path"]), record["resume_intent_sha256"])
        validate_resume(resume, request, guest_pin)
        if resume["native_request_sha256"] != record["native_request_sha256"] \
                or resume["native_completion_sha256"] != record["native_completion_sha256"]:
            raise GuestError("committed native completion pins changed")
        receipt, raw, _ = backend._validated_package(PACKAGE, "committed namespace package", exclude_development_control=True)
        if sha(raw) != request["candidate_receipt_sha256"] \
                or receipt.get("source", {}).get("source_snapshot_sha256") != request["source_snapshot_sha256"] \
                or file_hash(PACKAGE / "bin/fullmag-api") != request["candidate_api_sha256"] \
                or file_hash(PACKAGE / "bin/fullmag-runtime-service") != request["candidate_native_sha256"] \
                or file_hash(Path("/opt/fullmag/control/backend/runtime-provenance.json"), MAX_JSON) != record["provenance_sha256"] \
                or file_hash(Path(request["fms_archive_path"])) != request["fms_archive_sha256"]:
            raise GuestError("committed promoted package, provenance, or archive changed")
        # Complete a possibly interrupted publication before admitting work.
        # immutable() refuses different bytes and fsyncs both file and parent.
        immutable(record_path, record)
        # The PID namespace may change on Docker restart. Ordinary startup uses
        # the promoted v3 reader; historical recovery is never re-executed.
        environment = dict(os.environ)
        environment.pop("FULLMAG_API_RUNTIME_FAILURE_FENCE", None)
        os.execvpe("/usr/local/bin/python3", ["/usr/local/bin/python3", "-B", "/opt/fullmag/entrypoint.py", "backend"], environment)
        raise GuestError("committed normal entrypoint exec returned unexpectedly")


def diagnostic_fence_path(service, paths, request_id):
    parent = service.process_receipt_path(paths).parent
    path = parent / ("api-failure-succeeded-namespace-" + request_id + ".json")
    # Match the native diagnostic_fence authority, not a similarly named
    # verification/control file. Never rewrite OWNER or process-tree evidence.
    if not path.is_relative_to(Path("/opt/fullmag/runtime-control")):
        raise GuestError("diagnostic API fence is outside the native runtime-control authority")
    return path


def run(request_path, guest_pin):
    if os.name != "posix" or os.getpid() != 1:
        raise GuestError("namespace recovery guest must be the Linux backend PID1")
    forbid_startup(os.environ)
    request_path = control_path(str(request_path))
    request, _ = read_json(request_path, guest_pin)
    validate_request(request, request_path)
    service, backend = image_modules(request)
    paths = service.canonical_paths()
    committed_handoff(request, request_path, guest_pin, service, backend, paths)
    status_path = Path(request["status_path"])
    started_path = status_path.with_suffix(".started.json")
    if started_path.exists() or started_path.is_symlink() or status_path.exists() or status_path.is_symlink():
        raise GuestError("this guest operation was already attempted; no automatic retry")
    immutable(started_path, {"schema":"fullmag.succeeded-namespace-guest-start.v1", "guest_request_sha256":guest_pin,
        "pid":os.getpid(), "start_token":start_token(os.getpid())})
    if Path(request["config_path"]) != paths.config:
        raise GuestError("guest configuration is not canonical")
    config, _ = read_json(paths.config, request["config_sha256"])
    if config.get("store_root") != str(paths.store):
        raise GuestError("guest store differs from canonical configuration")
    if file_hash(Path(request["fms_archive_path"])) != request["fms_archive_sha256"]:
        raise GuestError("preserved FMS archive changed")
    validate_package(request, backend)
    no_other_consumers({os.getpid()})
    fence = diagnostic_fence_path(service, paths, request["request_id"])
    fence_sha = immutable(fence, {"schema":"fullmag.api-runtime-failure-fence.v1", "stage":"runtime_startup",
        "reason":"Explicit succeeded-worker namespace recovery; runtime ownership and all execution remain blocked.",
        "next_action":"Await the pinned native release and explicit resume intent. No Solve is replayed."})
    environment = service.process_environment(paths)
    environment["FULLMAG_API_RUNTIME_FAILURE_FENCE"] = str(fence)
    candidate = Path(request["candidate_path"])
    environment["LD_LIBRARY_PATH"] = str(candidate / "lib") + ":" + environment.get("LD_LIBRARY_PATH", "")
    stopping = threading.Event()
    for number in (signal.SIGTERM, signal.SIGINT):
        signal.signal(number, lambda *_: stopping.set())
    children = []
    try:
        executable = candidate / "bin/fullmag-api"
        api = own_child(subprocess.Popen([str(executable)], env=environment, stdin=subprocess.DEVNULL),
            executable, request["candidate_api_sha256"], children)
        cid, namespace = container_identity()
        immutable(status_path, {"schema":"fullmag.succeeded-namespace-guest-status.v1", "state":"diagnostic_api",
            "guest_request_sha256":guest_pin, "execution_container_id":cid, "execution_pid_namespace":namespace,
            "diagnostic_api_pid":api.process.pid, "diagnostic_api_start_token":api.token,
            "diagnostic_api_executable_sha256":api.executable_sha256, "diagnostic_api_failure_fence":str(fence),
            "diagnostic_api_failure_fence_sha256":fence_sha, "solve_replay":False})
        while not stopping.wait(1):
            assert_child(api)
            resume_path = Path(request["resume_intent_path"])
            if resume_path.exists() or resume_path.is_symlink():
                resume, _ = read_json(resume_path)
                handoff(request, request_path, guest_pin, resume, api, children, service, backend, paths, stopping)
                raise GuestError("handoff returned without exec")
        return 0
    finally:
        # PID1 must not exit with an unconfirmed owned child: Linux would then
        # kill namespace descendants implicitly. Preserve the failed operation
        # and wait for actual termination, with no SIGKILL or process restart.
        for child in reversed(children):
            try:
                stop_child(child)
            except Exception:
                while child.process.poll() is None:
                    time.sleep(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--request-sha256", required=True)
    args = parser.parse_args()
    try:
        return run(args.request, digest(args.request_sha256))
    except Exception as error:
        reason = str(error) if isinstance(error, GuestError) else type(error).__name__
        print("succeeded namespace guest refused: " + reason, file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
