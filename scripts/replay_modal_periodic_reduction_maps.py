"""Replay periodic class numbering from a cached mesh and accepted runtime pairs.

This diagnostic compares numbering to independent graph components. It does
not execute FEM or certify eigenfrequencies, residuals, or convergence.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import zipfile
import numpy as np


def replay(node_count, magnetic_nodes, pairs, minimum_root):
    adjacency = [set() for _ in range(node_count)]
    for a, b in pairs:
        if not (0 <= a < node_count and 0 <= b < node_count):
            raise ValueError("periodic pair outside mesh")
        adjacency[a].add(b)
        adjacency[b].add(a)
    canonical = [None] * node_count
    for start in range(node_count):
        if canonical[start] is not None:
            continue
        queue = [start]
        canonical[start] = start
        for node in queue:
            for neighbor in adjacency[node]:
                if canonical[neighbor] is None:
                    canonical[neighbor] = start
                    queue.append(neighbor)
    parent = list(range(node_count))

    def find(node):
        while parent[node] != node:
            parent[node] = parent[parent[node]]
            node = parent[node]
        return node

    for a, b in pairs:
        a, b = find(a), find(b)
        if a != b:
            if minimum_root:
                parent[max(a, b)] = min(a, b)
            else:
                parent[b] = a
    scalar_ids = {}
    scalar = []
    for node in range(node_count):
        root = find(node)
        scalar_ids.setdefault(root, len(scalar_ids))
        scalar.append(scalar_ids[root])
    roots = sorted({find(node) for node in magnetic_nodes})
    magnetic_ids = {root: index for index, root in enumerate(roots)}
    expected_scalar = {root: index for index, root in enumerate(sorted(set(canonical)))}
    expected_magnetic = {root: index for index, root in
                         enumerate(sorted({canonical[node] for node in magnetic_nodes}))}
    magnetic = [magnetic_ids[find(node)] if node in magnetic_nodes else 2**32 - 1
                for node in range(node_count)]
    scalar_bad = [node for node in range(node_count)
                  if scalar[node] != expected_scalar[canonical[node]]]
    magnetic_bad = [node for node in sorted(magnetic_nodes)
                    if magnetic[node] != expected_magnetic[canonical[node]]]
    return {"scalar_mismatched_nodes": scalar_bad,
            "magnetic_mismatched_nodes": magnetic_bad,
            "scalar_class_count": len(scalar_ids),
            "magnetic_class_count": len(roots),
            "scalar_map": scalar, "magnetic_map": magnetic}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mesh", required=True, type=Path)
    parser.add_argument("--runtime-pairs", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    with zipfile.ZipFile(args.mesh) as archive:
        topology = np.load(io.BytesIO(archive.read("topology.npz")), allow_pickle=False)
        metadata = json.loads(str(topology["metadata_json"]))
        markers = topology["element_markers"]
        if set(markers.tolist()) != {0, 1}:
            raise ValueError("replay currently requires a single magnetic tet4 region")
        if set(topology["cell_types"].tolist()) != {"tet4"}:
            raise ValueError("replay requires tet4 cells")
        count = len(topology["nodes"])
        old_magnetic = set(topology["cell_nodes"].reshape(-1, 4)[markers == 1].ravel().tolist())
        # Single-region pack_mesh_by_analysis preserves ascending source-node
        # order within the magnetic prefix, followed by air-only nodes.
        order = sorted(old_magnetic) + sorted(set(range(count)) - old_magnetic)
        remap = {node: index for index, node in enumerate(order)}
        pairs = [(remap[p["node_a"]], remap[p["node_b"]])
                 for p in metadata["periodic_node_pairs"]]
    accepted = json.loads(args.runtime_pairs.read_text(encoding="utf-8"))
    if accepted["certificate_status"] != "accepted" or accepted["validation_status"] != "ok":
        raise ValueError("runtime periodic certificate is not accepted")
    actual_order = list(dict.fromkeys((p["node_a"], p["node_b"])
                    for boundary in accepted["pairs"] for p in boundary["node_pairs"]))
    packed_order = list(dict.fromkeys(pairs))
    if packed_order != actual_order:
        raise ValueError("reconstructed packing does not match actual runtime node pair order")
    magnetic = set(range(len(old_magnetic)))
    legacy = replay(count, magnetic, pairs, False)
    fixed = replay(count, magnetic, pairs, True)
    reversed_pairs = [(b, a) for a, b in reversed(pairs)]
    alternate = replay(count, magnetic, reversed_pairs, True)
    if fixed != alternate or fixed["scalar_mismatched_nodes"] or fixed["magnetic_mismatched_nodes"]:
        raise ValueError("minimum-root map violates canonical numbering or order invariance")
    for result in (legacy, fixed):
        result.pop("scalar_map")
        result.pop("magnetic_map")
    report = {"schema": "fullmag.modal-periodic-map-replay.v1",
              "qualification": "diagnostic only; native runtime NOT VERIFIED",
              "node_count": count, "magnetic_node_count": len(magnetic),
              "unique_periodic_pair_count": len(set(pairs)),
              "runtime_pair_set_matches_packed_source": True,
              "runtime_pair_order_matches_packed_source": True,
              "legacy": legacy, "minimum_root": fixed,
              "direction_and_order_invariant": True,
              "input_sha256": {str(p): hashlib.sha256(p.read_bytes()).hexdigest()
                               for p in (args.mesh, args.runtime_pairs)}}
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"report": str(args.output),
                      "legacy_magnetic_mismatch_count": len(legacy["magnetic_mismatched_nodes"]),
                      "fixed_magnetic_mismatch_count": len(fixed["magnetic_mismatched_nodes"])}))


if __name__ == "__main__":
    main()
