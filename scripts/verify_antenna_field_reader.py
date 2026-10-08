"""Run interpreted antenna artifact-reader regressions with managed evidence.

No native build or physical field solve is performed by this fixed route.
"""
from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid

import fullmag_storage as storage

PROFILE = "antenna-field-reader"
SOURCES = ("tests/antenna/verify_field_convergence.py",
           "tests/antenna/direct_quadrature_evidence.py",
           "tests/antenna/matched_libm.py",
           "tests/antenna/test_matched_libm.py",
           "tests/antenna/test_verify_field_convergence.py",
           "scripts/verify_antenna_field_reader.py",
           "scripts/fullmag_storage.py",
           "crates/fullmag-runner/src/antenna_stage.rs")


def fingerprint(repo):
    digest = hashlib.sha256()
    for name in SOURCES:
        digest.update(name.encode("utf-8") + b"\0")
        digest.update(hashlib.sha256((repo / name).read_bytes()).digest())
    return digest.hexdigest()


def run(repo):
    layout = storage.resolve_layout(repo, PROFILE)
    storage.initialize(layout)
    with storage.build_lock(layout):
        root = storage.validate_path(Path(layout["build_root"]) / uuid.uuid4().hex,
                                     layout["build_storage_root"], "reader evidence")
        root.mkdir(parents=True)
        log = root / "checks.log"
        receipt_path = root / "receipt.json"
        command = [sys.executable, "-B", "-m", "unittest",
                   "tests.antenna.test_verify_field_convergence", "tests.antenna.test_matched_libm", "-v"]
        receipt = {"schema": "fullmag.antenna.field_reader_checks.v1",
                   "state": "running", "started_at": storage.now(),
                   "head": subprocess.check_output(["git", "rev-parse", "HEAD"],
                                                   cwd=repo, text=True).strip(),
                   "repo_root": str(repo), "worktree_id": layout["worktree_id"],
                   "command": command, "source_digest_before": fingerprint(repo),
                   "qualification": "artifact_reader_only_not_native_or_physics",
                   "unit_tests": "interpreted_python_only_no_compilation",
                   "log": str(log)}
        storage.atomic_json(receipt_path, receipt)
        code = 1
        try:
            with log.open("w", encoding="utf-8") as stream:
                code = subprocess.run(command, cwd=repo,
                                      env={**os.environ, **layout["env"],
                                           "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
                                      stdout=stream, stderr=subprocess.STDOUT).returncode
            output = log.read_text(encoding="utf-8")
            count = re.search(r"Ran (\d+) tests? in", output)
            receipt["tests_run"] = int(count[1]) if count else 0
            receipt["tests_skipped"] = len(re.findall(r"\.\.\. skipped ", output))
            if receipt["tests_run"] == 0:
                code = 1
                receipt["error"] = "reader checks did not report any tests"
            print(output)
        except Exception as error:
            code = 1
            receipt["error"] = str(error)
            raise
        finally:
            try:
                receipt["source_digest_after"] = fingerprint(repo)
                if receipt["source_digest_before"] != receipt["source_digest_after"]:
                    code = 1
                    receipt["error"] = "source changed during reader checks"
            except Exception as error:
                code = 1
                receipt["error"] = f"cannot verify final source digest: {error}"
            receipt.update(state="passed" if code == 0 else "failed", exit_code=code,
                           finished_at=storage.now())
            storage.atomic_json(receipt_path, receipt)
            print(f"ANTENNA_FIELD_READER_RECEIPT={receipt_path}")
        return code


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    return run(args.repo_root.resolve())


if __name__ == "__main__":
    raise SystemExit(main())
