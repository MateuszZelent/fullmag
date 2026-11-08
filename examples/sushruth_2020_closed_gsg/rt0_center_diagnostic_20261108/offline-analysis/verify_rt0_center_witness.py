"""Offline audit of an unaccepted RT0 refusal witness; never invokes Fullmag."""
import argparse
from fractions import Fraction as Q
import json
import math
from pathlib import Path
import re
import struct

SCHEMA = "fullmag.rt0_center_failure.v1"
MARKER = " " + SCHEMA + "="
KEYS = {"schema", "element", "axis", "vertex_ids", "vertex_xyz_bits", "vertex_j_bits",
        "center_xyz_bits", "center_j_bits", "mean_bits", "scale_bits", "difference_bits",
        "budget_bits", "face_flux_bits"}

def bits(value):
    return struct.pack(">d", value).hex()

def number(value):
    if not isinstance(value, str) or not re.fullmatch("[0-9a-f]{16}", value):
        raise ValueError("expected exactly sixteen lowercase hexadecimal digits")
    return struct.unpack(">d", bytes.fromhex(value))[0]

def compensated(values):
    total = correction = 0.0
    for value in values:
        if not math.isfinite(value):
            raise ValueError("witness contradicts earlier nonfinite flux guard")
        next_total = total + value
        correction += ((total-next_total)+value if abs(total) >= abs(value)
                       else (value-next_total)+total)
        total = next_total
    result = total + correction
    if not math.isfinite(result):
        raise ValueError("witness contradicts earlier flux sum overflow guard")
    return result

def analyze(witness):
    if not isinstance(witness, dict) or set(witness) != KEYS or witness["schema"] != SCHEMA:
        raise ValueError("unsupported or incomplete witness")
    axis = witness["axis"]
    if type(axis) is not int or axis not in range(3):
        raise ValueError("invalid axis")
    for key in ["element", "mean_bits", "scale_bits", "difference_bits", "budget_bits"]:
        number(witness[key])
    expected_lengths = {"vertex_ids": 4, "vertex_xyz_bits": 12, "vertex_j_bits": 12,
                        "center_xyz_bits": 3, "center_j_bits": 3, "face_flux_bits": 4}
    values = {}
    for key, count in expected_lengths.items():
        row = witness[key]
        if not isinstance(row, list) or len(row) != count:
            raise ValueError("invalid fixed-array length: " + key)
        values[key] = [None if key == "face_flux_bits" and x is None else number(x) for x in row]
    ids = [int(x, 16) for x in witness["vertex_ids"]]
    if len(set(ids)) != 4:
        raise ValueError("duplicate stable vertex IDs")
    current = values["vertex_j_bits"]
    mean = compensated(current[3*i+axis] * .25 for i in range(4))
    scale = max(abs(current[3*i+axis]) for i in range(4))
    center_j = values["center_j_bits"]
    difference = abs(mean-center_j[axis])
    budget = 128.0 * 2.0**-52 * scale
    derived = dict(mean_bits=bits(mean), scale_bits=bits(scale),
                   difference_bits=bits(difference), budget_bits=bits(budget))
    replay = {"passes": math.isfinite(center_j[axis]) and difference <= budget,
              "derived_bits": derived,
              "derived_bits_match": all(witness[k] == v for k, v in derived.items())}
    coords, center, fluxes = values["vertex_xyz_bits"], values["center_xyz_bits"], values["face_flux_bits"]
    if not all(math.isfinite(x) for x in coords + center):
        raise ValueError("nonfinite witnessed geometry")
    points = [[Q(coords[3*i+a]) for a in range(3)] for i in range(4)]
    exact_center = [sum(p[a] for p in points)/4 for a in range(3)]
    delta = [Q(center[a])-exact_center[a] for a in range(3)]
    result = {"schema": "fullmag.rt0_center_offline_audit.v1", "witness": witness,
              "gate_replay": replay, "centroid_error_m": [float(x) for x in delta],
              "moment_reconstruction": {"available": False},
              "reconstruction_rounding": "exact rational moments followed by binary64 nearest-even",
              "native_cpp_executed": False, "solver_executed": False,
              "accepted_source": False, "physics_qualified": False}
    if any(f is None or not math.isfinite(f) for f in fluxes):
        result["moment_reconstruction"]["reason"] = "missing or nonfinite canonical face moment"
        return result
    edges = [[points[i][a]-points[0][a] for a in range(3)] for i in range(1,4)]
    a,b,c = edges
    determinant = sum(a[i]*(b[(i+1)%3]*c[(i+2)%3]-b[(i+2)%3]*c[(i+1)%3]) for i in range(3))
    if determinant <= 0:
        raise ValueError("witness contradicts prior positive Tet4 volume guard")
    outward_faces = [(1,2,3),(0,3,2),(0,1,3),(0,2,1)]
    outward = []
    for face, flux in zip(outward_faces, fluxes):
        face_ids = [ids[i] for i in face]
        inversions = sum(face_ids[i] > face_ids[j] for i in range(3) for j in range(i+1,3))
        outward.append(Q(flux) * (-1 if inversions % 2 else 1))
    def field(point):
        return [2*sum(outward[i]*(point[a]-points[i][a]) for i in range(4))/determinant
                for a in range(3)]
    vertex_predicted = [float(v) for p in points for v in field(p)]
    center_predicted = [float(v) for v in field([Q(x) for x in center])]
    slope = 2*sum(outward)/determinant
    result["moment_reconstruction"] = {
        "available": True,
        "vertex_j_bits": [bits(v) for v in vertex_predicted],
        "center_j_bits": [bits(v) for v in center_predicted],
        "all_vertex_samples_match": all(bits(v) == x for v,x in zip(vertex_predicted,witness["vertex_j_bits"])),
        "all_center_samples_match": all(bits(v) == x for v,x in zip(center_predicted,witness["center_j_bits"])),
        "centroid_shift_delta_j_apm2": [float(slope*x) for x in delta],
        "coefficient_provenance": "canonical face moments, not unpublished MFEM coefficient bytes",
    }
    return result

def unique_pairs(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate JSON key: " + key)
        value[key] = item
    return value

def read_witness(path):
    raw = Path(path).read_bytes()
    if len(raw) > 65536:
        raise ValueError("witness input exceeds 64 KiB")
    value = json.loads(raw, object_pairs_hook=unique_pairs)
    if isinstance(value,dict) and value.get("schema") == SCHEMA:
        return value, raw
    reason = value.get("failure_reason") if isinstance(value,dict) else value
    if not isinstance(reason,str) or MARKER not in reason:
        raise ValueError("no complete RT0 center witness in the failure report")
    witness, _ = json.JSONDecoder(object_pairs_hook=unique_pairs).raw_decode(reason.split(MARKER,1)[1])
    return witness, raw

if __name__ == "__main__":
    import hashlib
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input",type=Path)
    parser.add_argument("output",type=Path)
    args = parser.parse_args()
    witness, raw = read_witness(args.input)
    report = analyze(witness)
    report["input_sha256"] = hashlib.sha256(raw).hexdigest()
    with args.output.open("x") as stream:
        json.dump(report,stream,indent=2,allow_nan=False)
    print(json.dumps({"gate_passes":report["gate_replay"]["passes"],
                     "output_sha256":hashlib.sha256(args.output.read_bytes()).hexdigest(),
                     "physics_qualified":False}))
