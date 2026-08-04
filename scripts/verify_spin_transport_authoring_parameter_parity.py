from __future__ import annotations

import argparse
import hashlib
import json
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
MANIFEST_RELATIVE = Path("docs/specs/spin-transport-authoring-parameter-parity-v1.json")
REPORT_SCHEMA = "fullmag.spin_transport_authoring_parameter_parity.v1"


def _contains_forbidden_validated(value: object) -> bool:
    if isinstance(value, str):
        return value == "validated"
    if isinstance(value, dict):
        return any(_contains_forbidden_validated(item) for item in value.values())
    if isinstance(value, list):
        return any(_contains_forbidden_validated(item) for item in value)
    return False


def validate_report(report: dict[str, object]) -> None:
    required = {
        "schema_version",
        "status",
        "manifest_path",
        "manifest_sha256",
        "source_commit",
        "layers",
        "unsupported_cases",
        "qualification_boundary",
    }
    missing = required.difference(report)
    if missing:
        raise ValueError(f"report is missing required keys: {sorted(missing)}")
    if report["schema_version"] != REPORT_SCHEMA:
        raise ValueError("unexpected authoring parity report schema")
    if report["status"] not in {"pass", "fail"}:
        raise ValueError("report status must be pass or fail; validated is not an authoring status")
    if _contains_forbidden_validated(report):
        raise ValueError("authoring parity report must not claim validated")
    manifest_sha = report["manifest_sha256"]
    if not isinstance(manifest_sha, str) or len(manifest_sha) != 64:
        raise ValueError("manifest_sha256 must be a SHA-256 hexadecimal digest")
    try:
        int(manifest_sha, 16)
    except ValueError as error:
        raise ValueError("manifest_sha256 must be hexadecimal") from error
    source_commit = report["source_commit"]
    if not isinstance(source_commit, str) or len(source_commit) != 40:
        raise ValueError("source_commit must be a full 40-character commit id")
    layers = report["layers"]
    if not isinstance(layers, dict):
        raise ValueError("layers must be an object")
    for layer in ("manifest", "python", "rust", "ui"):
        entry = layers.get(layer)
        if not isinstance(entry, dict) or entry.get("status") not in {"pass", "fail"}:
            raise ValueError(f"layers.{layer}.status must be pass or fail")
    unsupported = report["unsupported_cases"]
    if not isinstance(unsupported, list):
        raise ValueError("unsupported_cases must be a list")
    for case in unsupported:
        if not isinstance(case, dict) or case.get("fallback_forbidden") is not True:
            raise ValueError("unsupported cases must explicitly forbid fallback")
    boundary = report["qualification_boundary"]
    if not isinstance(boundary, dict):
        raise ValueError("qualification_boundary must be an object")
    if boundary.get("authoring_parity") not in {"pass", "fail"}:
        raise ValueError("qualification_boundary.authoring_parity is required")
    if boundary.get("physics") != "not_qualified":
        raise ValueError("the authoring gate must not promote physics qualification")
    if boundary.get("backend_capability_promotion") != "forbidden":
        raise ValueError("backend capability promotion must remain forbidden")


def _run(label: str, command: list[str], *, cwd: Path = REPO_ROOT, env: dict[str, str] | None = None) -> dict[str, object]:
    merged_env = None
    if env is not None:
        import os

        merged_env = dict(os.environ)
        merged_env.update(env)
    process = subprocess.run(
        command,
        cwd=cwd,
        env=merged_env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    output = process.stdout or ""
    return {
        "label": label,
        "status": "pass" if process.returncode == 0 else "fail",
        "exit_code": process.returncode,
        "command": " ".join(shlex.quote(part) for part in command),
        "output_tail": output[-5000:],
    }


def _layer(label: str, commands: list[tuple[list[str], Path, dict[str, str] | None]]) -> dict[str, object]:
    results = [_run(label, command, cwd=cwd, env=env) for command, cwd, env in commands]
    return {
        "status": "pass" if all(result["status"] == "pass" for result in results) else "fail",
        "checks": results,
    }


def run_gate(output_path: Path) -> dict[str, object]:
    manifest_path = REPO_ROOT / MANIFEST_RELATIVE
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest_digest = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    source_commit = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=REPO_ROOT,
        text=True,
        stdout=subprocess.PIPE,
        check=True,
    ).stdout.strip()
    python_env = {"PYTHONPATH": "packages/fullmag-py/src"}
    cargo_env = {
        "CARGO_TARGET_DIR": "/tmp/fullmag-zfn2-build/cargo-targets/spin-transport-parity",
        "CARGO_INCREMENTAL": "0",
    }
    layers: dict[str, object] = {
        "manifest": _layer(
            "manifest",
            [
                ([sys.executable, "-m", "unittest", "scripts.test_spin_transport_authoring_parameter_parity"], REPO_ROOT, python_env),
            ],
        ),
        "python": _layer(
            "python",
            [
                ([sys.executable, "-m", "unittest", "packages.fullmag-py.tests.test_spin_transport_authoring_parameter_parity"], REPO_ROOT, python_env),
                ([sys.executable, "-m", "unittest", "packages.fullmag-py.tests.test_spin_drift_diffusion"], REPO_ROOT, python_env),
            ],
        ),
        "rust": _layer(
            "rust",
            [
                (["cargo", "test", "-p", "fullmag-ir", "--test", "ir_tests", "spin_transport"], REPO_ROOT, cargo_env),
                (["cargo", "test", "-p", "fullmag-plan", "spin_transport"], REPO_ROOT, cargo_env),
            ],
        ),
        "ui": _layer(
            "ui",
            [
                ([
                    "pnpm",
                    "exec",
                    "vitest",
                    "run",
                    "src/modules/inspector/panels/TransportAuthoringInspectorModel.test.ts",
                    "src/modules/inspector/panels/SpinAuthoringInspectorModel.test.ts",
                ], REPO_ROOT / "apps/control-room", None),
            ],
        ),
    }
    report: dict[str, object] = {
        "schema_version": REPORT_SCHEMA,
        "status": "pass" if all(
            isinstance(layer, dict) and layer.get("status") == "pass"
            for layer in layers.values()
        ) else "fail",
        "manifest_path": str(MANIFEST_RELATIVE),
        "manifest_sha256": manifest_digest,
        "source_commit": source_commit,
        "layers": layers,
        "unsupported_cases": [
            {
                "id": case.get("id"),
                "request": case.get("request"),
                "error_class": case.get("error_class"),
                "fallback_forbidden": case.get("fallback_forbidden") is True,
            }
            for case in manifest.get("unsupported_cases", [])
        ],
        "qualification_boundary": {
            "authoring_parity": "pass" if all(
                isinstance(layer, dict) and layer.get("status") == "pass"
                for layer in layers.values()
            ) else "fail",
            "physics": "not_qualified",
            "backend_capability_promotion": "forbidden",
            "notes": [
                "This gate proves authoring/IR/planner/UI parity only.",
                "It does not qualify FEM/FDM continuum convergence, GPU residency, or external-solver equivalence.",
            ],
        },
    }
    validate_report(report)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(".fullmag/reports/spin-transport-authoring-parameter-parity/report.json"),
    )
    args = parser.parse_args()
    output_path = args.output if args.output.is_absolute() else REPO_ROOT / args.output
    try:
        report = run_gate(output_path)
    except (OSError, ValueError, subprocess.CalledProcessError, json.JSONDecodeError) as error:
        print(f"spin transport authoring parity gate failed: {error}", file=sys.stderr)
        return 1
    print(f"spin transport authoring parity: {report['status']}")
    print(f"report: {output_path}")
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
