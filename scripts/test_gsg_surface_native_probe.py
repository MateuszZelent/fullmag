"""Small interpreted regressions; never load or call the native library."""
import importlib.util
from pathlib import Path
import struct
import hashlib
import json
import tempfile
import unittest

p = Path(__file__).resolve().parents[1] / "tools/gsg_surface_native_probe.py"
spec = importlib.util.spec_from_file_location("gsg_surface_native_probe", p)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def cell(ids=(0, 1, 2, 3), xyz=(0.,0.,0.,1.,0.,0.,0.,1.,0.,0.,0.,1.), ordinal=0):
    return struct.pack("<5Q30d", ordinal, *ids, *xyz, *([0.] * 18))


def faces(ids=(0, 1, 2, 3), values=(.5, .5, 0., 0.)):
    rows = [(tuple(sorted(ids[j] for j in range(4) if j != i)), values[i]) for i in range(4)]
    return b"".join(struct.pack("<3Qd", *key, value) for key, value in sorted(rows))


class FrozenPackingTests(unittest.TestCase):
    def pack(self, c=None, f=None, count=1, vertices=4):
        return probe.pack_rt0(cell() if c is None else c, faces() if f is None else f, count, vertices)

    def test_uniform_x_has_exact_outward_coefficients_and_keeps_negative_zero(self):
        raw, evidence = self.pack()
        self.assertEqual(raw[:96], cell()[40:136])
        self.assertEqual(raw[96:], struct.pack("<4d", 1., -1., 0., -0.))
        self.assertEqual(evidence["source_cells"], 1)
        self.assertEqual(evidence["canonical_faces"], 4)

    def test_arbitrary_stable_ids_preserve_all_orientations(self):
        ids = (10, 30, 20, 40)
        raw, _ = self.pack(cell(ids=ids), faces(ids, (1., 2., 4., 8.)))
        self.assertEqual(raw[96:], struct.pack("<4d", -2., -4., 8., 16.))

    def test_missing_duplicate_or_unordered_face_refuses(self):
        for f in (faces()[:-32], faces() + faces()[:32], b"".join(reversed([faces()[i:i+32] for i in range(0,128,32)]))):
            with self.subTest(data=len(f)), self.assertRaises(ValueError):
                self.pack(f=f)

    def test_foreign_ordinal_duplicate_vertex_degenerate_or_negative_tet_refuses(self):
        cases = [cell(ordinal=1), cell(ids=(0,1,1,3)), cell(xyz=(0.,)*12), cell(xyz=(0.,0.,0.,0.,1.,0.,1.,0.,0.,0.,0.,1.))]
        for c in cases:
            with self.subTest(c=c[:40]), self.assertRaises(ValueError): self.pack(c=c)

    def test_nonfinite_scaling_overflow_and_wrong_counts_refuse(self):
        for f in (faces(values=(float("nan"),0.,0.,0.)), faces(values=(float.fromhex("0x1.fffffffffffffp+1023"),0.,0.,0.))):
            with self.assertRaises(ValueError): self.pack(f=f)
        with self.assertRaises(ValueError): self.pack(count=2)
        with self.assertRaises(ValueError): self.pack(vertices=5)

    def test_subnormal_moments_scale_reversibly(self):
        tiny = float.fromhex("0x0.0000000000001p-1022")
        raw, _ = self.pack(f=faces(values=(tiny,)*4))
        self.assertEqual(struct.unpack("<4d",raw[96:]), (tiny*2,-tiny*2,tiny*2,-tiny*2))


class FrozenAbiTests(unittest.TestCase):
    def test_ctypes_sizes_match_the_existing_lp64_header(self):
        self.assertEqual(probe.abi_sizes(), {"Limits":272,"Tolerances":88,"Options":368,"Frozen":128,"Request":440,"Result":320,"Profile":112})

    def test_comparison_uses_the_full_vector_and_both_declared_gates(self):
        v = probe.compare_reference((1., 0., 0.), ["1", "0", "0"])
        self.assertTrue(v["within_gate"])
        v = probe.compare_reference((-1., 0., 0.), ["1", "0", "0"])
        self.assertFalse(v["within_gate"])
        self.assertFalse(v["within_historical_gate"])

    def test_signed_zero_in_native_json_survives_parsing(self):
        v = probe.evidence_json(b'{"h":[-0,0,1]}')
        self.assertEqual(struct.pack("<d", v["h"][0]), struct.pack("<d", -0.))
        with self.assertRaises(ValueError): probe.evidence_json(b'{"a":1,"a":2}')
        with self.assertRaises(ValueError): probe.evidence_json(b'{"x":NaN}')


class NativeOutputTests(unittest.TestCase):
    def buffers(self):
        c = probe.C
        h = (probe.D*9)(*[float("nan")]*9)
        e = (c.c_uint8*8)(*b"bad-json")
        r = probe.Result(1,0,c.sizeof(probe.Result),h,9,0,e,8,8,b"surface work guard")
        p = probe.Profile(abi_version=1,struct_size=c.sizeof(probe.Profile))
        return r,h,e,p

    def test_refusal_never_parses_or_publishes_partial_evidence(self):
        r,h,e,p = self.buffers()
        info,raw = probe.native_output(-3,r,h,e,p)
        self.assertEqual(info["native_status"],-3)
        self.assertEqual(info["error"],"surface work guard")
        self.assertIsNone(info["native_evidence"])
        self.assertIsNone(raw)
        self.assertNotIn("h_xyz_apm",info)
        self.assertEqual(info["work_report_availability"],"NOT AVAILABLE")

    def test_success_requires_complete_finite_h_and_valid_json(self):
        r,h,e,p = self.buffers()
        with self.assertRaises(ValueError): probe.native_output(0,r,h,e,p)
        r.h_xyz_apm_len=9
        h[:]=[0.]*9
        with self.assertRaises(ValueError): probe.native_output(0,r,h,e,p)

    def test_actual_return_code_survives_bad_output_header(self):
        policy = json.loads((p.parents[1]/".superpowers/sdd/2026-11-13-retained-dtq-public-field-proposal/full-gsg-native-experiment-20261115/policy-proposal.json").read_text())
        policy["limits"]["total"][9] = 128
        def bad(request, result, profile, observer):
            result._obj.h_xyz_apm_capacity = 10
            return -7
        frozen,_ = probe.pack_rt0(cell(),faces(),1,4)
        info,raw = probe.evaluate_once(bad,frozen,struct.pack("<9d",*([0.]*9)),policy,
                                       {"frozen_sha256":"a"*64},"b"*64,lambda:None)
        self.assertEqual(info["native_status"],-7)
        self.assertIn("output_validation_error",info)
        self.assertIsNone(raw)

    def test_output_pointer_or_capacity_mutation_refuses(self):
        r,h,e,p = self.buffers();r.h_xyz_apm_capacity=10
        with self.assertRaises(ValueError):probe.native_output(-3,r,h,e,p)


class BundleReaderTests(unittest.TestCase):
    def bundle(self):
        names=("cells","faces","vertex_xyz","stable_vertex_ids","sample_xyz","sample_cells","h_raw")
        payloads={n:bytes([i+1]) for i,n in enumerate(names)}
        descriptors={n:{"path":"antenna/field_solutions/gsg/"+n+".bin","byte_length":len(v),"sha256":hashlib.sha256(v).hexdigest()} for n,v in payloads.items()}
        manifest={"schema_version":"antenna_field_solution.v2","status":"inspection_only","solution_id":"gsg","payloads":descriptors}
        text=json.dumps(manifest).encode()
        raw=b"FMACLB01"+struct.pack("<QI",len(text),len(payloads))+text
        for n,v in sorted(payloads.items(),key=lambda row:descriptors[row[0]]["path"]):
            path=descriptors[n]["path"].encode()
            raw+=struct.pack("<H",len(path))+path+struct.pack("<Q",len(v))+v
        return raw,payloads

    def read(self,raw,pin=None,linked=False):
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder)/"bundle";p.write_bytes(raw)
            if linked:
                q=Path(folder)/"linked";q.symlink_to(p);p=q
            return probe.read_bundle(p,hashlib.sha256(raw).hexdigest() if pin is None else pin)

    def test_streaming_reader_preserves_all_required_payloads(self):
        raw,values=self.bundle();manifest,actual=self.read(raw)
        self.assertEqual(actual,values)
        self.assertEqual(manifest["solution_id"],"gsg")

    def test_changed_payload_truncation_trailing_hash_and_link_refuse(self):
        raw,_=self.bundle()
        for changed in (raw[:-1],raw+b"X",raw[:-1]+bytes([raw[-1]^1])):
            with self.subTest(length=len(changed)),self.assertRaises(ValueError): self.read(changed)
        with self.assertRaises(ValueError): self.read(raw,"0"*64)
        with self.assertRaises(ValueError): self.read(raw,linked=True)



class NativeEvidenceTests(unittest.TestCase):
    def fixture(self):
        import copy
        policy = json.loads((p.parents[1]/".superpowers/sdd/2026-11-13-retained-dtq-public-field-proposal/full-gsg-native-experiment-20261115/policy-proposal.json").read_text())
        count = 85980
        work = [count,8*count,8*count,24*count]+[0]*10
        precision = dict(evaluated=True,refusal_reason="",h_xyz_apm=["0"]*3,whole_h_xyz_apm=["0"]*3,
                         sum_local_norm_apm="0",cancellation="0",maximum_face_cancellation="0")
        target = dict(h_xyz_apm=[0.]*3,precisions=[copy.deepcopy(precision) for _ in range(3)],work=work,
                      binary64_requires_highprecision=False,precision_budget_apm="1e-9",
                      local_precision_delta_apm="0",local_formula_delta_apm="0",
                      local_formula_delta_80_apm="0",binary64_roundoff_indicator_apm="0")
        targets = [copy.deepcopy(target) for _ in range(3)]
        total = [3*n for n in work]
        total[4] = 100  # Shared exact preparation belongs to total, outside target and precision.
        by_precision = [[0]*14 for _ in range(3)]
        for row in by_precision[1:]:
            row[1:4] = [12*count,12*count,36*count]
        value = dict(schema_version="fem_rt0_surface_snapshot.v1",
                     operator_version="fem_oersted_rt0_surface.mpfr128_160_rndn_etoff.inspection.v1",
                     basis_version="fem_generic_affine_rt0.v1",
                     inspection_only=True,error_certificate_available=False,source_view_identity_digest="a"*64,
                     accepted_source_state_digest="b"*64,policy_version=policy["policy_version"],
                     limits=policy["limits"],tolerances=policy["tolerances"],targets_xyz_m=[[0.]*3 for _ in range(3)],
                     targets=targets,work_report=dict(total=total,current_target=work.copy(),by_precision=by_precision,
                     current_target_index=2,maximum_raw_integer_bits=1,maximum_reduced_fraction_bits=1,
                     last_sampled_lifetime_peak_rss_bytes=1024,elapsed_seconds=0.1))
        request = dict(policy=policy,scope=dict(frozen_sha256="a"*64),source_state_sha256="b"*64)
        return value,dict(h_xyz_apm=[[0.]*3 for _ in range(3)]),request,struct.pack("<9d",*([0.]*9))

    def test_complete_ledger_accepts_shared_preparation_without_invented_equality(self):
        probe.validate_evidence(*self.fixture())

    def test_missing_precision_and_inconsistent_ledgers_refuse(self):
        mutations = [
            lambda v:v["targets"][0]["precisions"].__setitem__(0,{}),
            lambda v:v["work_report"].update(by_precision=[None,None,None]),
            lambda v:v["work_report"]["total"].__setitem__(0,0),
            lambda v:v["work_report"]["by_precision"][1].__setitem__(1,0),
            lambda v:v["work_report"]["by_precision"][0].__setitem__(4,101),
            lambda v:v["work_report"].update(current_target_index=0),
            lambda v:v["work_report"]["current_target"].__setitem__(4,1),
            lambda v:v["work_report"].update(last_sampled_lifetime_peak_rss_bytes=3221225473),
            lambda v:v.update(operator_version="unknown"),
        ]
        for mutate in mutations:
            value,info,request,xyz=self.fixture();mutate(value)
            with self.subTest(mutate=mutate),self.assertRaises(ValueError):
                probe.validate_evidence(value,info,request,xyz)

    def test_precision_decimal_shape_rounding_and_local_budget_refuse(self):
        mutations = [
            lambda v:v["targets"][0]["precisions"][1].update(h_xyz_apm=["0"]*2),
            lambda v:v["targets"][0]["precisions"][2].update(cancellation="NaN"),
            lambda v:v["targets"][0]["precisions"][2].update(h_xyz_apm=["1","0","0"]),
            lambda v:v["targets"][0].update(local_precision_delta_apm="1e-8"),
        ]
        for mutate in mutations:
            value,info,request,xyz=self.fixture();mutate(value)
            with self.subTest(mutate=mutate),self.assertRaises(ValueError):
                probe.validate_evidence(value,info,request,xyz)

    def test_binary_refusal_requires_reason_empty_values_and_highprecision_flag(self):
        value,info,request,xyz=self.fixture()
        low=value["targets"][0]["precisions"][0]
        low.update(evaluated=False,refusal_reason="bounded binary cancellation",
                   h_xyz_apm=[""]*3,whole_h_xyz_apm=[""]*3,
                   sum_local_norm_apm="",cancellation="",maximum_face_cancellation="")
        value["targets"][0].update(binary64_requires_highprecision=True,binary64_roundoff_indicator_apm="")
        probe.validate_evidence(value,info,request,xyz)
        low["refusal_reason"]=""
        with self.assertRaises(ValueError):probe.validate_evidence(value,info,request,xyz)


if __name__ == "__main__": unittest.main()
