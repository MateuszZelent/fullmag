#!/usr/bin/env python3
"""Reject zero-match, ignored, failed or ambiguous exact Rust test runs."""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

_SUMMARY = re.compile(
    r"^test result: (ok|FAILED)\. "
    r"(\d+) passed; (\d+) failed; (\d+) ignored; "
    r"(\d+) measured; (\d+) filtered out;(?:.*)$",
    re.MULTILINE,
)
_RUNNING = re.compile(r"^running (\d+) tests?\s*$", re.MULTILINE)


def validate_log(text: str) -> None:
    runs = _RUNNING.findall(text)
    summaries = _SUMMARY.findall(text)
    if runs != ["1"] or len(summaries) != 1:
        raise ValueError("expected exactly one test binary running exactly one test")
    status, passed, failed, ignored, measured, _filtered = summaries[0]
    if (status, passed, failed, ignored, measured) != ("ok", "1", "0", "0", "0"):
        raise ValueError("the selected test must pass; zero/ignored/failed tests do not qualify")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("log", type=Path)
    args = parser.parse_args()
    try:
        validate_log(args.log.read_text(encoding="utf-8", errors="strict"))
    except (OSError, UnicodeError, ValueError) as exc:
        print(f"FAIL: exact Rust contract: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
