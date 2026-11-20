#!/usr/bin/env python3
"""Run one exact Cargo test and reject empty selections."""

import re
import subprocess
import sys

ANSI = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]")
TARGETS = {"--lib", "--bin", "--test"}


def main(args):
    if "--" not in args:
        print("usage: run_exact_cargo_test.py CARGO_ARGS... -- --exact", file=sys.stderr)
        return 2
    split = args.index("--")
    cargo_args, harness_args = args[:split], args[split + 1 :]
    if not cargo_args or harness_args != ["--exact"]:
        print("expected one filter followed by -- --exact", file=sys.stderr)
        return 2
    if sum(arg in TARGETS for arg in cargo_args) != 1:
        print("expected exactly one --lib, --bin, or --test target", file=sys.stderr)
        return 2

    expected = cargo_args[-1]
    passed_line = f"test {expected} ... ok".encode()
    matches = 0
    with subprocess.Popen(["cargo", "test", *args], stdout=subprocess.PIPE) as process:
        for line in process.stdout:
            sys.stdout.buffer.write(line)
            sys.stdout.buffer.flush()
            if ANSI.sub(b"", line).rstrip(b"\r\n") == passed_line:
                matches += 1
        if process.wait():
            return process.returncode
    if matches != 1:
        print("exact Cargo test did not pass: " + expected, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
