"""Managed admission and Engine evidence for one succeeded worker with unknown OS exit."""
from __future__ import annotations

import argparse
from contextlib import ExitStack, contextmanager
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import time
import uuid

from docker_build_control import BuildControl, BuildControlError, canonical, docker_capture

STOP_SCHEMA = "fullmag.succeeded-namespace-stop-request.v1"
STOP_PROOF_SCHEMA = "fullmag.succeeded-namespace-kernel-stop.v1"
MAX_BYTES = 8 * 1024 * 1024
MAX_FILES = 10000
SHA = re.compile(r"[0-9a-f]{64}")
STOP_FIELDS = {"schema", "request_id", "source_root", "compose_project", "backend", "frontend", "teardown",
               "process_receipt_sha256", "owner_sha256", "processes", "lease_heartbeat_sequence", "documents",
               "archive", "stop_timeout_seconds"}


def require(value, message):
    if not value:
        raise BuildControlError(message)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def strict_json(raw):
    require(0 < len(raw) <= MAX_BYTES, "Recovery JSON exceeds its positive bound")
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "Duplicate recovery field")
            result[key] = value
        return result
    value = json.loads(raw, object_pairs_hook=pairs,
                       parse_constant=lambda _: require(False, "Non-finite recovery number"))
    require(isinstance(value, dict), "Recovery JSON must be an object")
    return value


def regular(path, maximum=MAX_BYTES, *, allow_empty=False):
    path = Path(path)
    require(path.is_absolute() and ".." not in path.parts, "Absolute normalized evidence path required")
    require(not any(p.is_symlink() for p in (path, *path.parents)), "Evidence alias refused")
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
                and (0 <= before.st_size if allow_empty else 0 < before.st_size) and before.st_size <= maximum,
                "Evidence is not one bounded regular file")
        raw = stream.read(maximum + 1)
        after = os.fstat(stream.fileno())
        current = path.stat()
        identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        require(len(raw) == before.st_size and identity(before) == identity(after) == identity(current),
                "Evidence changed during read")
        return raw


@contextmanager
def kernel_lock(path, *, timeout_seconds=0):
    import fcntl
    path = Path(path)
    require(not any(p.is_symlink() for p in (path, *path.parents)), "Lock alias refused")
    fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1, "Unsafe lock inode")
        require(0 <= timeout_seconds <= 5, "Kernel lock wait exceeds its bound")
        deadline = time.monotonic() + timeout_seconds
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(min(0.05, max(0, deadline - time.monotonic())))
        current = path.stat()
        require((before.st_dev, before.st_ino) == (current.st_dev, current.st_ino), "Lock inode changed")
        yield
        current = path.stat()
        require((before.st_dev, before.st_ino) == (current.st_dev, current.st_ino), "Lock inode changed")
    finally:
        os.close(fd)


def validate_stop_request(request):
    require(isinstance(request, dict) and set(request) == STOP_FIELDS and request["schema"] == STOP_SCHEMA,
            "Unsupported succeeded namespace stop request")
    identifier = uuid.UUID(request["request_id"])
    require(identifier.int and str(identifier) == request["request_id"], "Canonical request UUID required")
    core = request["teardown"]
    require(isinstance(core, dict) and core.get("schema_version") == "host_succeeded_worker_namespace_teardown_request.v1"
            and core.get("request_id") == request["request_id"], "Teardown core identity differs")
    require(core.get("compose_project") == request["compose_project"]
            and core.get("old_container_id") == request["backend"].get("container_id")
            and core.get("old_image_id") == request["backend"].get("image_id")
            and core.get("original_owner_sha256") == request["owner_sha256"], "Original namespace/owner binding differs")
    for name in ("backend", "frontend"):
        pin = request[name]
        require(isinstance(pin, dict) and set(pin) == {"container_id", "image_id", "started_at", "fingerprint"}
                and SHA.fullmatch(pin["container_id"]) and SHA.fullmatch(pin["fingerprint"])
                and re.fullmatch(r"sha256:[0-9a-f]{64}", pin["image_id"])
                and isinstance(pin["started_at"], str) and pin["started_at"], "Incomplete service incarnation pin")
    require(request["backend"]["container_id"] != request["frontend"]["container_id"], "Backend/frontend collision")
    require(all(SHA.fullmatch(request[k]) for k in ("process_receipt_sha256", "owner_sha256")), "Missing native source pin")
    require(type(request["stop_timeout_seconds"]) is int and 1 <= request["stop_timeout_seconds"] <= 60,
            "Stop deadline must be within 1..60 seconds")
    require(type(request["lease_heartbeat_sequence"]) is int and request["lease_heartbeat_sequence"] >= 0,
            "Invalid heartbeat sequence")
    pins = request["processes"]
    require(isinstance(pins, list) and len(pins) == 3 and {p.get("role") for p in pins} == {"owner", "compute", "preparation"},
            "Three exact native process pins required")
    for pin in pins:
        require(set(pin) == {"role", "pid", "start_token", "executable_sha256"}
                and type(pin["pid"]) is int and pin["pid"] > 1
                and re.fullmatch(r"linux-starttime-[0-9]+", pin["start_token"])
                and SHA.fullmatch(pin["executable_sha256"]), "Incomplete native PID/start/executable pin")
    require(len({pin["pid"] for pin in pins}) == 3, "Repeated native process identity")
    require(isinstance(request["documents"], dict) and 0 < len(request["documents"]) <= MAX_FILES
            and all(isinstance(k, str) and SHA.fullmatch(v) for k, v in request["documents"].items()),
            "Complete bounded raw document pins required")
    archive = request["archive"]
    require(isinstance(archive, dict) and set(archive) == {"path", "sha256"} and SHA.fullmatch(archive["sha256"]),
            "Preserved authoring archive pin required")
    return request


def stream_sha(stream):
    value = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        value.update(chunk)
    return value.hexdigest()


def process_identity(pid):
    root = Path("/proc") / str(pid)
    try:
        fields = (root / "stat").read_text().rsplit(")", 1)[1].split()
        if fields[0] == "Z":
            return None
        # /proc stat field 22; field 3 is the first token after comm.
        token = "linux-starttime-" + fields[19]
        executable = (root / "exe").resolve(strict=True)
        with executable.open("rb") as stream:
            sha = stream_sha(stream)
        again = (root / "stat").read_text().rsplit(")", 1)[1].split()
        require(again[19] == fields[19], "Native process changed during observation")
        if again[0] == "Z":
            return None
        return {"pid": pid, "start_token": token, "executable_sha256": sha}
    except (FileNotFoundError, ProcessLookupError):
        return None


def no_foreign_native_processes(request, api_pid):
    allowed = {api_pid, *(pin["pid"] for pin in request["processes"])}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit() or int(entry.name) in allowed:
            continue
        try:
            fields = (entry / "stat").read_text().rsplit(")", 1)[1].split()
            if fields[0] == "Z":
                continue
            command = (entry / "cmdline").read_bytes().split(b"\0")
            executable = Path(os.fsdecode(command[0])).name
        except (FileNotFoundError, ProcessLookupError):
            continue
        require(not executable.startswith("fullmag") and executable not in
                {"cargo", "rustc", "make", "cmake", "ninja", "nvcc", "cc1", "cc1plus"},
                "Another native consumer or compiler is alive")


def require_processes(request):
    for pin in request["processes"]:
        require(process_identity(pin["pid"]) == {k: pin[k] for k in ("pid", "start_token", "executable_sha256")},
                "Native PID/start/executable identity changed")


def file_sha(path, maximum=512 * 1024 * 1024):
    path = Path(path)
    require(path.is_absolute() and ".." not in path.parts
            and not any(p.is_symlink() for p in (path, *path.parents)), "Unsafe evidence file")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 <= before.st_size <= maximum,
                "Unbounded or aliased evidence file")
        sha = stream_sha(stream)
        after = os.fstat(stream.fileno())
        now = path.stat()
        identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        require(identity(before) == identity(after) == identity(now), "Evidence changed while hashing")
        return sha


def raw_inventory(root):
    result = {}
    root = Path(root)
    require(root.is_dir() and not any(p.is_symlink() for p in (root, *root.parents)), "Unsafe run inventory root")
    total = 0
    for directory, directories, files in os.walk(root, followlinks=False):
        for name in directories:
            require(not (Path(directory) / name).is_symlink(), "Run inventory directory alias refused")
        for name in files:
            require(len(result) < MAX_FILES, "Run inventory exceeds bound")
            path = Path(directory) / name
            total += path.lstat().st_size
            require(total <= 512 * 1024 * 1024, "Run inventory byte budget exceeded")
            result[str(path)] = file_sha(path)
    return result


def validate_worker_evidence(request, paths):
    """Verify raw snapshots under host->store locks; no release authority is produced."""
    core = request["teardown"]
    identity = core["identity"]
    claim = {k: identity[k] for k in ("run_id", "task_id", "lease_token")}
    claim.update(attempt_id=identity["owner"]["attempt_id"], ownership_epoch=identity["owner"]["ownership_epoch"])
    root = paths.store / "runs" / claim["run_id"]
    observed = raw_inventory(root)
    pinned = {path: pin for path, pin in request["documents"].items() if Path(path).is_relative_to(root)}
    require(observed == pinned, "Complete run inventory changed or contains omitted documents")
    for path, pin in request["documents"].items():
        require(Path(path).is_relative_to(paths.store) or Path(path).is_relative_to(Path("/opt/fullmag/control")),
                "Document pin escaped private store/control")
        require(file_sha(path) == pin, "Pinned raw document changed")
    def read(path):
        require(str(path) in request["documents"], "Unpinned run document")
        return strict_json(regular(path))
    catalog = read(root / "run_catalog.json")
    require(catalog.get("revision") == core["catalog_revision"] and catalog.get("tasks") == [core["expected_task"]]
            and core["expected_task"].get("lifecycle") == "succeeded", "Exact succeeded catalog required")
    for path in (paths.store / "runs").glob("*/run_catalog.json"):
        other = strict_json(regular(path))
        require(all(task.get("lifecycle") in {"succeeded", "failed", "cancelled"} for task in other.get("tasks", [])),
                "Another accepted task is not terminal")
    exits = root / "worker_process_exit_receipts"
    require(not exits.exists() or (exits.is_dir() and not any(exits.iterdir())), "An existing exit receipt requires its ordinary recovery")
    lease = read(root / "resource_leases" / identity["resource_id"] / (claim["lease_token"] + ".json"))
    require(digest(canonical(lease)) == core["lease_before_sha256"]
            and all(lease.get(k) == v for k, v in claim.items()) and lease.get("state") == "active"
            and lease.get("heartbeat_sequence") == request["lease_heartbeat_sequence"], "Exact active local lease required")
    inboxes = list((root / "worker_inbox").glob("*.json"))
    require(len(inboxes) == 1, "Exactly one settled worker inbox required")
    def payload(document):
        body = document["payload"]
        require(digest(canonical(body)) == document.get("payload_sha256"), "Journal/inbox payload integrity changed")
        return body
    inbox = payload(read(inboxes[0]))
    require(inbox.get("pending") is None and inbox.get("claim") is not None
            and all(inbox["claim"].get(k) == v for k, v in claim.items()), "Inbox is pending or belongs to another claim")
    streams = {}
    for direction in ("command", "event"):
        rows = [read(path) for path in (root / "coordinator_journal" / direction).glob("*.json")]
        rows.sort(key=lambda row: row["sequence"])
        require(rows and [row["sequence"] for row in rows] == list(range(1, len(rows) + 1)), "Journal sequence is not complete")
        envelopes = []
        for row in rows:
            require(all(row.get(k) == v for k, v in claim.items()) and row.get("direction") == direction,
                    "Journal claim/direction changed")
            envelope = payload(row)["message"]["envelope"]
            require(envelope["sequence"] == row["sequence"] and envelope["message_id"] == row["entry_id"]
                    and all(envelope["claim"].get(k) == v for k, v in claim.items()), "Journal envelope differs")
            envelopes.append(envelope)
        streams[direction] = (rows, envelopes)
    commands, command_envelopes = streams["command"]
    events, event_envelopes = streams["event"]
    require(digest(canonical({"commands": command_envelopes, "events": event_envelopes})) == core["journal_sha256"]
            and digest(canonical(inbox)) == core["inbox_sha256"]
            and inbox.get("schema_version") == "worker_inbox.v1"
            and inbox.get("applied") == command_envelopes
            and sum(e["command"]["kind"] == "start" for e in command_envelopes) == 1
            and events[-1].get("terminal") is True and not any(row.get("terminal") for row in events[:-1])
            and event_envelopes[-1]["event"]["kind"] == "completed"
            and payload(events[-1])["checkpoint"]["task"]["lifecycle"] == "succeeded",
            "Applied inbox and terminal Completed journal differ")
    attempt = root / "worker-attempts" / claim["task_id"] / claim["attempt_id"] / ("epoch-" + str(claim["ownership_epoch"]))
    for name, key in (("worker_execution_started.v1.json", "execution_started_sha256"),
                      ("worker_execution_completed.v1.json", "execution_completed_sha256")):
        require(digest(regular(attempt / name)) == core[key], "Started/Completed receipt differs")
    artifacts = read(root / "artifact_catalog.json")
    entries = artifacts.get("entries")
    require(isinstance(entries, list) and len(entries) == 2
            and digest(canonical(entries)) == core["artifacts_sha256"]
            and {entry.get("artifact_id") for entry in entries} == set(core["expected_task"]["artifact_ids"]),
            "Complete accepted artifact catalog differs")
    manifests = [entry for entry in entries if entry.get("artifact_type") == "study_output_manifest"]
    require(len(manifests) == 1, "Exactly one accepted output manifest required")
    for entry in entries:
        require(all(entry.get(k) == claim[k] for k in ("task_id", "attempt_id", "ownership_epoch"))
                and entry.get("status") == "published" and entry.get("required") is True
                and entry.get("content_sha256") == entry.get("object_ref")
                and SHA.fullmatch(entry["object_ref"]), "Accepted artifact ownership differs")
        object_path = paths.store / "objects" / "sha256" / entry["object_ref"]
        require(str(object_path) in request["documents"] and file_sha(object_path) == entry["object_ref"],
                "Published accepted artifact CAS differs")
    manifest = read(paths.store / "objects" / "sha256" / manifests[0]["object_ref"])
    output = next(entry for entry in entries if entry is not manifests[0])
    outputs = manifest.get("outputs", [])
    require(manifest.get("schema_version") == "study_output_manifest.v3"
            and all(manifest.get(k) == claim[k] for k in ("run_id", "task_id", "attempt_id", "ownership_epoch"))
            and len(outputs) == 1 and outputs[0].get("codec_id") == "fullmag.antenna.closed_loop_bundle"
            and outputs[0].get("codec_version") == "v1"
            and all(outputs[0].get(k) == output.get(k) for k in ("artifact_id", "object_ref", "content_sha256")),
            "Accepted closed-loop publication manifest differs")
    ledger_path = Path(os.environ["FULLMAG_HOST_LEDGER_ROOT"]) / "HOST_RESOURCE_LEDGER.json"
    ledger = strict_json(regular(ledger_path))
    outstanding = [r for r in ledger["reservations"] if r.get("state") != "released"]
    require(len(outstanding) == 1 and outstanding[0].get("state") == "committed"
            and outstanding[0].get("identity") == identity
            and outstanding[0].get("worker_launch_gate") == {"state": "consumed", "token": core["worker_launch_token"]}
            and outstanding[0].get("runtime_generation_sha256") == core["runtime_generation_sha256"]
            and digest(canonical(outstanding[0])) == core["reservation_before_sha256"],
            "Another consumer or changed committed consumed reservation exists")
    require(digest(regular(request["archive"]["path"], 64 * 1024 * 1024)) == request["archive"]["sha256"],
            "Authoring FMS changed")
    return {"run_files": len(observed), "ledger_sha256": digest(regular(ledger_path)),
            "run_inventory_sha256": digest(canonical(observed)), "reservation_released": False}


def immutable_bytes(path, raw):
    path = Path(path)
    require(not any(p.is_symlink() for p in (path, *path.parents)), "Recovery publication alias refused")
    if path.exists():
        require(regular(path, max(MAX_BYTES, len(raw)), allow_empty=True) == raw, "Recovery publication replay differs")
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        return
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def immutable_write(path, value):
    immutable_bytes(path, canonical(value) + b"\n")


def observe_terminated(processes, timeout):
    deadline = time.monotonic() + timeout
    while True:
        alive = False
        for pin in processes:
            observed = process_identity(pin["pid"])
            if observed is not None:
                require(observed == {k: pin[k] for k in ("pid", "start_token", "executable_sha256")},
                        "A stopped PID was reused; outcome is unknown")
                alive = True
        if not alive:
            return
        require(time.monotonic() < deadline, "Native SIGTERM deadline exceeded; no escalation authorized")
        time.sleep(0.05)


def same_owner_with_monotonic_heartbeat(original, current):
    from datetime import datetime
    require(isinstance(original, dict) and isinstance(current, dict)
            and set(original) == set(current), "Native owner fields changed")
    before, after = original.get("heartbeat_at"), current.get("heartbeat_at")
    require(isinstance(before, str) and isinstance(after, str), "Native heartbeat timestamp is missing")
    def timestamp(value):
        match = re.fullmatch(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})", value)
        require(match is not None, "Native heartbeat is not a bounded RFC3339 timestamp")
        seconds = datetime.fromisoformat(match[1] + match[3].replace("Z", "+00:00"))
        return seconds, int((match[2] or "").ljust(9, "0"))
    require(timestamp(after) >= timestamp(before), "Native owner heartbeat moved backwards")
    require({key: value for key, value in original.items() if key != "heartbeat_at"}
            == {key: value for key, value in current.items() if key != "heartbeat_at"},
            "Native owner identity or state changed")


def guest_snapshot(seed):
    """Capture current evidence; never signal, build, accept a run or change the ledger."""
    import sys
    sys.path.insert(0, "/opt/fullmag")
    import runtime_service as runtime
    fields = {"schema", "request_id", "source_root", "compose_project", "backend", "frontend", "archive",
              "expected_run_id", "expected_task_id", "docker_engine_id_sha256", "private_volume_name", "stop_timeout_seconds"}
    require(set(seed) == fields and seed["schema"] == "fullmag.succeeded-namespace-snapshot-seed.v1",
            "Unsupported recovery snapshot seed")
    paths = runtime.canonical_paths()
    services = runtime.runtime_services_root(paths)
    with ExitStack() as fences:
        fences.enter_context(kernel_lock(services / "STARTUP-GATE.lock"))
        fences.enter_context(kernel_lock(services / "LAUNCH.lock"))
        fences.enter_context(kernel_lock(Path(os.environ["FULLMAG_HOST_LEDGER_ROOT"]) / "WRITER.lock", timeout_seconds=5))
        fences.enter_context(kernel_lock(paths.store / "WRITER.lock", timeout_seconds=5))
        owner_path, process_path = services / "OWNER.json", runtime.process_receipt_path(paths)
        owner_raw, process_raw = regular(owner_path), regular(process_path)
        owner, process = strict_json(owner_raw), strict_json(process_raw)
        require(owner.get("state") == "ready" and process.get("state") == "ready", "Original Ready owner/API snapshot required")
        ledger = strict_json(regular(Path(os.environ["FULLMAG_HOST_LEDGER_ROOT"]) / "HOST_RESOURCE_LEDGER.json"))
        outstanding = [row for row in ledger["reservations"] if row.get("state") != "released"]
        require(len(outstanding) == 1 and outstanding[0].get("state") == "committed", "Exactly one committed reservation required")
        reservation = outstanding[0]
        identity = reservation["identity"]
        require(identity.get("run_id") == seed["expected_run_id"] and identity.get("task_id") == seed["expected_task_id"],
                "Snapshot belongs to another run/task")
        root = paths.store / "runs" / identity["run_id"]
        catalog = strict_json(regular(root / "run_catalog.json"))
        require(len(catalog["tasks"]) == 1 and catalog["tasks"][0].get("lifecycle") == "succeeded", "One succeeded task required")
        task = catalog["tasks"][0]
        lease_path = root / "resource_leases" / identity["resource_id"] / (identity["lease_token"] + ".json")
        lease = strict_json(regular(lease_path))
        attempt = root / "worker-attempts" / task["task_id"] / task["attempt_id"] / ("epoch-" + str(task["ownership_epoch"]))
        streams = {}
        for direction in ("command", "event"):
            rows = [strict_json(regular(path)) for path in (root / "coordinator_journal" / direction).glob("*.json")]
            rows.sort(key=lambda row: row["sequence"])
            streams[direction] = [row["payload"]["message"]["envelope"] for row in rows]
        inbox_paths = list((root / "worker_inbox").glob("*.json"))
        require(len(inbox_paths) == 1, "One worker inbox required")
        inbox = strict_json(regular(inbox_paths[0]))["payload"]
        artifacts = strict_json(regular(root / "artifact_catalog.json"))
        provenance = strict_json(regular("/opt/fullmag/control/backend/runtime-provenance.json"))
        core = {"schema_version": "host_succeeded_worker_namespace_teardown_request.v1", "request_id": seed["request_id"],
                "identity": identity, "host_id": reservation["host_id"], "reservation_request_sha256": reservation["request_sha256"],
                "reservation_before_sha256": digest(canonical(reservation)), "lease_before_sha256": digest(canonical(lease)),
                "runtime_generation_sha256": reservation["runtime_generation_sha256"],
                "worker_launch_token": reservation["worker_launch_gate"]["token"], "expected_task": task, "catalog_revision": catalog["revision"],
                "journal_sha256": digest(canonical({"commands": streams["command"], "events": streams["event"]})),
                "inbox_sha256": digest(canonical(inbox)),
                "execution_started_sha256": digest(regular(attempt / "worker_execution_started.v1.json")),
                "execution_completed_sha256": digest(regular(attempt / "worker_execution_completed.v1.json")),
                "artifacts_sha256": digest(canonical(artifacts["entries"])), "config_sha256": digest(regular(paths.config)),
                "original_owner_sha256": digest(owner_raw), "producer_source_snapshot_sha256": provenance["source_snapshot_sha256"],
                "producer_package_receipt_sha256": digest(regular("/opt/fullmag/package/backend-build-receipt.json")),
                "docker_engine_id_sha256": seed["docker_engine_id_sha256"], "old_container_id": seed["backend"]["container_id"],
                "old_image_id": seed["backend"]["image_id"], "compose_project": seed["compose_project"],
                "private_volume_name": seed["private_volume_name"], "pid_namespace": os.readlink("/proc/self/ns/pid"),
                "boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
                "cgroup_sha256": digest(Path("/proc/self/cgroup").read_bytes())}
        processes = []
        for role, pid in [("owner", owner["pid"]), *[(child["role"], child["pid"]) for child in owner["children"]]]:
            observed = process_identity(pid)
            require(observed is not None, "Snapshot native process is already absent")
            processes.append({"role": role, **observed})
        documents = raw_inventory(root)
        for entry in artifacts["entries"]:
            path = paths.store / "objects/sha256" / entry["object_ref"]
            documents[str(path)] = file_sha(path)
        # Live owner/process descriptors may legitimately change during SIGTERM;
        # they have independent original pins and are archived before signalling.
        slots = paths.store / "supervisor-slots"
        if slots.exists():
            documents.update(raw_inventory(slots))
        request = {"schema": STOP_SCHEMA, **{key: seed[key] for key in
                   ("request_id", "source_root", "compose_project", "backend", "frontend", "archive", "stop_timeout_seconds")},
                   "teardown": core, "process_receipt_sha256": digest(process_raw), "owner_sha256": digest(owner_raw),
                   "processes": processes, "lease_heartbeat_sequence": lease["heartbeat_sequence"], "documents": documents}
        validate_stop_request(request)
        validate_worker_evidence(request, paths)
        no_foreign_native_processes(request, process["api_pid"])
        same_owner_with_monotonic_heartbeat(owner, strict_json(regular(owner_path)))
        require(regular(process_path) == process_raw, "Native API receipt changed during snapshot")
        archive = Path("/opt/fullmag/control/verification/succeeded-namespace-recovery-20261104/requests") / request["request_id"]
        archive.mkdir(mode=0o750, parents=True, exist_ok=True)
        immutable_bytes(archive / "original-owner.json", owner_raw)
        immutable_bytes(archive / "original-process-tree.json", process_raw)
        return request


def guest_stop(request, request_sha, result_path, apply=False):
    import signal
    import sys
    sys.path.insert(0, "/opt/fullmag")
    import runtime_service as runtime
    validate_stop_request(request)
    require(digest(canonical(request) + b"\n") == request_sha, "Stop request SHA differs")
    paths = runtime.canonical_paths()
    services = runtime.runtime_services_root(paths)
    require(request["compose_project"] == os.environ["FULLMAG_COMPOSE_PROJECT"]
            and request["source_root"] == os.environ["FULLMAG_SOURCE_HOST_ROOT"], "Stop source/group differs")
    completed_path = Path(result_path)
    if apply and completed_path.exists():
        completed = strict_json(regular(completed_path))
        require(completed.get("schema") == STOP_PROOF_SCHEMA and completed.get("request_sha256") == request_sha
                and completed.get("state") == "native-processes-terminated"
                and all(process_identity(pin["pid"]) is None for pin in request["processes"]),
                "Completed stop replay pins or dead processes differ")
        with ExitStack() as replay_fences:
            replay_fences.enter_context(kernel_lock(services / "STARTUP-GATE.lock"))
            replay_fences.enter_context(kernel_lock(services / "LAUNCH.lock"))
            replay_fences.enter_context(kernel_lock(Path(os.environ["FULLMAG_HOST_LEDGER_ROOT"]) / "WRITER.lock", timeout_seconds=5))
            replay_fences.enter_context(kernel_lock(paths.store / "WRITER.lock"))
            require(validate_worker_evidence(request, paths) == completed["evidence"], "Completed stop evidence changed")
            require(digest(regular(services / "OWNER.json")) == completed["post_stop_owner_sha256"], "Post-stop owner changed")
        return completed
    core = request["teardown"]
    require(os.readlink("/proc/self/ns/pid") == core["pid_namespace"]
            and Path("/proc/sys/kernel/random/boot_id").read_text().strip() == core["boot_id"]
            and digest(Path("/proc/self/cgroup").read_bytes()) == core["cgroup_sha256"],
            "Original kernel namespace/boot/cgroup differs")
    config = strict_json(regular(paths.config))
    require(digest(regular(paths.config)) == core["config_sha256"] and config.get("store_root") == str(paths.store),
            "Original service config/store differs")
    provenance = strict_json(regular("/opt/fullmag/control/backend/runtime-provenance.json"))
    require(provenance.get("source_snapshot_sha256") == core["producer_source_snapshot_sha256"]
            and digest(regular("/opt/fullmag/package/backend-build-receipt.json")) == core["producer_package_receipt_sha256"],
            "Original producer package/source differs")
    with ExitStack() as fences:
        # Same kernel locks as native startup, launch and host->store transactions.
        fences.enter_context(kernel_lock(services / "STARTUP-GATE.lock"))
        fences.enter_context(kernel_lock(services / "LAUNCH.lock"))
        fences.enter_context(kernel_lock(Path(os.environ["FULLMAG_HOST_LEDGER_ROOT"]) / "WRITER.lock", timeout_seconds=5))
        with kernel_lock(paths.store / "WRITER.lock"):
            original_owner_raw = regular(Path(result_path).with_name("original-owner.json"))
            require(digest(original_owner_raw) == request["owner_sha256"], "Archived original owner changed")
            owner_raw = regular(services / "OWNER.json")
            owner = strict_json(owner_raw)
            same_owner_with_monotonic_heartbeat(strict_json(original_owner_raw), owner)
            require(owner.get("state") == "ready", "Exact original Ready owner required")
            expected = {"owner": owner["pid"], **{c["role"]: c["pid"] for c in owner["children"]}}
            require(expected == {p["role"]: p["pid"] for p in request["processes"]}, "Native process ownership differs")
            require(digest(regular(runtime.process_receipt_path(paths))) == request["process_receipt_sha256"],
                    "Original process receipt changed")
            process = strict_json(regular(runtime.process_receipt_path(paths)))
            no_foreign_native_processes(request, process["api_pid"])
            evidence = validate_worker_evidence(request, paths)
            require_processes(request)
            result = {"schema": STOP_PROOF_SCHEMA, "request_sha256": request_sha, "state": "preview-passed",
                      "evidence": evidence, "processes": request["processes"], "stop_signal": "SIGTERM",
                      "stop_escalated": False, "reservation_released": False, "solve_replay": False}
            if not apply:
                return result
            for name, raw in (("pre-stop-owner.json", owner_raw),
                              ("original-process-tree.json", regular(runtime.process_receipt_path(paths))),
                              ("producer-backend-build-receipt.json", regular("/opt/fullmag/package/backend-build-receipt.json")),
                              ("original-runtime-config.json", regular(paths.config))):
                immutable_bytes(Path(result_path).with_name(name), raw)
            intent_path = Path(result_path).with_name("kernel-stop-intent.json")
            require(not intent_path.exists(), "Interrupted stop intent requires observation recovery; signals are not automatically repeated")
            immutable_write(intent_path, result)
        # The writer fence is released so terminal metadata may be published. The
        # host admission, startup and launch fences remain held through observation.
        for pin in request["processes"]:
            identity = process_identity(pin["pid"])
            if identity is None:
                continue
            require(identity == {k: pin[k] for k in ("pid", "start_token", "executable_sha256")},
                    "Native process changed immediately before SIGTERM")
            os.kill(pin["pid"], signal.SIGTERM)
        observe_terminated(request["processes"], request["stop_timeout_seconds"])
        with kernel_lock(paths.store / "WRITER.lock"):
            require(validate_worker_evidence(request, paths) == evidence, "Protected evidence changed during stop")
        result.update(state="native-processes-terminated", process_exit_status="unknown",
                      original_owner_sha256=request["owner_sha256"],
                      post_stop_owner_sha256=digest(regular(services / "OWNER.json")),
                      post_stop_process_receipt_sha256=digest(regular(runtime.process_receipt_path(paths))))
        immutable_write(result_path, result)
        return result


def namespace_diagnostic_api(process, paths, stop_proof_path):
    import urllib.request
    import sys
    sys.path.insert(0, "/opt/fullmag")
    import runtime_service as runtime
    original = strict_json(regular(Path(stop_proof_path).with_name("original-process-tree.json")))
    require(process.get("service_owner") == original.get("service_owner"), "Diagnostic API changed original service owner")
    pid = process["api_pid"]
    api = Path("/proc") / str(pid)
    expected = Path("/opt/fullmag/package/bin/fullmag-api")
    require((api / "exe").resolve(strict=True) == expected and process_identity(pid) is not None,
            "Diagnostic API executable or process differs")
    fence = Path(process.get("api_failure_fence", ""))
    require(fence.parent == runtime.process_receipt_path(paths).parent
            and re.fullmatch(r"api-failure-[0-9a-f]{32}\.json", fence.name), "Diagnostic API fence path differs")
    raw = regular(fence)
    document = strict_json(raw)
    require(document.get("schema") == "fullmag.api-runtime-failure-fence.v1"
            and document.get("stage") == "runtime_supervision" and document.get("api_pid") == pid,
            "Diagnostic API fence identity differs")
    instance = document.get("api_instance_id")
    require(isinstance(instance, str) and str(uuid.UUID(instance)) == instance, "Diagnostic API incarnation differs")
    require(("FULLMAG_API_RUNTIME_FAILURE_FENCE=" + str(fence)).encode()
            in (api / "environ").read_bytes().split(b"\0"), "Diagnostic API environment is not fenced")
    with urllib.request.urlopen("http://127.0.0.1:8081/v2/platform/health", timeout=5) as response:
        health = strict_json(response.read(256 * 1024))
        require(response.status == 200 and health.get("status") == "degraded"
                and response.headers.get("x-fullmag-api-instance") == instance, "Diagnostic API health or incarnation differs")
    return {str(fence): digest(raw)}


def namespace_build_evidence(request, paths, process, owner):
    """Explicit new build kind; the legacy exit-receipt admission is unchanged."""
    proof_raw = regular(request["succeeded_worker_proof"])
    require(digest(proof_raw) == request["succeeded_worker_proof_sha256"], "Namespace build proof changed")
    proof = strict_json(proof_raw)
    fields = {"schema", "run_id", "task_id", "attempt_id", "ownership_epoch", "lease_token", "store_id",
              "lease_heartbeat_sequence", "documents", "teardown_request_sha256", "stop_request_path",
              "stop_request_sha256", "stop_proof_path", "stop_proof_sha256"}
    require(set(proof) == fields and proof["schema"] == "fullmag.succeeded-namespace-build-proof.v1",
            "Unsupported namespace build proof")
    for path_key in ("stop_request_path", "stop_proof_path"):
        path = Path(proof[path_key])
        require(path.is_absolute() and path.is_relative_to(Path("/opt/fullmag/control/verification"))
                and ".." not in path.parts, "Namespace proof escaped control verification")
    stop_raw = regular(proof["stop_request_path"])
    require(digest(stop_raw) == proof["stop_request_sha256"], "Bootstrap stop request changed")
    stop = validate_stop_request(strict_json(stop_raw))
    completed_raw = regular(proof["stop_proof_path"])
    require(digest(completed_raw) == proof["stop_proof_sha256"], "Kernel stop proof changed")
    completed = strict_json(completed_raw)
    require(completed.get("schema") == STOP_PROOF_SCHEMA and completed.get("state") == "native-processes-terminated"
            and completed.get("request_sha256") == proof["stop_request_sha256"]
            and completed.get("processes") == stop["processes"] and completed.get("stop_signal") == "SIGTERM"
            and completed.get("stop_escalated") is False and completed.get("reservation_released") is False
            and completed.get("solve_replay") is False and completed.get("process_exit_status") == "unknown",
            "Kernel-fenced stop did not complete for these exact inputs")
    core = stop["teardown"]
    require(proof["teardown_request_sha256"] == digest(canonical(core))
            and proof["documents"] == stop["documents"]
            and proof["lease_heartbeat_sequence"] == stop["lease_heartbeat_sequence"], "Build changed the immutable teardown inputs")
    identity = core["identity"]
    expected = {k: identity[k] for k in ("run_id", "task_id", "store_id", "lease_token")}
    expected.update(attempt_id=identity["owner"]["attempt_id"], ownership_epoch=identity["owner"]["ownership_epoch"])
    require(all(proof[k] == value for k, value in expected.items()), "Build belongs to another task/lease")
    require(digest(regular(Path(__file__))) == request.get("namespace_controller_sha256"), "Namespace controller source changed")
    require(completed["post_stop_owner_sha256"] == request["owner_sha256"]
            and owner.get("schema_version") == "runtime_service_owner.v1"
            and owner.get("state") in {"ready", "unknown", "failed"}, "Honest post-stop owner pin differs")
    require(process.get("schema") == "fullmag.docker-process-tree.v1"
            and process.get("state") == "failed_outcome_retained" and process.get("api_diagnostic_only") is True
            and process.get("runtime_pid") is None and type(process.get("api_pid")) is int,
            "A retained diagnostic-only API is required for this build kind")
    require(all(process_identity(pin["pid"]) is None for pin in stop["processes"]),
            "An original native owner or scheduler is still alive")
    no_foreign_native_processes(stop, process["api_pid"])
    api_evidence = namespace_diagnostic_api(process, paths, proof["stop_proof_path"])
    evidence = validate_worker_evidence(stop, paths)
    require(evidence == completed["evidence"], "Protected evidence changed after the stopped admission")
    return {str(Path(proof["stop_request_path"])): digest(stop_raw), str(Path(proof["stop_proof_path"])): digest(completed_raw),
            str(Path(request["succeeded_worker_proof"])): digest(proof_raw), **proof["documents"], **api_evidence}


def container_pin(actual):
    from docker_volume_reconcile import fingerprint
    return {"container_id": actual["Id"], "image_id": actual["Image"],
            "started_at": actual["State"]["StartedAt"], "fingerprint": fingerprint(actual)}


def require_container(actual, pin, project, service, *, running=True):
    require(container_pin(actual) == pin and actual.get("Config", {}).get("Labels", {}).get("com.docker.compose.project") == project
            and actual.get("Config", {}).get("Labels", {}).get("com.docker.compose.service") == service
            and actual["State"].get("Running") is running and not actual["State"].get("Restarting")
            and actual["State"].get("OOMKilled") is not True, "Pinned service incarnation changed")


def engine_receipt(engine_sha, argv, result):
    require(SHA.fullmatch(engine_sha) and isinstance(argv, list) and all(isinstance(v, str) for v in argv),
            "Invalid Engine observation identity")
    return {"schema": "fullmag.succeeded-namespace-engine-command.v1", "engine_id_sha256": engine_sha,
            "argv": argv, "exit_code": result.returncode, "stdout": result.stdout.decode("utf-8", "strict"),
            "stderr": result.stderr.decode("utf-8", "strict")}


def validate_removed(old_cid, receipt):
    require(receipt.get("argv") == ["rm", old_cid] and receipt.get("exit_code") == 0
            and receipt.get("stdout", "").strip() == old_cid and not receipt.get("stderr", "").strip(),
            "Exact non-forced Engine removal is not confirmed")


def validate_not_found(old_cid, receipt):
    text = receipt.get("stderr", "").strip()
    require(receipt.get("argv") == ["inspect", old_cid] and receipt.get("exit_code") == 1
            and receipt.get("stdout", "").strip() in {"", "[]"}
            and text in {"Error: No such object: " + old_cid,
                         "Error response from daemon: No such container: " + old_cid,
                         "error: no such object: " + old_cid},
            "Exact removed CID is not authoritatively absent")


def run(args):
    from docker_dev import _compose_identity, _select_source
    from docker_dev_recovery_build import inspect_one
    from docker_compose_identity import validate_source_labels
    from docker_volume_unclaimed_cancellation import _project_container_ids, _volume_consumer_ids
    require(SHA.fullmatch(args.request_sha256), "Exact stop request SHA required")
    relative = PurePosixPath(args.request)
    require(str(relative) == args.request and args.request.startswith("verification/") and ".." not in relative.parts,
            "Control verification request required")
    selected, layout = _select_source(Path(args.source_root), args.source_root)
    control = BuildControl(_compose_identity(layout), args.image_id)
    raw = control.read_bytes(args.request)
    require(digest(raw) == args.request_sha256, "Stop request bytes changed")
    request = validate_stop_request(strict_json(raw))
    require(raw == canonical(request) + b"\n" and request["source_root"] == str(selected)
            and request["compose_project"] == control.project and request["backend"]["image_id"] == args.image_id,
            "Stop request source/group/image differs")
    phase = "succeeded-namespace-stop" if args.apply else "succeeded-namespace-preview"
    inputs = {"request_sha256": args.request_sha256, "source_root": str(selected),
              "controller_sha256": digest(Path(__file__).read_bytes())}
    if args.apply:
        preview = control.read("succeeded-namespace-preview/verified.json")
        require(preview.get("state") == "succeeded" and preview.get("inputs") == inputs,
                "A verified preview of the same request/controller is required")
    with control.operation(phase, inputs) as operation:
        for service in ("backend", "frontend"):
            actual = inspect_one("container", request[service]["container_id"])
            require_container(actual, request[service], control.project, service)
            validate_source_labels(actual, control.identity)
        expected = {request["backend"]["container_id"], request["frontend"]["container_id"], operation["helper_container_id"]}
        require(_project_container_ids(control.project) == expected and _volume_consumer_ids(control.volume) == expected,
                "Another group/private-volume consumer exists")
        stable_root = "verification/succeeded-namespace-recovery-20261104/requests/" + request["request_id"]
        existing_request = control.read_bytes(stable_root + "/stop-request.json", optional=True)
        require(existing_request is None or existing_request == raw, "A different stop request already owns this request ID")
        if existing_request is None:
            control.write(stable_root + "/stop-request.json", request)
        result_path = "/opt/fullmag/control/" + stable_root + "/kernel-stop-proof.json"
        code = ("import sys,json; sys.path.insert(0,'/opt/fullmag/source/scripts'); "
                "import docker_volume_succeeded_namespace_recovery as c; "
                "request=c.strict_json(sys.stdin.buffer.read()); "
                "result=c.guest_stop(request,sys.argv[1],sys.argv[2],sys.argv[3]=='apply'); "
                "print(json.dumps(result))")
        if args.apply:
            operation["daemon_pending"] = True
        response = docker_capture("exec", "-i", request["backend"]["container_id"], "python3", "-B", "-c", code,
                                  args.request_sha256, result_path, "apply" if args.apply else "preview",
                                  data=raw, timeout=request["stop_timeout_seconds"] + 45)
        result = strict_json(response.stdout)
        require(result.get("state") == ("native-processes-terminated" if args.apply else "preview-passed")
                and result.get("request_sha256") == args.request_sha256
                and result.get("reservation_released") is False, "Native stop proof differs")
        control.write(operation["root"] + "/result.json", result)
        operation["daemon_pending"] = False
        operation["receipt"].update(state="succeeded", result={"state": result["state"], "reservation_released": False,
            "proof_path": result_path, "proof_sha256": digest(canonical(result) + b"\n")})
        print(json.dumps(operation["receipt"]["result"]))


def recognized_layer_path(name):
    path = Path(name)
    known = {"/usr", "/usr/lib", "/usr/lib/x86_64-linux-gnu", "/usr/lib/wsl", "/usr/lib/wsl/drivers",
             "/usr/sbin", "/usr/sbin/docker-init", "/usr/bin", "/usr/bin/nvidia-smi", "/etc", "/etc/ld.so.cache",
             "/var", "/var/cache", "/var/cache/ldconfig", "/var/cache/ldconfig/aux-cache", "/user-data", "/run",
             "/run/fullmag", "/run/fullmag/linux-native-host.json", "/opt", "/opt/fullmag", "/opt/fullmag/shared-backend",
             "/opt/fullmag/shared-cargo", "/host-ledger"}
    libraries = {"libcuda.so", "libcuda.so.1", "libnvidia-ml.so.1", "libnvidia-gpucomp.so", "libcudadebugger.so.1", "libdxcore.so"}
    return bool(name in known or (str(path.parent) == "/usr/lib/x86_64-linux-gnu" and
                (path.name in libraries or re.fullmatch(r"libnvidia-gpucomp\.so\.[0-9.]+", path.name)))
                or re.fullmatch(r"/usr/lib/wsl/drivers/nvami\.inf_amd64_[0-9a-f]+(?:/[A-Za-z0-9._-]+)?", name))


def canonical_layer_diff_sha256(diff):
    require(isinstance(diff, str) and len(diff.encode()) <= MAX_BYTES, "Unbounded writable layer diff")
    lines = diff.splitlines()
    require(len(lines) <= 256, "Writable layer diff has too many entries")
    rows, paths = [], set()
    for line in lines:
        require(len(line) > 3 and line[0] in "ACD" and line[1] == " ", "Malformed Docker layer diff")
        name = line[2:]
        path = PurePosixPath(name)
        require(path.is_absolute() and str(path) == name and ".." not in path.parts and "\0" not in name,
                "Unsafe writable layer path")
        require(name not in paths, "Duplicate writable layer entry")
        paths.add(name)
        rows.append({"change": line[0], "path": name})
    return digest(canonical(sorted(rows, key=lambda row: row["path"])))


def guest_layer_snapshot(diff):
    """Preserve bounded writable system files; unknown paths prevent removal."""
    canonical_diff = canonical_layer_diff_sha256(diff)
    require(isinstance(diff, str) and len(diff.encode()) <= MAX_BYTES, "Unbounded writable layer inventory")
    lines = diff.splitlines()
    require(len(lines) <= 256, "Writable layer inventory has too many entries")
    mounts = {}
    for line in Path("/proc/self/mountinfo").read_text().splitlines():
        fields = line.split()
        point = fields[4].replace("\\040", " ").replace("\\134", "\\")
        mounts[point] = fields[5].split(",")
    result, total = [], 0
    for line in lines:
        require(len(line) > 3 and line[0] in "ACD" and line[1] == " ", "Malformed Docker layer diff")
        change, name = line[0], line[2:]
        path = Path(name)
        require(path.is_absolute() and str(PurePosixPath(name)) == name and ".." not in path.parts,
                "Unsafe writable layer path")
        allowed = recognized_layer_path(name)
        row = {"change": change, "path": name, "recognized_runtime_path": bool(allowed)}
        if change == "D":
            row["kind"] = "deleted"
        else:
            metadata = path.lstat()
            row.update(mode=metadata.st_mode, uid=metadata.st_uid, gid=metadata.st_gid, size=metadata.st_size)
            if stat.S_ISLNK(metadata.st_mode):
                row.update(kind="symlink", target=os.readlink(path))
            elif stat.S_ISDIR(metadata.st_mode):
                row["kind"] = "directory"
            elif stat.S_ISREG(metadata.st_mode) and not allowed:
                row.update(kind="regular", disposition="unknown-retained-in-container")
            elif stat.S_ISREG(metadata.st_mode):
                row["kind"] = "regular"
                if name in mounts and "ro" in mounts[name]:
                    row["disposition"] = "external-readonly-file-mount"
                else:
                    total += metadata.st_size
                    require(metadata.st_size <= 32 * 1024 * 1024 and total <= 64 * 1024 * 1024,
                            "Writable layer file preservation exceeds bound; keep container")
                    row["disposition"] = "preserved-control-file"
            else:
                row["kind"] = "unsupported"
                row["recognized_runtime_path"] = False
        result.append(row)
    require(len({row["path"] for row in result}) == len(result), "Duplicate writable layer entry")
    return {"schema": "fullmag.succeeded-namespace-writable-layer.v1", "diff_sha256": digest(diff.encode()),
            "canonical_diff_sha256": canonical_diff, "entries": sorted(result, key=lambda row: row["path"]), "preserved_bytes": total,
            "unknown_paths": [row["path"] for row in result if not row["recognized_runtime_path"]]}


def guest_layer_metadata(row):
    require(isinstance(row, dict) and row.get("recognized_runtime_path") is True
            and recognized_layer_path(row.get("path", "")) and row.get("kind") == "regular",
            "Only an inventoried runtime file may be read")
    require(type(row.get("uid")) is int and row["uid"] >= 0
            and ((row["uid"] == 0) == (os.geteuid() == 0)), "Layer reader does not match the inventoried owner class")
    path = Path(row["path"])
    observed = path.lstat()
    require(stat.S_ISREG(observed.st_mode)
            and (observed.st_mode, observed.st_uid, observed.st_gid, observed.st_size)
                == (row.get("mode"), row.get("uid"), row.get("gid"), row.get("size")), "Layer file metadata changed")
    return path


def external_readonly_layer_hash(row):
    path = guest_layer_metadata(row)
    require(row.get("disposition") == "external-readonly-file-mount", "External read-only file classification required")
    require(not any(part.is_symlink() for part in (path, *path.parents)), "Read-only layer alias refused")
    def mounted_readonly():
        matches = []
        for line in Path("/proc/self/mountinfo").read_text().splitlines():
            fields = line.split()
            point = fields[4].replace("\\040", " ").replace("\\134", "\\")
            if point == str(path):
                matches.append((line, fields[5].split(",")))
        require(len(matches) == 1 and "ro" in matches[0][1] and "rw" not in matches[0][1],
                "Layer file is not an exact current read-only mount")
        return matches[0][0]
    mount = mounted_readonly()
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_nlink >= 1 and 0 <= before.st_size <= 512 * 1024 * 1024
                and (before.st_mode, before.st_uid, before.st_gid, before.st_size)
                    == (row.get("mode"), row.get("uid"), row.get("gid"), row.get("size")),
                "Read-only layer file metadata differs")
        hasher, remaining = hashlib.sha256(), before.st_size
        while remaining:
            raw = stream.read(min(1024 * 1024, remaining))
            require(bool(raw), "Read-only layer file was truncated")
            hasher.update(raw)
            remaining -= len(raw)
        require(stream.read(1) == b"", "Read-only layer file grew beyond its bounded size")
        value = hasher.hexdigest()
        identity = lambda info: (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_size, info.st_nlink, info.st_mtime_ns, info.st_ctime_ns)
        require(identity(before) == identity(os.fstat(stream.fileno())) == identity(path.lstat())
                and mounted_readonly() == mount, "Read-only layer file or mount changed during hash")
    return value


def guest_layer_hash(row):
    if row.get("disposition") == "external-readonly-file-mount":
        return external_readonly_layer_hash(row)
    path = guest_layer_metadata(row)
    value = file_sha(path)
    guest_layer_metadata(row)
    return value


def hash_layer_inventory(inventory, read_hash):
    require(not inventory.get("unknown_paths"), "Unknown layer paths must remain in the retained container")
    total = 0
    for row in inventory["entries"]:
        if row.get("kind") == "regular":
            require(row.get("recognized_runtime_path") is True and recognized_layer_path(row.get("path", ""))
                    and type(row.get("size")) is int and 0 <= row["size"] <= 512 * 1024 * 1024,
                    "Layer hash inventory exceeds its bound")
            total += row["size"]
            require(total <= 512 * 1024 * 1024, "Layer hash inventory total exceeds its bound")
    for row in inventory["entries"]:
        if row.get("kind") == "regular":
            value = read_hash(row)
            require(isinstance(value, str) and SHA.fullmatch(value), "Layer owner reader returned an invalid hash")
            row["sha256"] = value
    return inventory


def guest_layer_payload(row):
    require(isinstance(row, dict) and row.get("recognized_runtime_path") is True
            and recognized_layer_path(row.get("path", "")) and row.get("kind") == "regular"
            and row.get("disposition") == "preserved-control-file", "Only an inventoried runtime file may be read")
    size = row.get("size")
    require(type(size) is int and 0 <= size <= MAX_BYTES,
            "Layer file exceeds the existing bounded control transport; retain container")
    path = guest_layer_metadata(row)
    raw = regular(path, MAX_BYTES, allow_empty=True)
    guest_layer_metadata(row)
    require(len(raw) == size and digest(raw) == row.get("sha256"), "Layer file changed before payload copy")
    return raw


def copy_layer_payloads(control, stable_root, inventory, read_payload):
    require(not inventory.get("unknown_paths"), "Unknown layer paths must remain in the retained container")
    rows = [row for row in inventory["entries"] if row.get("disposition") == "preserved-control-file"]
    total = 0
    for row in rows:
        require(row.get("recognized_runtime_path") is True and recognized_layer_path(row.get("path", ""))
                and row.get("kind") == "regular" and type(row.get("size")) is int
                and 0 <= row["size"] <= MAX_BYTES and SHA.fullmatch(row.get("sha256", "")),
                "Layer payload exceeds the existing bounded control transport; retain container")
        total += row["size"]
        require(total <= 64 * 1024 * 1024, "Layer payload total exceeds its approved bound")
    require(total == inventory["preserved_bytes"], "Layer payload inventory byte total differs")
    for row in rows:
        raw = read_payload(row)
        require(isinstance(raw, bytes) and len(raw) == row["size"] and digest(raw) == row["sha256"],
                "Layer payload size or hash changed during transport")
        control.write_bytes(stable_root + "/layer-files/" + row["sha256"] + ".bin", raw)


def engine_observe(control, root, name, engine_sha, argv):
    from docker_volume_container_recovery import _docker_engine_sha
    require(_docker_engine_sha() == engine_sha, "Docker Engine changed before command")
    result = docker_capture(*argv, allow_failure=True, timeout=90)
    require(_docker_engine_sha() == engine_sha, "Docker Engine changed during command")
    receipt = engine_receipt(engine_sha, argv, result)
    relative = root + "/" + name
    previous = control.read_bytes(relative, optional=True)
    raw = canonical(receipt) + b"\n"
    require(previous is None or previous == raw, "Immutable Engine receipt replay differs")
    if previous is None:
        control.write(relative, receipt)
    return receipt, digest(raw)


def inspect_receipt(receipt, cid):
    require(receipt["argv"] == ["inspect", cid] and receipt["exit_code"] == 0 and not receipt["stderr"].strip(),
            "Exact Engine inspect did not succeed")
    rows = json.loads(receipt["stdout"])
    require(isinstance(rows, list) and len(rows) == 1 and rows[0].get("Id") == cid, "Ambiguous Engine container identity")
    return rows[0]


def stopped_namespace(actual, core):
    state = actual.get("State", {})
    host = actual.get("HostConfig", {})
    require(actual.get("Id") == core["old_container_id"] and actual.get("Image") == core["old_image_id"]
            and host.get("PidMode", "") == "" and state.get("Running") is False
            and state.get("Pid") == 0 and state.get("Restarting") is False and state.get("OOMKilled") is False
            and type(state.get("ExitCode")) is int and isinstance(state.get("FinishedAt"), str)
            and state["FinishedAt"] and not state["FinishedAt"].startswith("0001-"),
            "Private PID namespace termination is not confirmed by Engine")
    return state["FinishedAt"]


def require_exact_consumers(control, operation, service_ids):
    from docker_volume_unclaimed_cancellation import _project_container_ids, _volume_consumer_ids
    expected = set(service_ids) | {operation["helper_container_id"]}
    require(_project_container_ids(control.project) == expected
            and _volume_consumer_ids(control.volume) == expected,
            "Another group or private-volume consumer exists")


def retire_namespace(control, operation, seed, native_request, before, frontend):
    """Actual Engine receipts only; stopped/missing input alone never admits removal."""
    from docker_dev_recovery_build import inspect_one
    from docker_volume_container_recovery import _docker_engine_sha
    core = native_request["teardown"]
    cid, engine = core["old_container_id"], core["docker_engine_id_sha256"]
    root = seed["engine_receipts_directory"].removeprefix("/opt/fullmag/control/")
    require(root.startswith("verification/") and ".." not in PurePosixPath(root).parts, "Engine receipt root escaped control")
    require(_docker_engine_sha() == engine, "Original Docker Engine differs")
    require(before.get("HostConfig", {}).get("PidMode", "") == "", "Shared PID namespace is ineligible")
    require(any(m.get("Type") == "volume" and m.get("Name") == control.volume
                and m.get("Destination") == "/opt/fullmag/control" and m.get("RW") is True
                for m in before.get("Mounts", [])), "Private control volume identity differs")
    previous = control.read(root + "/retirement-state.json", optional=True)
    intent = {"schema": "fullmag.succeeded-namespace-retirement-intent.v1", "core_request_sha256": digest(canonical(core)),
              "native_request_sha256": seed["native_request_sha256"], "backend": seed["backend"], "frontend": seed["frontend"],
              "engine_id_sha256": engine, "layer_inventory_sha256": seed["layer_inventory_sha256"], "stop_signal": "SIGTERM"}
    if previous is None:
        control.write(root + "/retirement-state.json", {"intent": intent, "state": "prepared"})
    else:
        require(previous.get("intent") == intent, "Retirement request changed; no new signal authorized")
    before_receipt, before_sha = engine_observe(control, root, "engine-before-inspect.json", engine, ["inspect", cid])
    require(container_pin(inspect_receipt(before_receipt, cid)) == seed["backend"], "Pre-stop Engine incarnation changed")
    if previous is not None:
        require(previous.get("state") == "prepared", "Interrupted retirement requires observation-only recovery; do not repeat signals")
    # The caller holds a kernel-fenced guest admission through the container's
    # lifetime. It never calls docker stop (which could escalate to SIGKILL).
    require_exact_consumers(control, operation, {cid, frontend["Id"]})
    operation["daemon_pending"] = True
    control.write(root + "/retirement-state.json", {"intent": intent, "state": "sigterm-planned"})
    signal_receipt, signal_sha = engine_observe(control, root, "engine-sigterm-receipt.json", engine,
                                               ["kill", "--signal", "TERM", cid])
    require(signal_receipt["exit_code"] == 0 and signal_receipt["stdout"].strip() == cid
            and not signal_receipt["stderr"].strip(), "Engine did not acknowledge exact SIGTERM")
    deadline = time.monotonic() + seed["stop_timeout_seconds"]
    while True:
        actual = inspect_one("container", cid)
        if actual["State"].get("Running") is False:
            break
        require(time.monotonic() < deadline, "Backend SIGTERM deadline exceeded; no escalation authorized")
        time.sleep(0.2)
    stopped_receipt, stopped_sha = engine_observe(control, root, "engine-stopped-inspect.json", engine, ["inspect", cid])
    stopped = inspect_receipt(stopped_receipt, cid)
    finished = stopped_namespace(stopped, core)
    require(container_pin(stopped) == seed["backend"], "Stopped container configuration differs")
    require_container(inspect_one("container", frontend["Id"]), seed["frontend"], control.project, "frontend")
    logs = docker_capture("logs", cid, timeout=120)
    control.write_bytes(root + "/final-container-stdout.log", logs.stdout)
    control.write_bytes(root + "/final-container-stderr.log", logs.stderr)
    control.write(root + "/final-container-logs.json", {"schema": "fullmag.succeeded-namespace-logs.v1",
        "container_id": cid, "stdout_sha256": digest(logs.stdout), "stderr_sha256": digest(logs.stderr)})
    require_exact_consumers(control, operation, {cid, frontend["Id"]})
    removed, remove_sha = engine_observe(control, root, "engine-remove-receipt.json", engine, ["rm", cid])
    validate_removed(cid, removed)
    absent, absent_sha = engine_observe(control, root, "engine-after-inspect.json", engine, ["inspect", cid])
    validate_not_found(cid, absent)
    result = {"schema": "fullmag.succeeded-namespace-retirement.v1", "state": "removed-confirmed",
              "core_request_sha256": digest(canonical(core)), "old_container_id": cid, "engine_id_sha256": engine,
              "before_inspect_sha256": before_sha, "stop_signal_receipt_sha256": signal_sha,
              "stopped_inspect_sha256": stopped_sha, "remove_receipt_sha256": remove_sha, "after_inspect_sha256": absent_sha,
              "stop_signal": "SIGTERM", "stop_escalated": False, "stopped_pid": 0, "descendant_count": 0,
              "finished_at": finished, "engine_transport": "docker_cli", "remove_exit_code": 0,
              "after_inspect_exit_code": 1, "after_inspect_error": "no_such_container", "solve_replay": False}
    control.write(root + "/retirement-state.json", {"intent": intent, "state": "removed-confirmed", "result": result})
    operation["daemon_pending"] = False
    return result


def run_layer_snapshot(args):
    from docker_dev import _compose_identity, _select_source
    from docker_dev_recovery_build import inspect_one
    from docker_volume_container_recovery import _docker_engine_sha
    selected, layout = _select_source(Path(args.source_root), args.source_root)
    control = BuildControl(_compose_identity(layout), args.image_id)
    raw = control.read_bytes(args.request)
    require(digest(raw) == args.request_sha256, "Layer request changed")
    request = validate_stop_request(strict_json(raw))
    core = request["teardown"]
    require(request["source_root"] == str(selected) and request["compose_project"] == control.project
            and core["docker_engine_id_sha256"] == _docker_engine_sha(), "Layer source/Engine differs")
    inputs = {"request_sha256": args.request_sha256, "controller_sha256": digest(Path(__file__).read_bytes())}
    with control.operation("succeeded-namespace-layer-snapshot", inputs) as operation:
        require_container(inspect_one("container", core["old_container_id"]), request["backend"], control.project, "backend")
        result = docker_capture("diff", core["old_container_id"], timeout=120)
        require(result.returncode == 0 and not result.stderr.strip(), "Docker layer inventory failed")
        control.write(operation["root"] + "/layer-diff.json", engine_receipt(core["docker_engine_id_sha256"], ["diff", core["old_container_id"]], result))
        stable_root = "verification/succeeded-namespace-recovery-20261104/requests/" + request["request_id"] + "/layer/" + operation["root"].split("/")[-1]
        logs = docker_capture("logs", core["old_container_id"], timeout=120)
        control.write_bytes(stable_root + "/container-stdout.log", logs.stdout)
        control.write_bytes(stable_root + "/container-stderr.log", logs.stderr)
        control.write(stable_root + "/logs.json", {"schema": "fullmag.succeeded-namespace-logs.v1",
            "container_id": core["old_container_id"], "stdout_sha256": digest(logs.stdout), "stderr_sha256": digest(logs.stderr)})
        archive = "/opt/fullmag/control/" + stable_root + "/layer-files"
        control.write(stable_root + "/layer-files/index.json", {"request_sha256": args.request_sha256})
        def root_read(code, payload):
            return docker_capture("exec", "--user", "0", "-i", core["old_container_id"], "python3", "-B", "-c", code,
                                  data=payload, timeout=120).stdout
        code = ("import sys,json;sys.path.insert(0,'/opt/fullmag/source/scripts');"
                "import docker_volume_succeeded_namespace_recovery as c;"
                "print(json.dumps(c.guest_layer_snapshot(sys.stdin.read())))")
        def owner_read(code, row):
            require(type(row.get("uid")) is int and row["uid"] >= 0, "Layer file owner is unknown")
            payload = canonical({"row": row})
            if row["uid"] == 0:
                return root_read(code, payload)
            return docker_capture("exec", "-i", core["old_container_id"], "python3", "-B", "-c", code,
                                  data=payload, timeout=120).stdout
        hash_code = ("import sys;sys.path.insert(0,'/opt/fullmag/source/scripts');"
            "import docker_volume_succeeded_namespace_recovery as c;q=c.strict_json(sys.stdin.buffer.read());"
            "print(c.guest_layer_hash(q['row']))")
        def inventory_with_hashes():
            metadata = strict_json(root_read(code, result.stdout))
            require(not metadata["unknown_paths"], "Unrecognized writable-layer paths retained; container removal refused")
            return hash_layer_inventory(metadata, lambda row: owner_read(hash_code, row).decode("ascii").strip())
        inventory = inventory_with_hashes()
        relative = stable_root + "/layer-inventory.json"
        control.write(relative, inventory)
        control.write(operation["root"] + "/layer-inventory.json", inventory)
        payload_code = ("import sys;sys.path.insert(0,'/opt/fullmag/source/scripts');"
            "import docker_volume_succeeded_namespace_recovery as c;q=c.strict_json(sys.stdin.buffer.read());"
            "sys.stdout.buffer.write(c.guest_layer_payload(q['row']))")
        copy_layer_payloads(control, stable_root, inventory,
            lambda row: owner_read(payload_code, row))
        require(inventory_with_hashes() == inventory, "Writable layer metadata or owner hashes changed during preservation")
        latest = docker_capture("diff", core["old_container_id"], timeout=120)
        require(not latest.stderr.strip() and canonical_layer_diff_sha256(latest.stdout.decode("utf-8", "strict"))
                == inventory["canonical_diff_sha256"], "Writable layer diff changed during preservation")
        require(_docker_engine_sha() == core["docker_engine_id_sha256"], "Engine changed during layer snapshot")
        summary = {"state": "layer-preserved", "layer_inventory_path": "/opt/fullmag/control/" + relative,
                   "layer_inventory_sha256": digest(canonical(inventory) + b"\n"), "archive_root": archive,
                   "entries": len(inventory["entries"]), "preserved_bytes": inventory["preserved_bytes"]}
        operation["receipt"].update(state="succeeded", result=summary)
        print(json.dumps(summary))


RETIRE_FENCE = r"""
import os,sys,time
from contextlib import ExitStack
from pathlib import Path
sys.path.insert(0,'/opt/fullmag/source/scripts');sys.path.insert(0,'/opt/fullmag')
import docker_volume_succeeded_namespace_recovery as c
import runtime_service as runtime
request=c.strict_json(c.regular(sys.argv[1]));c.require(c.digest(c.regular(sys.argv[1]))==sys.argv[2],'Stop request changed')
paths=runtime.canonical_paths();services=runtime.runtime_services_root(paths)
with ExitStack() as fences:
 for path in (services/'STARTUP-GATE.lock',services/'LAUNCH.lock',services/'OWNER.lock',Path(os.environ['FULLMAG_HOST_LEDGER_ROOT'])/'WRITER.lock'):
  fences.enter_context(c.kernel_lock(path))
 with c.kernel_lock(paths.store/'WRITER.lock'):
  c.validate_worker_evidence(request,paths)
  c.require(all(c.process_identity(pin['pid']) is None for pin in request['processes']),'Original native process is alive')
  process=c.strict_json(c.regular(runtime.process_receipt_path(paths)))
  c.require(process.get('api_diagnostic_only') is True,'API is not fenced')
  c.no_foreign_native_processes(request,process['api_pid'])
 print('READY',flush=True)
 line=sys.stdin.readline(64)
 if line=='ABORT\n':sys.exit(0)
 c.require(line=='BEGIN_TEARDOWN\n','Missing exact teardown decision')
 print('FENCED',flush=True)
 # Keep native admission fenced even if the host observation disappears. Only
 # authoritative namespace destruction ends this guard after BEGIN_TEARDOWN.
 while True:time.sleep(1)
"""


@contextmanager
def retirement_fence(cid, stop_path, stop_sha):
    import queue
    import subprocess
    import threading
    from docker_dev_host import docker_argv
    process = subprocess.Popen(docker_argv("exec", "-i", cid, "python3", "-B", "-c", RETIRE_FENCE, stop_path, stop_sha),
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    messages = queue.Queue()
    def read():
        for line in iter(process.stdout.readline, b""):
            messages.put(line)
        messages.put(b"")
    thread = threading.Thread(target=read, daemon=True)
    thread.start()
    began = False
    try:
        require(messages.get(timeout=20) == b"READY\n", "Kernel retirement admission was refused")
        def begin():
            nonlocal began
            process.stdin.write(b"BEGIN_TEARDOWN\n"); process.stdin.flush()
            require(messages.get(timeout=10) == b"FENCED\n", "Retirement fence handoff unknown")
            began = True
        yield begin
    finally:
        if not began and process.poll() is None:
            process.stdin.write(b"ABORT\n"); process.stdin.flush(); process.stdin.close()
            process.wait(timeout=10)
        # No client kill may be interpreted as namespace/process termination.


def run_retire(args):
    from docker_dev import _compose_identity, _select_source
    from docker_dev_recovery_build import inspect_one
    from docker_volume_container_recovery import _docker_engine_sha
    fields = {"schema", "source_root", "compose_project", "backend", "frontend", "native_request_path", "native_request_sha256",
              "native_intent_path", "native_intent_sha256", "layer_inventory_path", "layer_inventory_sha256",
              "engine_receipts_directory", "stop_timeout_seconds"}
    selected, layout = _select_source(Path(args.source_root), args.source_root)
    control = BuildControl(_compose_identity(layout), args.image_id)
    raw = control.read_bytes(args.request)
    require(digest(raw) == args.request_sha256, "Retirement seed changed")
    seed = strict_json(raw)
    require(set(seed) == fields and seed["schema"] == "fullmag.succeeded-namespace-retirement-request.v1"
            and seed["source_root"] == str(selected) and seed["compose_project"] == control.project,
            "Unsupported retirement seed")
    def read_guest(path, sha):
        require(path.startswith("/opt/fullmag/control/verification/") and ".." not in PurePosixPath(path).parts,
                "Retirement evidence escaped private verification root")
        data = control.read_bytes(path.removeprefix("/opt/fullmag/control/"))
        require(digest(data) == sha, "Retirement evidence changed")
        return strict_json(data)
    native = read_guest(seed["native_request_path"], seed["native_request_sha256"])
    require(native.get("schema_version") == "runtime_service_succeeded_namespace_recovery.v1", "Typed native recovery request required")
    core = native["teardown"]
    intent = read_guest(seed["native_intent_path"], seed["native_intent_sha256"])
    require(intent.get("request") == core and intent.get("request_sha256") == digest(canonical(core)), "Native durable intent differs")
    inventory = read_guest(seed["layer_inventory_path"], seed["layer_inventory_sha256"])
    require(not inventory.get("unknown_paths"), "Unknown writable layer cannot be discarded")
    require(type(seed["stop_timeout_seconds"]) is int and 1 <= seed["stop_timeout_seconds"] <= 60,
            "Container stop deadline exceeds the approved bound")
    require(core["docker_engine_id_sha256"] == _docker_engine_sha() and core["private_volume_name"] == control.volume,
            "Retirement Engine/private volume changed")
    storage = native.get("candidate_storage")
    require(isinstance(storage, dict), "Managed ready recovery candidate required")
    result = managed_candidate_result(control, native, selected)
    candidate = result.get("candidate", "")
    require(re.fullmatch(r"/opt/fullmag/package/\.development/candidates/\.backend-package-candidate-[A-Za-z0-9._-]+", candidate)
            and result.get("state") == "ready" and result.get("package_promoted") is False,
            "The exact unpublished candidate is required")
    inputs = {"request_sha256": args.request_sha256, "source_root": str(selected), "controller_sha256": digest(Path(__file__).read_bytes())}
    with control.operation("succeeded-namespace-retirement", inputs) as operation:
        before, frontend = inspect_one("container", core["old_container_id"]), inspect_one("container", seed["frontend"]["container_id"])
        require_container(before, seed["backend"], control.project, "backend")
        require_container(frontend, seed["frontend"], control.project, "frontend")
        # The new native binary validates candidate storage, terminal journal,
        # accepted CAS, original owner and the exact unconsumed teardown intent.
        preview = docker_capture("exec", before["Id"], candidate + "/bin/fullmag-runtime-service", "--recover-succeeded-namespace",
                                 "--config", "/opt/fullmag/runtime-control/runtime-service/docker-all.json",
                                 "--request", seed["native_request_path"], "--request-sha256", seed["native_request_sha256"],
                                 "--verify-only", timeout=180)
        control.write_bytes(operation["root"] + "/native-verify-only.json", preview.stdout)
        latest = docker_capture("diff", before["Id"], timeout=120)
        require(isinstance(inventory.get("canonical_diff_sha256"), str) and SHA.fullmatch(inventory["canonical_diff_sha256"])
                and not latest.stderr.strip() and canonical_layer_diff_sha256(latest.stdout.decode("utf-8", "strict"))
                    == inventory["canonical_diff_sha256"], "Writable layer changed after preservation")
        with retirement_fence(before["Id"], native["stop_request_path"], native["stop_request_sha256"]) as begin:
            require(_docker_engine_sha() == core["docker_engine_id_sha256"], "Engine changed before fenced teardown")
            begin()
            outcome = retire_namespace(control, operation, seed, native, before, frontend)
        relative = seed["engine_receipts_directory"].removeprefix("/opt/fullmag/control/") + "/retirement-result.json"
        control.write(relative, outcome)
        operation["receipt"].update(state="succeeded", result=outcome)
        print(json.dumps({"state": outcome["state"], "old_container_id": outcome["old_container_id"],
            "result_path": "/opt/fullmag/control/" + relative, "result_sha256": digest(canonical(outcome) + b"\n"), "solve_replay": False}))


def guest_finish_stop(stop, seed, result_path, apply):
    import sys
    sys.path.insert(0, "/opt/fullmag")
    import runtime_service as runtime
    validate_stop_request(stop)
    require(digest(canonical(stop) + b"\n") == seed["stop_request_sha256"], "Original stop request changed")
    core = stop["teardown"]
    require(os.readlink("/proc/self/ns/pid") == core["pid_namespace"]
            and Path("/proc/sys/kernel/random/boot_id").read_text().strip() == core["boot_id"]
            and digest(Path("/proc/self/cgroup").read_bytes()) == core["cgroup_sha256"], "Original namespace changed")
    paths = runtime.canonical_paths()
    services = runtime.runtime_services_root(paths)
    with ExitStack() as fences:
        for path in (services / "STARTUP-GATE.lock", services / "LAUNCH.lock",
                     Path(os.environ["FULLMAG_HOST_LEDGER_ROOT"]) / "WRITER.lock", paths.store / "WRITER.lock"):
            fences.enter_context(kernel_lock(path, timeout_seconds=5))
        require(digest(regular(paths.config)) == core["config_sha256"], "Original service config changed")
        original = regular(Path(result_path).with_name("original-owner.json"))
        require(digest(original) == stop["owner_sha256"], "Archived original owner changed")
        owner_raw = regular(services / "OWNER.json")
        same_owner_with_monotonic_heartbeat(strict_json(original), strict_json(owner_raw))
        intent_raw = regular(seed["stop_intent_path"])
        require(digest(intent_raw) == seed["stop_intent_sha256"], "Original durable stop intent changed")
        intent = strict_json(intent_raw)
        require(intent.get("schema") == STOP_PROOF_SCHEMA and intent.get("state") == "preview-passed"
                and intent.get("request_sha256") == seed["stop_request_sha256"]
                and intent.get("processes") == stop["processes"] and intent.get("stop_signal") == "SIGTERM"
                and intent.get("stop_escalated") is False and intent.get("reservation_released") is False
                and intent.get("solve_replay") is False, "Original stop intent identity differs")
        require(all(not (Path("/proc") / str(pin["pid"])).exists() for pin in stop["processes"]),
                "Observation finish requires every original PID path to be absent")
        process_raw = regular(runtime.process_receipt_path(paths))
        process = strict_json(process_raw)
        require(process.get("state") == "failed_outcome_retained" and process.get("api_diagnostic_only") is True
                and process.get("runtime_pid") is None, "Canonical retained diagnostic API has not settled")
        no_foreign_native_processes(stop, process["api_pid"])
        api = namespace_diagnostic_api(process, paths, result_path)
        evidence = validate_worker_evidence(stop, paths)
        require(evidence == intent["evidence"], "Protected evidence changed after the original stop intent")
        identity = process_identity(process["api_pid"])
        require(identity is not None, "Diagnostic API process disappeared")
        result = {**intent, "state": "native-processes-terminated" if apply else "observation-preview-passed",
            "process_exit_status": "unknown", "original_owner_sha256": stop["owner_sha256"],
            "post_stop_owner_sha256": digest(owner_raw), "post_stop_process_receipt_sha256": digest(process_raw),
            "finish_observation_only": True, "signals_replayed": False,
            "original_stop_attempt": seed["original_attempt"], "original_stop_receipt_sha256": seed["original_receipt_sha256"],
            "original_controller_sha256": seed["original_controller_sha256"], "original_intent_sha256": seed["stop_intent_sha256"],
            "diagnostic_api_identity": identity, "diagnostic_api_fence_path": next(iter(api)),
            "diagnostic_api_fence_sha256": next(iter(api.values()))}
        if apply:
            immutable_write(result_path, result)
        return result


def retained_stop_helper(control, receipt, pin, phase="succeeded-namespace-stop"):
    from docker_dev_recovery_build import inspect_one
    from docker_compose_identity import source_labels
    actual = inspect_one("container", pin["container_id"])
    require_container(actual, pin, control.project, "build-control")
    expected = control.helper_args(control.operation_script(phase, receipt["attempt"]),
                                   name=receipt["helper_container"])
    index = expected.index("--entrypoint")
    labels = actual.get("Config", {}).get("Labels", {})
    require(actual["Config"].get("Entrypoint") == ["/bin/bash"] and actual["Config"].get("Cmd") == expected[index + 3:]
            and all(labels.get(key) == value for key, value in {**control.labels, **source_labels(control.identity)}.items()),
            "Original managed helper protocol changed")
    require(len(actual.get("Mounts", [])) == 1 and actual["Mounts"][0].get("Name") == control.volume
            and actual["Mounts"][0].get("Destination") == "/control" and actual["Mounts"][0].get("RW") is True,
            "Original managed helper mount changed")


def run_finish_stop(args):
    from docker_dev import _compose_identity, _select_source
    from docker_dev_recovery_build import inspect_one
    from docker_volume_activation_reconcile import _validate_helper_logged
    selected, layout = _select_source(Path(args.source_root), args.source_root)
    control = BuildControl(_compose_identity(layout), args.image_id)
    seed = control_document(control, "/opt/fullmag/control/" + args.request, args.request_sha256)
    fields = {"schema", "source_root", "compose_project", "stop_request_path", "stop_request_sha256",
        "stop_intent_path", "stop_intent_sha256", "original_attempt", "original_receipt_sha256",
        "original_controller_sha256", "helper"}
    require(set(seed) == fields and seed["schema"] == "fullmag.succeeded-namespace-stop-finish.v1"
            and seed["source_root"] == str(selected) and seed["compose_project"] == control.project
            and re.fullmatch(r"[0-9a-f]{32}", seed["original_attempt"]), "Unsupported observation-only finish seed")
    stop = control_document(control, seed["stop_request_path"], seed["stop_request_sha256"])
    validate_stop_request(stop)
    root = "succeeded-namespace-stop/attempts/" + seed["original_attempt"]
    receipt_raw = control.read_bytes(root + "/receipt.json")
    require(digest(receipt_raw) == seed["original_receipt_sha256"], "Original partial-stop managed receipt changed")
    receipt = strict_json(receipt_raw)
    require(receipt.get("schema") == "fullmag.docker-build-operation.v1"
            and receipt.get("phase") == "succeeded-namespace-stop"
            and receipt.get("state") == "outcome-unknown-resources-retained"
            and receipt.get("attempt") == seed["original_attempt"] and receipt.get("compose_project") == control.project
            and receipt.get("control_volume") == control.volume
            and receipt.get("helper_container") == "fullmag-control-" + seed["original_attempt"]
            and receipt.get("inputs", {}).get("request_sha256") == seed["stop_request_sha256"]
            and receipt.get("inputs", {}).get("controller_sha256") == seed["original_controller_sha256"]
            and receipt.get("inputs", {}).get("source_root") == str(selected), "Original managed stop identity differs")
    require(control.read_bytes("active") == (seed["original_attempt"] + "\n").encode(), "Original active marker differs")
    retained_stop_helper(control, receipt, seed["helper"])
    log_ack = _validate_helper_logged(seed["helper"]["container_id"])
    for service in ("backend", "frontend"):
        require_container(inspect_one("container", stop[service]["container_id"]), stop[service], control.project, service)
    require_exact_consumers(control, {"helper_container_id": seed["helper"]["container_id"]},
                            {stop["backend"]["container_id"], stop["frontend"]["container_id"]})
    preview_relative = seed["stop_request_path"].removeprefix("/opt/fullmag/control/").rsplit("/", 1)[0] + "/finish-preview.json"
    source_sha = digest(Path(__file__).read_bytes())
    if args.apply:
        preview = control.read(preview_relative)
        require(preview.get("request_sha256") == args.request_sha256 and preview.get("observer_source_sha256") == source_sha
                and preview.get("state") == "observation-preview-passed", "Same observer preview required before finish")
    result_path = str(Path(seed["stop_request_path"]).with_name("kernel-stop-proof.json"))
    code = ("import sys,json;sys.path.insert(0,'/opt/fullmag/source/scripts');import docker_volume_succeeded_namespace_recovery as c;"
            "bundle=c.strict_json(sys.stdin.buffer.read());print(json.dumps(c.guest_finish_stop(bundle['stop'],bundle['seed'],sys.argv[1],sys.argv[2]=='apply')))")
    response = docker_capture("exec", "-i", stop["backend"]["container_id"], "python3", "-B", "-c", code,
        result_path, "apply" if args.apply else "preview", data=canonical({"stop": stop, "seed": seed}), timeout=120)
    proof = strict_json(response.stdout)
    require(proof.get("finish_observation_only") is True and proof.get("signals_replayed") is False,
            "Observation finish must not replay any signal")
    if not args.apply:
        control.write(preview_relative, {"state": proof["state"], "request_sha256": args.request_sha256,
            "observer_source_sha256": source_sha, "proof": proof})
        print(json.dumps({"state": proof["state"], "request_sha256": args.request_sha256, "signals_replayed": False}))
        return
    require(proof.get("state") == "native-processes-terminated", "Observation finish did not complete")
    require(control.read_bytes(root + "/receipt.json") == receipt_raw
            and control.read_bytes("active") == (seed["original_attempt"] + "\n").encode(),
            "Original managed observation changed before terminal publication")
    retained_stop_helper(control, receipt, seed["helper"])
    _validate_helper_logged(seed["helper"]["container_id"])
    require_exact_consumers(control, {"helper_container_id": seed["helper"]["container_id"]},
                            {stop["backend"]["container_id"], stop["frontend"]["container_id"]})
    control.write_bytes(root + "/original-unknown-receipt.json", receipt_raw)
    final = {**receipt, "state": "succeeded", "finished_at": time.time(), "result": proof,
        "observation_finish": {"request_sha256": args.request_sha256, "observer_source_sha256": source_sha,
            "original_receipt_sha256": seed["original_receipt_sha256"], "log_ack": log_ack,
            "signals_replayed": False, "scientific_claim_modified": False}}
    control.write(root + "/receipt.json", final)
    control.write(root + "/terminal.json", final)
    control.write("succeeded-namespace-stop/current.json", final)
    control.write("succeeded-namespace-stop/verified.json", final)
    deadline = time.monotonic() + 30
    while docker_capture("inspect", seed["helper"]["container_id"], allow_failure=True).returncode == 0:
        require(time.monotonic() < deadline, "Original helper finalization remains unknown")
        time.sleep(0.2)
    require(control.read_bytes("active", optional=True) is None, "Original helper has not released its active marker")
    print(json.dumps({"state": "native-processes-terminated", "proof_path": result_path,
        "proof_sha256": digest(canonical(proof) + b"\n"), "signals_replayed": False, "solve_replay": False}))


ENGINE_RECEIPT_NAMES = ("engine-before-inspect.json", "engine-sigterm-receipt.json", "engine-stopped-inspect.json",
                        "engine-remove-receipt.json", "engine-after-inspect.json")


def retirement_result_from_receipts(core, seed, receipts):
    require(set(receipts) == set(ENGINE_RECEIPT_NAMES), "Exactly the original five Engine receipts are required")
    for receipt in receipts.values():
        require(receipt.get("schema") == "fullmag.succeeded-namespace-engine-command.v1"
                and receipt.get("engine_id_sha256") == core["docker_engine_id_sha256"], "Engine receipt identity differs")
    cid = core["old_container_id"]
    before = inspect_receipt(receipts[ENGINE_RECEIPT_NAMES[0]], cid)
    stopped = inspect_receipt(receipts[ENGINE_RECEIPT_NAMES[2]], cid)
    require_container(before, seed["backend"], core["compose_project"], "backend")
    require_container(stopped, seed["backend"], core["compose_project"], "backend", running=False)
    require(before["Image"] == core["old_image_id"] and before.get("HostConfig", {}).get("PidMode", "") == ""
            and any(m.get("Type") == "volume" and m.get("Name") == core["private_volume_name"]
                    and m.get("Destination") == "/opt/fullmag/control" and m.get("RW") is True for m in before["Mounts"]),
            "Original private namespace or volume pin differs")
    signal = receipts[ENGINE_RECEIPT_NAMES[1]]
    require(signal.get("argv") == ["kill", "--signal", "TERM", cid] and signal.get("exit_code") == 0
            and signal.get("stdout", "").strip() == cid and not signal.get("stderr", "").strip(),
            "Original exact SIGTERM receipt differs")
    validate_removed(cid, receipts[ENGINE_RECEIPT_NAMES[3]])
    validate_not_found(cid, receipts[ENGINE_RECEIPT_NAMES[4]])
    return {"schema": "fullmag.succeeded-namespace-retirement.v1", "state": "removed-confirmed",
        "core_request_sha256": digest(canonical(core)), "old_container_id": cid,
        "engine_id_sha256": core["docker_engine_id_sha256"], "finished_at": stopped_namespace(stopped, core),
        "stop_signal": "SIGTERM", "stop_escalated": False, "stopped_pid": 0, "descendant_count": 0,
        "engine_transport": "docker_cli", "remove_exit_code": 0, "after_inspect_exit_code": 1,
        "after_inspect_error": "no_such_container", "solve_replay": False}


def validate_retirement_archive(control, seed):
    inventory = control_document(control, seed["layer_inventory_path"], seed["layer_inventory_sha256"])
    require(not inventory.get("unknown_paths") and SHA.fullmatch(inventory.get("canonical_diff_sha256", "")),
            "Original layer archive is unqualified")
    total = 0
    base = str(Path(seed["layer_inventory_path"]).parent).removeprefix("/opt/fullmag/control/")
    for row in inventory["entries"]:
        if row.get("disposition") == "preserved-control-file":
            require(row.get("recognized_runtime_path") is True and recognized_layer_path(row.get("path", ""))
                    and type(row.get("size")) is int and 0 <= row["size"] <= MAX_BYTES,
                    "Archived layer payload escaped its bound")
            total += row["size"]
            require(total <= 64 * 1024 * 1024 and SHA.fullmatch(row.get("sha256", "")), "Archived layer budget or hash differs")
            raw = control.read_bytes(base + "/layer-files/" + row["sha256"] + ".bin")
            require(len(raw) == row["size"] and digest(raw) == row["sha256"], "Preserved layer payload changed")
    require(total == inventory["preserved_bytes"], "Original layer archive byte total differs")


def validate_current_retirement_intent(control, before, core, expected):
    import docker_backend_volume_cache as cache
    from docker_dev_recovery_build import inspect_one
    mounts = [m for m in before["Mounts"] if m.get("Destination") == "/host-ledger"]
    require(len(mounts) == 1, "Original host-ledger mount is ambiguous")
    volume = inspect_one("volume", control.volume)
    subpath = cache._observed_volume_subpath(before, mounts[0], "/host-ledger", control.volume, volume["Mountpoint"])
    roots = [value.split("=", 1)[1] for value in before["Config"].get("Env", []) if value.startswith("FULLMAG_HOST_LEDGER_ROOT=")]
    require(len(roots) == 1 and roots[0].startswith("/host-ledger/") and ".." not in PurePosixPath(roots[0]).parts,
            "Original host-ledger root is not pinned")
    relative = subpath + "/" + str(PurePosixPath(roots[0]).relative_to("/host-ledger"))
    intent = strict_json(control.read_bytes(relative + "/succeeded-namespace-teardowns/" + digest(canonical(core)) + ".json"))
    require(intent == expected and intent.get("request") == core and intent.get("request_sha256") == digest(canonical(core)),
            "The original durable namespace intent changed")
    ledger = strict_json(control.read_bytes(relative + "/HOST_RESOURCE_LEDGER.json"))
    active = [row for row in ledger["reservations"] if row.get("state") != "released"]
    require(len(active) == 1 and active[0].get("state") == "committed"
            and digest(canonical(active[0])) == core["reservation_before_sha256"], "Retained reservation changed or was released")


def run_finish_retirement(args):
    from docker_dev import _compose_identity, _select_source
    from docker_dev_recovery_build import inspect_one
    from docker_volume_activation_reconcile import _validate_helper_logged
    from docker_volume_container_recovery import _docker_engine_sha
    selected, layout = _select_source(Path(args.source_root), args.source_root)
    control = BuildControl(_compose_identity(layout), args.image_id)
    observer = control_document(control, "/opt/fullmag/control/" + args.request, args.request_sha256)
    fields = {"schema", "source_root", "compose_project", "retirement_request_path", "retirement_request_sha256",
        "original_attempt", "original_receipt_sha256", "original_controller_sha256", "helper", "engine_receipts"}
    require(set(observer) == fields and observer["schema"] == "fullmag.succeeded-namespace-retirement-finish.v1"
            and observer["source_root"] == str(selected) and observer["compose_project"] == control.project
            and re.fullmatch(r"[0-9a-f]{32}", observer["original_attempt"]), "Unsupported retirement observation finish")
    seed = control_document(control, observer["retirement_request_path"], observer["retirement_request_sha256"])
    native = control_document(control, seed["native_request_path"], seed["native_request_sha256"])
    core = native["teardown"]
    require(seed.get("schema") == "fullmag.succeeded-namespace-retirement-request.v1"
            and seed.get("source_root") == str(selected) and seed.get("compose_project") == control.project
            and core["private_volume_name"] == control.volume and core["docker_engine_id_sha256"] == _docker_engine_sha(),
            "Original retirement source, Engine or private volume differs")
    intent = control_document(control, seed["native_intent_path"], seed["native_intent_sha256"])
    root = "succeeded-namespace-retirement/attempts/" + observer["original_attempt"]
    receipt_raw = control.read_bytes(root + "/receipt.json")
    require(digest(receipt_raw) == observer["original_receipt_sha256"], "Original unknown retirement receipt changed")
    receipt = strict_json(receipt_raw)
    require(receipt.get("schema") == "fullmag.docker-build-operation.v1"
            and receipt.get("phase") == "succeeded-namespace-retirement"
            and receipt.get("state") == "outcome-unknown-resources-retained"
            and receipt.get("attempt") == observer["original_attempt"] and receipt.get("compose_project") == control.project
            and receipt.get("control_volume") == control.volume
            and receipt.get("helper_container") == "fullmag-control-" + observer["original_attempt"]
            and receipt.get("inputs", {}).get("source_root") == str(selected)
            and receipt["inputs"].get("request_sha256") == observer["retirement_request_sha256"]
            and receipt["inputs"].get("controller_sha256") == observer["original_controller_sha256"],
            "Original unknown managed retirement identity differs")
    require(control.read_bytes("active") == (observer["original_attempt"] + "\n").encode(), "Original active marker changed")
    retained_stop_helper(control, receipt, observer["helper"], "succeeded-namespace-retirement")
    log_ack = _validate_helper_logged(observer["helper"]["container_id"])
    expected_consumers = {"helper_container_id": observer["helper"]["container_id"]}
    require_exact_consumers(control, expected_consumers, {seed["frontend"]["container_id"]})
    require_container(inspect_one("container", seed["frontend"]["container_id"]), seed["frontend"], control.project, "frontend")
    require(set(observer["engine_receipts"]) == set(ENGINE_RECEIPT_NAMES), "The original five receipt pins are required")
    records = {name: control_document(control, seed["engine_receipts_directory"] + "/" + name, observer["engine_receipts"][name])
               for name in ENGINE_RECEIPT_NAMES}
    result = retirement_result_from_receipts(core, seed, records)
    before = inspect_receipt(records[ENGINE_RECEIPT_NAMES[0]], core["old_container_id"])
    validate_current_retirement_intent(control, before, core, intent)
    validate_retirement_archive(control, seed)
    engine_root = seed["engine_receipts_directory"].removeprefix("/opt/fullmag/control/")
    state = control.read(engine_root + "/retirement-state.json")
    expected_intent = {"schema": "fullmag.succeeded-namespace-retirement-intent.v1", "core_request_sha256": digest(canonical(core)),
        "native_request_sha256": seed["native_request_sha256"], "backend": seed["backend"], "frontend": seed["frontend"],
        "engine_id_sha256": core["docker_engine_id_sha256"], "layer_inventory_sha256": seed["layer_inventory_sha256"], "stop_signal": "SIGTERM"}
    require(state == {"intent": expected_intent, "state": "sigterm-planned"}, "Original retirement intent changed")
    fresh = engine_receipt(core["docker_engine_id_sha256"], ["inspect", core["old_container_id"]],
        docker_capture("inspect", core["old_container_id"], allow_failure=True))
    validate_not_found(core["old_container_id"], fresh)
    require(_docker_engine_sha() == core["docker_engine_id_sha256"], "Engine changed during observation")
    result.update(before_inspect_sha256=observer["engine_receipts"][ENGINE_RECEIPT_NAMES[0]],
        stop_signal_receipt_sha256=observer["engine_receipts"][ENGINE_RECEIPT_NAMES[1]],
        stopped_inspect_sha256=observer["engine_receipts"][ENGINE_RECEIPT_NAMES[2]],
        remove_receipt_sha256=observer["engine_receipts"][ENGINE_RECEIPT_NAMES[3]],
        after_inspect_sha256=observer["engine_receipts"][ENGINE_RECEIPT_NAMES[4]],
        finish_observation_only=True, signals_replayed=False, removal_replayed=False)
    source_sha = digest(Path(__file__).read_bytes())
    preview_path = engine_root + "/finish-preview.json"
    if not args.apply:
        control.write(preview_path, {"request_sha256": args.request_sha256, "observer_source_sha256": source_sha,
            "state": "retirement-observation-preview-passed", "result": result})
        print(json.dumps({"state": "retirement-observation-preview-passed", "signals_replayed": False, "removal_replayed": False}))
        return
    preview = control.read(preview_path)
    require(preview.get("request_sha256") == args.request_sha256 and preview.get("observer_source_sha256") == source_sha
            and preview.get("result") == result, "Same retirement observation preview required")
    retained_stop_helper(control, receipt, observer["helper"], "succeeded-namespace-retirement")
    require(control.read_bytes(root + "/receipt.json") == receipt_raw
            and control.read_bytes("active") == (observer["original_attempt"] + "\n").encode(), "Original operation changed before finalization")
    require_exact_consumers(control, expected_consumers, {seed["frontend"]["container_id"]})
    control.write(engine_root + "/finish-after-inspect-observation.json", fresh)
    control.write(engine_root + "/retirement-result.json", result)
    control.write(engine_root + "/retirement-state.json", {"intent": expected_intent, "state": "removed-confirmed", "result": result})
    control.write_bytes(root + "/original-unknown-receipt.json", receipt_raw)
    final = {**receipt, "state": "succeeded", "finished_at": time.time(), "result": result,
        "observation_finish": {"request_sha256": args.request_sha256, "observer_source_sha256": source_sha,
            "original_receipt_sha256": observer["original_receipt_sha256"], "log_ack": log_ack,
            "signals_replayed": False, "removal_replayed": False, "scientific_claim_modified": False}}
    control.write(root + "/receipt.json", final)
    control.write(root + "/terminal.json", final)
    control.write("succeeded-namespace-retirement/current.json", final)
    control.write("succeeded-namespace-retirement/verified.json", final)
    deadline = time.monotonic() + 30
    while docker_capture("inspect", observer["helper"]["container_id"], allow_failure=True).returncode == 0:
        require(time.monotonic() < deadline, "Original retirement helper finalization is unknown")
        time.sleep(0.2)
    require(control.read_bytes("active", optional=True) is None, "Original retirement helper retained its active marker")
    print(json.dumps({"state": "removed-confirmed", "result_path": "/opt/fullmag/control/" + engine_root + "/retirement-result.json",
        "result_sha256": digest(canonical(result) + b"\n"), "signals_replayed": False, "removal_replayed": False}))


def validate_stopped_fms_tar(raw, path, expected_sha256):
    import io
    import tarfile
    require(0 < len(raw) <= MAX_BYTES, "Stopped FMS transport exceeds its bound")
    try:
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as archive:
            members = archive.getmembers()
            require(len(members) == 1 and members[0].isreg() and not members[0].issparse()
                    and members[0].name == PurePosixPath(path).name and 0 < members[0].size <= MAX_BYTES,
                    "Stopped FMS must be exactly its bounded regular basename")
            payload = archive.extractfile(members[0]).read(MAX_BYTES + 1)
            require(len(payload) == members[0].size and digest(payload) == expected_sha256, "Saved FMS bytes changed")
    except tarfile.TarError as error:
        raise BuildControlError("Stopped FMS archive is incomplete or malformed") from error


def inspect_mount_order_sha256(actual):
    from copy import deepcopy
    value = deepcopy(actual)
    mounts = value.get("Mounts")
    require(isinstance(mounts, list) and all(isinstance(mount, dict)
            and isinstance(mount.get("Destination"), str) for mount in mounts), "Inspect mounts must have explicit destinations")
    require(len({mount["Destination"] for mount in mounts}) == len(mounts), "Inspect has duplicate mount destinations")
    value["Mounts"] = sorted(mounts, key=lambda mount: mount["Destination"])
    return digest(canonical(value))


def matching_original_daemon_binds(authored, actual):
    observed = {mount["Destination"]: mount["Source"] for mount in actual["Mounts"] if mount["Type"] == "bind"}
    return {target: source for target, source in authored["services"]["backend"].get("x-fullmag-daemon-binds", {}).items()
            if observed.get(target) == source}


FAILED_GUEST_PID1_STDERR = b"succeeded namespace guest refused: namespace recovery guest must be the Linux backend PID1\n"


def validate_failed_guest_pid1(actual, pin, image, logs):
    require(container_pin(actual) == pin and actual.get("Image") == image
            and actual.get("HostConfig", {}).get("Init") is True
            and actual.get("HostConfig", {}).get("PidMode", "") == "", "Failed guest incarnation or PID1 cause differs")
    state = actual.get("State", {})
    require(state.get("Running") is False and state.get("Pid") == 0 and state.get("ExitCode") == 1
            and state.get("OOMKilled") is False and state.get("Restarting") is False
            and isinstance(state.get("FinishedAt"), str) and bool(state["FinishedAt"]) and not state["FinishedAt"].startswith("0001-"),
            "The exact failed guest is not confirmed exited1 without OOM")
    require(logs.returncode == 0 and logs.stdout == b"" and logs.stderr == FAILED_GUEST_PID1_STDERR,
            "Failed guest logs do not prove the exact pre-write PID1 guard")


def run_finish_failed_recreate(args):
    from copy import deepcopy
    from docker_dev import _compose_identity, _select_source
    from docker_dev_recovery_build import inspect_one
    from docker_volume_dev import _validate_retained_service
    from docker_volume_activation_reconcile import _validate_helper_logged
    from docker_volume_container_recovery import _docker_engine_sha
    selected, layout = _select_source(Path(args.source_root), args.source_root)
    control = BuildControl(_compose_identity(layout), args.image_id)
    observer = control_document(control, "/opt/fullmag/control/" + args.request, args.request_sha256)
    fields = {"schema", "source_root", "compose_project", "recreate_request_path", "recreate_request_sha256",
        "original_attempt", "original_receipt_sha256", "original_controller_sha256", "planned_compose_sha256",
        "helper", "failed_backend", "expected_observation_sha256"}
    require(set(observer) == fields and observer["schema"] == "fullmag.succeeded-namespace-failed-recreate-finish.v1"
            and observer["source_root"] == str(selected) and observer["compose_project"] == control.project
            and re.fullmatch(r"[0-9a-f]{32}", observer["original_attempt"]), "Unsupported failed recreate observation")
    seed = control_document(control, observer["recreate_request_path"], observer["recreate_request_sha256"])
    require(seed.get("schema") == "fullmag.succeeded-namespace-recreate-request.v1"
            and seed.get("source_root") == str(selected) and seed.get("compose_project") == control.project,
            "Original recreate source differs")
    native = control_document(control, seed["native_request_path"], seed["native_request_sha256"])
    guest = control_document(control, seed["guest_request_path"], seed["guest_request_sha256"])
    core = native["teardown"]
    require(guest.get("teardown") == core and core["private_volume_name"] == control.volume
            and core["docker_engine_id_sha256"] == _docker_engine_sha(), "Failed recreate core or Engine differs")
    root = "succeeded-namespace-recreate/attempts/" + observer["original_attempt"]
    receipt_raw = control.read_bytes(root + "/receipt.json")
    require(digest(receipt_raw) == observer["original_receipt_sha256"], "Original failed recreate receipt changed")
    receipt = strict_json(receipt_raw)
    require(receipt.get("schema") == "fullmag.docker-build-operation.v1" and receipt.get("phase") == "succeeded-namespace-recreate"
            and receipt.get("state") == "outcome-unknown-resources-retained" and receipt.get("attempt") == observer["original_attempt"]
            and receipt.get("compose_project") == control.project and receipt.get("control_volume") == control.volume
            and receipt.get("helper_container") == "fullmag-control-" + observer["original_attempt"]
            and receipt.get("inputs", {}).get("source_root") == str(selected)
            and receipt["inputs"].get("request_sha256") == observer["recreate_request_sha256"]
            and receipt["inputs"].get("controller_sha256") == observer["original_controller_sha256"],
            "Original retained recreate identity differs")
    require(control.read_bytes("active") == (observer["original_attempt"] + "\n").encode(), "Original active marker changed")
    retained_stop_helper(control, receipt, observer["helper"], "succeeded-namespace-recreate")
    log_ack = _validate_helper_logged(observer["helper"]["container_id"])
    planned_raw = control.read_bytes(root + "/compose.json")
    require(digest(planned_raw) == observer["planned_compose_sha256"], "Original guest Compose plan changed")
    planned = strict_json(planned_raw)
    authored = control_document(control, seed["compose_path"], seed["compose_sha256"])
    expected = deepcopy(authored)
    expected["services"]["backend"]["entrypoint"] = ["/usr/local/bin/python3", "-B",
        "/opt/fullmag/source/scripts/docker_volume_succeeded_namespace_guest.py", "--request", seed["guest_request_path"],
        "--request-sha256", seed["guest_request_sha256"]]
    expected["services"]["backend"]["command"] = []
    require(planned == expected and planned["services"]["backend"].get("init") is True, "Failed guest plan is not the exact init=true attempt")
    actual = inspect_one("container", observer["failed_backend"]["container_id"])
    logs = docker_capture("logs", actual["Id"], allow_failure=True)
    validate_failed_guest_pid1(actual, observer["failed_backend"], args.image_id, logs)
    checked = deepcopy(planned)
    checked["services"]["backend"]["x-fullmag-daemon-binds"] = matching_original_daemon_binds(authored, actual)
    _validate_retained_service(checked, actual, "backend", inspect_one("image", args.image_id).get("Config", {}))
    require(digest(regular(selected / "scripts/docker_volume_succeeded_namespace_guest.py")) == guest["guest_sha256"],
            "The PID1 guard source differs from the pinned guest")
    status = Path(guest["status_path"])
    absent = [status, status.with_suffix(".started.json"), status.with_suffix(".native-preview.json"),
        status.with_suffix(".handoff-committed.json"), Path(guest["resume_intent_path"]),
        Path(seed["guest_request_path"]).with_name("engine-attestation.json")]
    for path in absent:
        require(str(path).startswith("/opt/fullmag/control/verification/") and ".." not in path.parts
                and control.read_bytes(str(path).removeprefix("/opt/fullmag/control/"), optional=True) is None,
                "Guest start, API, resume or attestation evidence exists; refuse no-spawn classification")
    candidate = managed_candidate_result(control, native, selected)
    require(guest["candidate_path"] == candidate["candidate"] and guest["candidate_receipt_sha256"] == native["package_receipt_sha256"]
            and guest["source_snapshot_sha256"] == native["source_snapshot_sha256"], "Candidate provenance changed")
    state_mounts = [mount for mount in authored["services"]["backend"]["volumes"] if mount.get("target") == "/state"]
    archive = PurePosixPath(guest["fms_archive_path"])
    require(len(state_mounts) == 1 and state_mounts[0].get("type") == "bind"
            and archive.is_relative_to(PurePosixPath("/state")) and ".." not in archive.parts, "Saved FMS has no exact authored state bind")
    validate_stopped_fms_tar(docker_capture("cp", actual["Id"] + ":" + str(archive), "-").stdout,
        str(archive), guest["fms_archive_sha256"])
    before_receipt = control_document(control, native["engine_receipts_directory"] + "/engine-before-inspect.json",
        control_document(control, seed["retirement_result_path"], seed["retirement_result_sha256"])["before_inspect_sha256"])
    intent = {"schema_version": "host_succeeded_worker_namespace_teardown_intent.v1",
        "request_sha256": digest(canonical(core)), "request": core}
    require(digest(canonical(intent)) == guest["teardown_intent_sha256"], "Original intent provenance changed")
    validate_current_retirement_intent(control, inspect_receipt(before_receipt, core["old_container_id"]), core, intent)
    require_container(inspect_one("container", seed["frontend"]["container_id"]), seed["frontend"], control.project, "frontend")
    require_exact_consumers(control, {"helper_container_id": observer["helper"]["container_id"]}, {actual["Id"], seed["frontend"]["container_id"]})
    require(_docker_engine_sha() == core["docker_engine_id_sha256"], "Engine changed during failed-start observation")
    proof = {"schema": "fullmag.succeeded-namespace-failed-recreate-observation.v1", "original_attempt": observer["original_attempt"],
        "failed_container_id": actual["Id"], "inspect_sha256": inspect_mount_order_sha256(actual), "stderr_sha256": digest(logs.stderr),
        "guest_request_sha256": seed["guest_request_sha256"], "candidate_receipt_sha256": native["package_receipt_sha256"],
        "source_snapshot_sha256": native["source_snapshot_sha256"], "fms_archive_sha256": guest["fms_archive_sha256"],
        "observer_source_sha256": digest(Path(__file__).read_bytes()), "api_started": False, "solve_replayed": False,
        "signals_replayed": False, "removal_replayed": False, "reservations_modified": False}
    proof_sha = digest(canonical(proof))
    if not args.apply:
        print(json.dumps({"state": "failed-recreate-observation-preview-passed", "observation_sha256": proof_sha, "proof": proof}))
        return
    require(observer["expected_observation_sha256"] == proof_sha, "Exact read-only observation must be approved before finalization")
    require(control.read_bytes(root + "/receipt.json") == receipt_raw
            and control.read_bytes("active") == (observer["original_attempt"] + "\n").encode(), "Original recreate changed before finalization")
    retained_stop_helper(control, receipt, observer["helper"], "succeeded-namespace-recreate")
    control.write_bytes(root + "/original-unknown-receipt.json", receipt_raw)
    control.write(root + "/failed-guest-observation.json", proof)
    control.write(root + "/failed-guest-inspect.json", actual)
    control.write_bytes(root + "/failed-guest-stderr.log", logs.stderr)
    final = {**receipt, "state": "failed-confirmed", "finished_at": time.time(), "failure_observation": proof,
             "observation_sha256": proof_sha, "log_ack": log_ack, "scientific_claim_modified": False}
    control.write(root + "/receipt.json", final)
    control.write(root + "/terminal.json", final)
    control.write("succeeded-namespace-recreate/current.json", final)
    deadline = time.monotonic() + 30
    while docker_capture("inspect", observer["helper"]["container_id"], allow_failure=True).returncode == 0:
        require(time.monotonic() < deadline, "Original failed-recreate helper finalization is unknown")
        time.sleep(0.2)
    require(control.read_bytes("active", optional=True) is None, "Original helper retained its active marker")
    print(json.dumps({"state": "failed-confirmed", "observation_sha256": proof_sha, "container_preserved": True,
        "api_started": False, "solve_replayed": False, "removal_replayed": False}))


def control_document(control, path, sha):
    require(isinstance(path, str) and path.startswith("/opt/fullmag/control/verification/")
            and ".." not in PurePosixPath(path).parts and SHA.fullmatch(sha), "Evidence escaped private verification root")
    raw = control.read_bytes(path.removeprefix("/opt/fullmag/control/"))
    require(digest(raw) == sha, "Pinned recovery document changed")
    return strict_json(raw)


def managed_candidate_result(control, native, source_root):
    storage = native.get("candidate_storage")
    require(isinstance(storage, dict), "Pinned managed candidate storage is required")
    result_path, terminal_path = storage.get("managed_result_path"), storage.get("managed_terminal_path")
    match = re.fullmatch(r"/opt/fullmag/control/recovery-build/attempts/([0-9a-f]{32})/result\.json", result_path or "")
    require(match is not None and terminal_path == str(Path(result_path).with_name("terminal.json")),
            "Managed candidate evidence escaped its exact recovery-build attempt")
    def pinned(path, sha):
        require(isinstance(sha, str) and SHA.fullmatch(sha), "Managed candidate digest is malformed")
        raw = control.read_bytes(path.removeprefix("/opt/fullmag/control/"))
        require(digest(raw) == sha, "Managed candidate evidence changed")
        return strict_json(raw)
    terminal = pinned(terminal_path, storage.get("managed_terminal_sha256"))
    result = pinned(result_path, storage.get("managed_result_sha256"))
    stop_proof = control_document(control, native["stop_proof_path"], native["stop_proof_sha256"])
    diagnostic_pin = stop_proof.get("post_stop_process_receipt_sha256")
    require(stop_proof.get("schema") == STOP_PROOF_SCHEMA and stop_proof.get("state") == "native-processes-terminated"
            and stop_proof.get("request_sha256") == native["stop_request_sha256"]
            and stop_proof.get("process_exit_status") == "unknown"
            and stop_proof.get("reservation_released") is False and stop_proof.get("solve_replay") is False
            and isinstance(diagnostic_pin, str) and SHA.fullmatch(diagnostic_pin),
            "Managed build requires its exact post-stop diagnostic process receipt")
    core, inputs = native["teardown"], terminal.get("inputs", {})
    require(terminal.get("schema") == "fullmag.docker-build-operation.v1"
            and terminal.get("phase") == "recovery-build" and terminal.get("state") == "succeeded"
            and terminal.get("attempt") == match[1] and terminal.get("compose_project") == control.project
            and terminal.get("control_volume") == control.volume and terminal.get("image_id") == core["old_image_id"]
            and inputs.get("source_root") == str(source_root) and inputs.get("compose_project") == control.project
            and inputs.get("image_id") == core["old_image_id"] and inputs.get("backend_container_id") == core["old_container_id"]
            and inputs.get("source_commit") == native["build_commit"]
            and inputs.get("owner_sha256") == native["owner_sha256"]
            and inputs.get("process_receipt_sha256") == diagnostic_pin
            and inputs.get("diagnostic_api_only") is True and terminal.get("candidate") == result,
            "Managed candidate terminal does not bind this completed build")
    source = result.get("source", {})
    require(result.get("schema") == "fullmag.docker-recovery-build.v1" and result.get("state") == "ready"
            and result.get("package_promoted") is False and result.get("runtime_started") is False
            and result.get("receipt_sha256") == native["package_receipt_sha256"]
            and source.get("resolved_commit") == native["build_commit"]
            and source.get("source_snapshot_sha256") == native["source_snapshot_sha256"],
            "Managed result does not identify this unpublished compiled candidate")
    return result


def run_recreate(args):
    from copy import deepcopy
    from docker_build_control import compose_capture
    from docker_dev import _compose_identity, _select_source
    from docker_dev_recovery_build import inspect_one
    from docker_volume_dev import _validate_retained_service
    from docker_compose_identity import validate_source_labels
    from docker_volume_container_recovery import _docker_engine_sha
    selected, layout = _select_source(Path(args.source_root), args.source_root)
    control = BuildControl(_compose_identity(layout), args.image_id)
    seed = control_document(control, "/opt/fullmag/control/" + args.request, args.request_sha256)
    fields = {"schema", "source_root", "compose_project", "native_request_path", "native_request_sha256",
              "guest_request_path", "guest_request_sha256", "compose_path", "compose_sha256",
              "retirement_result_path", "retirement_result_sha256", "frontend"}
    require(set(seed) == fields and seed["schema"] == "fullmag.succeeded-namespace-recreate-request.v1"
            and seed["source_root"] == str(selected) and seed["compose_project"] == control.project,
            "Unsupported backend-only recreation request")
    native = control_document(control, seed["native_request_path"], seed["native_request_sha256"])
    core = native["teardown"]
    guest = control_document(control, seed["guest_request_path"], seed["guest_request_sha256"])
    retired = control_document(control, seed["retirement_result_path"], seed["retirement_result_sha256"])
    document = control_document(control, seed["compose_path"], seed["compose_sha256"])
    require(native.get("schema_version") == "runtime_service_succeeded_namespace_recovery.v1"
            and guest.get("schema") == "fullmag.succeeded-namespace-guest.v1"
            and guest.get("teardown") == core and guest.get("teardown_request_sha256") == digest(canonical(core))
            and retired.get("schema") == "fullmag.succeeded-namespace-retirement.v1"
            and retired.get("state") == "removed-confirmed" and retired.get("core_request_sha256") == digest(canonical(core))
            and retired.get("old_container_id") == core["old_container_id"]
            and document.get("name") == control.project and set(document.get("services", {})) == {"backend", "frontend"},
            "Recreation core, retirement or Compose identity differs")
    require(core["private_volume_name"] == control.volume and core["docker_engine_id_sha256"] == _docker_engine_sha(),
            "Recreation private volume or Engine differs")
    receipt_root = native["engine_receipts_directory"]
    before = control_document(control, receipt_root + "/engine-before-inspect.json", retired["before_inspect_sha256"])
    original = inspect_receipt(before, core["old_container_id"])
    image = inspect_one("image", args.image_id)
    _validate_retained_service(document, original, "backend", image.get("Config", {}))
    configured = deepcopy(document)
    # The diagnostic guest owns PID1 and its children; Docker's init would take PID1.
    configured["services"]["backend"]["init"] = False
    # Daemon spellings belong to the old incarnation. The unchanged validator
    # first proves new binds against their canonical authored host paths.
    configured["services"]["backend"].pop("x-fullmag-daemon-binds", None)
    configured["services"]["backend"]["entrypoint"] = ["/usr/local/bin/python3", "-B",
        "/opt/fullmag/source/scripts/docker_volume_succeeded_namespace_guest.py", "--request", seed["guest_request_path"],
        "--request-sha256", seed["guest_request_sha256"]]
    configured["services"]["backend"]["command"] = []
    inputs = {"request_sha256": args.request_sha256, "source_root": str(selected),
              "controller_sha256": digest(Path(__file__).read_bytes())}
    with control.operation("succeeded-namespace-recreate", inputs) as operation:
        frontend = inspect_one("container", seed["frontend"]["container_id"])
        require_container(frontend, seed["frontend"], control.project, "frontend")
        absent = engine_receipt(core["docker_engine_id_sha256"], ["inspect", core["old_container_id"]],
            docker_capture("inspect", core["old_container_id"], allow_failure=True))
        validate_not_found(core["old_container_id"], absent)
        existing = docker_capture("ps", "--all", "--quiet", "--filter", "label=com.docker.compose.project=" + control.project,
            "--filter", "label=com.docker.compose.service=backend").stdout.decode().strip()
        require(not existing, "A backend already occupies this group; refusing implicit replacement")
        resolved = strict_json(compose_capture(configured, "config", "--format", "json", timeout=60))
        require(resolved.get("name") == control.project and set(resolved.get("services", {})) == {"backend", "frontend"},
                "Recreation Compose resolution changed group or services")
        require(resolved["services"]["backend"].get("init") is False, "Guest Compose must preserve explicit init=false")
        control.write(operation["root"] + "/compose.json", configured)
        require_exact_consumers(control, operation, {frontend["Id"]})
        operation["daemon_pending"] = True
        compose_capture(configured, "up", "--detach", "--no-deps", "--no-build", "--pull", "never", "backend", timeout=180)
        ids = docker_capture("ps", "--all", "--no-trunc", "--quiet", "--filter", "label=com.docker.compose.project=" + control.project,
            "--filter", "label=com.docker.compose.service=backend").stdout.decode().split()
        require(len(ids) == 1 and ids[0] != core["old_container_id"], "Recreated backend identity is ambiguous")
        actual = inspect_one("container", ids[0])
        require_exact_consumers(control, operation, {actual["Id"], frontend["Id"]})
        require(actual["Image"] == args.image_id and actual["State"].get("Running") is True
                and actual.get("HostConfig", {}).get("PidMode", "") == "", "Recreated image or private namespace differs")
        configured["services"]["backend"]["x-fullmag-daemon-binds"] = matching_original_daemon_binds(document, actual)
        _validate_retained_service(configured, actual, "backend", image.get("Config", {}))
        require(actual.get("HostConfig", {}).get("Init") is False, "Diagnostic guest must own PID1 without Docker init")
        configured["services"]["backend"]["x-fullmag-daemon-binds"] = {
            mount["Destination"]: mount["Source"] for mount in actual["Mounts"] if mount["Type"] == "bind"}
        control.write(operation["root"] + "/compose.json", configured)
        validate_source_labels(actual, control.identity)
        require_container(inspect_one("container", frontend["Id"]), seed["frontend"], control.project, "frontend")
        deadline = time.monotonic() + 60
        status_relative = guest["status_path"].removeprefix("/opt/fullmag/control/")
        while True:
            status_raw = control.read_bytes(status_relative, optional=True)
            if status_raw is not None:
                status = strict_json(status_raw)
                break
            require(time.monotonic() < deadline, "Diagnostic guest did not publish status; no fallback start authorized")
            time.sleep(0.2)
        require(status.get("schema") == "fullmag.succeeded-namespace-guest-status.v1"
                and status.get("state") == "diagnostic_api" and status.get("guest_request_sha256") == seed["guest_request_sha256"]
                and status.get("execution_container_id") == actual["Id"]
                and status.get("execution_pid_namespace") != core["pid_namespace"] and status.get("solve_replay") is False,
                "Diagnostic guest incarnation differs")
        require(_docker_engine_sha() == core["docker_engine_id_sha256"], "Engine changed during recreation")
        attestation = {"schema_version": "docker_succeeded_worker_namespace_teardown_attestation.v1",
            "request_sha256": digest(canonical(core)), "intent_sha256": guest["teardown_intent_sha256"],
            **{key: core[key] for key in ("docker_engine_id_sha256", "old_container_id", "old_image_id", "compose_project",
                "private_volume_name", "pid_namespace", "boot_id", "cgroup_sha256")},
            **{key: retired[key] for key in ("before_inspect_sha256", "stop_signal_receipt_sha256", "stopped_inspect_sha256",
                "remove_receipt_sha256", "after_inspect_sha256", "finished_at")},
            "engine_transport": "docker_cli", "remove_exit_code": 0, "after_inspect_exit_code": 1,
            "after_inspect_error": "no_such_container", "stop_signal": "SIGTERM", "stop_escalated": False,
            "stopped_pid": 0, "descendant_count": 0, "new_container_id": actual["Id"],
            "new_pid_namespace": status["execution_pid_namespace"], "task_outcome": "succeeded",
            "process_exit_status": "unknown", "solve_replay": False}
        target = Path(seed["guest_request_path"]).with_name("engine-attestation.json").as_posix()
        relative = target.removeprefix("/opt/fullmag/control/")
        old = control.read_bytes(relative, optional=True)
        raw = canonical(attestation) + b"\n"
        require(old is None or old == raw, "Engine attestation publication differs")
        if old is None:
            control.write_bytes(relative, raw)
        result = {"state": "diagnostic-backend-recreated", "backend": container_pin(actual),
            "guest_status_path": guest["status_path"], "guest_status_sha256": digest(status_raw),
            "attestation_path": target, "attestation_sha256": digest(raw), "solve_replay": False}
        control.write(operation["root"] + "/result.json", result)
        operation["daemon_pending"] = False
        operation["receipt"].update(state="succeeded", result=result)
        print(json.dumps(result))


def run_native(args):
    from docker_dev import _compose_identity, _select_source
    from docker_dev_recovery_build import inspect_one
    from docker_compose_identity import validate_source_labels
    from docker_volume_container_recovery import _docker_engine_sha
    selected, layout = _select_source(Path(args.source_root), args.source_root)
    control = BuildControl(_compose_identity(layout), args.image_id)
    seed = control_document(control, "/opt/fullmag/control/" + args.request, args.request_sha256)
    fields = {"schema", "source_root", "compose_project", "backend", "frontend", "native_request_path",
              "native_request_sha256", "mode", "result_path"}
    require(set(seed) == fields and seed["schema"] == "fullmag.succeeded-namespace-native-command.v1"
            and seed["source_root"] == str(selected) and seed["compose_project"] == control.project
            and seed["mode"] in {"verify", "begin", "release-preview", "complete", "handoff-preview"},
            "Unsupported managed native recovery command")
    native = control_document(control, seed["native_request_path"], seed["native_request_sha256"])
    core = native["teardown"]
    require(native.get("schema_version") == "runtime_service_succeeded_namespace_recovery.v1"
            and core["private_volume_name"] == control.volume and core["docker_engine_id_sha256"] == _docker_engine_sha(),
            "Native command source or private Engine differs")
    storage = native.get("candidate_storage")
    require(isinstance(storage, dict), "Native command needs an unpublished managed candidate")
    candidate_result = managed_candidate_result(control, native, selected)
    candidate = candidate_result.get("candidate", "")
    require(re.fullmatch(r"/opt/fullmag/package/\.development/candidates/\.backend-package-candidate-[A-Za-z0-9._-]+", candidate)
            and candidate_result.get("state") == "ready" and candidate_result.get("package_promoted") is False,
            "Managed recovery candidate differs")
    result_path = seed["result_path"]
    require(result_path.startswith("/opt/fullmag/control/verification/") and ".." not in PurePosixPath(result_path).parts,
            "Native result escaped private verification")
    command = ["exec", seed["backend"]["container_id"], candidate + "/bin/fullmag-runtime-service",
               "--recover-succeeded-namespace", "--config", "/opt/fullmag/runtime-control/runtime-service/docker-all.json",
               "--request", seed["native_request_path"], "--request-sha256", seed["native_request_sha256"]]
    if seed["mode"] in {"release-preview", "complete", "handoff-preview"}:
        require(isinstance(native.get("attestation_path"), str) and SHA.fullmatch(native.get("attestation_sha256", "")),
                "Native release requires an explicit Engine attestation")
        command += ["--attestation", native["attestation_path"], "--attestation-sha256", native["attestation_sha256"]]
    if seed["mode"] in {"verify", "release-preview", "handoff-preview"}:
        command += ["--verify-only"]
    if seed["mode"] == "handoff-preview":
        command += ["--handoff-preview"]
    inputs = {"request_sha256": args.request_sha256, "source_root": str(selected), "mode": seed["mode"],
              "controller_sha256": digest(Path(__file__).read_bytes())}
    with control.operation("succeeded-namespace-native", inputs) as operation:
        for service in ("backend", "frontend"):
            actual = inspect_one("container", seed[service]["container_id"])
            require_container(actual, seed[service], control.project, service)
            validate_source_labels(actual, control.identity)
        response = docker_capture(*command, timeout=180)
        strict_json(response.stdout)
        require(_docker_engine_sha() == core["docker_engine_id_sha256"], "Engine changed during native recovery")
        relative = result_path.removeprefix("/opt/fullmag/control/")
        previous = control.read_bytes(relative, optional=True)
        require(previous is None or previous == response.stdout, "Native result publication differs")
        if previous is None:
            control.write_bytes(relative, response.stdout)
        result = {"state": "native-command-completed", "mode": seed["mode"], "result_path": result_path,
                  "result_sha256": digest(response.stdout), "solve_replay": False}
        operation["receipt"].update(state="succeeded", result=result)
        print(json.dumps(result))


def run_resume(args):
    from docker_dev import _compose_identity, _select_source
    from docker_dev_recovery_build import inspect_one
    selected, layout = _select_source(Path(args.source_root), args.source_root)
    control = BuildControl(_compose_identity(layout), args.image_id)
    seed = control_document(control, "/opt/fullmag/control/" + args.request, args.request_sha256)
    fields = {"schema", "source_root", "compose_project", "backend", "frontend", "guest_request_path",
              "guest_request_sha256", "resume"}
    require(set(seed) == fields and seed["schema"] == "fullmag.succeeded-namespace-resume-command.v1"
            and seed["source_root"] == str(selected) and seed["compose_project"] == control.project,
            "Unsupported managed resume command")
    guest = control_document(control, seed["guest_request_path"], seed["guest_request_sha256"])
    resume = seed["resume"]
    require(isinstance(resume, dict) and set(resume) == {"schema", "guest_request_sha256", "native_request_path",
        "native_request_sha256", "native_completion_path", "native_completion_sha256", "fms_archive_sha256", "solve_replay"}
        and resume["schema"] == "fullmag.succeeded-namespace-resume.v1" and resume["solve_replay"] is False
        and resume["guest_request_sha256"] == seed["guest_request_sha256"]
        and resume["fms_archive_sha256"] == guest["fms_archive_sha256"], "Guest resume pins differ")
    native = control_document(control, resume["native_request_path"], resume["native_request_sha256"])
    completion = control_document(control, resume["native_completion_path"], resume["native_completion_sha256"])
    require(native.get("teardown") == guest["teardown"] and completion.get("status") == "released"
            and completion.get("schema_version") == "runtime_service_succeeded_namespace_recovery.v1"
            and completion.get("request_sha256") == resume["native_request_sha256"]
            and completion.get("teardown_request_sha256") == digest(canonical(guest["teardown"]))
            and isinstance(completion.get("release_proof_sha256"), str)
            and SHA.fullmatch(completion["release_proof_sha256"])
            and completion.get("task_outcome") == "succeeded" and completion.get("process_exit_status") == "unknown"
            and completion.get("solve_replayed") is False and completion.get("mutations_applied") is True,
            "Only the exact native release can publish a guest resume")
    target = guest["resume_intent_path"]
    require(Path(target).parent == Path(seed["guest_request_path"]).parent,
            "Guest resume escaped its pinned verification directory")
    inputs = {"request_sha256": args.request_sha256, "source_root": str(selected),
              "controller_sha256": digest(Path(__file__).read_bytes())}
    with control.operation("succeeded-namespace-resume", inputs) as operation:
        for service in ("backend", "frontend"):
            require_container(inspect_one("container", seed[service]["container_id"]), seed[service], control.project, service)
        relative = target.removeprefix("/opt/fullmag/control/")
        raw = canonical(resume) + b"\n"
        previous = control.read_bytes(relative, optional=True)
        require(previous is None or previous == raw, "Immutable guest resume already differs")
        if previous is None:
            control.write_bytes(relative, raw)
        result = {"state": "resume-published", "resume_path": target, "resume_sha256": digest(raw), "solve_replay": False}
        operation["receipt"].update(state="succeeded", result=result)
        print(json.dumps(result))


def run_snapshot(args):
    from docker_dev import _compose_identity, _select_source
    from docker_dev_recovery_build import inspect_one
    from docker_compose_identity import validate_source_labels
    from docker_volume_container_recovery import _docker_engine_sha
    selected, layout = _select_source(Path(args.source_root), args.source_root)
    control = BuildControl(_compose_identity(layout), args.image_id)
    require(SHA.fullmatch(args.request_sha256) and args.request.startswith("verification/")
            and ".." not in PurePosixPath(args.request).parts, "Pinned control snapshot seed required")
    raw = control.read_bytes(args.request)
    require(digest(raw) == args.request_sha256, "Snapshot seed bytes changed")
    seed = strict_json(raw)
    require(seed.get("schema") == "fullmag.succeeded-namespace-snapshot-seed.v1"
            and seed.get("source_root") == str(selected) and seed.get("compose_project") == control.project
            and seed.get("private_volume_name") == control.volume
            and seed.get("docker_engine_id_sha256") == _docker_engine_sha(), "Snapshot seed source/Engine/volume differs")
    inputs = {"seed_sha256": args.request_sha256, "source_root": str(selected), "controller_sha256": digest(Path(__file__).read_bytes())}
    with control.operation("succeeded-namespace-snapshot", inputs) as operation:
        for service in ("backend", "frontend"):
            actual = inspect_one("container", seed[service]["container_id"])
            require_container(actual, seed[service], control.project, service)
            validate_source_labels(actual, control.identity)
        code = ("import sys,json; sys.path.insert(0,'/opt/fullmag/source/scripts'); "
                "import docker_volume_succeeded_namespace_recovery as c; "
                "print(json.dumps(c.guest_snapshot(c.strict_json(sys.stdin.buffer.read()))))")
        response = docker_capture("exec", "-i", seed["backend"]["container_id"], "python3", "-B", "-c", code,
                                  data=raw, timeout=120)
        request = validate_stop_request(strict_json(response.stdout))
        require(_docker_engine_sha() == seed["docker_engine_id_sha256"], "Engine changed during snapshot")
        relative = "verification/succeeded-namespace-recovery-20261104/requests/" + request["request_id"] + "/stop-request.json"
        control.write(operation["root"] + "/stop-request.json", request)
        existing = control.read_bytes(relative, optional=True)
        request_raw = canonical(request) + b"\n"
        require(existing is None or existing == request_raw, "Stable snapshot request already differs")
        if existing is None:
            control.write_bytes(relative, request_raw)
        result = {"state": "prepared-no-stop", "stop_request": relative, "stop_request_sha256": digest(canonical(request) + b"\n"),
                  "core_request_sha256": digest(canonical(request["teardown"])), "run_documents": len(request["documents"]),
                  "solve_replay": False}
        operation["receipt"].update(state="succeeded", result=result)
        print(json.dumps(result))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source-root", "image-id", "request", "request-sha256"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--snapshot", action="store_true")
    parser.add_argument("--layer-snapshot", action="store_true")
    parser.add_argument("--retire", action="store_true")
    parser.add_argument("--recreate", action="store_true")
    parser.add_argument("--native", action="store_true")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--finish-stop", action="store_true")
    parser.add_argument("--finish-retirement", action="store_true")
    parser.add_argument("--finish-failed-recreate", action="store_true")
    try:
        args = parser.parse_args()
        require(sum((args.snapshot, args.layer_snapshot, args.retire, args.recreate, args.native, args.resume, args.finish_stop, args.finish_retirement, args.finish_failed_recreate)) <= 1
                and not (args.apply and any((args.snapshot, args.layer_snapshot, args.retire, args.recreate, args.native, args.resume))), "Recovery modes cannot be combined")
        mode = run_snapshot if args.snapshot else run_layer_snapshot if args.layer_snapshot else run_retire if args.retire else run_recreate if args.recreate else run_native if args.native else run_resume if args.resume else run_finish_stop if args.finish_stop else run_finish_retirement if args.finish_retirement else run_finish_failed_recreate if args.finish_failed_recreate else run
        mode(args)
    except (BuildControlError, OSError, ValueError, KeyError) as error:
        parser.exit(2, str(error) + "\n")


if __name__ == "__main__":
    main()
