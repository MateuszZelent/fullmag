"""Inspect archived magnetic mode seams using explicit periodic mesh pairs.
This is an independent diagnostic, not execution of the production Rust tracker.
"""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from compare_de_bv_mode_profiles import load_record


def magnetic_pair_seams(nodes, field, magnetic_nodes, pairs, definitions, k):
    nodes, field, k = np.asarray(nodes, float), np.asarray(field, complex), np.asarray(k, float)
    if nodes.ndim != 2 or nodes.shape[1] != 3 or field.shape != nodes.shape or k.shape != (3,):
        raise ValueError("invalid Cartesian seam shapes")
    if not np.isfinite(nodes).all() or not np.isfinite(field).all() or not np.isfinite(k).all():
        raise ValueError("nonfinite seam inputs")
    magnetic = set(int(node) for node in magnetic_nodes)
    if not magnetic or min(magnetic) < 0 or max(magnetic) >= len(nodes):
        raise ValueError("invalid magnetic nodes")
    translations = {}
    for definition in definitions:
        pair_id = definition["pair_id"]
        translation = np.asarray(definition["translation"], float)
        tolerance = definition["tolerance_m"]
        if translation.shape != (3,) or not np.isfinite(translation).all() or np.linalg.norm(translation) == 0:
            raise ValueError("invalid periodic translation")
        if isinstance(tolerance, bool) or not np.isfinite(tolerance) or tolerance <= 0:
            raise ValueError("invalid periodic coordinate tolerance")
        old = translations.get(pair_id)
        if old is not None and (not np.array_equal(old[0], translation) or old[1] != tolerance):
            raise ValueError("ambiguous periodic translation")
        translations[pair_id] = (translation, tolerance)
    scale = float(np.max(np.abs(field[list(magnetic)])))
    if not np.isfinite(scale) or scale <= 0:
        raise ValueError("zero or unrepresentable mode amplitude")
    scaled = field / scale
    denominator = float(np.max(np.linalg.norm(scaled[list(magnetic)], axis=1)))
    result, seen = [], set()
    for pair in pairs:
        a, b = pair["node_a"], pair["node_b"]
        if isinstance(a, bool) or isinstance(b, bool) or not isinstance(a, int) or not isinstance(b, int):
            raise ValueError("invalid periodic node index")
        if not 0 <= a < len(nodes) or not 0 <= b < len(nodes) or a == b:
            raise ValueError("periodic node outside topology")
        if a not in magnetic or b not in magnetic:
            continue
        identity = (pair["pair_id"], a, b)
        if identity in seen:
            raise ValueError("duplicate magnetic node pair")
        seen.add(identity)
        translation, tolerance = translations[pair["pair_id"]]
        delta = nodes[b] - nodes[a]
        if np.linalg.norm(delta - translation) > tolerance:
            raise ValueError("node pair does not follow declared oriented translation")
        angle = float(k @ translation)
        if not np.isfinite(angle):
            raise ValueError("unrepresentable Floquet phase")
        phase = np.exp(-1j * angle)
        def defect(p):
            return float(np.linalg.norm(scaled[b] - p * scaled[a]) / denominator)
        result.append({"pair_id": pair["pair_id"], "node_a": a, "node_b": b,
                       "phase_rad": -angle, "relative_mismatch": defect(phase),
                       "wrong_sign_relative_mismatch": defect(phase.conjugate()),
                       "no_phase_relative_mismatch": defect(1.0)})
    if not result:
        raise ValueError("no magnetic periodic node pairs measured")
    if not all(np.isfinite(row[key]) for row in result for key in
               ("relative_mismatch", "wrong_sign_relative_mismatch", "no_phase_relative_mismatch")):
        raise ValueError("nonfinite seam defect")
    return result


def inspect(comparison):
    records = []
    for record in comparison["records"]:
        mesh, envelope, tetra, _, hashes, _ = load_record(record)
        k = np.asarray([0, record["k_rad_per_m"], 0] if record["geometry"] == "damon_eshbach"
                       else [record["k_rad_per_m"], 0, 0], float)
        field = envelope * np.exp(-1j * (mesh.nodes @ k))[:, None]
        pairs = magnetic_pair_seams(mesh.nodes, field, np.unique(tetra), mesh.periodic_node_pairs,
                                    mesh.periodic_boundary_pairs, k)
        records.append({"geometry": record["geometry"], "pilot": record["pilot"],
                        "k_rad_per_m": record["k_rad_per_m"], "frequency_hz": record["frequency_hz"],
                        "source_mesh_topology_sha256": mesh.topology_fingerprint_v3(),
                        "input_sha256": hashes, "magnetic_pair_count": len(pairs),
                        "max_relative_mismatch": max(p["relative_mismatch"] for p in pairs),
                        "wrong_sign_max_relative_mismatch": max(p["wrong_sign_relative_mismatch"] for p in pairs),
                        "no_phase_max_relative_mismatch": max(p["no_phase_relative_mismatch"] for p in pairs),
                        "pairs": pairs})
    if not records:
        raise ValueError("empty comparison")
    return {"schema": "fullmag.archived_magnetic_mode_seams.v1", "qualification": "NOT VERIFIED",
            "scope": "independent explicit magnetic-pair diagnostic; not Rust execution, phi or convergence",
            "phase_convention": "exp_minus_i_k_dot_translation", "records": records,
            "max_relative_mismatch": max(r["max_relative_mismatch"] for r in records)}


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
                      "max_relative_mismatch": result["max_relative_mismatch"],
                      "qualification": result["qualification"]}))


if __name__ == "__main__":
    main()
