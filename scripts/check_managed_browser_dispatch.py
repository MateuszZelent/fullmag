"""Interpret the real managed-browser dispatch; never execute its launcher."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

import fullmag_storage as storage


def check(repo: Path, evidence: Path, just: Path, bash: Path) -> int:
    layout = storage.resolve_layout(repo, "managed-browser-cpu")
    task_root = Path(layout["build_storage_root"]) / "builds" / layout["worktree_id"]
    evidence = storage.validate_path(evidence, task_root, "dispatch check evidence")
    evidence.mkdir(parents=True, exist_ok=False)
    shell = repo / "scripts/just_storage_shell.sh"
    source = shell.read_text(encoding="utf-8")
    start = source.index('  *"scripts/run_managed_browser.py"*)')
    end = source.index('\n  *"scripts/verify_saved_fem_archive_roundtrip.py"*)', start)
    block = source[start:end]
    harness = evidence / "dispatch.sh"
    harness.write_text("set -euo pipefail\n" +
        'exec() { printf "%s\\0" "$@" > "$FULLMAG_DISPATCH_ARGS"; exit 0; }\n' +
        'python_cmd=/verified/python\n' +
        'script_dir="$FULLMAG_DISPATCH_SCRIPTS"\nrepo_root="$FULLMAG_DISPATCH_REPO"\n' +
        'recipe="$FULLMAG_DISPATCH_RECIPE"\ncase "$recipe" in\n' + block + '\nesac\n', encoding="utf-8")
    job, commit, capsule, native = "a" * 32, "b" * 40, "c" * 64, "d" * 64
    recipes = {}
    for name, args in {
        "clean": ["run-managed-browser", job, commit, "3104"],
        "snapshot": ["run-managed-browser-snapshot", job, commit, capsule, native, "3104"],
        "ram": ["run-managed-browser-snapshot-ram", job, commit, capsule, native, "3106"],
    }.items():
        result = subprocess.run([str(just), "--dry-run", *args], cwd=repo,
            capture_output=True, text=True, check=True, timeout=30)
        lines = [line for line in (result.stdout + result.stderr).splitlines()
                 if "scripts/run_managed_browser.py" in line]
        assert len(lines) == 1, "Expected one exact managed-browser recipe body"
        recipes[name] = lines[0]
    checks = []
    cases = [(name, recipe, name) for name, recipe in recipes.items()]
    cases.extend([
        ("short job", recipes["snapshot"].replace(job, job[:-1]), None),
        ("short commit", recipes["snapshot"].replace(commit, commit[:-1]), None),
        ("uppercase capsule", recipes["snapshot"].replace(capsule, capsule.upper()), None),
        ("short native snapshot", recipes["snapshot"].replace(native, native[:-1]), None),
        ("missing native snapshot", recipes["snapshot"].replace(f" --native-snapshot-sha256 '{native}'", ""), None),
        ("extra argument", recipes["ram"] + " --unexpected", None),
        ("duplicate RAM flag", recipes["ram"] + " --ephemeral", None),
        ("shell suffix", recipes["ram"] + "; echo unexpected", None),
        ("unquoted snapshot job", recipes["snapshot"].replace(f"'{job}'", job), None),
    ])
    for index, (name, recipe, mode) in enumerate(cases):
        args_file = evidence / f"{index:02d}.args"
        result = subprocess.run([str(bash), harness.name], cwd=evidence,
            env={**os.environ, "FULLMAG_DISPATCH_ARGS": args_file.name,
                 "FULLMAG_DISPATCH_RECIPE": recipe,
                 "FULLMAG_DISPATCH_SCRIPTS": (repo / "scripts").as_posix(),
                 "FULLMAG_DISPATCH_REPO": repo.as_posix()},
            capture_output=True, text=True, timeout=15)
        (evidence / f"{index:02d}.stderr").write_text(result.stderr, encoding="utf-8")
        if mode is None:
            assert result.returncode == 2 and not args_file.exists(), (name, result.returncode, result.stderr)
        else:
            expected = ["/verified/python", (repo / "scripts/run_managed_browser.py").as_posix(),
                "--repo-root", repo.as_posix(), "--job-id", job, "--commit", commit]
            if mode != "clean":
                expected += ["--source-digest", capsule, "--native-snapshot-sha256", native]
            expected += ["--port", "3106" if mode == "ram" else "3104"]
            if mode == "ram":
                expected += ["--ephemeral"]
            assert result.returncode == 0, (name, result.stderr)
            assert args_file.read_bytes().split(b"\0") == [v.encode() for v in expected] + [b""], name
        checks.append({"case": name, "result": "PASS"})
    report = {"schema": "fullmag.managed-browser-dispatch-check.v1", "state": "passed",
        "scope": "actual_case_block_with_recorded_exec_not_runtime_qualification",
        "checks": checks, "actual_recipes": recipes,
        "shell_sha256": hashlib.sha256(shell.read_bytes()).hexdigest(),
        "checker_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "justfile_sha256": hashlib.sha256((repo / "justfile").read_bytes()).hexdigest(),
        "launcher_executed": False, "unit_tests_compiled": False}
    storage.atomic_json(evidence / "report.json", report)
    print(json.dumps({"report": str(evidence / "report.json"), "checks": len(checks), "state": "passed"}))
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--evidence-root", type=Path, required=True)
    parser.add_argument("--just", type=Path, required=True)
    parser.add_argument("--bash", type=Path, required=True)
    args = parser.parse_args()
    raise SystemExit(check(args.repo_root.resolve(), args.evidence_root, args.just, args.bash))
