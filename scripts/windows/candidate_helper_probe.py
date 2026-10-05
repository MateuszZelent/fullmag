"""Private helper process used by the managed candidate-preparation fault probe."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import time


REQUEST_SCHEMA = "fullmag.development-candidate-helper-probe-request.v1"
ACK_SCHEMA = "fullmag.development-candidate-helper-probe-ack.v1"
PROBE_CASES = {
    "success",
    "nonzero_exit",
    "output_overflow",
    "explicit_cancel",
    "timeout",
    "incomplete_stdin",
    "child_early_exit",
}
MAX_REQUEST_BYTES = 16 * 1024


def _ack(case: str) -> bytes:
    return json.dumps(
        {"schema": ACK_SCHEMA, "case": case},
        separators=(",", ":"),
    ).encode("ascii") + b"\n"


def _read_request(case: str) -> bool:
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        return False
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False
    return (
        isinstance(value, dict)
        and set(value) == {"schema", "case", "padding"}
        and value["schema"] == REQUEST_SCHEMA
        and value["case"] == case
        and value["padding"] is None
    )


def main() -> int:
    if (
        os.environ.get("FULLMAG_DEVELOPMENT_OWNER_PROBE") != "1"
        or os.environ.get("FULLMAG_DEVELOPMENT_RESTART_PROBE_CASE") != "preparation-faults"
    ):
        return 2

    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--repo-root", required=True)
    try:
        args = parser.parse_args()
    except SystemExit:
        return 2
    if not Path(args.repo_root).is_dir():
        return 2

    if case_name := os.environ.get("FULLMAG_CANDIDATE_HELPER_PROBE_CASE"):
        if case_name not in PROBE_CASES:
            return 2
    else:
        return 2

    if case_name == "incomplete_stdin":
        # The parent writes the strict prefix, then observes this ACK and the
        # actual exit before attempting the tail. Close the descriptor so Windows'
        # pipe buffer size cannot turn the intended broken pipe into success.
        header = json.dumps(
            {"schema": REQUEST_SCHEMA, "case": case_name, "padding": ""},
            separators=(",", ":"),
        ).encode("ascii")[:-2]
        if sys.stdin.buffer.read(len(header)) != header:
            return 3
        os.close(sys.stdin.fileno())
        sys.stdout.buffer.write(_ack(case_name))
        sys.stdout.buffer.flush()
        return 0
    if not _read_request(case_name):
        return 3
    if case_name == "child_early_exit":
        return 9
    if case_name == "nonzero_exit":
        sys.stdout.buffer.write(_ack(case_name))
        sys.stdout.buffer.flush()
        return 7
    if case_name == "output_overflow":
        sys.stdout.buffer.write(b"x" * 256)
        sys.stdout.buffer.flush()
        return 0
    if case_name in {"explicit_cancel", "timeout"}:
        sys.stdout.buffer.write(_ack(case_name))
        sys.stdout.buffer.flush()
        while True:
            time.sleep(0.05)
    sys.stdout.buffer.write(_ack(case_name))
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
