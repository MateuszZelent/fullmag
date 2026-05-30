#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


@dataclass
class CheckResult:
    name: str
    status: str
    command: list[str]
    stdout_tail: str
    stderr_tail: str


def _python_env() -> dict[str, str]:
    env = dict(os.environ)
    package_path = str(REPO_ROOT / "packages" / "fullmag-py" / "src")
    existing = env.get("PYTHONPATH")
    env["PYTHONPATH"] = f"{package_path}:{existing}" if existing else package_path
    return env


def run_check(name: str, command: list[str]) -> CheckResult:
    completed = subprocess.run(
        command,
        cwd=REPO_ROOT,
        env=_python_env(),
        text=True,
        capture_output=True,
    )
    status = "passed" if completed.returncode == 0 else "failed"
    return CheckResult(
        name=name,
        status=status,
        command=command,
        stdout_tail=completed.stdout[-4000:],
        stderr_tail=completed.stderr[-4000:],
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    checks = [
        run_check(
            "python_meshing_tests",
            [
                sys.executable,
                "-m",
                "pytest",
                "packages/fullmag-py/tests/test_meshing.py",
                "-vv",
            ],
        ),
        run_check(
            "python_api_mesh_tests",
            [
                sys.executable,
                "-m",
                "pytest",
                "packages/fullmag-py/tests/test_api.py",
                "-k",
                "mesh or airbox or thin_film",
                "-vv",
            ],
        ),
    ]

    payload = {"checks": [asdict(check) for check in checks]}
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        for check in checks:
            print(f"{check.name}: {check.status}")
    return 0 if all(check.status == "passed" for check in checks) else 1


if __name__ == "__main__":
    raise SystemExit(main())
