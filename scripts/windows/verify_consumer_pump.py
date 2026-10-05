"""Drive a managed cross-build native consumer-readiness pump probe.

This proves the B CLI/pump selecting and renewing B's real ready candidate
while owned by a separately verified A API. It does not prove the production
launcher, public UI availability, solver execution, or release qualification.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import uuid
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import fullmag_storage as storage
from windows.development_status import (
    DevelopmentStatusPublisher,
    StatusHeartbeat,
    verified_build_identity,
)
from windows import runtime_bundle


SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
BUNDLE_ID_RE = re.compile(r"^[0-9a-f]{32}$")
REQUEST_SCHEMA = "fullmag.development-cli-consumer-pump-request.v1"
RESULT_SCHEMA = "fullmag.development-cli-consumer-pump-check.v1"
HELPER_PROGRESS_SCHEMA = "fullmag.development-cli-consumer-pump-helper.v1"
PREPARATION_PROGRESS_SCHEMA = "fullmag.development-cli-candidate-preparation-progress.v1"
OWNER_PROGRESS_SCHEMA = "fullmag.development-cli-owner-progress.v1"
# Covers the dedicated 120s preparation, 20s owner verifier, API startup and
# lease observation windows. This is only the owned diagnostic process budget.
PROBE_TIMEOUT_SECONDS = 240
EXPECTED_CHECKS = frozenset({
    "cross_build_owner_confirmed",
    "initial_readiness_absent",
    "preparation_pending_observed",
    "preparation_step_nonblocking_observed",
    "ready_candidate_selected",
    "lease_renewed_past_initial_ttl",
    "single_candidate_bundle_reused",
    "lease_expired_without_steps",
    "lease_renewed_after_pause",
    "no_request_or_process_replacement",
    "readiness_withdrawn",
    "api_waited",
    "scope_loss_pending_observed",
    "scope_loss_nonblocking",
    "scope_loss_helper_reaped",
    "scope_loss_no_candidate",
    "scope_loss_no_replacement",
})
HASHED_HELPERS = (
    "scripts/windows/verify_consumer_pump.py",
    "scripts/windows/validate_candidate_owner.py",
    "scripts/windows/select_development_candidate.py",
    "scripts/windows/check_development_candidate.py",
)


def _terminal_helper(value, canceled_pid):
    """Accept terminal custody only with an actual integer process exit."""
    if (
        not isinstance(value, dict)
        or set(value) != {"pid", "waited", "exit_code"}
        or type(value.get("pid")) is not int
        or value["pid"] <= 0
        or value.get("waited") is not True
        or type(value.get("exit_code")) is not int
        or (value["pid"] != canceled_pid and value["exit_code"] != 0)
    ):
        raise storage.StorageError("Consumer pump has invalid terminal helper custody")
    return dict(value)


def _canceled_preparation_pid(result, preparation_starts):
    pid = result.get("canceled_helper_pid")
    ordered = list(preparation_starts)
    if type(pid) is not int or pid <= 0 or len(ordered) != 2 or pid != ordered[1]:
        raise storage.StorageError("Consumer pump cancellation does not match its second preparation")
    return pid


def _preparation_starts(frames, ready_build_id, ready_source_sha256, on_start=None):
    """Capture early custody evidence even when the CLI later fails."""
    starts = {}
    expected = {"schema", "event", "helper_pid", "api_instance_id",
                "ready_build_id", "ready_source_sha256"}
    for frame in frames:
        if frame.get("schema") != PREPARATION_PROGRESS_SCHEMA:
            continue
        pid = frame.get("helper_pid")
        instance = frame.get("api_instance_id")
        if (set(frame) != expected or frame.get("event") != "started"
                or type(pid) is not int or pid <= 0 or pid in starts
                or not isinstance(instance, str)
                or frame.get("ready_build_id") != ready_build_id
                or frame.get("ready_source_sha256") != ready_source_sha256):
            raise storage.StorageError("Consumer pump emitted invalid candidate preparation progress")
        try:
            parsed_instance = uuid.UUID(instance)
        except ValueError as error:
            raise storage.StorageError("Candidate preparation API identity is invalid") from error
        if parsed_instance.int == 0 or str(parsed_instance) != instance:
            raise storage.StorageError("Candidate preparation API identity is not canonical")
        starts[pid] = dict(frame)
        if on_start is not None:
            on_start(pid)
    return starts


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _hash_helpers(repo: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    for relative in HASHED_HELPERS:
        path = storage.validate_path(repo / relative, repo, f"consumer pump helper {relative}")
        runtime_bundle._require_regular_file(path, f"consumer pump helper {relative}", nonempty=True)
        result[relative] = _sha256(path.read_bytes())
    return result


def _json_frames(path: Path) -> list[dict[str, Any]]:
    frames: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.startswith("{"):
            continue
        try:
            frame = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(frame, dict):
            frames.append(frame)
    return frames


def _valid_uuid(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError):
        return False
    return parsed.int != 0 and str(parsed) == value


def _restore_diagnostic_status(
    status: Path,
    worktree: str,
    generation: str,
    original_status: bytes | None,
) -> None:
    if not os.path.lexists(status) or status.is_symlink() or not status.is_file():
        raise storage.StorageError("Consumer pump diagnostic status changed before restoration")
    try:
        current = json.loads(status.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise storage.StorageError("Consumer pump diagnostic status changed before restoration") from error
    if current.get("generation_id") != generation or current.get("worktree_id") != worktree:
        raise storage.StorageError("Consumer pump diagnostic status is no longer owned by this fixture")
    if original_status is None:
        status.unlink()
        return
    restore_path = status.with_name(status.name + ".restore-" + uuid.uuid4().hex + ".tmp")
    with restore_path.open("xb") as stream:
        stream.write(original_status)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(restore_path, status)


def _reserve_port() -> int:
    while True:
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        # This managed probe must never claim the user's Windows UI port.
        if port != 3197:
            return port


def exercise(
    repo: Path,
    run_root: Path,
    manifest: dict[str, Any],
    receipt: dict[str, Any],
    binaries: Path,
    owner_bundle: str,
) -> None:
    """Run the bounded B-pump probe against an immutable, verified A bundle."""
    if not BUNDLE_ID_RE.fullmatch(owner_bundle):
        raise storage.StorageError("Consumer pump owner bundle must be a lowercase bundle ID")

    fixture = run_root / "consumer-pump-fixture"
    fixture.mkdir(parents=True, exist_ok=False)
    native = storage.resolve_layout(repo, "windows-native-fdm-cpu-dev")
    checks = storage.resolve_layout(repo, "development-backend-api-checks")
    storage_root = Path(native["storage_root"])
    runtime_root = Path(native["runtime_root"])
    worktree = native["worktree_id"]
    runs_root = Path(native["runs_root"])
    status = storage.validate_path(
        Path(checks["build_root"]) / "backend-watch-status.json",
        checks["storage_root"],
        "consumer pump diagnostic status",
    )
    native_status = Path(native["build_root"]) / "backend-watch-status.json"
    if os.path.normcase(os.path.abspath(status)) == os.path.normcase(os.path.abspath(native_status)):
        raise storage.StorageError("Consumer pump diagnostic status aliases the native watcher")
    if os.path.lexists(status) and (status.is_symlink() or not status.is_file()):
        raise storage.StorageError("Consumer pump diagnostic status is not a regular file")

    original_status = status.read_bytes() if status.exists() else None
    if original_status is not None:
        (fixture / "preexisting-diagnostic-status.json").write_bytes(original_status)
        receipt["consumer_pump_prior_status_sha256"] = _sha256(original_status)

    helper_hashes_before = _hash_helpers(repo)

    # B is the actual source-pinned managed build admitted by the outer verifier.
    ready_manifest_path = storage.validate_path(
        Path(native["build_root"]) / "windows-runtime/build-manifest.json",
        checks["storage_root"],
        "consumer pump ready build manifest",
    )
    raw_ready_manifest = ready_manifest_path.read_bytes()
    ready_build_id = _sha256(raw_ready_manifest)
    ready_source_sha256 = manifest.get("backend_source_sha256")
    ready_snapshot_sha256 = manifest.get("source_snapshot_sha256")
    if (
        not isinstance(ready_source_sha256, str)
        or not SHA256_RE.fullmatch(ready_source_sha256)
        or not isinstance(ready_snapshot_sha256, str)
        or not SHA256_RE.fullmatch(ready_snapshot_sha256)
        or ready_build_id != receipt.get("verified_build_id")
        or ready_source_sha256 != receipt.get("source_sha256")
    ):
        raise storage.StorageError("Consumer pump ready identity differs from the verified B package")
    ready_identity = verified_build_identity(
        native["build_root"], runtime_root, ready_manifest_path, ready_source_sha256
    )
    if (
        ready_identity.get("ready_build_id") != ready_build_id
        or ready_identity.get("ready_source_sha256") != ready_source_sha256
        or ready_manifest_path.read_bytes() != raw_ready_manifest
    ):
        raise storage.StorageError("Consumer pump B manifest changed during identity verification")

    # A is accepted only after complete bundle validation in this same resolved
    # worktree/runtime namespace. Pin the raw manifest around the validation.
    owner_root = storage.validate_path(
        runtime_root / "native-bundles" / owner_bundle,
        storage_root,
        "consumer pump owner bundle",
    )
    owner_manifest_path = storage.validate_path(
        owner_root / "manifest.json", storage_root, "consumer pump owner manifest"
    )
    if owner_manifest_path.stat().st_size > 256 * 1024:
        raise storage.StorageError("Consumer pump owner manifest exceeds its limit")
    raw_owner_manifest = owner_manifest_path.read_bytes()
    owner_manifest_sha256 = _sha256(raw_owner_manifest)
    owner_manifest, owner_file_hashes = runtime_bundle.validate_bundle(
        owner_root, runtime_root, "dev"
    )
    owner_source = owner_manifest.get("source")
    if not isinstance(owner_source, dict):
        raise storage.StorageError("Consumer pump owner bundle lacks source identity")
    if (
        owner_manifest.get("bundle_id") != owner_bundle
        or owner_manifest.get("profile") != "dev"
        or owner_source.get("workspace_namespace") != worktree
        or owner_source.get("source_snapshot_sha256") == ready_snapshot_sha256
        or owner_source.get("backend_source_sha256") == ready_source_sha256
        or owner_source.get("manifest_sha256") == ready_build_id
        or owner_manifest_sha256 == ready_build_id
        or owner_manifest_path.read_bytes() != raw_owner_manifest
    ):
        raise storage.StorageError("Consumer pump owner A is not a distinct stable build from ready B")
    owner_source_sha256 = owner_source.get("backend_source_sha256")
    if not isinstance(owner_source_sha256, str) or not SHA256_RE.fullmatch(owner_source_sha256):
        raise storage.StorageError("Consumer pump owner backend source identity is invalid")

    generation = uuid.uuid4().hex
    accepted_store_scope = str(uuid.uuid4())
    case_root = fixture / "readiness"
    state_root = case_root / "state"
    state_root.mkdir(parents=True, exist_ok=False)
    port = _reserve_port()
    accepted_store = runs_root / "workspaces" / accepted_store_scope / "session-store"
    if os.path.lexists(accepted_store.parent):
        raise storage.StorageError("Consumer pump accepted-store scope already exists")

    base_env = {
        key: os.environ[key]
        for key in ("SYSTEMROOT", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP", "COMPUTERNAME")
        if key in os.environ
    }
    env = {
        **base_env,
        "FULLMAG_REPO_ROOT": str(repo),
        "FULLMAG_DEVELOPMENT_OWNER_PROBE": "1",
        "FULLMAG_NATIVE_RUNTIME_ACTIVE": "1",
        "FULLMAG_PYTHON": str(Path(native["build_root"]) / "python/fullmag/Scripts/python.exe"),
        "FULLMAG_STORAGE_PROFILE": "windows-native-fdm-cpu-dev",
        "FULLMAG_PROJECT_STORAGE_ROOT": str(storage_root),
        "FULLMAG_WORKTREE_ID": worktree,
        "FULLMAG_RUNS_ROOT": str(runs_root),
        "FULLMAG_DEVELOPMENT_BACKEND_SOURCE": ready_source_sha256,
        "FULLMAG_DEVELOPMENT_BACKEND_VERSION": manifest["build_version"]["product_version"],
        "FULLMAG_DEVELOPMENT_BACKEND_STATUS_FILE": str(status),
        "FULLMAG_STATE_ROOT": str(state_root),
        "FULLMAG_API_PORT": str(port),
        "FULLMAG_ACCEPTED_STORE_SCOPE": accepted_store_scope,
        "FULLMAG_DEVELOPMENT_BACKEND_GENERATION": generation,
        "FULLMAG_DEVELOPMENT_RESTART_PROBE_CASE": "readiness",
    }
    # The probe itself creates a fresh private owner token; no credential is
    # supplied to or recorded by the Python driver.
    for key in (
        "FULLMAG_DEVELOPMENT_OWNER_TOKEN",
        "FULLMAG_DEVELOPMENT_OWNER_PROBE_TOKEN",
        "FULLMAG_RUNTIME_SERVICE_CONFIG",
    ):
        env.pop(key, None)

    publisher = DevelopmentStatusPublisher(status, generation, worktree)
    heartbeat: StatusHeartbeat | None = None
    status_published = False
    safe_to_restore_status = True
    api_started = False
    api_terminal = False
    try:
        publisher.publish({
            "state": "ready",
            "source_sha256": ready_source_sha256,
            "ready_build_id": ready_build_id,
            "ready_source_sha256": ready_source_sha256,
        })
        status_published = True
        heartbeat = StatusHeartbeat(publisher, interval_seconds=2.0).start()
    except Exception:
        if status_published:
            _restore_diagnostic_status(status, worktree, generation, original_status)
        raise

    receipt["consumer_pump_fixture"] = {
        "generation_id": generation,
        "worktree_id": worktree,
        "accepted_store_scope": accepted_store_scope,
        "accepted_store_root": str(accepted_store),
        "api_port": port,
        "owner": {
            "bundle_id": owner_bundle,
            "bundle_manifest_sha256": owner_manifest_sha256,
            "source_snapshot_sha256": owner_source["source_snapshot_sha256"],
            "backend_source_sha256": owner_source_sha256,
            "source_manifest_sha256": owner_source["manifest_sha256"],
            "git_commit": owner_source["git_commit"],
            "workspace_namespace": owner_source["workspace_namespace"],
            "validated_files": owner_file_hashes,
        },
        "ready": {
            "build_id": ready_build_id,
            "source_sha256": ready_source_sha256,
            "source_snapshot_sha256": ready_snapshot_sha256,
            "git_commit": manifest["git_commit"],
        },
        "helper_sha256_before": helper_hashes_before,
    }

    try:
        initializer_path = fixture / "accepted-store-initializer.log"
        with initializer_path.open("wb") as initializer_log:
            initializer = subprocess.Popen(
                [str(binaries / "fullmag.exe"), "runtime", "initialize-scoped-accepted-store"],
                cwd=repo,
                env=env,
                stdout=initializer_log,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            initializer_record = {
                "label": "consumer-pump-accepted-store-initializer",
                "pid": initializer.pid,
                "waited": False,
            }
            receipt["processes"].append(initializer_record)
            try:
                initializer.wait(timeout=20)
                initializer_record.update(waited=True, exit_code=initializer.returncode)
            except subprocess.TimeoutExpired:
                initializer.kill()
                initializer.wait(timeout=10)
                initializer_record.update(
                    waited=True,
                    exit_code=initializer.returncode,
                    termination_reason="owned scoped accepted-store initializer timeout",
                )
                raise storage.StorageError("Consumer pump accepted-store initializer timed out")
        initializer_frames = _json_frames(initializer_path)
        if (
            initializer.returncode != 0
            or len(initializer_frames) != 1
            or initializer_frames[0].get("schema") != "fullmag.scoped-accepted-store-initialization.v1"
            or initializer_frames[0].get("scope") != accepted_store_scope
            or not accepted_store.is_dir()
        ):
            raise storage.StorageError("Consumer pump accepted-store initialization evidence is invalid")
        receipt["consumer_pump_fixture"]["accepted_store_binding"] = initializer_frames[0]["binding"]

        request = {
            "schema": REQUEST_SCHEMA,
            "owner_bundle_id": owner_bundle,
            "owner_manifest_sha256": owner_manifest_sha256,
            "owner_source_sha256": owner_source_sha256,
            "ready_build_id": ready_build_id,
            "ready_source_sha256": ready_source_sha256,
        }
        request_bytes = json.dumps(request, separators=(",", ":")).encode("utf-8")
        log_path = fixture / "consumer-pump.log"
        cli_record: dict[str, Any]
        timed_out = False
        with log_path.open("wb") as log:
            process = subprocess.Popen(
                [str(binaries / "fullmag.exe"), "runtime", "verify-development-restart-consumer"],
                cwd=repo,
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
                stdin=subprocess.PIPE,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            cli_record = {
                "label": "consumer-pump-cli-b",
                "pid": process.pid,
                "waited": False,
            }
            receipt["processes"].append(cli_record)
            try:
                process.communicate(input=request_bytes, timeout=PROBE_TIMEOUT_SECONDS)
                cli_record.update(waited=True, exit_code=process.returncode)
            except subprocess.TimeoutExpired:
                timed_out = True
                safe_to_restore_status = False
                cli_record.update(waited=False, outcome="unknown")
                log.flush()

        frames = _json_frames(log_path)
        helper_progress = [frame for frame in frames if frame.get("schema") == HELPER_PROGRESS_SCHEMA]
        api_starts = [frame for frame in frames if frame.get("schema") == OWNER_PROGRESS_SCHEMA]
        results = [frame for frame in frames if frame.get("schema") == RESULT_SCHEMA]
        api_started = bool(api_starts)
        api_records: dict[int, dict[str, Any]] = {}
        for frame in api_starts:
            pid = frame.get("api_pid")
            if (
                frame.get("event") != "owned_api_started"
                or type(pid) is not int or pid <= 0
                or type(frame.get("api_port")) is not int or frame["api_port"] != port
                or pid in api_records
            ):
                raise storage.StorageError("Consumer pump emitted invalid owned API start progress")
            record = {"label": "consumer-pump-owned-api-a", "pid": pid,
                      "api_port": port, "waited": False,
                      "outcome": "unknown" if timed_out else "pending"}
            api_records[pid] = record
            receipt["processes"].append(record)
        preparation_records = {}
        def remember_preparation(pid):
            record = {"label": "consumer-pump-candidate-preparation", "pid": pid,
                      "waited": False, "outcome": "unknown"}
            preparation_records[pid] = record
            receipt["processes"].append(record)
        preparation_starts = _preparation_starts(
            frames, ready_build_id, ready_source_sha256, remember_preparation,
        )
        helper_records = dict(preparation_records)
        result = results[0] if len(results) == 1 else None
        canceled_pid = (_canceled_preparation_pid(result, preparation_starts)
                        if result is not None else None)

        helper_evidence: dict[int, dict[str, Any]] = {}
        for frame in helper_progress:
            pid = frame.get("helper_pid")
            value = {"pid": pid, "waited": frame.get("helper_waited"),
                     "exit_code": frame.get("helper_exit_code")}
            observed = _terminal_helper(value, pid)
            if pid not in helper_records:
                helper_records[pid] = {"label": "consumer-pump-owned-helper"}
                receipt["processes"].append(helper_records[pid])
            helper_records[pid].update(observed, outcome="terminal")
            terminal = _terminal_helper(
                value, canceled_pid,
            )
            if (
                pid in helper_evidence
            ):
                raise storage.StorageError("Consumer pump emitted invalid owner-helper progress")
            helper_evidence[pid] = terminal

        result_helpers: set[int] = set()
        if result is not None:
            helpers = result.get("helper_processes")
            if not isinstance(helpers, list):
                raise storage.StorageError("Consumer pump result lacks helper process evidence")
            for helper in helpers:
                terminal = _terminal_helper(helper, canceled_pid)
                pid = helper["pid"]
                if pid in result_helpers:
                    raise storage.StorageError("Consumer pump result duplicated a helper PID")
                result_helpers.add(pid)
                if pid in helper_evidence and helper_evidence[pid] != terminal:
                    raise storage.StorageError("Consumer pump helper exit differs from terminal progress")
                helper_evidence.setdefault(pid, terminal)
            if len(helper_progress) != 4 or len(result_helpers) != 4:
                raise storage.StorageError("Consumer pump omitted owner and selector/verifier helper evidence")
            if set(helper_evidence) != result_helpers:
                raise storage.StorageError("Consumer pump result helper PIDs differ from terminal progress")
            if (len(preparation_starts) != 2
                    or not set(preparation_starts).issubset(result_helpers)
                    or any(start["api_instance_id"] != result.get("api_instance_id")
                           for start in preparation_starts.values())):
                raise storage.StorageError("Consumer pump lacks matching early preparation custody evidence")

        for pid in sorted(set(helper_evidence) | set(preparation_starts)):
            helper = helper_evidence.get(pid, {"pid": pid, "waited": False, "outcome": "unknown"})
            if pid in helper_records:
                helper_records[pid].update(helper)
                if helper.get("waited") is True:
                    helper_records[pid]["outcome"] = "terminal"
                continue
            label = "consumer-pump-candidate-preparation" if pid in preparation_starts else "consumer-pump-owned-helper"
            receipt["processes"].append({"label": label, **helper})

        if result is not None:
            api_pid = result.get("api_pid")
            if (
                len(api_records) != 1
                or type(api_pid) is not int
                or api_pid not in api_records
                or result.get("api_waited") is not True
                or type(result.get("api_exit_code")) is not int
            ):
                raise storage.StorageError("Consumer pump result lacks terminal evidence for its exact API child")
            api_records[api_pid].update(
                waited=True,
                exit_code=result["api_exit_code"],
                outcome="terminal",
                termination_reason="explicit owned probe shutdown after readiness proof",
            )
            api_terminal = True
            safe_to_restore_status = True

        if timed_out:
            raise storage.StorageError(
                f"Consumer pump outcome is unknown; no API or helper process was terminated; see {log_path}"
            )
        if process.returncode != 0:
            if api_started and not api_terminal:
                safe_to_restore_status = False
                for record in api_records.values():
                    record.update(waited=False, outcome="unknown")
            raise storage.StorageError(
                f"Consumer pump CLI failed with exit code {process.returncode}; see {log_path}"
            )
        if len(helper_progress) != 4 or len(api_starts) != 1 or len(results) != 1:
            raise storage.StorageError("Consumer pump did not produce exactly one complete owner/API/result trace")

        expected_result_fields = {
            "schema", "status", "api_pid", "api_instance_id", "api_waited", "api_exit_code",
            "launcher_build_matches_api", "owner_bundle_id", "owner_manifest_sha256",
            "owner_source_sha256", "candidate_bundle_id", "candidate_manifest_sha256",
            "ready_build_id", "ready_source_sha256", "renewal_observation_ms",
            "paused_observation_ms", "preparation_step_elapsed_ms", "helper_processes", "checks",
            "canceled_helper_pid", "cancel_step_elapsed_ms",
        }
        if set(result) != expected_result_fields:
            raise storage.StorageError("Consumer pump result fields differ from the pinned probe contract")
        step_elapsed_ms = result.get("preparation_step_elapsed_ms")
        if type(step_elapsed_ms) is not int or not 0 <= step_elapsed_ms < 1000:
            raise storage.StorageError("Consumer pump preparation step blocked its control loop")
        cancel_step_ms = result.get("cancel_step_elapsed_ms")
        if type(cancel_step_ms) is not int or not 0 <= cancel_step_ms < 1000:
            raise storage.StorageError("Consumer pump scope-loss step blocked its control loop")
        checks_object = result.get("checks")
        if (
            result.get("status") != "passed"
            or result.get("launcher_build_matches_api") is not False
            or not isinstance(checks_object, dict)
            or set(checks_object) != EXPECTED_CHECKS
            or any(value is not True for value in checks_object.values())
        ):
            raise storage.StorageError("Consumer pump result does not satisfy its exact readiness checks")
        if (
            result.get("owner_bundle_id") != owner_bundle
            or result.get("owner_manifest_sha256") != owner_manifest_sha256
            or result.get("owner_source_sha256") != owner_source_sha256
            or result.get("ready_build_id") != ready_build_id
            or result.get("ready_source_sha256") != ready_source_sha256
            or not BUNDLE_ID_RE.fullmatch(str(result.get("candidate_bundle_id", "")))
            or not SHA256_RE.fullmatch(str(result.get("candidate_manifest_sha256", "")))
            or result["candidate_bundle_id"] == owner_bundle
            or not _valid_uuid(result.get("api_instance_id"))
            or type(result.get("renewal_observation_ms")) is not int
            or result["renewal_observation_ms"] < 5000
            or type(result.get("paused_observation_ms")) is not int
            or result["paused_observation_ms"] < 5000
        ):
            raise storage.StorageError("Consumer pump result identities do not match the verified A/B inputs")

        candidate_root = storage.validate_path(
            runtime_root / "native-bundles" / result["candidate_bundle_id"],
            storage_root,
            "consumer pump selected candidate bundle",
        )
        candidate_manifest_path = storage.validate_path(
            candidate_root / "manifest.json", storage_root, "consumer pump selected manifest"
        )
        if candidate_manifest_path.stat().st_size > 256 * 1024:
            raise storage.StorageError("Consumer pump selected candidate manifest exceeds its limit")
        raw_candidate_manifest = candidate_manifest_path.read_bytes()
        candidate_manifest_sha256 = _sha256(raw_candidate_manifest)
        candidate_manifest, candidate_file_hashes = runtime_bundle.validate_bundle(
            candidate_root, runtime_root, "dev"
        )
        candidate_source = candidate_manifest.get("source")
        if not isinstance(candidate_source, dict):
            raise storage.StorageError("Consumer pump selected candidate lacks source identity")
        if (
            candidate_manifest_sha256 != result["candidate_manifest_sha256"]
            or candidate_manifest_path.read_bytes() != raw_candidate_manifest
            or owner_manifest_path.read_bytes() != raw_owner_manifest
            or ready_manifest_path.read_bytes() != raw_ready_manifest
            or candidate_manifest.get("bundle_id") != result["candidate_bundle_id"]
            or candidate_source.get("workspace_namespace") != worktree
            or candidate_source.get("git_commit") != manifest.get("git_commit")
            or candidate_source.get("source_snapshot_sha256") != ready_snapshot_sha256
            or candidate_source.get("backend_source_sha256") != ready_source_sha256
            or candidate_source.get("manifest_sha256") != ready_build_id
            or candidate_source.get("source_snapshot_sha256") == owner_source.get("source_snapshot_sha256")
            or candidate_source.get("backend_source_sha256") == owner_source_sha256
            or candidate_manifest_sha256 == owner_manifest_sha256
        ):
            raise storage.StorageError("Consumer pump selected bundle is not the real, verified B candidate")

        receipt["consumer_pump_candidate"] = {
            "bundle_id": candidate_manifest["bundle_id"],
            "bundle_manifest_sha256": candidate_manifest_sha256,
            "source_snapshot_sha256": candidate_source["source_snapshot_sha256"],
            "backend_source_sha256": candidate_source["backend_source_sha256"],
            "source_manifest_sha256": candidate_source["manifest_sha256"],
            "git_commit": candidate_source["git_commit"],
            "workspace_namespace": candidate_source["workspace_namespace"],
            "validated_files": candidate_file_hashes,
        }
        receipt["consumer_pump_result"] = result
        receipt["checks"].extend(
            f"consumer-pump-{name}" for name in sorted(EXPECTED_CHECKS)
        )
        heartbeat.raise_if_failed()
    finally:
        if api_started and not api_terminal:
            safe_to_restore_status = False
        if heartbeat is not None:
            heartbeat.stop()
        if status_published and safe_to_restore_status:
            _restore_diagnostic_status(status, worktree, generation, original_status)
        elif status_published:
            receipt["consumer_pump_diagnostic_status"] = "retained; owned API process outcome is unknown"
        helper_hashes_after = _hash_helpers(repo)
        receipt["consumer_pump_fixture"]["helper_sha256_after"] = helper_hashes_after
        if helper_hashes_after != helper_hashes_before and sys.exc_info()[0] is None:
            raise storage.StorageError("Consumer pump helpers changed during the managed probe")
