#!/usr/bin/env python3
"""Run the managed CPU/SLEPc modal wrapper on an ephemeral GitHub Linux VM.

This is a narrow GHA entrypoint around Fullmag's existing storage, container,
source-capture, queue, lease, and receipt APIs. It does not qualify the solver.
"""

from __future__ import annotations

import contextlib
import getpass
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import threading
import time
from typing import Any


PROFILE = "fem-cpu-slepc-modal-v1"
EXPECTED_REPOSITORY = "MateuszZelent/fullmag"
OPERATION_DEADLINE_SECONDS = 285 * 60
POLL_INTERVAL_SECONDS = 5.0
POLL_REQUEST_TIMEOUT_SECONDS = 10.0
MAX_LOG_TAIL_BYTES = 64 * 1024
MAX_EVIDENCE_FILE_BYTES = 8 * 1024 * 1024
TERMINAL_STATES = {"succeeded", "failed", "cancelled", "blocked"}
REPORT_FILES = (
    "contracts/slepc-modal/result.json",
    "contracts/slepc-modal/cmake-attestation.json",
    "contracts/slepc-modal/runtime-attestation.json",
    "contracts/slepc-modal/dependency-attestation.json",
    "contracts/slepc-modal/resolution-attestation.json",
    "contracts/slepc-modal/ctest-junit-attestation.json",
    "contracts/slepc-modal/library-identity-attestation.json",
    "contracts/slepc-modal/test.junit.xml",
)


class ManagedRunError(RuntimeError):
    pass


def _require(condition: object, message: str) -> None:
    if not condition:
        raise ManagedRunError(message)


def _json_file(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError) as error:
        raise ManagedRunError(f"Invalid JSON evidence file: {path.name}") from error


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _redact(message: str) -> str:
    message = re.sub(r"(?i)\bbearer\s+[A-Za-z0-9._~+/-]+", "Bearer [redacted]", message)
    message = re.sub(
        r"(?i)(\b(?:token|password|secret|authorization)\b\s*[:=]\s*)[^\s,;}]+",
        r"\1[redacted]",
        message,
    )
    return message[:1200]


def _git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode != 0:
        raise ManagedRunError(f"Git identity query failed: {result.stderr.strip()[:500]}")
    return result.stdout.strip()


def _checked_checkout(repo_arg: str) -> tuple[Path, str]:
    _require(os.environ.get("GITHUB_ACTIONS") == "true", "This entrypoint runs only inside GitHub Actions.")
    _require(os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch", "Managed execution is manual-dispatch only.")
    _require(os.environ.get("RUN_MANAGED_WRAPPER") == "true", "The explicit managed-wrapper opt-in is required.")
    _require(
        os.environ.get("GITHUB_REPOSITORY") == EXPECTED_REPOSITORY,
        "Refusing to run outside the canonical Fullmag repository.",
    )
    _require(sys.platform == "linux", "The managed coordinator requires a Linux host.")
    expected_sha = os.environ.get("GITHUB_SHA", "").lower()
    _require(re.fullmatch(r"[0-9a-f]{40}", expected_sha) is not None, "GITHUB_SHA must be a full commit SHA.")
    repo = Path(repo_arg).resolve(strict=True)
    checkout_root = Path(_git(repo, "rev-parse", "--show-toplevel")).resolve(strict=True)
    _require(repo == checkout_root, "The requested root is not the checked-out repository root.")
    head = _git(repo, "rev-parse", "HEAD").lower()
    _require(head == expected_sha, "Checked-out HEAD does not equal GITHUB_SHA.")
    _require(
        not _git(repo, "status", "--porcelain", "--untracked-files=all"),
        "The checkout must be clean before canonical source capture.",
    )
    _require((repo / "scripts" / "run_fem_cpu_slepc_modal_contract.sh").is_file(), "Modal wrapper is absent from this SHA.")
    return repo, expected_sha


def _prepare_evidence() -> tuple[Path, Path]:
    runner_temp = os.environ.get("RUNNER_TEMP")
    _require(bool(runner_temp), "RUNNER_TEMP is required for isolated evidence output.")
    root = Path(runner_temp).resolve(strict=True)
    evidence = root / "fullmag-managed-modal-evidence"
    docker_config = root / "fullmag-managed-modal-docker-config"
    evidence.mkdir(parents=False, exist_ok=False)
    docker_config.mkdir(parents=False, exist_ok=False)
    return evidence, docker_config


def _docker_environment(docker_config: Path) -> dict[str, str]:
    environment = os.environ.copy()
    for name in ("DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "DOCKER_API_VERSION"):
        environment.pop(name, None)
    environment["DOCKER_HOST"] = "unix:///var/run/docker.sock"
    environment["DOCKER_CONFIG"] = str(docker_config)
    environment["FULLMAG_STORAGE_PROFILE"] = "linux-host"
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    return environment


def _capture_command(argv: list[str], *, cwd: Path, environment: dict[str, str], timeout: float = 60.0) -> str:
    result = subprocess.run(
        argv,
        cwd=cwd,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if result.returncode != 0:
        raise ManagedRunError(
            f"Command failed ({result.returncode}): {Path(argv[0]).name}; {_redact(result.stderr.strip())}"
        )
    return result.stdout.strip()


def _docker_info_from_adapter(docker_call: Any) -> dict[str, Any]:
    try:
        info = json.loads(docker_call(["info"]))
    except (TypeError, ValueError) as error:
        raise ManagedRunError("The Unix-socket adapter returned invalid Docker info JSON.") from error
    _require(isinstance(info, dict), "Docker Engine info must be an object.")
    return info


def _daemon_identity(repo: Path, environment: dict[str, str], docker_call: Any, evidence: Path) -> dict[str, Any]:
    socket_path = Path("/var/run/docker.sock")
    _require(socket_path.exists() and stat.S_ISSOCK(socket_path.stat().st_mode), "The canonical Linux Docker socket is unavailable.")
    adapter_info = _docker_info_from_adapter(docker_call)
    cli_raw = _capture_command(
        ["docker", "info", "--format", "{{json .}}"], cwd=repo, environment=environment
    )
    try:
        cli_info = json.loads(cli_raw)
    except ValueError as error:
        raise ManagedRunError("Docker CLI info was not valid JSON.") from error
    _require(isinstance(cli_info, dict), "Docker CLI info must be an object.")
    identity_keys = ("Name", "DockerRootDir", "ServerVersion", "OSType")
    for key in identity_keys:
        _require(isinstance(adapter_info.get(key), str) and adapter_info.get(key), f"Unix Docker info is missing {key}.")
        _require(adapter_info.get(key) == cli_info.get(key), f"Docker CLI and Unix adapter daemon identity differ at {key}.")
    _require(adapter_info["OSType"] == "linux", "The selected Docker daemon is not Linux.")
    identity = {key: adapter_info[key] for key in identity_keys}
    if isinstance(adapter_info.get("ID"), str) and adapter_info.get("ID"):
        _require(adapter_info.get("ID") == cli_info.get("ID"), "Docker CLI and Unix adapter daemon IDs differ.")
        identity["ID"] = adapter_info["ID"]
    identity["socket"] = str(socket_path)
    _write_json(evidence / "docker-daemon-identity.json", identity)
    return identity


def _drain_bounded(pipe: Any, tail: bytearray, lock: threading.Lock, errors: list[BaseException]) -> None:
    try:
        while True:
            chunk = pipe.read(16 * 1024)
            if not chunk:
                return
            with lock:
                tail.extend(chunk)
                if len(tail) > MAX_LOG_TAIL_BYTES:
                    del tail[:-MAX_LOG_TAIL_BYTES]
    except BaseException as error:  # reader thread errors are relayed to the owner thread
        errors.append(error)


def _run_bounded_process(
    argv: list[str], *, cwd: Path, environment: dict[str, str], deadline: float, evidence: Path, label: str
) -> None:
    remaining = deadline - time.monotonic()
    _require(remaining > 0, "Managed execution deadline expired before the next image build.")
    tail = bytearray()
    tail_lock = threading.Lock()
    reader_errors: list[BaseException] = []
    process = subprocess.Popen(
        argv,
        cwd=cwd,
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        bufsize=0,
    )
    assert process.stdout is not None
    reader = threading.Thread(target=_drain_bounded, args=(process.stdout, tail, tail_lock, reader_errors), daemon=True)
    reader.start()
    timed_out = False
    drainer_stuck = False
    try:
        code = process.wait(timeout=remaining)
    except subprocess.TimeoutExpired:
        timed_out = True
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        code = process.returncode
    finally:
        reader.join(timeout=10)
        if reader.is_alive():
            drainer_stuck = True
            process.stdout.close()
            reader.join(timeout=1)
        else:
            process.stdout.close()
    log_path = evidence / f"{label}-build-tail.log"
    log_path.write_bytes(bytes(tail))
    if drainer_stuck:
        raise ManagedRunError(f"Could not finish draining the bounded {label} build log.")
    if reader_errors:
        raise ManagedRunError(f"Could not capture bounded {label} build diagnostics.") from reader_errors[0]
    if timed_out:
        raise ManagedRunError(f"{label} Docker build exceeded the shared managed-run deadline; no retry was started.")
    if code != 0:
        raise ManagedRunError(f"{label} Docker build exited with status {code}; bounded log tail is in the evidence artifact.")


def _image_id(docker_call: Any, reference: str) -> str:
    try:
        inspected = json.loads(docker_call(["image", "inspect", reference]))
    except (TypeError, ValueError) as error:
        raise ManagedRunError(f"Docker image inspect returned invalid metadata for {reference}.") from error
    _require(isinstance(inspected, list) and len(inspected) == 1, f"Expected exactly one image for {reference}.")
    image_id = inspected[0].get("Id") if isinstance(inspected[0], dict) else None
    _require(isinstance(image_id, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", image_id), f"Image {reference} has no immutable ID.")
    return image_id


def _build_images(repo: Path, run_tag: str, environment: dict[str, str], docker_call: Any, deadline: float, evidence: Path) -> dict[str, str]:
    toolchain_tag = f"fullmag-managed-modal-toolchain:{run_tag}"
    worker_tag = f"fullmag-managed-modal-worker:{run_tag}"
    coordinator_tag = f"fullmag-managed-modal-coordinator:{run_tag}"
    builds = (
        (
            "toolchain",
            ["docker", "build", "--progress=plain", "--file", "docker/fem-cpu/Dockerfile", "--target", "fem-cpu-dev",
             "--build-arg", "FULLMAG_FEM_CPU_BUILD_JOBS=2", "--build-arg", "FULLMAG_FEM_CPU_WITH_SLEPC=OFF",
             "--tag", toolchain_tag, "."],
        ),
        (
            "worker",
            ["docker", "build", "--progress=plain", "--file", "scripts/local_runner/Dockerfile.build",
             "--build-arg", f"TOOLCHAIN_IMAGE={toolchain_tag}", "--build-arg", "CPU_MFEM_ONLY=1",
             "--tag", worker_tag, "scripts"],
        ),
        (
            "coordinator",
            ["docker", "build", "--progress=plain", "--file", "scripts/local_runner/Dockerfile.coordinator",
             "--tag", coordinator_tag, "scripts"],
        ),
    )
    ids: dict[str, str] = {}
    for label, argv in builds:
        print(f"Building the pinned {label} image on the selected local Linux daemon.", flush=True)
        _run_bounded_process(argv, cwd=repo, environment=environment, deadline=deadline, evidence=evidence, label=label)
        ids[label] = _image_id(docker_call, {"toolchain": toolchain_tag, "worker": worker_tag, "coordinator": coordinator_tag}[label])
        _write_json(evidence / "image-ids.json", ids)
    return ids


def _health_gate(health: object, expected_profiles: tuple[str, ...]) -> dict[str, Any]:
    _require(isinstance(health, dict), "Coordinator health response is not an object.")
    _require(health.get("ok") is True, "Coordinator health is not ready.")
    _require(health.get("accepting_jobs") is True, "Coordinator is not accepting jobs.")
    _require(health.get("worker_alive") is True, "Coordinator queue worker is not alive.")
    _require(health.get("worker_error") in (None, ""), "Coordinator reports a worker error.")
    _require(health.get("active_jobs") == [], "Coordinator has active jobs before this run.")
    _require(health.get("legacy_jobs") == [], "Coordinator has legacy jobs requiring recovery.")
    observed = health.get("allowed_profiles")
    _require(isinstance(observed, list) and set(observed) == set(expected_profiles), "Coordinator profile allow-list does not match configured intent.")
    _require(PROFILE in observed, "The SLEPc modal profile is not enabled by the coordinator.")
    _require(health.get("qualification") == "NOT VERIFIED", "Coordinator health must retain the non-qualification status.")
    return {
        key: health.get(key)
        for key in ("ok", "accepting_jobs", "worker_alive", "worker_state", "worker_error", "active_jobs", "legacy_jobs", "allowed_profiles", "qualification")
    }


def _submit_with_capture(repo: Path, sha: str, request_key: str, *, layout: dict[str, Any], owner: str, api: Any) -> dict[str, Any]:
    import local_runner_cli

    stdout = io.StringIO()
    stderr = io.StringIO()
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        code = local_runner_cli.main([
            "--repo-root", str(repo), "submit", "--source", "commit", "--ref", sha,
            "--operation", "build", "--profile", PROFILE, "--request-key", request_key,
        ])
    parsed: dict[str, Any] | None = None
    if code == 0:
        try:
            value = json.loads(stdout.getvalue())
            if isinstance(value, dict):
                parsed = value
        except ValueError:
            parsed = None
    if parsed is None or parsed.get("request_key") != request_key:
        # POST may have been accepted even if its response was lost. Reconcile
        # only by the original idempotency key; never submit a replacement job.
        matches: list[dict[str, Any]] = []
        for attempt in range(12):
            records = api.request(layout, owner=owner, method="GET", path="/jobs", timeout=10)
            _require(isinstance(records, list), "Coordinator job list is not an array during request-key reconciliation.")
            matches = [record for record in records if isinstance(record, dict) and record.get("request_key") == request_key]
            if matches:
                break
            if attempt < 11:
                time.sleep(5)
        _require(len(matches) == 1, "Submission response was inconclusive and the original request key did not resolve to exactly one job; no retry was sent.")
        parsed = matches[0]
        _require(parsed.get("owner") == owner, "Reconciled job owner does not match the submitting operator.")
    job_id = parsed.get("job_id")
    _require(isinstance(job_id, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", job_id), "Submit did not return a valid job ID.")
    _require(parsed.get("profile") == PROFILE and parsed.get("operation") == "build", "Submitted job does not match the requested profile/operation.")
    _require(parsed.get("request_key") == request_key and parsed.get("owner") == owner, "Submitted job identity mismatch.")
    exact = api.request(layout, owner=owner, method="GET", path=f"/jobs/{job_id}", timeout=10)
    _require(isinstance(exact, dict) and exact.get("job_id") == job_id, "The submitted job cannot be read back by its exact ID.")
    _require(exact.get("request_key") == request_key and exact.get("owner") == owner, "Read-back job identity does not match the exact request.")
    _write_json(_CURRENT_EVIDENCE / "job-submission.json", {
        key: exact.get(key)
        for key in ("job_id", "worktree_id", "source_digest", "request_key", "operation", "profile", "state", "exit_code", "owner", "created_at")
    })
    if code != 0:
        print(f"Submit response was reconciled by its original request key after CLI status {code}.", flush=True)
    return exact


_CURRENT_EVIDENCE: Path


def _poll_job(layout: dict[str, Any], owner: str, job: dict[str, Any], *, api: Any, deadline: float, evidence: Path) -> dict[str, Any]:
    job_id = job["job_id"]
    last_error: str | None = None
    consecutive_errors = 0
    while time.monotonic() < deadline:
        remaining = deadline - time.monotonic()
        try:
            latest = api.request(
                layout, owner=owner, method="GET", path=f"/jobs/{job_id}",
                timeout=min(POLL_REQUEST_TIMEOUT_SECONDS, max(0.5, remaining)),
            )
            _require(isinstance(latest, dict) and latest.get("job_id") == job_id, "Coordinator returned a different job during polling.")
            _require(latest.get("request_key") == job.get("request_key"), "Polled job request key changed.")
            state = latest.get("state")
            if state in TERMINAL_STATES:
                _write_json(evidence / "job-terminal.json", {
                    key: latest.get(key)
                    for key in ("job_id", "worktree_id", "source_digest", "request_key", "operation", "profile", "state", "exit_code", "owner", "created_at", "started_at", "finished_at")
                })
                return latest
            _require(state in {"queued", "running", "cancel_requested"}, f"Coordinator returned unknown job state {state!r}.")
            last_error = None
            consecutive_errors = 0
        except api.ContainerClientError as error:
            # Read-only status polling may be retried; the job is never resubmitted.
            last_error = f"{type(error).__name__}: {_redact(str(error))}"
            consecutive_errors += 1
            _require(consecutive_errors <= 12, "Coordinator status endpoint stayed unavailable; the existing job was not resubmitted.")
        time.sleep(min(POLL_INTERVAL_SECONDS, max(0.0, deadline - time.monotonic())))
    _write_json(evidence / "job-observation-timeout.json", {
        "job_id": job_id,
        "request_key": job.get("request_key"),
        "last_read_error": last_error,
        "state": "unknown-after-observation-deadline",
        "retry_submitted": False,
    })
    raise ManagedRunError("The existing job did not reach a terminal state before the observation deadline; no retry or cancellation was issued.")


def _safe_job_summary(job: dict[str, Any]) -> dict[str, Any]:
    return {
        key: job.get(key)
        for key in ("job_id", "worktree_id", "source_digest", "request_key", "operation", "profile", "state", "exit_code", "owner", "created_at", "started_at", "finished_at")
    }


def _tail_file(source: Path, destination: Path, *, limit: int = MAX_LOG_TAIL_BYTES) -> None:
    if not source.is_file() or source.is_symlink():
        return
    size = source.stat().st_size
    with source.open("rb") as stream:
        stream.seek(max(0, size - limit))
        data = stream.read(limit)
    destination.write_bytes(data)


def _copy_report_evidence(artifacts: Path, evidence: Path, receipt: dict[str, Any], validate_path: Any) -> list[dict[str, Any]]:
    artifact_entries = receipt.get("artifacts")
    _require(isinstance(artifact_entries, list), "Validated build receipt artifact list is missing.")
    by_path = {
        entry.get("path"): entry
        for entry in artifact_entries
        if isinstance(entry, dict) and isinstance(entry.get("path"), str)
    }
    selected = ["build-receipt.json", "source-identity.json", *REPORT_FILES]
    for relative in selected:
        source = validate_path(artifacts / PurePosixPath(relative), artifacts, "selected evidence artifact")
        _require(source.is_file() and not source.is_symlink(), f"Required evidence artifact is absent: {relative}")
        _require(source.stat().st_size <= MAX_EVIDENCE_FILE_BYTES, f"Evidence artifact exceeds the bounded size: {relative}")
        if relative != "build-receipt.json":
            _require(relative in by_path, f"Evidence artifact is not listed in the validated receipt: {relative}")
        target = evidence / PurePosixPath(relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    receipt_copy = _json_file(evidence / "build-receipt.json")
    identity = _json_file(evidence / "source-identity.json")
    modal_result = _json_file(evidence / "contracts/slepc-modal/result.json")
    attestation = modal_result.get("attestation") if isinstance(modal_result, dict) else None
    _require(isinstance(identity, dict), "Source identity evidence is not an object.")
    _require(isinstance(attestation, dict), "Modal wrapper result lacks its execution attestations.")
    for name in ("cmake", "runtime", "dependency", "resolution", "ctest_junit", "library_identity"):
        component = attestation.get(name)
        _require(isinstance(component, dict) and component.get("status") == "pass", f"Modal {name} attestation is not passing.")
    _require(modal_result.get("status") == "pass" and modal_result.get("scenario") == "slepc-modal", "Modal wrapper result is not a passing slepc-modal result.")
    _require(receipt_copy.get("qualification") == "NOT VERIFIED", "Build receipt must remain explicitly unqualified.")
    reported_hashes: list[dict[str, Any]] = []
    for path, entry in sorted(by_path.items()):
        is_report = path in REPORT_FILES
        is_runtime_library = path.startswith("outputs/.fullmag/local/lib/libfullmag_fem.so")
        if is_report or is_runtime_library:
            reported_hashes.append({"path": path, "size": entry.get("size"), "sha256": entry.get("sha256")})
    _require(any(entry["path"].startswith("outputs/.fullmag/local/lib/libfullmag_fem.so") for entry in reported_hashes), "Validated receipt lacks the tested native FEM library hash.")
    _write_json(evidence / "validated-artifact-hashes.json", reported_hashes)
    return reported_hashes


def _save_terminal_evidence(
    *, repo: Path, sha: str, run_id: str, attempt: str, owner: str, layout: dict[str, Any],
    job: dict[str, Any], journal: dict[str, Any], worker_image_id: str, evidence: Path,
    validate_build_receipt: Any, validate_path: Any,
) -> None:
    _require(job.get("state") == "succeeded" and job.get("exit_code") == 0, "The managed build job did not succeed with exit code 0.")
    _require(job.get("profile") == PROFILE and job.get("operation") == "build", "Terminal job profile or operation mismatch.")
    _require(job.get("owner") == owner, "Terminal job owner mismatch.")
    payload = job.get("payload")
    native = payload.get("native_source_identity") if isinstance(payload, dict) else None
    _require(isinstance(native, dict) and native.get("head_commit_full", "").lower() == sha, "Job native source identity is not bound to GITHUB_SHA.")
    _require(journal.get("job_id") == job.get("job_id") and journal.get("owner") == owner, "Coordinator journal identity mismatch.")
    _require(journal.get("phase") == "terminal" and journal.get("state") == "succeeded" and journal.get("exit_code") == 0, "Coordinator journal is not terminal-success for this job.")
    _require(journal.get("profile") == PROFILE and journal.get("image_digest") == worker_image_id, "Coordinator journal profile/image identity mismatch.")
    _require(journal.get("source_digest") == job.get("source_digest"), "Coordinator journal source digest mismatch.")
    storage = Path(layout["storage_root"])
    run_root = validate_path(storage / "runs" / job["worktree_id"] / job["job_id"], storage, "managed run root")
    artifacts = validate_path(run_root / "artifacts", storage, "managed artifacts")
    validate_build_receipt(artifacts, job, journal)
    receipt = _json_file(artifacts / "build-receipt.json")
    identity = _json_file(artifacts / "source-identity.json")
    _require(identity == native, "Validated source identity artifact differs from the job identity.")
    _require(identity.get("head_commit_full", "").lower() == sha, "Source identity artifact does not identify GITHUB_SHA.")
    hashes = _copy_report_evidence(artifacts, evidence, receipt, validate_path)
    _tail_file(run_root / "worker.log", evidence / "worker-log-tail.log")
    safe_journal = {
        key: journal.get(key)
        for key in ("schema", "job_id", "owner", "operation", "profile", "source_digest", "image_digest", "phase", "container_id", "started_at", "finished_at", "exit_code", "qualification")
    }
    safe_journal["state"] = journal.get("state")
    _write_json(evidence / "coordinator-terminal-summary.json", safe_journal)
    _write_json(evidence / "run-summary.json", {
        "repository": EXPECTED_REPOSITORY,
        "commit": sha,
        "workflow_run_id": run_id,
        "workflow_attempt": attempt,
        "job": _safe_job_summary(job),
        "profile": PROFILE,
        "wrapper_result": "pass",
        "library_artifact_hash_count": sum(item["path"].startswith("outputs/.fullmag/local/lib/libfullmag_fem.so") for item in hashes),
        "qualification": "NOT VERIFIED",
        "scientific_qualification": "NOT VERIFIED",
    })


def run(repo_arg: str) -> int:
    global _CURRENT_EVIDENCE
    repo, sha = _checked_checkout(repo_arg)
    evidence: Path | None = None
    phase = "startup"
    run_id = os.environ.get("GITHUB_RUN_ID", "")
    attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "")
    try:
        _require(run_id.isdigit() and attempt.isdigit(), "GitHub run ID and attempt are required.")
        _require(not os.environ.get("FULLMAG_PROJECT_STORAGE_ROOT"), "This workflow must use the canonical Linux storage root, without an override.")
        sys.path.insert(0, str(repo / "scripts"))
        from fullmag_storage import initialize, register, resolve_layout, validate_path
        from local_runner import container_client, unix_docker
        from local_runner.build_executor import configure_build, configured_build, validate_build_receipt

        bootstrap_layout = resolve_layout(repo, "linux-host")
        canonical_storage = Path(bootstrap_layout["project_root"]) / "storage"
        _require(
            Path(bootstrap_layout["storage_root"]) == canonical_storage,
            "Read-only resolver did not identify the canonical sibling Linux storage root.",
        )
        os.environ["FULLMAG_PROJECT_STORAGE_ROOT"] = str(canonical_storage)
        os.environ["FULLMAG_STORAGE_PROFILE"] = "linux-host"
        evidence, docker_config = _prepare_evidence()
        _CURRENT_EVIDENCE = evidence
        environment = _docker_environment(docker_config)
        layout = resolve_layout(repo, "linux-host")
        _require(
            Path(layout["project_root"]) == Path(bootstrap_layout["project_root"]),
            "Storage project identity changed after explicit canonical-root selection.",
        )
        _require(Path(layout["storage_root"]) == canonical_storage, "Resolver did not select the canonical sibling Linux storage root.")
        _require(
            os.environ.get("FULLMAG_PROJECT_STORAGE_ROOT") == str(canonical_storage)
            and environment.get("FULLMAG_PROJECT_STORAGE_ROOT") == str(canonical_storage),
            "CLI and Docker subprocesses do not share the explicit canonical storage root.",
        )
        _require(layout.get("profile") == "linux-host", "Storage resolver did not retain the Linux-host profile.")
        owner = getpass.getuser()
        task_id = f"gha-managed-modal-{run_id}-{attempt}"
        initialize(layout)
        register(layout, task_id, owner, "ephemeral GitHub Actions managed modal wrapper")
        _write_json(evidence / "storage-identity.json", {
            "profile": layout["profile"],
            "platform": layout.get("platform", "linux"),
            "worktree_id": layout["worktree_id"],
            "storage_root": layout["storage_root"],
            "canonical_storage_root": str(canonical_storage),
        })

        phase = "docker-daemon-identity"
        daemon = _daemon_identity(repo, environment, unix_docker.docker, evidence)
        existing = unix_docker.docker(["ps", "-a", "--no-trunc", "--filter", "name=^/Fullmag_build_runner$", "--format", "{{.ID}}"])
        _require(not str(existing).strip(), "The ephemeral host already has a reserved Fullmag coordinator; refusing replacement or reuse.")

        phase = "image-builds"
        deadline = time.monotonic() + OPERATION_DEADLINE_SECONDS
        run_tag = f"{sha[:12]}-{run_id}-{attempt}"
        image_ids = _build_images(repo, run_tag, environment, unix_docker.docker, deadline, evidence)
        _write_json(evidence / "image-ids.json", image_ids)

        phase = "coordinator-configure-start"
        config_path = Path(layout["storage_root"]) / "index" / "local-runner-container.json"
        _require(not config_path.exists(), "A coordinator configuration already exists in this fresh storage root; refusing implicit reuse.")
        container_client.configure(layout, image_ids["coordinator"], owner=owner, enable_slepc_modal=True)
        container_client.start(layout, owner=owner, call=unix_docker.docker)
        status = container_client.status(layout, owner=owner, call=unix_docker.docker)
        _require(status.get("running") is True and status.get("image_id") == image_ids["coordinator"], "Started coordinator identity is not attested.")
        activation = status.get("profile_activation")
        _require(isinstance(activation, dict) and activation.get("status") == "active", "Coordinator did not activate its configured profile set.")
        expected_profiles = tuple(container_client.SLEPC_MODAL_PROFILES)
        _require(set(activation.get("desired_allowed_profiles", [])) == set(expected_profiles), "Configured coordinator allow-list is unexpected.")
        _require(set(activation.get("observed_allowed_profiles", [])) == set(expected_profiles), "Observed coordinator allow-list is unexpected.")
        health = container_client.request(layout, owner=owner, method="GET", path="/health", timeout=10)
        health_summary = _health_gate(health, expected_profiles)
        _write_json(evidence / "coordinator-readiness.json", {
            "container_id": status.get("container_id"),
            "image_id": status.get("image_id"),
            "profile_activation": activation,
            "health": health_summary,
            "docker_daemon": daemon,
        })

        phase = "worker-profile-configure"
        configure_build(
            layout, PROFILE, image_ids["worker"], owner=owner, cpus=2,
            memory_bytes=6 * 1024**3, call=unix_docker.docker,
        )
        build_config = configured_build(layout, owner, PROFILE)
        _require(build_config.get("image_digest") == image_ids["worker"], "Worker profile did not retain the immutable image ID.")
        _require(build_config.get("cpus") == 2 and build_config.get("memory_bytes") == 6 * 1024**3, "Worker resource bounds differ from the managed workflow contract.")
        existing_jobs = container_client.request(layout, owner=owner, method="GET", path="/jobs", timeout=10)
        _require(isinstance(existing_jobs, list) and not existing_jobs, "Fresh coordinator queue is not empty before submission.")

        phase = "source-capture-and-submit"
        request_key = f"gha-modal-{sha[:12]}-{run_id}-{attempt}"
        job = _submit_with_capture(repo, sha, request_key, layout=layout, owner=owner, api=container_client)
        _require(job.get("state") in {"queued", "running", "succeeded"}, "Submitted job did not enter an executable state.")

        phase = "job-observation"
        terminal = _poll_job(layout, owner, job, api=container_client, deadline=deadline, evidence=evidence)
        if terminal.get("state") != "succeeded" or terminal.get("exit_code") != 0:
            run_root = Path(layout["storage_root"]) / "runs" / str(terminal.get("worktree_id")) / str(terminal.get("job_id"))
            _tail_file(run_root / "worker.log", evidence / "worker-log-tail.log")
            raise ManagedRunError(f"Managed build ended {terminal.get('state')} with exit code {terminal.get('exit_code')}.")

        phase = "receipt-and-artifact-validation"
        storage = Path(layout["storage_root"])
        run_root = validate_path(storage / "runs" / terminal["worktree_id"] / terminal["job_id"], storage, "managed run root")
        journal_path = validate_path(run_root / "coordinator.json", storage, "coordinator journal")
        journal = _json_file(journal_path)
        _save_terminal_evidence(
            repo=repo, sha=sha, run_id=run_id, attempt=attempt, owner=owner, layout=layout,
            job=terminal, journal=journal, worker_image_id=image_ids["worker"], evidence=evidence,
            validate_build_receipt=validate_build_receipt, validate_path=validate_path,
        )
        print(f"Managed wrapper completed for {sha}; validated receipt and artifact hashes. Qualification remains NOT VERIFIED.", flush=True)
        return 0
    except Exception as error:
        failure = {
            "phase": phase,
            "error_type": type(error).__name__,
            "message": _redact(str(error)),
            "retry_submitted": False,
            "qualification": "NOT VERIFIED",
        }
        if evidence is not None:
            try:
                _write_json(evidence / "failure.json", failure)
            except Exception:
                pass
        print(f"Managed wrapper failed during {phase}: {failure['message']}", file=sys.stderr, flush=True)
        return 1


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] != "--repo-root":
        print("usage: run_managed_modal_wrapper.py --repo-root <checkout>", file=sys.stderr)
        return 2
    try:
        return run(sys.argv[2])
    except Exception as error:
        print(f"Managed wrapper startup failed: {_redact(str(error))}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
