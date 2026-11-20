#!/usr/bin/env python3
"""Run a single exact Cargo test and reject empty test selections."""

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
    cargo_args, test_args = args[:split], args[split + 1 :]
    if test_args != ["--exact"] or not cargo_args:
        print("expected one Cargo filter followed by -- --exact", file=sys.stderr)
        return 2
    if sum(arg in TARGETS for arg in cargo_args) != 1:
        print("expected exactly one --lib, --bin, or --test target", file=sys.stderr)
        return 2

    expected = cargo_args[-1]
    process = subprocess.Popen(["cargo", "test", *args], stdout=subprocess.PIPE)
    output, _ = process.communicate()
    sys.stdout.buffer.write(output)
    sys.stdout.buffer.flush()
    if process.returncode:
        return process.returncode

    output = ANSI.sub(b"", output)
    pattern = re.compile(
        rb"(?m)^test " + re.escape(expected.encode()) + rb" \.\.\. ok\r?$"
    )
    if len(pattern.findall(output)) != 1:
        print("exact Cargo test did not pass: " + expected, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
