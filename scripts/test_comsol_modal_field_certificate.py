#!/usr/bin/env python3
"""Tests for the independent COMSOL modal field certificate."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import math
from pathlib import Path
import struct

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = REPO_ROOT / "scripts" / "comsol_modal_field_certificate.py"


def load_module():
    spec = importlib.util.spec_from_file_location("comsol_modal_field_certificate", MODULE_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def encode_vectors(vectors: list[tuple[complex, complex, complex]]) -> bytes:
    values: list[float] = []
    for vector in vectors:
        for component in vector:
            values.extend((component.real, component.imag))
    return struct.pack(f"<{len(values)}d", *values)


def write_case(
    root: Path,
    *,
    vectors: list[tuple[complex, complex, complex]],
    raw_mode_index: int = 7,
    boundary_pairs: list[dict] | None = None,
    payload_override: bytes | None = None,
) -> tuple[Path, Path]:
    case_dir = root / "case"
    vector_path = case_dir / "eigen" / "mode_fields" / "sample_0000" / f"mode_{raw_mode_index:04d}" / "vector.bin"
    mode_path = case_dir / "eigen" / "modes" / "sample_0000" / f"mode_{raw_mode_index:04d}.json"
    vector_path.parent.mkdir(parents=True)
    mode_path.parent.mkdir(parents=True)

    data = encode_vectors(vectors) if payload_override is None else payload_override
    vector_path.write_bytes(data)
    digest = f"sha256:{hashlib.sha256(data).hexdigest()}"

    if boundary_pairs is None:
        boundary_pairs = [
            {"pair_id": "x_faces", "translation": [1.0, 0.0, 0.0]},
        ]
    backend_plan = {
        "mesh": {
            "nodes": [
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [1.0, 1.0, 0.0],
            ],
            "periodic_node_pairs": [
                {"pair_id": "x_faces", "node_a": 0, "node_b": 1},
                {"pair_id": "x_faces", "node_a": 2, "node_b": 3},
            ],
            "periodic_boundary_pairs": boundary_pairs,
        },
        "spin_wave_bc": {"kind": "floquet", "pair_ids": ["x_faces"]},
        "k_sampling": {
            "kind": "single",
            "vector_rad_per_m": [math.pi / 2.0, 0.0, 0.0],
        },
    }
    (case_dir / "metadata.json").write_text(
        json.dumps({"execution_plan": {"backend_plan": backend_plan}}),
        encoding="utf-8",
    )
    mode = {
        "schema_version": "eigen_mode.v2",
        "sample_index": 0,
        "raw_mode_index": raw_mode_index,
        "k_vector": [math.pi / 2.0, 0.0, 0.0],
        "source_mesh_identity": {
            "indexing": "full_domain_node_order",
            "node_count": len(vectors),
        },
        "mode_field_sample_count": len(vectors),
        "complex_pair_count": len(vectors) * 3,
        "payload_value_count": len(vectors) * 6,
        "payload_sha256": digest,
        "payload_encoding": "f64_interleaved_real_imag_xyz",
        "binary_layout": "complex_f64_pairs_little_endian",
        "component_basis": "global_xyz",
        "value_kind": "complex_spatial_vector",
        "component_count": 3,
        "compatibility_binary_payload_path": (
            f"eigen/mode_fields/sample_0000/mode_{raw_mode_index:04d}/vector.bin"
        ),
    }
    mode_path.write_text(json.dumps(mode), encoding="utf-8")
    return case_dir, vector_path


def good_vectors() -> list[tuple[complex, complex, complex]]:
    phase = complex(0.0, -1.0)
    first = (1.0 + 2.0j, 2.0 - 1.0j, 3.0 + 0.5j)
    second = (2.0 + 0.5j, -1.0 + 1.0j, 0.25 - 2.0j)
    return [first, tuple(phase * value for value in first), second, tuple(phase * value for value in second)]


def test_good_selected_raw_mode_is_certified_and_hashes_real_files(tmp_path: Path) -> None:
    module = load_module()
    case_dir, vector_path = write_case(tmp_path, vectors=good_vectors(), raw_mode_index=7)

    report = module.validate_modal_field_certificate(
        case_dir,
        mode_selections=[(0, 7)],
    )

    assert report["status"] == "pass"
    assert report["qualification"] == "QUALIFIED"
    assert report["selection_policy"] == "explicit"
    assert report["requested_modes"] == [{"sample_index": 0, "raw_mode_index": 7}]
    assert report["validated_mode_count"] == 1
    assert len(report["modes"][0]["phase_checks"]) == 2
    hashes = {item["path"]: item["sha256"] for item in report["file_hashes"]}
    assert "metadata.json" in hashes
    assert hashes["eigen/mode_fields/sample_0000/mode_0007/vector.bin"] == (
        f"sha256:{hashlib.sha256(vector_path.read_bytes()).hexdigest()}"
    )


def test_zero_endpoint_pair_is_vacuous_when_group_has_informative_pair(tmp_path: Path) -> None:
    module = load_module()
    vectors = good_vectors()
    vectors[2] = (0j, 0j, 0j)
    vectors[3] = (0j, 0j, 0j)
    case_dir, _ = write_case(tmp_path, vectors=vectors)

    report = module.validate_modal_field_certificate(case_dir, mode_selections=[(0, 7)])

    assert report["status"] == "pass"
    assert report["modes"][0]["phase_checks"][1]["phase_validation"] == "vacuous_zero_field"
    assert report["modes"][0]["pair_group_status"] == {
        "x_faces": "qualified_informative_field"
    }


def test_wrong_phase_is_rejected_from_vector_bytes(tmp_path: Path) -> None:
    module = load_module()
    vectors = good_vectors()
    vectors[1] = (vectors[1][0] + 0.1, vectors[1][1], vectors[1][2])
    case_dir, _ = write_case(tmp_path, vectors=vectors)

    report = module.validate_modal_field_certificate(case_dir, mode_selections=[(0, 7)])

    assert report["status"] == "fail"
    assert any("phase residual" in reason for reason in report["reasons"])


def test_missing_boundary_pair_id_fails_closed(tmp_path: Path) -> None:
    module = load_module()
    case_dir, _ = write_case(tmp_path, vectors=good_vectors(), boundary_pairs=[])

    report = module.validate_modal_field_certificate(case_dir, mode_selections=[(0, 7)])

    assert report["status"] == "fail"
    assert "x_faces" in report["pair_contract"]["missing_pair_ids"]
    assert any("absent from periodic_boundary_pairs" in reason for reason in report["reasons"])


def test_identically_zero_field_is_not_a_certificate(tmp_path: Path) -> None:
    module = load_module()
    zero = [(0j, 0j, 0j) for _ in range(4)]
    case_dir, _ = write_case(tmp_path, vectors=zero)

    report = module.validate_modal_field_certificate(case_dir, mode_selections=[(0, 7)])

    assert report["status"] == "fail"
    assert any("identically zero" in reason for reason in report["reasons"])


def test_nonfinite_field_is_rejected(tmp_path: Path) -> None:
    module = load_module()
    vectors = good_vectors()
    vectors[0] = (complex(float("nan"), 0.0), vectors[0][1], vectors[0][2])
    case_dir, _ = write_case(tmp_path, vectors=vectors)

    report = module.validate_modal_field_certificate(case_dir, mode_selections=[(0, 7)])

    assert report["status"] == "fail"
    assert any("non-finite" in reason for reason in report["reasons"])


def test_wrong_payload_length_is_rejected(tmp_path: Path) -> None:
    module = load_module()
    data = encode_vectors(good_vectors())[:-8]
    case_dir, _ = write_case(tmp_path, vectors=good_vectors(), payload_override=data)

    report = module.validate_modal_field_certificate(case_dir, mode_selections=[(0, 7)])

    assert report["status"] == "fail"
    assert any("length" in reason for reason in report["reasons"])


def test_missing_explicit_mode_selection_does_not_scan_another_raw_mode(tmp_path: Path) -> None:
    module = load_module()
    case_dir, _ = write_case(tmp_path, vectors=good_vectors(), raw_mode_index=7)

    report = module.validate_modal_field_certificate(case_dir, mode_selections=[(0, 99)])

    assert report["status"] == "fail"
    assert report["mode_count"] == 0
    assert any("selected mode (0, 99) metadata is missing" in reason for reason in report["reasons"])



@pytest.mark.parametrize("trace_amplitude", [0.0, 1e-100])
def test_nonzero_interior_mode_with_zero_or_roundoff_sized_trace_is_valid(tmp_path, trace_amplitude):
    module = load_module()
    vectors = [(complex(trace_amplitude), 0j, 0j)] * 4 + [(1+0j, 0j, 0j)]
    case_dir, _ = write_case(tmp_path, vectors=vectors)
    path = case_dir / "metadata.json"
    metadata = json.loads(path.read_text(encoding="utf-8"))
    metadata["execution_plan"]["backend_plan"]["mesh"]["nodes"].append([0.5, 0.5, 0.0])
    path.write_text(json.dumps(metadata), encoding="utf-8")
    report = module.validate_modal_field_certificate(case_dir, mode_selections=[(0, 7)])
    assert report["status"] == "pass", report["reasons"]
    assert report["modes"][0]["phase_checks"][0]["relative_residual"] < 1e-8
