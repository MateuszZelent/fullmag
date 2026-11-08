"""Exact geometry readback of the captured first refusal; no Fullmag execution."""
import json, struct, math, hashlib
from fractions import Fraction as Q
from pathlib import Path
import sys

def value(bits):
    return struct.unpack(">d", bytes.fromhex(bits))[0]
def bits(value):
    return struct.pack(">d", value).hex()

source=Path(sys.argv[1])
data=json.loads(source.read_text())
w=data["witness"]
assert data["gate_replay"]["derived_bits_match"] and not data["gate_replay"]["passes"]
assert data["moment_reconstruction"]["all_vertex_samples_match"]
assert data["moment_reconstruction"]["all_center_samples_match"]
axis=w["axis"]
xyz=[value(x) for x in w["vertex_xyz_bits"]]
currents=[value(x) for x in w["vertex_j_bits"]]
positions=[Q(xyz[3*i+axis]) for i in range(4)]
samples=[Q(currents[3*i+axis]) for i in range(4)]
assert positions[0]==positions[1]==positions[2] and positions[3]!=positions[0]
assert samples[0]==samples[1]==samples[2]==0
center=value(w["center_xyz_bits"][axis])
sample=value(w["center_j_bits"][axis])
mean=value(w["mean_bits"])
difference=value(w["difference_bits"])
budget=value(w["budget_bits"])
weight=(Q(center)-positions[0])/(positions[3]-positions[0])
point_prediction=float(samples[3]*weight)
barycenter_prediction=float(samples[3]/4)
ulp=math.ldexp(1.0,math.frexp(sample)[1]-53)
gap_ulps=abs(point_prediction-sample)/ulp
assert bits(barycenter_prediction)==w["mean_bits"]
assert gap_ulps<=1.0
out={
 "element":int(w["element"],16), "axis":axis,
 "input_analysis_sha256":hashlib.sha256(source.read_bytes()).hexdigest(),
 "mean_j_apm2":mean, "sample_j_apm2":sample,
 "absolute_difference_apm2":difference, "budget_apm2":budget,
 "difference_over_budget":difference/budget,
 "rounded_center_minus_exact_centroid_m":float(Q(center)-sum(positions)/4),
 "actual_point_barycentric_weight_3":float(weight),
 "actual_weight_minus_one_quarter":float(weight-Q(1,4)),
 "point_interpolated_j_bits":bits(point_prediction),
 "point_interpolation_gap_ulps":gap_ulps,
 "exact_centroid_interpolated_j_bits":bits(barycenter_prediction),
 "exact_centroid_gate_passes":abs(barycenter_prediction-mean)<=budget,
 "max_vertex_component_apm2":max(abs(x) for x in currents),
 "difference_over_max_vertex_component":difference/max(abs(x) for x in currents),
 "all_15_native_samples_match_canonical_moment_reconstruction":True,
 "scope":"First refused cell only; no full-source or publication qualification.",
 "production_predicate_changed":False, "new_solver_runs":0
}
target=Path(sys.argv[2])
with target.open("x") as stream:
    json.dump(out,stream,indent=2,allow_nan=False)
print(json.dumps(out,indent=2))
