"""Read-only CLI regression; run against the selected managed backend package."""
import argparse
import json
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    cases = {
        "prepare-run-json": ("--project-id", "--api-url"),
        "run-script-accepted": ("--execution-profile", "--resources", "--submit-only", "--prepare-only"),
        "run-json": ("--api-url", "--submit-only"),
    }
    checks = []
    for command, flags in cases.items():
        result = subprocess.run(
            [str(binary), command, "--help"],
            capture_output=True, text=True, timeout=20,
        )
        usage = next((line for line in result.stdout.splitlines() if line.startswith("Usage:")), "")
        passed = result.returncode == 0 and command in usage and all(
            flag in result.stdout for flag in flags
        )
        checks.append({"command": command, "exit_code": result.returncode,
                       "usage": usage, "passed": passed})
    inputs = ["run-script-accepted", "missing.py", "--project", "missing.fms",
              "--execution-profile", "missing.json", "--resources", "missing.json",
              "--idempotency-key", "dispatch-regression"]
    for name, extra, expected in [
        ("conflicting-modes", ["--prepare-only", "--submit-only"], "cannot be used with"),
        ("submit-requires-origin", [], "--api-url"),
    ]:
        result = subprocess.run([str(binary), *inputs, *extra],
                                capture_output=True, text=True, timeout=20)
        checks.append({"command": name, "exit_code": result.returncode,
                       "passed": result.returncode == 2 and expected in result.stderr})
    print(json.dumps({"passed": all(check["passed"] for check in checks),
                      "checks": checks, "scope": "CLI help and parser rejection only; no Submit or Solve"}))
    return 0 if all(check["passed"] for check in checks) else 1


if __name__ == "__main__":
    raise SystemExit(main())
