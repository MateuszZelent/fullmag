"""Interpreted regressions for signed-fifteen serial/adaptive campaign parity."""

from __future__ import annotations

import csv
import hashlib
import json
import struct
from pathlib import Path

import pytest

import plot_signed_de_campaign as plotting
from fem_linearization_identity_replay import IDENTITY_FIELDS
from fem_equilibrium_field_replay import recomputed_fem_equilibrium_content_sha256
from fem_equilibrium_identity_replay import (
    BOUNDARY_NAMESPACE,
    MATERIAL_V1_NAMESPACE,
    STATIC_PHYSICS_NAMESPACE,
    framed_digest,
    raw_material_digest,
)
from verify_fem_frequency_domain_eigen_artifacts import (
    equilibrium_artifact_v7_digest,
    linearization_state_v7_digest,
)
from test_plot_signed_de_campaign import (
    MODEL_SHA,
    _write_batch,
    _write_runtime_evidence,
)
from test_validate_parallel_execution_report import ADMISSION_JOURNAL_SCHEMA, _event

import validate_signed_de_campaign_parity as parity


SOURCE_SNAPSHOT = "a" * 64
SOURCE_DIGEST = "c" * 64
SOURCE_COMMIT = "d" * 40
MODEL_SOURCE_COMMIT = "e" * 40
RUNTIME_IMAGE = "sha256:" + "f" * 64
PLAN_SHA = "sha256:" + "1" * 64
RESIDUAL = 2.0e-12


def _sha(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, separators=(",", ":")), encoding="utf-8")


def _read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _canonical_preimage(payload: dict, namespace: str | None) -> tuple[str, str]:
    text = json.dumps(payload, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    raw = text.encode("utf-8")
    digest = framed_digest(namespace, raw) if namespace else raw_material_digest(raw)
    return text, digest


def _pack_identity(identity: dict) -> tuple[dict, dict]:
    preimage = dict(identity)
    preimage["content_sha256"] = ""
    preimage_json = json.dumps(preimage, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    preimage_bytes = preimage_json.encode("utf-8")
    framed = b"linearization_identity.v2\0" + struct.pack("<Q", len(preimage_bytes)) + preimage_bytes
    packed = dict(identity)
    packed["content_sha256"] = "sha256:" + hashlib.sha256(framed).hexdigest()
    sidecar = {
        "schema_version": "linearization_identity_preimage.v1",
        "identity_schema": "linearization_identity.v2",
        "identity_preimage_json": preimage_json,
        "identity_preimage_sha256": "sha256:" + hashlib.sha256(preimage_bytes).hexdigest(),
        "identity_content_sha256": packed["content_sha256"],
    }
    return packed, sidecar


def _write_replayable_identity(index: int, run_id: str, eq_sha: str, state_sha: str, m0: list[list[float]]) -> dict:
    identity = {}
    for name in IDENTITY_FIELDS:
        if name == "sample_index":
            identity[name] = index
        elif name == "node_count":
            identity[name] = 1
        elif name in {"producer_build_identity", "consumer_build_identity"}:
            identity[name] = {"source_snapshot_sha256": SOURCE_SNAPSHOT, "profile": "fem-cpu"}
        elif name in {"producer_source_snapshot_sha256", "consumer_source_snapshot_sha256"}:
            identity[name] = SOURCE_SNAPSHOT
        elif name == "schema_version":
            identity[name] = "linearization_identity.v2"
        elif name == "content_sha256":
            identity[name] = ""
        elif name.endswith("_sha256"):
            identity[name] = _sha(f"{name}:sample-{index}")
        else:
            identity[name] = f"{name}:stable"

    equilibrium_material_preimage = {
        "schema_version": MATERIAL_V1_NAMESPACE,
        "saturation_magnetisation_a_per_m": 800_000.0,
        "exchange_stiffness_j_per_m": 1.3e-11,
        "saturation_magnetisation_field_a_per_m": None,
        "exchange_stiffness_field_j_per_m": None,
    }
    static_physics_preimage = {
        "schema_version": STATIC_PHYSICS_NAMESPACE,
        "enable_exchange": True,
        "enable_demag": True,
        "external_field_a_per_m": [0.0, 0.0, 0.0],
    }
    boundary_preimage = {
        "schema_version": BOUNDARY_NAMESPACE,
        "exchange_bc": "neumann",
        "demag_realization": None,
        "air_box_config": None,
        "periodic_node_pairs": [],
        "periodic_boundary_pairs": [],
    }
    raw_material_preimage = {
        "name": "signed15-material",
        "saturation_magnetisation": 800_000.0,
        "exchange_stiffness": 1.3e-11,
        "damping": 0.01,
        "uniaxial_anisotropy": None,
        "anisotropy_axis": None,
    }
    eq_material_json, eq_material_sha = _canonical_preimage(
        equilibrium_material_preimage, MATERIAL_V1_NAMESPACE
    )
    static_json, static_sha = _canonical_preimage(static_physics_preimage, STATIC_PHYSICS_NAMESPACE)
    boundary_json, boundary_sha = _canonical_preimage(boundary_preimage, BOUNDARY_NAMESPACE)
    raw_material_json, raw_material_sha = _canonical_preimage(raw_material_preimage, None)
    stable = {
        "equilibrium_artifact_schema": "equilibrium_artifact.v7",
        "linearization_state_schema": "LinearizationState.v6",
        "accepted_fields_schema": "accepted_fem_equilibrium_fields.v3",
        "certified_fields_schema": "certified_fem_equilibrium_fields.v3",
        "recomputed_certificate_schema": "fem_equilibrium_acceptance_certificate.v2",
        "handoff_schema_version": "fem_relax_to_eigen_handoff.v2",
        "cross_build_policy": "same_source_snapshot_required",
        "source_mesh_topology_sha256": _sha("shared-source-mesh"),
        "modal_mesh_topology_fingerprint_v3": _sha("shared-modal-mesh"),
        "equilibrium_material_signature": eq_material_sha,
        "equilibrium_material_preimage_json": eq_material_json,
        "equilibrium_static_physics_signature": static_sha,
        "equilibrium_static_physics_preimage_json": static_json,
        "equilibrium_boundary_signature": boundary_sha,
        "equilibrium_boundary_preimage_json": boundary_json,
        "material_signature": _sha("shared-material"),
        "material_identity_kind": "canonical_material_identity",
        "material_provenance_signature": raw_material_sha,
        "material_provenance_scope": "model",
        "material_provenance_preimage_json": raw_material_json,
        "producer_material_provenance_signature": raw_material_sha,
        "producer_material_provenance_preimage_json": raw_material_json,
        "equilibrium_artifact_sha256": eq_sha,
        "equilibrium_content_sha256": recomputed_fem_equilibrium_content_sha256(m0),
        "linearization_state_sha256": state_sha,
        "equilibrium_artifact_path": f"eigen/metadata/sample_{index:04d}/equilibrium_artifact.v7.json",
        "linearization_state_path": f"eigen/metadata/sample_{index:04d}/linearization_state.v6.json",
        "source_run_id": run_id,
        "source_stage_id": f"stage-{run_id}",
        "producer_plan_snapshot_sha256": _sha("stable-producer-plan"),
        "consumer_plan_snapshot_sha256": PLAN_SHA,
    }
    identity.update(stable)
    return _pack_identity(identity)


def _pool_journal(mode: str, equilibrium_by_sample: dict[int, str], *, overlap: bool = True) -> dict:
    indices = list(range(1, 15))
    report = {
        "protocol": "fullmag.eigen_k_worker.v1",
        "requested_mode": mode,
        "resolved_mode": "adaptive_processes" if mode == "adaptive" else "serial_processes",
        "resolved_workers": 2 if mode == "adaptive" else 1,
        "policy": {"mode": mode, **plotting.EXPECTED_POLICY},
        "inputs": [
            {
                "sample_index": index,
                "plan_sha256": PLAN_SHA,
                "equilibrium_artifact_sha256": equilibrium_by_sample[index],
            }
            for index in indices
        ],
        "thread_bindings": [
            {
                "sample_index": index,
                "budget": {
                    "requested_threads": 1,
                    "resolved_threads": 1,
                    "cap_reason": "parent_admission_requested_threads",
                    "allocation_cpu_cores": 8.0,
                    "host_cpu_cores": 8,
                },
            }
            for index in indices
        ],
        "cpu_observations": [
            {
                "sample_index": index,
                "valid_intervals": 4,
                "observed_seconds": 1.25,
                "demand_source": "periodic_peak_with_terminal_average",
                "sampled_peak_cpu_cores": 1.25,
                "terminal_average_cpu_cores": 0.75,
                "resolved_threads": 1,
                "demand_cpu_cores": 1.25,
            }
            for index in indices
        ] if mode == "adaptive" else [],
        "worker_logs": [
            {
                "sample_index": index,
                "stdout_path": f"/managed/{mode}/{index}/stdout.log",
                "stderr_path": f"/managed/{mode}/{index}/stderr.log",
                "handshake_path": f"/managed/{mode}/{index}/handshake.json",
                "worker_executable_sha256": _sha("worker-build"),
                "worker_build_identity": {"profile": "fem-cpu-runtime-v2"},
            }
            for index in indices
        ],
        "events": (
            [
                _event(1_700_000_000_000, 0),
                _event(1_700_000_000_100, 1),
                *([_event(1_700_000_000_200, 2, peak_cpu=2.0)] if overlap else []),
                _event(1_700_000_000_300, 1),
                _event(1_700_000_000_400, 0),
            ]
            if mode == "adaptive" else []
        ),
        "events_truncated": False,
        "telemetry_reason": None,
    }
    return {
        "schema_version": ADMISSION_JOURNAL_SCHEMA,
        "terminal_state": "completed",
        "events_truncated": False,
        "report": report,
    }


def _refresh_catalog(batch: Path) -> None:
    result_path = batch / "run-result.json"
    result = _read_json(result_path)
    binding = {}
    case = Path(result["runtime_output_binding"]["artifact_dir"])
    for path in sorted(case.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        relative = path.relative_to(case).as_posix()
        raw = path.read_bytes()
        binding[relative] = {"size": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
    result["artifacts"]["required_artifact_hashes"] = binding
    _write_json(result_path, result)


def _write_native_artifacts(
    case: Path,
    run_id: str,
    *,
    frequency_delta: dict[int, float] | None = None,
    residuals: dict[int, float] | None = None,
    m0_overrides: dict[int, list[list[float]]] | None = None,
) -> dict[int, str]:
    frequency_delta = frequency_delta or {}
    residuals = residuals or {}
    m0_overrides = m0_overrides or {}
    k_values = plotting.EXPECTED_K_RAD_PER_M
    frequencies = {index: 10.0e9 + index * 1.0e8 + frequency_delta.get(index, 0.0)
                   for index in range(15)}
    csv_path = case / "eigen" / "dispersion.csv"
    with csv_path.open("r", encoding="utf-8", newline="") as stream:
        rows = list(csv.DictReader(stream))
        fieldnames = list(rows[0])
    for index, row in enumerate(rows):
        row["frequency_hz"] = str(frequencies[index])
    with csv_path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    eq_hashes: dict[int, str] = {}
    native_samples = []
    native_map = {}
    for index, k_value in enumerate(k_values):
        mesh_sha = _sha("shared-modal-mesh")
        periodic_sha = _sha("shared-periodic-certificate")
        phase_sha = _sha(f"phase-constraint:{index}")
        m0 = m0_overrides.get(index, [[1.0, 0.0, 0.0]])
        sample_dir = case / "eigen" / "metadata" / f"sample_{index:04d}"
        equilibrium = {
            "schema_version": "equilibrium_artifact.v7",
            "content_sha256": "",
            "equilibrium_id": "",
            "producer_run_id": run_id,
            "material_signature": _sha("shared-material"),
            # These sidecar signatures are the legacy payload hash forms and
            # intentionally differ from the canonical identity-v2 signatures.
            "physics_signature": _sha("legacy-physics-payload"),
            "boundary_signature": _sha("legacy-boundary-payload"),
            "static_demag_signature": _sha("static-demag-payload"),
            "m0": m0,
            "periodic_mesh_certificate": {"content_sha256": periodic_sha},
        }
        eq_sha = equilibrium_artifact_v7_digest(equilibrium)
        equilibrium["content_sha256"] = eq_sha
        equilibrium["equilibrium_id"] = f"equilibrium_artifact.v7:{eq_sha.removeprefix('sha256:')}"

        state = {
            "schema_version": "LinearizationState.v6",
            "content_sha256": "",
            "linearization_state_id": "",
            "accepted_for_frequency_operator": True,
            "producer_run_id": run_id,
            "equilibrium_artifact_sha256": eq_sha,
            "source_equilibrium_artifact": eq_sha,
            "source_equilibrium_id": equilibrium["equilibrium_id"],
        }
        state_sha = linearization_state_v7_digest(state)
        state["content_sha256"] = state_sha
        state["linearization_state_id"] = f"LinearizationState.v6:{state_sha.removeprefix('sha256:')}"
        operator_sha = _sha(f"operator-input:{eq_sha}:{state_sha}:{index}")

        identity, preimage = _write_replayable_identity(index, run_id, eq_sha, state_sha, m0)
        _write_json(sample_dir / "equilibrium_artifact.v7.json", equilibrium)
        eq_hashes[index] = "sha256:" + hashlib.sha256(
            (sample_dir / "equilibrium_artifact.v7.json").read_bytes()
        ).hexdigest()
        _write_json(sample_dir / "linearization_state.v6.json", state)
        _write_json(sample_dir / "linearization_identity.v2.json", identity)
        _write_json(sample_dir / "linearization_identity_preimage.v1.json", preimage)
        native_map[str(index)] = {
            "source_mesh_topology_sha256": mesh_sha,
            "periodic_mesh_certificate_sha256": periodic_sha,
            "operator_input_signature_sha256": operator_sha,
            "phase_constraint_sha256": phase_sha,
            "equilibrium_artifact_sha256": eq_sha,
            "linearization_state_sha256": state_sha,
            "linearization_identity_sha256": identity["content_sha256"],
            "operator_dictionary_version": "FrequencyOperatorDictionary.v1",
            "implementation_state": "executable",
        }
        r = residuals.get(index, RESIDUAL)
        mode = {
            "sample_index": index,
            "raw_mode_index": 0,
            "assembly_kind": "mfem_weak_form_shared_domain",
            "frequency_hz": frequencies[index],
            "residual_relative_l2": r,
            "k_vector": [0.0, k_value, 0.0],
            "source_mesh_topology_sha256": mesh_sha,
            "periodic_mesh_certificate_sha256": periodic_sha,
            "operator_input_signature_sha256": operator_sha,
            "phase_constraint_sha256": phase_sha,
            "equilibrium_artifact_sha256": eq_sha,
            "linearization_state_sha256": state_sha,
            "block_residuals": {
                "scope": "native_descriptor",
                "certified": True,
                "eps_q": r,
                "eps_phi": r,
                "eps_gauge": r,
                "eps_full": r,
                "certification_tolerance": 1.0e-6,
                "full_descriptor_certified": True,
            },
        }
        native_samples.append({"sample_index": index, "modes": [mode]})

    _write_json(case / "eigen" / "spectrum.v3.json", {
        "schema_version": "eigen_spectrum.v3",
        "sample_count": 15,
        "samples": native_samples,
    })
    _write_json(case / "frequency_domain" / "manifest.v1.json", {
        "schema_version": "fullmag.frequency_domain_manifest.v1",
        "operator_dictionary_version": "FrequencyOperatorDictionary.v1",
        "physics_contract_version": "micromagnetics_frequency_domain_v5",
        "periodic_mesh_certificate_sha256": _sha("shared-periodic-certificate"),
        "native_provenance_by_sample": native_map,
    })
    return eq_hashes


def _write_campaign(
    parent: Path,
    mode: str,
    run_id: str,
    *,
    report: bool = True,
    report_overlap: bool = True,
    report_indices: list[int] | None = None,
    frequency_delta: dict[int, float] | None = None,
    residuals: dict[int, float] | None = None,
    m0_overrides: dict[int, list[list[float]]] | None = None,
) -> Path:
    batch = _write_batch(parent / mode)
    original = batch / f"{plotting.PILOT}-run-session-17-0"
    workspace = batch / f"{plotting.PILOT}-{run_id}-0"
    original.rename(workspace)
    case = workspace / "artifacts"

    request_path = batch / "run-request.json"
    result_path = batch / "run-result.json"
    request = _read_json(request_path)
    result = _read_json(result_path)
    job_id = hashlib.sha256(run_id.encode()).hexdigest()[:32]
    for value in (request, result):
        value["job"]["job_id"] = job_id
        value["parallel_campaign"]["mode"] = mode
        value["runtime"] = {
            "artifact_root": "build-run/artifacts/outputs/.fullmag/local",
            "backend": "fem",
            "device": "cpu",
            "image_digest": RUNTIME_IMAGE,
            "mode": "strict",
            "precision": "double",
            "slepc": True,
        }
        value["source"]["capsule_relative"] = f"runs/campaign-source/{run_id}/source"
        value["source"]["source_snapshot_sha256"] = SOURCE_SNAPSHOT
    request["orchestrator_sha256"] = hashlib.sha256(b"same-orchestrator").hexdigest()
    request["job"]["source_digest"] = SOURCE_DIGEST
    result["job"]["source_digest"] = SOURCE_DIGEST

    metadata_path = case / "metadata.json"
    metadata = _read_json(metadata_path)
    runtime_metadata = metadata["problem_meta"]["runtime_metadata"]
    runtime_metadata["producer_run_id"] = run_id
    runtime_metadata["runtime_selection"] = {
        "backend": "fem",
        "device": "cpu",
        "execution_mode": "strict",
        "execution_precision": "double",
        "parallel_execution": {"mode": mode, **plotting.EXPECTED_POLICY},
    }
    _write_json(metadata_path, metadata)
    _write_runtime_evidence(batch, workspace, run_id, f"session-{run_id}")

    eq_hashes = _write_native_artifacts(
        case, run_id, frequency_delta=frequency_delta, residuals=residuals,
        m0_overrides=m0_overrides,
    )
    if report:
        journal = _pool_journal(mode, eq_hashes)
        if report_indices is not None:
            inputs = journal["report"]["inputs"]
            by_index = {item["sample_index"]: item for item in inputs}
            journal["report"]["inputs"] = [
                by_index[index] if index in by_index else {**inputs[0], "sample_index": index}
                for index in report_indices
            ]
        if mode == "adaptive" and not report_overlap:
            journal = _pool_journal(mode, eq_hashes, overlap=False)
        _write_json(case / "eigen" / "parallel_execution.v1.json", journal)
    _, runtime_binding = plotting.resolve_runtime_artifact_root(
        batch.resolve(), plotting.PILOT, MODEL_SHA
    )
    result["runtime_output_binding"] = runtime_binding
    result["artifacts"] = {"case": plotting.PILOT, "required_artifact_hashes": {}}
    _write_json(request_path, request)
    _write_json(result_path, result)
    _refresh_catalog(batch)
    return batch


@pytest.fixture
def valid_pair(tmp_path, monkeypatch):
    monkeypatch.setattr(
        plotting, "validate_rows",
        lambda *args, **kwargs: {"status": "pass", "sampling": "signed-fifteen", "sample_count": 15},
    )
    serial = _write_campaign(tmp_path, "serial", "run-serial-01", report=False)
    adaptive = _write_campaign(tmp_path, "adaptive", "run-adaptive-01")
    return serial, adaptive


def _update_catalog(batch: Path) -> None:
    _refresh_catalog(batch)


def _artifact_case(batch: Path) -> Path:
    result = _read_json(batch / "run-result.json")
    return Path(result["runtime_output_binding"]["artifact_dir"])


def test_genuine_fifteen_point_campaigns_require_operator_projection_for_lineage_differences(valid_pair):
    serial, adaptive = valid_pair
    serial_case = _artifact_case(serial)
    adaptive_case = _artifact_case(adaptive)
    serial_identity = _read_json(serial_case / "eigen/metadata/sample_0000/linearization_identity.v2.json")
    adaptive_identity = _read_json(adaptive_case / "eigen/metadata/sample_0000/linearization_identity.v2.json")
    serial_equilibrium = _read_json(serial_case / "eigen/metadata/sample_0000/equilibrium_artifact.v7.json")
    serial_spectrum = _read_json(serial_case / "eigen/spectrum.v3.json")
    adaptive_spectrum = _read_json(adaptive_case / "eigen/spectrum.v3.json")
    assert serial_identity["content_sha256"] != adaptive_identity["content_sha256"]
    assert serial_identity["equilibrium_static_physics_signature"] != serial_equilibrium["physics_signature"]
    assert serial_identity["equilibrium_boundary_signature"] != serial_equilibrium["boundary_signature"]
    assert _sha("run-serial-01") != _sha("run-adaptive-01")
    assert (
        serial_spectrum["samples"][0]["modes"][0]["operator_input_signature_sha256"]
        != adaptive_spectrum["samples"][0]["modes"][0]["operator_input_signature_sha256"]
    )

    result = parity.validate_signed_de_campaign_parity(serial, adaptive)

    assert result["status"] == "not_verified"
    assert result["qualification"] == "NOT VERIFIED"
    assert result["numeric_parity"]["sample_count"] == 15
    assert result["scheduler"]["sample_zero_seed_outside_pool"] is True
    assert result["scheduler"]["adaptive"]["sample_indices"] == list(range(1, 15))
    assert result["scheduler"]["adaptive"]["concurrency"]["status"] == "observed_from_active_count"
    assert result["immutable_inputs"]["status"] == "pass"
    assert "runtime.image_digest" in result["immutable_inputs"]["fields_compared"]
    assert result["native_identity"]["campaign_artifact_bindings"]["serial"]["sample_sidecars"]["14"]
    assert result["native_identity"]["operator_input_cross_run"]["status"] == "not_verified"
    assert result["native_identity"]["operator_input_cross_run"]["mismatching_sample_count"] == 15
    assert result["native_identity"]["operator_input_cross_run"]["different_digest_is_not_a_physical_mismatch_claim"] is True


def test_canonical_identity_preimages_are_replayed_after_outer_rebinding(valid_pair):
    serial, adaptive = valid_pair
    case = _artifact_case(adaptive)
    sample_index = 5
    identity_path = case / f"eigen/metadata/sample_{sample_index:04d}/linearization_identity.v2.json"
    preimage_path = case / f"eigen/metadata/sample_{sample_index:04d}/linearization_identity_preimage.v1.json"
    identity = _read_json(identity_path)
    identity["equilibrium_static_physics_signature"] = _sha("rebound-but-invalid-static-physics")
    identity, preimage = _pack_identity(identity)
    _write_json(identity_path, identity)
    _write_json(preimage_path, preimage)

    spectrum_path = case / "eigen/spectrum.v3.json"
    spectrum = _read_json(spectrum_path)
    spectrum["samples"][sample_index]["modes"][0]["linearization_identity_sha256"] = identity["content_sha256"]
    _write_json(spectrum_path, spectrum)
    manifest_path = case / "frequency_domain/manifest.v1.json"
    manifest = _read_json(manifest_path)
    manifest["native_provenance_by_sample"][str(sample_index)]["linearization_identity_sha256"] = identity["content_sha256"]
    _write_json(manifest_path, manifest)
    _update_catalog(adaptive)

    with pytest.raises(parity.ValidationError, match="canonical equilibrium identity preimage replay failed"):
        parity.validate_signed_de_campaign_parity(serial, adaptive)


def test_equilibrium_semantic_digest_is_recomputed_after_raw_rebinding(valid_pair):
    serial, adaptive = valid_pair
    case = _artifact_case(adaptive)
    artifact_path = case / "eigen/metadata/sample_0007/equilibrium_artifact.v7.json"
    equilibrium = _read_json(artifact_path)
    equilibrium["static_demag_signature"] = _sha("tampered-but-rebound-payload")
    _write_json(artifact_path, equilibrium)
    _update_catalog(adaptive)

    with pytest.raises(parity.ValidationError, match="equilibrium artifact semantic content digest differs"):
        parity.validate_signed_de_campaign_parity(serial, adaptive)


def test_linearization_state_semantic_digest_is_recomputed_after_raw_rebinding(valid_pair):
    serial, adaptive = valid_pair
    case = _artifact_case(adaptive)
    state_path = case / "eigen/metadata/sample_0008/linearization_state.v6.json"
    state = _read_json(state_path)
    state["producer_run_id"] = "rebound-but-undeclared-state-change"
    _write_json(state_path, state)
    _update_catalog(adaptive)

    with pytest.raises(parity.ValidationError, match="linearization state semantic content digest differs"):
        parity.validate_signed_de_campaign_parity(serial, adaptive)


def test_missing_native_identity_reports_not_verified(valid_pair):
    serial, adaptive = valid_pair
    case = _artifact_case(adaptive)
    (case / "eigen/metadata/sample_0004/linearization_identity.v2.json").unlink()
    _update_catalog(adaptive)

    result = parity.validate_signed_de_campaign_parity(serial, adaptive)

    assert result["status"] == "not_verified"
    assert "sample_0004" in result["native_identity"]["reason"]


def test_stable_physical_identity_mismatch_is_rejected(tmp_path, monkeypatch):
    monkeypatch.setattr(plotting, "validate_rows", lambda *args, **kwargs: {"status": "pass"})
    serial = _write_campaign(tmp_path, "serial", "run-serial-02", report=False)
    adaptive = _write_campaign(
        tmp_path, "adaptive", "run-adaptive-02",
        m0_overrides={6: [[0.0, 1.0, 0.0]]},
    )

    with pytest.raises(parity.ValidationError, match="source M0"):
        parity.validate_signed_de_campaign_parity(serial, adaptive)


def test_duplicate_native_spectrum_sample_is_rejected(valid_pair):
    serial, adaptive = valid_pair
    spectrum_path = _artifact_case(adaptive) / "eigen/spectrum.v3.json"
    spectrum = _read_json(spectrum_path)
    spectrum["samples"][1]["sample_index"] = 0
    _write_json(spectrum_path, spectrum)
    _update_catalog(adaptive)

    with pytest.raises(parity.ValidationError, match="duplicate sample"):
        parity.validate_signed_de_campaign_parity(serial, adaptive)


def test_spectrum_mesh_identity_must_bind_to_modal_topology(valid_pair):
    serial, adaptive = valid_pair
    case = _artifact_case(adaptive)
    spectrum_path = case / "eigen/spectrum.v3.json"
    spectrum = _read_json(spectrum_path)
    manifest_path = case / "frequency_domain/manifest.v1.json"
    manifest = _read_json(manifest_path)
    replacement = _sha("different-modal-mesh")
    spectrum["samples"][5]["modes"][0]["source_mesh_topology_sha256"] = replacement
    manifest["native_provenance_by_sample"]["5"]["source_mesh_topology_sha256"] = replacement
    _write_json(spectrum_path, spectrum)
    _write_json(manifest_path, manifest)
    _update_catalog(adaptive)

    with pytest.raises(parity.ValidationError, match="differs from modal mesh identity"):
        parity.validate_signed_de_campaign_parity(serial, adaptive)


def test_mutated_m0_requires_semantic_artifact_digest_replay(valid_pair):
    serial, adaptive = valid_pair
    sample_path = _artifact_case(adaptive) / "eigen/metadata/sample_0006/equilibrium_artifact.v7.json"
    equilibrium = _read_json(sample_path)
    equilibrium["m0"] = [[0.0, 1.0, 0.0]]
    _write_json(sample_path, equilibrium)
    _update_catalog(adaptive)

    with pytest.raises(parity.ValidationError, match="equilibrium artifact semantic content digest differs"):
        parity.validate_signed_de_campaign_parity(serial, adaptive)


def test_report_artifact_hash_and_size_binding_is_enforced(valid_pair):
    serial, adaptive = valid_pair
    report_path = _artifact_case(adaptive) / "eigen/parallel_execution.v1.json"
    journal = _read_json(report_path)
    journal["report"]["policy"]["threads_per_worker"] = 2
    _write_json(report_path, journal)

    with pytest.raises(parity.ValidationError, match="artifact hash or size"):
        parity.validate_signed_de_campaign_parity(serial, adaptive)


def test_adaptive_coactivity_is_required_and_not_inferred_from_worker_count(tmp_path, monkeypatch):
    monkeypatch.setattr(plotting, "validate_rows", lambda *args, **kwargs: {"status": "pass"})
    serial = _write_campaign(tmp_path, "serial", "run-serial-03", report=False)
    adaptive = _write_campaign(
        tmp_path, "adaptive", "run-adaptive-03", report_overlap=False,
    )

    result = parity.validate_signed_de_campaign_parity(serial, adaptive)

    assert result["status"] == "not_verified"
    assert result["scheduler"]["adaptive"]["concurrency"]["status"] == "not_verified"


@pytest.mark.parametrize("report_indices", [[*range(1, 15), 0], list(range(14))])
def test_adaptive_scheduler_must_exclude_seed_and_cover_exactly_one_through_fourteen(tmp_path, monkeypatch, report_indices):
    monkeypatch.setattr(plotting, "validate_rows", lambda *args, **kwargs: {"status": "pass"})
    serial = _write_campaign(tmp_path, "serial", "run-serial-04", report=False)
    adaptive = _write_campaign(
        tmp_path, "adaptive", "run-adaptive-04",
        report_indices=report_indices if len(report_indices) == 15 else None,
    )
    if len(report_indices) == 14:
        # Keep the report internally consistent so the signed-campaign seed
        # guard, rather than a generic cross-table error, rejects samples 0..13.
        def shift_sample_indices(value):
            if isinstance(value, list):
                return [shift_sample_indices(item) for item in value]
            if isinstance(value, dict):
                return {key: item - 1 if key == "sample_index" else shift_sample_indices(item)
                        for key, item in value.items()}
            return value

        path = _artifact_case(adaptive) / "eigen/parallel_execution.v1.json"
        _write_json(path, shift_sample_indices(_read_json(path)))
        _refresh_catalog(adaptive)

    with pytest.raises(parity.ValidationError, match=r"sample (indices|count)"):
        parity.validate_signed_de_campaign_parity(serial, adaptive)


def test_frequency_outside_existing_tolerance_is_not_verified(tmp_path, monkeypatch):
    monkeypatch.setattr(plotting, "validate_rows", lambda *args, **kwargs: {"status": "pass"})
    serial = _write_campaign(tmp_path, "serial", "run-serial-05", report=False)
    adaptive = _write_campaign(
        tmp_path, "adaptive", "run-adaptive-05",
        frequency_delta={9: 200.0},
    )

    result = parity.validate_signed_de_campaign_parity(serial, adaptive)

    assert result["status"] == "not_verified"
    assert result["numeric_parity"]["max_frequency_difference_hz"] == 200.0


def test_native_residual_above_existing_ceiling_is_not_verified(tmp_path, monkeypatch):
    monkeypatch.setattr(plotting, "validate_rows", lambda *args, **kwargs: {"status": "pass"})
    serial = _write_campaign(tmp_path, "serial", "run-serial-06", report=False)
    adaptive = _write_campaign(
        tmp_path, "adaptive", "run-adaptive-06",
        residuals={3: 2.0e-8},
    )

    result = parity.validate_signed_de_campaign_parity(serial, adaptive)

    assert result["status"] == "not_verified"
    assert result["numeric_parity"]["residual_ceiling"]["status"] == "not_verified"


def test_serial_scheduler_report_is_optional_and_input_comparison_uses_seed_contract(tmp_path, monkeypatch):
    monkeypatch.setattr(plotting, "validate_rows", lambda *args, **kwargs: {"status": "pass"})
    serial = _write_campaign(tmp_path, "serial", "run-shared-lineage-07", report=True)
    adaptive = _write_campaign(tmp_path, "adaptive", "run-shared-lineage-07")

    result = parity.validate_signed_de_campaign_parity(serial, adaptive)

    assert result["status"] == "pass"
    assert result["native_identity"]["operator_input_cross_run"]["status"] == "pass"
    assert result["scheduler"]["serial"]["status"] == "pass"
    assert result["scheduler"]["serial_adaptive_input_parity"]["sample_count"] == 14


def test_missing_required_adaptive_report_is_not_verified(tmp_path, monkeypatch):
    monkeypatch.setattr(plotting, "validate_rows", lambda *args, **kwargs: {"status": "pass"})
    serial = _write_campaign(tmp_path, "serial", "run-serial-08", report=False)
    adaptive = _write_campaign(tmp_path, "adaptive", "run-adaptive-08")
    report_path = _artifact_case(adaptive) / "eigen/parallel_execution.v1.json"
    report_path.unlink()
    _update_catalog(adaptive)

    result = parity.validate_signed_de_campaign_parity(serial, adaptive)

    assert result["status"] == "not_verified"
    assert result["scheduler"]["adaptive"]["status"] == "not_verified"


def test_cli_writes_a_separate_unqualified_report_without_mutating_inputs(tmp_path, monkeypatch):
    monkeypatch.setattr(plotting, "validate_rows", lambda *args, **kwargs: {"status": "pass"})
    serial = _write_campaign(tmp_path, "serial", "run-shared-cli", report=False)
    adaptive = _write_campaign(tmp_path, "adaptive", "run-shared-cli")
    before = {
        path: hashlib.sha256(path.read_bytes()).hexdigest()
        for batch in (serial, adaptive)
        for path in (batch / "run-request.json", batch / "run-result.json")
    }
    output = tmp_path / "parity-report.json"

    assert parity.main([str(serial), str(adaptive), "--output", str(output)]) == 0

    report = _read_json(output)
    assert report["qualification"] == "NOT VERIFIED"
    after = {
        path: hashlib.sha256(path.read_bytes()).hexdigest()
        for batch in (serial, adaptive)
        for path in (batch / "run-request.json", batch / "run-result.json")
    }
    assert after == before


def test_cli_writes_rejected_report_for_physical_identity_mismatch(tmp_path, monkeypatch):
    monkeypatch.setattr(plotting, "validate_rows", lambda *args, **kwargs: {"status": "pass"})
    serial = _write_campaign(tmp_path, "serial", "run-serial-cli-reject", report=False)
    adaptive = _write_campaign(
        tmp_path, "adaptive", "run-adaptive-cli-reject",
        m0_overrides={2: [[0.0, 1.0, 0.0]]},
    )
    output = tmp_path / "rejected-parity-report.json"

    assert parity.main([str(serial), str(adaptive), "--output", str(output)]) == 1

    report = _read_json(output)
    assert report["status"] == "rejected"
    assert report["qualification"] == "NOT VERIFIED"


def test_scheduler_input_uses_raw_artifact_hash_not_semantic_content(valid_pair):
    serial, adaptive = valid_pair
    case = _artifact_case(adaptive)
    artifact = _read_json(case / "eigen/metadata/sample_0001/equilibrium_artifact.v7.json")
    report_path = case / "eigen/parallel_execution.v1.json"
    journal = _read_json(report_path)
    assert journal["report"]["inputs"][0]["equilibrium_artifact_sha256"] != artifact["content_sha256"]
    baseline = parity.validate_signed_de_campaign_parity(serial, adaptive)
    assert baseline["scheduler"]["adaptive"]["status"] == "pass"
    journal["report"]["inputs"][0]["equilibrium_artifact_sha256"] = artifact["content_sha256"]
    _write_json(report_path, journal)
    _refresh_catalog(adaptive)
    result = parity.validate_signed_de_campaign_parity(serial, adaptive)
    assert result["scheduler"]["adaptive"]["status"] == "not_verified"
    assert "raw SHA" in result["scheduler"]["adaptive"]["reason"]


def test_direct_native_pool_report_is_valid_but_has_no_terminal_proof(valid_pair):
    serial, adaptive = valid_pair
    path = _artifact_case(adaptive) / "eigen/parallel_execution.v1.json"
    journal = _read_json(path)
    _write_json(path, journal["report"])
    _refresh_catalog(adaptive)
    result = parity.validate_signed_de_campaign_parity(serial, adaptive)
    assert result["scheduler"]["adaptive"]["status"] == "not_verified"
    assert "completed terminal state" in result["scheduler"]["adaptive"]["reason"]


def test_run_local_worker_plan_hash_difference_needs_physical_projection(tmp_path, monkeypatch):
    monkeypatch.setattr(plotting, "validate_rows", lambda *args, **kwargs: {"status": "pass"})
    serial = _write_campaign(tmp_path, "serial", "same-plan-lineage", report=True)
    adaptive = _write_campaign(tmp_path, "adaptive", "same-plan-lineage")
    path = _artifact_case(adaptive) / "eigen/parallel_execution.v1.json"
    journal = _read_json(path)
    journal["report"]["inputs"][2]["plan_sha256"] = _sha("different-run-local-artifact-path")
    _write_json(path, journal)
    _refresh_catalog(adaptive)
    result = parity.validate_signed_de_campaign_parity(serial, adaptive)
    comparison = result["scheduler"]["serial_adaptive_input_parity"]
    assert comparison["status"] == "not_verified"
    assert comparison["differing_plan_sample_indices"] == [3]
    assert comparison["different_digest_is_not_a_physical_mismatch_claim"] is True


def test_identity_snapshot_must_match_the_selected_runtime_capsule(valid_pair):
    serial, adaptive = valid_pair
    case = _artifact_case(serial)
    stem = case / "eigen/metadata/sample_0000"
    identity = _read_json(stem / "linearization_identity.v2.json")
    for role in ("producer", "consumer"):
        identity[f"{role}_source_snapshot_sha256"] = "b" * 64
        identity[f"{role}_build_identity"]["source_snapshot_sha256"] = "b" * 64
    identity, preimage = _pack_identity(identity)
    _write_json(stem / "linearization_identity.v2.json", identity)
    _write_json(stem / "linearization_identity_preimage.v1.json", preimage)
    manifest_path = case / "frequency_domain/manifest.v1.json"
    manifest = _read_json(manifest_path)
    manifest["native_provenance_by_sample"]["0"]["linearization_identity_sha256"] = identity["content_sha256"]
    _write_json(manifest_path, manifest)
    _refresh_catalog(serial)
    with pytest.raises(parity.ValidationError, match="snapshot differs from the selected capsule"):
        parity.validate_signed_de_campaign_parity(serial, adaptive)
