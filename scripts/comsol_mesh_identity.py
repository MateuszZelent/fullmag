"""Recompute the typed Rust MeshIR periodic-v6 (topology-v2) identity.

Field order follows fem_mesh_topology_fingerprint_v2, not sorted JSON keys.
Only canonical exported MeshIR is accepted; missing topology is not guessed.
"""
import hashlib
import math
from collections.abc import Mapping
from verify_fem_frequency_domain_eigen_artifacts import serde_json_compact_bytes


def _ordered_bytes(value):
    if isinstance(value, dict):
        return b"{" + b",".join(serde_json_compact_bytes(key) + b":" + _ordered_bytes(item) for key, item in value.items()) + b"}"
    if isinstance(value, list):
        return b"[" + b",".join(_ordered_bytes(item) for item in value) + b"]"
    return serde_json_compact_bytes(value)


def mesh_topology_fingerprint_v2(mesh):
    if not isinstance(mesh, Mapping):
        raise ValueError("canonical MeshIR object is required")
    def required_array(source, key):
        value=source.get(key)
        if not isinstance(value,list):raise ValueError(f"canonical mesh {key} array is required")
        return value
    def floats(values):
        import math
        if not isinstance(values,list) or len(values)!=3 or any(type(x) not in (int,float) or not math.isfinite(x) for x in values):
            raise ValueError("finite three-component mesh vector is required")
        return [float(x) for x in values]
    def connectivity(key, fields):
        source=mesh.get(key)
        if not isinstance(source,Mapping):raise ValueError(f"canonical {key} connectivity is required")
        result = {field: required_array(source, field) for field in fields}
        count = len(result["types"])
        ordinals = result["global_ordinals"]
        if len(ordinals) != count or any(type(value) is not int or value < 0 for value in ordinals):
            raise ValueError("canonical global_ordinals must explicitly cover every element")
        return result
    pairs=[]
    for source in required_array(mesh,"periodic_boundary_pairs"):
        if not isinstance(source,Mapping):raise ValueError("periodic pair must be an object")
        if "tolerance_m" in source:
            raise ValueError("canonical periodic pair requires tolerance, not tolerance_m")
        pair={}
        for key in ("pair_id","source_marker","destination_marker","marker_a","marker_b","translation","tolerance","axis_hint","orientation","pairing_policy"):
            value=source.get(key)
            if key in ("pair_id","marker_a","marker_b") and value is None:
                raise ValueError(f"canonical periodic pair requires {key}")
            if value is not None:
                if key=="translation":value=floats(value)
                if key=="tolerance":
                    if type(value) not in (int,float):raise ValueError("periodic tolerance must be numeric")
                    value=float(value)
                    if not math.isfinite(value):
                        raise ValueError("periodic tolerance must be finite")
                pair[key]=value
        pairs.append(pair)
    node_pairs=[]
    for source in required_array(mesh,"periodic_node_pairs"):
        if not isinstance(source,Mapping) or any(key not in source for key in ("pair_id","node_a","node_b")):
            raise ValueError("canonical periodic node pair is required")
        node_pairs.append({key:source[key] for key in ("pair_id","node_a","node_b")})
    payload={"nodes":[floats(row) for row in required_array(mesh,"nodes")],
             "cells":connectivity("cells",("types","offsets","nodes","global_ordinals","mesh_parts")),
             "element_markers":required_array(mesh,"element_markers"),
             "facets":connectivity("facets",("types","roles","offsets","nodes","global_ordinals")),
             "boundary_markers":required_array(mesh,"boundary_markers"),
             "periodic_boundary_pairs":pairs,"periodic_node_pairs":node_pairs}
    return "sha256:"+hashlib.sha256(b"fullmag:fem-mesh-topology-fingerprint:v2"+_ordered_bytes(payload)).hexdigest()
