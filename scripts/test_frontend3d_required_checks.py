from __future__ import annotations

import os
import json
import subprocess
import tempfile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
GATE = REPO_ROOT / "scripts/ci/run_frontend3d_required_gate.sh"


def run_gate(gate: str, *, inject_failure: str | None = None) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    environment.pop("FULLMAG_MANAGED_FEM_RUNNER", None)
    if inject_failure is None:
        environment.pop("FULLMAG_CI_INJECT_FAILURE", None)
    else:
        environment["FULLMAG_CI_INJECT_FAILURE"] = inject_failure
    return subprocess.run(
        ["bash", str(GATE), gate],
        cwd=REPO_ROOT,
        env=environment,
        text=True,
        capture_output=True,
        check=False,
    )


def test_intentional_proof_manifest_gate_failure_fails_the_job_command() -> None:
    result = run_gate("browser-fixture-smoke", inject_failure="browser-fixture-proof-identity")

    assert result.returncode == 1
    assert "INTENTIONAL_FAILURE browser-fixture-proof-identity" in result.stderr


def test_browser_fixture_gate_blocks_locally_without_github_execution_identity() -> None:
    result = run_gate("browser-fixture-proof-manifest")

    assert result.returncode == 2
    assert "BLOCKED github-execution-identity-missing" in result.stderr


def test_browser_fixture_writer_records_github_execution_identity_in_its_own_fixture() -> None:
    with tempfile.TemporaryDirectory() as directory:
        artifact_root = Path(directory)
        (artifact_root / "audit.json").write_text('{"ok":true}\n')
        source_snapshot_sha256 = "b" * 64
        (artifact_root / "source-snapshot.v2.json").write_text(
            json.dumps(
                {
                    "schema": "fullmag.source-snapshot.v2",
                    "head_commit_full": "a" * 40,
                    "source_snapshot_dirty": False,
                    "dirty_content_sha256": "c" * 64,
                    "source_snapshot_sha256": source_snapshot_sha256,
                    "git_status_porcelain_v1": [],
                }
            )
            + "\n"
        )
        environment = os.environ.copy()
        environment.update(
            {
                "GITHUB_RUN_ID": "123456789",
                "GITHUB_SHA": "a" * 40,
                "GITHUB_WORKFLOW": "bootstrap",
                "GITHUB_JOB": "browser-fixture-smoke",
                "CONTROL_ROOM_AUDIT_ARTIFACTS_DIR": str(artifact_root),
            }
        )
        result = subprocess.run(
            ["node", "apps/control-room/scripts/write-browser-fixture-proof-manifest.mjs"],
            cwd=REPO_ROOT,
            env=environment,
            text=True,
            capture_output=True,
            check=False,
        )

        assert result.returncode == 0, result.stderr
        manifest_path = artifact_root / "viewport-proof-manifest.json"
        manifest = json.loads(manifest_path.read_text())
        assert manifest["execution"] == {
            "provider": "github-actions",
            "runId": "123456789",
            "workflowName": "bootstrap",
            "jobName": "browser-fixture-smoke",
            "headSha": "a" * 40,
            "timestampUtc": manifest["execution"]["timestampUtc"],
            "conclusion": "success",
        }
        assert manifest["artifacts"] == [
            {
                "path": "audit.json",
                "sha256": "e5f1eb4d806641698a35efe20e098efd20d7d57a9b90ee69079d5bb650920726",
                "mediaType": "application/json",
            },
            {
                "path": "source-snapshot.v2.json",
                "sha256": manifest["artifacts"][1]["sha256"],
                "mediaType": "application/json",
            },
        ]
        assert manifest["source"]["implementationCommit"] == "a" * 40
        assert manifest["source"]["statusSha256"] == "c" * 64
        assert manifest["runtime"]["sourceSnapshotSha256"] == source_snapshot_sha256
        validated = subprocess.run(
            [
                "node",
                "apps/control-room/scripts/validate-viewport-proof-manifest.mjs",
                "--manifest",
                str(manifest_path),
                "--artifact-root",
                str(artifact_root),
                "--source-snapshot",
                str(artifact_root / "source-snapshot.v2.json"),
            ],
            cwd=REPO_ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        assert validated.returncode == 0, validated.stderr


def test_missing_managed_fem_runner_is_fail_closed_blocked_not_skipped() -> None:
    result = run_gate("managed-fem-qualification")

    assert result.returncode == 2
    assert "BLOCKED managed-fem-runner-unavailable" in result.stderr


def test_browser_fixture_source_snapshot_is_verified_after_manifest_write() -> None:
    dispatcher = GATE.read_text()
    browser_smoke = dispatcher.split("    browser-fixture-smoke)", 1)[1].split(
        "      ;;", 1
    )[0]
    ordered_steps = (
        "run_gate browser-fixture-source-snapshot",
        "pnpm --dir apps/control-room run audit:viewport-3d-memory-churn",
        "pnpm --dir apps/control-room run audit:viewport-3d-fem-topology-uploads",
        "run_gate browser-fixture-source-verify",
        "run_gate browser-fixture-proof-manifest",
        "run_gate browser-fixture-source-verify-post-write",
    )

    positions = [browser_smoke.index(step) for step in ordered_steps]
    assert positions == sorted(positions)


def load_workflow(path: Path) -> dict:
    result = subprocess.run(
        ["ruby", "-rjson", "-ryaml", "-e", "puts JSON.generate(YAML.load_file(ARGV.fetch(0)))", str(path)],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=True,
    )
    return json.loads(result.stdout)


def test_required_contexts_and_proof_output_are_fail_closed() -> None:
    bootstrap = load_workflow(REPO_ROOT / ".github/workflows/bootstrap.yml")
    jobs = bootstrap["jobs"]
    required_jobs = {
        "rust-contracts",
        "generated-api-determinism",
        "api-hygiene-rg13",
        "control-room-contracts",
        "browser-fixture-smoke",
    }
    assert required_jobs <= jobs.keys()
    for job_id in required_jobs:
        serialized = json.dumps(jobs[job_id])
        assert "continue-on-error" not in serialized
        assert jobs[job_id].get("if") is None

    browser_steps = jobs["browser-fixture-smoke"]["steps"]
    browser_gate_steps = [
        step
        for step in browser_steps
        if "run_frontend3d_required_gate.sh browser-fixture-smoke" in step.get("run", "")
    ]
    assert len(browser_gate_steps) == 2
    assert all(
        step["env"]["CONTROL_ROOM_AUDIT_ARTIFACTS_DIR"]
        == "${{ runner.temp }}/viewport-3d-browser-audit"
        for step in browser_gate_steps
    )
    assert any(
        step.get("run") == "./scripts/ci/run_frontend3d_required_gate.sh browser-fixture-smoke"
        for step in browser_steps
    )
    assert any(
        step.get("uses") == "actions/upload-artifact@v7"
        and step["with"].get("if-no-files-found") == "error"
        and step["with"].get("path") == "${{ runner.temp }}/viewport-3d-browser-audit"
        for step in browser_steps
    )

    managed = load_workflow(REPO_ROOT / ".github/workflows/frontend-3d-managed-fem.yml")
    managed_job = managed["jobs"]["managed-fem-qualification"]
    assert managed_job["runs-on"] == ["self-hosted", "linux", "x64", "fem-managed"]
    assert "continue-on-error" not in json.dumps(managed_job)
    assert managed_job.get("if") is None

    dispatcher = (REPO_ROOT / "scripts/ci/run_frontend3d_required_gate.sh").read_text()
    assert "browser-fixture-proof-identity" in dispatcher
    assert "browser-fixture-source-snapshot" in dispatcher
    assert "browser-fixture-source-verify" in dispatcher
    assert "browser-fixture-proof-manifest" in dispatcher
    assert "capture_source_snapshot_identity.py" in dispatcher
    assert "source-snapshot.v2.json" in dispatcher
    assert "write-browser-fixture-proof-manifest.mjs" in dispatcher

    matrix = (REPO_ROOT / "docs/validation/frontend-3d-required-check-matrix.md").read_text()
    for context in (
        "bootstrap / rust-contracts",
        "bootstrap / generated-api-determinism",
        "bootstrap / api-hygiene-rg13",
        "bootstrap / control-room-contracts",
        "bootstrap / browser-fixture-smoke",
        "frontend-3d-managed-fem / managed-fem-qualification",
    ):
        assert context in matrix


def test_browser_audit_build_keeps_next_env_source_identity_stable() -> None:
    next_env = (REPO_ROOT / "apps/control-room/next-env.d.ts").read_text()
    assert 'import "./.next-audit/types/routes.d.ts";' in next_env


def test_browser_source_verify_emits_dirty_paths_before_comparison() -> None:
    dispatcher = (REPO_ROOT / "scripts/ci/run_frontend3d_required_gate.sh").read_text()
    assert "git status --short" in dispatcher
