#!/usr/bin/env python3
"""Compare archived uniform-film modes with an exactly bound P1 mass metric.

This is offline diagnostic evidence, not a new solve or branch qualification.
Only a single magnetic marker 1 with air marker 0 and tet4/tri3 is supported.
"""
from __future__ import annotations

import argparse
from dataclasses import replace
import hashlib
from itertools import combinations
import json
from pathlib import Path
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "packages/fullmag-py/src"))
from fullmag.meshing.persistence import load_mesh_artifact


def pack_single_film_mesh(mesh):
    """Replay pack_mesh_by_analysis for one nonduplicated magnetic region."""
    if set(mesh.cell_types) != {"tet4"} or set(mesh.facet_types) != {"tri3"}:
        raise ValueError("profile comparison requires tet4/tri3")
    if set(mesh.element_markers) != {0, 1}:
        raise ValueError("profile comparison requires one magnetic marker 1 and air 0")
    magnetic = mesh.elements[mesh.element_markers == 1]
    ids = np.unique(magnetic)
    if len(np.unique(mesh.nodes[ids], axis=0)) != len(ids):
        raise ValueError("coordinate merging requires a separate packing implementation")
    order = np.r_[ids, np.setdiff1d(np.arange(mesh.n_nodes), ids)]
    inverse = np.empty(len(order), dtype=np.int64)
    inverse[order] = np.arange(len(order))
    magnetic_faces = {tuple(sorted(f)) for cell in magnetic for f in combinations(cell, 3)}
    owned = np.asarray([tuple(sorted(f)) in magnetic_faces for f in mesh.boundary_faces])
    facets = np.r_[np.flatnonzero(owned), np.flatnonzero(~owned)]
    cells = np.r_[np.flatnonzero(mesh.element_markers == 1), np.flatnonzero(mesh.element_markers == 0)]
    return replace(
        mesh, nodes=mesh.nodes[order], cell_types=mesh.cell_types[cells],
        cell_nodes=inverse[mesh.elements[cells]].reshape(-1),
        cell_global_ordinals=mesh.cell_global_ordinals[cells],
        cell_mesh_parts=mesh.cell_mesh_parts[cells] if len(mesh.cell_mesh_parts) else mesh.cell_mesh_parts,
        element_markers=mesh.element_markers[cells], facet_types=mesh.facet_types[facets],
        facet_roles=mesh.facet_roles[facets], facet_nodes=inverse[mesh.boundary_faces[facets]].reshape(-1),
        facet_global_ordinals=mesh.facet_global_ordinals[facets],
        boundary_markers=mesh.boundary_markers[facets],
        periodic_node_pairs=[{**pair, "node_a": int(inverse[pair["node_a"]]),
                             "node_b": int(inverse[pair["node_b"]])}
                            for pair in mesh.periodic_node_pairs],
        periodic_mesh_certificate=None,
    )


def bind_mesh(mesh, expected_fingerprint):
    packed = pack_single_film_mesh(mesh)
    if packed.topology_fingerprint_v3() != expected_fingerprint:
        raise ValueError("packed cache does not match final modal topology")
    return packed


def tetra_volumes(nodes, tetra):
    corners = np.asarray(nodes)[np.asarray(tetra)]
    volumes = np.abs(np.linalg.det(corners[:, 1:] - corners[:, :1])) / 6.0
    if not len(volumes) or not np.all(np.isfinite(volumes) & (volumes > 0)):
        raise ValueError("mass metric requires finite nondegenerate tetrahedra")
    return volumes


def consistent_inner_product(tetra, volumes, left, right):
    """Exact P1 tetra mass V/20 (ones + identity), on magnetic elements."""
    if left.shape != right.shape or left.ndim != 2 or left.shape[1] != 3:
        raise ValueError("mass vectors require equal N by 3 shape")
    if not np.all(np.isfinite(left)) or not np.all(np.isfinite(right)):
        raise ValueError("mass vectors must be finite")
    a, b = np.conjugate(left[tetra]), right[tetra]
    local = np.sum(a.sum(axis=1) * b.sum(axis=1), axis=1) + np.sum(a * b, axis=(1, 2))
    return complex(np.sum(volumes / 20.0 * local))


def normalized_overlap(tetra, volumes, left, right):
    ll = consistent_inner_product(tetra, volumes, left, left)
    rr = consistent_inner_product(tetra, volumes, right, right)
    if ll.real <= 0 or rr.real <= 0:
        raise ValueError("overlap requires positive mass norms")
    value = abs(consistent_inner_product(tetra, volumes, left, right)) ** 2 / (ll.real * rr.real)
    if not np.isfinite(value) or value > 1.0 + 1e-12:
        raise ValueError("mass overlap violates Cauchy Schwarz")
    return float(min(1.0, value))


def contained(root, relative):
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError("artifact path leaves its run")
    return path


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate_record_parameters(record, metadata):
    """Bind diagnostic SI parameters to the actual uniform-film run metadata."""
    try:
        model = metadata["problem_meta"]["runtime_metadata"]["de_smoke"]
        geometry = record["geometry"]
        orientations = {"damon_eshbach": "M0=x,k=y,normal=z",
                        "backward_volume": "M0=x,k=x,normal=z"}
        if (geometry not in orientations or model["schema"] != "fullmag.de-smoke.v1"
                or model["orientation"] != orientations[geometry]
                or model["outer_boundary_kind"] != "poisson_dirichlet"
                or model.get("dispersion_geometry", geometry) != geometry):
            raise ValueError("comparison geometry differs from actual DE-SMOKE metadata")
        fields = {
            "film_thickness_m": "film_thickness_m",
            "exchange_stiffness_j_per_m": "exchange_stiffness_j_per_m",
            "saturation_magnetisation_a_per_m": "saturation_magnetization_a_per_m",
            "gamma0_rad_s_per_a_m": "gamma0_m_per_a_s",
        }
        def positive(value):
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not np.isfinite(value) or value <= 0:
                raise ValueError("invalid actual or declared uniform-film SI parameter")
            return float(value)
        expected = {key: positive(model[source]) for key, source in fields.items()}
        expected["bias_field_a_per_m"] = positive(model["external_induction_t"]) / positive(model["mu0_t_m_a"])
        for key, value in expected.items():
            declared = positive(record["parameters"][key])
            if not np.isclose(declared, value, rtol=32*np.finfo(float).eps, atol=0):
                raise ValueError("comparison parameter differs from actual run: " + key)
    except (KeyError, TypeError) as error:
        raise ValueError("missing uniform-film comparison parameter metadata") from error


def load_record(record):
    run = Path(record["run_path"]).resolve()
    case = contained(run, record["pilot"])
    for relative, expected in record["artifact_sha256"].items():
        if sha256(contained(run, relative)) != expected:
            raise ValueError("comparison input hash mismatch")
    metadata_path = contained(case, "metadata.json")
    metadata_keys = [key for key in record["artifact_sha256"]
                     if contained(run, key) == metadata_path]
    if len(metadata_keys) != 1:
        raise ValueError("comparison must bind exactly one actual run metadata file")
    metadata_bytes = metadata_path.read_bytes()
    if hashlib.sha256(metadata_bytes).hexdigest() != record["artifact_sha256"][metadata_keys[0]]:
        raise ValueError("actual run metadata changed during comparison loading")
    validate_record_parameters(record, json.loads(metadata_bytes))
    result = json.loads((run / "run-result.json").read_text(encoding="utf-8"))
    if result.get("status") != "completed_unqualified":
        raise ValueError("only accepted completed archived runs may be compared")
    mode_path = contained(case, "eigen/modes/sample_0000/mode_0000.json")
    mode = json.loads(mode_path.read_text(encoding="utf-8"))
    blocks = mode["block_residuals"]
    if blocks.get("full_descriptor_certified") is not True or blocks.get("certified") is not True:
        raise ValueError("mode has no full descriptor certificate")
    residual = blocks["eps_full"]
    if not isinstance(residual, (int, float)) or not np.isfinite(residual) or not 0 <= residual <= 1e-8:
        raise ValueError("mode fails original full residual gate")
    if (mode["binary_layout"] != "complex_f64_pairs_little_endian"
            or mode["component_basis"] != "global_xyz" or mode["components"] != ["x", "y", "z"]):
        raise ValueError("unsupported Cartesian mode payload")
    k = np.asarray(mode["k_vector"], dtype=float)
    expected_k = [0, record["k_rad_per_m"], 0] if record["geometry"] == "damon_eshbach" else [record["k_rad_per_m"], 0, 0]
    if record["geometry"] not in ("damon_eshbach", "backward_volume") or not np.array_equal(k, expected_k):
        raise ValueError("mode wavevector or geometry mismatch")
    if mode["frequency_hz"] != record["frequency_hz"]:
        raise ValueError("mode frequency differs from comparison row")
    caches = [contained(run, str(path.relative_to(run))) for path in
              (run / "state/local/cache/fem_mesh_assets/shared_domains").glob("*.fullmag-mesh")]
    if len(caches) != 1:
        raise ValueError("expected exactly one archived mesh cache")
    mesh = bind_mesh(load_mesh_artifact(caches[0]).mesh, mode["source_mesh_topology_sha256"])
    payload = contained(case, mode["compatibility_binary_payload_path"])
    if "sha256:" + sha256(payload) != mode["payload_sha256"]:
        raise ValueError("mode binary hash mismatch")
    values = np.frombuffer(payload.read_bytes(), dtype="<f8")
    if values.size != mesh.n_nodes * 6 or mode["mode_field_sample_count"] != mesh.n_nodes:
        raise ValueError("mode node count does not match bound topology")
    values = values.reshape(mesh.n_nodes, 3, 2)
    field = values[:, :, 0] + 1j * values[:, :, 1]
    # Physical field convention exp(-i k.r); compare interpolated nodal envelopes.
    envelope = field * np.exp(1j * (mesh.nodes @ k))[:, None]
    tetra = mesh.elements[mesh.element_markers == 1]
    volumes = tetra_volumes(mesh.nodes, tetra)
    integral = np.sum(volumes[:, None] / 4.0 * envelope[tetra].sum(axis=1), axis=0)
    constant = np.broadcast_to(integral / volumes.sum(), envelope.shape)
    hashes = {"mode_metadata": sha256(mode_path), "mode_binary": sha256(payload), "mesh_cache": sha256(caches[0])}
    return mesh, envelope, tetra, volumes, hashes, normalized_overlap(tetra, volumes, envelope, constant)


def compare_profiles(comparison):
    records, adjacent, previous = [], [], {}
    parameter_reference = None
    for record in sorted(comparison["records"], key=lambda r: (r["geometry"], r["k_rad_per_m"])):
        parameters = {k: v for k, v in record["parameters"].items() if k != "geometry"}
        if parameter_reference is None:
            parameter_reference = parameters
        if parameters != parameter_reference:
            raise ValueError("profile comparison requires identical uniform material and geometry parameters")
        mesh, envelope, tetra, volumes, hashes, uniform_overlap = load_record(record)
        geometry, k = record["geometry"], record["k_rad_per_m"]
        fingerprint = mesh.topology_fingerprint_v3()
        if geometry in previous:
            old = previous[geometry]
            if old["fingerprint"] != fingerprint or k <= old["k"]:
                raise ValueError("adjacent profiles require identical ordered topology and distinct increasing k")
            adjacent.append({"geometry": geometry, "k_from_rad_per_m": old["k"], "k_to_rad_per_m": k,
                             "overlap_squared_consistent_mass": normalized_overlap(tetra, volumes, old["field"], envelope)})
        previous[geometry] = {"k": k, "field": envelope, "fingerprint": fingerprint}
        records.append({"geometry": geometry, "k_rad_per_m": k, "frequency_hz": record["frequency_hz"],
                        "uniform_projection_squared_consistent_mass": uniform_overlap,
                        "modal_topology": fingerprint, "input_sha256": hashes,
                        "magnetic_tetra_count": len(tetra), "magnetic_volume_m3": float(volumes.sum())})
    if not records:
        raise ValueError("no mode profiles to compare")
    return {"schema": "fullmag.de-bv.profile-comparison.v1", "qualification": "NOT VERIFIED",
            "spatial_phase_convention": "exp_minus_i_k_dot_delta_r", "metric": "consistent_P1_tet4_mass",
            "envelope": "P1_interpolation_of_Bloch_unwound_nodal_values",
            "scope": "single uniform film; diagnostic profile continuity, not spectral completeness or branch qualification",
            "records": records, "adjacent_pairs": adjacent}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("comparison", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    comparison_bytes = args.comparison.read_bytes()
    result = compare_profiles(json.loads(comparison_bytes))
    result["comparison_sha256"] = hashlib.sha256(comparison_bytes).hexdigest()
    result["producer_sha256"] = sha256(Path(__file__))
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    print(json.dumps({"profiles": len(result["records"]), "adjacent_pairs": len(result["adjacent_pairs"]),
                      "qualification": result["qualification"]}))


if __name__ == "__main__":
    main()
