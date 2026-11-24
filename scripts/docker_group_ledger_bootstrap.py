"""Build one unpromoted ledger-migration candidate in the fixed Compose backend."""
from __future__ import annotations

import argparse
from contextlib import ExitStack, contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile

SCHEMA = "fullmag.group-ledger-bootstrap.v1"
CONTROL = Path("/opt/fullmag/control")
RUNTIME_CONTROL = Path("/opt/fullmag/runtime-control")
SOURCE = Path("/opt/fullmag/source")
LEDGER = Path("/host-ledger")
MAX_RECORD = 8 * 1024**2
ROLES = {"stop_terminal", "backend_drain", "containers", "process", "owner", "config"}
FIELDS = {"schema", "request_id", "compose_project", "source_root", "source_commit",
          "source_manifest_sha256", "source_snapshot_sha256", "bootstrap_script_sha256",
          "old_backend_container_id", "old_backend_started_at", "development_attempt",
          "config_sha256", "control_volume", "records", "current_package",
          "ledger_inventory_sha256", "result_path"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def sha(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def strict_json(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "Duplicate JSON key")
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=unique)


def safe_path(value, root=CONTROL):
    require(isinstance(value, str), "Path must be text")
    path = Path(value)
    require(path.is_absolute() and str(path) == value and ".." not in path.parts
            and path != root and path.is_relative_to(root), "Path escapes its managed root")
    return path


def regular(path, maximum=MAX_RECORD):
    path = Path(path)
    for part in (path, *path.parents):
        require(not part.is_symlink(), "Symlink in evidence path")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
                and before.st_size <= maximum, "Evidence is not a bounded single regular file")
        raw = stream.read(maximum + 1)
        after = os.fstat(stream.fileno())
        current = path.stat(follow_symlinks=False)
        signature = lambda row: (row.st_dev, row.st_ino, row.st_size, row.st_mtime_ns, row.st_ctime_ns)
        require(len(raw) <= maximum and signature(before) == signature(after) == signature(current),
                "Evidence changed during read")
        return raw


def validate_request(value):
    require(isinstance(value, dict) and set(value) == FIELDS and value["schema"] == SCHEMA,
            "Unsupported bootstrap request")
    for name in ("source_manifest_sha256", "source_snapshot_sha256", "bootstrap_script_sha256",
                 "old_backend_container_id", "config_sha256", "ledger_inventory_sha256"):
        require(sha(value[name]), "Invalid " + name)
    require(isinstance(value["source_commit"], str)
            and re.fullmatch(r"[0-9a-f]{40}", value["source_commit"]), "Invalid source commit")
    for name in ("request_id", "development_attempt"):
        require(isinstance(value[name], str) and re.fullmatch(r"[0-9a-f]{32}", value[name]),
                "Invalid " + name)
    for name in ("compose_project", "control_volume"):
        require(isinstance(value[name], str) and re.fullmatch(r"[a-z0-9][a-z0-9_.-]{0,199}", value[name]),
                "Invalid " + name)
    require(isinstance(value["source_root"], str) and value["source_root"].startswith("/")
            and ".." not in Path(value["source_root"]).parts, "Invalid host source root")
    require(isinstance(value["old_backend_started_at"], str) and value["old_backend_started_at"],
            "Missing previous backend incarnation")
    records = value["records"]
    require(isinstance(records, dict) and set(records) == ROLES, "Incomplete evidence roles")
    paths = []
    for pin in records.values():
        require(isinstance(pin, dict) and set(pin) == {"path", "sha256"} and sha(pin["sha256"]),
                "Invalid evidence pin")
        paths.append(safe_path(pin["path"]))
    require(len(set(paths)) == len(paths), "Evidence roles must have distinct paths")
    package = value["current_package"]
    require(isinstance(package, dict) and set(package) == {"receipt_sha256", "inventory_sha256", "cli_sha256"}
            and all(sha(item) for item in package.values()), "Incomplete current package pins")
    expected = CONTROL / "group-ledger-bootstrap" / "attempts" / value["request_id"] / "result.json"
    require(safe_path(value["result_path"]) == expected, "Unexpected result path")
    return value


def read_records(request):
    records = {}
    for role, pin in request["records"].items():
        raw = regular(safe_path(pin["path"]))
        require(digest(raw) == pin["sha256"], "Evidence CAS differs: " + role)
        records[role] = strict_json(raw)
    stop, drained, containers = (records[name] for name in ("stop_terminal", "backend_drain", "containers"))
    require(stop.get("schema") == "fullmag.docker-build-operation.v1"
            and stop.get("phase") == "iteration" and stop.get("state") == "succeeded"
            and stop.get("idle_backend_stopped") is True
            and stop.get("compose_project") == request["compose_project"]
            and stop.get("control_volume") == request["control_volume"]
            and stop.get("backend_container") == request["old_backend_container_id"]
            and stop.get("config_sha256") == request["config_sha256"]
            and stop.get("inputs", {}).get("attempt") == request["development_attempt"],
            "Managed idle stop authority differs")
    stop_root = Path(request["records"]["stop_terminal"]["path"]).parent
    require(stop_root == CONTROL / "iteration" / "attempts" / stop.get("attempt", "")
            and Path(request["records"]["stop_terminal"]["path"]).name == "terminal.json"
            and Path(request["records"]["backend_drain"]["path"]) == stop_root / "backend-drain.json"
            and Path(request["records"]["containers"]["path"]) == stop_root / "idle-stop-containers.json",
            "Idle stop evidence paths differ")
    require(drained.get("schema") == "fullmag.docker-idle-restart-drain.v1"
            and drained.get("backend_container_id") == request["old_backend_container_id"]
            and drained.get("process_receipt_sha256") == request["records"]["process"]["sha256"]
            and drained.get("process_receipt") == records["process"], "Drain receipt differs")
    require(set(containers) == {"backend", "frontend"}
            and digest(canonical(containers) + b"\n") == stop.get("idle_stop_containers_sha256"),
            "Stopped container receipt differs")
    for service, row in containers.items():
        require(row.get("Id") == stop.get(service + "_container")
                and row.get("State", {}).get("Running") is False, "Service is not the stopped predecessor")
    require(containers["backend"]["State"].get("StartedAt") == request["old_backend_started_at"],
            "Previous backend incarnation differs")
    return records


def ledger_inventory(root=LEDGER):
    require(root.is_dir() and not root.is_symlink(), "Ledger mount is absent")
    rows, total = [], 0
    def fail(error):
        raise error
    for directory, folders, files in os.walk(root, followlinks=False, onerror=fail):
        for folder in folders:
            require(not (Path(directory) / folder).is_symlink(), "Ledger directory symlink")
        for name in files:
            path = Path(directory) / name
            raw = regular(path)
            total += len(raw)
            rows.append({"path": path.relative_to(root).as_posix(), "size": len(raw), "sha256": digest(raw)})
            require(len(rows) <= 10000 and total <= 128 * 1024**2, "Ledger inventory exceeds bound")
    require(rows, "Ledger inventory is empty")
    return sorted(rows, key=lambda row: row["path"])


def check_mounts(text):
    mounts = {}
    for line in text.splitlines():
        parts = line.split()
        require("-" in parts and len(parts) > 6, "Malformed mountinfo")
        target = parts[4]
        if target in {str(SOURCE), str(CONTROL), str(LEDGER), "/build", "/opt/fullmag/package"}:
            require(target not in mounts, "Ambiguous managed mount")
            mounts[target] = set(parts[5].split(","))
    require(set(mounts) == {str(SOURCE), str(CONTROL), str(LEDGER), "/build", "/opt/fullmag/package"}
            and "ro" in mounts[str(SOURCE)], "Managed mounts or readonly source differ")


def no_native_processes(root=Path("/proc")):
    forbidden = {"cargo", "rustc", "make", "cmake", "ninja", "nvcc", "cc1", "cc1plus", "mpirun", "mpiexec"}
    for entry in root.iterdir():
        if not entry.name.isdigit() or int(entry.name) == os.getpid():
            continue
        try:
            if (entry / "stat").read_text().rsplit(")", 1)[1].split()[0] == "Z":
                continue
            argv = (entry / "cmdline").read_bytes().split(b"\0")
            program = Path(os.fsdecode(argv[0])).name
        except (FileNotFoundError, ProcessLookupError):
            continue
        require(not program.startswith("fullmag") and program not in forbidden,
                "API, worker or native build process is still alive")


@contextmanager
def runtime_guards(runtime, paths):
    with ExitStack() as stack:
        locks = []
        for name in ("STARTUP-GATE.lock", "LAUNCH.lock"):
            path = runtime.runtime_services_root(paths) / name
            for part in (path, *path.parents):
                require(not part.is_symlink(), "Symlink in runtime gate path")
            fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
            stack.callback(os.close, fd)
            info = os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "Invalid runtime gate")
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            locks.append((path, fd, (info.st_dev, info.st_ino)))
        owner_guard = stack.enter_context(runtime._authenticated_terminal_drain(paths))
        def unchanged():
            owner_guard()
            for path, fd, identity in locks:
                info = path.stat(follow_symlinks=False)
                current = os.fstat(fd)
                require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                        and identity == (info.st_dev, info.st_ino) == (current.st_dev, current.st_ino),
                        "Runtime gate identity changed")
        unchanged()
        yield unchanged


def package_pin(backend, request):
    current = backend._validated_package(backend.PACKAGE_ROOT, "predecessor package", exclude_development_control=True)
    expected = request["current_package"]
    require(digest(current[1]) == expected["receipt_sha256"]
            and digest(canonical(current[0]["artifacts"])) == expected["inventory_sha256"]
            and backend._sha256_file(backend.PACKAGE_ROOT / "bin" / "fullmag-bin", "predecessor CLI", 512 * 1024**2, package_artifact=True)[0] == expected["cli_sha256"],
            "Current package identity differs")
    return current


def capture(backend, request):
    args = argparse.Namespace(source_root=SOURCE,
        git_common_root=Path(os.environ.get("FULLMAG_SOURCE_GIT_COMMON", "/opt/fullmag/source-git")), source_tar=None)
    args.manifest = backend._capture_start_manifest(args, Path("/build"))
    document, _ = backend._read_json(args.manifest, "bootstrap source manifest", 64 * 1024**2)
    require(document.get("resolved_commit") == request["source_commit"]
            and document.get("source_manifest_sha256") == request["source_manifest_sha256"]
            and document.get("source_snapshot_sha256") == request["source_snapshot_sha256"],
            "Live source identity differs")
    return args


def probe_capabilities(candidate):
    cli = candidate / "bin" / "fullmag-bin"
    probes = {}
    for command in ("ledger-relocation-inspect", "ledger-relocation-preview"):
        result = subprocess.run([str(cli), "runtime", command, "--help"],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30,
            env={**os.environ, "LD_LIBRARY_PATH": str(candidate / "lib")})
        require(result.returncode == 0 and len(result.stdout) + len(result.stderr) <= 1024**2
                and command.encode() in result.stdout, "Candidate lacks native relocation capability")
        probes[command] = {"stdout_sha256": digest(result.stdout), "stderr_sha256": digest(result.stderr),
                           "exit_code": result.returncode}
    return probes


def check_native_aliases(request, runtime, paths):
    native_records = {"process": runtime.process_receipt_path(paths),
                      "owner": runtime.runtime_services_root(paths) / "OWNER.json", "config": paths.config}
    for role, native in native_records.items():
        native = Path(native)
        alias = CONTROL / "runtime-control" / native.relative_to(RUNTIME_CONTROL) if native.is_relative_to(RUNTIME_CONTROL) else native
        pin = request["records"][role]
        require(Path(pin["path"]) == alias, "Native record alias differs")
        native_raw = regular(native)
        native_stat, alias_stat = native.stat(follow_symlinks=False), alias.stat(follow_symlinks=False)
        require((native_stat.st_dev, native_stat.st_ino) == (alias_stat.st_dev, alias_stat.st_ino)
                and digest(native_raw) == pin["sha256"], "Native record alias inode or CAS differs")


def build(request, backend, runtime):
    require(os.environ.get("FULLMAG_COMPOSE_PROJECT") == request["compose_project"]
            and os.environ.get("FULLMAG_SOURCE_HOST_ROOT") == request["source_root"]
            and os.environ.get("FULLMAG_BUILD_CONTROL_VOLUME") == request["control_volume"]
            and os.environ.get("FULLMAG_DOCKER_ROLE") == "backend", "Guest group binding differs")
    check_mounts(Path("/proc/self/mountinfo").read_text())
    require(digest(regular(Path(__file__))) == request["bootstrap_script_sha256"], "Bootstrap source CAS differs")
    paths = runtime.canonical_paths()
    check_native_aliases(request, runtime, paths)
    with runtime_guards(runtime, paths) as guards, backend._runtime_build_lock(Path("/build")):
        read_records(request)
        no_native_processes()
        require(digest(canonical(ledger_inventory())) == request["ledger_inventory_sha256"], "Ledger inventory CAS differs")
        current = package_pin(backend, request)
        control = backend._ensure_package_development_root(backend.PACKAGE_ROOT)
        require(not os.path.lexists(control / backend.PACKAGE_ROTATION_JOURNAL_NAME)
                and not any((control / backend.PACKAGE_CANDIDATES_DIRNAME).iterdir()),
                "Pending package publication requires its existing recovery")
        backend._preflight_candidate_storage(Path("/build"), current[0])
        args = capture(backend, request)
        _, toolchain = backend._toolchain_identity()
        jobs = int(os.environ.get("CARGO_BUILD_JOBS", "2"))
        require(1 <= jobs <= 64, "Invalid existing Cargo budget")
        candidate = Path(tempfile.mkdtemp(prefix=".backend-package-candidate-",
            dir=control / backend.PACKAGE_CANDIDATES_DIRNAME))
        backend._write_candidate_marker(candidate, backend.PACKAGE_ROOT, Path("/build"), state="building")
        require(backend._prepare_with_shared_package(args, Path("/build"), candidate, jobs, toolchain, candidate) == 0,
                "Canonical candidate preparation failed")
        marker = backend._validate_candidate_marker(candidate, backend.PACKAGE_ROOT, Path("/build"), state="ready")
        receipt, raw, _ = backend._validated_package(candidate, "bootstrap candidate", exclude_candidate_marker=True)
        require(marker.get("artifact_inventory_sha256") == digest(backend._canonical(receipt["artifacts"])),
                "Candidate marker inventory differs")
        probes = probe_capabilities(candidate)
        guards()
        check_native_aliases(request, runtime, paths)
        read_records(request)
        require(package_pin(backend, request) == current, "Current package changed during bootstrap")
        require(digest(canonical(ledger_inventory())) == request["ledger_inventory_sha256"], "Ledger changed during bootstrap")
        capture(backend, request)
        no_native_processes()
        result = {"schema": SCHEMA, "state": "candidate-ready", "request_sha256": digest(backend._canonical(request)),
            "candidate": str(candidate), "candidate_receipt_sha256": digest(raw),
            "candidate_cli_sha256": backend._sha256_file(candidate / "bin" / "fullmag-bin", "candidate CLI", 512 * 1024**2, package_artifact=True)[0],
            "source": receipt["source"], "capabilities": probes,
            "package_promoted": False, "runtime_started": False, "ledger_modified": False}
        target = safe_path(request["result_path"])
        require(not target.exists(), "Bootstrap result already exists")
        backend._write_json(target, result, "ledger bootstrap result")
        return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", required=True)
    parser.add_argument("--request-sha256", required=True)
    args = parser.parse_args(argv)
    require(sha(args.request_sha256), "Invalid request SHA256")
    raw = regular(safe_path(args.request))
    require(digest(raw) == args.request_sha256, "Bootstrap request CAS differs")
    request = validate_request(strict_json(raw))
    require(raw == canonical(request) + b"\n", "Bootstrap request must use backend canonical JSON with LF")
    sys.path.insert(0, "/opt/fullmag")
    import backend_dev
    import runtime_service
    result = build(request, backend_dev, runtime_service)
    print(json.dumps(result, sort_keys=True), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
