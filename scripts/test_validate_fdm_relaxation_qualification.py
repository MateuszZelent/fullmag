from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
from functools import lru_cache
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "validate_fdm_relaxation_qualification.py"


@lru_cache(maxsize=1)
def load_module():
    spec = importlib.util.spec_from_file_location("fdm_qualification", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def init_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "FDM Test"], cwd=repo, check=True)
    (repo / ".gitignore").write_text(".fullmag/\n", encoding="utf-8")
    (repo / "source.cpp").write_text("int version = 1;\n", encoding="utf-8")
    subprocess.run(["git", "add", ".gitignore", "source.cpp"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-qm", "fixture"], cwd=repo, check=True)
    return repo


def artifact(repo: Path, name: str, payload: object) -> tuple[str, str]:
    path = repo / ".fullmag" / "reports" / "fdm-relaxation" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, sort_keys=True) + "\n", encoding="utf-8")
    return str(path.relative_to(repo)), hashlib.sha256(path.read_bytes()).hexdigest()


def valid_receipt(repo: Path) -> dict[str, object]:
    module = load_module()
    lane = "fdm_cpu_reference"
    precision = "fp64"
    algorithm = "projected_gradient_bb"
    commit, tree = module.source_identity(repo)
    oracle_path, oracle_hash = artifact(repo, "oracle.json", {"oracle": "reference"})
    cases = []
    for case_name in ("macrospin", "exchange_demag"):
        workload = module.workload_id(lane, precision, algorithm, case_name)
        case_path, case_hash = artifact(repo, f"{case_name}.json", {"workload_id": workload})
        cases.append(
            {
                "workload_id": workload,
                "algorithm": algorithm,
                "backend": "fdm",
                "device": "cpu",
                "precision": precision,
                "timeout_s": 30.0,
                "elapsed_s": 0.25,
                "status": "passed",
                "skipped": False,
                "fallback_occurred": False,
                "completion": {"converged": True, "reason": "torque"},
                "accepted_steps": 12,
                "max_steps": 100,
                "metrics": {"max_torque_apm": 1.0, "energy_j": -1.0e-21},
                "oracle": {
                    "kind": "independent_reference",
                    "id": "fdm_direct_minimizer_reference.v1",
                    "artifact_path": oracle_path,
                    "artifact_sha256": oracle_hash,
                },
                "artifacts": [{"path": case_path, "sha256": case_hash}],
            }
        )
    receipt_path, receipt_hash = artifact(repo, "receipt-artifact.json", {"status": "passed"})
    return {
        "schema_version": module.SCHEMA,
        "status": "passed",
        "lane": lane,
        "backend": "fdm",
        "device": "cpu",
        "precision": precision,
        "runtime_identity": {"kind": "reference_process", "id": "fdm_cpu_reference"},
        "algorithm": algorithm,
        "managed_command": "just verify-fdm-relaxation-qualification-smoke",
        "source_identity": {"source_clean": True, "source_commit": commit, "source_tree_sha256": tree},
        "validated_workloads": module.canonical_workloads(lane, precision, algorithm),
        "cases": cases,
        "artifact_path": receipt_path,
        "artifact_sha256": receipt_hash,
    }


def test_accepts_complete_receipt(tmp_path: Path) -> None:
    repo = init_repo(tmp_path)
    receipt = valid_receipt(repo)
    load_module().validate_receipt(receipt, repo)


@pytest.mark.parametrize(
    ("path", "value", "message"),
    [
        (("cases", 0, "completion", "converged"), False, "converged"),
        (("cases", 0, "accepted_steps"), 100, "max_steps"),
        (("cases", 0, "skipped"), True, "skipped"),
        (("cases", 0, "fallback_occurred"), True, "fallback"),
        (("cases", 0, "elapsed_s"), 31.0, "timeout"),
        (("cases", 0, "oracle"), None, "oracle"),
    ],
)
def test_rejects_non_qualifying_case(tmp_path: Path, path: tuple[object, ...], value: object, message: str) -> None:
    repo = init_repo(tmp_path)
    receipt = valid_receipt(repo)
    target: object = receipt
    for part in path[:-1]:
        target = target[part]  # type: ignore[index]
    target[path[-1]] = value  # type: ignore[index]
    with pytest.raises(load_module().QualificationError, match=message):
        load_module().validate_receipt(receipt, repo)


def test_rejects_illegal_cpu_fp32(tmp_path: Path) -> None:
    repo = init_repo(tmp_path)
    receipt = valid_receipt(repo)
    receipt["precision"] = "fp32"
    with pytest.raises(load_module().QualificationError, match="precision"):
        load_module().validate_receipt(receipt, repo)


def test_rejects_tampered_artifact(tmp_path: Path) -> None:
    repo = init_repo(tmp_path)
    receipt = valid_receipt(repo)
    artifact_path = repo / receipt["cases"][0]["artifacts"][0]["path"]  # type: ignore[index]
    artifact_path.write_text("tampered\n", encoding="utf-8")
    with pytest.raises(load_module().QualificationError, match="hash"):
        load_module().validate_receipt(receipt, repo)


def test_rejects_missing_workload(tmp_path: Path) -> None:
    repo = init_repo(tmp_path)
    receipt = valid_receipt(repo)
    receipt["cases"] = receipt["cases"][:1]  # type: ignore[index]
    with pytest.raises(load_module().QualificationError, match="incomplete"):
        load_module().validate_receipt(receipt, repo)
