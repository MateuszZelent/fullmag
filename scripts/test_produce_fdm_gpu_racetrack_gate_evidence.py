from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts import produce_fdm_gpu_racetrack_gate_evidence as producer
from scripts.test_verify_fdm_gpu_racetrack_qualification import _claims


def _inputs(tmp_path: Path) -> tuple[Path, Path, Path, Path, dict[str, str], dict[str, object]]:
    scenario = tmp_path / "scenario.py"
    scenario.write_text("study = None\n", encoding="utf-8")
    fixture = tmp_path / "fixture.v1.json"
    fixture.write_text('{"schema_version":"racetrack_m1_v1"}\n', encoding="utf-8")
    snapshot = tmp_path / "source-snapshot.json"
    snapshot.write_text(
        json.dumps(
            {
                "head_commit_full": "a" * 40,
                "source_snapshot_sha256": "b" * 64,
            }
        ),
        encoding="utf-8",
    )
    runtime_path = tmp_path / "runtime.json"
    runtime = {
        "managed_container": True,
        "gpu_uuid": "GPU-test",
        "cuda_driver": "550.54.14",
        "cuda_runtime": "12.4",
        "build_digest": "e" * 64,
        "free_memory_bytes": 8 * 1024**3,
    }
    runtime_path.write_text(json.dumps(runtime), encoding="utf-8")
    source = {
        "commit": "a" * 40,
        "source_snapshot_sha256": "b" * 64,
        "input_sha256": producer.input_digest((scenario,)),
        "fixture_sha256": producer.sha256_file(fixture),
    }
    return scenario, fixture, snapshot, runtime_path, source, runtime


def test_missing_proof_is_materialized_as_blocked_gate(tmp_path: Path) -> None:
    scenario, fixture, snapshot, runtime_path, _, _ = _inputs(tmp_path)
    result = producer.produce(
        tmp_path,
        source_snapshot_path=snapshot,
        runtime_identity_path=runtime_path,
        input_paths=(scenario,),
        fixture_path=fixture,
    )

    assert result["status"] == "blocked"
    assert "workload_signs_units" in result["blocked_gates"]
    artifact = json.loads(
        (tmp_path / "gates/workload_signs_units.json").read_text(encoding="utf-8")
    )
    assert artifact["status"] == "blocked"
    assert artifact["reason_codes"] == ["proof_missing"]


def test_proof_requires_existing_evidence_and_preserves_claims(tmp_path: Path) -> None:
    scenario, fixture, snapshot, runtime_path, source, runtime = _inputs(tmp_path)
    proof_root = tmp_path / "proofs"
    proof_root.mkdir()
    evidence = tmp_path / "raw" / "signs.json"
    evidence.parent.mkdir()
    evidence.write_text("{}\n", encoding="utf-8")
    (proof_root / "workload_signs_units.json").write_text(
        json.dumps(
            {
                "schema_version": producer.PROOF_SCHEMA,
                "gate_id": "workload_signs_units",
                "status": "pass",
                "source_identity": source,
                "runtime_identity": runtime,
                "claims": _claims()["workload_signs_units"],
                "evidence_paths": ["raw/signs.json"],
            }
        ),
        encoding="utf-8",
    )

    result = producer.produce(
        tmp_path,
        source_snapshot_path=snapshot,
        runtime_identity_path=runtime_path,
        input_paths=(scenario,),
        fixture_path=fixture,
        proof_root=proof_root,
    )

    assert result["status"] == "blocked"
    assert "workload_signs_units" in result["passed_gates"]
    gate = json.loads(
        (tmp_path / "gates/workload_signs_units.json").read_text(encoding="utf-8")
    )
    assert gate["status"] == "pass"
    assert gate["claims"] == _claims()["workload_signs_units"]
    assert gate["source_identity"] == source
    assert gate["runtime_identity"] == runtime


def test_proof_outside_root_is_rejected(tmp_path: Path) -> None:
    scenario, fixture, snapshot, runtime_path, _, _ = _inputs(tmp_path)
    proof_root = tmp_path / "proofs"
    proof_root.mkdir()
    (proof_root / "workload_signs_units.json").write_text(
        json.dumps(
            {
                "schema_version": producer.PROOF_SCHEMA,
                "gate_id": "workload_signs_units",
                "status": "pass",
                "claims": _claims()["workload_signs_units"],
                "evidence_paths": ["../outside.json"],
            }
        ),
        encoding="utf-8",
    )

    result = producer.produce(
        tmp_path,
        source_snapshot_path=snapshot,
        runtime_identity_path=runtime_path,
        input_paths=(scenario,),
        fixture_path=fixture,
        proof_root=proof_root,
    )

    assert result["status"] == "blocked"
    assert "workload_signs_units" in result["blocked_gates"]
    assert "workload_signs_units_proof_evidence_outside_root" in result["reason_codes"]


def test_proof_without_source_or_runtime_identity_is_rejected(tmp_path: Path) -> None:
    scenario, fixture, snapshot, runtime_path, _, _ = _inputs(tmp_path)
    proof_root = tmp_path / "proofs"
    proof_root.mkdir()
    evidence = tmp_path / "raw" / "signs.json"
    evidence.parent.mkdir()
    evidence.write_text("{}\n", encoding="utf-8")
    (proof_root / "workload_signs_units.json").write_text(
        json.dumps(
            {
                "schema_version": producer.PROOF_SCHEMA,
                "gate_id": "workload_signs_units",
                "status": "pass",
                "claims": _claims()["workload_signs_units"],
                "evidence_paths": ["raw/signs.json"],
            }
        ),
        encoding="utf-8",
    )
    result = producer.produce(
        tmp_path,
        source_snapshot_path=snapshot,
        runtime_identity_path=runtime_path,
        input_paths=(scenario,),
        fixture_path=fixture,
        proof_root=proof_root,
    )
    assert result["status"] == "blocked"
    assert "workload_signs_units_proof_source_identity_missing" in result["reason_codes"]


def test_proof_cannot_use_another_proof_as_raw_evidence(tmp_path: Path) -> None:
    scenario, fixture, snapshot, runtime_path, source, runtime = _inputs(tmp_path)
    proof_root = tmp_path / "proofs"
    proof_root.mkdir()
    raw_proof = proof_root / "raw.json"
    raw_proof.write_text("{}\n", encoding="utf-8")
    (proof_root / "workload_signs_units.json").write_text(
        json.dumps(
            {
                "schema_version": producer.PROOF_SCHEMA,
                "gate_id": "workload_signs_units",
                "status": "pass",
                "source_identity": source,
                "runtime_identity": runtime,
                "claims": _claims()["workload_signs_units"],
                "evidence_paths": ["proofs/raw.json"],
            }
        ),
        encoding="utf-8",
    )
    result = producer.produce(
        tmp_path,
        source_snapshot_path=snapshot,
        runtime_identity_path=runtime_path,
        input_paths=(scenario,),
        fixture_path=fixture,
        proof_root=proof_root,
    )
    assert result["status"] == "blocked"
    assert "workload_signs_units_proof_evidence_must_be_raw" in result["reason_codes"]


def test_proof_file_outside_evidence_root_is_rejected(tmp_path: Path) -> None:
    scenario, fixture, snapshot, runtime_path, source, runtime = _inputs(tmp_path)
    evidence_root = tmp_path / "evidence"
    proof_root = tmp_path / "external-proofs"
    proof_root.mkdir()
    evidence = evidence_root / "raw" / "signs.json"
    evidence.parent.mkdir(parents=True)
    evidence.write_text("{}\n", encoding="utf-8")
    (proof_root / "workload_signs_units.json").write_text(
        json.dumps(
            {
                "schema_version": producer.PROOF_SCHEMA,
                "gate_id": "workload_signs_units",
                "status": "pass",
                "source_identity": source,
                "runtime_identity": runtime,
                "claims": _claims()["workload_signs_units"],
                "evidence_paths": ["raw/signs.json"],
            }
        ),
        encoding="utf-8",
    )
    result = producer.produce(
        evidence_root,
        source_snapshot_path=snapshot,
        runtime_identity_path=runtime_path,
        input_paths=(scenario,),
        fixture_path=fixture,
        proof_root=proof_root,
    )
    assert result["status"] == "blocked"
    assert "workload_signs_units_proof_outside_root" in result["reason_codes"]
