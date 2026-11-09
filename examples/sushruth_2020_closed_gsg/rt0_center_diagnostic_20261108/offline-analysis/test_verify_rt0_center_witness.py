import struct,unittest
from verify_rt0_center_witness import analyze
def bits(x):return struct.pack(">d",x).hex()
def fixture(translation=0.0,wrong_center=False):
 points=[[translation,0.,0.],[translation+1.,0.,0.],[translation,1.,0.],[translation,0.,1.]]
 vertex_j=[0.,0.,0.,1.,0.,0.,0.,1.,0.,0.,0.,1.]
 center=[float(translation+.25),.25,.25]
 center_j=[center[0]-translation,.25,.25]
 if wrong_center:center_j[0]=9.
 mean=.25;difference=abs(mean-center_j[0]);budget=128*2.**-52
 return {"schema":"fullmag.rt0_center_failure.v1","element":"0000000000000007","axis":0,
 "vertex_ids":["0000000000000001","0000000000000002","0000000000000003","0000000000000004"],
 "vertex_xyz_bits":[bits(x) for p in points for x in p],"vertex_j_bits":[bits(x) for x in vertex_j],
 "center_xyz_bits":[bits(x) for x in center],"center_j_bits":[bits(x) for x in center_j],
 "mean_bits":bits(mean),"scale_bits":bits(1.),"difference_bits":bits(difference),"budget_bits":bits(budget),
 "face_flux_bits":[bits(.5),bits(0.),bits(0.),bits(0.)]}
class WitnessTests(unittest.TestCase):
 def test_exact_unit_affine_field(self):
  r=analyze(fixture())
  self.assertTrue(r["gate_replay"]["passes"])
  self.assertTrue(r["gate_replay"]["derived_bits_match"])
  self.assertTrue(r["moment_reconstruction"]["all_vertex_samples_match"])
  self.assertTrue(r["moment_reconstruction"]["all_center_samples_match"])
  self.assertEqual(r["centroid_error_m"],[0.,0.,0.])
  self.assertFalse(r["physics_qualified"])
 def test_translation_rounding_explains_refusal(self):
  r=analyze(fixture(float(2**52)))
  self.assertFalse(r["gate_replay"]["passes"])
  self.assertTrue(r["gate_replay"]["derived_bits_match"])
  self.assertTrue(r["moment_reconstruction"]["all_vertex_samples_match"])
  self.assertTrue(r["moment_reconstruction"]["all_center_samples_match"])
  self.assertEqual(r["centroid_error_m"],[-.25,0.,0.])
  self.assertEqual(r["moment_reconstruction"]["centroid_shift_delta_j_apm2"],[-.25,0.,0.])
 def test_wrong_center_is_not_blended_into_a_match(self):
  r=analyze(fixture(wrong_center=True))
  self.assertFalse(r["gate_replay"]["passes"])
  self.assertFalse(r["moment_reconstruction"]["all_center_samples_match"])
 def test_nan_payload_and_missing_face_are_reported_without_false_reconstruction(self):
  w=fixture();w["center_j_bits"][0]="7ff8123456789abc";w["face_flux_bits"][1]=None
  r=analyze(w);self.assertEqual(r["witness"]["center_j_bits"][0],"7ff8123456789abc")
  self.assertFalse(r["gate_replay"]["passes"]);self.assertFalse(r["moment_reconstruction"]["available"])
 def test_malformed_bits_and_duplicate_ids_are_rejected(self):
  for mutate in [lambda w:w["vertex_xyz_bits"].__setitem__(0,"xyz"),lambda w:w["vertex_ids"].__setitem__(0,w["vertex_ids"][1])]:
   w=fixture();mutate(w)
   with self.assertRaises(ValueError):analyze(w)

 def test_constant_divergence_free_field(self):
  w=fixture();w["vertex_j_bits"]=[bits(8.)]*12;w["center_j_bits"]=[bits(8.)]*3
  w.update(mean_bits=bits(8.),scale_bits=bits(8.),difference_bits=bits(0.),budget_bits=bits(128*2.**-52*8))
  w["face_flux_bits"]=[bits(x) for x in [12.,4.,-4.,4.]]
  r=analyze(w)
  self.assertTrue(r["moment_reconstruction"]["all_vertex_samples_match"])
  self.assertTrue(r["moment_reconstruction"]["all_center_samples_match"])
  self.assertEqual(r["moment_reconstruction"]["centroid_shift_delta_j_apm2"],[0.,0.,0.])
 def test_receipt_framing_and_duplicate_json_rejection(self):
  import json
  from unittest import mock
  from verify_rt0_center_witness import read_witness,MARKER
  w=fixture()
  raw=json.dumps({"failure_reason":"wrapper"+MARKER+json.dumps(w)+" | stdout: tail"}).encode()
  with mock.patch("verify_rt0_center_witness.Path.read_bytes",return_value=raw):
   parsed,_=read_witness("unused");self.assertEqual(parsed,w)
  duplicate=json.dumps(w).replace('{"schema":','{"schema":"ignored","schema":',1).encode()
  with mock.patch("verify_rt0_center_witness.Path.read_bytes",return_value=duplicate):
   with self.assertRaises(ValueError):read_witness("unused")


def v2(w):
 w=dict(w)
 for key in ["mean_bits","scale_bits","difference_bits","budget_bits"]:w.pop(key)
 w.update(schema="fullmag.rt0_center_failure.v2",comparison_policy="canonical_rt0_at_stored_point.v1",axis_scale_bits=bits(1.))
 return w

class StoredPointWitnessTests(unittest.TestCase):
 def actual_v2(self):
  import json
  from pathlib import Path
  w=json.loads((Path(__file__).parent/"fixtures/actual-first-center-refusal.json").read_text())
  w=v2(w)
  w["axis_scale_bits"]=bits(max(abs(struct.unpack(">d",bytes.fromhex(w["vertex_j_bits"][3*i+w["axis"]]))[0]) for i in range(4)))
  w["center_j_bits"][1]="3e363893a7151338"
  return w
 def test_v2_earlier_axis_survives_later_nonfinite_vertex_sample(self):
  import json
  w=self.actual_v2();w["vertex_j_bits"][2]="7ff8123456789abc"
  r=analyze(w)
  self.assertFalse(r["gate_replay"]["passes"])
  self.assertTrue(r["gate_replay"]["exact_reference_available"])
  self.assertFalse(r["moment_reconstruction"]["all_vertex_samples_match"])
  self.assertEqual(r["witness"],w)
  json.dumps(r,allow_nan=False)
 def test_v2_earlier_axis_survives_later_nonfinite_center_coordinate(self):
  import json
  w=self.actual_v2();w["center_xyz_bits"][2]="7ff8123456789abc"
  r=analyze(w)
  self.assertFalse(r["gate_replay"]["passes"])
  self.assertTrue(r["gate_replay"]["exact_reference_available"])
  self.assertIsNone(r["centroid_error_m"][2])
  self.assertIsNone(r["moment_reconstruction"]["center_j_bits"][2])
  self.assertFalse(r["moment_reconstruction"]["all_center_samples_match"])
  self.assertEqual(r["witness"],w)
  json.dumps(r,allow_nan=False)
 def test_v2_exact_refusal_survives_unrepresentable_display_reference(self):
  import json
  w=self.actual_v2();w["face_flux_bits"][0]="7fefffffffffffff"
  r=analyze(w)
  self.assertFalse(r["gate_replay"]["passes"])
  self.assertTrue(r["gate_replay"]["exact_reference_available"])
  self.assertTrue(any(x is None for x in r["moment_reconstruction"]["center_j_bits"]))
  self.assertEqual(r["witness"],w)
  json.dumps(r,allow_nan=False)
 def test_v2_replays_stored_point_instead_of_exact_centroid(self):
  r=analyze(v2(fixture(float(2**52))))
  self.assertTrue(r["gate_replay"]["passes"])
  self.assertEqual(r["gate_replay"]["comparison_policy"],"canonical_rt0_at_stored_point.v1")
  self.assertFalse(r["accepted_source"])
 def test_v2_wrong_center_and_incomplete_reference_fail_closed(self):
  w=v2(fixture(wrong_center=True))
  self.assertFalse(analyze(w)["gate_replay"]["passes"])
  w["face_flux_bits"][0]=None
  r=analyze(w)
  self.assertFalse(r["gate_replay"]["passes"])
  self.assertFalse(r["moment_reconstruction"]["available"])
 def test_v2_rejects_mixed_policy_and_legacy_derived_fields(self):
  for key,value in [("comparison_policy","unknown"),("mean_bits",bits(.25)),("axis_scale_bits",bits(-1.))]:
   w=v2(fixture());w[key]=value
   with self.assertRaises(ValueError):analyze(w)
 def test_v2_receipt_frame_preserves_the_complete_witness(self):
  import json
  from unittest import mock
  from verify_rt0_center_witness import read_witness
  w=v2(fixture())
  raw=json.dumps({"failure_reason":"wrapper fullmag.rt0_center_failure.v2="+json.dumps(w)+" | stdout: tail"}).encode()
  with mock.patch("verify_rt0_center_witness.Path.read_bytes",return_value=raw):
   parsed,_=read_witness("unused");self.assertEqual(parsed,w)

if __name__=="__main__":unittest.main()
