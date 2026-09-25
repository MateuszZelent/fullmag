"""Recompute the typed Rust MeshIR periodic-v6 (topology-v2) identity.

Field order follows fem_mesh_topology_fingerprint_v2, not sorted JSON keys.
Only canonical exported MeshIR is accepted; missing topology is not guessed.
"""
import hashlib
import math
import operator
import struct
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


def mesh_topology_fingerprint_v3(mesh):
    """Recompute the typed mixed-mesh v3 identity emitted by MeshIR.

    This is a byte-for-byte Python port of
    ``fullmag_ir::fem_mesh_topology_fingerprint_v3``.  It is deliberately a
    separate function: ``MeshIR.topology_fingerprint_v6`` is the historical
    periodic-certificate v2 identity and must not be used for modal field
    source binding.
    """
    if not isinstance(mesh, Mapping):
        raise ValueError("canonical MeshIR object is required")

    encoded = bytearray(b"fullmag:fem-mesh-topology-fingerprint:v3")

    def u8(value):
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 0xFF:
            raise ValueError("topology fingerprint v3 u8 value is out of range")
        encoded.extend(struct.pack("<B", value))

    def integer(value, bits):
        try:
            integer_value = operator.index(value)
        except TypeError as error:
            raise TypeError("topology fingerprint v3 integer field must be an integer") from error
        maximum = (1 << bits) - 1
        if isinstance(value, bool) or integer_value < 0 or integer_value > maximum:
            raise ValueError("topology fingerprint v3 integer value is out of range")
        encoded.extend(struct.pack("<Q" if bits == 64 else "<I", integer_value))

    def u32(value):
        integer(value, 32)

    def u64(value):
        integer(value, 64)

    def f64(value):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise TypeError("topology fingerprint v3 f64 field must be numeric")
        number = float(value)
        if not math.isfinite(number):
            raise ValueError("topology fingerprint v3 requires finite f64 values")
        bits = struct.unpack("<Q", struct.pack("<d", number))[0]
        u64(bits)

    def string(value):
        if not isinstance(value, str):
            raise TypeError("topology fingerprint v3 string field must be a string")
        data = value.encode("utf-8")
        u64(len(data))
        encoded.extend(data)

    def sequence(values, write_item):
        if not isinstance(values, list):
            raise ValueError("topology fingerprint v3 sequence field must be an array")
        u64(len(values))
        for item in values:
            write_item(item)

    def optional(value, write_value):
        if value is None:
            u8(0)
        else:
            u8(1)
            write_value(value)

    def f64x3(values):
        if not isinstance(values, list) or len(values) != 3:
            raise ValueError("topology fingerprint v3 vector must have three components")
        for item in values:
            f64(item)

    def enum(mapping, value):
        if not isinstance(value, str):
            raise TypeError("topology fingerprint v3 enum field must be a string")
        try:
            tag = mapping[value]
        except KeyError as error:
            raise ValueError(f"topology fingerprint v3 has unsupported enum value {value!r}") from error
        u8(tag)

    cells = mesh.get("cells")
    facets = mesh.get("facets")
    if not isinstance(cells, Mapping) or not isinstance(facets, Mapping):
        raise ValueError("canonical cells and facets connectivity are required")

    sequence(mesh.get("nodes"), f64x3)
    sequence(cells.get("types"), lambda value: enum(
        {"tet4": 1, "prism6": 2, "pyramid5": 3, "hex8": 4}, value))
    sequence(cells.get("offsets"), u32)
    sequence(cells.get("nodes"), u32)
    sequence(cells.get("global_ordinals"), u64)
    sequence(cells.get("mesh_parts"), lambda value: enum(
        {
            "magnetic": 1,
            "transition_air": 2,
            "far_air": 3,
        },
        value))
    sequence(mesh.get("element_markers"), u32)
    sequence(facets.get("types"), lambda value: enum({"tri3": 1, "quad4": 2}, value))
    sequence(facets.get("roles"), lambda value: enum(
        {"exterior": 1, "material_interface": 2, "periodic_seam": 3}, value))
    sequence(facets.get("offsets"), u32)
    sequence(facets.get("nodes"), u32)
    sequence(facets.get("global_ordinals"), u64)
    sequence(mesh.get("boundary_markers"), u32)

    def periodic_boundary_pair(pair):
        if not isinstance(pair, Mapping):
            raise TypeError("topology fingerprint v3 periodic boundary pair must be an object")
        string(pair.get("pair_id"))
        optional(pair.get("source_marker"), string)
        optional(pair.get("destination_marker"), string)
        u32(pair.get("marker_a", 0))
        u32(pair.get("marker_b", 0))
        optional(pair.get("translation"), f64x3)
        tolerance = pair.get("tolerance")
        if tolerance is None:
            tolerance = pair.get("tolerance_m")
        optional(tolerance, f64)
        optional(pair.get("axis_hint"), string)
        optional(pair.get("orientation"), string)
        optional(pair.get("pairing_policy"), string)

    sequence(mesh.get("periodic_boundary_pairs"), periodic_boundary_pair)

    def periodic_node_pair(pair):
        if not isinstance(pair, Mapping):
            raise TypeError("topology fingerprint v3 periodic node pair must be an object")
        string(pair.get("pair_id"))
        u32(pair.get("node_a"))
        u32(pair.get("node_b"))

    sequence(mesh.get("periodic_node_pairs"), periodic_node_pair)
    return "sha256:" + hashlib.sha256(encoded).hexdigest()
