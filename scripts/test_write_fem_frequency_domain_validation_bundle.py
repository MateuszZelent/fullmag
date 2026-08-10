from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from test_verify_fem_frequency_domain_production_dod import valid_scope  # noqa: E402
from verify_fem_frequency_domain_production_dod import (  # noqa: E402
    validate_production_record,
    validate_scope_catalog,
    scope_id_for,
)
from write_fem_frequency_domain_validation_bundle import (  # noqa: E402
    write_validation_bundle,
)


def _write_fixture_artifacts(root: Path) -> None:
    (root / "frequency_domain").mkdir(parents=True)
    (root / "eigen" / "mode_fields.zarr").mkdir(parents=True)
    (root / "frequency_domain" / "manifest.v1.json").write_text(
        json.dumps(
            {
                "schema_version": "frequency_domain_manifest.v1",
                "implementation_state": "executable",
                "validation_state": "unvalidated",
            }
        ),
        encoding="utf-8",
    )
    (root / "eigen" / "spectrum.v2.json").write_text(
        json.dumps({"schema_version": "eigen_spectrum.v2", "samples": []}),
        encoding="utf-8",
    )
    (root / "eigen" / "dispersion.csv").write_text(
        "sample_index,frequency_hz\n0,1.0\n", encoding="utf-8"
    )
    (root / "eigen" / "mode_fields.zarr" / ".zgroup").write_text(
        '{"zarr_format":2}\n', encoding="utf-8"
    )


def _execution_proof(scope: dict[str, object], root: Path) -> dict[str, object]:
    stdout = root / "validation" / "verifier.stdout.log"
    stderr = root / "validation" / "verifier.stderr.log"
    stdout.parent.mkdir(parents=True, exist_ok=True)
    stdout.write_text("verifier: pass\n", encoding="utf-8")
    stderr.write_text("", encoding="utf-8")
    catalog = {
        "schema": "scope_catalog.v1",
        "scope_schema": "frequency_domain_validation_scope.v1",
        "scopes": {scope_id_for(scope): scope},
    }
    catalog_sha256 = validate_scope_catalog(catalog)
    return {
        "id": "test-verifier",
        "version": "v1",
        "result": "pass",
        "command": ["python3", "scripts/test-verifier.py", "--scope", scope_id_for(scope)],
        "exit_code": 0,
        "stdout_path": "validation/verifier.stdout.log",
        "stdout_sha256": "sha256:" + hashlib.sha256(stdout.read_bytes()).hexdigest(),
        "stderr_path": "validation/verifier.stderr.log",
        "stderr_sha256": "sha256:" + hashlib.sha256(stderr.read_bytes()).hexdigest(),
        "executed_at": "2026-08-05T12:00:00Z",
        "scope_id": scope_id_for(scope),
        "scope_catalog_sha256": catalog_sha256,
        "runtime_fullmag_commit": scope["runtime_scope"]["fullmag_commit"],
        "runtime_build_id": scope["runtime_scope"]["build_id"],
    }


def test_writer_emits_catalog_bindings_sidecars_and_blocked_record(tmp_path: Path) -> None:
    _write_fixture_artifacts(tmp_path)
    result = write_validation_bundle(tmp_path, valid_scope())

    catalog_path = tmp_path / "validation" / "scopes" / "scope_catalog.v1.json"
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    assert result.scope_id in catalog["scopes"]
    assert result.catalog_sha256 == validate_scope_catalog(catalog)

    for path in (
        tmp_path / "frequency_domain" / "manifest.v1.json",
        tmp_path / "eigen" / "spectrum.v2.json",
    ):
        value = json.loads(path.read_text(encoding="utf-8"))
        assert value["verified_coverage_of"]["scope_id"] == result.scope_id

    csv_sidecar = tmp_path / "eigen" / "dispersion.csv.validation_manifest.v1.json"
    zarr_sidecar = (
        tmp_path / "eigen" / "mode_fields.zarr.validation_manifest.v1.json"
    )
    assert csv_sidecar.is_file()
    assert zarr_sidecar.is_file()
    assert json.loads(csv_sidecar.read_text(encoding="utf-8"))["artifact_uri"] == (
        "eigen/dispersion.csv"
    )
    assert json.loads(zarr_sidecar.read_text(encoding="utf-8"))["artifact_uri"] == (
        "eigen/mode_fields.zarr"
    )

    record = json.loads(Path(result.production_record_path).read_text(encoding="utf-8"))
    assert record["promotion_decision"] == "blocked"
    assert record["open_blockers"]
    validate_production_record(record, tmp_path)


def test_writer_rejects_noncanonical_scope(tmp_path: Path) -> None:
    _write_fixture_artifacts(tmp_path)
    scope = valid_scope()
    scope["problem_scope"]["k_scope"] = {"kind": "invalid"}  # type: ignore[index]
    with pytest.raises(ValueError, match="scope"):
        write_validation_bundle(tmp_path, scope)


def test_writer_rejects_scope_for_wrong_production_lane(tmp_path: Path) -> None:
    _write_fixture_artifacts(tmp_path)
    with pytest.raises(ValueError, match="does not match the production lane"):
        write_validation_bundle(tmp_path, valid_scope(), expected_device="gpu")


def test_writer_rejects_declared_pass_without_execution_proof(tmp_path: Path) -> None:
    _write_fixture_artifacts(tmp_path)
    scope = valid_scope()
    gates: dict[str, object] = {}
    for index in range(1, 15):
        gate_id = f"DOD-{index:02d}"
        if gate_id == "DOD-12":
            gates[gate_id] = {
                "state": "not_applicable",
                "reason": "validated_scope.device=cpu excludes GPU",
            }
        else:
            gates[gate_id] = {
                "state": "pass",
                "evidence": ["frequency_domain/manifest.v1.json"],
                "fixture_ids": scope["fixture_ids"],
                "oracle_ids": scope["oracle_ids"],
                "metrics": {},
                "tolerances": {},
                "verifier": {"id": "test-verifier", "version": "v1", "result": "pass"},
            }
    evidence_manifest = tmp_path.parent / f"{tmp_path.name}-evidence.json"
    evidence_manifest.write_text(
        json.dumps(
            {
                "schema": "frequency_domain_production_evidence_manifest.v1",
                "validation_state_before_promotion": "physics_validated",
                "gates": gates,
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="missing required fields"):
        write_validation_bundle(
            tmp_path,
            scope,
            expected_device="cpu",
            evidence_manifest=evidence_manifest,
        )


def test_writer_promotes_only_from_complete_hashed_evidence_manifest(tmp_path: Path) -> None:
    _write_fixture_artifacts(tmp_path)
    scope = valid_scope()
    proof = _execution_proof(scope, tmp_path)
    gates: dict[str, object] = {}
    for index in range(1, 15):
        gate_id = f"DOD-{index:02d}"
        if gate_id == "DOD-12":
            gates[gate_id] = {
                "state": "not_applicable",
                "reason": "validated_scope.device=cpu excludes GPU",
            }
        else:
            gates[gate_id] = {
                "state": "pass",
                "evidence": ["frequency_domain/manifest.v1.json"],
                "fixture_ids": scope["fixture_ids"],
                "oracle_ids": scope["oracle_ids"],
                "metrics": {},
                "tolerances": {},
                "verifier": proof,
            }
    evidence_manifest = tmp_path.parent / f"{tmp_path.name}-evidence.json"
    evidence_manifest.write_text(
        json.dumps(
            {
                "schema": "frequency_domain_production_evidence_manifest.v1",
                "validation_state_before_promotion": "physics_validated",
                "gates": gates,
            }
        ),
        encoding="utf-8",
    )
    result = write_validation_bundle(
        tmp_path,
        scope,
        expected_device="cpu",
        evidence_manifest=evidence_manifest,
    )
    record = json.loads(Path(result.production_record_path).read_text(encoding="utf-8"))
    assert record["promotion_decision"] == "production_qualified"
    assert record["items"]["DOD-12"] == "not_applicable"
    validate_production_record(record, tmp_path)
