"""Regressions for campaign-derived immutable probe inputs."""
from __future__ import annotations

import hashlib
import json
import os
import copy
from pathlib import Path

import pytest

import de_signed_state_closure as state_closure
import fem_linearization_identity_replay
import freeze_signed_de_probe_inputs as freezer
import plot_signed_de_campaign as plotting
from comsol_mesh_identity import mesh_topology_fingerprint_v3


PINNED_COMMIT = "71ba0d18225ffcc83f7f18e676de8dc051e87fd1"
MODEL_BYTES = b"# accepted campaign model source fixture\n"
MODEL_SHA = hashlib.sha256(MODEL_BYTES).hexdigest()
K_VALUES = (-25, -20, -15, -10, -7, -5, -2, 0, 2, 5, 7, 10, 15, 20, 25)
IDENTITY_ORDER = """
schema_version sample_index equilibrium_artifact_schema linearization_state_schema
accepted_fields_schema certified_fields_schema recomputed_certificate_schema
handoff_schema_version handoff_content_sha256 source_run_id source_stage_id
source_stage_kind producer_plan_snapshot_sha256 consumer_plan_snapshot_sha256
producer_build_identity consumer_build_identity producer_source_snapshot_sha256
consumer_source_snapshot_sha256 cross_build_policy source_mesh_topology_sha256
modal_mesh_topology_fingerprint_v3 node_count equilibrium_content_sha256
equilibrium_artifact_path equilibrium_artifact_sha256 linearization_state_path
linearization_state_sha256 equilibrium_material_signature
equilibrium_material_preimage_json equilibrium_static_physics_signature
equilibrium_static_physics_preimage_json equilibrium_boundary_signature
equilibrium_boundary_preimage_json material_signature material_identity_kind
material_provenance_signature material_provenance_scope material_provenance_preimage_json
producer_material_provenance_signature producer_material_provenance_preimage_json
accepted_fields_content_sha256 accepted_fields_path certified_fields_content_sha256
certified_fields_path recomputed_certificate_content_sha256 recomputed_certificate_path
accepted_fields_bytes_sha256 certified_fields_bytes_sha256 recomputed_certificate_bytes_sha256
recomputed_certificate_preimage_json recomputed_certificate_preimage_sha256 content_sha256
""".split()


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _write_json(path: Path, value: object) -> bytes:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)
    return raw


def _native_identity(sample_index: int, eq_path: str, eq_content: str,
                     linearization_path: str, linearization_raw: bytes,
                     source_mesh_fingerprint: str, modal_mesh_fingerprint: str,
                     source_node_count: int) -> tuple[dict, dict]:
    digest = "sha256:" + "a" * 64
    snapshot = "b" * 64
    identity = {field: "fixture" for field in IDENTITY_ORDER}
    identity.update({
        "schema_version": "linearization_identity.v2",
        "sample_index": sample_index,
        "equilibrium_artifact_schema": "equilibrium_artifact.v8",
        "linearization_state_schema": "LinearizationState.v7",
        "accepted_fields_schema": "CertifiedFemEquilibriumFields.v2",
        "certified_fields_schema": "CertifiedFemEquilibriumFields.v2",
        "recomputed_certificate_schema": "RecomputedFemLinearizationCertificate.v2",
        "handoff_schema_version": "accepted_fem_relax_stage_handoff.v3",
        "producer_build_identity": {"source_snapshot_sha256": snapshot},
        "consumer_build_identity": {"source_snapshot_sha256": snapshot},
        "producer_source_snapshot_sha256": snapshot,
        "consumer_source_snapshot_sha256": snapshot,
        "cross_build_policy": "same_source_snapshot_required",
        "source_mesh_topology_sha256": source_mesh_fingerprint,
        "modal_mesh_topology_fingerprint_v3": modal_mesh_fingerprint,
        "node_count": source_node_count,
        "equilibrium_content_sha256": eq_content,
        "equilibrium_artifact_path": eq_path,
        "equilibrium_artifact_sha256": eq_content,
        "linearization_state_path": linearization_path,
        "linearization_state_sha256": json.loads(linearization_raw)["content_sha256"],
        "content_sha256": "",
    })
    for field in IDENTITY_ORDER:
        if field.endswith("_signature") or field.endswith("_content_sha256") or field.endswith("_bytes_sha256"):
            identity[field] = digest
    identity["equilibrium_content_sha256"] = eq_content
    identity["equilibrium_artifact_sha256"] = eq_content
    identity["linearization_state_sha256"] = json.loads(linearization_raw)["content_sha256"]
    for field in ("equilibrium_material_preimage_json", "equilibrium_static_physics_preimage_json",
                  "equilibrium_boundary_preimage_json", "material_provenance_preimage_json",
                  "producer_material_provenance_preimage_json", "recomputed_certificate_preimage_json"):
        identity[field] = "{}"
    identity["accepted_fields_path"] = f"eigen/metadata/sample_{sample_index:04}/accepted_fem_equilibrium_fields.v2.json"
    identity["certified_fields_path"] = f"eigen/metadata/sample_{sample_index:04}/certified_fem_equilibrium_fields.v2.json"
    identity["recomputed_certificate_path"] = f"eigen/metadata/sample_{sample_index:04}/recomputed_fem_linearization_certificate.v2.json"
    preimage_object = dict(identity)
    preimage_object["content_sha256"] = ""
    preimage = json.dumps(preimage_object, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    framed = b"linearization_identity.v2\0" + len(preimage).to_bytes(8, "little") + preimage
    identity_digest = "sha256:" + hashlib.sha256(framed).hexdigest()
    identity["content_sha256"] = identity_digest
    preimage_sidecar = {
        "schema_version": "linearization_identity_preimage.v1",
        "identity_schema": "linearization_identity.v2",
        "identity_preimage_json": preimage.decode("utf-8"),
        "identity_preimage_sha256": "sha256:" + hashlib.sha256(preimage).hexdigest(),
        "identity_content_sha256": identity_digest,
    }
    return identity, preimage_sidecar


def _write_batch(storage: Path, *, mode: str = "adaptive", same_equilibrium: bool = True) -> Path:
    batch = storage / "signed15" / "accepted"
    case = batch / plotting.PILOT
    (case / "eigen" / "diagnostics").mkdir(parents=True)
    (batch / "model-input.py").write_bytes(MODEL_BYTES)
    source_mesh = {
        "mesh_name": "source-relaxation-mesh",
        "mesh_id": "source-relaxation-mesh-id",
        "nodes": [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
        "cells": {
            "types": ["tet4"], "offsets": [0, 4], "nodes": [0, 1, 2, 3],
            "global_ordinals": [0], "mesh_parts": [],
        },
        "element_markers": [7],
        "facets": {
            "types": ["tri3"], "roles": ["exterior"], "offsets": [0, 3],
            "nodes": [0, 1, 2], "global_ordinals": [0],
        },
        "boundary_markers": [11],
        "periodic_boundary_pairs": [{
            "pair_id": "periodic-x", "marker_a": 11, "marker_b": 12,
            "translation": [1.0, 0.0, 0.0], "tolerance": 1e-12,
            "axis_hint": "x", "orientation": "same", "pairing_policy": "translation",
        }],
        "periodic_node_pairs": [{"pair_id": "periodic-x", "node_a": 0, "node_b": 1}],
        "per_domain_quality": [{"marker": 7, "minimum_jacobian": 0.25, "certificate": {"algorithm": "fixture"}}],
        "mesh_certificate": {"schema": "mesh-certificate.fixture.v1", "digest": "sha256:" + "9" * 64},
    }
    mesh = copy.deepcopy(source_mesh)
    mesh["mesh_name"] = "modal-film-airbox-mesh"
    mesh["nodes"].append([0.0, 0.0, -1.0])
    mesh["cells"]["types"].append("tet4")
    mesh["cells"]["offsets"].append(8)
    mesh["cells"]["nodes"].extend([0, 2, 1, 4])
    mesh["cells"]["global_ordinals"].append(1)
    mesh["cells"]["mesh_parts"] = ["magnetic", "far_air"]
    mesh["element_markers"].append(8)
    modal_facets = [[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 1, 4], [1, 2, 4], [2, 0, 4]]
    mesh["facets"] = {
        "types": ["tri3"] * len(modal_facets),
        "roles": ["exterior"] * len(modal_facets),
        "offsets": list(range(0, 3 * len(modal_facets) + 1, 3)),
        "nodes": [node for facet in modal_facets for node in facet],
        "global_ordinals": list(range(len(modal_facets))),
    }
    mesh["boundary_markers"] = [11] * len(modal_facets)
    mesh["per_domain_quality"].append({"marker": 8, "minimum_jacobian": 0.125, "certificate": {"algorithm": "fixture"}})
    source_mesh_fingerprint = mesh_topology_fingerprint_v3(source_mesh)
    modal_mesh_fingerprint = mesh_topology_fingerprint_v3(mesh)
    model = {
        "schema": "fullmag.de-smoke.v1", "sampling": "signed-fifteen",
        "dispersion_geometry": "damon_eshbach", "orientation": "M0=x,k=y,normal=z",
        "outer_boundary_kind": "poisson_dirichlet", "modal_target": "frequency_window",
        "selection_scope": "frequency_window", "window_complete": None,
        "requested_mode_count": 1, "ky_rad_per_m": [k * 1e6 for k in K_VALUES],
        "kx_rad_per_m": [0.0] * 15,
        "k_vectors_rad_per_m": [[0.0, k * 1e6, 0.0] for k in K_VALUES],
        "frequency_window_hz": [8.5e9, 16e9], "magnetostatic_bc": "floquet_airbox",
        "mu0_t_m_a": plotting.MU0, "external_induction_t": 0.1,
        "air_padding_each_side_m": 2e-6, "film_thickness_m": 10e-9,
        "exchange_stiffness_j_per_m": 13e-12,
        "saturation_magnetization_a_per_m": 800000.0,
        "gamma0_m_per_a_s": 221100.0,
        "cell_period_m": 40e-9, "magnetic_element_size_m": 10e-9,
        "through_thickness_elements": 3, "eigen_solver_rtol": 1e-8,
        "eigen_solver_max_outer_iterations": 2000,
    }
    parallel = {"mode": mode, **plotting.EXPECTED_POLICY}
    metadata = {
        "execution_plan": {"backend_plan": {
            "mesh": mesh,
            "mesh_build_report": {"region_markers": [{"geometry_name": "film", "marker": 7}]},
        }},
        "problem_meta": {"runtime_metadata": {
            "de_smoke": model,
            "runtime_selection": {"parallel_execution": parallel},
            "mesh_workflow": {
                "domain_region_markers": None,
                "domain_object_region_markers": None,
            },
        }},
    }
    _write_json(case / "metadata.json", metadata)
    rows = [
        {"sample_index": i, "raw_mode_index": 0, "branch_id": 0,
         "kx_rad_per_m": 0.0, "ky_rad_per_m": k * 1e6, "kz_rad_per_m": 0.0,
         "frequency_hz": 10.0e9 + i * 1.0e8, "residual_norm": 1.0e-12}
        for i, k in enumerate(K_VALUES)
    ]
    csv_path = case / "eigen" / "dispersion.csv"
    csv_path.write_text(
        ",".join(rows[0]) + "\n" + "".join(",".join(str(value) for value in row.values()) + "\n" for row in rows),
        encoding="utf-8",
    )
    artifact_paths = {
        "eigen/spectrum.v2.json": b"{}",
        "eigen/branches.v2.json": b"{}",
        "eigen/diagnostics/solver.v1.json": b"{}",
        "eigen/metadata/eigen_summary.json": b"{}",
        "frequency_domain/manifest.v1.json": b"{}",
    }
    for relative, content in artifact_paths.items():
        path = case / Path(*relative.split("/"))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)

    eq_content = "sha256:" + "1" * 64
    for index in (3, 11):
        eq_path = f"eigen/metadata/sample_{index:04}/equilibrium_artifact.v8.json"
        eq_native = {
            "schema_version": "equilibrium_artifact.v8",
            "content_sha256": eq_content if same_equilibrium or index == 3 else "sha256:" + "2" * 64,
            "accepted_for_linearization": True,
            "certificate": {"preserved": [1, 2, 3]},
        }
        eq_target = case / Path(*eq_path.split("/"))
        if same_equilibrium and index == 11:
            eq_target.parent.mkdir(parents=True, exist_ok=True)
            eq_raw = json.dumps(eq_native, indent=2).encode("utf-8")
            eq_target.write_bytes(eq_raw)
        else:
            eq_raw = _write_json(eq_target, eq_native)
        linearization_path = f"eigen/metadata/sample_{index:04}/linearization_state.v7.json"
        linearization_content = "sha256:" + ("3" if index == 3 else "4") * 64
        linearization_raw = _write_json(case / Path(*linearization_path.split("/")), {
            "schema_version": "LinearizationState.v7",
            "content_sha256": linearization_content,
            "source_equilibrium_artifact": eq_native["content_sha256"],
        })
        source_mesh_path = f"eigen/metadata/sample_{index:04}/nonshared_source/source_mesh.json"
        source_mesh_raw = _write_json(case / Path(*source_mesh_path.split("/")), source_mesh)
        source_state_path = f"eigen/metadata/sample_{index:04}/nonshared_floquet_source_state.v1.json"
        source_mesh_sha = "sha256:" + _sha(source_mesh_raw)
        source_state = {
            "schema_version": "nonshared_floquet_source_state.v1",
            "content_sha256": "sha256:" + "5" * 64,
            "sample_index": index,
            "source_replay_qualified": True,
            "source_replay_available": True,
            "source_replay_status": "producer_plan_snapshot_verified",
            "source_field_origins_verified": True,
            "source_field_lengths_verified": True,
            "source_mesh_node_count": len(source_mesh["nodes"]),
            "mesh": {
                "topology_fingerprint_v3": modal_mesh_fingerprint,
                "source_mesh_topology_sha256": source_mesh_fingerprint,
                "producer_mesh_node_count": len(source_mesh["nodes"]),
                "payload_kind": "producer_plan_snapshot_mesh",
                "payload_sha256": source_mesh_sha,
                "payload_path": source_mesh_path,
                "source_mesh_payload_status": "producer_plan_snapshot_verified",
            },
        }
        _write_json(case / Path(*source_state_path.split("/")), source_state)
        identity, preimage = _native_identity(
            index, eq_path, eq_native["content_sha256"], linearization_path,
            linearization_raw, source_mesh_fingerprint, modal_mesh_fingerprint,
            len(source_mesh["nodes"]),
        )
        _write_json(case / f"eigen/metadata/sample_{index:04}/linearization_identity.v2.json", identity)
        _write_json(case / f"eigen/metadata/sample_{index:04}/linearization_identity_preimage.v1.json", preimage)
    (case / "equilibrium").mkdir()
    (case / "equilibrium" / "accepted-source.dat").write_bytes(b"bound dependency fixture\n")

    hashes = {}
    paths = [case / "metadata.json", csv_path, *(case / Path(*relative.split("/")) for relative in artifact_paths)]
    for path in paths:
        relative = path.relative_to(case).as_posix()
        raw = path.read_bytes()
        hashes[relative] = {"size": len(raw), "sha256": _sha(raw)}
    artifacts = {"case": "fixture", "required_artifact_hashes": hashes}
    state_closure.bind_signed_state_closure(case, artifacts)

    job = {"job_id": "b" * 32, "worktree_id": "fixture", "source_digest": "c" * 64}
    source = {"capsule_relative": "runs/worktree/job/source/tree", "resolved_commit": "d" * 40}
    model_source = {
        "kind": "versioned_standalone_input", "commit": PINNED_COMMIT,
        "path": "examples/fem_de_smoke_numeric.py", "sha256": MODEL_SHA,
    }
    campaign = {
        "mode": mode, "sampling": "signed-fifteen", "model_sha256": MODEL_SHA,
        "model_source_commit": PINNED_COMMIT, **plotting.EXPECTED_POLICY,
    }
    request = {
        "schema": "fullmag.de-smoke.request.v1", "status": "prepared",
        "operation": plotting.PILOT + "-numerical-pilot", "cases": [plotting.PILOT],
        "sampling": "signed-fifteen", "output_dir": str(batch.resolve()),
        "job": job, "source": source, "model_sha256": MODEL_SHA,
        "model_source": model_source, "parallel_campaign": campaign,
    }
    result = {
        "schema": "fullmag.de-smoke.result.v1", "pilot": plotting.PILOT,
        "status": "completed_unqualified", "return_code": 0, "job": job,
        "source": source, "model_sha256": MODEL_SHA, "model_source": model_source,
        "parallel_campaign": campaign, "artifacts": artifacts,
    }
    _write_json(batch / "run-request.json", request)
    _write_json(batch / "run-result.json", result)
    return batch


def _refresh_state_receipt(batch: Path) -> None:
    case = batch / plotting.PILOT
    result_path = batch / "run-result.json"
    result = json.loads(result_path.read_text(encoding="utf-8"))
    closure = state_closure.collect_signed_state_closure(case)
    required = result["artifacts"]["required_artifact_hashes"]
    for entry in closure["files"]:
        required[entry["path"]] = {"size": entry["size"], "sha256": entry["sha256"]}
    result["artifacts"]["signed_state_closure"] = closure
    _write_json(result_path, result)


def _refresh_metadata_receipt(batch: Path) -> None:
    case = batch / plotting.PILOT
    metadata_path = case / "metadata.json"
    raw = metadata_path.read_bytes()
    result_path = batch / "run-result.json"
    result = json.loads(result_path.read_text(encoding="utf-8"))
    result["artifacts"]["required_artifact_hashes"]["metadata.json"] = {
        "size": len(raw), "sha256": _sha(raw),
    }
    _write_json(result_path, result)


def _freeze(tmp_path: Path, monkeypatch, *, same_equilibrium: bool = True):
    storage = tmp_path / "storage"
    storage.mkdir()
    batch = _write_batch(storage, same_equilibrium=same_equilibrium)
    monkeypatch.setattr(
        plotting, "validate_rows",
        lambda *args, **kwargs: {"status": "pass", "sampling": "signed-fifteen", "sample_count": 15},
    )
    output = storage / "frozen-probe"
    manifest = freezer.freeze_inputs(batch, output, storage)
    return storage, batch, output, manifest


def test_freeze_preserves_bound_mesh_state_and_native_identity(tmp_path, monkeypatch):
    storage, batch, output, manifest = _freeze(tmp_path, monkeypatch)
    metadata = json.loads((batch / plotting.PILOT / "metadata.json").read_text(encoding="utf-8"))
    expected_mesh = metadata["execution_plan"]["backend_plan"]["mesh"]
    assert json.loads((output / "input" / "mesh-ir.json").read_text(encoding="utf-8")) == expected_mesh
    assert manifest["mesh"]["region_markers"] == metadata["execution_plan"]["backend_plan"]["mesh_build_report"]["region_markers"]
    assert manifest["mesh"]["object_region_markers"] is None
    expected_fingerprint = mesh_topology_fingerprint_v3(expected_mesh)
    assert manifest["mesh"]["modal_mesh_topology_fingerprint_v3"] == expected_fingerprint
    source_mesh_path = batch / plotting.PILOT / "eigen/metadata/sample_0003/nonshared_source/source_mesh.json"
    source_mesh = json.loads(source_mesh_path.read_text(encoding="utf-8"))
    source_fingerprint = mesh_topology_fingerprint_v3(source_mesh)
    assert manifest["mesh"]["source_mesh_topology_sha256"] == source_fingerprint
    assert source_fingerprint != expected_fingerprint
    assert manifest["selected_equilibrium"]["mesh_identity"]["node_count"] == len(source_mesh["nodes"])
    assert manifest["mesh"]["node_count"] == len(expected_mesh["nodes"])
    assert manifest["source_mesh_geometry_replay"]["status"] == "receipt_bound_source_and_modal_topology_replayed"
    assert manifest["source_mesh_geometry_replay"]["physical_source_state_replay"] == "not_performed"
    assert manifest["probe"]["source_sample_indices"] == [3, 11, 3]
    assert manifest["probe"]["k_vectors_rad_per_m"] == [[0.0, -1e7, 0.0], [0.0, 1e7, 0.0], [0.0, -1e7, 0.0]]
    assert manifest["numerical_settings"]["model_metadata"] == metadata["problem_meta"]["runtime_metadata"]["de_smoke"]
    assert manifest["selected_equilibrium"]["source_samples"] == [3, 11]
    assert manifest["selected_equilibrium"]["native_content_sha256"].startswith("sha256:")
    identity = json.loads((batch / plotting.PILOT / "eigen/metadata/sample_0003/linearization_identity.v2.json").read_text(encoding="utf-8"))
    assert set(identity) == fem_linearization_identity_replay.IDENTITY_FIELDS
    assert len(identity) == 52
    assert manifest["selected_equilibrium"]["raw_sha256"] != manifest["selected_equilibrium"]["native_content_sha256"]
    assert manifest["identities"]["3"]["equilibrium_raw_sha256"] != manifest["identities"]["11"]["equilibrium_raw_sha256"]
    assert manifest["identities"]["3"]["equilibrium_content_sha256"] == manifest["identities"]["11"]["equilibrium_content_sha256"]
    selected_source = batch / plotting.PILOT / Path(*manifest["selected_equilibrium"]["source_path"].split("/"))
    selected_copy = output / Path(*manifest["selected_equilibrium"]["bundle_path"].split("/"))
    assert selected_copy.read_bytes() == selected_source.read_bytes()
    assert manifest["source_state_closure"]["schema"] == state_closure.SCHEMA
    assert freezer.validate_bundle(output, storage)["selected_equilibrium"] == manifest["selected_equilibrium"]


def test_freeze_rejects_different_equilibrium_content_for_probe_samples(tmp_path, monkeypatch):
    storage = tmp_path / "storage"
    storage.mkdir()
    batch = _write_batch(storage, same_equilibrium=False)
    monkeypatch.setattr(plotting, "validate_rows", lambda *args, **kwargs: {"status": "pass"})
    with pytest.raises(ValueError, match="samples 3 and 11.*equilibrium content"):
        freezer.freeze_inputs(batch, storage / "out", storage)
    assert not (storage / "out").exists()


def test_freeze_rejects_failed_and_missing_run_result(tmp_path, monkeypatch):
    storage = tmp_path / "storage"
    storage.mkdir()
    batch = _write_batch(storage)
    monkeypatch.setattr(plotting, "validate_rows", lambda *args, **kwargs: {"status": "pass"})
    result_path = batch / "run-result.json"
    result = json.loads(result_path.read_text(encoding="utf-8"))
    result["status"] = "failed"
    _write_json(result_path, result)
    with pytest.raises(ValueError, match="completed managed"):
        freezer.freeze_inputs(batch, storage / "failed", storage)
    result_path.unlink()
    with pytest.raises(ValueError, match="run-result"):
        freezer.freeze_inputs(batch, storage / "missing", storage)
    assert not (storage / "failed").exists() and not (storage / "missing").exists()


def test_freeze_rejects_tampered_campaign_artifact(tmp_path, monkeypatch):
    storage = tmp_path / "storage"
    storage.mkdir()
    batch = _write_batch(storage)
    (batch / plotting.PILOT / "metadata.json").write_bytes(b"{}")
    monkeypatch.setattr(plotting, "validate_rows", lambda *args, **kwargs: {"status": "pass"})
    with pytest.raises(ValueError, match="artifact hash or size mismatch"):
        freezer.freeze_inputs(batch, storage / "out", storage)
    assert not (storage / "out").exists()


def test_freeze_rejects_unbound_closure_dependency(tmp_path, monkeypatch):
    storage = tmp_path / "storage"
    storage.mkdir()
    batch = _write_batch(storage)
    case = batch / plotting.PILOT
    extra = case / "eigen" / "metadata" / "sample_0011" / "nonshared_source" / "dependency.bin"
    extra.parent.mkdir(parents=True, exist_ok=True)
    extra.write_bytes(b"dependency not in receipt hash map")
    result_path = batch / "run-result.json"
    result = json.loads(result_path.read_text(encoding="utf-8"))
    result["artifacts"]["signed_state_closure"] = state_closure.collect_signed_state_closure(case)
    _write_json(result_path, result)
    monkeypatch.setattr(plotting, "validate_rows", lambda *args, **kwargs: {"status": "pass"})
    with pytest.raises(ValueError, match="closure file is not bound by run-result"):
        freezer.freeze_inputs(batch, storage / "out", storage)


def test_freeze_rejects_abbreviated_52_field_identity(tmp_path, monkeypatch):
    storage = tmp_path / "storage"
    storage.mkdir()
    batch = _write_batch(storage)
    identity_path = batch / plotting.PILOT / "eigen/metadata/sample_0003/linearization_identity.v2.json"
    identity = json.loads(identity_path.read_text(encoding="utf-8"))
    assert len(identity) == 52
    identity.pop("accepted_fields_schema")
    _write_json(identity_path, identity)
    _refresh_state_receipt(batch)
    monkeypatch.setattr(plotting, "validate_rows", lambda *args, **kwargs: {"status": "pass"})
    with pytest.raises(ValueError, match="unknown or missing fields"):
        freezer.freeze_inputs(batch, storage / "out", storage)


def test_freeze_rejects_receipt_rebound_structurally_invalid_mesh(tmp_path, monkeypatch):
    storage = tmp_path / "storage"
    storage.mkdir()
    batch = _write_batch(storage)
    metadata_path = batch / plotting.PILOT / "metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata["execution_plan"]["backend_plan"]["mesh"]["cells"]["nodes"][0] = 999
    _write_json(metadata_path, metadata)
    _refresh_metadata_receipt(batch)
    monkeypatch.setattr(plotting, "validate_rows", lambda *args, **kwargs: {"status": "pass"})
    with pytest.raises(ValueError, match="references a node outside"):
        freezer.freeze_inputs(batch, storage / "out", storage)


def test_freeze_rejects_receipt_rebound_mesh_with_stale_native_fingerprint(tmp_path, monkeypatch):
    storage = tmp_path / "storage"
    storage.mkdir()
    batch = _write_batch(storage)
    metadata_path = batch / plotting.PILOT / "metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    # Keep the producer-shaped MeshIR structurally valid while changing its
    # topology identity; rebinding raw metadata must not hide stale EQ identities.
    metadata["execution_plan"]["backend_plan"]["mesh"]["nodes"][1][0] = 1.25
    _write_json(metadata_path, metadata)
    _refresh_metadata_receipt(batch)
    monkeypatch.setattr(plotting, "validate_rows", lambda *args, **kwargs: {"status": "pass"})
    with pytest.raises(ValueError, match="modal_mesh_topology_fingerprint_v3 differs from the frozen modal MeshIR"):
        freezer.freeze_inputs(batch, storage / "out", storage)
    assert not (storage / "out").exists()


def test_freeze_rejects_missing_receipt_bound_source_mesh(tmp_path, monkeypatch):
    storage = tmp_path / "storage"
    storage.mkdir()
    batch = _write_batch(storage)
    case = batch / plotting.PILOT
    source_path = "eigen/metadata/sample_0003/nonshared_source/source_mesh.json"
    (case / Path(*source_path.split("/"))).unlink()
    result_path = batch / "run-result.json"
    result = json.loads(result_path.read_text(encoding="utf-8"))
    result["artifacts"]["required_artifact_hashes"].pop(source_path)
    _write_json(result_path, result)
    _refresh_state_receipt(batch)
    monkeypatch.setattr(plotting, "validate_rows", lambda *args, **kwargs: {"status": "pass"})
    with pytest.raises(ValueError, match="source_mesh_geometry_replay NOT VERIFIED.*source MeshIR is not receipt-bound"):
        freezer.freeze_inputs(batch, storage / "out", storage)
    assert not (storage / "out").exists()


def test_freeze_rejects_escaping_closure_entry(tmp_path, monkeypatch):
    storage = tmp_path / "storage"
    storage.mkdir()
    batch = _write_batch(storage)
    result_path = batch / "run-result.json"
    result = json.loads(result_path.read_text(encoding="utf-8"))
    closure = result["artifacts"]["signed_state_closure"]
    closure["files"].append({"path": "../outside.json", "size": 1, "sha256": "0" * 64})
    closure["files"].sort(key=lambda entry: entry["path"])
    closure["file_count"] = len(closure["files"])
    closure["total_bytes"] += 1
    canonical = json.dumps(closure["files"], sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    closure["file_table_sha256"] = _sha(canonical)
    _write_json(result_path, result)
    monkeypatch.setattr(plotting, "validate_rows", lambda *args, **kwargs: {"status": "pass"})
    with pytest.raises(ValueError, match="closure path escapes"):
        freezer.freeze_inputs(batch, storage / "out", storage)


def test_freeze_rejects_closure_links_when_platform_allows_symlinks(tmp_path, monkeypatch):
    storage = tmp_path / "storage"
    storage.mkdir()
    batch = _write_batch(storage)
    case = batch / plotting.PILOT
    source = case / "eigen" / "metadata" / "sample_0003" / "equilibrium_artifact.v8.json"
    link = case / "eigen" / "metadata" / "sample_0003" / "linked-equilibrium.json"
    try:
        os.symlink(source, link)
    except (OSError, NotImplementedError):
        pytest.skip("the host does not permit creating a symbolic link")
    monkeypatch.setattr(plotting, "validate_rows", lambda *args, **kwargs: {"status": "pass"})
    with pytest.raises(ValueError, match="link"):
        freezer.freeze_inputs(batch, storage / "out", storage)


def test_freeze_refuses_overwrite_without_changing_existing_bundle(tmp_path, monkeypatch):
    storage, _, output, _ = _freeze(tmp_path, monkeypatch)
    before = (output / "input-manifest.json").read_bytes()
    with pytest.raises(ValueError, match="already exists"):
        freezer.freeze_inputs(storage / "signed15" / "accepted", output, storage)
    assert (output / "input-manifest.json").read_bytes() == before


def test_bundle_reader_rejects_tampered_copied_dependency(tmp_path, monkeypatch):
    storage, _, output, _ = _freeze(tmp_path, monkeypatch)
    dependency = output / "input" / "state" / "equilibrium" / "accepted-source.dat"
    dependency.write_bytes(b"modified")
    with pytest.raises(ValueError, match="bundle file hash mismatch"):
        freezer.validate_bundle(output, storage)


def test_bundle_reader_rejects_extra_unbound_file(tmp_path, monkeypatch):
    storage, _, output, _ = _freeze(tmp_path, monkeypatch)
    (output / "input" / "unbound.txt").write_text("extra", encoding="utf-8")
    with pytest.raises(ValueError, match="unbound bundle file"):
        freezer.validate_bundle(output, storage)


def test_bundle_reader_fails_closed_when_directory_walk_errors(tmp_path, monkeypatch):
    storage, _, output, _ = _freeze(tmp_path, monkeypatch)

    def denied_walk(path, *, followlinks, onerror):
        onerror(PermissionError("simulated inaccessible directory"))
        return iter(())

    monkeypatch.setattr(freezer.os, "walk", denied_walk)
    with pytest.raises(ValueError, match="could not be fully enumerated"):
        freezer.validate_bundle(output, storage)


def test_freeze_copies_validated_receipt_bytes_without_source_reread(tmp_path, monkeypatch):
    storage = tmp_path / "storage"
    storage.mkdir()
    batch = _write_batch(storage)
    case = batch / plotting.PILOT
    expected = {
        "provenance/run-request.json": (batch / "run-request.json").read_bytes(),
        "provenance/run-result.json": (batch / "run-result.json").read_bytes(),
        "provenance/metadata.json": (case / "metadata.json").read_bytes(),
        "model-input.py": (batch / "model-input.py").read_bytes(),
    }
    original_copy = freezer._copy_source_files

    def mutate_source_after_validation(source, output, records, mesh_bytes):
        (batch / "run-request.json").write_bytes(b"tampered request")
        (batch / "run-result.json").write_bytes(b"tampered result")
        (batch / "model-input.py").write_bytes(b"tampered model")
        (case / "metadata.json").write_bytes(b"tampered metadata")
        original_copy(source, output, records, mesh_bytes)

    monkeypatch.setattr(freezer, "_copy_source_files", mutate_source_after_validation)
    monkeypatch.setattr(plotting, "validate_rows", lambda *args, **kwargs: {"status": "pass"})
    output = storage / "frozen-probe"
    freezer.freeze_inputs(batch, output, storage)
    for relative, raw in expected.items():
        assert (output / Path(*relative.split("/"))).read_bytes() == raw
