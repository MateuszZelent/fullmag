"""Independently assemble archived P1 Poisson weak residual with Floquet reduction.
No FEM solver is launched; this audits old fields and does not qualify convergence.
"""
from collections import deque
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from audit_de_bv_potential_fields import inspect as inspect_potential, payload
from compare_de_bv_mode_profiles import load_record, contained, sha256


def weak_poisson_residual(nodes, tetra, markers, phi, magnetization, ms, pairs, definitions, k, fixed_nodes):
    nodes, tetra, markers = np.asarray(nodes, float), np.asarray(tetra), np.asarray(markers)
    phi, magnetization, k = np.asarray(phi, complex), np.asarray(magnetization, complex), np.asarray(k, float)
    if (nodes.ndim != 2 or nodes.shape[1] != 3 or phi.shape != (len(nodes),)
        or magnetization.shape != nodes.shape or k.shape != (3,)
        or tetra.ndim != 2 or tetra.shape[1] != 4 or not len(tetra)
        or not np.issubdtype(tetra.dtype, np.integer) or markers.shape != (len(tetra),)
        or set(markers.tolist()) - {0, 1} or tetra.min() < 0 or tetra.max() >= len(nodes)):
        raise ValueError("unsupported uniform-film Poisson shapes/markers")
    if isinstance(ms, bool) or not np.isfinite(ms) or ms <= 0:
        raise ValueError("uniform-film Ms must be finite positive")
    if not all(np.isfinite(value).all() for value in [nodes, phi, magnetization, k]):
        raise ValueError("nonfinite weak Poisson data")
    fixed_nodes = np.asarray(fixed_nodes)
    if (fixed_nodes.ndim != 1 or not np.issubdtype(fixed_nodes.dtype, np.integer)
        or (fixed_nodes.size and (fixed_nodes.min() < 0 or fixed_nodes.max() >= len(nodes)))):
        raise ValueError("invalid Dirichlet node indices")
    matrix = nodes[tetra[:, 1:]] - nodes[tetra[:, 0]][:, None, :]
    volumes = np.abs(np.linalg.det(matrix)) / 6
    if not np.isfinite(volumes).all() or (volumes <= 0).any():
        raise ValueError("degenerate Poisson tetra")
    gradients_123 = np.linalg.inv(matrix).transpose(0, 2, 1)
    gradients = np.concatenate([-gradients_123.sum(axis=1)[:, None, :], gradients_123], axis=1)
    grad_phi = np.einsum("tij,ti->tj", gradients, phi[tetra])
    lhs_local = volumes[:, None] * np.einsum("tij,tj->ti", gradients, grad_phi)
    mean_m = magnetization[tetra].mean(axis=1)
    mean_m[markers != 1] = 0
    rhs_local = volumes[:, None] * np.einsum("tij,tj->ti", gradients, ms*mean_m)
    if not np.isfinite(lhs_local).all() or not np.isfinite(rhs_local).all():
        raise ValueError("unrepresentable assembled weak terms")
    lhs, rhs = np.zeros(len(nodes), complex), np.zeros(len(nodes), complex)
    np.add.at(lhs, tetra.ravel(), lhs_local.ravel())
    np.add.at(rhs, tetra.ravel(), rhs_local.ravel())
    translations = {}
    for definition in definitions:
        translation = np.asarray(definition["translation"], float)
        tolerance = definition["tolerance_m"]
        if translation.shape != (3,) or not np.isfinite(translation).all() or not np.isfinite(tolerance) or tolerance <= 0:
            raise ValueError("invalid periodic translation/tolerance")
        existing = translations.get(definition["pair_id"])
        if existing is not None and (not np.array_equal(existing[0], translation) or existing[1] != tolerance):
            raise ValueError("ambiguous periodic translation")
        translations[definition["pair_id"]] = (translation, tolerance)
    graph = [[] for _ in nodes]
    seen = set()
    for pair in pairs:
        a, b = pair["node_a"], pair["node_b"]
        if type(a) is not int or type(b) is not int or not 0 <= a < len(nodes) or not 0 <= b < len(nodes) or a == b:
            raise ValueError("invalid periodic Poisson nodes")
        identity = (pair["pair_id"], a, b)
        if identity in seen:
            raise ValueError("duplicate periodic Poisson pair")
        seen.add(identity)
        translation, tolerance = translations[pair["pair_id"]]
        if np.linalg.norm(nodes[b] - nodes[a] - translation) > tolerance:
            raise ValueError("Poisson pair does not follow oriented translation")
        angle = float(k @ translation)
        if not np.isfinite(angle):
            raise ValueError("unrepresentable Poisson phase")
        phase = np.exp(-1j*angle)
        graph[a].append((b, phase)); graph[b].append((a, phase.conjugate()))
    classes, phases = np.full(len(nodes), -1, int), np.ones(len(nodes), complex)
    count, cycle_defect = 0, 0.0
    for root in range(len(nodes)):
        if classes[root] >= 0:
            continue
        classes[root] = count
        queue = deque([root])
        while queue:
            a = queue.popleft()
            for b, factor in graph[a]:
                expected = phases[a] * factor
                if classes[b] < 0:
                    classes[b] = count; phases[b] = expected; queue.append(b)
                else:
                    cycle_defect = max(cycle_defect, float(abs(phases[b] - expected)))
        count += 1
    cycle_roundoff_bound = 64*np.finfo(float).eps*max(1, len(pairs))
    if cycle_defect > cycle_roundoff_bound:
        raise ValueError("inconsistent phase constraint cycle")
    reduced_lhs, reduced_rhs = np.zeros(count, complex), np.zeros(count, complex)
    np.add.at(reduced_lhs, classes, phases.conjugate()*lhs)
    np.add.at(reduced_rhs, classes, phases.conjugate()*rhs)
    fixed_classes = np.unique(classes[fixed_nodes])
    free = np.setdiff1d(np.arange(count), fixed_classes)
    if not len(free):
        raise ValueError("no free Poisson test functions")
    lhs, rhs = reduced_lhs[free], reduced_rhs[free]
    scale = max(float(np.max(np.abs(lhs))), float(np.max(np.abs(rhs))))
    if not np.isfinite(scale) or scale <= 0:
        raise ValueError("zero or unrepresentable Poisson weak norm")
    lhs, rhs = lhs/scale, rhs/scale
    denominator = np.linalg.norm(lhs) + np.linalg.norm(rhs)
    fit = np.vdot(rhs, lhs) / np.vdot(rhs, rhs) if np.vdot(rhs, rhs).real > 0 else complex(np.nan)
    fitted_defect = float(np.linalg.norm(lhs-fit*rhs) / denominator)
    residual = float(np.linalg.norm(lhs-rhs) / denominator)
    wrong_sign = float(np.linalg.norm(lhs+rhs) / denominator)
    if not np.isfinite(residual) or not np.isfinite(wrong_sign):
        raise ValueError("nonfinite weak Poisson residual")
    return {"relative_weak_residual": residual, "wrong_source_sign_relative": wrong_sign,
            "diagnostic_source_scale_fit_real": float(fit.real), "diagnostic_source_scale_fit_imag": float(fit.imag),
            "diagnostic_after_fit_relative_defect": fitted_defect,
            "source_scale_fit_applied_to_data": False,

            "free_phi_class_count": len(free), "dirichlet_phi_class_count": len(fixed_classes),
            "phase_cycle_defect": cycle_defect, "cycle_roundoff_bound": cycle_roundoff_bound,
            "periodic_pair_count": len(pairs)}


def inspect(comparison):
    # Reuse strict potential metadata/identity checks before re-reading bound payloads.
    prior = inspect_potential(comparison)
    records = []
    for record, checked in zip(comparison["records"], prior["records"]):
        mesh, envelope, _, _, hashes, _ = load_record(record)
        case = contained(Path(record["run_path"]).resolve(), record["pilot"])
        meta_path = contained(case, "eigen/mode_fields/sample_0000/mode_0000/physical_potential.v1.json")
        if sha256(meta_path) != checked["input_sha256"]["physical_potential_metadata"]:
            raise ValueError("potential metadata changed during independent inspection")
        metadata = json.loads(meta_path.read_text(encoding="utf-8"))
        phi, phi_hash = payload(case, metadata["potential"], "node_major_real_imag", mesh.n_nodes, 1, "A")
        if phi_hash != checked["input_sha256"]["potential_binary"]:
            raise ValueError("physical potential changed during inspection")
        k = np.asarray([0, record["k_rad_per_m"], 0] if record["geometry"] == "damon_eshbach"
                       else [record["k_rad_per_m"], 0, 0], float)
        m = envelope * np.exp(-1j*(mesh.nodes @ k))[:, None]
        z = mesh.nodes[:, 2]
        fixed = np.flatnonzero((z == z.min()) | (z == z.max()))
        result = weak_poisson_residual(mesh.nodes, mesh.elements, mesh.element_markers, phi, m,
            record["parameters"]["saturation_magnetisation_a_per_m"], mesh.periodic_node_pairs,
            mesh.periodic_boundary_pairs, k, fixed)
        records.append({"pilot": record["pilot"], "geometry": record["geometry"],
                        "k_rad_per_m": record["k_rad_per_m"], "frequency_hz": record["frequency_hz"],
                        "source_mesh_topology_sha256": mesh.topology_fingerprint_v3(),
                        "input_sha256": checked["input_sha256"], "poisson": result})
    return {"schema": "fullmag.archived_poisson_weak_diagnostic.v1", "qualification": "NOT VERIFIED",
            "scope": "independent P1 Poisson weak assembly / Floquet C^H / benchmark outer-z Dirichlet; not a new solve or convergence",
            "residual_definition": "norm(C^H(K_phi*phi-S_M*m))/(norm(C^H*K_phi*phi)+norm(C^H*S_M*m)) on free classes",
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
        "max_relative_weak_residual": max(r["poisson"]["relative_weak_residual"] for r in result["records"]),
        "min_wrong_source_sign_relative": min(r["poisson"]["wrong_source_sign_relative"] for r in result["records"]),
        "qualification": result["qualification"]}))


if __name__ == "__main__":
    main()
