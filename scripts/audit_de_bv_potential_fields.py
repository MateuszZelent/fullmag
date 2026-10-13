"""Independent archived full-physical phi / element demag consistency diagnostic.
This does not solve Poisson, rerun FEM or qualify airbox convergence.
"""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from audit_de_bv_periodic_seams import magnetic_pair_seams
from compare_de_bv_mode_profiles import load_record, contained, sha256


def gradient_diagnostics(nodes, tetra, phi, demag):
    nodes, tetra = np.asarray(nodes, float), np.asarray(tetra)
    phi, demag = np.asarray(phi, complex), np.asarray(demag, complex)
    if nodes.ndim != 2 or nodes.shape[1] != 3 or phi.shape != (len(nodes),):
        raise ValueError("invalid physical potential shape")
    if tetra.ndim != 2 or tetra.shape[1] != 4 or not np.issubdtype(tetra.dtype, np.integer):
        raise ValueError("invalid tetra layout")
    if not len(tetra) or tetra.min() < 0 or tetra.max() >= len(nodes) or demag.shape != (len(tetra), 3):
        raise ValueError("invalid demag element shape or indices")
    if not np.isfinite(nodes).all() or not np.isfinite(phi).all() or not np.isfinite(demag).all():
        raise ValueError("nonfinite physical potential/demag")
    matrix = nodes[tetra[:, 1:]] - nodes[tetra[:, 0]][:, None, :]
    volumes = np.abs(np.linalg.det(matrix)) / 6
    if not np.isfinite(volumes).all() or (volumes <= 0).any():
        raise ValueError("degenerate or unrepresentable tetra")
    delta = phi[tetra[:, 1:]] - phi[tetra[:, 0]][:, None]
    expected = -np.linalg.solve(matrix, delta[..., None])[..., 0]
    scale = max(float(np.max(np.abs(expected))), float(np.max(np.abs(demag))))
    if not np.isfinite(expected).all() or not np.isfinite(scale) or scale <= 0:
        raise ValueError("zero or unrepresentable demag norm")
    target, actual = expected / scale, demag / scale
    weights = volumes / volumes.max()
    error = actual - target
    denominator = np.sum(weights[:, None] * np.abs(target)**2)
    if not np.isfinite(denominator) or denominator <= 0:
        raise ValueError("invalid reconstructed demag norm")
    relative_l2 = float(np.sqrt(np.sum(weights[:, None]*np.abs(error)**2) / denominator))
    relative_max = float(np.max(np.linalg.norm(error, axis=1)) / np.max(np.linalg.norm(target, axis=1)))
    if not np.isfinite(relative_l2) or not np.isfinite(relative_max):
        raise ValueError("nonfinite reconstruction defect")
    return {"volume_weighted_relative_l2": relative_l2, "relative_max": relative_max,
            "tetra_count": len(tetra)}


def payload(case, descriptor, layout, count, components, unit):
    if (descriptor.get("association") != ("source_mesh_nodes" if components == 1 else "source_mesh_tet4_elements")
        or descriptor.get("layout") != layout or descriptor.get("dtype") != "float64"
        or descriptor.get("byte_order") != "little" or descriptor.get("count") != count
        or descriptor.get("unit") != unit):
        raise ValueError("unsupported physical potential/demag descriptor")
    path = contained(case, descriptor["path"])
    data = path.read_bytes()
    if "sha256:" + hashlib.sha256(data).hexdigest() != descriptor["sha256"]:
        raise ValueError("potential/demag hash mismatch")
    values = np.frombuffer(data, dtype="<f8")
    if values.size != count*components*2 or not np.isfinite(values).all():
        raise ValueError("potential/demag binary shape or finite-value mismatch")
    values = values.reshape(count, components, 2)
    result = values[..., 0] + 1j * values[..., 1]
    return result[:, 0] if components == 1 else result, sha256(path)


def inspect(comparison):
    records = []
    for record in comparison["records"]:
        mesh, _, _, _, hashes, _ = load_record(record)
        case = contained(Path(record["run_path"]).resolve(), record["pilot"])
        metadata_path = contained(case, "eigen/mode_fields/sample_0000/mode_0000/physical_potential.v1.json")
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        mode = json.loads(contained(case, "eigen/modes/sample_0000/mode_0000.json").read_text(encoding="utf-8"))
        if (metadata.get("schema_version") != "fem_modal_physical_potential.v1"
            or metadata.get("representation") != "full_physical_phasor"
            or metadata.get("normalization") != "same_complex_scale_as_published_magnetization_mode"
            or metadata.get("sample_index") != 0 or metadata.get("mode_index") != mode["raw_mode_index"]
            or metadata.get("source_mesh_topology_sha256") != mode["source_mesh_topology_sha256"]):
            raise ValueError("physical potential identity or representation mismatch")
        for key in ["operator_input_signature_sha256", "phase_constraint_sha256"]:
            if not metadata.get(key) or metadata[key] != mode.get(key):
                raise ValueError("physical potential operator/phase identity mismatch")
        phi, hashes["potential_binary"] = payload(case, metadata["potential"], "node_major_real_imag", mesh.n_nodes, 1, "A")
        demag, hashes["demag_binary"] = payload(case, metadata["demag_field"], "element_major_xyz_real_imag", len(mesh.elements), 3, "A/m")
        hashes["physical_potential_metadata"] = sha256(metadata_path)
        if metadata["demag_field"].get("reconstruction") != "-grad(phi_full)":
            raise ValueError("unsupported demag reconstruction")
        k = np.asarray(mode["k_vector"], float)
        scalar_xyz = np.column_stack([phi, np.zeros((mesh.n_nodes, 2), complex)])
        pairs = magnetic_pair_seams(mesh.nodes, scalar_xyz, np.arange(mesh.n_nodes),
                                    mesh.periodic_node_pairs, mesh.periodic_boundary_pairs, k)
        z = mesh.nodes[:, 2]
        outer_nodes = (z == z.min()) | (z == z.max())
        scale = float(np.max(np.abs(phi)))
        if scale <= 0 or not np.isfinite(scale):
            raise ValueError("physical potential is zero or invalid")
        records.append({"geometry": record["geometry"], "pilot": record["pilot"],
            "k_rad_per_m": record["k_rad_per_m"], "frequency_hz": record["frequency_hz"],
            "source_mesh_topology_sha256": mesh.topology_fingerprint_v3(), "input_sha256": hashes,
            "potential_node_count": mesh.n_nodes, "periodic_pair_count": len(pairs),
            "potential_seam_max_relative": max(p["relative_mismatch"] for p in pairs),
            "wrong_sign_potential_seam_max_relative": max(p["wrong_sign_relative_mismatch"] for p in pairs),
            "outer_z_plane_node_count": int(outer_nodes.sum()),
            "outer_z_plane_potential_max_relative": float(np.max(np.abs(phi[outer_nodes])) / scale),
            "demag_gradient": gradient_diagnostics(mesh.nodes, mesh.elements, phi, demag)})
    if not records:
        raise ValueError("empty potential comparison")
    return {"schema": "fullmag.archived_physical_potential_diagnostic.v1", "qualification": "NOT VERIFIED",
            "scope": "archived full phi Floquet pairs / outer z planes / P1 -grad(phi); not independent Poisson, runtime or convergence",
            "records": records}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("comparison", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    data = args.comparison.read_bytes()
    result = inspect(json.loads(data))
    result["comparison_sha256"] = hashlib.sha256(data).hexdigest()
    result["producer_sha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    print(json.dumps({"records": len(result["records"]),
        "max_phi_seam_relative": max(r["potential_seam_max_relative"] for r in result["records"]),
        "max_outer_z_relative": max(r["outer_z_plane_potential_max_relative"] for r in result["records"]),
        "max_demag_gradient_relative_l2": max(r["demag_gradient"]["volume_weighted_relative_l2"] for r in result["records"]),
        "qualification": result["qualification"]}))


if __name__ == "__main__":
    main()
