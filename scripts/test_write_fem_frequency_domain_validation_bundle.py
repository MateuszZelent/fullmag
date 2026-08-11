from __future__ import annotations

import hashlib
import json
import os
import sys
from copy import deepcopy
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from test_verify_fem_frequency_domain_production_dod import valid_scope  # noqa: E402
from verify_fem_frequency_domain_production_dod import (  # noqa: E402
    canonical_json_bytes,
    validate_production_record,
    validate_scope_catalog,
    scope_id_for,
)
from write_fem_frequency_domain_validation_bundle import (  # noqa: E402
    ingest_staged_evidence,
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


def test_writer_preserves_bytes_of_already_validated_json_evidence(tmp_path: Path) -> None:
    _write_fixture_artifacts(tmp_path)
    scope = valid_scope()
    scope_id = scope_id_for(scope)
    catalog = {
        "schema": "scope_catalog.v1",
        "scope_schema": "frequency_domain_validation_scope.v1",
        "scopes": {scope_id: scope},
    }
    binding = _direct_binding(scope_id, validate_scope_catalog(catalog))
    artifact = tmp_path / "eigen" / "spectrum.v2.json"
    value = json.loads(artifact.read_text(encoding="utf-8"))
    value["verified_coverage_of"] = binding
    artifact.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    revision_before = _sha256_path(artifact)

    write_validation_bundle(tmp_path, scope)

    assert _sha256_path(artifact) == revision_before


def test_writer_rejects_existing_json_binding_for_foreign_catalog(tmp_path: Path) -> None:
    _write_fixture_artifacts(tmp_path)
    scope = valid_scope()
    scope_id = scope_id_for(scope)
    artifact = tmp_path / "eigen" / "spectrum.v2.json"
    value = json.loads(artifact.read_text(encoding="utf-8"))
    value["verified_coverage_of"] = _direct_binding(scope_id, "sha256:" + "f" * 64)
    artifact.write_text(json.dumps(value), encoding="utf-8")

    with pytest.raises(ValueError, match="catalog digest"):
        write_validation_bundle(tmp_path, scope)


def _sha256_path(path: Path) -> str:
    if path.is_file():
        return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
    digest = hashlib.sha256()
    for child in sorted(item for item in path.rglob("*") if item.is_file()):
        relative = child.relative_to(path).as_posix().encode("utf-8")
        payload = child.read_bytes()
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        digest.update(len(payload).to_bytes(8, "big"))
        digest.update(payload)
    return "sha256:" + digest.hexdigest()


def _direct_binding(
    scope_id: str,
    catalog_sha256: str,
) -> dict[str, object]:
    return {
        "schema": "validation_scope_binding.v1",
        "scope_schema": "frequency_domain_validation_scope.v1",
        "kind": "direct",
        "scope_id": scope_id,
        "scope_catalog_uri": "validation/scopes/scope_catalog.v1.json",
        "scope_catalog_sha256": catalog_sha256,
    }


def _write_ingest_fixture(
    root: Path,
    *,
    scope: dict[str, object] | None = None,
    catalog: dict[str, object] | None = None,
    binding: dict[str, object] | None = None,
    include_zarr: bool = False,
) -> tuple[dict[str, object], dict[str, object], Path, Path, Path]:
    scope = valid_scope() if scope is None else scope
    scope_id = scope_id_for(scope)
    catalog = (
        {
            "schema": "scope_catalog.v1",
            "scope_schema": "frequency_domain_validation_scope.v1",
            "scopes": {scope_id: scope},
        }
        if catalog is None
        else catalog
    )
    catalog_sha256 = validate_scope_catalog(catalog)
    binding = _direct_binding(scope_id, catalog_sha256) if binding is None else binding
    staging = root / "staging"
    json_source = staging / "cpu" / "pre_release_regression.v1.json"
    json_source.parent.mkdir(parents=True)
    json_source.write_text(
        json.dumps(
            {
                "schema": "pre_release_regression.v1",
                "verified_coverage_of": binding,
                "result": "pass",
            }
        ),
        encoding="utf-8",
    )
    sources = [json_source]
    if include_zarr:
        zarr = staging / "cpu" / "mode_fields.zarr"
        (zarr / "sample-0000" / "mode-0000").mkdir(parents=True)
        (zarr / ".zgroup").write_text('{"zarr_format":2}\n', encoding="utf-8")
        (zarr / "sample-0000" / "mode-0000" / "0").write_bytes(b"mode-field")
        sources.append(zarr)

    artifacts: list[dict[str, object]] = []
    revisions: list[dict[str, str]] = []
    for source in sources:
        relative = source.relative_to(staging).as_posix()
        revision = _sha256_path(source)
        sidecar_path: str | None = None
        sidecar_sha256: str | None = None
        if source.is_dir():
            sidecar = source.with_name(source.name + ".validation_manifest.v1.json")
            sidecar.write_text(
                json.dumps(
                    {
                        "schema": "validation_artifact_manifest.v1",
                        "artifact_kind": "zarr",
                        "artifact_schema": "eigen_mode_fields_zarr.v1",
                        "artifact_uri": relative,
                        "zarr_tree_sha256": revision,
                        "verified_coverage_of": binding,
                    }
                ),
                encoding="utf-8",
            )
            sidecar_path = sidecar.relative_to(staging).as_posix()
            sidecar_sha256 = _sha256_path(sidecar)
        artifacts.append(
            {
                "path": relative,
                "sha256": revision,
                "size_bytes": (
                    len(source.read_bytes())
                    if source.is_file()
                    else sum(len(child.read_bytes()) for child in source.rglob("*") if child.is_file())
                ),
                "artifact_revision": revision,
                "producer_command": ["just", "verify-pre-release"],
                "producer_exit_code": 0,
                "scope_id": scope_id,
                "runtime_fullmag_commit": scope["runtime_scope"]["fullmag_commit"],
                "runtime_build_id": scope["runtime_scope"]["build_id"],
                "sidecar_path": sidecar_path,
                "sidecar_sha256": sidecar_sha256,
            }
        )
        revisions.append({"path": relative, "artifact_revision": revision})

    source_manifest = staging / "cpu" / "source_manifest.v1.json"
    source_manifest.write_text(
        json.dumps(
            {
                "schema": "frequency_domain_source_manifest.v1",
                "scope_id": scope_id,
                "runtime_fullmag_commit": scope["runtime_scope"]["fullmag_commit"],
                "runtime_build_id": scope["runtime_scope"]["build_id"],
                "artifacts": revisions,
                "verified_coverage_of": binding,
            }
        ),
        encoding="utf-8",
    )
    index: dict[str, object] = {
        "schema": "frequency_domain_staging_index.v1",
        "lane": "cpu",
        "scope_id": scope_id,
        "runtime_fullmag_commit": scope["runtime_scope"]["fullmag_commit"],
        "runtime_build_id": scope["runtime_scope"]["build_id"],
        "source_manifest_path": source_manifest.relative_to(staging).as_posix(),
        "source_manifest_sha256": _sha256_path(source_manifest),
        "artifacts": artifacts,
        "evidence_manifest": {
            "schema": "frequency_domain_production_evidence_manifest.v1",
            "validation_state_before_promotion": "physics_validated",
            "gates": {
                "DOD-14": {
                    "state": "pass",
                    "evidence": [artifact["path"] for artifact in artifacts],
                }
            },
        },
    }
    staging_index = staging / "cpu" / "staging_index.v1.json"
    staging_index.write_bytes(canonical_json_bytes(index))
    return scope, catalog, staging, staging_index, json_source


def _rewrite_index(path: Path, index: dict[str, object]) -> None:
    path.write_bytes(canonical_json_bytes(index))


def test_ingest_stages_json_and_zarr_without_publishing_release(tmp_path: Path) -> None:
    scope, catalog, staging, staging_index, json_source = _write_ingest_fixture(
        tmp_path,
        include_zarr=True,
    )
    requested_release = tmp_path / "final-cpu"

    result = ingest_staged_evidence(
        staging,
        staging_index,
        requested_release,
        scope,
        expected_device="cpu",
        scope_catalog=catalog,
    )

    prepublish = Path(result.prepublish_bundle_root)
    assert not requested_release.exists()
    assert prepublish.is_dir()
    assert prepublish.name.startswith(".final-cpu.prepublish-")
    copied_json = prepublish / "evidence" / "cpu" / json_source.name
    copied_zarr = prepublish / "evidence" / "cpu" / "mode_fields.zarr"
    assert copied_json.read_bytes() == json_source.read_bytes()
    assert copied_json.stat().st_nlink == 1
    assert copied_json.stat().st_ino != json_source.stat().st_ino
    assert (copied_zarr / "sample-0000" / "mode-0000" / "0").read_bytes() == b"mode-field"
    copied_sidecar = copied_zarr.with_name(copied_zarr.name + ".validation_manifest.v1.json")
    sidecar_value = json.loads(copied_sidecar.read_text(encoding="utf-8"))
    assert sidecar_value["artifact_uri"] == "evidence/cpu/mode_fields.zarr"
    assert sidecar_value["zarr_tree_sha256"] == _sha256_path(copied_zarr)
    evidence_manifest = json.loads(Path(result.evidence_manifest_path).read_text(encoding="utf-8"))
    assert evidence_manifest["gates"]["DOD-14"]["evidence"] == [
        "evidence/cpu/pre_release_regression.v1.json",
        "evidence/cpu/mode_fields.zarr",
    ]
    assert Path(result.source_manifest_path).is_file()


@pytest.mark.parametrize(
    ("binding_mutation", "message"),
    [
        (lambda value: value.pop("verified_coverage_of"), "verified_coverage_of"),
        (
            lambda value: value["verified_coverage_of"].pop("scope_catalog_sha256"),
            "missing required fields",
        ),
        (
            lambda value: value["verified_coverage_of"].__setitem__(
                "scope_catalog_sha256", "sha256:" + "f" * 64
            ),
            "catalog digest",
        ),
    ],
)
def test_ingest_rejects_missing_truncated_or_foreign_json_scope_binding(
    tmp_path: Path,
    binding_mutation: object,
    message: str,
) -> None:
    scope, catalog, staging, staging_index, json_source = _write_ingest_fixture(tmp_path)
    value = json.loads(json_source.read_text(encoding="utf-8"))
    binding_mutation(value)
    json_source.write_text(json.dumps(value), encoding="utf-8")
    index = json.loads(staging_index.read_text(encoding="utf-8"))
    revision = _sha256_path(json_source)
    index["artifacts"][0]["sha256"] = revision
    index["artifacts"][0]["size_bytes"] = len(json_source.read_bytes())
    index["artifacts"][0]["artifact_revision"] = revision
    source_manifest = staging / index["source_manifest_path"]
    source_value = json.loads(source_manifest.read_text(encoding="utf-8"))
    source_value["artifacts"][0]["artifact_revision"] = revision
    source_manifest.write_text(json.dumps(source_value), encoding="utf-8")
    index["source_manifest_sha256"] = _sha256_path(source_manifest)
    _rewrite_index(staging_index, index)

    with pytest.raises(ValueError, match=message):
        ingest_staged_evidence(
            staging,
            staging_index,
            tmp_path / "final-cpu",
            scope,
            expected_device="cpu",
            scope_catalog=catalog,
        )
    assert not (tmp_path / "final-cpu").exists()


def test_ingest_rejects_multi_scope_catalog_before_non_target_binding(
    tmp_path: Path,
) -> None:
    scope = valid_scope()
    other_scope = deepcopy(scope)
    other_scope["fixture_ids"] = [
        {"id": "fixture:k0:other", "version": "v1", "sha256": "sha256:" + "9" * 64}
    ]
    target_id = scope_id_for(scope)
    other_id = scope_id_for(other_scope)
    catalog = {
        "schema": "scope_catalog.v1",
        "scope_schema": "frequency_domain_validation_scope.v1",
        "scopes": {target_id: scope, other_id: other_scope},
    }
    binding = _direct_binding(other_id, validate_scope_catalog(catalog))
    scope, catalog, staging, staging_index, _ = _write_ingest_fixture(
        tmp_path,
        scope=scope,
        catalog=catalog,
        binding=binding,
    )

    with pytest.raises(ValueError, match="canonical single-scope catalog"):
        ingest_staged_evidence(
            staging,
            staging_index,
            tmp_path / "final-cpu",
            scope,
            expected_device="cpu",
            scope_catalog=catalog,
        )


def test_ingest_rejects_stale_artifact_revision_against_source_manifest(tmp_path: Path) -> None:
    scope, catalog, staging, staging_index, json_source = _write_ingest_fixture(tmp_path)
    json_source.write_text(json_source.read_text(encoding="utf-8") + "\n", encoding="utf-8")
    index = json.loads(staging_index.read_text(encoding="utf-8"))
    revision = _sha256_path(json_source)
    index["artifacts"][0]["sha256"] = revision
    index["artifacts"][0]["size_bytes"] = len(json_source.read_bytes())
    index["artifacts"][0]["artifact_revision"] = revision
    _rewrite_index(staging_index, index)

    with pytest.raises(ValueError, match="source manifest artifact revision"):
        ingest_staged_evidence(
            staging,
            staging_index,
            tmp_path / "final-cpu",
            scope,
            expected_device="cpu",
            scope_catalog=catalog,
        )


def test_ingest_rejects_missing_artifact_revision(tmp_path: Path) -> None:
    scope, catalog, staging, staging_index, _ = _write_ingest_fixture(tmp_path)
    index = json.loads(staging_index.read_text(encoding="utf-8"))
    index["artifacts"][0].pop("artifact_revision")
    _rewrite_index(staging_index, index)

    with pytest.raises(ValueError, match="closed object"):
        ingest_staged_evidence(
            staging,
            staging_index,
            tmp_path / "final-cpu",
            scope,
            expected_device="cpu",
            scope_catalog=catalog,
        )


def test_ingest_rejects_source_manifest_hash_mismatch(tmp_path: Path) -> None:
    scope, catalog, staging, staging_index, _ = _write_ingest_fixture(tmp_path)
    index = json.loads(staging_index.read_text(encoding="utf-8"))
    source_manifest = staging / index["source_manifest_path"]
    source_manifest.write_text(source_manifest.read_text(encoding="utf-8") + "\n", encoding="utf-8")

    with pytest.raises(ValueError, match="source manifest hash"):
        ingest_staged_evidence(
            staging,
            staging_index,
            tmp_path / "final-cpu",
            scope,
            expected_device="cpu",
            scope_catalog=catalog,
        )


@pytest.mark.parametrize("unsafe_kind", ["symlink", "hardlink"])
def test_ingest_rejects_unsafe_zarr_tree_entries(tmp_path: Path, unsafe_kind: str) -> None:
    scope, catalog, staging, staging_index, _ = _write_ingest_fixture(tmp_path, include_zarr=True)
    zarr = staging / "cpu" / "mode_fields.zarr"
    chunk = zarr / "sample-0000" / "mode-0000" / "0"
    unsafe = chunk.with_name("unsafe")
    if unsafe_kind == "symlink":
        unsafe.symlink_to(chunk)
    else:
        os.link(chunk, unsafe)

    with pytest.raises(ValueError, match=unsafe_kind):
        ingest_staged_evidence(
            staging,
            staging_index,
            tmp_path / "final-cpu",
            scope,
            expected_device="cpu",
            scope_catalog=catalog,
        )


def test_ingest_rejects_invalid_non_json_sidecar_before_staging(tmp_path: Path) -> None:
    scope, catalog, staging, staging_index, _ = _write_ingest_fixture(tmp_path, include_zarr=True)
    sidecar = staging / "cpu" / "mode_fields.zarr.validation_manifest.v1.json"
    sidecar.write_text("{}", encoding="utf-8")
    index = json.loads(staging_index.read_text(encoding="utf-8"))
    index["artifacts"][1]["sidecar_sha256"] = _sha256_path(sidecar)
    _rewrite_index(staging_index, index)

    with pytest.raises(ValueError, match="sidecar"):
        ingest_staged_evidence(
            staging,
            staging_index,
            tmp_path / "final-cpu",
            scope,
            expected_device="cpu",
            scope_catalog=catalog,
        )
    assert not (tmp_path / "final-cpu").exists()


@pytest.mark.parametrize("overlap_kind", ["nested_json", "zarr_sidecar"])
def test_ingest_rejects_artifacts_owned_by_zarr(
    tmp_path: Path,
    overlap_kind: str,
) -> None:
    scope, catalog, staging, staging_index, _ = _write_ingest_fixture(
        tmp_path,
        include_zarr=True,
    )
    index = json.loads(staging_index.read_text(encoding="utf-8"))
    source_manifest = staging / index["source_manifest_path"]
    source_value = json.loads(source_manifest.read_text(encoding="utf-8"))
    zarr = staging / "cpu" / "mode_fields.zarr"
    if overlap_kind == "nested_json":
        overlapping_artifact = zarr / "metadata.json"
        overlapping_artifact.write_text(
            json.dumps(
                {
                    "schema": "zarr_metadata.v1",
                    "verified_coverage_of": _direct_binding(
                        scope_id_for(scope),
                        validate_scope_catalog(catalog),
                    ),
                }
            ),
            encoding="utf-8",
        )
        zarr_revision = _sha256_path(zarr)
        index["artifacts"][1]["sha256"] = zarr_revision
        index["artifacts"][1]["size_bytes"] = sum(
            len(child.read_bytes()) for child in zarr.rglob("*") if child.is_file()
        )
        index["artifacts"][1]["artifact_revision"] = zarr_revision
        source_value["artifacts"][1]["artifact_revision"] = zarr_revision
        zarr_sidecar = zarr.with_name(
            zarr.name + ".validation_manifest.v1.json"
        )
        sidecar_value = json.loads(zarr_sidecar.read_text(encoding="utf-8"))
        sidecar_value["zarr_tree_sha256"] = zarr_revision
        zarr_sidecar.write_text(json.dumps(sidecar_value), encoding="utf-8")
        index["artifacts"][1]["sidecar_sha256"] = _sha256_path(zarr_sidecar)
    else:
        overlapping_artifact = zarr.with_name(
            zarr.name + ".validation_manifest.v1.json"
        )
    relative = overlapping_artifact.relative_to(staging).as_posix()
    revision = _sha256_path(overlapping_artifact)
    overlapping_entry = deepcopy(index["artifacts"][0])
    overlapping_entry.update(
        {
            "path": relative,
            "sha256": revision,
            "size_bytes": len(overlapping_artifact.read_bytes()),
            "artifact_revision": revision,
        }
    )
    index["artifacts"].append(overlapping_entry)
    source_value["artifacts"].append(
        {"path": relative, "artifact_revision": revision}
    )
    source_manifest.write_text(json.dumps(source_value), encoding="utf-8")
    index["source_manifest_sha256"] = _sha256_path(source_manifest)
    _rewrite_index(staging_index, index)
    requested_release = tmp_path / "final-cpu"

    with pytest.raises(ValueError, match="path ownership"):
        ingest_staged_evidence(
            staging,
            staging_index,
            requested_release,
            scope,
            expected_device="cpu",
            scope_catalog=catalog,
        )
    assert not requested_release.exists()
    assert not list(tmp_path.glob(".final-cpu.prepublish-*"))


def test_ingest_rejects_multi_scope_catalog_before_copy(tmp_path: Path) -> None:
    scope = valid_scope()
    other_scope = deepcopy(scope)
    other_scope["fixture_ids"] = [
        {"id": "fixture:k0:other", "version": "v1", "sha256": "sha256:" + "9" * 64}
    ]
    scope_id = scope_id_for(scope)
    other_scope_id = scope_id_for(other_scope)
    catalog = {
        "schema": "scope_catalog.v1",
        "scope_schema": "frequency_domain_validation_scope.v1",
        "scopes": {scope_id: scope, other_scope_id: other_scope},
    }
    binding = _direct_binding(scope_id, validate_scope_catalog(catalog))
    scope, catalog, staging, staging_index, _ = _write_ingest_fixture(
        tmp_path,
        scope=scope,
        catalog=catalog,
        binding=binding,
    )
    requested_release = tmp_path / "final-cpu"

    with pytest.raises(ValueError, match="canonical single-scope catalog"):
        ingest_staged_evidence(
            staging,
            staging_index,
            requested_release,
            scope,
            expected_device="cpu",
            scope_catalog=catalog,
        )
    assert not requested_release.exists()
    assert not list(tmp_path.glob(".final-cpu.prepublish-*"))


def test_single_scope_ingest_chains_into_writer(tmp_path: Path) -> None:
    scope, catalog, staging, staging_index, _ = _write_ingest_fixture(tmp_path)
    result = ingest_staged_evidence(
        staging,
        staging_index,
        tmp_path / "final-cpu",
        scope,
        expected_device="cpu",
        scope_catalog=catalog,
    )
    prepublish = Path(result.prepublish_bundle_root)
    manifest = prepublish / "frequency_domain" / "manifest.v1.json"
    manifest.parent.mkdir(parents=True)
    manifest.write_text(
        json.dumps(
            {
                "schema_version": "frequency_domain_manifest.v1",
                "implementation_state": "executable",
                "validation_state": "unvalidated",
            }
        ),
        encoding="utf-8",
    )

    writer_result = write_validation_bundle(prepublish, scope)

    assert writer_result.catalog_sha256 == validate_scope_catalog(catalog)
