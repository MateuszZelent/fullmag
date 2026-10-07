"""Interpreted regressions for the private frozen-v2 probe adapter."""
from __future__ import annotations

import ast
import hashlib
import json
from pathlib import Path

import pytest

import test_freeze_signed_de_probe_inputs as fixture
import de_frozen_v2_runtime_adapter as adapter


REPO_ROOT = Path(__file__).resolve().parents[1]
EXPECTED_VECTORS = ((0.0, -1.0e7, 0.0), (0.0, 1.0e7, 0.0), (0.0, -1.0e7, 0.0))


def _frozen_bundle(tmp_path: Path, monkeypatch):
    storage = tmp_path / "storage"
    storage.mkdir()
    model_bytes = (REPO_ROOT / "examples" / "fem_de_smoke_numeric.py").read_bytes()
    monkeypatch.setattr(fixture, "MODEL_BYTES", model_bytes)
    monkeypatch.setattr(fixture, "MODEL_SHA", hashlib.sha256(model_bytes).hexdigest())
    batch = fixture._write_batch(storage)
    monkeypatch.setattr(
        fixture.plotting,
        "validate_rows",
        lambda *args, **kwargs: {"status": "pass", "sampling": "signed-fifteen", "sample_count": 15},
    )
    bundle = storage / "frozen-probe"
    manifest = fixture.freezer.freeze_inputs(batch, bundle, storage)
    return storage, bundle, manifest


def _call_name(node: ast.AST) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = _call_name(node.value)
        return f"{base}.{node.attr}" if base else None
    return None


def _calls(tree: ast.AST, name: str):
    return [node for node in ast.walk(tree) if isinstance(node, ast.Call) and _call_name(node.func) == name]


def _assigned(tree: ast.AST, name: str):
    matches = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == name for target in node.targets):
            matches.append(node.value)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == name:
            matches.append(node.value)
    assert len(matches) == 1
    return ast.literal_eval(matches[0])


def test_prepares_exact_equilibrium_mesh_and_derived_three_point_script(tmp_path, monkeypatch):
    storage, bundle, manifest = _frozen_bundle(tmp_path, monkeypatch)

    prepared = adapter.prepare_frozen_v2_probe(bundle, storage)

    assert prepared.manifest_sha256 == hashlib.sha256((bundle / "input-manifest.json").read_bytes()).hexdigest()
    assert prepared.source_model_sha256 == manifest["source"]["model_source"]["sha256"]
    assert prepared.model_source_commit == fixture.PINNED_COMMIT
    assert prepared.model_source_path == "examples/fem_de_smoke_numeric.py"
    assert prepared.runtime_script_sha256 == hashlib.sha256(prepared.runtime_script_bytes).hexdigest()
    assert prepared.runtime_script_sha256 != prepared.source_model_sha256
    request_record = next(record for record in manifest["files"] if record["role"] == "run_request")
    result_record = next(record for record in manifest["files"] if record["role"] == "run_result")
    assert prepared.run_request_sha256 == request_record["raw_sha256"]
    assert prepared.run_result_sha256 == result_record["raw_sha256"]
    assert prepared.selected_equilibrium_bundle_path == manifest["selected_equilibrium"]["bundle_path"]
    assert prepared.selected_equilibrium_schema == manifest["selected_equilibrium"]["schema_version"]
    assert prepared.selected_equilibrium_raw_sha256 == manifest["selected_equilibrium"]["raw_sha256"]
    assert prepared.selected_equilibrium_native_content_sha256 == manifest["selected_equilibrium"]["native_content_sha256"]
    assert prepared.selected_equilibrium_raw_sha256 != prepared.selected_equilibrium_native_content_sha256.removeprefix("sha256:")
    assert prepared.source_sample_indices == (3, 11, 3)
    assert prepared.k_vectors_rad_per_m == EXPECTED_VECTORS
    assert prepared.source_mesh_topology_sha256 == manifest["mesh"]["source_mesh_topology_sha256"]
    assert prepared.modal_mesh_topology_fingerprint_v3 == manifest["mesh"]["modal_mesh_topology_fingerprint_v3"]
    assert prepared.source_mesh_topology_sha256 != prepared.modal_mesh_topology_fingerprint_v3
    assert prepared.mesh_region_markers == manifest["mesh"]["region_markers"]
    assert prepared.mesh_object_region_markers == manifest["mesh"]["object_region_markers"]
    assert prepared.mesh_ir_bundle_path == "input/mesh-ir.json"
    assert prepared.mesh_ir_raw_sha256 == manifest["mesh"]["raw_sha256"]
    mesh = json.loads(prepared.mesh_ir_raw)
    assert mesh == json.loads((bundle / "input" / "mesh-ir.json").read_bytes())
    assert set(mesh) >= {
        "nodes", "cells", "element_markers", "facets", "boundary_markers",
        "periodic_boundary_pairs", "periodic_node_pairs", "per_domain_quality", "mesh_certificate",
    }
    assert mesh["mesh_certificate"] == {"schema": "mesh-certificate.fixture.v1", "digest": "sha256:" + "9" * 64}
    assert mesh["cells"]["mesh_parts"] == ["magnetic", "far_air"]
    assert prepared.source_state_closure_status == "hash_bound_only"
    assert prepared.physical_source_state_replay == "not_performed"
    assert prepared.runtime_capsule_status.startswith("NOT VERIFIED")
    assert prepared.qualification_status == "NOT VERIFIED"
    launch_validation = adapter.verify_bundle_for_launch(prepared, storage)
    assert launch_validation["manifest_sha256"] == prepared.manifest_sha256
    assert launch_validation["runtime_script_sha256"] == prepared.runtime_script_sha256
    assert launch_validation["selected_equilibrium_native_content_sha256"] == prepared.selected_equilibrium_native_content_sha256

    runtime_source = prepared.runtime_script_bytes.decode("utf-8")
    tree = ast.parse(runtime_source)
    compile(tree, "derived-frozen-probe.py", "exec")
    assert _assigned(tree, "SAMPLING") == "signed-fifteen"
    assert _assigned(tree, "KY") == (-1.0e7, 1.0e7, -1.0e7)
    assert _assigned(tree, "K_VECTORS") == [tuple(vector) for vector in EXPECTED_VECTORS]
    assert not _calls(tree, "study.build_domain_mesh")
    assert not _calls(tree, "study.stages.add_relax")
    assert len(_calls(tree, "fm.domain_mesh")) == 1
    assert len(_calls(tree, "study.stages.add_eigenmodes")) == 1
    domain_call = _calls(tree, "fm.domain_mesh")[0]
    assert ast.literal_eval(domain_call.args[0]) == "/workspace/benchmark-input/input/mesh-ir.json"
    domain_kwargs = {kw.arg: ast.literal_eval(kw.value) for kw in domain_call.keywords}
    assert domain_kwargs == {
        "region_markers": manifest["mesh"]["region_markers"],
        "object_region_markers": manifest["mesh"]["object_region_markers"],
    }
    eigen_call = _calls(tree, "study.stages.add_eigenmodes")[0]
    eigen_kwargs = {kw.arg: ast.literal_eval(kw.value) for kw in eigen_call.keywords if kw.arg in {
        "equilibrium_source", "equilibrium_artifact",
    }}
    assert eigen_kwargs == {
        "equilibrium_source": "artifact",
        "equilibrium_artifact": "/workspace/benchmark-input/" + prepared.selected_equilibrium_bundle_path,
    }
    assert "FULLMAG_DE_SMOKE_MESH_LEVEL" in prepared.runtime_environment
    assert "FULLMAG_DE_SMOKE_THICKNESS_LAYERS" in prepared.runtime_environment
    assert "FULLMAG_DE_SMOKE_SOLVER_RTOL" in prepared.runtime_environment
    assert prepared.runtime_environment["FULLMAG_DE_SMOKE_MESH_LEVEL"] == "L0"
    assert prepared.runtime_environment["FULLMAG_DE_SMOKE_THICKNESS_LAYERS"] == "3"
    assert prepared.runtime_environment["FULLMAG_DE_SMOKE_SOLVER_RTOL"] == "1e-8"
    assert prepared.runtime_environment["FULLMAG_DE_SMOKE_FREQUENCY_MIN_GHZ"] == "8.5"
    assert prepared.runtime_environment["FULLMAG_DE_SMOKE_FREQUENCY_MAX_GHZ"] == "16.0"

    serial = prepared.environment_for_mode("serial")
    adaptive = prepared.environment_for_mode("adaptive")
    assert serial["FULLMAG_DE_SMOKE_PARALLEL_MODE"] == "serial"
    assert adaptive["FULLMAG_DE_SMOKE_PARALLEL_MODE"] == "adaptive"
    serial.pop("FULLMAG_DE_SMOKE_PARALLEL_MODE")
    adaptive.pop("FULLMAG_DE_SMOKE_PARALLEL_MODE")
    assert serial == adaptive


def test_failed_or_missing_receipt_is_rejected_before_script_derivation(tmp_path, monkeypatch):
    storage, bundle, _ = _frozen_bundle(tmp_path, monkeypatch)
    result_path = bundle / "provenance" / "run-result.json"
    result = json.loads(result_path.read_bytes())
    result["status"] = "failed"
    failed_raw = json.dumps(result, sort_keys=True, indent=2, ensure_ascii=False, allow_nan=False).encode("utf-8") + b"\n"
    result_path.write_bytes(failed_raw)
    manifest_path = bundle / "input-manifest.json"
    manifest = json.loads(manifest_path.read_bytes())
    result_record = next(record for record in manifest["files"] if record["role"] == "run_result")
    result_record["size"] = len(failed_raw)
    result_record["raw_sha256"] = hashlib.sha256(failed_raw).hexdigest()
    manifest_path.write_bytes(
        json.dumps(manifest, sort_keys=True, indent=2, ensure_ascii=False, allow_nan=False).encode("utf-8") + b"\n"
    )
    called = False
    original = adapter._derive_runtime_script

    def tracked(*args, **kwargs):
        nonlocal called
        called = True
        return original(*args, **kwargs)

    monkeypatch.setattr(adapter, "_derive_runtime_script", tracked)
    with pytest.raises(ValueError):
        adapter.prepare_frozen_v2_probe(bundle, storage)
    assert not called

    result_path.unlink()
    with pytest.raises(ValueError):
        adapter.prepare_frozen_v2_probe(bundle, storage)
    assert not called


def test_rechecks_all_receipt_bound_bytes_after_validator_returns(tmp_path, monkeypatch):
    storage, bundle, _ = _frozen_bundle(tmp_path, monkeypatch)
    dependency = bundle / "input" / "state" / "equilibrium" / "accepted-source.dat"
    original_validate = adapter.freezer.validate_bundle

    def mutate_after_validation(path, root):
        manifest = original_validate(path, root)
        dependency.write_bytes(b"changed after validate_bundle")
        return manifest

    monkeypatch.setattr(adapter.freezer, "validate_bundle", mutate_after_validation)
    with pytest.raises(ValueError, match="hash mismatch|changed while reading"):
        adapter.prepare_frozen_v2_probe(bundle, storage)


def test_rejects_unbound_file_added_after_campaign_validation(tmp_path, monkeypatch):
    storage, bundle, _ = _frozen_bundle(tmp_path, monkeypatch)
    original_validate = adapter.freezer.validate_bundle

    def add_unbound_after_validation(path, root):
        manifest = original_validate(path, root)
        (bundle / "input" / "unbound-after-validation.bin").write_bytes(b"unbound")
        return manifest

    monkeypatch.setattr(adapter.freezer, "validate_bundle", add_unbound_after_validation)
    with pytest.raises(ValueError, match="file set changed"):
        adapter.prepare_frozen_v2_probe(bundle, storage)


def test_launch_revalidation_rejects_changed_selected_equilibrium(tmp_path, monkeypatch):
    storage, bundle, _ = _frozen_bundle(tmp_path, monkeypatch)
    prepared = adapter.prepare_frozen_v2_probe(bundle, storage)
    eq_path = bundle / Path(*prepared.selected_equilibrium_bundle_path.split("/"))
    eq_path.write_bytes(eq_path.read_bytes() + b" ")

    with pytest.raises(ValueError):
        adapter.verify_bundle_for_launch(prepared, storage)


def test_rejects_container_mount_path_escape(tmp_path, monkeypatch):
    storage, bundle, _ = _frozen_bundle(tmp_path, monkeypatch)
    with pytest.raises(ValueError, match="container input root"):
        adapter.prepare_frozen_v2_probe(bundle, storage, container_input_root="/workspace/../../outside")


def test_runtime_source_transform_fails_closed_for_unrecognized_model(tmp_path):
    with pytest.raises(ValueError, match="pinned model|expected.*assignment|model structure"):
        adapter._derive_runtime_script(
            b"import fullmag as fm\n# unknown model shape\n",
            {
                "mesh": {"region_markers": [], "object_region_markers": None},
                "selected_equilibrium": {"bundle_path": "input/state/equilibrium/eq.json"},
            },
            "/workspace/benchmark-input",
        )
