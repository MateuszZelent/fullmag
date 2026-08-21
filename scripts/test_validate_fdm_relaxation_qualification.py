from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
import sys
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
    (repo / "justfile").write_text(
        "verify-fdm-relaxation-qualification-release:\n"
        "    echo release\n",
        encoding="utf-8",
    )
    subprocess.run(["git", "add", ".gitignore", "source.cpp", "justfile"], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-qm", "fixture"], cwd=repo, check=True)
    return repo


def artifact(repo: Path, name: str, payload: object) -> tuple[str, str]:
    path = repo / ".fullmag" / "reports" / "fdm-relaxation" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, sort_keys=True) + "\n", encoding="utf-8")
    return str(path.relative_to(repo)), hashlib.sha256(path.read_bytes()).hexdigest()


def fixture_json_hash(payload: object) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8").replace(b"\n", b"") + b"\n").hexdigest()


def valid_receipt(repo: Path) -> dict[str, object]:
    module = load_module()
    lane = "fdm_cpu_reference"
    precision = "fp64"
    algorithm = "projected_gradient_bb"
    commit, tree = module.source_identity(repo)
    workloads = module.canonical_workloads(lane, precision, algorithm)
    runtime_identity = module.LANE_POLICY[lane]["runtime"]
    managed_command = "just verify-fdm-relaxation-qualification-release"
    result = {
        "status": "passed",
        "converged": True,
        "termination_reason": "torque",
        "accepted_steps": 12,
        "max_steps": 100,
        "metrics": {
            "max_torque_apm": 1.0,
            "max_torque_t": 1.0e-6,
            "energy_j": -1.0e-21,
            "mx": 0.0,
            "my": 0.0,
            "mz": 1.0,
        },
    }
    binding = module.canonical_binding(
        lane=lane,
        algorithm=algorithm,
        workload_ids=workloads,
        mesh_levels=("coarse", "medium", "fine"),
    )
    parity = module.parity_scope(lane, precision)
    refinement_observations = []
    repeatability_observations = []
    for workload in workloads:
        for mesh_level in ("coarse", "medium", "fine"):
            input_hash = fixture_json_hash({"workload_id": workload, "mesh_level": mesh_level})
            state_hash = fixture_json_hash({"values": [[0.0, 0.0, 1.0]]})
            refinement_observations.append(
                {
                    "workload_id": workload,
                    "mesh_level": mesh_level,
                    "input_contract_sha256": input_hash,
                    "measured_run_count": 5,
                    "final_state_sha256": [state_hash] * 5,
                    "result": result,
                }
            )
            repeatability_observations.append(
                {
                    "workload_id": workload,
                    "mesh_level": mesh_level,
                    "warmup_run_count": 1,
                    "measured_run_count": 5,
                    "input_contract_sha256": input_hash,
                    "run_log_paths": [
                        f"runs/{algorithm}--{lane}--{precision}/{workload}/{mesh_level}/measured-{index:02d}/runtime.log"
                        for index in range(1, 6)
                    ],
                    "final_state_sha256": [state_hash] * 5,
                    "energy_relative_spread": 0.0,
                }
            )
    refinement = {
        "levels": ["coarse", "medium", "fine"],
        "strategy": "same_physical_problem",
        "observations": refinement_observations,
    }
    repeatability = {
        "warmup_runs": 1,
        "measured_runs": 5,
        "determinism_policy": "same_input_contract_and_bounded_metric_spread",
        "observations": repeatability_observations,
    }
    evidence: dict[str, dict[str, object]] = {}
    artifact_paths: dict[str, tuple[str, str]] = {}
    for level in module.EVIDENCE_LEVELS:
        relative = f"artifacts/{level.lower()}.json"
        artifact_path, digest = artifact(
            repo,
            relative,
            {
                "schema_version": module.ARTIFACT_SCHEMA,
                "level": level,
                "cell": {"algorithm": algorithm, "lane": lane, "precision": precision},
                "workload_ids": workloads,
                "source_commit": commit,
                "source_tree_sha256": tree,
                "runtime_identity": runtime_identity,
                "oracle": module.ORACLES[algorithm],
                **binding,
                "parity": parity,
                "mesh_refinement_observations": refinement,
                "repeatability_observations": repeatability,
                "result": result,
            },
        )
        artifact_paths[level] = (artifact_path, digest)
        evidence[level] = {
            "status": "passed",
            "artifact_manifest": [{"path": artifact_path, "sha256": digest}],
        }
    oracle_script = ROOT / "scripts" / "verify_relaxation_independent_oracle.py"
    workload_records: dict[str, list[dict[str, object]]] = {}
    measured_records: list[dict[str, object]] = []

    def make_run_records(workload: str) -> list[dict[str, object]]:
        records: list[dict[str, object]] = []
        for mesh_level in ("coarse", "medium", "fine"):
            for repetition in ("warmup-01", "measured-01", "measured-02", "measured-03", "measured-04", "measured-05"):
                base = f"runs/{algorithm}--{lane}--{precision}/{workload}/{mesh_level}/{repetition}"
                log_path, log_hash = artifact(repo, f"{base}/runtime.log", {"status": "passed"})
                input_path, input_hash = artifact(repo, f"{base}/input-contract.json", {"workload_id": workload, "mesh_level": mesh_level})
                metadata_path, metadata_hash = artifact(
                    repo,
                    f"{base}/metadata.json",
                    {"status": "completed", "completion": {"converged": True, "reason": "torque"}},
                )
                observables_path, observables_hash = artifact(repo, f"{base}/scalars.csv", {"E_total": -1e-21})
                state_path, state_hash = artifact(repo, f"{base}/m_final.json", {"values": [[0.0, 0.0, 1.0]]})
                record = {
                    "workload_id": workload,
                    "mesh_level": mesh_level,
                    "repetition": repetition,
                    "command": "/opt/fullmag/bin/fullmag examples/relaxation_qualification_case.py --headless --json",
                    "elapsed_s": 0.25,
                    "timeout_s": 30.0,
                    "timeout": False,
                    "exit_code": 0,
                    "log_path": log_path,
                    "log_sha256": log_hash,
                    "input_contract_path": input_path,
                    "input_contract_sha256": input_hash,
                    "metadata_path": metadata_path,
                    "metadata_sha256": metadata_hash,
                    "final_observables_path": observables_path,
                    "final_observables_sha256": observables_hash,
                    "final_state_path": state_path,
                    "final_state_sha256": state_hash,
                    "result": result,
                    "initial_energy_j": -1e-21,
                }
                records.append(record)
                if repetition.startswith("measured-"):
                    measured_records.append(record)
        return records

    cases = []
    for case_name in ("macrospin", "exchange_demag"):
        workload = module.workload_id(lane, precision, algorithm, case_name)
        records = make_run_records(workload)
        workload_records[workload] = records
        oracle_input_path, _ = artifact(
            repo,
            f"oracles/input_{case_name}.json",
            {
                "schema_version": "fullmag.relaxation.oracle_input.v1",
                "oracle": module.ORACLES[algorithm],
                "algorithm": algorithm,
                "lane": lane,
                "precision": precision,
                "workload": case_name,
                "measurements": [
                    {
                        key: record[key]
                        for key in (
                            "input_contract_path",
                            "input_contract_sha256",
                            "final_state_path",
                            "final_state_sha256",
                            "initial_energy_j",
                            "result",
                        )
                    }
                    for record in records
                ],
            },
        )
        oracle_path = f".fullmag/reports/fdm-relaxation/oracles/{algorithm}--{lane}--{precision}--{case_name}.json"
        oracle_absolute = repo / oracle_path
        oracle_run = subprocess.run(
            [
                sys.executable,
                str(oracle_script),
                "--input",
                str(repo / oracle_input_path),
                "--output",
                str(oracle_absolute),
                "--artifact-root",
                str(repo),
            ],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        assert oracle_run.returncode == 0, oracle_run.stdout + oracle_run.stderr
        oracle_hash = hashlib.sha256(oracle_absolute.read_bytes()).hexdigest()
        case_path, case_hash = artifact(
            repo,
            f"cases/{case_name}.json",
            {
                "schema_version": "fullmag.relaxation.case_artifact.v1",
                "workload_id": workload,
                "status": "passed",
                "result": result,
                "run_count": 18,
                "run_records": records,
            },
        )
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
                "metrics": result["metrics"],
                "oracle": {
                    "kind": "independent_reference",
                    "id": module.ORACLES[algorithm]["id"],
                    "artifact_path": oracle_path,
                    "artifact_sha256": oracle_hash,
                },
                "artifacts": [{"path": case_path, "sha256": case_hash}],
            }
        )
    runtime_manifest_path, runtime_manifest_hash = artifact(
        repo,
        "process/runtime-manifest.json",
        {
            "schema_version": "fullmag.relaxation.runtime_manifest.v1",
            "runtime_identity": runtime_identity,
            "backend": "fdm",
            "device": "cpu",
            "precision": precision,
            "source_commit": commit,
            "source_tree_sha256": tree,
            "source_git_tree": "f" * 40,
            "scenario": "examples/relaxation_qualification_case.py",
            "scenario_sha256": "c" * 64,
            "executable": "/opt/fullmag/bin/fullmag",
            "executable_sha256": "e" * 64,
        },
    )
    log_path, log_hash = artifact(
        repo,
        "process/run.log",
        {
            "schema_version": "fullmag.relaxation.execution_log.v1",
            "status": "passed",
            "exit_code": 0,
            "command": managed_command,
            "subprocesses": measured_records,
        },
    )
    execution = {
        "status": "passed",
        "converged": True,
        "termination_reason": "torque",
        "timeout": False,
        "max_steps_reached": False,
        "non_converged": False,
        "fallback_occurred": False,
        "accepted_steps": 12,
        "max_steps": 100,
        "metrics": result["metrics"],
        "confirmation": {
            "accepted_state_id": "fdm_cpu_reference:fp64:projected_gradient_bb:step-12",
            "observed_after_accepted_step": True,
        },
        "process": {
            "command": managed_command,
            "command_sha256": hashlib.sha256(managed_command.encode()).hexdigest(),
            "runtime_manifest_path": runtime_manifest_path,
            "runtime_manifest_sha256": runtime_manifest_hash,
            "log_path": log_path,
            "log_sha256": log_hash,
            "exit_code": 0,
        },
    }
    return {
        "schema_version": module.SCHEMA,
        "status": "passed",
        "feature_id": f"relaxation_{algorithm}",
        "algorithm": algorithm,
        "lane": lane,
        "backend": "fdm",
        "device": "cpu",
        "precision": precision,
        "runtime_identity": runtime_identity,
        "source_commit": commit,
        "source_tree_sha256": tree,
        "source_clean": True,
        "recipe_sha256": module.recipe_sha256(repo, managed_command),
        "managed_command": managed_command,
        "artifact_path": artifact_paths["D6"][0],
        "artifact_sha256": artifact_paths["D6"][1],
        "validated_scope": {
            "feature_id": f"relaxation_{algorithm}",
            "algorithm": algorithm,
            "lane": lane,
            "backend": "fdm",
            "device": "cpu",
            "precision": precision,
            "runtime_identity": runtime_identity,
            "validated_workloads": workloads,
            "oracle": module.ORACLES[algorithm],
            "mesh_refinement": refinement,
            "repeatability": repeatability,
            **binding,
            "parity": parity,
            "evidence": evidence,
        },
        "execution": execution,
        "cases": cases,
        "solver_audit_gate": "passed",
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
        (("cases", 0, "timeout_s"), 901.0, "timeout"),
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


def test_rejects_cpu_recipe_for_gpu_lane(tmp_path: Path) -> None:
    repo = init_repo(tmp_path)
    receipt = valid_receipt(repo)
    receipt["lane"] = "fdm_gpu_production"
    receipt["device"] = "cuda"
    receipt["runtime_identity"] = {
        "kind": "managed_container",
        "id": "fdm_cuda_runtime",
    }
    with pytest.raises(load_module().QualificationError, match="allowlisted recipe"):
        load_module().validate_receipt(receipt, repo)


def test_rejects_smoke_recipe_as_qualification_receipt(tmp_path: Path) -> None:
    repo = init_repo(tmp_path)
    receipt = valid_receipt(repo)
    receipt["managed_command"] = "just verify-fdm-relaxation-qualification-smoke"
    with pytest.raises(load_module().QualificationError, match="allowlisted recipe"):
        load_module().validate_receipt(receipt, repo)


def test_rejects_arbitrary_semantic_artifact(tmp_path: Path) -> None:
    repo = init_repo(tmp_path)
    receipt = valid_receipt(repo)
    item = receipt["validated_scope"]["evidence"]["D4"]["artifact_manifest"][0]  # type: ignore[index]
    path = repo / item["path"]  # type: ignore[index]
    path.write_text(json.dumps({"status": "passed"}) + "\n", encoding="utf-8")
    item["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()  # type: ignore[index]
    with pytest.raises(load_module().QualificationError, match="artifact schema"):
        load_module().validate_receipt(receipt, repo)


def test_rejects_assume_unchanged_source_flag(tmp_path: Path) -> None:
    repo = init_repo(tmp_path)
    receipt = valid_receipt(repo)
    subprocess.run(["git", "update-index", "--assume-unchanged", "justfile"], cwd=repo, check=True)
    with pytest.raises(load_module().QualificationError, match="assume-unchanged"):
        load_module().validate_receipt(receipt, repo)


def test_rejects_unattested_execution_log(tmp_path: Path) -> None:
    repo = init_repo(tmp_path)
    receipt = valid_receipt(repo)
    log_path = repo / receipt["execution"]["process"]["log_path"]  # type: ignore[index]
    log_path.write_text(json.dumps({"status": "passed", "exit_code": 0}) + "\n", encoding="utf-8")
    receipt["execution"]["process"]["log_sha256"] = hashlib.sha256(log_path.read_bytes()).hexdigest()  # type: ignore[index]
    with pytest.raises(load_module().QualificationError, match="execution log schema"):
        load_module().validate_receipt(receipt, repo)
