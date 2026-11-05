#!/usr/bin/env python3
"""Submit one prepared accepted request in an exactly validated running DEV group."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import time
import urllib.request

from docker_build_control import BuildControlError, docker_capture
from docker_dev_defaults import _discover_pins, resolve_defaults

# Match the public CLI accepted-request bound; archive bounds are separate.
MAX_REQUEST_BYTES = 96 * 1024 * 1024
SHA256_RE = re.compile(r"[0-9a-f]{64}")


def validate_relative(value: str) -> str:
    path = PurePosixPath(value)
    if (not value or str(path) != value or path.is_absolute()
            or any(part in {".", ".."} for part in path.parts)
            or path.parts[0] != "verification" or "\\" in value or "\x00" in value):
        raise ValueError("request must be a canonical verification-relative path")
    return value


def _validated_request(root: Path, relative: str, expected_sha256: str, snapshot: str):
    validate_relative(relative)
    if not SHA256_RE.fullmatch(expected_sha256) or not SHA256_RE.fullmatch(snapshot):
        raise ValueError("invalid SHA-256 pin")
    path = root / relative
    if any(item.is_symlink() for item in (path, *path.parents)):
        raise ValueError("request traverses a symbolic link")
    with path.open("rb") as stream:
        metadata = os.fstat(stream.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise ValueError("request must be a private regular file")
        raw = stream.read(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES or hashlib.sha256(raw).hexdigest() != expected_sha256:
        raise ValueError("request size or digest differs")
    provenance = json.loads((root / "backend/runtime-provenance.json").read_bytes())
    if provenance["source_snapshot_sha256"] != snapshot:
        raise ValueError("published source snapshot differs")
    request = json.loads(raw)
    spec = request["run_intent"]["specification"]
    run_id = spec["run_id"]
    project_id = spec["snapshot"]["project_id"]
    if not isinstance(run_id, str) or not run_id or not isinstance(project_id, str) or not project_id:
        raise ValueError("accepted run identity is absent")
    return raw, run_id, project_id


def submit_once(root: Path, relative: str, expected_sha256: str, snapshot: str) -> dict:
    """Freeze validated bytes and fence before invoking the public CLI."""
    raw, run_id, project_id = _validated_request(root, relative, expected_sha256, snapshot)
    fence = root / "verification/accepted-submissions" / hashlib.sha256(run_id.encode()).hexdigest()
    fence.mkdir(parents=True, exist_ok=True)
    identity = {"run_id": run_id, "project_id": project_id,
                "request_sha256": expected_sha256, "source_snapshot_sha256": snapshot,
                "submit_count": 1, "started_unix": time.time()}
    # Exclusive durable intent forbids mutation replay even after transport loss.
    with (fence / "started.json").open("xb") as stream:
        stream.write(json.dumps(identity, sort_keys=True).encode() + b"\n")
        stream.flush()
        os.fsync(stream.fileno())
    directory_fd = os.open(fence, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
    frozen = fence / "request.json"
    with frozen.open("xb") as stream:
        stream.write(raw)
    command = ["/opt/fullmag/package/bin/fullmag-bin", "run-json", str(frozen),
               "--api-url", "http://127.0.0.1:8081", "--submit-only"]
    started = time.monotonic()
    with (fence / "stdout.log").open("xb") as stdout, (fence / "stderr.log").open("xb") as stderr:
        result = subprocess.run(command, stdout=stdout, stderr=stderr)
    receipt = {**identity, "cli_exit_code": result.returncode,
               "seconds": time.monotonic() - started, "command": command,
               "next_action": "Observe this exact run through GET; never repeat Submit after an unknown outcome."}
    (fence / "result.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


def materialize_once(root: Path, relative: str, expected_sha256: str, snapshot: str, fingerprint: str) -> dict:
    """Reconcile the accepted identity, then perform only the missing catalog step."""
    if not SHA256_RE.fullmatch(fingerprint):
        raise ValueError("invalid payload fingerprint")
    _, run_id, project_id = _validated_request(root, relative, expected_sha256, snapshot)
    from urllib.parse import quote
    url = ("http://127.0.0.1:8081/v2/persistence/projects/" + quote(project_id, safe="")
           + "/runs/" + quote(run_id, safe=""))
    with urllib.request.urlopen(url, timeout=15) as response:
        raw = response.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024:
        raise ValueError("run readback exceeds limit")
    accepted = json.loads(raw)
    if (accepted.get("run_id") != run_id or accepted.get("project_id") != project_id
            or accepted.get("payload_fingerprint") != fingerprint):
        raise ValueError("accepted run identity or fingerprint differs")
    if accepted.get("catalog_state") != "pending_materialization":
        raise ValueError("run is not pending materialization; inspect existing catalog")
    fence = root / "verification/accepted-submissions" / hashlib.sha256(run_id.encode()).hexdigest()
    fence.mkdir(parents=True, exist_ok=True)
    identity = {"run_id": run_id, "project_id": project_id, "payload_fingerprint": fingerprint,
                "request_sha256": expected_sha256, "source_snapshot_sha256": snapshot,
                "operation": "materialization", "started_unix": time.time()}
    with (fence / "materialization-started.json").open("xb") as stream:
        stream.write(json.dumps(identity, sort_keys=True).encode() + b"\n")
        stream.flush()
        os.fsync(stream.fileno())
    directory_fd = os.open(fence, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)
    request = urllib.request.Request(url + "/materialization", method="POST", data=b"")
    with urllib.request.urlopen(request, timeout=120) as response:
        raw = response.read(1024 * 1024 + 1)
        status = response.status
    if len(raw) > 1024 * 1024:
        raise ValueError("materialization response exceeds limit; inspect GET, do not replay")
    body = json.loads(raw)
    receipt = {**identity, "http_status": status, "body": body}
    (fence / "materialization-result.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--attempt", required=True)
    parser.add_argument("--config-sha256", required=True)
    parser.add_argument("--source-snapshot-sha256", required=True)
    parser.add_argument("--request-relative", required=True)
    parser.add_argument("--request-sha256", required=True)
    parser.add_argument("--operation", choices=("submit", "materialize"), default="submit")
    parser.add_argument("--payload-fingerprint")
    args = parser.parse_args()
    if (args.operation == "materialize") != (args.payload_fingerprint is not None):
        raise ValueError("materialization requires the accepted payload fingerprint")
    validate_relative(args.request_relative)
    if not SHA256_RE.fullmatch(args.request_sha256) or not SHA256_RE.fullmatch(args.source_snapshot_sha256):
        raise ValueError("invalid SHA-256 pin")
    defaults = resolve_defaults(args.repo_root, source_root=args.source_root)
    pins = _discover_pins(args.repo_root, defaults, expected_attempt=args.attempt,
                          expected_config_sha256=args.config_sha256)
    # Transfer only this orchestration module; execute the published native package.
    payload = Path(__file__).read_text()
    arguments = ", ".join(repr(value) for value in (args.request_relative, args.request_sha256, args.source_snapshot_sha256))
    if args.operation == "materialize":
        invocation = ("\nreceipt = materialize_once(Path('/opt/fullmag/control'), " + arguments
                      + ", " + repr(args.payload_fingerprint) + ")\nprint(json.dumps(receipt))\n")
    else:
        invocation = ("\nreceipt = submit_once(Path('/opt/fullmag/control'), " + arguments
                      + ")\nprint(json.dumps(receipt))\nraise SystemExit(receipt['cli_exit_code'])\n")
    # Image-side mode needs only stdlib; host admission imports are removed.
    payload = payload[:payload.index("def main()")]
    payload = payload.replace("from docker_build_control import BuildControlError, docker_capture\n", "")
    payload = payload.replace("from docker_dev_defaults import _discover_pins, resolve_defaults\n", "")
    result = docker_capture("exec", pins.backend_container_id, "/usr/local/bin/python3", "-I", "-B",
                            "-c", payload + invocation, timeout=150, allow_failure=True)
    sys.stdout.buffer.write(result.stdout)
    sys.stderr.buffer.write(result.stderr)
    return result.returncode


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (BuildControlError, OSError, ValueError, KeyError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2)
