"""Interpreted tests for the fail-closed COMSOL scientific gate."""

from __future__ import annotations

import csv
import copy
import hashlib
import json
import importlib.util
import itertools
import math
import struct
import subprocess
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock


sys.path.insert(0, str(Path(__file__).resolve().parent))
import validate_comsol_dispersion_scientific_gate as gate


REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "packages/fullmag-py/src"))
PARAMETERS = REPO_ROOT / "docs/guides/comsol-dispersion-benchmark/parameters.json"
KPATH = REPO_ROOT / "docs/guides/comsol-dispersion-benchmark/kpath.csv"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    digest.update(path.read_bytes())
    return digest.hexdigest()


def _tracking_fixture_payload(branches):
    """Synthetic assignment records for contract tests, never physical tracking evidence."""
    branches = copy.deepcopy(branches)
    policy = dict(method="overlap_hungarian", overlap_floor=0.5,
                  frequency_window_hz=None, max_branch_gap=0)
    for branch in branches:
        previous = None
        for point in branch["points"]:
            seed = previous is None
            source = "seed" if seed else "modal_overlap_weighted_score"
            point["tracking_score_source"] = source
            point["overlap_prev"] = None if seed else 1.0
            point["tracking_edge"] = dict(
                policy=policy.copy(), score_source=source,
                metric="unavailable" if seed else "consistent_p1_tet4_cartesian_nodal_envelope",
                transition="seed" if seed else "pair",
                previous_sample_index=None if seed else previous["sample_index"],
                previous_raw_mode_index=None if seed else previous["raw_mode_index"],
                skipped_sample_count=0, subspace=None,
            )
            previous = point
    return dict(schema_version="eigen_branches.v2", branches=branches,
                tracking_policy_availability="complete", tracking_method=policy["method"],
                overlap_floor=policy["overlap_floor"], frequency_window_hz=None)


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2), encoding="utf-8")


def _native_mode_diagnostics(mode):
    """Synthetic values using the actual native modal diagnostics field names."""
    frequency = mode["frequency_real_hz"]
    mode.update({
        "phasor_convention": "exp_i_omega_t", "eigenvalue_mapping": "lambda_eq_i_omega",
        "eigenvalue_real": 0.0, "eigenvalue_imag": math.tau * frequency,
        "omega_rad_s": math.tau * frequency, "residual_absolute_l2": 1e-12,
        "residual_relative_l2": 1e-12, "residual_linf": 1e-12, "mass_norm": 1.0,
        "tangent_leakage_mean_abs": 0.0, "tangent_leakage_max_abs": 0.0,
        "gamma0_rad_s_per_A_m": 221100.0, "mu0_T_m_per_A": 1.2566370614359173e-6,
        "gamma_rad_s_T": 221100.0 / 1.2566370614359173e-6,
        "damping_rate_hz": 0.0, "linewidth_fwhm_hz": 0.0,
    })


def _native_metadata(case, mesh_id, airbox_m, requested_modes):
    config_path = REPO_ROOT / "tests/standard_problems/mumag/comsol_nonzero_k_dispersion/config.py"
    spec = importlib.util.spec_from_file_location("comsol_gate_fixture_config", config_path)
    config = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = config
    spec.loader.exec_module(config)
    guide = config.guide_metadata(next(c for c in config.available_cases() if c.key == case))
    guide["geometry"]["air_padding_each_side_m"] = airbox_m
    film_min, film_max = [-1e-7, -1e-7, -5e-9], [1e-7, 1e-7, 5e-9]
    nodes = [[x, y, z] for z in (film_min[2], film_max[2]) for y in (film_min[1], film_max[1]) for x in (film_min[0], film_max[0])]
    node_pairs = [
        {"pair_id": "x_faces", "node_a": index, "node_b": index + 1}
        for index in (0, 2, 4, 6)
    ] + [
        {"pair_id": "y_faces", "node_a": index, "node_b": index + 2}
        for index in (0, 1, 4, 5)
    ]
    tet4_connectivity = [
        [0, 1, 3, 7],
        [0, 3, 2, 7],
        [0, 2, 6, 7],
        [0, 6, 4, 7],
        [0, 4, 5, 7],
        [0, 5, 1, 7],
    ]
    canonical_cells = {
        "types": ["tet4"] * len(tet4_connectivity),
        "offsets": list(range(0, 4 * len(tet4_connectivity) + 1, 4)),
        "nodes": [node for cell in tet4_connectivity for node in cell],
        "global_ordinals": list(range(len(tet4_connectivity))), "mesh_parts": ["magnetic"] * len(tet4_connectivity),
    }
    demag = case != "c0"
    plan = {
        "kind": "fem_eigen", "mesh_name": mesh_id,
        "mesh": {"mesh_name": mesh_id, "nodes": nodes,
            "cells": canonical_cells, "element_markers": [1] * len(tet4_connectivity),
            "facets": {"types": [], "roles": [], "offsets": [0], "nodes": [], "global_ordinals": []},
            "boundary_markers": [], "periodic_node_pairs": node_pairs,
            "periodic_boundary_pairs": [
                {"pair_id": "x_faces", "marker_a": 1, "marker_b": 2, "translation": [2e-7, 0.0, 0.0]},
                {"pair_id": "y_faces", "marker_a": 3, "marker_b": 4, "translation": [0.0, 2e-7, 0.0]},
            ]},
        "mesh_parts": [
            {
                "id": "magnetic_object",
                "role": "magnetic_object",
                "element_selector": {
                    "kind": "element_range",
                    "start": 0,
                    "count": len(tet4_connectivity),
                },
            },
        ],
        "hmax": {"mesh-L1": 5e-9, "mesh-L2": 2.5e-9, "mesh-L3": 1.25e-9}.get(mesh_id, 5e-9), "fe_order": 1,
        "material": {"name": "Permalloy", "saturation_magnetisation": 800000.0,
            "exchange_stiffness": 1.3e-11, "damping": 0.5,
            "uniaxial_anisotropy": None, "anisotropy_axis": None},
        "gyromagnetic_ratio": 221100.0, "external_field": [79577.47154594767, 0.0, 0.0],
        "operator": {"kind": "full_2x2", "include_demag": demag},
        "enable_demag": demag, "enable_exchange": True,
        "equilibrium_magnetization": [[1.0, 0.0, 0.0] for _ in nodes],
        "damping_policy": "ignore", "count": requested_modes,
        "solver_policy": {
            "residual_tolerance": guide["eigensolve"]["eigen_solver"]["relative_tolerance"],
            "max_outer_iterations": guide["eigensolve"]["eigen_solver"]["max_outer_iterations"],
            "max_linear_iterations": guide["eigensolve"]["eigen_solver"]["max_linear_iterations"],
        },
        "spin_wave_bc": {"kind": "floquet" if demag else "periodic", "pair_ids": ["x_faces", "y_faces"]},
        "demag_realization": "poisson_dirichlet" if demag else None,
        "air_box_config": {"factor": 1.0 + 2.0 * airbox_m / 1e-8,
            "grading": 1.4, "boundary_marker": 99, "bc_kind": "dirichlet"},
        "domain_frame": {"object_bounds_min": film_min, "object_bounds_max": film_max,
            "mesh_bounds_min": [-1e-7, -1e-7, -5e-9 - airbox_m],
            "mesh_bounds_max": [1e-7, 1e-7, 5e-9 + airbox_m]},
    }
    return {"problem_meta": {"runtime_metadata": {"comsol_nonzero_k_dispersion": guide}},
            "execution_plan": {"backend_plan": plan}}


def _write_mode_fields(root, samples):
    """Synthetic native-layout Bloch fields, not a FEM eigenmode calculation."""
    metadata = json.loads((root / "metadata.json").read_text(encoding="utf-8"))
    nodes = metadata["execution_plan"]["backend_plan"]["mesh"]["nodes"]
    from comsol_mesh_identity import mesh_topology_fingerprint_v3
    mesh_signature = mesh_topology_fingerprint_v3(metadata["execution_plan"]["backend_plan"]["mesh"])
    field_samples = {sample["sample_index"] for sample in samples}
    for sample in samples:
        index = sample["sample_index"]
        k = sample["k_vector"]
        for mode in sample["modes"][:8]:
            raw = mode["raw_mode_index"]
            mode_metadata = {
                "sample_index": index,
                "raw_mode_index": raw,
                "k_vector": k,
                "frequency_real_hz": mode["frequency_real_hz"],
                "frequency_imag_hz": mode["frequency_imag_hz"],
                "source_mesh_topology_sha256": mesh_signature,
                "source_mesh_identity": {
                    "indexing": "full_domain_node_order",
                    "node_count": len(nodes),
                    "mesh_generation_id": "mesh-generation-primary",
                },
            }
            if index in field_samples:
                values = []
                for node in nodes:
                    argument = sum(a * b for a, b in zip(k, node))
                    phase = complex(math.cos(argument), -math.sin(argument))
                    for value in (0j, phase, 1j * phase):
                        values.extend((value.real, value.imag))
                data = struct.pack(f"<{len(values)}d", *values)
                relative = f"eigen/mode_fields/sample_{index:04}/mode_{raw:04}/vector.bin"
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
                mode_metadata.update({
                    "payload_encoding": "f64_interleaved_real_imag_xyz",
                    "binary_layout": "complex_f64_pairs_little_endian",
                    "component_basis": "global_xyz",
                    "mode_field_sample_count": len(nodes),
                    "compatibility_binary_payload_path": relative,
                    "payload_sha256": "sha256:" + hashlib.sha256(data).hexdigest(),
                })
            _write_json(
                root / f"eigen/modes/sample_{index:04}/mode_{raw:04}.json",
                mode_metadata,
            )

def _attach_ks_equilibrium(root):
    """Synthetic accepted state for gate contracts; no native solve claim."""
    from test_equilibrium_payload_validation import _fresh_artifact, _refresh_digest
    from verify_fem_frequency_domain_eigen_artifacts import serde_json_compact_bytes
    from comsol_mesh_identity import mesh_topology_fingerprint_v2
    metadata = json.loads((root / "metadata.json").read_text())
    plan = metadata["execution_plan"]["backend_plan"]
    signature = mesh_topology_fingerprint_v2(plan["mesh"])
    eq = _fresh_artifact(root / "synthetic_reference")
    eq["external_field_a_per_m"] = plan["external_field"]
    eq["m0"] = plan["equilibrium_magnetization"]
    eq["mesh_signature"] = signature
    for key in ("material_signature", "physics_signature", "boundary_signature", "static_demag_signature"):
        eq[key] = key
    from comsol_equilibrium_artifacts import physics_signature_from_plan
    eq["physics_signature"] = physics_signature_from_plan(plan)
    digest = _refresh_digest(eq)
    state = {key: eq[key] for key in ("mesh_signature", "material_signature", "physics_signature", "boundary_signature", "static_demag_signature")}
    state.update(schema_version="LinearizationState.v6", accepted_for_frequency_operator=True,
                 source_equilibrium_id=eq["equilibrium_id"], source_equilibrium_artifact=digest, m0=eq["m0"])
    state_digest = "sha256:" + hashlib.sha256(serde_json_compact_bytes(state)).hexdigest()
    state.update(content_sha256=state_digest, linearization_state_id="LinearizationState.v6:" + state_digest.removeprefix("sha256:"))
    paths = ("eigen/metadata/sample_0000/equilibrium_artifact.v7.json", "eigen/metadata/sample_0000/linearization_state.v6.json")
    for path, payload in zip(paths, (eq, state)):
        _write_json(root / path, payload)
    manifest_path = root / "frequency_domain/manifest.v1.json"
    manifest = json.loads(manifest_path.read_text())
    manifest.setdefault("artifacts", {}).update(equilibrium_artifact_v7_paths=[paths[0]], linearization_state_v6_paths=[paths[1]])
    _write_json(manifest_path, manifest)
    mode_path = root / "eigen/modes/sample_0000/mode_0000.json"
    mode = json.loads(mode_path.read_text())
    from comsol_mesh_identity import mesh_topology_fingerprint_v3
    mode.update(
        equilibrium_artifact_sha256=digest,
        linearization_state_sha256=state_digest,
        source_mesh_topology_sha256=mesh_topology_fingerprint_v3(plan["mesh"]),
    )
    _write_json(mode_path, mode)


def _primary_equilibrium_material_preimage(material):
    ku = material.get("uniaxial_anisotropy")
    ms_field = material.get("ms_field")
    axis = material.get("anisotropy_axis")
    zero_axis = axis is not None and all(float(value) == 0.0 for value in axis)
    physical_v2 = ku is not None and not (
        float(ku) == 0.0 and (ms_field is not None or zero_axis)
    )
    preimage = {
        "schema_version": (
            "EquilibriumMaterialSignaturePreimage.v2"
            if physical_v2
            else "EquilibriumMaterialSignaturePreimage.v1"
        ),
        "saturation_magnetisation_a_per_m": material["saturation_magnetisation"],
        "exchange_stiffness_j_per_m": material["exchange_stiffness"],
        "saturation_magnetisation_field_a_per_m": ms_field,
        "exchange_stiffness_field_j_per_m": material.get("a_field"),
    }
    if physical_v2:
        raw_axis = axis if axis is not None else [0.0, 0.0, 1.0]
        scale = max(abs(float(value)) for value in raw_axis)
        if scale == 0.0:
            raise ValueError("canonical fixture material axis must be non-zero")
        scaled = [float(value) / scale for value in raw_axis]
        norm = math.hypot(math.hypot(scaled[0], scaled[1]), scaled[2])
        first = next(value for value in scaled if value != 0.0)
        orientation = 1.0 if first > 0.0 else -1.0
        canonical_axis = [
            0.0 if orientation * value / norm == 0.0 else orientation * value / norm
            for value in scaled
        ]
        preimage.update({
            "uniaxial_anisotropy_j_per_m3": 0.0 if float(ku) == 0.0 else ku,
            "canonical_uniaxial_axis": canonical_axis,
        })
    return preimage


def _attach_primary_equilibria(root: Path, samples, *, producer_material=None) -> None:
    """Attach accepted, content-bound synthetic states for the public gate path."""
    from test_equilibrium_payload_validation import _fresh_artifact, _refresh_digest
    from verify_fem_frequency_domain_eigen_artifacts import (
        equilibrium_artifact_v8_digest,
        linearization_state_v7_digest,
        serde_json_compact_bytes,
    )
    from comsol_equilibrium_artifacts import physics_signature_from_plan
    from comsol_mesh_identity import mesh_topology_fingerprint_v2, mesh_topology_fingerprint_v3
    from fem_equilibrium_identity_replay import framed_digest
    from fem_linearization_identity_replay import IDENTITY_FIELDS

    metadata = json.loads((root / "metadata.json").read_text(encoding="utf-8"))
    plan = metadata["execution_plan"]["backend_plan"]
    consumer_material = plan["material"]
    source_material = copy.deepcopy(
        consumer_material if producer_material is None else producer_material
    )
    consumer_is_canonical = consumer_material.get("uniaxial_anisotropy") is not None
    producer_is_canonical = source_material.get("uniaxial_anisotropy") is not None
    canonical_state_family = consumer_is_canonical
    producer_plan = copy.deepcopy(plan)
    producer_plan["material"] = source_material
    mesh = plan["mesh"]
    mesh_signature = mesh_topology_fingerprint_v2(mesh)
    modal_mesh_signature = mesh_topology_fingerprint_v3(mesh)
    producer_material_json = json.dumps(source_material, separators=(",", ":"), ensure_ascii=False)
    producer_material_bytes = producer_material_json.encode("utf-8")
    producer_material_signature = "sha256:" + hashlib.sha256(producer_material_bytes).hexdigest()
    consumer_material_json = json.dumps(consumer_material, separators=(",", ":"), ensure_ascii=False)
    consumer_material_bytes = consumer_material_json.encode("utf-8")
    consumer_material_signature = "sha256:" + hashlib.sha256(consumer_material_bytes).hexdigest()
    material_preimage = _primary_equilibrium_material_preimage(source_material)
    material_preimage_json = json.dumps(material_preimage, separators=(",", ":"), ensure_ascii=False)
    material_signature = framed_digest(
        material_preimage["schema_version"],
        material_preimage_json.encode("utf-8"),
    )
    static_preimage = {
        "schema_version": "EquilibriumStaticPhysicsSignaturePreimage.v1",
        "enable_exchange": producer_plan["enable_exchange"],
        "enable_demag": producer_plan["enable_demag"],
        "external_field_a_per_m": producer_plan.get("external_field"),
    }
    static_preimage_json = json.dumps(static_preimage, separators=(",", ":"), ensure_ascii=False)
    static_signature = framed_digest(
        "EquilibriumStaticPhysicsSignaturePreimage.v1",
        static_preimage_json.encode("utf-8"),
    )
    boundary_preimage = {
        "schema_version": "EquilibriumBoundarySignaturePreimage.v1",
        "exchange_bc": "neumann",
        "demag_realization": producer_plan.get("demag_realization"),
        "air_box_config": producer_plan.get("air_box_config"),
        "periodic_node_pairs": mesh.get("periodic_node_pairs", []),
        "periodic_boundary_pairs": mesh.get("periodic_boundary_pairs", []),
    }
    boundary_preimage_json = json.dumps(boundary_preimage, separators=(",", ":"), ensure_ascii=False)
    boundary_signature = framed_digest(
        "EquilibriumBoundarySignaturePreimage.v1",
        boundary_preimage_json.encode("utf-8"),
    )
    source_run_id = "synthetic-source-run"
    source_stage_id = "synthetic-source-stage"
    source_stage_kind = "relaxation"
    source_snapshot = "a" * 64
    equilibrium_template = _fresh_artifact(root / "_synthetic_reference")
    equilibrium_paths = []
    state_paths = []
    state_digests = {}
    identity_paths = []
    identity_preimage_paths = []
    identity_hashes = {}

    for sample in samples:
        sample_index = sample["sample_index"]
        folder = f"sample_{sample_index:04d}"
        equilibrium_schema = (
            "equilibrium_artifact.v8" if canonical_state_family else "equilibrium_artifact.v7"
        )
        state_schema = "LinearizationState.v7" if canonical_state_family else "LinearizationState.v6"
        equilibrium_filename = (
            "equilibrium_artifact.v8.json" if canonical_state_family else "equilibrium_artifact.v7.json"
        )
        state_filename = (
            "linearization_state.v7.json" if canonical_state_family else "linearization_state.v6.json"
        )
        equilibrium_relative = f"eigen/metadata/{folder}/{equilibrium_filename}"
        state_relative = f"eigen/metadata/{folder}/{state_filename}"
        equilibrium = copy.deepcopy(equilibrium_template)
        equilibrium.update({
            "schema_version": equilibrium_schema,
            "external_field_a_per_m": producer_plan["external_field"],
            "m0": producer_plan["equilibrium_magnetization"],
            "mesh_signature": mesh_signature,
            "material_signature": material_signature if consumer_is_canonical else producer_material_signature,
            "physics_signature": physics_signature_from_plan(producer_plan),
            "boundary_signature": boundary_signature,
            "static_demag_signature": static_signature,
            "producer_run_id": source_run_id,
        })
        if consumer_is_canonical:
            equilibrium.update({
                "material_identity_kind": "canonical_equilibrium_material.v2",
                "material_provenance_signature": consumer_material_signature,
                "material_provenance_scope": "materialization_plan",
            })
            equilibrium_digest = equilibrium_artifact_v8_digest(equilibrium)
            equilibrium["content_sha256"] = equilibrium_digest
            equilibrium["equilibrium_id"] = (
                "equilibrium_artifact.v8:" + equilibrium_digest.removeprefix("sha256:")
            )
        else:
            equilibrium_digest = _refresh_digest(equilibrium)

        linearization_state = {
            key: equilibrium[key]
            for key in (
                "mesh_signature",
                "material_signature",
                "physics_signature",
                "boundary_signature",
                "static_demag_signature",
            )
        }
        linearization_state.update({
            "schema_version": state_schema,
            "accepted_for_frequency_operator": True,
            "source_equilibrium_id": equilibrium["equilibrium_id"],
            "source_equilibrium_artifact": equilibrium_digest,
            "m0": producer_plan["equilibrium_magnetization"],
        })
        if consumer_is_canonical:
            linearization_state.update({
                "material_identity_kind": "canonical_equilibrium_material.v2",
                "material_provenance_signature": consumer_material_signature,
                "material_provenance_scope": "materialization_plan",
            })
            state_digest = linearization_state_v7_digest(linearization_state)
            linearization_state.update({
                "content_sha256": state_digest,
                "linearization_state_id": (
                    "LinearizationState.v7:" + state_digest.removeprefix("sha256:")
                ),
            })
        else:
            state_digest = "sha256:" + hashlib.sha256(
                serde_json_compact_bytes(linearization_state)
            ).hexdigest()
            linearization_state.update({
                "content_sha256": state_digest,
                "linearization_state_id": (
                    "LinearizationState.v6:" + state_digest.removeprefix("sha256:")
                ),
            })
        _write_json(root / equilibrium_relative, equilibrium)
        _write_json(root / state_relative, linearization_state)
        equilibrium_paths.append(equilibrium_relative)
        state_paths.append(state_relative)
        state_digests[sample_index] = (equilibrium_digest, state_digest)

        magnetization = producer_plan["equilibrium_magnetization"]
        m0_digest = hashlib.sha256()
        m0_digest.update(b"RecomputedFemLinearizationCertificate.m0.v1\0")
        m0_digest.update(struct.pack("<Q", len(magnetization)))
        for vector in magnetization:
            for value in vector:
                m0_digest.update(struct.pack("<d", float(value)))
        equilibrium_content_signature = "sha256:" + m0_digest.hexdigest()

        producer_payload_version = 2 if producer_is_canonical else 1
        identity = {key: "fixture" for key in sorted(IDENTITY_FIELDS)}
        identity.update({
            "schema_version": "linearization_identity.v2",
            "sample_index": sample_index,
            "equilibrium_artifact_schema": equilibrium_schema,
            "linearization_state_schema": state_schema,
            "accepted_fields_schema": f"CertifiedFemEquilibriumFields.v{producer_payload_version}",
            "certified_fields_schema": f"CertifiedFemEquilibriumFields.v{producer_payload_version}",
            "recomputed_certificate_schema": f"RecomputedFemLinearizationCertificate.v{producer_payload_version}",
            "handoff_schema_version": "AcceptedFemRelaxStageHandoff.v3",
            "handoff_content_sha256": "sha256:" + "b" * 64,
            "source_run_id": source_run_id,
            "source_stage_id": source_stage_id,
            "source_stage_kind": source_stage_kind,
            "producer_plan_snapshot_sha256": "sha256:" + "c" * 64,
            "consumer_plan_snapshot_sha256": "sha256:" + "d" * 64,
            "producer_build_identity": {"source_snapshot_sha256": source_snapshot},
            "consumer_build_identity": {"source_snapshot_sha256": source_snapshot},
            "producer_source_snapshot_sha256": source_snapshot,
            "consumer_source_snapshot_sha256": source_snapshot,
            "cross_build_policy": "same_source_snapshot",
            "source_mesh_topology_sha256": modal_mesh_signature,
            "modal_mesh_topology_fingerprint_v3": modal_mesh_signature,
            "node_count": len(mesh["nodes"]),
            "equilibrium_content_sha256": equilibrium_content_signature,
            "equilibrium_artifact_path": equilibrium_relative,
            "equilibrium_artifact_sha256": equilibrium_digest,
            "linearization_state_path": state_relative,
            "linearization_state_sha256": state_digest,
            "equilibrium_material_signature": material_signature,
            "equilibrium_material_preimage_json": material_preimage_json,
            "equilibrium_static_physics_signature": static_signature,
            "equilibrium_static_physics_preimage_json": static_preimage_json,
            "equilibrium_boundary_signature": boundary_signature,
            "equilibrium_boundary_preimage_json": boundary_preimage_json,
            "material_signature": material_signature if consumer_is_canonical else consumer_material_signature,
            "material_identity_kind": (
                "canonical_equilibrium_material.v2" if consumer_is_canonical else "raw_material.v1"
            ),
            "material_provenance_signature": consumer_material_signature,
            "material_provenance_scope": "materialization_plan",
            "material_provenance_preimage_json": consumer_material_json,
            "producer_material_provenance_signature": producer_material_signature,
            "producer_material_provenance_preimage_json": producer_material_json,
            "accepted_fields_content_sha256": "sha256:" + "e" * 64,
            "accepted_fields_path": f"eigen/metadata/{folder}/accepted_fields.v{producer_payload_version}.json",
            "certified_fields_content_sha256": "sha256:" + "f" * 64,
            "certified_fields_path": f"eigen/metadata/{folder}/certified_fields.v{producer_payload_version}.json",
            "recomputed_certificate_content_sha256": "sha256:" + "1" * 64,
            "recomputed_certificate_path": f"eigen/metadata/{folder}/recomputed_certificate.v{producer_payload_version}.json",
            "accepted_fields_bytes_sha256": "sha256:" + "2" * 64,
            "certified_fields_bytes_sha256": "sha256:" + "3" * 64,
            "recomputed_certificate_bytes_sha256": "sha256:" + "4" * 64,
            "recomputed_certificate_preimage_json": "{}",
            "recomputed_certificate_preimage_sha256": "sha256:" + "5" * 64,
            "content_sha256": "",
        })
        identity_preimage_json = json.dumps(identity, separators=(",", ":"), ensure_ascii=False)
        identity_preimage_bytes = identity_preimage_json.encode("utf-8")
        identity_digest = "sha256:" + hashlib.sha256(
            b"linearization_identity.v2\0"
            + struct.pack("<Q", len(identity_preimage_bytes))
            + identity_preimage_bytes
        ).hexdigest()
        identity["content_sha256"] = identity_digest
        identity_relative = f"eigen/metadata/{folder}/linearization_identity.v2.json"
        identity_preimage_relative = f"eigen/metadata/{folder}/linearization_identity_preimage.v1.json"
        _write_json(root / identity_relative, identity)
        _write_json(root / identity_preimage_relative, {
            "schema_version": "linearization_identity_preimage.v1",
            "identity_schema": "linearization_identity.v2",
            "identity_preimage_json": identity_preimage_json,
            "identity_preimage_sha256": "sha256:" + hashlib.sha256(identity_preimage_bytes).hexdigest(),
            "identity_content_sha256": identity_digest,
        })
        identity_paths.append(identity_relative)
        identity_preimage_paths.append(identity_preimage_relative)
        identity_hashes[str(sample_index)] = identity_digest
        for mode in sample["modes"]:
            mode_relative = (
                f"eigen/modes/sample_{sample_index:04d}/mode_{mode['raw_mode_index']:04d}.json"
            )
            mode_path = root / mode_relative
            mode_metadata = json.loads(mode_path.read_text(encoding="utf-8"))
            mode_metadata.update({
                "equilibrium_artifact_sha256": equilibrium_digest,
                "linearization_state_sha256": state_digest,
                "source_mesh_topology_sha256": modal_mesh_signature,
            })
            _write_json(mode_path, mode_metadata)

    first_equilibrium_digest, first_state_digest = state_digests[min(state_digests)]
    handoff_preimage = {
        "schema_version": "AcceptedFemEigenEquilibriumHandoff.v1",
        "stage_fem_mesh_generation_id": "mesh-generation-primary",
        "source_mesh_topology_sha256": modal_mesh_signature,
        "equilibrium_artifact_sha256": first_equilibrium_digest,
        "linearization_state_sha256": first_state_digest,
    }
    handoff_digest = "sha256:" + hashlib.sha256(
        serde_json_compact_bytes(handoff_preimage)
    ).hexdigest()
    handoff = dict(handoff_preimage, content_sha256=handoff_digest)
    for sample in samples:
        sample_index = sample["sample_index"]
        for mode in sample["modes"]:
            mode_path = root / (
                f"eigen/modes/sample_{sample_index:04d}/mode_{mode['raw_mode_index']:04d}.json"
            )
            mode_metadata = json.loads(mode_path.read_text(encoding="utf-8"))
            mode_metadata.update({
                "relax_to_eigen_handoff_sha256": handoff_digest,
                "relax_to_eigen_source_mesh_topology_sha256": modal_mesh_signature,
            })
            _write_json(mode_path, mode_metadata)
    diagnostics_path = root / "eigen/diagnostics/solver.v1.json"
    solver_diagnostics = json.loads(diagnostics_path.read_text(encoding="utf-8"))
    solver_diagnostics.update({
        "relax_to_eigen_handoff": handoff,
        "relax_to_eigen_handoff_sha256": handoff_digest,
        "relax_to_eigen_source_mesh_topology_sha256": modal_mesh_signature,
    })
    _write_json(diagnostics_path, solver_diagnostics)
    manifest_path = root / "frequency_domain/manifest.v1.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    artifacts = manifest.setdefault("artifacts", {})
    for key in (
        "equilibrium_artifact_v8_paths",
        "linearization_state_v7_paths",
        "equilibrium_artifact_v7_paths",
        "linearization_state_v6_paths",
    ):
        artifacts.pop(key, None)
    if canonical_state_family:
        artifacts.update({
            "equilibrium_artifact_v8_paths": equilibrium_paths,
            "linearization_state_v7_paths": state_paths,
        })
    else:
        artifacts.update({
            "equilibrium_artifact_v7_paths": equilibrium_paths,
            "linearization_state_v6_paths": state_paths,
        })
    artifacts.update({
        "linearization_identity_v2_paths": identity_paths,
        "linearization_identity_preimage_v1_paths": identity_preimage_paths,
        "linearization_identity_sha256_by_sample": identity_hashes,
    })
    _write_json(manifest_path, manifest)

def _rewrite_primary_identity(root: Path, sample_index: int, **changes) -> None:
    identity_path = root / f"eigen/metadata/sample_{sample_index:04d}/linearization_identity.v2.json"
    preimage_path = root / f"eigen/metadata/sample_{sample_index:04d}/linearization_identity_preimage.v1.json"
    identity = json.loads(identity_path.read_text(encoding="utf-8"))
    identity.update(changes)
    preimage = dict(identity, content_sha256="")
    raw = json.dumps(preimage, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    digest = "sha256:" + hashlib.sha256(
        b"linearization_identity.v2\0" + struct.pack("<Q", len(raw)) + raw
    ).hexdigest()
    identity["content_sha256"] = digest
    _write_json(identity_path, identity)
    _write_json(preimage_path, {
        "schema_version": "linearization_identity_preimage.v1",
        "identity_schema": "linearization_identity.v2",
        "identity_preimage_json": raw.decode("utf-8"),
        "identity_preimage_sha256": "sha256:" + hashlib.sha256(raw).hexdigest(),
        "identity_content_sha256": digest,
    })
    manifest_path = root / "frequency_domain/manifest.v1.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["artifacts"]["linearization_identity_sha256_by_sample"][str(sample_index)] = digest
    _write_json(manifest_path, manifest)

def _rewrite_primary_consumer_material(root: Path, sample_index: int, material) -> None:
    raw = json.dumps(material, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    _rewrite_primary_identity(
        root,
        sample_index,
        material_provenance_preimage_json=raw.decode("utf-8"),
        material_provenance_signature="sha256:" + hashlib.sha256(raw).hexdigest(),
    )

def _rewrite_mode_field_with_z_sign_profile(root: Path, *, sample_index: int = 0, raw_mode_index: int = 0) -> None:
    """Rewrite one KS payload with a z+/z- envelope while preserving Bloch seams."""
    metadata = json.loads((root / "metadata.json").read_text(encoding="utf-8"))
    plan = metadata["execution_plan"]["backend_plan"]
    nodes = plan["mesh"]["nodes"]
    spectrum = json.loads((root / "eigen/spectrum.v2.json").read_text(encoding="utf-8"))
    sample = next(item for item in spectrum["samples"] if item["sample_index"] == sample_index)
    k = sample["k_vector"]
    values = []
    for node in nodes:
        argument = sum(a * b for a, b in zip(k, node))
        phase = complex(math.cos(argument), -math.sin(argument))
        sign = -1.0 if node[2] > 0.0 else 1.0
        for value in (0j, sign * phase, 1j * sign * phase):
            values.extend((value.real, value.imag))
    data = struct.pack(f"<{len(values)}d", *values)
    relative = f"eigen/mode_fields/sample_{sample_index:04}/mode_{raw_mode_index:04}/vector.bin"
    (root / relative).write_bytes(data)
    mode_path = root / f"eigen/modes/sample_{sample_index:04}/mode_{raw_mode_index:04}.json"
    mode = json.loads(mode_path.read_text(encoding="utf-8"))
    mode["payload_sha256"] = "sha256:" + hashlib.sha256(data).hexdigest()
    _write_json(mode_path, mode)

def _write_native_context(root, case, mesh_id, airbox_m, requested_modes, samples):
    _write_json(root / "metadata.json", _native_metadata(case, mesh_id, airbox_m, requested_modes))
    _write_json(root / "eigen/diagnostics/solver.v1.json", {
        "schema_version": "frequency_domain_modal_solver_diagnostics.v1",
        "solver_model": gate.PRODUCTION_SOLVER_MODEL, "production_native_solver_available": True,
        "validation_only": False, "complete": True, "status": "ready",
        "requested_mode_count": requested_modes,
        "sample_count": len(samples), "mode_count": sum(len(sample["modes"]) for sample in samples),
    })


def _canonical_path() -> list[dict[str, str]]:
    with KPATH.open(encoding="utf-8", newline="") as stream:
        return list(csv.DictReader(stream))


def _canonical_test_material(name="Permalloy", *, ku=12000.0, axis=None):
    return {
        "name": name,
        "saturation_magnetisation": 800000.0,
        "exchange_stiffness": 1.3e-11,
        "damping": 0.5,
        "uniaxial_anisotropy": ku,
        "anisotropy_axis": [0.0, 0.0, 1.0] if axis is None else axis,
    }

def _bundle_descriptor(case_dir: Path, root: str) -> dict[str, object]:
    relative_paths = {
        "metadata": f"{root}/metadata.json",
        "metadata": f"{root}/metadata.json",
        "diagnostics": f"{root}/eigen/diagnostics/solver.v1.json",
        "spectrum": f"{root}/eigen/spectrum.v2.json",
        "branches": f"{root}/eigen/branches.v2.json",
        "manifest": f"{root}/frequency_domain/manifest.v1.json",
        "diagnostics": f"{root}/eigen/diagnostics/solver.v1.json",
    }
    return {
        "root": root,
        "artifacts": {
            logical: {"path": path, "sha256": _sha256(case_dir / path)}
            for logical, path in relative_paths.items()
        },
    }


def _write_bundle(
    case_dir: Path,
    root: str,
    samples: list[dict[str, object]],
    branches: list[dict[str, object]],
    *,
    mesh_id: str,
    airbox_m: float,
    requested_modes: int,
) -> dict[str, object]:
    for sample in samples:
        for mode in sample["modes"]:
            _native_mode_diagnostics(mode)
    _write_native_context(case_dir / root, case_dir.name, mesh_id, airbox_m, requested_modes, samples)
    _write_json(case_dir / root / "eigen/spectrum.v2.json", {
        "schema_version": "eigen_spectrum.v2",
        "sample_count": len(samples),
        "mode_count": sum(len(sample["modes"]) for sample in samples),
        "samples": samples,
    })
    _write_json(case_dir / root / "eigen/branches.v2.json", _tracking_fixture_payload(branches))
    _write_json(case_dir / root / "frequency_domain/manifest.v1.json", {
        "schema_version": "frequency_domain_manifest.v1",
        "analysis_family": "magnetic_frequency_domain", "study_product": "modal_eigen",
        "resolved_execution": {"reference_or_production": "production"},
        "solver_model": "full_2x2_herring_kittel",
        "mesh_identity": mesh_id,
        "geometry": {"air_padding_each_side_m": airbox_m},
        "requested_mode_count": requested_modes,
        "validation": {
            "dispersion_frequency_source": gate.NUMERIC_FREQUENCY_SOURCE,
            "dynamic_demag_operator_source": "numeric_modal_solver",
        },
    })
    return _bundle_descriptor(case_dir, root)


def _scaled_payload(
    samples: list[dict[str, object]], branches: list[dict[str, object]], scale: float
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    scaled_samples = json.loads(json.dumps(samples))
    scaled_branches = json.loads(json.dumps(branches))
    for sample in scaled_samples:
        for mode in sample["modes"]:
            mode["frequency_real_hz"] *= scale
    for branch in scaled_branches:
        for point in branch["points"]:
            point["frequency_real_hz"] *= scale
    return scaled_samples, scaled_branches


def _evidence(
    case_dir: Path,
    case: str,
    base_artifacts: dict[str, str],
    *,
    ks_bv: dict[str, object] | None = None,
    ks_de: dict[str, object] | None = None,
    convergence_runs: dict[str, dict[str, object]] | None = None,
) -> dict[str, object]:
    sample_indices = gate.EXPECTED_CONTROL_SAMPLES if case in gate.PATH_CASES else (0,)
    bands = range(gate.EXPECTED_TARGET_BANDS if case in gate.PATH_CASES else 1)
    comparisons = [{"sample_index": sample, "branch_id": band} for sample in sample_indices for band in bands]
    runs = convergence_runs or {}
    convergence: dict[str, object] = {
        "mesh": {"status": "pass", "runs": {"coarse": runs.get("mesh_coarse"), "medium": runs.get("mesh_medium"), "fine": runs.get("mesh_fine")}, "comparisons": comparisons},
        "airbox": {"status": "pass", "runs": {"coarse": runs.get("airbox_coarse"), "medium": runs.get("airbox_medium"), "fine": runs.get("airbox_fine")}, "comparisons": comparisons},
        "mode_count": {"status": "pass", "baseline_requested_modes": 24, "check_requested_modes": 48, "runs": {"baseline": runs.get("modes_24"), "check": runs.get("modes_48")}, "comparisons": comparisons},
    }
    if case == "c0":
        convergence["airbox"] = {"status": "not_applicable", "reason": "C0 disables dynamic demagnetization by construction"}
    controls: dict[str, object] = {"kittel": {"status": "pass"}}
    if case == "c1":
        controls["kalinikos_slab_n0"] = {
            "status": "pass",
            "samples": [
                {"geometry": "backward_volume", "k_rad_per_m": 1.0e7, "sample_index": 0, "branch_id": 0, "run": ks_bv},
                {"geometry": "damon_eshbach", "k_rad_per_m": 1.0e7, "sample_index": 0, "branch_id": 0, "run": ks_de},
            ],
        }
    return {
        "schema_version": gate.EVIDENCE_SCHEMA,
        "case_id": case,
        "numeric_run": {"frequency_source": gate.NUMERIC_FREQUENCY_SOURCE, "analytic_solver_used_for_frequencies": False, "dynamic_demag_operator_source": "numeric_modal_solver"},
        "artifact_bindings": base_artifacts,
        "analytic_controls": controls,
        "convergence": convergence,
    }


def _make_case(root: Path, case: str = "c1", *, primary_material=None, producer_material=None) -> Path:
    case_dir = root / case
    path_rows = _canonical_path()
    parameters = json.loads(PARAMETERS.read_text(encoding="utf-8"))
    samples: list[dict[str, object]] = []
    branches: list[dict[str, object]] = [
        {"branch_id": band, "label": f"band_{band}", "points": []}
        for band in range(gate.EXPECTED_TARGET_BANDS)
    ]
    for index, row in enumerate(path_rows if case in gate.PATH_CASES else [path_rows[0]]):
        k = tuple(float(row[key]) for key in ("kx_rad_per_m", "ky_rad_per_m", "kz_rad_per_m"))
        if case == "c0":
            frequencies = [parameters["controls_infinite_film_hz"]["no_demag_gamma"] + band * 1.0e8 for band in range(gate.EXPECTED_TARGET_BANDS)]
        elif index == 0:
            frequencies = [parameters["controls_finite_dirichlet_box"]["with_demag_gamma_hz"] + band * 1.0e8 for band in range(gate.EXPECTED_TARGET_BANDS)]
        else:
            # The path includes the oblique X→M and M→Γ segments.  Build the
            # fixture from the same arbitrary-angle n=0 oracle that the gate
            # recomputes from each exported k-vector; using kx/BV here would
            # make the fixture fail for the right physical reason.
            sin_squared_phi = gate._sin_squared_phi_from_k_vector(k)
            analytic_frequency = gate._kalinikos_frequency_hz_general_phi(
                math.sqrt(k[0] * k[0] + k[1] * k[1]), sin_squared_phi, parameters
            )
            frequencies = [
                (analytic_frequency or 10.0e9) + band * 1.0e8
                for band in range(gate.EXPECTED_TARGET_BANDS)
            ]
        modes = [
            {"raw_mode_index": band, "frequency_real_hz": frequency, "frequency_imag_hz": 0.0}
            for band, frequency in enumerate(frequencies)
        ]
        samples.append({"sample_index": index, "k_vector": list(k), "modes": modes})
        for band, frequency in enumerate(frequencies):
            branches[band]["points"].append({
                "sample_index": index,
                "raw_mode_index": band,
                "frequency_real_hz": frequency,
                "frequency_imag_hz": 0.0,
                "tracking_confidence": 1.0,
            })
    for sample in samples:
        for mode in sample["modes"]:
            _native_mode_diagnostics(mode)
    _write_native_context(case_dir, case, "mesh-L1", 2e-6, 24, samples)
    if primary_material is not None:
        metadata_path = case_dir / "metadata.json"
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        metadata["execution_plan"]["backend_plan"]["material"] = copy.deepcopy(primary_material)
        _write_json(metadata_path, metadata)
    _write_json(case_dir / "eigen/spectrum.v2.json", {
        "schema_version": "eigen_spectrum.v2",
        "sample_count": len(samples),
        "mode_count": sum(len(sample["modes"]) for sample in samples),
        "samples": samples,
    })
    _write_json(case_dir / "eigen/branches.v2.json", _tracking_fixture_payload(branches))
    dispersion = case_dir / "eigen/dispersion.csv"
    dispersion.parent.mkdir(parents=True, exist_ok=True)
    with dispersion.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(
            stream,
            fieldnames=[
                "sample_index", "kx_rad_per_m", "ky_rad_per_m", "kz_rad_per_m",
                "frequency_hz", "raw_mode_index", "branch_id",
                "analytic_frequency_hz", "relative_error", "validation_geometry",
            ],
        )
        writer.writeheader()
        for sample in samples:
            for mode in sample["modes"]:
                vector = tuple(float(value) for value in sample["k_vector"])
                sin_squared_phi = gate._sin_squared_phi_from_k_vector(vector)
                analytic_frequency = (
                    gate._kalinikos_frequency_hz_general_phi(
                        math.sqrt(vector[0] * vector[0] + vector[1] * vector[1]),
                        sin_squared_phi,
                        parameters,
                    )
                    if case == "c1" and sin_squared_phi is not None
                    else None
                )
                geometry = (
                    "backward_volume"
                    if sin_squared_phi is not None and sin_squared_phi <= 1.0e-12
                    else "damon_eshbach"
                    if sin_squared_phi is not None and abs(sin_squared_phi - 1.0) <= 1.0e-12
                    else "oblique"
                    if case == "c1"
                    else ""
                )
                writer.writerow({
                    "sample_index": sample["sample_index"],
                    "kx_rad_per_m": sample["k_vector"][0],
                    "ky_rad_per_m": sample["k_vector"][1],
                    "kz_rad_per_m": sample["k_vector"][2],
                    "frequency_hz": mode["frequency_real_hz"],
                    "raw_mode_index": mode["raw_mode_index"],
                    "branch_id": mode["raw_mode_index"],
                    "analytic_frequency_hz": analytic_frequency if analytic_frequency is not None else "",
                    "relative_error": gate._relative_error(mode["frequency_real_hz"], analytic_frequency) if analytic_frequency is not None else "",
                    "validation_geometry": geometry,
                })
    _write_json(case_dir / "frequency_domain/manifest.v1.json", {
        "schema_version": "frequency_domain_manifest.v1",
        "analysis_family": "magnetic_frequency_domain", "study_product": "modal_eigen",
        "resolved_execution": {"reference_or_production": "production"},
        "solver_model": "full_2x2_herring_kittel",
        "mesh_identity": "base-mesh",
        "geometry": {"air_padding_each_side_m": 2.0e-6},
        "validation": {
            "dispersion_frequency_source": gate.NUMERIC_FREQUENCY_SOURCE,
            "dynamic_demag_operator_source": "numeric_modal_solver",
        },
    })
    _write_mode_fields(case_dir, samples)
    _attach_primary_equilibria(case_dir, samples, producer_material=producer_material)
    base_bindings = {
        "metadata_sha256": _sha256(case_dir / "metadata.json"),
        "solver_diagnostics_sha256": _sha256(case_dir / "eigen/diagnostics/solver.v1.json"),
        "spectrum_v2_sha256": _sha256(case_dir / "eigen/spectrum.v2.json"),
        "branches_v2_sha256": _sha256(case_dir / "eigen/branches.v2.json"),
        "dispersion_csv_sha256": _sha256(case_dir / "eigen/dispersion.csv"),
        "manifest_sha256": _sha256(case_dir / "frequency_domain/manifest.v1.json"),
    }
    ks_bv = ks_de = None
    convergence_runs: dict[str, dict[str, object]] = {}
    if case == "c1":
        parameters = json.loads(PARAMETERS.read_text(encoding="utf-8"))
        bv_frequency = gate._kalinikos_frequency_hz(1.0e7, "backward_volume", parameters)
        de_frequency = gate._kalinikos_frequency_hz(1.0e7, "damon_eshbach", parameters)
        ks_samples = [{"sample_index": 0, "k_vector": [1.0e7, 0.0, 0.0], "modes": [{"raw_mode_index": 0, "frequency_real_hz": bv_frequency, "frequency_imag_hz": 0.0}]}]
        ks_branches = [{"branch_id": 0, "points": [{"sample_index": 0, "raw_mode_index": 0, "frequency_real_hz": bv_frequency, "frequency_imag_hz": 0.0}]}]
        ks_bv = _write_bundle(case_dir, "validation/ks/bv", ks_samples, ks_branches, mesh_id="ks-bv", airbox_m=2.0e-6, requested_modes=1)
        ks_samples_de = [{"sample_index": 0, "k_vector": [0.0, 1.0e7, 0.0], "modes": [{"raw_mode_index": 0, "frequency_real_hz": de_frequency, "frequency_imag_hz": 0.0}]}]
        ks_branches_de = [{"branch_id": 0, "points": [{"sample_index": 0, "raw_mode_index": 0, "frequency_real_hz": de_frequency, "frequency_imag_hz": 0.0}]}]
        ks_de = _write_bundle(case_dir, "validation/ks/de", ks_samples_de, ks_branches_de, mesh_id="ks-de", airbox_m=2.0e-6, requested_modes=1)
        _write_mode_fields(case_dir / "validation/ks/bv", ks_samples)
        _write_mode_fields(case_dir / "validation/ks/de", ks_samples_de)
        for direction in ("bv", "de"):
            _attach_ks_equilibrium(case_dir / f"validation/ks/{direction}")
        ks_bv = _bundle_descriptor(case_dir, "validation/ks/bv")
        ks_de = _bundle_descriptor(case_dir, "validation/ks/de")
    for name, mesh_id, airbox, scale, modes in (("mesh_coarse", "mesh-L1", 2.0e-6, 1.0, 24), ("mesh_medium", "mesh-L2", 2.0e-6, 1.00005, 24), ("mesh_fine", "mesh-L3", 2.0e-6, 1.0001, 24), ("airbox_coarse", "mesh-L1", 2.0e-6, 1.0, 24), ("airbox_medium", "mesh-L1", 4.0e-6, 1.00005, 24), ("airbox_fine", "mesh-L1", 8.0e-6, 1.0001, 24), ("modes_24", "mesh-L1", 2.0e-6, 1.0, 24), ("modes_48", "mesh-L1", 2.0e-6, 1.00005, 48)):
        scaled_samples, scaled_branches = _scaled_payload(samples, branches, scale)
        convergence_runs[name] = _write_bundle(case_dir, f"validation/convergence/{name}", scaled_samples, scaled_branches, mesh_id=mesh_id, airbox_m=airbox, requested_modes=modes)
    evidence = _evidence(case_dir, case, base_bindings, ks_bv=ks_bv, ks_de=ks_de, convergence_runs=convergence_runs)
    _write_json(case_dir / gate.EVIDENCE_RELATIVE_PATH, evidence)
    return case_dir


class ScientificGateTests(unittest.TestCase):
    def test_metadata_requires_explicit_eigen_solver_iteration_policy(self):
        parameters = json.loads(PARAMETERS.read_text(encoding="utf-8"))
        metadata = _native_metadata("c1", "mesh-L1", 2.0e-6, 24)
        metadata["problem_meta"]["runtime_metadata"]["comsol_nonzero_k_dispersion"]["eigensolve"]["eigen_solver"]["max_outer_iterations"] = 0
        reasons = []
        valid = gate._validate_benchmark_metadata(
            metadata,
            "c1",
            parameters,
            "primary",
            reasons,
            require_uniform_slab=True,
        )
        self.assertFalse(valid)
        self.assertTrue(any("max_outer_iterations" in reason for reason in reasons), reasons)

    def test_resolved_backend_policy_cannot_fall_back_to_petcs_defaults(self):
        parameters = json.loads(PARAMETERS.read_text(encoding="utf-8"))
        metadata = _native_metadata("c1", "mesh-L1", 2.0e-6, 24)
        metadata["execution_plan"]["backend_plan"]["solver_policy"]["max_linear_iterations"] = 0
        reasons = []
        valid = gate._validate_benchmark_metadata(
            metadata,
            "c1",
            parameters,
            "primary",
            reasons,
            require_uniform_slab=True,
        )
        self.assertFalse(valid)
        self.assertTrue(any("backend_plan.solver_policy.max_linear_iterations" in reason for reason in reasons), reasons)

    def test_override_kpath_is_compared_to_repository_vectors_not_trusted(self):
        canonical = _canonical_path()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "override.csv"
            for kind in ("all_gamma", "changed_vector", "duplicate_index", "renumbered"):
                rows = copy.deepcopy(canonical)
                if kind == "all_gamma":
                    for row in rows:
                        row.update(kx_rad_per_m="0", ky_rad_per_m="0", kz_rad_per_m="0")
                elif kind == "changed_vector":
                    rows[1]["ky_rad_per_m"] = "1"
                elif kind == "duplicate_index":
                    rows.append(copy.deepcopy(rows[0]))
                else:
                    rows[0]["jpath"] = "100"
                with self.subTest(kind=kind):
                    with path.open("w", encoding="utf-8", newline="") as stream:
                        writer = csv.DictWriter(stream, fieldnames=list(canonical[0]))
                        writer.writeheader()
                        writer.writerows(rows)
                    expected, check, reasons = gate._canonical_path_rows(path)
                    self.assertEqual(check["status"], "fail")
                    self.assertTrue(reasons)
                    self.assertEqual(expected, gate._path_rows(KPATH)[0])
                    self.assertNotEqual(expected[1], (0.0, 0.0, 0.0))

    def test_semantically_identical_kpath_copy_and_missing_reference(self):
        canonical = _canonical_path()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "copy.csv"
            with path.open("w", encoding="utf-8-sig", newline="") as stream:
                writer = csv.DictWriter(stream, fieldnames=list(canonical[0]))
                writer.writeheader()
                for row in canonical:
                    row = dict(row)
                    for key in ("kx_rad_per_m", "ky_rad_per_m", "kz_rad_per_m"):
                        row[key] = format(float(row[key]), ".17e")
                    writer.writerow(row)
            expected, check, reasons = gate._canonical_path_rows(path)
            self.assertEqual(check["status"], "pass", reasons)
            self.assertEqual(len(expected), 61)
            with mock.patch.object(gate, "CANONICAL_KPATH", Path(directory) / "missing.csv"):
                expected, check, reasons = gate._canonical_path_rows(path)
            self.assertEqual(check["status"], "fail")
            self.assertEqual(expected, {})
            self.assertTrue(any("cannot read canonical k-path" in reason for reason in reasons))

    def test_validate_case_has_mandatory_canonical_kpath_check(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            case_dir = _make_case(root, "c1")
            override = root / "all-gamma.csv"
            rows = _canonical_path()
            with override.open("w", encoding="utf-8", newline="") as stream:
                writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
                writer.writeheader()
                for row in rows:
                    row = dict(row)
                    row.update(kx_rad_per_m="0", ky_rad_per_m="0", kz_rad_per_m="0")
                    writer.writerow(row)
            report = gate.validate_case(case_dir, "c1", parameters_path=PARAMETERS, kpath_path=override)
            self.assertEqual(report["checks"]["canonical_kpath"]["status"], "fail")
            self.assertEqual(report["status"], "not_qualified")
            self.assertTrue(any("required scientific check canonical_kpath" in reason for reason in report["reasons"]))
            valid = gate.validate_case(case_dir, "c1", parameters_path=PARAMETERS, kpath_path=KPATH)
            self.assertEqual(valid["checks"]["canonical_kpath"]["status"], "pass")

    def test_canonical_path_requires_an_explicit_pure_de_auxiliary_control(self):
        parameters = json.loads(PARAMETERS.read_text(encoding="utf-8"))
        control = parameters["analytic_controls"]["kalinikos_slab_n0"]
        self.assertEqual(control["damon_eshbach_k_vector_rad_per_m"], [0.0, 1.0e7, 0.0])
        rows = _canonical_path()
        sin_squared = []
        for row in rows:
            kx, ky = float(row["kx_rad_per_m"]), float(row["ky_rad_per_m"])
            norm_squared = kx * kx + ky * ky
            sin_squared.append(0.0 if norm_squared == 0.0 else ky * ky / norm_squared)
        self.assertEqual(len(rows), gate.EXPECTED_PATH_SAMPLE_COUNT)
        self.assertEqual(max(sin_squared), 0.5)
        self.assertFalse(any(abs(value - 1.0) < 1.0e-12 for value in sin_squared))

    def test_selected_fundamental_branch_must_be_lowest_positive_mode(self):
        modes = {(sample, raw): 1.0e9 + raw * 1.0e8 for sample in range(61) for raw in range(8)}
        branches = []
        for branch_id in range(8):
            raw = 1 if branch_id == 0 else 0 if branch_id == 1 else branch_id
            branches.append({
                "branch_id": branch_id,
                "points": [
                    {
                        "sample_index": sample,
                        "raw_mode_index": raw,
                        "frequency_real_hz": modes[(sample, raw)],
                        "frequency_imag_hz": 0.0,
                    }
                    for sample in range(61)
                ],
            })
        reasons = []
        selected, check = gate._validate_branches({"branches": branches}, "c1", modes, reasons)
        self.assertEqual(len(selected), 8)
        self.assertEqual(check["status"], "fail")
        self.assertTrue(any("lowest positive branch" in reason for reason in reasons), reasons)

    def test_airbox_boundary_sweep_is_not_compared_to_primary_same_physics(self):
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(Path(directory), "c1")
            evidence_path = case_dir / gate.EVIDENCE_RELATIVE_PATH
            evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
            # Make the expected finite-boundary trend visible while keeping
            # adjacent increments decreasing: 2->4 um = 0.06%, 4->8 um =
            # 0.02%.  The 8 um result is 0.08% from primary, which is a
            # legitimate boundary shift but would fail the old 2e-4 check.
            for root_name, scale in (("medium", 1.0006), ("fine", 1.0008)):
                descriptor = evidence["convergence"]["airbox"]["runs"][root_name]
                root = case_dir / descriptor["root"]
                spectrum_path = root / "eigen/spectrum.v2.json"
                branches_path = root / "eigen/branches.v2.json"
                spectrum = json.loads(spectrum_path.read_text(encoding="utf-8"))
                branches = json.loads(branches_path.read_text(encoding="utf-8"))
                for sample in spectrum["samples"]:
                    for mode in sample["modes"]:
                        mode["frequency_real_hz"] *= scale
                        _native_mode_diagnostics(mode)
                for branch in branches["branches"]:
                    for point in branch["points"]:
                        point["frequency_real_hz"] *= scale
                _write_json(spectrum_path, spectrum)
                _write_json(branches_path, branches)
                evidence["convergence"]["airbox"]["runs"][root_name] = _bundle_descriptor(
                    case_dir, descriptor["root"]
                )
            _write_json(evidence_path, evidence)
            report = gate.validate_case(case_dir, "c1", parameters_path=PARAMETERS, kpath_path=KPATH)
        self.assertEqual(report["campaign_contract_status"], "pass", report["reasons"][:12])
        airbox_check = report["checks"]["airbox_convergence"]
        self.assertEqual(airbox_check["status"], "pass", report["reasons"][:12])
        self.assertTrue(airbox_check["adjacent_comparisons"])
        self.assertTrue(all(
            item["comparison_reference"] == "adjacent_airbox_boundary_sweep"
            for item in airbox_check["adjacent_comparisons"]
        ))
        self.assertTrue(all(
            item["tolerance"] == gate.AIRBOX_CONVERGENCE_RELATIVE_TOLERANCE
            for item in airbox_check["adjacent_comparisons"]
        ))

    def test_nonzero_k_oracle_does_not_apply_scalar_finite_airbox_correction(self):
        parameters = json.loads(PARAMETERS.read_text(encoding="utf-8"))
        narrow = copy.deepcopy(parameters)
        wide = copy.deepcopy(parameters)
        narrow["geometry"]["air_padding_each_side_m"] = 2.0e-6
        wide["geometry"]["air_padding_each_side_m"] = 8.0e-6
        for k, sin_squared_phi in ((1.0e7, 0.0), (1.0e7, 1.0), (2.0e7, 0.25)):
            with self.subTest(k=k, sin_squared_phi=sin_squared_phi):
                self.assertAlmostEqual(
                    gate._kalinikos_frequency_hz_general_phi(k, sin_squared_phi, narrow),
                    gate._kalinikos_frequency_hz_general_phi(k, sin_squared_phi, wide),
                    places=6,
                )

    def test_comparison_label_cannot_override_missing_native_execution(self):
        for changes in ({"production_native_solver_available": False}, {"validation_only": True}):
            with self.subTest(changes=changes):
                manifest = {"validation": {
                    "dispersion_frequency_source": gate.NUMERIC_FREQUENCY_SOURCE,
                    "dynamic_demag_operator_source": "numeric_modal_solver",
                }}
                diagnostics = {"solver_model": gate.PRODUCTION_SOLVER_MODEL,
                    "production_native_solver_available": True, "validation_only": False, **changes}
                reasons = []
                result = gate._validate_numeric_source(manifest, diagnostics, "c1", reasons)
                self.assertEqual(result["status"], "fail")
                self.assertTrue(reasons)

    def test_csv_corruption_is_rejected_after_rebinding_current_file_hash(self):
        for defect in ("nan", "frequency_mismatch", "duplicate_mode", "k_mismatch"):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as directory:
                case_dir = _make_case(Path(directory), "c1")
                csv_path = case_dir / "eigen/dispersion.csv"
                with csv_path.open(encoding="utf-8", newline="") as stream:
                    reader = csv.DictReader(stream)
                    fields, rows = reader.fieldnames, list(reader)
                if defect == "nan":
                    rows[-1]["frequency_hz"] = "NaN"
                elif defect == "frequency_mismatch":
                    rows[-1]["frequency_hz"] = str(float(rows[-1]["frequency_hz"]) * 1.1)
                elif defect == "duplicate_mode":
                    rows[-1] = dict(rows[-2])
                else:
                    rows[-1]["kx_rad_per_m"] = "1234567"
                with csv_path.open("w", encoding="utf-8", newline="") as stream:
                    writer = csv.DictWriter(stream, fieldnames=fields)
                    writer.writeheader()
                    writer.writerows(rows)
                evidence_path = case_dir / gate.EVIDENCE_RELATIVE_PATH
                evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
                evidence["artifact_bindings"]["dispersion_csv_sha256"] = _sha256(csv_path)
                _write_json(evidence_path, evidence)
                report = gate.validate_case(case_dir, "c1", parameters_path=PARAMETERS, kpath_path=KPATH)
                self.assertEqual(report["status"], "not_qualified")
                self.assertTrue(any("dispersion.csv" in reason for reason in report["reasons"]))
                self.assertFalse(any("binding does not match" in reason for reason in report["reasons"]))

    def test_cli_serializes_real_gate_report(self):
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(Path(directory), "c0")
            process = subprocess.run(
                [sys.executable, "-B", str(REPO_ROOT / "scripts/validate_comsol_dispersion_scientific_gate.py"),
                 str(case_dir), "--case", "c0", "--parameters", str(PARAMETERS)],
                capture_output=True, text=True, encoding="utf-8", check=False,
            )
            self.assertEqual(process.returncode, 0, process.stderr)
            report = json.loads(process.stdout)
            self.assertEqual(report["status"], "qualified")
            self.assertIn("eigen/spectrum.v2.json", report["artifact_bindings"])

    def test_rehashed_wrong_phase_is_not_qualified(self):
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(Path(directory), "c1")
            metadata_path = case_dir / "eigen/modes/sample_0010/mode_0000.json"
            mode = json.loads(metadata_path.read_text(encoding="utf-8"))
            path = case_dir / mode["compatibility_binary_payload_path"]
            data = path.read_bytes()
            values = list(struct.unpack(f"<{len(data)//8}d", data))
            values[8] += 0.5
            data = struct.pack(f"<{len(values)}d", *values)
            path.write_bytes(data)
            mode["payload_sha256"] = "sha256:" + hashlib.sha256(data).hexdigest()
            _write_json(metadata_path, mode)
            report = gate.validate_case(case_dir, "c1", parameters_path=PARAMETERS, kpath_path=KPATH)
            self.assertEqual(report["status"], "not_qualified")
            self.assertTrue(any("phase residual" in reason for reason in report["reasons"]))
            self.assertFalse(any("payload_sha256 does not match" in reason for reason in report["reasons"]))

    def test_bundle_phase_residual_uses_certificate_tolerance(self):
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(Path(directory), "c1")
            spectrum_path = case_dir / "eigen/spectrum.v2.json"
            spectrum = json.loads(spectrum_path.read_text(encoding="utf-8"))
            spectrum["samples"][10]["modes"][0]["phase_constraint_residual"] = 2.0e-8
            _write_json(spectrum_path, spectrum)
            evidence_path = case_dir / gate.EVIDENCE_RELATIVE_PATH
            evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
            evidence["artifact_bindings"]["spectrum_v2_sha256"] = _sha256(spectrum_path)
            _write_json(evidence_path, evidence)
            report = gate.validate_case(case_dir, "c1", parameters_path=PARAMETERS, kpath_path=KPATH)
            self.assertEqual(report["status"], "not_qualified")
            self.assertTrue(any("phase constraint residual" in reason for reason in report["reasons"]))

    def test_valid_gamma_field_cannot_substitute_for_nonzero_k_sample(self):
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(Path(directory), "c1")
            metadata_path = case_dir / "eigen/modes/sample_0010/mode_0000.json"
            mode = json.loads(metadata_path.read_text(encoding="utf-8"))
            values = [0.0, 0.0, 1.0, 0.0, 0.0, 1.0] * mode["mode_field_sample_count"]
            data = struct.pack(f"<{len(values)}d", *values)
            (case_dir / mode["compatibility_binary_payload_path"]).write_bytes(data)
            mode["payload_sha256"] = "sha256:" + hashlib.sha256(data).hexdigest()
            mode["k_vector"] = [0.0, 0.0, 0.0]
            _write_json(metadata_path, mode)
            report = gate.validate_case(case_dir, "c1", parameters_path=PARAMETERS, kpath_path=KPATH)
            self.assertEqual(report["status"], "not_qualified")
            self.assertEqual(report["checks"]["modal_field_phase"]["status"], "fail")
            self.assertTrue(any("wavevector differs from the numeric spectrum" in reason for reason in report["reasons"]))
            self.assertFalse(any("phase residual" in reason for reason in report["reasons"]))

    def test_modal_field_phase_covers_every_selected_path_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(Path(directory), "c1")
            report = gate.validate_case(case_dir, "c1", parameters_path=PARAMETERS, kpath_path=KPATH)
            field_check = report["checks"]["modal_field_phase"]
            coverage = field_check["selection_coverage"]

            self.assertEqual(field_check["status"], "pass")
            self.assertTrue(coverage["complete"])
            self.assertEqual(coverage["expected_sample_count"], 61)
            self.assertEqual(coverage["observed_sample_count"], 61)
            self.assertEqual(coverage["expected_modes_per_sample"], 8)
            self.assertEqual(coverage["expected_mode_count"], 488)
            self.assertEqual(coverage["selected_mode_count"], 488)
            self.assertEqual(coverage["unique_selected_mode_count"], 488)
            self.assertEqual(coverage["certificate_mode_count"], 488)
            self.assertEqual(coverage["validated_mode_count"], 488)
            self.assertEqual(coverage["missing_sample_indices"], [])
            self.assertTrue(all(count == 8 for count in coverage["selected_raw_mode_count_by_sample"].values()))

            requested = field_check["requested_modes"]
            requested_pairs = {
                (item["sample_index"], item["raw_mode_index"])
                for item in requested
            }
            self.assertEqual(len(requested), 488)
            self.assertEqual(len(requested_pairs), 488)
            for sample_index in range(61):
                self.assertEqual(
                    len({raw for sample, raw in requested_pairs if sample == sample_index}),
                    8,
                )

    def test_missing_or_corrupt_j30_modal_field_fails_phase_check(self):
        for damage in ("missing", "corrupt"):
            with self.subTest(damage=damage), tempfile.TemporaryDirectory() as directory:
                case_dir = _make_case(Path(directory), "c1")
                branch_document = json.loads(
                    (case_dir / "eigen/branches.v2.json").read_text(encoding="utf-8")
                )
                first_branch = next(
                    branch for branch in branch_document["branches"]
                    if branch["branch_id"] == 0
                )
                point = next(
                    point for point in first_branch["points"]
                    if point["sample_index"] == 30
                )
                raw_mode = point["raw_mode_index"]
                mode_path = case_dir / f"eigen/modes/sample_0030/mode_{raw_mode:04}.json"
                mode = json.loads(mode_path.read_text(encoding="utf-8"))
                vector_path = case_dir / mode["compatibility_binary_payload_path"]
                if damage == "missing":
                    vector_path.unlink()
                else:
                    data = vector_path.read_bytes()
                    values = list(struct.unpack(f"<{len(data)//8}d", data))
                    values[8] += 0.5
                    data = struct.pack(f"<{len(values)}d", *values)
                    vector_path.write_bytes(data)
                    mode["payload_sha256"] = "sha256:" + hashlib.sha256(data).hexdigest()
                    _write_json(mode_path, mode)

                report = gate.validate_case(
                    case_dir, "c1", parameters_path=PARAMETERS, kpath_path=KPATH
                )
                field_check = report["checks"]["modal_field_phase"]
                self.assertEqual(field_check["status"], "fail")
                self.assertFalse(field_check["selection_coverage"]["complete"])
                self.assertTrue(
                    any("sample_0030" in reason for reason in field_check.get("reasons", [])),
                                    field_check.get("reasons"),
                )

    def test_missing_modal_field_prevents_qualification(self):
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(Path(directory), "c1")
            (case_dir / "eigen/mode_fields/sample_0010/mode_0000/vector.bin").unlink()
            report = gate.validate_case(case_dir, "c1", parameters_path=PARAMETERS, kpath_path=KPATH)
            self.assertEqual(report["status"], "not_qualified")
            self.assertEqual(report["checks"]["modal_field_phase"]["status"], "fail")

    def test_convergence_keeps_target_and_finite_element_order_fixed(self):
        for vary, field, original_value, changed_value in (
            ("mode_count", "target", {"kind": "frequency_window", "frequency_min_hz": 1e6, "frequency_max_hz": 30e9}, {"kind": "frequency_window", "frequency_min_hz": 1e6, "frequency_max_hz": 40e9}),
            ("mesh", "fe_order", 1, 2),
        ):
            with self.subTest(vary=vary):
                original = _native_metadata("c1", "mesh-L1", 2e-6, 24)
                original["execution_plan"]["backend_plan"][field] = original_value
                changed = json.loads(json.dumps(original))
                changed["execution_plan"]["backend_plan"][field] = changed_value
                self.assertNotEqual(gate._backend_signature(original, vary=vary), gate._backend_signature(changed, vary=vary))

    def test_primary_and_comparison_schema_versions_are_required(self):
        for scope in ("primary", "comparison"):
            for payload in ("spectrum", "branches", "manifest"):
                with self.subTest(scope=scope, payload=payload), tempfile.TemporaryDirectory() as directory:
                    case_dir = _make_case(Path(directory), "c1")
                    root = "" if scope == "primary" else "validation/convergence/mesh_medium"
                    relative = {"spectrum": "eigen/spectrum.v2.json", "branches": "eigen/branches.v2.json", "manifest": "frequency_domain/manifest.v1.json"}[payload]
                    artifact_path = case_dir / root / relative
                    data = json.loads(artifact_path.read_text(encoding="utf-8"))
                    data["schema_version"] = "unknown.v999"
                    _write_json(artifact_path, data)
                    evidence_path = case_dir / gate.EVIDENCE_RELATIVE_PATH
                    evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
                    if scope == "comparison":
                        evidence["convergence"]["mesh"]["runs"]["medium"] = _bundle_descriptor(case_dir, root)
                    else:
                        binding = {"spectrum": "spectrum_v2_sha256", "branches": "branches_v2_sha256", "manifest": "manifest_sha256"}[payload]
                        evidence["artifact_bindings"][binding] = _sha256(artifact_path)
                    _write_json(evidence_path, evidence)
                    report = gate.validate_case(case_dir, "c1", parameters_path=PARAMETERS, kpath_path=KPATH)
                    self.assertEqual(report["status"], "not_qualified")
                    self.assertTrue(any(f".{payload} requires schema_version" in reason for reason in report["reasons"]))
                    self.assertFalse(any("binding does not match" in reason or "SHA256 does not match" in reason for reason in report["reasons"]))

    def test_mode_count_comparison_cannot_change_mesh_resolution(self):
        original = _native_metadata("c1", "mesh-L1", 2e-6, 24)
        changed = _native_metadata("c1", "mesh-L2", 2e-6, 48)
        self.assertNotEqual(gate._backend_signature(original, vary="mode_count"), gate._backend_signature(changed, vary="mode_count"))

    def test_airbox_comparison_preserves_magnetic_geometry_and_hmax(self):
        original = _native_metadata("c1", "mesh-L1", 2e-6, 24)
        for defect in ("hmax", "magnetic_bounds"):
            with self.subTest(defect=defect):
                changed = json.loads(json.dumps(original))
                plan = changed["execution_plan"]["backend_plan"]
                if defect == "hmax":
                    plan["hmax"] *= 0.5
                else:
                    plan["domain_frame"]["object_bounds_max"][2] *= 2
                self.assertNotEqual(gate._backend_signature(original, vary="airbox"), gate._backend_signature(changed, vary="airbox"))

    def test_uniform_equilibrium_can_be_resampled_on_a_refined_mesh(self):
        original = _native_metadata("c1", "mesh-L1", 2e-6, 24)
        refined = _native_metadata("c1", "mesh-L2", 2e-6, 24)
        plan = refined["execution_plan"]["backend_plan"]
        plan["equilibrium_magnetization"] *= 2
        self.assertEqual(gate._backend_signature(original, vary="mesh"), gate._backend_signature(refined, vary="mesh"))
        plan["equilibrium_magnetization"][-1] = [0.0, 1.0, 0.0]
        self.assertNotEqual(gate._backend_signature(original, vary="mesh"), gate._backend_signature(refined, vary="mesh"))

    def test_airbox_identity_uses_resolved_bounds_not_authoring_factor(self):
        plan = _native_metadata("c1", "mesh-L1", 2e-6, 24)["execution_plan"]["backend_plan"]
        self.assertAlmostEqual(gate._backend_airbox_value(plan), 2e-6, delta=1e-18)
        plan["air_box_config"]["factor"] *= 10
        self.assertAlmostEqual(gate._backend_airbox_value(plan), 2e-6, delta=1e-18)
        plan.pop("domain_frame")
        self.assertIsNone(gate._backend_airbox_value(plan))

    def test_two_levels_cannot_qualify_mesh_or_airbox_convergence(self):
        for key in ("mesh", "airbox"):
            with self.subTest(key=key), tempfile.TemporaryDirectory() as directory:
                case_dir = _make_case(Path(directory), "c1")
                path = case_dir / gate.EVIDENCE_RELATIVE_PATH
                evidence = json.loads(path.read_text(encoding="utf-8"))
                evidence["convergence"][key]["runs"].pop("medium", None)
                _write_json(path, evidence)
                report = gate.validate_case(case_dir, "c1", parameters_path=PARAMETERS, kpath_path=KPATH)
                self.assertEqual(report["status"], "not_qualified")
                self.assertEqual(report["checks"][f"{key}_convergence"]["status"], "fail")
                self.assertTrue(any(f"convergence.{key}" in reason and "three" in reason for reason in report["reasons"]))

    def test_three_level_convergence_rejects_reused_or_reversed_levels(self):
        for key in ("mesh", "airbox"):
            for defect in ("reused", "reversed"):
                with self.subTest(key=key, defect=defect), tempfile.TemporaryDirectory() as directory:
                    case_dir = _make_case(Path(directory), "c1")
                    path = case_dir / gate.EVIDENCE_RELATIVE_PATH
                    evidence = json.loads(path.read_text(encoding="utf-8"))
                    runs = evidence["convergence"][key]["runs"]
                    if defect == "reused":
                        runs["medium"] = runs["coarse"]
                    else:
                        runs["medium"], runs["fine"] = runs["fine"], runs["medium"]
                    _write_json(path, evidence)
                    report = gate.validate_case(case_dir, "c1", parameters_path=PARAMETERS, kpath_path=KPATH)
                    self.assertEqual(report["checks"][f"{key}_convergence"]["status"], "fail")
                    self.assertEqual(report["status"], "not_qualified")

    def test_small_but_growing_refinement_increments_are_not_convergence(self):
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(Path(directory), "c1")
            path = case_dir / gate.EVIDENCE_RELATIVE_PATH
            evidence = json.loads(path.read_text(encoding="utf-8"))
            samples = json.loads((case_dir / "eigen/spectrum.v2.json").read_text(encoding="utf-8"))["samples"]
            branches = json.loads((case_dir / "eigen/branches.v2.json").read_text(encoding="utf-8"))["branches"]
            samples, branches = _scaled_payload(samples, branches, 1.00019)
            evidence["convergence"]["mesh"]["runs"]["fine"] = _write_bundle(
                case_dir, "validation/convergence/mesh_fine", samples, branches,
                mesh_id="mesh-L3", airbox_m=2e-6, requested_modes=24,
            )
            _write_json(path, evidence)
            report = gate.validate_case(case_dir, "c1", parameters_path=PARAMETERS, kpath_path=KPATH)
            self.assertEqual(report["status"], "not_qualified")
            self.assertEqual(report["checks"]["mesh_convergence"]["status"], "fail")
            self.assertTrue(any("increments grow" in reason for reason in report["reasons"]))
            self.assertTrue(all(check["status"] == "pass" for check in report["checks"]["mesh_convergence"]["adjacent_comparisons"]))

    def test_campaign_contract_pass_cannot_qualify_missing_tracking_replay(self):
        with tempfile.TemporaryDirectory() as directory:
            results = {}
            for case in ("c0", "c1", "a1"):
                with self.subTest(case=case):
                    results[case] = gate.validate_case(
                        _make_case(Path(directory), case), case,
                        parameters_path=PARAMETERS, kpath_path=KPATH,
                    )
                    self.assertEqual(results[case]["campaign_contract_status"], "pass", results[case]["reasons"][:8])
                    self.assertEqual(results[case]["status"], "qualified" if case == "c0" else "not_qualified")
                    if case in gate.PATH_CASES:
                        self.assertEqual(results[case]["qualification"], "NOT VERIFIED")
                        self.assertEqual(results[case]["checks"]["tracking_field_metric_replay"]["status"], "missing")
            self.assertEqual(gate.validate_requested_cases(results, ("c0", "c1", "a1"))["status"], "not_qualified")

    def test_primary_equilibrium_is_mandatory_for_c0_c1_a1(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for case in ("c0", "c1", "a1"):
                with self.subTest(case=case):
                    report = gate.validate_case(
                        _make_case(root, case),
                        case,
                        parameters_path=PARAMETERS,
                        kpath_path=KPATH,
                    )
                    self.assertEqual(
                        report["checks"]["primary_equilibrium"]["status"],
                        "pass",
                        report["checks"]["primary_equilibrium"],
                    )
                    if case in {"c0", "a1"}:
                        self.assertEqual(report["checks"]["kalinikos_slab_n0"]["status"], "not_applicable")

    def test_primary_equilibrium_rejects_stale_and_mismatched_bindings(self):
        defects = (
            "missing_mode",
            "stale_state_hash",
            "wrong_source_run",
            "wrong_source_mesh",
            "wrong_material",
            "wrong_physics",
            "identity_hash",
        )
        for defect in defects:
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as directory:
                case_dir = _make_case(Path(directory), "c0")
                if defect == "missing_mode":
                    (case_dir / "eigen/modes/sample_0000/mode_0000.json").unlink()
                elif defect == "stale_state_hash":
                    path = case_dir / "eigen/metadata/sample_0000/linearization_state.v6.json"
                    state = json.loads(path.read_text(encoding="utf-8"))
                    state["m0"][0][0] = 0.5
                    _write_json(path, state)
                elif defect == "wrong_source_run":
                    _rewrite_primary_identity(case_dir, 0, source_run_id="different-source-run")
                elif defect == "wrong_source_mesh":
                    _rewrite_primary_identity(
                        case_dir,
                        0,
                        source_mesh_topology_sha256="sha256:" + "9" * 64,
                    )
                elif defect == "wrong_material":
                    path = case_dir / "metadata.json"
                    metadata = json.loads(path.read_text(encoding="utf-8"))
                    metadata["execution_plan"]["backend_plan"]["material"][
                        "saturation_magnetisation"
                    ] = 700000.0
                    _write_json(path, metadata)
                elif defect == "wrong_physics":
                    path = case_dir / "metadata.json"
                    metadata = json.loads(path.read_text(encoding="utf-8"))
                    metadata["execution_plan"]["backend_plan"]["external_field"][0] += 100.0
                    _write_json(path, metadata)
                else:
                    path = case_dir / "eigen/metadata/sample_0000/linearization_identity.v2.json"
                    identity = json.loads(path.read_text(encoding="utf-8"))
                    identity["source_stage_id"] = "unbound-stage-edit"
                    _write_json(path, identity)

                report = gate.validate_case(
                    case_dir,
                    "c0",
                    parameters_path=PARAMETERS,
                    kpath_path=KPATH,
                )
                self.assertEqual(
                    report["checks"]["primary_equilibrium"]["status"],
                    "fail",
                    report["checks"]["primary_equilibrium"],
                )
    def test_primary_canonical_v8_v7_reuse_binds_both_raw_material_plans(self):
        producer_material = _canonical_test_material("relaxation-source")
        consumer_material = _canonical_test_material("current-consumer")
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(
                Path(directory),
                "c0",
                primary_material=consumer_material,
                producer_material=producer_material,
            )
            report = gate.validate_case(
                case_dir,
                "c0",
                parameters_path=PARAMETERS,
                kpath_path=KPATH,
            )
            self.assertEqual(
                report["checks"]["primary_equilibrium"]["status"],
                "pass",
                report["checks"]["primary_equilibrium"],
            )
            identity = json.loads(
                (case_dir / "eigen/metadata/sample_0000/linearization_identity.v2.json")
                .read_text(encoding="utf-8")
            )
            equilibrium = json.loads(
                (case_dir / "eigen/metadata/sample_0000/equilibrium_artifact.v8.json")
                .read_text(encoding="utf-8")
            )
            state = json.loads(
                (case_dir / "eigen/metadata/sample_0000/linearization_state.v7.json")
                .read_text(encoding="utf-8")
            )
            self.assertEqual(equilibrium["material_provenance_signature"],
                             identity["material_provenance_signature"])
            self.assertEqual(state["material_provenance_signature"],
                             identity["material_provenance_signature"])
            self.assertNotEqual(identity["producer_material_provenance_signature"],
                                identity["material_provenance_signature"])
            self.assertEqual(identity["material_signature"], equilibrium["material_signature"])

    def test_primary_canonical_v8_v7_rejects_current_physical_material_changes(self):
        changes = (
            ("saturation_magnetisation", 700000.0),
            ("exchange_stiffness", 1.4e-11),
            ("uniaxial_anisotropy", 14000.0),
            ("ms_field", "spatial"),
            ("a_field", "spatial"),
        )
        for field, value in changes:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                consumer_material = _canonical_test_material()
                producer_material = _canonical_test_material("relaxation-source")
                case_dir = _make_case(
                    Path(directory),
                    "c0",
                    primary_material=consumer_material,
                    producer_material=producer_material,
                )
                changed_material = copy.deepcopy(consumer_material)
                if value == "spatial":
                    node_count = len(
                        json.loads((case_dir / "metadata.json").read_text(encoding="utf-8"))
                        ["execution_plan"]["backend_plan"]["mesh"]["nodes"]
                    )
                    field_value = (
                        [800000.0] * node_count if field == "ms_field"
                        else [1.3e-11] * node_count
                    )
                    changed_material[field] = field_value
                else:
                    changed_material[field] = value
                metadata_path = case_dir / "metadata.json"
                metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
                metadata["execution_plan"]["backend_plan"]["material"] = changed_material
                _write_json(metadata_path, metadata)
                _rewrite_primary_consumer_material(case_dir, 0, changed_material)

                report = gate.validate_case(
                    case_dir,
                    "c0",
                    parameters_path=PARAMETERS,
                    kpath_path=KPATH,
                )
                self.assertEqual(
                    report["checks"]["primary_equilibrium"]["status"],
                    "fail",
                    report["checks"]["primary_equilibrium"],
                )

    def test_primary_canonical_ku0_uses_physical_v1_preimage(self):
        material = _canonical_test_material(ku=0.0, axis=[0.0, 0.0, 0.0])
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(
                Path(directory),
                "c0",
                primary_material=material,
                producer_material=copy.deepcopy(material),
            )
            report = gate.validate_case(
                case_dir,
                "c0",
                parameters_path=PARAMETERS,
                kpath_path=KPATH,
            )
            self.assertEqual(
                report["checks"]["primary_equilibrium"]["status"],
                "pass",
                report["checks"]["primary_equilibrium"],
            )
            identity = json.loads(
                (case_dir / "eigen/metadata/sample_0000/linearization_identity.v2.json")
                .read_text(encoding="utf-8")
            )
            physical = json.loads(identity["equilibrium_material_preimage_json"])
            self.assertEqual(identity["material_identity_kind"],
                             "canonical_equilibrium_material.v2")
            self.assertEqual(physical["schema_version"],
                             "EquilibriumMaterialSignaturePreimage.v1")
    def test_metric_replay_pass_cannot_qualify_unreplayed_assignment(self):
        # Unit coverage of the aggregate verdict only, not a field/solver proof.
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(Path(directory), "c1")
            with patch.object(gate, "replay_tracking_fields", return_value={
                "status": "pass", "qualification": "NOT VERIFIED", "reasons": [],
                "assignment_replay": "NOT VERIFIED",
            }) as replay:
                report = gate.validate_case(case_dir, "c1", parameters_path=PARAMETERS, kpath_path=KPATH)
            replay.assert_called_once()
            self.assertEqual(report["checks"]["tracking_field_metric_replay"]["status"], "pass")
            self.assertEqual(report["checks"]["tracking_assignment_replay"]["status"], "missing")
            self.assertEqual(report["scientific_qualification"], "not_verified")
            self.assertEqual(report["qualification"], "NOT VERIFIED")

    def test_assignment_flag_without_full_step_certificate_cannot_qualify(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(Path(directory), "c1")
            for steps in ([], [dict(sample_index=1, status="pass")],
                          [dict(sample_index=index, status="pass") for index in reversed(range(1,61))]):
                with self.subTest(steps=len(steps)), patch.object(gate, "replay_tracking_fields", return_value={
                    "status":"pass", "reasons":[], "assignment_replay":"pass",
                    "global_assignment_verification":steps,
                }):
                    report = gate.validate_case(case_dir,"c1",parameters_path=PARAMETERS,kpath_path=KPATH)
                    self.assertEqual(report["checks"]["tracking_assignment_replay"]["status"],"missing")
                    self.assertEqual(report["qualification"],"NOT VERIFIED")

    def test_full_executed_assignment_certificate_closes_only_its_gate(self):
        # Consumer logic with an injected component result, not runtime proof.
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(Path(directory), "c1")
            with patch.object(gate,"replay_tracking_fields",return_value={
                "status":"pass", "reasons":[], "assignment_replay":"pass",
                "replayed_branch_scope":"all_candidates", "branch_lifecycle_scope":"complete_continuous",
                "candidate_field_coverage":{"status":"pass", "exported_candidate_count":61 * 8},
                "global_assignment_verification":[dict(sample_index=index,status="pass") for index in range(1,61)],
            }):
                report = gate.validate_case(case_dir,"c1",parameters_path=PARAMETERS,kpath_path=KPATH)
            self.assertEqual(report["checks"]["tracking_assignment_replay"]["status"],"pass")
            self.assertEqual(report["status"],"qualified",report["reasons"])

    def test_complete_steps_without_full_candidate_scope_cannot_qualify(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(Path(directory), "c1")
            result = dict(status="pass", reasons=[], assignment_replay="pass",
                replayed_branch_scope="all_candidates", branch_lifecycle_scope="complete_continuous",
                candidate_field_coverage=dict(status="pass", exported_candidate_count=61 * 8),
                global_assignment_verification=[dict(sample_index=index,status="pass") for index in range(1,61)])
            for defect in ("scope", "lifecycle", "coverage", "count"):
                changed = copy.deepcopy(result)
                if defect == "scope":
                    changed.pop("replayed_branch_scope")
                elif defect == "lifecycle":
                    changed.pop("branch_lifecycle_scope")
                elif defect == "coverage":
                    changed["candidate_field_coverage"]["status"] = "missing"
                else:
                    changed["candidate_field_coverage"]["exported_candidate_count"] -= 1
                with self.subTest(defect=defect), patch.object(gate,"replay_tracking_fields",return_value=changed):
                    report = gate.validate_case(case_dir,"c1",parameters_path=PARAMETERS,kpath_path=KPATH)
                    self.assertEqual(report["checks"]["tracking_assignment_replay"]["status"],"missing")
                    self.assertEqual(report["qualification"],"NOT VERIFIED")

    def test_sparse_history_requires_executed_lifecycle_certificate(self):
        # Injected component results test this consumer, not FEM execution.
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(Path(directory), "c1")
            result = dict(status="pass", reasons=[], assignment_replay="pass",
                replayed_branch_scope="all_candidates", branch_lifecycle_scope="complete_history",
                branch_lifecycle_replay=dict(status="pass", verified_sample_count=61),
                candidate_field_coverage=dict(status="pass", exported_candidate_count=61 * 8),
                global_assignment_verification=[dict(sample_index=index,status="pass") for index in range(1,61)])
            for defect in (None, "missing", "failed", "count", "boolean"):
                changed = copy.deepcopy(result)
                if defect == "missing": changed.pop("branch_lifecycle_replay")
                elif defect == "failed": changed["branch_lifecycle_replay"]["status"] = "NOT VERIFIED"
                elif defect == "count": changed["branch_lifecycle_replay"]["verified_sample_count"] = 60
                elif defect == "boolean": changed["branch_lifecycle_replay"]["verified_sample_count"] = True
                with self.subTest(defect=defect), patch.object(gate,"replay_tracking_fields",return_value=changed):
                    report = gate.validate_case(case_dir,"c1",parameters_path=PARAMETERS,kpath_path=KPATH)
                    self.assertEqual(report["checks"]["tracking_assignment_replay"]["status"],
                                     "pass" if defect is None else "missing")

    def test_resolved_spatial_material_override_cannot_claim_homogeneous_ks(self):
        metadata = _native_metadata("c1", "mesh-L1", 2e-6, 24)
        metadata["execution_plan"]["backend_plan"]["material"]["ms_field"] = [800000.0, 1600000.0]
        reasons = []
        self.assertFalse(gate._validate_benchmark_metadata(
            metadata, "c1", json.loads(PARAMETERS.read_text(encoding="utf-8")),
            "inhomogeneous fixture", reasons, require_uniform_slab=True,
        ), "spatial Ms overrides the scalar and invalidates the homogeneous-film oracle")

    def test_canonical_guide_metadata_matches_resolved_c1_without_validation_toggle(self):
        metadata = _native_metadata("c1", "mesh-L1", 2e-6, 24)
        self.assertNotIn("dispersion_validation", metadata["execution_plan"]["backend_plan"])
        reasons = []
        self.assertTrue(gate._validate_benchmark_metadata(
            metadata, "c1", json.loads(PARAMETERS.read_text(encoding="utf-8")),
            "canonical fixture", reasons, require_uniform_slab=True,
        ), reasons)
        self.assertEqual(reasons, [])

    def test_canonical_metadata_cannot_hide_changed_resolved_gamma(self):
        metadata = _native_metadata("c1", "mesh-L1", 2e-6, 24)
        metadata["execution_plan"]["backend_plan"]["gyromagnetic_ratio"] *= 2.0
        reasons = []
        self.assertFalse(gate._validate_benchmark_metadata(
            metadata, "c1", json.loads(PARAMETERS.read_text(encoding="utf-8")),
            "canonical fixture", reasons, require_uniform_slab=True,
        ))
        self.assertTrue(any("gyromagnetic_ratio" in reason for reason in reasons))

    def test_full_c1_contract_pass_requires_controls_and_convergence_but_is_not_qualification(self):
        with tempfile.TemporaryDirectory() as directory:
            report = gate.validate_case(
                _make_case(Path(directory), "c1"),
                "c1",
                parameters_path=PARAMETERS,
                kpath_path=KPATH,
            )
        self.assertEqual(report["campaign_contract_status"], "pass", report["reasons"][:12])
        self.assertEqual(report["status"], "not_qualified")
        self.assertTrue(any("field-metric replay" in reason for reason in report["reasons"]))
        self.assertEqual(report["checks"]["tracked_branches"]["target_band_count"], 8)
        self.assertEqual(report["checks"]["spectrum_samples"]["sample_count"], 61)
        self.assertEqual(report["checks"]["kalinikos_slab_n0"]["status"], "pass")

    def test_ks_mode_cannot_use_equilibrium_from_another_mesh(self):
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(Path(directory), "c1")
            mode_path = case_dir / "validation/ks/bv/eigen/modes/sample_0000/mode_0000.json"
            mode = json.loads(mode_path.read_text())
            mode["source_mesh_topology_sha256"] = "sha256:" + "0" * 64
            _write_json(mode_path, mode)
            report = gate.validate_case(case_dir, "c1", parameters_path=PARAMETERS, kpath_path=KPATH)
        self.assertEqual(report["status"], "not_qualified")
        self.assertEqual(report["checks"]["kalinikos_slab_n0"]["status"], "fail")
        self.assertTrue(any("mesh signature mismatch" in item for item in report["reasons"]), report["reasons"])

    def test_ks_field_frequency_must_match_spectrum(self):
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(Path(directory), "c1")
            path = case_dir / "validation/ks/bv/eigen/modes/sample_0000/mode_0000.json"
            mode = json.loads(path.read_text())
            mode["frequency_imag_hz"] = 1.0
            _write_json(path, mode)
            report = gate.validate_case(case_dir, "c1", parameters_path=PARAMETERS, kpath_path=KPATH)
        self.assertEqual(report["status"], "not_qualified")
        self.assertEqual(report["checks"]["kalinikos_slab_n0"]["status"], "fail")
        self.assertTrue(any("frequency_imag_hz differs" in reason for reason in report["reasons"]), report["reasons"])

    def test_primary_connectivity_change_invalidates_modal_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(Path(directory), "c1")
            path = case_dir / "metadata.json"
            metadata = json.loads(path.read_text())
            nodes = metadata["execution_plan"]["backend_plan"]["mesh"]["cells"]["nodes"]
            nodes[0], nodes[1] = nodes[1], nodes[0]
            _write_json(path, metadata)
            report = gate.validate_case(case_dir, "c1", parameters_path=PARAMETERS, kpath_path=KPATH)
        self.assertEqual(report["status"], "not_qualified")
        self.assertTrue(any("topology differs" in reason for reason in report["reasons"]), report["reasons"])

    def test_primary_field_frequency_must_match_spectrum(self):
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(Path(directory), "c1")
            path = case_dir / "eigen/modes/sample_0000/mode_0000.json"
            mode = json.loads(path.read_text())
            mode["frequency_real_hz"] *= 2
            _write_json(path, mode)
            report = gate.validate_case(case_dir, "c1", parameters_path=PARAMETERS, kpath_path=KPATH)
        self.assertEqual(report["status"], "not_qualified")
        self.assertTrue(any("frequency_real_hz differs" in reason for reason in report["reasons"]), report["reasons"])

    def test_missing_ks_equilibrium_is_not_qualified(self):
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(Path(directory), "c1")
            (case_dir / "validation/ks/bv/eigen/metadata/sample_0000/equilibrium_artifact.v7.json").unlink()
            report = gate.validate_case(case_dir, "c1", parameters_path=PARAMETERS, kpath_path=KPATH)
        self.assertEqual(report["status"], "not_qualified")
        self.assertEqual(report["checks"]["kalinikos_slab_n0"]["status"], "fail")
        self.assertTrue(any("n0 profile measurement failed" in item for item in report["reasons"]), report["reasons"])

    def test_missing_ks_profile_vector_is_not_qualified(self):
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(Path(directory), "c1")
            vector_path = case_dir / (
                "validation/ks/bv/eigen/mode_fields/"
                "sample_0000/mode_0000/vector.bin"
            )
            vector_path.unlink()
            report = gate.validate_case(
                case_dir,
                "c1",
                parameters_path=PARAMETERS,
                kpath_path=KPATH,
            )
        self.assertEqual(report["status"], "not_qualified")
        check = report["checks"]["kalinikos_slab_n0"]
        self.assertEqual(check["status"], "fail")
        self.assertTrue(
            any("n0 profile measurement failed" in reason for reason in report["reasons"]),
            report["reasons"],
        )

    def test_hashed_nonuniform_ks_profile_is_not_qualified_despite_frequency_match(self):
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(Path(directory), "c1")
            _rewrite_mode_field_with_z_sign_profile(case_dir / "validation/ks/bv")
            report = gate.validate_case(
                case_dir,
                "c1",
                parameters_path=PARAMETERS,
                kpath_path=KPATH,
            )
        self.assertEqual(report["status"], "not_qualified")
        check = report["checks"]["kalinikos_slab_n0"]
        self.assertEqual(check["status"], "fail")
        profile = check["n0_profiles"][0]
        self.assertEqual(profile["status"], "measured")
        self.assertGreater(
            profile["metrics"]["projection_residual"],
            0.01,
        )
        self.assertTrue(
            any("n0 projection_residual exceeds" in reason for reason in report["reasons"]),
            report["reasons"],
        )

    def test_missing_ks_profile_policy_is_a_gate_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(Path(directory), "c1")
            parameters = json.loads(PARAMETERS.read_text(encoding="utf-8"))
            parameters.pop("ks_n0_profile")
            parameters_path = Path(directory) / "parameters-without-ks-profile.json"
            _write_json(parameters_path, parameters)
            report = gate.validate_case(
                case_dir,
                "c1",
                parameters_path=parameters_path,
                kpath_path=KPATH,
            )
        self.assertEqual(report["status"], "not_qualified")
        check = report["checks"]["kalinikos_slab_n0"]
        self.assertEqual(check["status"], "fail")
        self.assertTrue(
            any(
                "requires explicit finite n0 profile tolerances" in reason
                for reason in report["reasons"]
            ),
            report["reasons"],
        )
    def test_ks_check_rejects_invalid_control_even_when_frequencies_agree(self):
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(Path(directory), "c1")
            baseline = json.loads((case_dir / gate.EVIDENCE_RELATIVE_PATH).read_text(encoding="utf-8"))
            parameters = json.loads(PARAMETERS.read_text(encoding="utf-8"))
            for field, value in (("sample_index", False), ("branch_id", False), ("k_rad_per_m", 2.0e7), ("k_rad_per_m", None), ("k_rad_per_m", float("nan")), ("k_rad_per_m", "1e7"), ("k_rad_per_m", -1.0)):
                with self.subTest(field=field):
                    evidence = copy.deepcopy(baseline)
                    evidence["analytic_controls"]["kalinikos_slab_n0"]["samples"][0][field] = value
                    reasons = []
                    check = gate._validate_ks(case_dir, "c1", evidence, parameters, reasons)
                    self.assertEqual(check["status"], "fail", reasons)
                    self.assertTrue(reasons)

    def test_duplicate_branch_ids_do_not_count_as_independent_bands(self):
        branches = [{"branch_id": 0, "points": [{"sample_index": sample, "raw_mode_index": raw,
                     "frequency_real_hz": 1e9 + raw} for sample in range(61)]} for raw in range(8)]
        modes = {(sample, raw): 1e9 + raw for sample in range(61) for raw in range(8)}
        reasons = []
        selected, check = gate._validate_branches({"branches": branches}, "c1", modes, reasons)
        self.assertEqual(check["status"], "fail")
        self.assertEqual(len(selected), 1)
        self.assertTrue(any("unique" in reason for reason in reasons))

    def test_primary_artifacts_reject_link_before_hashing(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "metadata.json"
            path.write_text("{}")
            original = Path.is_symlink
            with patch.object(Path, "is_symlink", lambda value: value == path or original(value)):
                with patch.object(gate, "_sha256", side_effect=AssertionError("linked artifact was read")):
                    artifacts, reasons = gate._artifact_map(root)
        self.assertNotIn(Path("metadata.json"), artifacts)
        self.assertTrue(any("symlink or junction" in reason for reason in reasons))

    def test_tracking_snapshot_covers_sparse_unselected_candidates_and_missing_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            header = root / "eigen/modes/sample_0001/mode_0064.json"
            vector = root / "eigen/mode_fields/sample_0001/mode_0064/vector.bin"
            header.parent.mkdir(parents=True)
            vector.parent.mkdir(parents=True)
            header.write_text("{}")
            vector.write_bytes(b"candidate")
            snapshot = gate._tracking_input_hashes(root, {}, {(1, 64): 1e9, (1, 91): 2e9})
            self.assertEqual(snapshot[header.relative_to(root).as_posix()], "sha256:" + _sha256(header))
            self.assertEqual(snapshot[vector.relative_to(root).as_posix()], "sha256:" + _sha256(vector))
            self.assertIsNone(snapshot["eigen/modes/sample_0001/mode_0091.json"])
            self.assertIsNone(snapshot["eigen/mode_fields/sample_0001/mode_0091/vector.bin"])

    def test_tracking_snapshot_rejects_linked_field_before_hashing(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "eigen/modes/sample_0000/mode_0064.json"
            path.parent.mkdir(parents=True)
            path.write_text("{}")
            original = Path.is_symlink
            with patch.object(Path, "is_symlink", lambda value: value == path or original(value)):
                with patch.object(gate, "_sha256", side_effect=AssertionError("linked field was read")):
                    snapshot = gate._tracking_input_hashes(root, {}, {(0, 64): 1e9})
            self.assertIsNone(snapshot[path.relative_to(root).as_posix()])

    def test_internal_linked_parent_is_rejected(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            parent = root / "eigen"
            parent.mkdir()
            (parent / "spectrum.v2.json").write_text("{}")
            original = Path.is_symlink
            reasons = []
            with patch.object(Path, "is_symlink", lambda value: value == parent or original(value)):
                result = gate._safe_relative_path(root, "eigen/spectrum.v2.json", "spectrum", reasons)
        self.assertIsNone(result)
        self.assertTrue(any("symlink or junction" in reason for reason in reasons))

    def test_comparison_spectrum_rejects_duplicate_samples_and_bool_indices(self):
        from unittest.mock import patch
        baseline = {"spectrum": {"sample_count": 1, "mode_count": 1, "samples": [{"sample_index": 0, "k_vector": [0., 0., 0.],
                    "modes": [{"raw_mode_index": 0}]}]},
                    "diagnostics": {"sample_count": 1, "mode_count": 1}}
        for defect in ("duplicate", "bool_sample", "bool_mode", "negative_mode", "bad_k"):
            with self.subTest(defect=defect):
                bundle = copy.deepcopy(baseline)
                sample = bundle["spectrum"]["samples"][0]
                if defect == "duplicate":
                    second = copy.deepcopy(sample)
                    second["modes"][0]["raw_mode_index"] = 1
                    bundle["spectrum"]["samples"].append(second)
                    bundle["diagnostics"].update(sample_count=2, mode_count=2)
                    bundle["spectrum"].update(sample_count=2, mode_count=2)
                elif defect == "bool_sample": sample["sample_index"] = False
                elif defect == "bool_mode": sample["modes"][0]["raw_mode_index"] = False
                elif defect == "negative_mode": sample["modes"][0]["raw_mode_index"] = -1
                else: sample["k_vector"] = [float("nan"), 0., 0.]
                reasons = []
                with patch.object(gate, "_validate_modal_quality", return_value=True):
                    gate._validate_bundle_modal_payload(bundle, "control", reasons)
                self.assertTrue(reasons)

    def test_comparison_counts_must_match_contents_with_integer_types(self):
        from unittest.mock import patch
        baseline = {"spectrum": {"sample_count": 1, "mode_count": 1,
                    "samples": [{"sample_index": 0, "k_vector": [0., 0., 0.], "modes": [{"raw_mode_index": 0}]}]},
                    "diagnostics": {"sample_count": 1, "mode_count": 1}}
        with patch.object(gate, "_validate_modal_quality", return_value=True):
            reasons = []
            gate._validate_bundle_modal_payload(baseline, "control", reasons)
            self.assertFalse(reasons)
            for source in ("spectrum", "diagnostics"):
                for key in ("sample_count", "mode_count"):
                    for value in (None, True, 2):
                        with self.subTest(source=source, key=key, value=value):
                            bundle = copy.deepcopy(baseline)
                            bundle[source][key] = value
                            reasons = []
                            gate._validate_bundle_modal_payload(bundle, "control", reasons)
                            self.assertTrue(any(key in reason for reason in reasons))

    def test_bundle_checks_points_outside_selected_control(self):
        modes = [{"raw_mode_index": raw, "frequency_real_hz": 1e9 + raw, "frequency_imag_hz": 0.0} for raw in (0, 1)]
        bundle = {"spectrum": {"samples": [{"sample_index": 0, "modes": modes}]},
                  "branches": {"branches": [{"branch_id": raw, "points": [{"sample_index": 0, **mode}]} for raw, mode in enumerate(modes)]}}
        reasons = []
        gate._validate_bundle_branches(bundle, "control", reasons)
        self.assertFalse(reasons)
        bundle["branches"]["branches"][1]["points"][0]["frequency_real_hz"] *= 2
        gate._validate_bundle_branches(bundle, "control", reasons)
        self.assertTrue(any("differs from spectrum" in reason for reason in reasons))

    def test_rehashed_wrong_manifest_product_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(Path(directory), "c1")
            path = case_dir / "validation/ks/bv/frequency_domain/manifest.v1.json"
            baseline = json.loads(path.read_text())
            for field, value in (("study_product", "driven_response"), ("analysis_family", "other")):
                with self.subTest(field=field):
                    manifest = copy.deepcopy(baseline)
                    manifest[field] = value
                    _write_json(path, manifest)
                    descriptor = _bundle_descriptor(case_dir, "validation/ks/bv")
                    reasons = []
                    gate._load_numeric_bundle(case_dir, descriptor, "KS", reasons, require_demag=True)
                    self.assertTrue(any(f"manifest {field}" in reason for reason in reasons), reasons)
                    self.assertFalse(any("SHA256 does not match" in reason for reason in reasons), reasons)

    def test_convergence_cannot_use_only_control_samples(self):
        samples = [{"sample_index": index, "modes": [{"raw_mode_index": raw, "frequency_real_hz": 1e9 + raw} for raw in range(8)]}
                   for index in (0, 10, 20, 30, 40, 50, 60)]
        branches = [{"branch_id": raw, "points": [{"sample_index": sample["sample_index"], "raw_mode_index": raw,
                     "frequency_real_hz": 1e9 + raw} for sample in samples]} for raw in range(8)]
        reasons = []
        gate._validate_convergence_coverage({"spectrum": {"samples": samples}, "branches": {"branches": branches}}, "c1", "mesh fine", reasons)
        self.assertTrue(any("complete benchmark sample set" in reason for reason in reasons))
        self.assertTrue(any("complete tracked branches" in reason for reason in reasons))

    def test_convergence_path_checks_noncontrol_sample(self):
        primary = {"spectrum": {"samples": [{"sample_index": i, "k_vector": [float(i), 0., 0.]} for i in range(61)]}}
        candidate = copy.deepcopy(primary)
        reasons = []
        gate._validate_convergence_path(candidate, primary, "fine", reasons)
        self.assertFalse(reasons)
        candidate["spectrum"]["samples"][17]["k_vector"][1] = 1.0
        gate._validate_convergence_path(candidate, primary, "fine", reasons)
        self.assertTrue(any("sample 17 wavevector differs" in reason for reason in reasons))

    def test_missing_evidence_is_unqualified_with_explicit_reasons(self):
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(Path(directory), "c1")
            (case_dir / gate.EVIDENCE_RELATIVE_PATH).unlink()
            report = gate.validate_case(case_dir, "c1", parameters_path=PARAMETERS, kpath_path=KPATH)
        self.assertEqual(report["status"], "not_qualified")
        self.assertTrue(any("missing scientific evidence bundle" in reason for reason in report["reasons"]))
        self.assertTrue(any("missing convergence.mesh" in reason for reason in report["reasons"]))

    def test_analytic_frequency_source_cannot_qualify_numeric_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(Path(directory), "c1")
            manifest_path = case_dir / "frequency_domain/manifest.v1.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["validation"]["dispersion_frequency_source"] = "analytic_reference_model"
            _write_json(manifest_path, manifest)
            evidence_path = case_dir / gate.EVIDENCE_RELATIVE_PATH
            evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
            evidence["artifact_bindings"]["manifest_sha256"] = _sha256(manifest_path)
            _write_json(evidence_path, evidence)
            report = gate.validate_case(case_dir, "c1", parameters_path=PARAMETERS, kpath_path=KPATH)
        self.assertEqual(report["status"], "not_qualified")
        self.assertTrue(any("analytic reference is declared" in reason for reason in report["reasons"]))

    def test_incomplete_path_or_branch_is_rejected_even_with_nonempty_csv(self):
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(Path(directory), "c1")
            branches_path = case_dir / "eigen/branches.v2.json"
            branches = json.loads(branches_path.read_text(encoding="utf-8"))
            branches["branches"][0]["points"].pop()
            _write_json(branches_path, branches)
            evidence_path = case_dir / gate.EVIDENCE_RELATIVE_PATH
            evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
            evidence["artifact_bindings"]["branches_v2_sha256"] = _sha256(branches_path)
            _write_json(evidence_path, evidence)
            report = gate.validate_case(case_dir, "c1", parameters_path=PARAMETERS, kpath_path=KPATH)
        self.assertEqual(report["status"], "not_qualified")
        self.assertTrue(any("complete tracked branches" in reason for reason in report["reasons"]))

    def test_complete_case_selection_accepts_all_permutations(self):
        results = {case: {"status": "qualified", "scientific_qualification": "qualified", "reasons": []}
                   for case in gate.EXPECTED_CASES}
        for cases in itertools.permutations(gate.EXPECTED_CASES):
            with self.subTest(cases=cases):
                self.assertEqual(gate.validate_requested_cases(results, cases)["status"], "qualified")
        self.assertEqual(gate.validate_requested_cases(results, ("c0", "c1", "c1"))["status"], "not_qualified")

    def test_numeric_bundle_cannot_mix_files_from_other_declared_run(self):
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(Path(directory), "c1")
            evidence = json.loads((case_dir / gate.EVIDENCE_RELATIVE_PATH).read_text(encoding="utf-8"))
            runs = evidence["convergence"]["mesh"]["runs"]
            descriptor = copy.deepcopy(runs["coarse"])
            descriptor["artifacts"]["spectrum"] = copy.deepcopy(runs["fine"]["artifacts"]["spectrum"])
            reasons = []
            bundle = gate._load_numeric_bundle(case_dir, descriptor, "mixed", reasons, require_demag=True)
        self.assertIsNone(bundle)
        self.assertTrue(any("outside the declared numeric run root" in reason for reason in reasons), reasons)

    def test_numeric_bundle_root_must_be_an_existing_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            case_dir = Path(directory)
            (case_dir / "regular-file").write_text("{}", encoding="utf-8")
            for root in ("regular-file", "missing-directory"):
                with self.subTest(root=root):
                    reasons = []
                    result = gate._load_numeric_bundle(case_dir, {"root": root, "artifacts": {}},
                                                       "bundle", reasons, require_demag=True)
                    self.assertIsNone(result)
                    self.assertTrue(any("root is not a directory" in reason for reason in reasons), reasons)

    def test_failed_check_without_reason_cannot_qualify(self):
        with tempfile.TemporaryDirectory() as directory:
            case_dir = _make_case(Path(directory), "c0")
            with mock.patch.object(gate, "_validate_convergence", return_value={"status": "fail"}):
                report = gate.validate_case(case_dir, "c0", parameters_path=PARAMETERS, kpath_path=KPATH)
        self.assertEqual(report["status"], "not_qualified")
        self.assertTrue(any("required scientific check mesh_convergence did not pass" in reason
                            for reason in report["reasons"]), report["reasons"])

    def test_partial_case_selection_cannot_be_promoted(self):
        result = gate.validate_requested_cases({"c1": {"status": "qualified", "reasons": []}}, ("c1",))
        self.assertEqual(result["status"], "not_qualified")
        self.assertIn("requires cases c0,c1,a1", result["reasons"][0])


if __name__ == "__main__":
    unittest.main()
