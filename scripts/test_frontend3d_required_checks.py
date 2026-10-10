from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path

import pytest
import yaml


REPO_ROOT = Path(__file__).resolve().parents[1]
GATE = REPO_ROOT / "scripts/ci/run_frontend3d_required_gate.sh"


def run_gate(gate: str, *, inject_failure: str | None = None) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    environment.pop("FULLMAG_MANAGED_FEM_RUNNER", None)
    for name in ("GITHUB_RUN_ID", "GITHUB_SHA", "GITHUB_WORKFLOW", "GITHUB_JOB"):
        environment.pop(name, None)
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
        adaptive_report = b'{"schema":"fullmag_study_adaptive_authoring_browser_v1"}\n'
        (artifact_root / "study-adaptive-authoring.json").write_bytes(adaptive_report)
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
            {
                "path": "study-adaptive-authoring.json",
                "sha256": hashlib.sha256(adaptive_report).hexdigest(),
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

        original_manifest = manifest_path.read_bytes()
        repeated_write = subprocess.run(
            ["node", "apps/control-room/scripts/write-browser-fixture-proof-manifest.mjs"],
            cwd=REPO_ROOT,
            env=environment,
            text=True,
            capture_output=True,
            check=False,
        )
        assert repeated_write.returncode != 0
        assert "EEXIST" in repeated_write.stderr
        assert manifest_path.read_bytes() == original_manifest


def test_missing_managed_fem_runner_is_fail_closed_blocked_not_skipped() -> None:
    result = run_gate("managed-fem-qualification")

    assert result.returncode == 2
    assert "BLOCKED managed-fem-runner-unavailable" in result.stderr


def test_browser_fixture_preproof_and_standalone_manifest_order() -> None:
    dispatcher = GATE.read_text()
    preproof = dispatcher.split("    browser-fixture-pre-proof)", 1)[1].split(
        "      ;;", 1
    )[0]
    preproof_steps = (
        "run_gate browser-fixture-proof-identity",
        "run_gate browser-fixture-source-snapshot",
        "pnpm --dir apps/control-room run audit:viewport-3d-memory-churn",
        "pnpm --dir apps/control-room run audit:viewport-3d-fem-topology-uploads",
        "run_gate browser-fixture-source-verify",
    )
    positions = [preproof.index(step) for step in preproof_steps]
    assert positions == sorted(positions)
    assert "browser-fixture-proof-manifest" not in preproof
    assert "browser-fixture-source-verify-post-write" not in preproof

    browser_smoke = dispatcher.split("    browser-fixture-smoke)", 1)[1].split(
        "      ;;", 1
    )[0]
    ordered_steps = (
        "run_gate browser-fixture-pre-proof",
        "run_gate browser-fixture-proof-manifest",
        "run_gate browser-fixture-source-verify-post-write",
    )

    positions = [browser_smoke.index(step) for step in ordered_steps]
    assert positions == sorted(positions)
    assert browser_smoke.count("run_gate browser-fixture-proof-manifest") == 1


def load_workflow(path: Path) -> dict:
    return yaml.safe_load(path.read_text())


CONTRACT_SCOPES = frozenset(
    {
        "bootstrap",
        "rust",
        "browser",
        "positive-mass",
        "native-modal",
        "floquet-modal-slepc",
        "generic-modal-slepc",
        "floquet-count-slepc",
        "modal-phase-slepc",
        "retention",
    }
)
SCOPED_REQUIRED_JOB_EXCLUSIONS = {
    "api-hygiene-rg13": CONTRACT_SCOPES - {"bootstrap"},
    "control-room-contracts": CONTRACT_SCOPES - {"bootstrap", "browser"},
    "browser-fixture-smoke": CONTRACT_SCOPES - {"bootstrap", "browser"},
}


def dispatch_scope_guard(exclusions: set[str] | frozenset[str]) -> str:
    terms = sorted(exclusions)
    return (
        "${{ github.event_name != 'workflow_dispatch' || ("
        + " && ".join(f"inputs.contract_scope != '{scope}'" for scope in terms)
        + ") }}"
    )


def assert_dispatch_scope_guard(
    condition: str,
    *,
    expected_exclusions: set[str] | frozenset[str] | None = None,
) -> None:
    prefix = "${{ github.event_name != 'workflow_dispatch' || "
    assert condition.startswith(prefix)
    assert condition.endswith("}}")
    exclusions = condition[len(prefix) : -2].strip()
    assert exclusions.startswith("(") and exclusions.endswith(")")
    terms = exclusions[1:-1].split(" && ")
    assert terms
    scopes = []
    for term in terms:
        term_prefix = "inputs.contract_scope != '"
        assert term.startswith(term_prefix) and term.endswith("'")
        scope = term[len(term_prefix) : -1]
        assert scope in CONTRACT_SCOPES
        assert scope != "bootstrap"
        scopes.append(scope)
    assert len(scopes) == len(set(scopes))
    if expected_exclusions is not None:
        assert set(scopes) == set(expected_exclusions)


def test_dispatch_scope_guards_reject_wrong_required_job_exclusions() -> None:
    browser_exclusions = SCOPED_REQUIRED_JOB_EXCLUSIONS["browser-fixture-smoke"]
    api_exclusions = SCOPED_REQUIRED_JOB_EXCLUSIONS["api-hygiene-rg13"]
    for job_exclusions in SCOPED_REQUIRED_JOB_EXCLUSIONS.values():
        assert_dispatch_scope_guard(
            dispatch_scope_guard(job_exclusions),
            expected_exclusions=job_exclusions,
        )

    invalid_cases = (
        (browser_exclusions | {"browser"}, browser_exclusions),
        (api_exclusions | {"all"}, api_exclusions),
        (api_exclusions | {"brower"}, api_exclusions),
        (api_exclusions | {"bootstrap"}, api_exclusions),
        (api_exclusions - {"browser"}, api_exclusions),
    )
    for exclusions, expected_exclusions in invalid_cases:
        with pytest.raises(AssertionError):
            assert_dispatch_scope_guard(
                dispatch_scope_guard(exclusions),
                expected_exclusions=expected_exclusions,
            )

    with pytest.raises(AssertionError):
        assert_dispatch_scope_guard(
            dispatch_scope_guard(api_exclusions).replace(") }}", ") && !cancelled() }}"),
            expected_exclusions=api_exclusions,
        )


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
        condition = jobs[job_id].get("if")
        expected_exclusions = SCOPED_REQUIRED_JOB_EXCLUSIONS.get(job_id)
        if expected_exclusions is not None:
            assert condition is not None
            assert_dispatch_scope_guard(
                condition,
                expected_exclusions=expected_exclusions,
            )
        elif condition is not None:
            assert_dispatch_scope_guard(condition)

    browser_steps = jobs["browser-fixture-smoke"]["steps"]
    preproof_steps = [
        step
        for step in browser_steps
        if "run_frontend3d_required_gate.sh browser-fixture-pre-proof" in step.get("run", "")
    ]
    assert len(preproof_steps) == 1
    assert preproof_steps[0]["env"]["CONTROL_ROOM_AUDIT_ARTIFACTS_DIR"] == (
        "${{ runner.temp }}/viewport-3d-browser-audit"
    )
    negative_controls = [
        step
        for step in browser_steps
        if "run_frontend3d_required_gate.sh browser-fixture-smoke" in step.get("run", "")
    ]
    assert len(negative_controls) == 1
    assert "FULLMAG_CI_INJECT_FAILURE=browser-fixture-proof-identity" in negative_controls[0]["run"]
    assert negative_controls[0]["env"]["CONTROL_ROOM_AUDIT_ARTIFACTS_DIR"] == (
        "${{ runner.temp }}/viewport-3d-browser-audit"
    )

    inspector_index = next(
        index
        for index, step in enumerate(browser_steps)
        if step.get("name") == "Run Inspector mutation and DMI authoring browser regressions"
    )
    publication_steps = [
        (index, step)
        for index, step in enumerate(browser_steps)
        if "run_frontend3d_required_gate.sh browser-fixture-proof-manifest"
        in step.get("run", "")
    ]
    assert len(publication_steps) == 1
    publication_index, publication_step = publication_steps[0]
    publication_run = publication_step["run"]
    assert publication_run.index("browser-fixture-proof-manifest") < publication_run.index(
        "browser-fixture-source-verify-post-write"
    )
    assert "node apps/control-room/scripts/smoke-adaptive-study-authoring.mjs" in browser_steps[
        inspector_index
    ]["run"]
    assert "pnpm --dir apps/control-room run smoke:inspector" in browser_steps[
        inspector_index
    ]["run"]
    assert "smoke:analysis-plots" in browser_steps[inspector_index]["run"]
    preproof_index = browser_steps.index(preproof_steps[0])
    upload_index = next(
        index
        for index, step in enumerate(browser_steps)
        if step.get("uses") == "actions/upload-artifact@v7"
        and step["with"].get("name") == "viewport-3d-browser-audit"
    )
    assert preproof_index < inspector_index < publication_index < upload_index
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
    assert "browser-fixture-pre-proof" in dispatcher
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


def test_browser_audit_build_uses_isolated_dist_dir_and_restores_next_env() -> None:
    app_root = REPO_ROOT / "apps/control-room"
    next_env = (app_root / "next-env.d.ts").read_text()
    next_config = (app_root / "next.config.ts").read_text()
    package = json.loads((app_root / "package.json").read_text())
    audit_build = (app_root / "scripts/build-audit-control-room.mjs").read_text()

    assert (
        'import "./.next/types/routes.d.ts";' in next_env
        or 'import "./.next/dev/types/routes.d.ts";' in next_env
    )
    assert package["scripts"]["build:audit:webpack"] == (
        "node scripts/build-audit-control-room.mjs"
    )
    assert 'const auditBuild = process.env.NEXT_PUBLIC_AUDIT_BUILD === "1";' in next_config
    assert "const distDir = resolveControlRoomDistDir({\n  auditBuild," in next_config
    assert 'return auditBuild ? ".next-audit" : ".next";' in next_config
    assert 'NEXT_PUBLIC_AUDIT_BUILD: "1"' in audit_build
    assert 'const nextEnvSnapshot = readFileSync(nextEnvPath, "utf8");' in audit_build
    assert "} finally {\n  writeFileSync(nextEnvPath, nextEnvSnapshot);" in audit_build


def test_browser_source_verify_emits_dirty_paths_before_comparison() -> None:
    dispatcher = (REPO_ROOT / "scripts/ci/run_frontend3d_required_gate.sh").read_text()
    assert "git status --short" in dispatcher
