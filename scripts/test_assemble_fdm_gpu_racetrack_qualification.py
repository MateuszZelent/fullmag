from __future__ import annotations

import importlib.util
import json
from pathlib import Path

from scripts.test_verify_fdm_gpu_racetrack_qualification import _claims


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "assemble_fdm_gpu_racetrack_qualification.py"
SPEC = importlib.util.spec_from_file_location("racetrack_assembler", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
assembler = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(assembler)


def _inputs(tmp_path: Path) -> tuple[Path, Path, Path, Path, dict[str, object], dict[str, object]]:
    script = tmp_path / "scenario.py"
    script.write_text("study = None\n", encoding="utf-8")
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
    return script, fixture, snapshot, runtime_path, runtime, {
        "commit": "a" * 40,
        "source_snapshot_sha256": "b" * 64,
        "input_sha256": assembler.input_digest((script,)),
        "fixture_sha256": assembler.sha256_file(fixture),
    }


def test_missing_gate_artifacts_writes_blocked_summary_without_manifest(tmp_path: Path) -> None:
    script, fixture, snapshot, runtime, _, _ = _inputs(tmp_path)
    result = assembler.assemble(
        tmp_path,
        source_snapshot_path=snapshot,
        runtime_identity_path=runtime,
        input_paths=(script,),
        fixture_path=fixture,
    )

    assert result["status"] == "blocked"
    assert "missing_gate_workload_signs_units" in result["reason_codes"]
    assert (tmp_path / assembler.SUMMARY_NAME).is_file()
    assert not (tmp_path / assembler.MANIFEST_NAME).exists()


def test_gate_without_proof_is_blocked_before_manifest_assembly(tmp_path: Path) -> None:
    script, fixture, snapshot, runtime_path, runtime, source = _inputs(tmp_path)
    gate_dir = tmp_path / "gates"
    gate_dir.mkdir()
    (gate_dir / "workload_signs_units.json").write_text(
        json.dumps(
            {
                "schema_version": "fdm_gpu_racetrack_gate_evidence.v1",
                "status": "pass",
                "source_identity": source,
                "runtime_identity": runtime,
                "claims": _claims()["workload_signs_units"],
            }
        ),
        encoding="utf-8",
    )
    result = assembler.assemble(
        tmp_path,
        source_snapshot_path=snapshot,
        runtime_identity_path=runtime_path,
        input_paths=(script,),
        fixture_path=fixture,
    )
    assert result["status"] == "blocked"
    assert "workload_signs_units_proof_missing_or_invalid" in result["reason_codes"]
    assert not (tmp_path / assembler.MANIFEST_NAME).exists()


def test_all_gate_artifacts_publish_an_atomically_validated_manifest(tmp_path: Path) -> None:
    script, fixture, snapshot, runtime_path, runtime, source = _inputs(tmp_path)
    gate_dir = tmp_path / "gates"
    proof_dir = tmp_path / "proofs"
    raw_dir = tmp_path / "raw"
    gate_dir.mkdir()
    proof_dir.mkdir()
    raw_dir.mkdir()
    for gate_id, claims in _claims().items():
        raw_path = raw_dir / f"{gate_id}.json"
        raw_path.write_text(json.dumps({"gate_id": gate_id}), encoding="utf-8")
        evidence_paths = [f"raw/{gate_id}.json"]
        (proof_dir / f"{gate_id}.json").write_text(
            json.dumps(
                {
                    "schema_version": "fdm_gpu_racetrack_gate_proof.v1",
                    "gate_id": gate_id,
                    "status": "pass",
                    "source_identity": source,
                    "runtime_identity": runtime,
                    "claims": claims,
                    "evidence_paths": evidence_paths,
                }
            ),
            encoding="utf-8",
        )
        (gate_dir / f"{gate_id}.json").write_text(
            json.dumps(
                {
                    "schema_version": "fdm_gpu_racetrack_gate_evidence.v1",
                    "status": "pass",
                    "source_identity": source,
                    "runtime_identity": runtime,
                    "claims": claims,
                    "proof": {
                        "schema_version": "fdm_gpu_racetrack_gate_proof.v1",
                        "path": f"proofs/{gate_id}.json",
                        "evidence_paths": evidence_paths,
                    },
                }
            ),
            encoding="utf-8",
        )
    audit = tmp_path / "execution-audit.json"
    audit.write_text(
        json.dumps(
            {
                "schema_version": "fdm_gpu_racetrack_execution_audit.v1",
                "status": "pass",
                "runtime_identity": runtime,
                "reason_codes": [],
                "fallbacks": [],
                "hot_loop_host_device_transfers": 0,
                "forbidden_transfer_bytes": 0,
                "torque_provenance": "solved_transport",
                "transport_telemetry": {
                    "schema_version": "fdm_gpu_transport_telemetry_summary.v1",
                    "status": "pass",
                    "stage_count": 6,
                    "record_count": 120,
                    "hot_loop_host_device_transfers": 0,
                    "hot_loop_device_to_device_transfers": 120,
                    "hot_loop_host_sync_count": 120,
                    "forbidden_transfer_bytes": 0,
                    "allowed_control_h2d_records": 120,
                    "allowed_control_h2d_bytes": 30720,
                    "allowed_scalar_d2h_records": 120,
                    "allowed_scalar_d2h_bytes": 30720,
                    "torque_provenance": "solved_transport",
                    "all_stage_records_present": True,
                },
            }
        ),
        encoding="utf-8",
    )

    result = assembler.assemble(
        tmp_path,
        source_snapshot_path=snapshot,
        runtime_identity_path=runtime_path,
        input_paths=(script,),
        fixture_path=fixture,
        execution_audit_path=audit,
    )

    assert result["status"] == "pass"
    manifest_path = tmp_path / assembler.MANIFEST_NAME
    assert manifest_path.is_file()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["status"] == "pass"
    assert set(manifest["gates"]) == set(_claims())


def test_gate_identity_mismatch_blocks_publication(tmp_path: Path) -> None:
    script, fixture, snapshot, runtime_path, runtime, source = _inputs(tmp_path)
    gate_dir = tmp_path / "gates"
    gate_dir.mkdir()
    for gate_id, claims in _claims().items():
        gate_source = dict(source)
        if gate_id == "hall_angle":
            gate_source["input_sha256"] = "f" * 64
        (gate_dir / f"{gate_id}.json").write_text(
            json.dumps(
                {
                    "schema_version": "fdm_gpu_racetrack_gate_evidence.v1",
                    "status": "pass",
                    "source_identity": gate_source,
                    "runtime_identity": runtime,
                    "claims": claims,
                }
            ),
            encoding="utf-8",
        )
    result = assembler.assemble(
        tmp_path,
        source_snapshot_path=snapshot,
        runtime_identity_path=runtime_path,
        input_paths=(script,),
        fixture_path=fixture,
    )
    assert result["status"] == "blocked"
    assert "hall_angle_source_identity_mismatch" in result["reason_codes"]
    assert not (tmp_path / assembler.MANIFEST_NAME).exists()


def test_blocked_gate_reason_is_preserved_in_summary(tmp_path: Path) -> None:
    script, fixture, snapshot, runtime_path, runtime, source = _inputs(tmp_path)
    gate_dir = tmp_path / "gates"
    gate_dir.mkdir()
    (gate_dir / "workload_signs_units.json").write_text(
        json.dumps(
            {
                "schema_version": "fdm_gpu_racetrack_gate_evidence.v1",
                "status": "blocked",
                "source_identity": source,
                "runtime_identity": runtime,
                "reason_codes": ["proof_missing"],
                "claims": {},
            }
        ),
        encoding="utf-8",
    )

    result = assembler.assemble(
        tmp_path,
        source_snapshot_path=snapshot,
        runtime_identity_path=runtime_path,
        input_paths=(script,),
        fixture_path=fixture,
    )

    assert result["status"] == "blocked"
    assert "workload_signs_units_proof_missing" in result["reason_codes"]


def test_qualification_input_must_match_captured_snapshot(tmp_path: Path) -> None:
    script, fixture, snapshot, runtime_path, _, _ = _inputs(tmp_path)
    snapshot.write_text(
        json.dumps(
            {
                "head_commit_full": "a" * 40,
                "source_snapshot_sha256": "b" * 64,
                "qualification_inputs": [
                    {
                        "path": "tests/standard_problems/transport/racetrack_m1_v1/fixture.v1.json",
                        "mode": "100644",
                        "sha256": assembler.sha256_file(fixture),
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    result = assembler.assemble(
        tmp_path,
        source_snapshot_path=snapshot,
        runtime_identity_path=runtime_path,
        input_paths=(script,),
        fixture_path=fixture,
        qualification_input="tests/standard_problems/transport/racetrack_m1_v1/fixture.v1.json",
    )
    assert result["status"] == "blocked"
    assert "missing_gate_workload_signs_units" in result["reason_codes"]

    fixture.write_text('{"schema_version":"racetrack_m1_v1","changed":true}\n', encoding="utf-8")
    changed = assembler.assemble(
        tmp_path,
        source_snapshot_path=snapshot,
        runtime_identity_path=runtime_path,
        input_paths=(script,),
        fixture_path=fixture,
        qualification_input="tests/standard_problems/transport/racetrack_m1_v1/fixture.v1.json",
    )
    assert changed["status"] == "blocked"
    assert "source_snapshot_qualification_input_mismatch" in changed["reason_codes"]
