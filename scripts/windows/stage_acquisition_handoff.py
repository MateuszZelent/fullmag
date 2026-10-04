"""Private stdin consumer for the native CLI's held authoring acquisition."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from windows import development_handoff as capsule
from windows.development_acquisition_handoff import stage_acquired_workspace

REQUEST_SCHEMA = "fullmag.development-acquisition-stage-request.v1"
MAX_REQUEST_BYTES = 128 * 1024 * 1024
MAX_ACK_BYTES = 16 * 1024
_REQUEST_FIELDS = frozenset({"schema", "acquisition_json", "source_identity", "candidate_bundle_root", "frontend_payload"})


def stage_request(repo_root: str, request: dict[str, Any]) -> dict[str, Any]:
    """Consume only an owner-validated request; never stop or restore a process."""
    capsule._exact_keys(request, _REQUEST_FIELDS, "acquisition stage request")
    if request["schema"] != REQUEST_SCHEMA:
        raise capsule.HandoffError("Unknown acquisition stage request schema")
    raw = request["acquisition_json"]
    candidate = request["candidate_bundle_root"]
    if not isinstance(raw, str) or not isinstance(candidate, str) or not candidate:
        raise capsule.HandoffError("Invalid acquisition stage request")
    try:
        data = raw.encode("utf-8", errors="strict")
    except UnicodeError as error:
        raise capsule.HandoffError("Acquisition is not UTF-8") from error
    return stage_acquired_workspace(repo_root, data, request["source_identity"],
                                    candidate, request["frontend_payload"])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", required=True)
    args = parser.parse_args(argv)
    try:
        if (os.environ.get("FULLMAG_NATIVE_RUNTIME_ACTIVE") != "1"
                or os.environ.get("FULLMAG_STORAGE_PROFILE") != "windows-native-fdm-cpu-dev"):
            raise capsule.HandoffError("Acquisition stage consumer requires managed native dev")
        # The CLI owns/closes stdin and enforces the absolute process deadline.
        # Reading one byte over the limit fails before any capsule is created.
        data = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        if len(data) > MAX_REQUEST_BYTES:
            raise capsule.HandoffError("Acquisition stage request exceeds its limit")
        request = capsule._strict_json(data, "acquisition stage request")
        result = stage_request(args.repo_root, request)
        encoded = capsule._canonical_json(result, "acquisition stage ACK", MAX_ACK_BYTES)
        sys.stdout.buffer.write(encoded + b"\n")
        sys.stdout.buffer.flush()
        return 0
    except (capsule.HandoffError, OSError, ValueError, TypeError, RecursionError):
        # Neither private payloads nor host paths appear in subprocess logs.
        print("Development acquisition staging failed", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
