from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
from functools import lru_cache
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
VALIDATOR_PATH = ROOT / "scripts" / "validate_relaxation_capability_evidence.py"
FEATURE_ID = "relaxation_projected_gradient_bb"
ALGORITHM = "projected_gradient_bb"
LANE = "fem_gpu_public"
WORKLOADS = [
    "fem_gpu_public.projected_gradient_bb.macrospin",
    "fem_gpu_public.projected_gradient_bb.exchange_demag",
]
MANAGED_RECIPE = "verify-fem-relaxation-production-benchmark"
DEFAULT_REQUIREMENTS = object()
ORACLE_IDS = {
    "llg_overdamped": "fem_llg_reference.v1",
    "projected_gradient_bb": "fem_relaxation_endpoint_equivalence.v1",
    "nonlinear_cg": "fem_relaxation_endpoint_equivalence.v1",
    "tangent_plane_implicit": "fem_tpi_reference.v1",
}


def workload_ids(lane: str, algorithm: str) -> list[str]:
    return [
        f"{lane}.{algorithm}.macrospin",
        f"{lane}.{algorithm}.exchange_demag",
    ]


def canonical_scope(
    *,
    feature_id: str = FEATURE_ID,
    algorithm: str = ALGORITHM,
    lane: str = LANE,
    workloads: list[str] | None = None,
) -> dict[str, object]:
    return {
        "feature_id": feature_id,
        "algorithm": algorithm,
        "lane": lane,
        "backend": "fem",
        "device": "gpu",
        "precision": "fp64",
        "runtime_identity": {
            "kind": "managed_container",
            "id": "fem_gpu_host",
        },
        "validated_workloads": workload_ids(lane, algorithm) if workloads is None else workloads,
        "oracle": {
            "kind": "independent_reference",
            "id": ORACLE_IDS[algorithm],
        },
        "mesh_refinement": {
            "levels": ["coarse", "medium", "fine"],
            "strategy": "same_physical_problem",
        },
        "repeatability": {
            "warmup_runs": 1,
            "measured_runs": 5,
        },
        "evidence": {
            "D4": {"status": "passed", "artifact_manifest": []},
            "D5": {"status": "passed", "artifact_manifest": []},
            "D6": {"status": "passed", "artifact_manifest": []},
        },
    }


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@lru_cache(maxsize=1)
def validator_module():
    return load_module("validate_relaxation_capability_evidence", VALIDATOR_PATH)


def git(repo: Path, *args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=repo, text=True).strip()


def managed_recipe_body() -> str:
    body = validator_module().recipe_body(ROOT / "justfile", MANAGED_RECIPE)
    return f"{MANAGED_RECIPE}:\n{body}\n"


def initialize_repo(tmp_path: Path, justfile_body: str | None = None) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "audit@example.invalid"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Audit Test"], cwd=repo, check=True)
    (repo / ".gitignore").write_text(".fullmag/\n", encoding="utf-8")
    (repo / "justfile").write_text(
        managed_recipe_body() if justfile_body is None else justfile_body,
        encoding="utf-8",
    )
    source = repo / "src" / "solver.cpp"
    source.parent.mkdir()
    source.write_text("int solver_version = 1;\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-qm", "fixture"], cwd=repo, check=True)
    return repo


def add_nested_repo(repo: Path) -> Path:
    nested = repo / "nested-solver"
    nested.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=nested, check=True)
    subprocess.run(["git", "config", "user.email", "nested@example.invalid"], cwd=nested, check=True)
    subprocess.run(["git", "config", "user.name", "Nested Test"], cwd=nested, check=True)
    (nested / "solver.cpp").write_text("int nested_version = 1;\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=nested, check=True)
    subprocess.run(["git", "commit", "-qm", "nested fixture"], cwd=nested, check=True)
    subprocess.run(["git", "add", "nested-solver"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-qm", "add nested solver"], cwd=repo, check=True)
    return nested


def legacy_source_identity(repo: Path) -> tuple[str, str]:
    commit = git(repo, "rev-parse", "HEAD")
    diff = subprocess.check_output(["git", "diff", "--binary", "HEAD"], cwd=repo)
    return commit, hashlib.sha256(diff).hexdigest()


def relaxation_feature(
    *,
    feature_id: str = FEATURE_ID,
    label: str = "Relaxation(projected_gradient_bb)",
    algorithm: str = ALGORITHM,
    lane: str = LANE,
    qualification_requirements: object | None = DEFAULT_REQUIREMENTS,
) -> dict[str, object]:
    lanes = {
        "fdm_cpu_reference": "reference_executable",
        "fdm_gpu_production": "development_executable",
        "fem_cpu_public": "development_executable",
        "fem_gpu_public": "development_executable",
    }
    lanes[lane] = "production_executable"
    feature: dict[str, object] = {
        "id": feature_id,
        "label": label,
        "lanes": lanes,
        "validated_workloads": workload_ids(lane, algorithm),
        "validation_state": "validated",
        "qualification_receipts": [".fullmag/reports/relaxation/receipt.json"],
        "notes": "fixture",
    }
    if qualification_requirements is DEFAULT_REQUIREMENTS:
        qualification_requirements = {
            lane: {
                "device": "gpu",
                "precision": "fp64",
                "validated_scope": canonical_scope(
                    feature_id=feature_id,
                    algorithm=algorithm,
                    lane=lane,
                ),
            }
        }
    if qualification_requirements is not None:
        feature["qualification_requirements"] = qualification_requirements
    return feature


def matrix(feature: dict[str, object]) -> dict[str, object]:
    return {"schema_version": "capability_matrix.v0", "features": [feature]}


def write_receipt(
    repo: Path,
    *,
    feature_id: str = FEATURE_ID,
    algorithm: str = ALGORITHM,
    lane: str = LANE,
    backend: str = "fem",
    device: str = "gpu",
    precision: str = "fp64",
    managed_command: str = f"just {MANAGED_RECIPE}",
    validated_workloads: list[str] | None = None,
    scope: dict[str, object] | None = None,
    source_clean: bool = True,
    source_identity: tuple[str, str] | None = None,
    solver_audit_gate: str = "passed",
) -> tuple[Path, Path]:
    reports = repo / ".fullmag" / "reports" / "relaxation"
    reports.mkdir(parents=True, exist_ok=True)
    artifact = reports / "artifact.json"
    artifact.write_text('{"result":"pass"}\n', encoding="utf-8")
    evidence_artifacts: dict[str, tuple[Path, str]] = {}
    for level in ("D4", "D5", "D6"):
        evidence_artifact = reports / f"{level.lower()}.json"
        evidence_artifact.write_text(
            json.dumps({"evidence": level, "status": "passed"}) + "\n",
            encoding="utf-8",
        )
        evidence_artifacts[level] = (
            evidence_artifact,
            hashlib.sha256(evidence_artifact.read_bytes()).hexdigest(),
        )
    commit, tree_sha256 = source_identity or validator_module().source_identity(repo)
    scope_workloads = (
        workload_ids(lane, algorithm)
        if validated_workloads is None
        else validated_workloads
    )
    validated_scope = canonical_scope(
        feature_id=feature_id,
        algorithm=algorithm,
        lane=lane,
        workloads=scope_workloads,
    ) if scope is None else scope
    evidence = validated_scope.get("evidence")
    if isinstance(evidence, dict):
        for level, (evidence_artifact, evidence_sha256) in evidence_artifacts.items():
            if isinstance(evidence.get(level), dict):
                evidence[level]["artifact_manifest"] = [
                    {
                        "path": f".fullmag/reports/relaxation/{level.lower()}.json",
                        "sha256": evidence_sha256,
                    }
                ]
        if isinstance(evidence.get("D6"), dict):
            evidence["D6"]["artifact_manifest"].append(
                {
                    "path": ".fullmag/reports/relaxation/artifact.json",
                    "sha256": hashlib.sha256(artifact.read_bytes()).hexdigest(),
                }
            )
    receipt = reports / "receipt.json"
    receipt.write_text(
        json.dumps(
            {
                "schema_version": "fullmag.relaxation_qualification_receipt.v1",
                "status": "passed",
                "feature_id": feature_id,
                "algorithm": algorithm,
                "lane": lane,
                "backend": backend,
                "device": device,
                "precision": precision,
                "source_commit": commit,
                "source_tree_sha256": tree_sha256,
                "source_clean": source_clean,
                "artifact_path": ".fullmag/reports/relaxation/artifact.json",
                "artifact_sha256": hashlib.sha256(artifact.read_bytes()).hexdigest(),
                "managed_command": managed_command,
                "validated_scope": validated_scope,
                "solver_audit_gate": solver_audit_gate,
            }
        )
        + "\n",
        encoding="utf-8",
    )
    return receipt, artifact


def validate(document: dict[str, object], repo: Path) -> None:
    validator_module().validate_matrix(document, repo)


def test_accepts_exact_clean_source_bound_managed_receipt(tmp_path: Path) -> None:
    repo = initialize_repo(tmp_path)
    write_receipt(repo)
    validate(matrix(relaxation_feature()), repo)


def test_repository_allowlisted_recipe_uses_managed_container_runtime() -> None:
    validator_module().validate_managed_command(
        f"just {MANAGED_RECIPE}", ROOT, "fem", ALGORITHM
    )


def test_does_not_trust_qualification_requirements(tmp_path: Path) -> None:
    repo = initialize_repo(tmp_path)
    write_receipt(repo)
    feature = relaxation_feature(
        qualification_requirements={
            LANE: {"device": "cpu", "precision": "fp32", "validated_scope": {}}
        }
    )
    validate(matrix(feature), repo)


@pytest.mark.parametrize(
    ("command", "justfile_body", "message"),
    [
        (
            "just verify-fake-relaxation",
            "verify-fake-relaxation:\n    docker compose run fem-gpu true\n",
            "allowlisted",
        ),
        (
            f"just {MANAGED_RECIPE}",
            "some-other-recipe:\n    docker compose run fem-gpu true\n",
            "does not exist",
        ),
        (
            f"just {MANAGED_RECIPE}",
            f"{MANAGED_RECIPE}:\n"
            "    # just ensure-managed-fem-runtime\n"
            "    # docker compose --profile fem-gpu run\n"
            "    cargo test -p fullmag-runner\n",
            "canonical recipe body|managed/container runtime",
        ),
    ],
)
def test_rejects_fake_missing_or_host_only_managed_command(
    tmp_path: Path, command: str, justfile_body: str, message: str
) -> None:
    repo = initialize_repo(tmp_path, justfile_body)
    write_receipt(repo, managed_command=command)
    with pytest.raises(validator_module().EvidenceError, match=message):
        validate(matrix(relaxation_feature()), repo)


def test_rejects_marker_only_recipe_with_exit_zero(tmp_path: Path) -> None:
    repo = initialize_repo(
        tmp_path,
        f"{MANAGED_RECIPE}:\n"
        "    echo 'just ensure-managed-fem-runtime'\n"
        "    echo 'docker compose --profile fem-gpu run'\n"
        "    exit 0\n",
    )
    write_receipt(repo)
    with pytest.raises(validator_module().EvidenceError, match="canonical recipe body|managed/container"):
        validate(matrix(relaxation_feature()), repo)


def test_rejects_tampered_recipe_with_markers_and_exit_zero(tmp_path: Path) -> None:
    repo = initialize_repo(
        tmp_path,
        f"{MANAGED_RECIPE}:\n"
        "    just ensure-managed-fem-runtime\n"
        "    docker compose --profile fem-gpu run --rm fem-gpu bash -lc 'true'\n"
        "    exit 0\n",
    )
    write_receipt(repo)
    with pytest.raises(validator_module().EvidenceError, match="canonical recipe body|sha256"):
        validate(matrix(relaxation_feature()), repo)


def test_rejects_lane_device_mismatch_even_if_requirements_claim_it(tmp_path: Path) -> None:
    repo = initialize_repo(tmp_path)
    write_receipt(repo, device="cpu")
    feature = relaxation_feature(
        qualification_requirements={
            LANE: {
                "device": "cpu",
                "precision": "fp64",
                "validated_scope": {
                    "feature_id": FEATURE_ID,
                    "algorithm": ALGORITHM,
                    "validated_workloads": list(WORKLOADS),
                },
            }
        }
    )
    with pytest.raises(validator_module().EvidenceError, match="device"):
        validate(matrix(feature), repo)


def test_rejects_lane_backend_mismatch(tmp_path: Path) -> None:
    repo = initialize_repo(tmp_path)
    write_receipt(repo, backend="fdm")
    with pytest.raises(validator_module().EvidenceError, match="backend"):
        validate(matrix(relaxation_feature()), repo)


def test_rejects_fem_single_precision_even_if_requirements_claim_it(tmp_path: Path) -> None:
    repo = initialize_repo(tmp_path)
    write_receipt(repo, precision="fp32")
    feature = relaxation_feature(
        qualification_requirements={
            LANE: {
                "device": "gpu",
                "precision": "fp32",
                "validated_scope": {
                    "feature_id": FEATURE_ID,
                    "algorithm": ALGORITHM,
                    "validated_workloads": list(WORKLOADS),
                },
            }
        }
    )
    with pytest.raises(validator_module().EvidenceError, match="precision"):
        validate(matrix(feature), repo)


def test_rejects_scope_missing_any_validated_workload(tmp_path: Path) -> None:
    repo = initialize_repo(tmp_path)
    write_receipt(repo, validated_workloads=[WORKLOADS[0]])
    with pytest.raises(validator_module().EvidenceError, match="validated_workloads"):
        validate(matrix(relaxation_feature()), repo)


@pytest.mark.parametrize(
    "missing_key",
    ["lane", "runtime_identity", "precision", "oracle", "mesh_refinement", "repeatability", "evidence"],
)
def test_rejects_incomplete_canonical_qualification_scope(
    tmp_path: Path, missing_key: str
) -> None:
    repo = initialize_repo(tmp_path)
    scope = canonical_scope()
    scope.pop(missing_key)
    write_receipt(repo, scope=scope)
    feature = relaxation_feature()
    feature["qualification_requirements"][LANE]["validated_scope"] = scope
    with pytest.raises(validator_module().EvidenceError, match="scope|canonical|" + missing_key):
        validate(matrix(feature), repo)


def test_rejects_receipt_evidence_manifest_with_wrong_artifact_hash(tmp_path: Path) -> None:
    repo = initialize_repo(tmp_path)
    write_receipt(repo)
    receipt_path = repo / ".fullmag" / "reports" / "relaxation" / "receipt.json"
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    receipt["validated_scope"]["evidence"]["D5"]["artifact_manifest"][0]["sha256"] = "0" * 64
    receipt_path.write_text(json.dumps(receipt) + "\n", encoding="utf-8")
    with pytest.raises(validator_module().EvidenceError, match="manifest|sha256"):
        validate(matrix(relaxation_feature()), repo)


def test_rejects_renamed_relaxation_feature(tmp_path: Path) -> None:
    repo = initialize_repo(tmp_path)
    write_receipt(repo, feature_id="renamed_pgbb")
    feature = relaxation_feature(feature_id="renamed_pgbb")
    with pytest.raises(validator_module().EvidenceError, match="canonical relaxation feature id"):
        validate(matrix(feature), repo)


def test_rejects_renamed_relaxation_label_with_non_relaxation_id(tmp_path: Path) -> None:
    repo = initialize_repo(tmp_path)
    feature = relaxation_feature(
        feature_id="renamed_pgbb",
        label="Exchange",
    )
    feature.pop("qualification_receipts")
    feature.pop("qualification_requirements")
    with pytest.raises(validator_module().EvidenceError, match="Relaxation|relaxation"):
        validate(matrix(feature), repo)


def test_rejects_noncanonical_workload_even_when_matrix_and_receipt_agree(tmp_path: Path) -> None:
    repo = initialize_repo(tmp_path)
    arbitrary_workload = ["whatever-string-the-receipt-claims"]
    scope = canonical_scope(workloads=arbitrary_workload)
    write_receipt(repo, validated_workloads=arbitrary_workload, scope=scope)
    feature = relaxation_feature()
    feature["validated_workloads"] = arbitrary_workload
    feature["qualification_requirements"][LANE]["validated_scope"] = scope
    with pytest.raises(validator_module().EvidenceError, match="canonical|workload"):
        validate(matrix(feature), repo)


def test_rejects_receipt_reused_across_algorithm(tmp_path: Path) -> None:
    repo = initialize_repo(tmp_path)
    write_receipt(repo)
    feature = relaxation_feature(
        feature_id="relaxation_nonlinear_cg",
        label="Relaxation(nonlinear_cg)",
        algorithm="nonlinear_cg",
    )
    with pytest.raises(validator_module().EvidenceError, match="feature_id|algorithm"):
        validate(matrix(feature), repo)


def test_rejects_tpi_receipt_from_non_tpi_production_recipe(tmp_path: Path) -> None:
    repo = initialize_repo(tmp_path)
    write_receipt(
        repo,
        feature_id="relaxation_tangent_plane_implicit",
        algorithm="tangent_plane_implicit",
        scope=canonical_scope(
            feature_id="relaxation_tangent_plane_implicit",
            algorithm="tangent_plane_implicit",
        ),
    )
    feature = relaxation_feature(
        feature_id="relaxation_tangent_plane_implicit",
        label="Relaxation(tangent_plane_implicit)",
        algorithm="tangent_plane_implicit",
    )
    with pytest.raises(validator_module().EvidenceError, match="algorithm|recipe|TPI"):
        validate(matrix(feature), repo)


def test_rejects_tampered_artifact(tmp_path: Path) -> None:
    repo = initialize_repo(tmp_path)
    _, artifact = write_receipt(repo)
    artifact.write_text('{"result":"tampered"}\n', encoding="utf-8")
    with pytest.raises(validator_module().EvidenceError, match="artifact_sha256"):
        validate(matrix(relaxation_feature()), repo)


def test_rejects_receipt_without_explicit_clean_source(tmp_path: Path) -> None:
    repo = initialize_repo(tmp_path)
    write_receipt(repo, source_clean=False)
    with pytest.raises(validator_module().EvidenceError, match="source_clean"):
        validate(matrix(relaxation_feature()), repo)


@pytest.mark.parametrize("dirty_kind", ["tracked", "untracked", "nested"])
def test_rejects_any_dirty_source_state(tmp_path: Path, dirty_kind: str) -> None:
    repo = initialize_repo(tmp_path)
    nested = add_nested_repo(repo) if dirty_kind == "nested" else None
    if dirty_kind == "tracked":
        (repo / "src" / "solver.cpp").write_text("int solver_version = 2;\n", encoding="utf-8")
    elif dirty_kind == "untracked":
        (repo / "src" / "untracked.cpp").write_text("int bypass = 1;\n", encoding="utf-8")
    else:
        assert nested is not None
        (nested / "solver.cpp").write_text("int nested_version = 2;\n", encoding="utf-8")
    write_receipt(repo, source_identity=legacy_source_identity(repo))
    with pytest.raises(validator_module().EvidenceError, match="source.*clean|dirty|untracked|nested"):
        validate(matrix(relaxation_feature()), repo)


def test_rejects_assume_unchanged_drift(tmp_path: Path) -> None:
    repo = initialize_repo(tmp_path)
    subprocess.run(
        ["git", "update-index", "--assume-unchanged", "src/solver.cpp"],
        cwd=repo,
        check=True,
    )
    (repo / "src" / "solver.cpp").write_text("int solver_version = 99;\n", encoding="utf-8")
    write_receipt(repo, source_identity=legacy_source_identity(repo))
    with pytest.raises(validator_module().EvidenceError, match="assume|index|clean|drift"):
        validate(matrix(relaxation_feature()), repo)


def test_rejects_skip_worktree_drift(tmp_path: Path) -> None:
    repo = initialize_repo(tmp_path)
    subprocess.run(
        ["git", "update-index", "--skip-worktree", "src/solver.cpp"],
        cwd=repo,
        check=True,
    )
    (repo / "src" / "solver.cpp").write_text("int solver_version = 100;\n", encoding="utf-8")
    write_receipt(repo, source_identity=legacy_source_identity(repo))
    with pytest.raises(validator_module().EvidenceError, match="skip|index|clean|drift"):
        validate(matrix(relaxation_feature()), repo)


def test_current_matrix_accepts_unpromoted_relaxation_rows_in_dirty_worktree() -> None:
    document = json.loads(
        (ROOT / "docs" / "specs" / "capability-matrix-v0.json").read_text(encoding="utf-8")
    )
    validator_module().validate_matrix(document, ROOT)
