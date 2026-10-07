#!/usr/bin/env python3
"""Run the fixed interpreted development-handoff checks under managed storage."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid

import fullmag_storage as storage


SOURCE_PATHS = (
    "scripts/windows/validate_candidate_owner.py",
    "scripts/test_windows_development_candidate_owner.py",
    "scripts/windows/accepted_store_identity.py",
    "scripts/windows/prepare_committed_restore.py",
    "scripts/test_windows_development_committed_restore.py",
    "scripts/windows/validate_commit_handoff.py",
    "scripts/test_windows_development_commit_consumer.py",
    "scripts/windows/stage_acquisition_handoff.py",
    "scripts/test_windows_development_stage_consumer.py",
    "scripts/windows/development_acquisition_handoff.py",
    "scripts/test_windows_development_acquisition_handoff.py",
    "scripts/windows/development_restore_launch.py",
    "scripts/test_windows_development_restore_launch.py",
    "scripts/windows/development_handoff.py",
    "scripts/windows/development_scene_handoff.py",
    "scripts/test_windows_development_scene_handoff.py",
    "scripts/windows/development_scene_assets.py",
    "scripts/test_windows_development_scene_assets.py",
    "scripts/test_windows_development_scene_python.py",
    "scripts/test_windows_development_scene_render_incomplete.py",
    "packages/fullmag-py/src/fullmag/model/_incomplete.py",
    "packages/fullmag-py/src/fullmag/model/problem.py",
    "packages/fullmag-py/src/fullmag/runtime/helper.py",
    "packages/fullmag-py/src/fullmag/runtime/script_builder.py",
    "packages/fullmag-py/src/fullmag/runtime/scene_document.py",
    "packages/fullmag-py/src/fullmag/model/study.py",
    "packages/fullmag-py/src/fullmag/world.py",
    "crates/fullmag-authoring/src/scene.rs",
    "crates/fullmag-authoring/src/builder.rs",
    "crates/fullmag-authoring/src/adapters.rs",
    "crates/fullmag-authoring/src/geometry.rs",
    "crates/fullmag-ir/src/model.rs",
    "crates/fullmag-ir/src/selection.rs",
    "crates/fullmag-ir/src/constraint.rs",
    "crates/fullmag-authoring/src/validation.rs",
    "crates/fullmag-cli/src/step_utils.rs",
    "crates/fullmag-runner/src/fem/eigen_equilibrium.rs",
    "scripts/test_windows_development_handoff.py",
    "scripts/test_verify_development_handoff.py",
    "scripts/verify_development_handoff.py",
    "scripts/fullmag_storage.py",
    "scripts/windows/runtime_bundle.py",
    "scripts/windows/development_status.py",
    "scripts/windows/watch_backend.py",
    "scripts/windows/workspace_backend_identity.py",
    "scripts/windows/runtime_lease.py",
    "scripts/windows/recover_runtime.py",
    "scripts/windows/run_fullmag.ps1",
    "scripts/test_windows_development_recovery.py",
    "scripts/test_windows_development_status.py",
    "scripts/just_storage_shell.sh",
    "justfile",
)


def source_identity(repo: Path) -> str:
    digest = hashlib.sha256()
    for relative in SOURCE_PATHS:
        path = repo / relative
        if path.is_symlink() or not path.is_file():
            raise storage.StorageError(f"Invalid handoff check source: {relative}")
        digest.update(relative.encode("utf-8") + b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def run(repo_root: str) -> int:
    layout = storage.resolve_layout(repo_root, "development-handoff-checks")
    repo = Path(layout["repo_root"])
    # Read-only preflight completes before creating any controlled output.
    source_before = source_identity(repo)
    registry = storage.validate_path(
        Path(layout["storage_root"]) / "index" / f"{layout['worktree_id']}.json",
        layout["storage_root"], "worktree owner registry",
    )
    owner = json.loads(registry.read_text(encoding="utf-8"))
    if (owner.get("repo_root") != str(repo) or not owner.get("task_id")
            or not owner.get("owner") or owner.get("state") not in {"active", "wip"}):
        raise storage.StorageError("Handoff checks require a registered active worktree owner")
    storage.initialize(layout)
    run_id = uuid.uuid4().hex
    with storage.build_lock(layout):
        run_root = storage.validate_path(
            Path(layout["build_root"]) / "checks" / run_id,
            layout["build_storage_root"], "handoff check run",
        )
        run_root.mkdir(parents=True, exist_ok=False)
        fixtures = storage.validate_path(run_root / "fixtures", run_root, "check fixtures")
        fixtures.mkdir()
        log_path = run_root / "checks.log"
        receipt_path = run_root / "receipt.json"
        receipt = {
            "schema": "fullmag.development-handoff-checks.v1",
            "run_id": run_id, "repo_root": str(repo),
            "worktree_id": layout["worktree_id"], "profile": layout["profile"],
            "task_id": owner["task_id"], "owner": owner["owner"],
            "head": storage.git(repo, "rev-parse", "HEAD"),
            "source_sha256": source_before, "source_paths": list(SOURCE_PATHS),
            "started_at": storage.now(), "state": "running",
            "scope": "interpreted handoff and development watcher checks; no solver or process restart",
        }
        storage.atomic_json(receipt_path, receipt)
        code = 1
        try:
            env = {**os.environ, **layout["env"],
                   "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUTF8": "1",
                   "TEMP": str(fixtures), "TMP": str(fixtures), "TMPDIR": str(fixtures)}
            command = [sys.executable, "-m", "unittest", "discover", "-s", "scripts",
                       "-p", "test_*development_*.py", "-v"]
            with log_path.open("w", encoding="utf-8") as log:
                code = subprocess.run(command, cwd=repo, env=env, stdout=log,
                                      stderr=subprocess.STDOUT, check=False).returncode
            output = log_path.read_text(encoding="utf-8")
            summary = re.search(r"^Ran (\d+) tests? in ", output, re.MULTILINE)
            count = int(summary.group(1)) if summary else 0
            receipt["tests_run"] = count
            skipped_summary = re.search(r"^OK \(skipped=(\d+)\)$", output, re.MULTILINE)
            skipped = int(skipped_summary.group(1)) if skipped_summary else 0
            receipt["tests_skipped"] = skipped
            if count == 0 or skipped == count:
                code = code or 1
                receipt["reason"] = "no_checks_executed"
            source_after = source_identity(repo)
            receipt["source_sha256_after"] = source_after
            if source_after != source_before:
                code = code or 1
                receipt["reason"] = "source_changed_during_checks"
            receipt["log_sha256"] = hashlib.sha256(log_path.read_bytes()).hexdigest()
        except Exception:
            code = code or 1
            receipt["reason"] = "check_execution_failed"
            raise
        finally:
            receipt.update(state="completed" if code == 0 else "failed", exit_code=code,
                           finished_at=storage.now())
            storage.atomic_json(receipt_path, receipt)
            print(json.dumps({"state": receipt["state"], "exit_code": code,
                              "receipt": str(receipt_path), "log": str(log_path)}))
        return code


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", required=True)
    args = parser.parse_args()
    try:
        return run(args.repo_root)
    except (storage.StorageError, OSError, ValueError) as error:
        print(f"Development handoff checks failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
