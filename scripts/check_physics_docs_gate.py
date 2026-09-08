#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PHYSICS_FACING_PREFIXES = (
    "packages/fullmag-py/",
    "backends/",
    "crates/fullmag-ir/",
    "crates/fullmag-engine/",
    "native/",
    "docs/specs/",
    "examples/",
)
PHYSICS_DOC_PREFIX = "docs/physics/"


def changed_files(base: str, head: str) -> list[str]:
    diff_range = ["git", "-c", f"safe.directory={ROOT}", "diff", "--name-only"]
    if head == "WORKTREE":
        diff_range.append(base)
    else:
        diff_range.append(f"{base}..{head}")
    result = subprocess.run(
        diff_range,
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--head", required=True)
    args = parser.parse_args()

    files = changed_files(args.base, args.head)
    touches_physics_surface = any(path.startswith(PHYSICS_FACING_PREFIXES) for path in files)
    touches_physics_docs = any(path.startswith(PHYSICS_DOC_PREFIX) for path in files)

    if touches_physics_surface and not touches_physics_docs:
        print("FAIL: physics-facing changes require a docs/physics update in the same diff.")
        for path in files:
            print(f" - {path}")
        return 1

    print("Physics documentation gate passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
