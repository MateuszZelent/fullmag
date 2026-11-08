"""Read-only arithmetic study of a proposed stored-point gate; never runs Fullmag."""
from fractions import Fraction as Q
import hashlib
import json
import math
from pathlib import Path
import struct

def value(bits):
    return struct.unpack(">d", bytes.fromhex(bits))[0]

def exact_field(points, ids, canonical_fluxes, point):
    points = [[Q(x) for x in row] for row in points]
    edges = [[points[i][a] - points[0][a] for a in range(3)] for i in range(1, 4)]
    a, b, c = edges
    det = sum(a[k] * (b[(k+1)%3]*c[(k+2)%3] - b[(k+2)%3]*c[(k+1)%3])
              for k in range(3))
    if det <= 0:
        raise ValueError("nonpositive determinant")
    outward = []
    for face, flux in zip([(1,2,3), (0,3,2), (0,1,3), (0,2,1)], canonical_fluxes):
        order = [ids[i] for i in face]
        odd = sum(order[i] > order[j] for i in range(3) for j in range(i+1,3)) % 2
        outward.append(Q(flux) * (-1 if odd else 1))
    return [2 * sum(outward[i] * (Q(point[k]) - points[i][k]) for i in range(4)) / det
            for k in range(3)]

def proposed_gate(expected, sample, nodal_samples):
    if not all(math.isfinite(x) for x in [sample] + nodal_samples):
        return False
    budget = Q(max(abs(x) for x in nodal_samples)) / (1 << 45)
    return abs(Q(sample) - expected) <= budget

def main():
    root = Path(__file__).resolve().parent
    witness_path = root.parent / "rt0_center_diagnostic_20261108/offline-analysis/fixtures/actual-first-center-refusal.json"
    raw = witness_path.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == "3337bf6858ecebfd9ee63eecb799a74353ae5ec5b45de8faf27a83b6e9c1d1db"
    w = json.loads(raw)
    points = [[value(w["vertex_xyz_bits"][3*i+k]) for k in range(3)] for i in range(4)]
    currents = [[value(w["vertex_j_bits"][3*i+k]) for k in range(3)] for i in range(4)]
    center = [value(x) for x in w["center_xyz_bits"]]
    sampled = [value(x) for x in w["center_j_bits"]]
    expected = exact_field(points, [int(x,16) for x in w["vertex_ids"]],
                           [value(x) for x in w["face_flux_bits"]], center)
    checks = []
    def check(name, condition):
        assert condition, name
        checks.append(name)
    for k in range(3):
        check("actual_component_" + str(k),
              proposed_gate(expected[k], sampled[k], [p[k] for p in currents]))
    check("actual_reconstructed_bits",
          [struct.pack(">d",float(x)).hex() for x in expected] == w["center_j_bits"])
    old_mean = value(w["mean_bits"])
    check("old_gate_still_rejects_actual",
          abs(old_mean - sampled[1]) > value(w["budget_bits"]))
    check("old_mean_is_wrong_point_for_new_gate",
          not proposed_gate(expected[1], old_mean, [p[1] for p in currents]))
    # Independent analytic constant field on the unit tetrahedron.
    unit = [[0.,0.,0.], [1.,0.,0.], [0.,1.,0.], [0.,0.,1.]]
    constant = exact_field(unit, [1,2,3,4], [4.,4.,0.,0.], [.25,.25,.25])
    check("analytic_constant_field", constant == [Q(8), Q(0), Q(0)])
    boundary = 8. + 128. * 2.**-52 * 8.
    next_value = struct.unpack(">d", struct.pack(">Q", struct.unpack(">Q",struct.pack(">d",boundary))[0]+1))[0]
    check("constant_boundary_inclusive", proposed_gate(constant[0], boundary, [8.]*4))
    check("constant_next_float_rejected", not proposed_gate(constant[0], next_value, [8.]*4))
    check("zero_field", proposed_gate(Q(0), -0., [0.]*4))
    check("no_absolute_floor", not proposed_gate(Q(0), float.fromhex("0x0.0000000000001p-1022"), [0.]*4))
    for sample in [float("nan"), float("inf")]:
        check("nonfinite_sample_" + str(sample), not proposed_gate(Q(0), sample, [1.]*4))
    for exponent in [-500, 500]:
        factor = 2.**exponent
        check("current_scale_" + str(exponent),
              proposed_gate(expected[1]*Q(factor), sampled[1]*factor,
                            [p[1]*factor for p in currents]))
    report = {
        "schema": "fullmag.stored_point_policy_readonly_audit.v1",
        "checks_passed": len(checks), "checks": checks,
        "actual_witness_sha256": hashlib.sha256(raw).hexdigest(),
        "actual_component_y_exact_error_apm2": float(abs(Q(sampled[1])-expected[1])),
        "actual_component_y_budget_apm2": float(Q(max(abs(p[1]) for p in currents))/(1 << 45)),
        "native_cpp_executed": False, "production_gate_changed": False,
        "new_solver_runs": 0, "accepted_source": False, "physics_qualified": False,
    }
    target = root / "stored_point_policy_audit.json"
    with target.open("x") as stream:
        json.dump(report, stream, indent=2, allow_nan=False)
    print(json.dumps(report, indent=2))

if __name__ == "__main__":
    main()
