#!/usr/bin/env python3
"""Regression tests for canonical Ku equilibrium/state artifact migration."""

from __future__ import annotations

import copy
import importlib.util
import json
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_ROOT = REPO_ROOT / "scripts"
if str(SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_ROOT))


def _load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


verifier = _load_module(
    SCRIPTS_ROOT / "verify_fem_frequency_domain_eigen_artifacts.py",
    "v8_verifier",
)
fixture_source = _load_module(
    SCRIPTS_ROOT / "test_verify_fem_frequency_domain_eigen_artifacts.py",
    "v8_fixture_source",
)

from comsol_equilibrium_artifacts import sample_state_paths
from comsol_linearization_binding import validate_linearization_binding


CANONICAL_SIGNATURE = "sha256:" + "c" * 64
EQUILIBRIUM_RAW_SIGNATURE = "sha256:" + "d" * 64
STATE_RAW_SIGNATURE = "sha256:" + "e" * 64
HANDOFF = {
    "equilibrium_artifact_schema": "equilibrium_artifact.v8",
    "linearization_state_schema": "LinearizationState.v7",
    "accepted_for_frequency_operator": True,
}


def _seal_equilibrium(artifact: dict, schema: str) -> dict:
    artifact.pop("content_sha256", None)
    artifact.pop("equilibrium_id", None)
    if schema == "equilibrium_artifact.v8":
        digest = verifier.equilibrium_artifact_v8_digest(artifact)
    else:
        digest = verifier.equilibrium_artifact_v7_digest(artifact)
    artifact["content_sha256"] = digest
    artifact["equilibrium_id"] = f"{schema}:{digest.removeprefix('sha256:')}"
    return artifact


def _seal_state(state: dict, schema: str = "LinearizationState.v7") -> dict:
    state.pop("content_sha256", None)
    state.pop("linearization_state_id", None)
    digest = verifier.linearization_state_v7_digest(state)
    state["content_sha256"] = digest
    state["linearization_state_id"] = f"{schema}:{digest.removeprefix('sha256:')}"
    return state


def _make_v8_pair(root: Path, *, sample_key: str = "") -> tuple[dict, dict]:
    if not (root / "frequency_domain" / "manifest.v1.json").is_file():
        fixture_source.write_eigen_fixture(root)
        seed_equilibrium = fixture_source.attach_certified_equilibrium_v7(root)
    else:
        seed_equilibrium = json.loads(
            (root / "eigen" / "metadata" / "equilibrium_artifact.v7.json").read_text(
                encoding="utf-8"
            )
        )
    equilibrium = copy.deepcopy(seed_equilibrium)
    equilibrium["schema_version"] = "equilibrium_artifact.v8"
    equilibrium["material_signature"] = CANONICAL_SIGNATURE
    equilibrium["material_identity_kind"] = "canonical_equilibrium_material.v2"
    equilibrium["material_provenance_signature"] = EQUILIBRIUM_RAW_SIGNATURE
    equilibrium["material_provenance_scope"] = "materialization_plan"
    equilibrium["external_field_a_per_m"] = [0.0, 0.0, 0.0]
    _seal_equilibrium(equilibrium, "equilibrium_artifact.v8")

    state = {
        "schema_version": "LinearizationState.v7",
        "accepted_for_frequency_operator": True,
        "source_equilibrium_artifact": equilibrium["content_sha256"],
        "source_equilibrium_id": equilibrium["equilibrium_id"],
        "m0": copy.deepcopy(equilibrium["m0"]),
        "mesh_signature": equilibrium["mesh_signature"],
        "material_signature": CANONICAL_SIGNATURE,
        "material_identity_kind": "canonical_equilibrium_material.v2",
        "material_provenance_signature": STATE_RAW_SIGNATURE,
        "material_provenance_scope": "materialization_plan",
        "physics_signature": equilibrium["physics_signature"],
        "boundary_signature": equilibrium["boundary_signature"],
        "static_demag_signature": equilibrium["static_demag_signature"],
    }
    _seal_state(state)

    relative_directory = (
        Path("eigen") / "metadata" / sample_key
        if sample_key
        else Path("eigen") / "metadata"
    )
    equilibrium_path = root / relative_directory / "equilibrium_artifact.v8.json"
    state_path = root / relative_directory / "linearization_state.v7.json"
    equilibrium_path.parent.mkdir(parents=True, exist_ok=True)
    equilibrium_path.write_text(json.dumps(equilibrium), encoding="utf-8")
    state_path.write_text(json.dumps(state), encoding="utf-8")
    return equilibrium, state


def _v8_manifest(root: Path, *, plural: bool = False) -> tuple[dict, dict]:
    manifest_path = root / "frequency_domain" / "manifest.v1.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    artifacts = manifest["artifacts"]
    for key in list(artifacts):
        if key.startswith("equilibrium_artifact_v7") or key.startswith(
            "linearization_state_v6"
        ):
            artifacts.pop(key)
    if plural:
        artifacts["equilibrium_artifact_v8_paths"] = [
            "eigen/metadata/sample_0000/equilibrium_artifact.v8.json",
            "eigen/metadata/sample_0001/equilibrium_artifact.v8.json",
        ]
        artifacts["linearization_state_v7_paths"] = [
            "eigen/metadata/sample_0000/linearization_state.v7.json",
            "eigen/metadata/sample_0001/linearization_state.v7.json",
        ]
        manifest.pop("equilibrium_artifact_sha256", None)
        manifest.pop("linearization_state_sha256", None)
    else:
        artifacts["equilibrium_artifact_v8_path"] = (
            "eigen/metadata/equilibrium_artifact.v8.json"
        )
        artifacts["linearization_state_v7_path"] = (
            "eigen/metadata/linearization_state.v7.json"
        )
        equilibrium = json.loads(
            (root / "eigen" / "metadata" / "equilibrium_artifact.v8.json").read_text(
                encoding="utf-8"
            )
        )
        state = json.loads(
            (root / "eigen" / "metadata" / "linearization_state.v7.json").read_text(
                encoding="utf-8"
            )
        )
        manifest["equilibrium_artifact_sha256"] = equilibrium["content_sha256"]
        manifest["linearization_state_sha256"] = state["content_sha256"]
    manifest["diagnostics"]["linearization_handoff"] = copy.deepcopy(HANDOFF)
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    solver_path = root / "eigen" / "diagnostics" / "solver.v1.json"
    solver = json.loads(solver_path.read_text(encoding="utf-8"))
    solver["linearization_handoff"] = copy.deepcopy(HANDOFF)
    solver_path.write_text(json.dumps(solver), encoding="utf-8")
    return manifest, solver


def _legacy_state(equilibrium: dict) -> dict:
    state = {
        "schema_version": "LinearizationState.v6",
        "accepted_for_frequency_operator": True,
        "source_equilibrium_artifact": equilibrium["content_sha256"],
        "source_equilibrium_id": equilibrium["equilibrium_id"],
        "m0": copy.deepcopy(equilibrium["m0"]),
        "mesh_signature": equilibrium["mesh_signature"],
        "material_signature": equilibrium["material_signature"],
        "physics_signature": equilibrium["physics_signature"],
        "boundary_signature": equilibrium["boundary_signature"],
        "static_demag_signature": equilibrium["static_demag_signature"],
    }
    return _seal_state(state, "LinearizationState.v6")


def test_v8_accepts_distinct_raw_provenance_for_state() -> None:
    equilibrium = {
        "schema_version": "equilibrium_artifact.v8",
        "material_signature": CANONICAL_SIGNATURE,
        "material_identity_kind": "canonical_equilibrium_material.v2",
        "material_provenance_signature": EQUILIBRIUM_RAW_SIGNATURE,
        "material_provenance_scope": "materialization_plan",
    }
    state = {
        "schema_version": "LinearizationState.v7",
        "material_signature": CANONICAL_SIGNATURE,
        "material_identity_kind": "canonical_equilibrium_material.v2",
        "material_provenance_signature": STATE_RAW_SIGNATURE,
        "material_provenance_scope": "materialization_plan",
    }
    assert verifier.validate_canonical_equilibrium_material_identity(
        equilibrium, "equilibrium"
    ) == (CANONICAL_SIGNATURE, EQUILIBRIUM_RAW_SIGNATURE)
    assert verifier.validate_canonical_equilibrium_material_identity(
        state, "state"
    ) == (CANONICAL_SIGNATURE, STATE_RAW_SIGNATURE)


def test_v8_pair_validates_and_binds_canonical_material(tmp_path: Path) -> None:
    equilibrium, state = _make_v8_pair(tmp_path)
    verifier.validate_equilibrium_artifact_v8_payload(
        equilibrium, equilibrium["content_sha256"]
    )
    verifier.validate_linearization_state_v7_payload(
        state, equilibrium, state["content_sha256"]
    )


@pytest.mark.parametrize(
    "field",
    [
        "material_signature",
        "material_identity_kind",
        "material_provenance_signature",
        "material_provenance_scope",
    ],
)
def test_v8_requires_all_identity_fields(tmp_path: Path, field: str) -> None:
    equilibrium, _ = _make_v8_pair(tmp_path)
    equilibrium.pop(field)
    _seal_equilibrium(equilibrium, "equilibrium_artifact.v8")
    with pytest.raises(SystemExit, match="material"):
        verifier.validate_equilibrium_artifact_v8_payload(equilibrium)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("material_identity_kind", "raw_material.v1"),
        ("material_provenance_scope", "original_authored_relaxation"),
        ("material_signature", "sha256:ABC"),
        ("material_provenance_signature", "sha256:not-a-digest"),
    ],
)
def test_v8_rejects_unknown_identity_values(
    tmp_path: Path, field: str, value: str
) -> None:
    equilibrium, _ = _make_v8_pair(tmp_path)
    equilibrium[field] = value
    _seal_equilibrium(equilibrium, "equilibrium_artifact.v8")
    with pytest.raises(SystemExit, match="material"):
        verifier.validate_equilibrium_artifact_v8_payload(equilibrium)


def test_v8_rejects_state_canonical_mismatch_even_when_rehashed(tmp_path: Path) -> None:
    equilibrium, state = _make_v8_pair(tmp_path)
    state["material_signature"] = "sha256:" + "f" * 64
    _seal_state(state)
    with pytest.raises(SystemExit, match="material_signature"):
        verifier.validate_linearization_state_v7_payload(state, equilibrium)


def test_legacy_v7_rejects_v8_identity_fields(tmp_path: Path) -> None:
    fixture_source.write_eigen_fixture(tmp_path)
    equilibrium = copy.deepcopy(fixture_source.attach_certified_equilibrium_v7(tmp_path))
    equilibrium["material_identity_kind"] = "canonical_equilibrium_material.v2"
    _seal_equilibrium(equilibrium, "equilibrium_artifact.v7")
    with pytest.raises(SystemExit, match="not allowed"):
        verifier.validate_equilibrium_artifact_v7_payload(equilibrium)


def test_legacy_v7_v6_pair_still_validates(tmp_path: Path) -> None:
    fixture_source.write_eigen_fixture(tmp_path)
    equilibrium = copy.deepcopy(fixture_source.attach_certified_equilibrium_v7(tmp_path))
    state = _legacy_state(equilibrium)
    verifier.validate_linearization_state_v6_payload(
        state, equilibrium, state["content_sha256"]
    )


def test_v8_bundle_validator_accepts_actual_handoff(tmp_path: Path) -> None:
    equilibrium, state = _make_v8_pair(tmp_path)
    manifest, solver = _v8_manifest(tmp_path)
    manifest["artifacts"]["equilibrium_artifact_v7_paths"] = []
    manifest["artifacts"]["linearization_state_v6_paths"] = []
    verifier.validate_equilibrium_artifacts(tmp_path, manifest, solver)
    assert equilibrium["material_provenance_signature"] != state[
        "material_provenance_signature"
    ]


def test_v8_bundle_validator_accepts_paired_plural_paths(tmp_path: Path) -> None:
    _make_v8_pair(tmp_path, sample_key="sample_0000")
    equilibrium, state = _make_v8_pair(tmp_path, sample_key="sample_0001")
    manifest, solver = _v8_manifest(tmp_path, plural=True)
    verifier.validate_equilibrium_artifacts(tmp_path, manifest, solver)
    assert equilibrium["content_sha256"] == state["source_equilibrium_artifact"]


def test_bundle_validator_rejects_mixed_schema_families(tmp_path: Path) -> None:
    _make_v8_pair(tmp_path)
    manifest, solver = _v8_manifest(tmp_path)
    manifest["artifacts"]["equilibrium_artifact_v7_path"] = (
        "eigen/metadata/equilibrium_artifact.v7.json"
    )
    with pytest.raises(SystemExit, match="mix"):
        verifier.validate_equilibrium_artifacts(tmp_path, manifest, solver)


def test_bundle_validator_rejects_singular_and_plural_ambiguity(tmp_path: Path) -> None:
    _make_v8_pair(tmp_path)
    manifest, solver = _v8_manifest(tmp_path)
    manifest["artifacts"]["equilibrium_artifact_v8_paths"] = [
        "eigen/metadata/equilibrium_artifact.v8.json"
    ]
    with pytest.raises(SystemExit, match="ambiguous"):
        verifier.validate_equilibrium_artifacts(tmp_path, manifest, solver)


def test_comsol_selector_accepts_v8_plural_pair_and_matches_keys() -> None:
    manifest = {
        "artifacts": {
            "equilibrium_artifact_v8_paths": [
                "eigen/metadata/sample_0000/equilibrium_artifact.v8.json",
                "eigen/metadata/sample_0001/equilibrium_artifact.v8.json",
            ],
            "linearization_state_v7_paths": [
                "eigen/metadata/sample_0000/linearization_state.v7.json",
                "eigen/metadata/sample_0001/linearization_state.v7.json",
            ],
        }
    }
    assert sample_state_paths(manifest, 1) == (
        "eigen/metadata/sample_0001/equilibrium_artifact.v8.json",
        "eigen/metadata/sample_0001/linearization_state.v7.json",
    )


def test_comsol_selector_ignores_empty_legacy_path_arrays() -> None:
    manifest = {
        "artifacts": {
            "equilibrium_artifact_v8_path": "eigen/metadata/equilibrium_artifact.v8.json",
            "linearization_state_v7_path": "eigen/metadata/linearization_state.v7.json",
            "equilibrium_artifact_v7_paths": [],
            "linearization_state_v6_paths": [],
        }
    }
    assert sample_state_paths(manifest, 0) == (
        "eigen/metadata/equilibrium_artifact.v8.json",
        "eigen/metadata/linearization_state.v7.json",
    )


@pytest.mark.parametrize("key", ["equilibrium_artifact_v7_path", "linearization_state_v6_paths"])
@pytest.mark.parametrize("value", [None, "bad-list"])
def test_comsol_selector_rejects_malformed_legacy_placeholders(key: str, value: object) -> None:
    manifest = {
        "artifacts": {
            "equilibrium_artifact_v8_path": "eigen/metadata/equilibrium_artifact.v8.json",
            "linearization_state_v7_path": "eigen/metadata/linearization_state.v7.json",
            key: value,
        }
    }
    with pytest.raises(ValueError):
        sample_state_paths(manifest, 0)


def test_comsol_selector_rejects_v8_plural_key_mismatch() -> None:
    manifest = {
        "artifacts": {
            "equilibrium_artifact_v8_paths": [
                "eigen/metadata/sample_0000/equilibrium_artifact.v8.json"
            ],
            "linearization_state_v7_paths": [
                "eigen/metadata/sample_0001/linearization_state.v7.json"
            ],
        }
    }
    with pytest.raises(ValueError, match="sample filename keys"):
        sample_state_paths(manifest, 0)


def test_v8_binding_accepts_raw_provenance_difference_and_rejects_canonical_difference(
    tmp_path: Path,
) -> None:
    equilibrium, state = _make_v8_pair(tmp_path)
    mode = {
        "equilibrium_artifact_sha256": equilibrium["content_sha256"],
        "linearization_state_sha256": state["content_sha256"],
        "source_mesh_topology_sha256": equilibrium["mesh_signature"],
    }
    result = validate_linearization_binding(
        equilibrium,
        state,
        mode,
        [0],
        node_count=1,
        mesh_signature=equilibrium["mesh_signature"],
    )
    assert result["magnetic_m0"] == equilibrium["m0"]
    state["material_signature"] = "sha256:" + "f" * 64
    _seal_state(state)
    mode["linearization_state_sha256"] = state["content_sha256"]
    with pytest.raises(ValueError, match="canonical material_signature"):
        validate_linearization_binding(
            equilibrium,
            state,
            mode,
            [0],
            node_count=1,
            mesh_signature=equilibrium["mesh_signature"],
        )
