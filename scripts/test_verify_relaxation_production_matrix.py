from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "verify_relaxation_production_matrix.py"
ORACLE_SCRIPT = ROOT / "scripts" / "verify_relaxation_independent_oracle.py"
SPEC = importlib.util.spec_from_file_location("relaxation_production_matrix", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
matrix = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(matrix)


ALGORITHMS = (
    "llg_overdamped",
    "projected_gradient_bb",
    "nonlinear_cg",
    "tangent_plane_implicit",
)
LANE_PRECISIONS = (
    ("fdm_cpu_reference", "fp64", "fdm", "cpu", "fdm_cpu_reference"),
    ("fdm_gpu_production", "fp32", "fdm", "cuda", "fdm_cuda_runtime"),
    ("fdm_gpu_production", "fp64", "fdm", "cuda", "fdm_cuda_runtime"),
    ("fem_cpu_public", "fp64", "fem", "cpu", "fem_cpu_runtime"),
    ("fem_gpu_public", "fp64", "fem", "gpu", "fem_gpu_host"),
)
ORACLES = {
    "llg_overdamped": {"kind": "independent_reference", "id": "fem_llg_reference.v1"},
    "projected_gradient_bb": {
        "kind": "independent_reference",
        "id": "fem_relaxation_endpoint_equivalence.v1",
    },
    "nonlinear_cg": {
        "kind": "independent_reference",
        "id": "fem_relaxation_endpoint_equivalence.v1",
    },
    "tangent_plane_implicit": {
        "kind": "independent_reference",
        "id": "fem_tpi_reference.v1",
    },
}
SOURCE_COMMIT = "a" * 40
SOURCE_TREE = "b" * 64
RECIPE_HASHES = {
    lane: hashlib.sha256(lane.encode("utf-8")).hexdigest()
    for lane, _, _, _, _ in LANE_PRECISIONS
}
EXPECTED_IDENTITY = {
    "source_commit": SOURCE_COMMIT,
    "source_tree_sha256": SOURCE_TREE,
    "recipe_sha256_by_lane": RECIPE_HASHES,
}


def _write_json(path: Path, payload: object) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _fixture_json_hash(payload: object) -> str:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8") + b"\n"
    ).hexdigest()


def _run_records(root: Path, stem: str, workload: str, result: dict[str, object]) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    for mesh in ("coarse", "medium", "fine"):
        for repetition in ("warmup-01", "measured-01", "measured-02", "measured-03", "measured-04", "measured-05"):
            base = Path("runs") / stem / workload / mesh / repetition
            log = root / base / "runtime.log"
            input_contract = root / base / "input-contract.json"
            metadata = root / base / "metadata.json"
            scalars = root / base / "scalars.csv"
            final_state = root / base / "m_final.json"
            for path, payload in (
                (input_contract, {"workload_id": workload, "mesh_level": mesh}),
                (metadata, {"status": "completed", "completion": {"converged": True, "reason": "torque"}}),
                (final_state, {"observable": "m", "values": [[0.0, 0.0, 1.0]]}),
            ):
                _write_json(path, payload)
            scalars.parent.mkdir(parents=True, exist_ok=True)
            scalars.write_text("step,E_total\n1,-1e-21\n", encoding="utf-8")
            log.parent.mkdir(parents=True, exist_ok=True)
            log.write_text("qualification runtime\n", encoding="utf-8")
            records.append(
                {
                    "workload_id": workload,
                    "mesh_level": mesh,
                    "repetition": repetition,
                    "command": "/opt/fullmag/bin/fullmag examples/relaxation_qualification_case.py --headless --json",
                    "elapsed_s": 0.25,
                    "timeout_s": 30.0,
                    "timeout": False,
                    "exit_code": 0,
                    "log_path": log.relative_to(root).as_posix(),
                    "log_sha256": hashlib.sha256(log.read_bytes()).hexdigest(),
                    "input_contract_path": input_contract.relative_to(root).as_posix(),
                    "input_contract_sha256": hashlib.sha256(input_contract.read_bytes()).hexdigest(),
                    "metadata_path": metadata.relative_to(root).as_posix(),
                    "metadata_sha256": hashlib.sha256(metadata.read_bytes()).hexdigest(),
                    "final_observables_path": scalars.relative_to(root).as_posix(),
                    "final_observables_sha256": hashlib.sha256(scalars.read_bytes()).hexdigest(),
                    "final_state_path": final_state.relative_to(root).as_posix(),
                    "final_state_sha256": hashlib.sha256(final_state.read_bytes()).hexdigest(),
                    "result": copy.deepcopy(result),
                    "initial_energy_j": -1.0e-21,
                }
            )
    return records


def _write_oracle(
    root: Path,
    stem: str,
    algorithm: str,
    lane: str,
    precision: str,
    workload: str,
    records: list[dict[str, object]],
) -> tuple[str, str]:
    identity = ORACLES[algorithm]
    input_path = root / "oracle-input" / f"{stem}--{workload}.json"
    _write_json(
        input_path,
        {
            "schema_version": "fullmag.relaxation.oracle_input.v1",
            "oracle": identity,
            "algorithm": algorithm,
            "lane": lane,
            "precision": precision,
            "workload": workload,
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
    output_path = root / "oracles" / f"{stem}--{workload}.json"
    result = subprocess.run(
        [
            sys.executable,
            str(ORACLE_SCRIPT),
            "--input",
            str(input_path),
            "--output",
            str(output_path),
            "--artifact-root",
            str(root),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    return output_path.relative_to(root).as_posix(), hashlib.sha256(output_path.read_bytes()).hexdigest()


def _cell_stem(algorithm: str, lane: str, precision: str) -> str:
    return f"{algorithm}--{lane}--{precision}"


def _workloads(algorithm: str, lane: str, precision: str) -> list[str]:
    return [
        f"{lane}.{precision}.{algorithm}.macrospin",
        f"{lane}.{precision}.{algorithm}.exchange_demag",
    ]


def _evidence_scope(
    algorithm: str,
    lane: str,
    precision: str,
    result: dict[str, object],
    *,
    stem: str,
) -> tuple[dict[str, object], dict[str, object]]:
    workloads = _workloads(algorithm, lane, precision)
    binding = matrix.canonical_binding(
        lane=lane,
        algorithm=algorithm,
        workload_ids=workloads,
        mesh_levels=("coarse", "medium", "fine"),
    )
    refinement_observations = []
    repeatability_observations = []
    for workload in workloads:
        for level in ("coarse", "medium", "fine"):
            input_hash = _fixture_json_hash({"workload_id": workload, "mesh_level": level})
            state_hash = _fixture_json_hash({"observable": "m", "values": [[0.0, 0.0, 1.0]]})
            refinement_observations.append(
                {
                    "workload_id": workload,
                    "mesh_level": level,
                    "input_contract_sha256": input_hash,
                    "measured_run_count": 5,
                    "final_state_sha256": [state_hash] * 5,
                    "result": result,
                }
            )
            repeatability_observations.append(
                {
                    "workload_id": workload,
                    "mesh_level": level,
                    "warmup_run_count": 1,
                    "measured_run_count": 5,
                    "input_contract_sha256": input_hash,
                    "run_log_paths": [
                        f"runs/{stem}/{workload}/{level}/measured-{index:02d}/runtime.log"
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
    return binding, {"mesh_refinement": refinement, "repeatability": repeatability}


def _init_source(root: Path) -> Path:
    source = root / "source"
    source.mkdir(parents=True)
    subprocess.run(["git", "init", "-q"], cwd=source, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=source, check=True)
    subprocess.run(["git", "config", "user.name", "Matrix Test"], cwd=source, check=True)
    (source / "source.cpp").write_text("int version = 1;\n", encoding="utf-8")
    recipes = "\n".join(
        f"{recipe}:\n    echo {recipe}\n"
        for recipe in matrix.CANONICAL_RECIPE_BY_LANE.values()
    )
    (source / "justfile").write_text(recipes, encoding="utf-8")
    subprocess.run(["git", "add", "source.cpp", "justfile"], cwd=source, check=True)
    subprocess.run(["git", "commit", "-qm", "fixture"], cwd=source, check=True)
    return source


def _write_receipt(
    root: Path,
    *,
    algorithm: str,
    lane: str,
    precision: str,
    source_commit: str = SOURCE_COMMIT,
    source_tree_sha256: str = SOURCE_TREE,
    recipe_sha256: str | None = None,
    source_clean: bool = True,
    scope_overrides: dict[str, object] | None = None,
    execution_overrides: dict[str, object] | None = None,
    receipt_status: str = "passed",
    output_name: str | None = None,
) -> Path:
    lane_row = next(
        row for row in LANE_PRECISIONS if row[0] == lane and row[1] == precision
    )
    _, _, backend, device, runtime_id = lane_row
    stem = _cell_stem(algorithm, lane, precision)
    evidence: dict[str, dict[str, object]] = {}
    workloads = _workloads(algorithm, lane, precision)
    runtime_identity = {
        "kind": "reference_process" if lane == "fdm_cpu_reference" else "managed_container",
        "id": runtime_id,
    }
    managed_command = f"just {matrix.CANONICAL_RECIPE_BY_LANE[lane]}"
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
    binding, observations = _evidence_scope(algorithm, lane, precision, result, stem=stem)
    parity = matrix.parity_scope(lane, precision)
    if parity["status"] == "required":
        parity_relative = Path("parity") / f"{stem}.json"
        baseline_workloads = _workloads(
            algorithm,
            parity["baseline_lane"],
            parity["baseline_precision"],
        )
        parity_digest = _write_json(
            root / parity_relative,
            {
                "schema_version": matrix.PARITY_SCHEMA,
                "status": "passed",
                "target": {"algorithm": algorithm, "lane": lane, "precision": precision},
                "baseline": {
                    "lane": parity["baseline_lane"],
                    "precision": parity["baseline_precision"],
                },
                "source_commit": source_commit,
                "source_tree_sha256": source_tree_sha256,
                "comparisons": [
                    {
                        "workload_id": workload,
                        "target_workload_id": workload,
                        "baseline_workload_id": baseline_workload,
                        "mesh_level": level,
                        "target_input_contract_sha256": _fixture_json_hash(
                            {"workload_id": workload, "mesh_level": level}
                        ),
                        "baseline_input_contract_sha256": "c" * 64,
                        "target_final_state_sha256": _fixture_json_hash(
                            {"observable": "m", "values": [[0.0, 0.0, 1.0]]}
                        ),
                        "baseline_final_state_sha256": "d" * 64,
                        "target_metrics": {
                            "energy_j": -1e-21,
                            "max_torque_apm": 1.0,
                            "max_torque_t": 1e-6,
                            "mx": 0.0,
                            "my": 0.0,
                            "mz": 1.0,
                        },
                        "baseline_metrics": {
                            "energy_j": -1e-21,
                            "max_torque_apm": 1.0,
                            "max_torque_t": 1e-6,
                            "mx": 0.0,
                            "my": 0.0,
                            "mz": 1.0,
                        },
                        "absolute_error": {
                            "energy_j": 0.0,
                            "max_torque_apm": 0.0,
                            "max_torque_t": 0.0,
                            "mx": 0.0,
                            "my": 0.0,
                            "mz": 0.0,
                        },
                        "tolerance": {
                            "energy_j": 1e-30,
                            "max_torque_apm": 1e-6,
                            "max_torque_t": 1e-12,
                            "mx": 1e-8,
                            "my": 1e-8,
                            "mz": 1e-8,
                        },
                        "status": "passed",
                    }
                    for workload, baseline_workload in zip(
                        _workloads(algorithm, lane, precision), baseline_workloads
                    )
                    for level in ("coarse", "medium", "fine")
                ],
                "tolerances": {},
            },
        )
        parity = {
            **parity,
            "artifact_path": parity_relative.as_posix(),
            "artifact_sha256": parity_digest,
        }
    for level in ("D4", "D5", "D6"):
        relative = Path("artifacts") / stem / f"{level.lower()}.json"
        digest = _write_json(
            root / relative,
            {
                "schema_version": matrix.ARTIFACT_SCHEMA,
                "level": level,
                "cell": {"algorithm": algorithm, "lane": lane, "precision": precision},
                "workload_ids": workloads,
                "source_commit": source_commit,
                "source_tree_sha256": source_tree_sha256,
                "runtime_identity": runtime_identity,
                "oracle": copy.deepcopy(ORACLES[algorithm]),
                **binding,
                "parity": parity,
                "mesh_refinement_observations": observations["mesh_refinement"],
                "repeatability_observations": observations["repeatability"],
                "result": result,
            },
        )
        evidence[level] = {
            "status": "passed",
            "artifact_manifest": [{"path": relative.as_posix(), "sha256": digest}],
        }
    artifact_relative = Path("artifacts") / stem / "result.json"
    artifact_digest = _write_json(
        root / artifact_relative,
        {
            "schema_version": matrix.ARTIFACT_SCHEMA,
            "level": "D6",
            "cell": {"algorithm": algorithm, "lane": lane, "precision": precision},
            "workload_ids": workloads,
            "source_commit": source_commit,
            "source_tree_sha256": source_tree_sha256,
            "runtime_identity": runtime_identity,
            "oracle": copy.deepcopy(ORACLES[algorithm]),
            **binding,
            "parity": parity,
            "mesh_refinement_observations": observations["mesh_refinement"],
            "repeatability_observations": observations["repeatability"],
            "result": result,
        },
    )
    evidence["D6"]["artifact_manifest"].append(
        {"path": artifact_relative.as_posix(), "sha256": artifact_digest}
    )
    scope: dict[str, object] = {
        "feature_id": f"relaxation_{algorithm}",
        "algorithm": algorithm,
        "lane": lane,
        "backend": backend,
        "device": device,
        "precision": precision,
        "runtime_identity": {
            "kind": "reference_process" if lane == "fdm_cpu_reference" else "managed_container",
            "id": runtime_id,
        },
        "validated_workloads": workloads,
        "oracle": copy.deepcopy(ORACLES[algorithm]),
        "mesh_refinement": observations["mesh_refinement"],
        "repeatability": observations["repeatability"],
        **binding,
        "parity": parity,
        "evidence": evidence,
    }
    cases: list[dict[str, object]] = []
    run_records_by_workload: dict[str, list[dict[str, object]]] = {}
    subprocess_records: list[dict[str, object]] = []
    for case_name in ("macrospin", "exchange_demag"):
        workload = f"{lane}.{precision}.{algorithm}.{case_name}"
        run_records = _run_records(root, stem, workload, result)
        run_records_by_workload[workload] = run_records
        subprocess_records.extend(
            record
            for record in run_records
            if str(record["repetition"]).startswith("measured-")
        )
        oracle_relative, oracle_digest = _write_oracle(
            root,
            stem,
            algorithm,
            lane,
            precision,
            case_name,
            run_records,
        )
        case_relative = Path("cases") / f"{stem}--{case_name}.json"
        case_digest = _write_json(
            root / case_relative,
            {
                "schema_version": "fullmag.relaxation.case_artifact.v1",
                "workload_id": workload,
                "status": "passed",
                "result": result,
                "run_count": 18,
                "run_records": run_records,
            },
        )
        cases.append(
            {
                "workload_id": workload,
                "algorithm": algorithm,
                "backend": backend,
                "device": device,
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
                    **ORACLES[algorithm],
                    "artifact_path": oracle_relative,
                    "artifact_sha256": oracle_digest,
                },
                "artifacts": [{"path": case_relative.as_posix(), "sha256": case_digest}],
            }
        )
    if scope_overrides:
        scope.update(copy.deepcopy(scope_overrides))
    execution: dict[str, object] = {
        "status": "passed",
        "converged": True,
        "termination_reason": "torque",
        "timeout": False,
        "max_steps_reached": False,
        "non_converged": False,
        "fallback_occurred": False,
        "accepted_steps": 12,
        "max_steps": 100,
        "metrics": {"max_torque_apm": 1.0, "energy_j": -1.0e-21},
        "confirmation": {
            "accepted_state_id": f"{stem}:step-12",
            "observed_after_accepted_step": True,
        },
        "process": {
            "command": managed_command,
            "command_sha256": hashlib.sha256(managed_command.encode()).hexdigest(),
            "runtime_manifest_path": f"artifacts/{stem}/runtime-manifest.json",
            "runtime_manifest_sha256": "",
            "log_path": f"artifacts/{stem}/run.log",
            "log_sha256": "",
            "exit_code": 0,
        },
    }
    if execution_overrides:
        execution.update(copy.deepcopy(execution_overrides))
    receipt: dict[str, object] = {
        "schema_version": matrix.RECEIPT_SCHEMA,
        "status": receipt_status,
        "feature_id": f"relaxation_{algorithm}",
        "algorithm": algorithm,
        "lane": lane,
        "backend": backend,
        "device": device,
        "runtime_identity": runtime_identity,
        "precision": precision,
        "source_commit": source_commit,
        "source_tree_sha256": source_tree_sha256,
        "source_clean": source_clean,
        "recipe_sha256": recipe_sha256 or RECIPE_HASHES[lane],
        "managed_command": managed_command,
        "artifact_path": artifact_relative.as_posix(),
        "artifact_sha256": artifact_digest,
        "validated_scope": scope,
        "execution": execution,
        "cases": cases,
        "solver_audit_gate": "passed",
    }
    runtime_manifest = root / execution["process"]["runtime_manifest_path"]
    log_path = root / execution["process"]["log_path"]
    runtime_manifest_digest = _write_json(
        runtime_manifest,
        {
            "schema_version": "fullmag.relaxation.runtime_manifest.v1",
            "runtime_identity": runtime_identity,
            "backend": backend,
            "device": device,
            "precision": precision,
            "source_commit": source_commit,
            "source_tree_sha256": source_tree_sha256,
            "source_git_tree": "f" * 40,
            "scenario": "examples/relaxation_qualification_case.py",
            "scenario_sha256": "c" * 64,
            "executable": "/opt/fullmag/bin/fullmag",
            "executable_sha256": "e" * 64,
            **(
                {
                    "managed_bundle_manifest_sha256": "d" * 64,
                    "managed_bundle_build_identity": {
                        "git_commit": source_commit,
                        "git_tree": "f" * 40,
                        "worktree_state": "clean",
                    },
                }
                if lane != "fdm_cpu_reference"
                else {}
            ),
        },
    )
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text(
        json.dumps(
            {
                "schema_version": "fullmag.relaxation.execution_log.v1",
                "status": "passed",
                "exit_code": 0,
                "command": managed_command,
                "subprocesses": subprocess_records,
            }
        )
        + "\n",
        encoding="utf-8",
    )
    execution["process"]["runtime_manifest_sha256"] = runtime_manifest_digest
    execution["process"]["log_sha256"] = hashlib.sha256(log_path.read_bytes()).hexdigest()
    name = output_name or f"{stem}.json"
    path = root / "receipts" / name
    _write_json(path, receipt)
    return path


def write_complete_bundle(root: Path) -> tuple[list[Path], dict[str, object]]:
    source = _init_source(root)
    source_commit, source_tree = matrix._source_identity(source)
    recipe_hashes = {
        lane: matrix._recipe_sha256(source, recipe)
        for lane, recipe in matrix.CANONICAL_RECIPE_BY_LANE.items()
    }
    paths: list[Path] = []
    for algorithm in ALGORITHMS:
        for lane, precision, *_ in LANE_PRECISIONS:
            if (algorithm, lane) in matrix.UNSUPPORTED_CELLS:
                continue
            paths.append(
                _write_receipt(
                    root,
                algorithm=algorithm,
                lane=lane,
                precision=precision,
                source_commit=source_commit,
                source_tree_sha256=source_tree,
                recipe_sha256=recipe_hashes[lane],
            )
        )
    return paths, {
        "source_commit": source_commit,
        "source_tree_sha256": source_tree,
        "recipe_sha256_by_lane": recipe_hashes,
    }


def run(paths: list[Path], root: Path, expected: dict[str, object]) -> dict[str, object]:
    source_root = root / "source"
    return matrix.orchestrate(
        paths,
        expected_identity=expected,
        artifact_root=root,
        source_root=source_root if source_root.is_dir() else None,
    )


def test_complete_matrix_is_qualified_and_manifest_is_deterministic(tmp_path: Path) -> None:
    paths, expected = write_complete_bundle(tmp_path)
    first = run(paths, tmp_path, expected)
    second = run(list(reversed(paths)), tmp_path, expected)

    assert first["status"] == "qualified"
    assert first["checksum_sha256"] == second["checksum_sha256"]
    assert first["manifest"] == second["manifest"]
    assert first["manifest"]["status"] == "qualified"
    assert len(first["manifest"]["cells"]) == 20
    assert first["manifest"]["canonical_scope"]["cell_count"] == 16


def test_cli_discovers_receipts_and_writes_deterministic_manifest(tmp_path: Path) -> None:
    _, expected = write_complete_bundle(tmp_path)
    expected_path = tmp_path / "expected-identity.json"
    _write_json(expected_path, expected)
    output = tmp_path / "matrix.json"

    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--receipt-root",
            str(tmp_path),
            "--artifact-root",
            str(tmp_path),
            "--expected-identity",
            str(expected_path),
            "--source-root",
            str(tmp_path / "source"),
            "--output",
            str(output),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0
    assert "FM-RELAX-017 QUALIFIED" in result.stdout
    manifest = json.loads(output.read_text(encoding="utf-8"))
    assert manifest["status"] == "qualified"
    assert manifest["checksum_sha256"] == matrix._sha256_bytes(
        matrix._canonical_bytes(
            {key: value for key, value in manifest.items() if key != "checksum_sha256"}
        )
    )


@pytest.mark.parametrize(
    "missing_lane",
    ["fdm_cpu_reference", "fdm_gpu_production", "fem_cpu_public", "fem_gpu_public"],
)
def test_every_missing_lane_blocks(tmp_path: Path, missing_lane: str) -> None:
    paths, expected = write_complete_bundle(tmp_path)
    paths = [path for path in paths if f"--{missing_lane}--" not in path.name]

    result = run(paths, tmp_path, expected)

    assert result["status"] == "blocked"
    assert any(
        f"lane={missing_lane}" in item and "missing=receipt" in item
        for item in result["missing_evidence"]
    )


@pytest.mark.parametrize("missing_algorithm", ALGORITHMS)
def test_every_missing_algorithm_blocks(tmp_path: Path, missing_algorithm: str) -> None:
    paths, expected = write_complete_bundle(tmp_path)
    paths = [path for path in paths if not path.name.startswith(f"{missing_algorithm}--")]

    result = run(paths, tmp_path, expected)

    assert result["status"] == "blocked"
    assert any(
        f"algorithm={missing_algorithm}" in item and "missing=receipt" in item
        for item in result["missing_evidence"]
    )


def test_every_missing_precision_blocks(tmp_path: Path) -> None:
    paths, expected = write_complete_bundle(tmp_path)
    paths = [
        path
        for path in paths
        if not path.name.endswith("--fdm_gpu_production--fp32.json")
    ]

    result = run(paths, tmp_path, expected)

    assert result["status"] == "blocked"
    assert any(
        "lane=fdm_gpu_production" in item
        and "precision=fp32" in item
        and "missing=receipt" in item
        for item in result["missing_evidence"]
    )


@pytest.mark.parametrize("scope_field", ["oracle", "mesh_refinement", "repeatability"])
def test_missing_canonical_scope_evidence_blocks(
    tmp_path: Path, scope_field: str
) -> None:
    paths, expected = write_complete_bundle(tmp_path)
    target = next(path for path in paths if "llg_overdamped--fdm_cpu_reference--fp64" in path.name)
    receipt = json.loads(target.read_text(encoding="utf-8"))
    receipt["validated_scope"].pop(scope_field)
    target.write_text(json.dumps(receipt), encoding="utf-8")

    result = run(paths, tmp_path, expected)

    assert result["status"] == "blocked"
    assert any(
        "algorithm=llg_overdamped" in item and f"missing=scope.{scope_field}" in item
        for item in result["missing_evidence"]
    )


@pytest.mark.parametrize(
    ("field", "value", "needle"),
    [
        ("source_commit", "c" * 40, "source_commit"),
        ("source_tree_sha256", "d" * 64, "source_tree_sha256"),
        ("recipe_sha256", "e" * 64, "recipe_sha256"),
    ],
)
def test_identity_mismatch_blocks(
    tmp_path: Path, field: str, value: str, needle: str
) -> None:
    paths, expected = write_complete_bundle(tmp_path)
    receipt = json.loads(paths[0].read_text(encoding="utf-8"))
    receipt[field] = value
    paths[0].write_text(json.dumps(receipt), encoding="utf-8")

    result = run(paths, tmp_path, expected)

    assert result["status"] == "blocked"
    assert any(needle in item and "mismatch" in item for item in result["missing_evidence"])


def test_dirty_source_blocks(tmp_path: Path) -> None:
    paths, expected = write_complete_bundle(tmp_path)
    receipt = json.loads(paths[0].read_text(encoding="utf-8"))
    receipt["source_clean"] = False
    paths[0].write_text(json.dumps(receipt), encoding="utf-8")

    result = run(paths, tmp_path, expected)

    assert result["status"] == "blocked"
    assert any("source_clean" in item for item in result["missing_evidence"])


@pytest.mark.parametrize(
    ("field", "value", "needle"),
    [("source_dirty", True, "source_dirty"), ("worktree_dirty", True, "source_dirty")],
)
def test_dirty_source_indicators_cannot_be_hidden(
    tmp_path: Path, field: str, value: object, needle: str
) -> None:
    paths, expected = write_complete_bundle(tmp_path)
    receipt = json.loads(paths[0].read_text(encoding="utf-8"))
    receipt[field] = value
    paths[0].write_text(json.dumps(receipt), encoding="utf-8")

    result = run(paths, tmp_path, expected)

    assert result["status"] == "blocked"
    assert any(needle in item for item in result["missing_evidence"])


def test_tampered_artifact_blocks(tmp_path: Path) -> None:
    paths, expected = write_complete_bundle(tmp_path)
    receipt = json.loads(paths[0].read_text(encoding="utf-8"))
    artifact = tmp_path / receipt["artifact_path"]
    artifact.write_text("tampered\n", encoding="utf-8")

    result = run(paths, tmp_path, expected)

    assert result["status"] == "blocked"
    assert any("artifact" in item and "sha256" in item for item in result["missing_evidence"])


def test_receipt_outside_artifact_root_blocks_deterministically(tmp_path: Path) -> None:
    bundle_root = tmp_path / "bundle"
    outside_root = tmp_path / "outside"
    paths, expected = write_complete_bundle(bundle_root)

    result = run(paths[:1], outside_root, expected)

    assert result["status"] == "blocked"
    assert any("outside_artifact_root" in item for item in result["missing_evidence"])
    assert all(str(tmp_path) not in item for item in result["missing_evidence"])


def test_fallback_reason_blocks_even_when_fallback_flag_is_false(tmp_path: Path) -> None:
    paths, expected = write_complete_bundle(tmp_path)
    receipt = json.loads(paths[0].read_text(encoding="utf-8"))
    receipt["execution"]["fallback_reason"] = "cpu fallback"
    paths[0].write_text(json.dumps(receipt), encoding="utf-8")

    result = run(paths, tmp_path, expected)

    assert result["status"] == "blocked"
    assert any("fallback" in item for item in result["missing_evidence"])


def test_mixed_source_blocks(tmp_path: Path) -> None:
    paths, expected = write_complete_bundle(tmp_path)
    receipt = json.loads(paths[1].read_text(encoding="utf-8"))
    receipt["source_commit"] = "f" * 40
    paths[1].write_text(json.dumps(receipt), encoding="utf-8")

    result = run(paths, tmp_path, expected)

    assert result["status"] == "blocked"
    assert any("mixed_source" in item or "source_commit" in item for item in result["missing_evidence"])


def test_duplicate_receipt_blocks(tmp_path: Path) -> None:
    paths, expected = write_complete_bundle(tmp_path)
    duplicate = tmp_path / "receipts" / "duplicate.json"
    shutil.copyfile(paths[0], duplicate)
    paths.append(duplicate)

    result = run(paths, tmp_path, expected)

    assert result["status"] == "blocked"
    assert any("duplicate_receipt" in item for item in result["missing_evidence"])


@pytest.mark.parametrize(
    ("execution_field", "value", "needle"),
    [
        ("status", "failed", "failed"),
        ("timeout", True, "timeout"),
        ("max_steps_reached", True, "max_steps"),
        ("non_converged", True, "non_converged"),
        ("fallback_occurred", True, "fallback"),
    ],
)
def test_failed_timeout_max_steps_nonconverged_and_fallback_block(
    tmp_path: Path, execution_field: str, value: object, needle: str
) -> None:
    paths, expected = write_complete_bundle(tmp_path)
    target = paths[0]
    receipt = json.loads(target.read_text(encoding="utf-8"))
    receipt["execution"][execution_field] = value
    if execution_field == "status":
        receipt["status"] = "failed"
    target.write_text(json.dumps(receipt), encoding="utf-8")

    result = run(paths, tmp_path, expected)

    assert result["status"] == "blocked"
    assert any(needle in item for item in result["missing_evidence"])


def test_missing_expected_identity_blocks_closed(tmp_path: Path) -> None:
    paths, _ = write_complete_bundle(tmp_path)

    result = matrix.orchestrate(paths, expected_identity=None, artifact_root=tmp_path)

    assert result["status"] == "blocked"
    assert "missing=expected_identity" in result["missing_evidence"]


def test_offline_orchestration_can_never_qualify(tmp_path: Path) -> None:
    paths, expected = write_complete_bundle(tmp_path)

    result = matrix.orchestrate(paths, expected_identity=expected, artifact_root=tmp_path)

    assert result["status"] == "blocked"
    assert "missing=source_root" in result["missing_evidence"]


def test_arbitrary_recipe_cannot_qualify(tmp_path: Path) -> None:
    paths, expected = write_complete_bundle(tmp_path)
    receipt = json.loads(paths[0].read_text(encoding="utf-8"))
    receipt["managed_command"] = "just definitely-not-a-real-managed-recipe"
    paths[0].write_text(json.dumps(receipt), encoding="utf-8")

    result = run(paths, tmp_path, expected)

    assert result["status"] == "blocked"
    assert any("canonical_recipe" in item for item in result["missing_evidence"])


def test_gpu_cannot_use_cpu_recipe_or_runtime(tmp_path: Path) -> None:
    paths, expected = write_complete_bundle(tmp_path)
    target = next(path for path in paths if "--fdm_gpu_production--fp64" in path.name)
    receipt = json.loads(target.read_text(encoding="utf-8"))
    receipt["managed_command"] = "just verify-fdm-relaxation-qualification-release"
    receipt["runtime_identity"] = {
        "kind": "reference_process",
        "id": "fdm_cpu_reference",
    }
    target.write_text(json.dumps(receipt), encoding="utf-8")

    result = run(paths, tmp_path, expected)

    assert result["status"] == "blocked"
    assert any("managed_command.canonical_recipe" in item for item in result["missing_evidence"])
    assert any("runtime_identity" in item for item in result["missing_evidence"])


def test_arbitrary_semantic_artifact_cannot_qualify(tmp_path: Path) -> None:
    paths, expected = write_complete_bundle(tmp_path)
    target = next(path for path in paths if "llg_overdamped--fdm_cpu_reference--fp64" in path.name)
    receipt = json.loads(target.read_text(encoding="utf-8"))
    item = receipt["validated_scope"]["evidence"]["D4"]["artifact_manifest"][0]
    artifact = tmp_path / item["path"]
    artifact.write_text(json.dumps({"status": "passed"}) + "\n", encoding="utf-8")
    item["sha256"] = hashlib.sha256(artifact.read_bytes()).hexdigest()
    target.write_text(json.dumps(receipt), encoding="utf-8")

    result = run(paths, tmp_path, expected)

    assert result["status"] == "blocked"
    assert any("D4.artifact_schema" in item for item in result["missing_evidence"])


def test_execution_log_schema_cannot_be_fabricated(tmp_path: Path) -> None:
    paths, expected = write_complete_bundle(tmp_path)
    target = paths[0]
    receipt = json.loads(target.read_text(encoding="utf-8"))
    process = receipt["execution"]["process"]
    log = tmp_path / process["log_path"]
    log.write_text(json.dumps({"status": "passed", "exit_code": 0, "command": process["command"]}) + "\n", encoding="utf-8")
    process["log_sha256"] = hashlib.sha256(log.read_bytes()).hexdigest()
    target.write_text(json.dumps(receipt), encoding="utf-8")

    result = run(paths, tmp_path, expected)

    assert result["status"] == "blocked"
    assert any("execution.log_schema" in item for item in result["missing_evidence"])


def test_same_artifact_cannot_be_shared_by_two_cells(tmp_path: Path) -> None:
    paths, expected = write_complete_bundle(tmp_path)
    first = next(path for path in paths if "llg_overdamped--fdm_cpu_reference--fp64" in path.name)
    second = next(path for path in paths if "projected_gradient_bb--fdm_cpu_reference--fp64" in path.name)
    first_receipt = json.loads(first.read_text(encoding="utf-8"))
    second_receipt = json.loads(second.read_text(encoding="utf-8"))
    shared_item = first_receipt["validated_scope"]["evidence"]["D4"]["artifact_manifest"][0]
    second_receipt["validated_scope"]["evidence"]["D4"]["artifact_manifest"][0] = copy.deepcopy(shared_item)
    second.write_text(json.dumps(second_receipt), encoding="utf-8")

    result = run(paths, tmp_path, expected)

    assert result["status"] == "blocked"
    assert any("duplicate_artifact_across_cells" in item for item in result["missing_evidence"])


def test_assume_unchanged_source_flag_blocks(tmp_path: Path) -> None:
    paths, expected = write_complete_bundle(tmp_path)
    subprocess.run(["git", "update-index", "--assume-unchanged", "justfile"], cwd=tmp_path / "source", check=True)

    result = run(paths, tmp_path, expected)

    assert result["status"] == "blocked"
    assert any("assume-unchanged" in item for item in result["missing_evidence"])


def test_no_receipts_blocks_every_expected_cell(tmp_path: Path) -> None:
    result = run([], tmp_path, copy.deepcopy(EXPECTED_IDENTITY))

    assert result["status"] == "blocked"
    assert sum("missing=receipt" in item for item in result["missing_evidence"]) == 16
    assert "missing=source_root" in result["missing_evidence"]
