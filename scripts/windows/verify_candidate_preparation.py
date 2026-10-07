"""Observe real native candidate-helper failures in managed disposable processes."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import threading

import fullmag_storage as storage
from windows.runtime_bundle import _check_path_chain

PROGRESS_SCHEMA = "fullmag.development-cli-candidate-preparation-helper-progress.v1"
RESULT_SCHEMA = "fullmag.development-cli-candidate-preparation-check.v1"
CASES = frozenset({"success", "nonzero_exit", "output_overflow", "explicit_cancel",
                   "timeout", "incomplete_stdin", "child_early_exit"})
CHECKS = frozenset({"late_ack_refused", "success_completed", "nonzero_exit_failed", "output_overflow_failed",
                    "explicit_cancel_reaped", "timeout_reaped", "incomplete_stdin_failed",
                    "child_early_exit_reaped", "poll_nonblocking"})
MAX_LOG_BYTES = 128 * 1024


class BoundedCapture:
    """Own a pipe reader; freeze a bounded snapshot without waiting on live children."""
    def __init__(self, stream):
        self.stream = stream
        self.lock = threading.Lock()
        self.raw = bytearray()
        self.frozen = False
        self.overflow = False
        self.error = False
        self.done = threading.Event()
        self.thread = threading.Thread(target=self._read, daemon=True)
        self.thread.start()

    def _read(self):
        try:
            with self.stream as stream:
                while chunk := stream.read1(4096):
                    with self.lock:
                        if self.frozen:
                            break
                        remaining = MAX_LOG_BYTES - len(self.raw)
                        self.raw.extend(chunk[:remaining])
                        if len(chunk) > remaining:
                            self.overflow = True
                            break
        except Exception:
            self.error = True
        finally:
            self.done.set()

    def snapshot(self):
        with self.lock:
            self.frozen = True
            return bytes(self.raw)


def frames_with_custody(raw, receipt, transport_confirmed):
    """Retain each complete started frame before decoding any later bad frame."""
    frames = []
    records = {}
    for line in raw.splitlines(keepends=True):
        if not line.startswith(b"{"):
            continue
        if not transport_confirmed and not line.endswith(b"\n"):
            break
        value = json.loads(line)
        if not isinstance(value, dict):
            raise storage.StorageError("Candidate fault probe frame is not an object")
        if value.get("schema") == PROGRESS_SCHEMA:
            candidate = progress_records([value])[value["case"]]
            if (value["case"] in records
                    or any(record["pid"] == candidate["pid"] for record in records.values())):
                raise storage.StorageError("Candidate fault probe duplicated early process evidence")
            records[value["case"]] = candidate
            receipt["processes"].append(candidate)
        frames.append(value)
    return frames, records


def progress_records(frames):
    records = {}
    for frame in frames:
        if frame.get("schema") != PROGRESS_SCHEMA:
            continue
        if (set(frame) != {"schema", "event", "case", "pid"}
                or frame["event"] != "started" or not isinstance(frame["case"], str)
                or frame["case"] not in CASES
                or type(frame["pid"]) is not int or frame["pid"] <= 0
                or frame["case"] in records
                or any(record["pid"] == frame["pid"] for record in records.values())):
            raise storage.StorageError("Candidate fault probe emitted invalid early process evidence")
        records[frame["case"]] = {"label": "candidate-preparation-" + frame["case"],
                                  "case": frame["case"], "pid": frame["pid"],
                                  "waited": False, "outcome": "unknown"}
    return records


def validate_result(result, records):
    if (set(result) != {"schema", "status", "poll_elapsed_ms", "checks", "processes"}
            or result["schema"] != RESULT_SCHEMA or result["status"] != "passed"
            or type(result["poll_elapsed_ms"]) is not int
            or not 0 <= result["poll_elapsed_ms"] < 1000
            or not isinstance(result["checks"], dict) or set(result["checks"]) != CHECKS
            or any(value is not True for value in result["checks"].values())
            or not isinstance(result["processes"], list)
            or len(result["processes"]) != len(CASES) or set(records) != CASES):
        raise storage.StorageError("Candidate fault probe did not prove every required check")
    terminal = terminal_records(result, records)
    for item in terminal.values():
        if ((item["case"] == "success" and
             (item["exit_code"] != 0 or item["outcome"] != "completed"))
                or (item["case"] != "success" and item["outcome"] != "failed")):
            raise storage.StorageError("Candidate fault outcome differs from its case")
    return terminal


def terminal_records(result, records):
    """Validate custody independently of whether the behavioral gates passed."""
    if (not isinstance(result.get("processes"), list)
            or len(result["processes"]) != len(CASES) or set(records) != CASES):
        raise storage.StorageError("Candidate fault probe lacks complete process custody evidence")
    terminal = {}
    for item in result["processes"]:
        if (not isinstance(item, dict)
                or set(item) != {"case", "pid", "waited", "exit_code", "outcome"}
                or not isinstance(item["case"], str)
                or item["case"] not in records or item["case"] in terminal
                or type(item["pid"]) is not int or item["pid"] != records[item["case"]]["pid"]
                or item["waited"] is not True or type(item["exit_code"]) is not int
                or item["outcome"] not in {"completed", "failed"}):
            raise storage.StorageError("Candidate fault probe lacks matching terminal process evidence")
        terminal[item["case"]] = {**records[item["case"]], **item}
    return terminal


def exercise(repo, run_root, manifest, receipt, binaries):
    native = storage.resolve_layout(repo, "windows-native-fdm-cpu-dev")
    fixture = run_root / "candidate-preparation-fixture"
    fixture.mkdir(exist_ok=False)
    helpers = [repo / "scripts/windows/candidate_helper_probe.py", Path(__file__)]
    def hashes():
        values = {}
        for path in helpers:
            _check_path_chain(path, "candidate preparation probe helper")
            values[str(path.relative_to(repo))] = hashlib.sha256(path.read_bytes()).hexdigest()
        return values
    before = hashes()
    env = {key: os.environ[key] for key in (
        "SystemRoot", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP",
        "USERPROFILE", "LOCALAPPDATA", "APPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"
    ) if key in os.environ}
    env.update({"FULLMAG_REPO_ROOT": str(repo), "FULLMAG_DEVELOPMENT_OWNER_PROBE": "1",
                "FULLMAG_DEVELOPMENT_RESTART_PROBE_CASE": "preparation-faults",
                "FULLMAG_NATIVE_RUNTIME_ACTIVE": "1",
                "FULLMAG_PROJECT_STORAGE_ROOT": native["storage_root"],
                "FULLMAG_WORKTREE_ID": native["worktree_id"],
                "FULLMAG_STORAGE_PROFILE": "windows-native-fdm-cpu-dev",
                "FULLMAG_STATE_ROOT": str(fixture),
                "FULLMAG_RUNS_ROOT": str(fixture / "runs"),
                "FULLMAG_PYTHON": str(Path(native["build_root"]) / "python/fullmag/Scripts/python.exe")})
    request = json.dumps({"schema": "fullmag.development-candidate-preparation-check-request.v1",
                          "worktree_id": native["worktree_id"]}).encode()
    log_path = fixture / "probe.log"
    cli_record = None
    try:
        process = subprocess.Popen([str(binaries / "fullmag.exe"), "runtime",
                                        "verify-development-restart-consumer"],
                                       cwd=repo, env=env, stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                       creationflags=subprocess.CREATE_NO_WINDOW)
        cli_record = {"label": "candidate-preparation-cli", "pid": process.pid,
                          "waited": False, "outcome": "unknown"}
        receipt["processes"].append(cli_record)
        capture = BoundedCapture(process.stdout)
        timed_out = False
        input_failed = False
        try:
            process.stdin.write(request)
            process.stdin.close()
        except OSError:
            input_failed = True
        try:
            process.wait(timeout=45)
            cli_record.update(waited=True, exit_code=process.returncode, outcome="terminal")
        except subprocess.TimeoutExpired:
            timed_out = True
        transport_confirmed = capture.done.wait(2)
        if transport_confirmed:
            capture.thread.join(timeout=1)
            transport_confirmed = not capture.thread.is_alive()
        raw = capture.snapshot()
        log_path.write_bytes(raw)
        receipt["candidate_preparation_log_transport"] = (
            "terminal" if transport_confirmed else "unknown")
        frames, records = frames_with_custody(raw, receipt, transport_confirmed)
        if capture.overflow or capture.error or not transport_confirmed:
            raise storage.StorageError("Candidate fault probe log transport failed or remains unknown")
        if input_failed:
            raise storage.StorageError("Candidate fault probe CLI input transport failed")
        if timed_out:
            raise storage.StorageError("Candidate fault probe outcome unknown; processes were not force-stopped")
        results = [frame for frame in frames if frame.get("schema") == RESULT_SCHEMA]
        if len(results) != 1:
            raise storage.StorageError("Candidate fault probe failed; inspect its preserved log")
        result = results[0]
        terminal = terminal_records(result, records)
        for record in records.values():
            record.update(terminal[record["case"]])
        receipt["candidate_preparation_result"] = result
        validate_result(result, records)
        if process.returncode != 0:
            raise storage.StorageError("Candidate fault probe CLI exited unsuccessfully")
        receipt["checks"].extend("candidate-preparation-" + key for key in sorted(CHECKS))
    finally:
        receipt["candidate_preparation_helper_sha256_before"] = before
        receipt["candidate_preparation_helper_sha256_after"] = hashes()
        if receipt["candidate_preparation_helper_sha256_after"] != before:
            raise storage.StorageError("Candidate preparation probe helpers changed during verification")
