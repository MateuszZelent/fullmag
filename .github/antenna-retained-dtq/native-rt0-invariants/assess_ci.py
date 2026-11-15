"""CI readback only: exact preregistered reference and frozen-binary64 audit."""
from fractions import Fraction as F
import hashlib
import json
import math
import os
from pathlib import Path
import re
import struct
import sys

BASE = Path(__file__).resolve().parent
ROOT = BASE.parents[2]
OUT = ROOT / "native-rt0-invariants-evidence"
MARKER = "NATIVE_RT0_THREE_INVARIANTS_DIAGNOSTIC_ONLY_PASS"
PRODUCTION = "PRODUCTION_DTQ_GATE_REMAINS_FAIL_FROM_RUN_43647488516"
OET0 = ["fem_conservative_current_view_"+suffix for suffix in
    ("contract", "mpi_n1", "mpi_n2", "mpi_byte_identity")]

def gate(h, ref):
    e2 = sum((a-b)**2 for a,b in zip(h,ref))
    r2 = sum(x*x for x in ref)
    x = e2/F(1,10**24)-1-r2
    return x <= 0 or x*x <= 4*r2

def require(ok, message):
    if not ok:
        raise ValueError(message)

def vector(value, length, label):
    require(isinstance(value,list) and len(value)==length, label+": shape")
    return value

def binary(hexvalues, values, count, label):
    vector(hexvalues,count,label)
    vector(values,count,label)
    raw = [float.fromhex(v) for v in hexvalues]
    require(all(math.isfinite(v) for v in raw),label+": finite")
    require(all(type(v) in (int,float) and math.isfinite(v) and
        struct.pack(">d",v)==struct.pack(">d",r) for v,r in zip(values,raw)),label+": raw bits")
    return [F.from_float(v) for v in raw]

def determinant(vertices):
    e=[[vertices[i+1][c]-vertices[0][c] for c in range(3)] for i in range(3)]
    return (e[0][0]*(e[1][1]*e[2][2]-e[1][2]*e[2][1])+
        e[0][1]*(e[1][2]*e[2][0]-e[1][0]*e[2][2])+
        e[0][2]*(e[1][0]*e[2][1]-e[1][1]*e[2][0]))

def source_guard():
    materialized=json.loads((OUT/"materialization.json").read_text())
    require(materialized["status"]=="PASS: source pins","materialization status")
    checked={}
    for name,expected in materialized["source_pins"].items():
        path=ROOT/name
        require(not path.is_symlink() and path.resolve().is_relative_to(ROOT.resolve()),"source guard path")
        data=path.read_bytes()
        actual={"bytes":len(data),"sha256":hashlib.sha256(data).hexdigest()}
        require(all(actual[k]==expected[k] for k in actual),"after-run source pin: "+name)
        checked[name]=actual
    return checked


def bits_equal(actual, expected):
    return len(actual)==len(expected) and all(struct.pack(">d",float.fromhex(a))==struct.pack(">d",float.fromhex(b)) for a,b in zip(actual,expected))

def exact_hex(values):
    return [F.from_float(float.fromhex(x)) for x in values]

def preregistered_inputs(inputs,reference,bindings):
    require(inputs["source_authentication"]=="NOT PROVIDED; synthetic caller binding only" and inputs["field_evaluation_executed"] is False,"synthetic status")
    require(inputs["policy_unchanged"]==reference["policy"],"unchanged policy")
    require(inputs["operator_version"]==reference["operator_version"],"unchanged operator")
    original=next(c for c in reference["targets"] if c["id"]=="interior")
    href=exact_hex(original["reference_H_apm_hex"])
    cases=vector(inputs["cases"],3,"cases")
    require([c["id"] for c in cases]==["affine_b4","affine_b4_odd_orientation","affine_b4_micrometre_negative_scale"],"case order")
    base=cases[0]
    for k,c in enumerate(cases):
        require(c["source_count"]==6 and c["target_count"]==1,"call shape")
        scale=F(c["geometry_scale_exact"]);amp=F(c["current_amplitude_scale_exact"])
        require(scale>0,"geometry scale")
        require(F(c["expected_reference_multiplier_exact"])==amp*scale,"reference scale law")
        require(exact_hex(c["expected_H_Apm_hex"])==[amp*scale*x for x in href],"inherited reference bits/multiplier")
        require(exact_hex(c["target_m_hex"])==[scale*x for x in exact_hex(original["xyz_m_hex"])],"target scale")
        require([F(x) for x in c["required_affine_a_Apm2_exact"]]==[amp*F(x) for x in base["required_affine_a_Apm2_exact"]],"affine a scale")
        require(F(c["required_affine_b_Apm3_exact"])==amp*F(4)/scale,"affine slope scale")
        permutation=[1,0,2,3] if k==1 else [0,1,2,3]
        for e,(vertices,coefficients) in enumerate(zip(vector(c["source_vertices_m_hex"],6,"vertices"),vector(c["signed_coefficients_A_hex"],6,"coefficients"))):
            require(len(vertices)==4 and len(coefficients)==4,"FrozenInput shape")
            vs=[exact_hex(v) for v in vertices];cs=exact_hex(coefficients)
            det=determinant(vs)
            require(abs(det)==scale**3,"determinant scale")
            require(sum(cs)/abs(det)==F(c["required_affine_b_Apm3_exact"]),"Fraction b")
            require([-sum(cs[i]*vs[i][axis] for i in range(4))/abs(det) for axis in range(3)]==[F(x) for x in c["required_affine_a_Apm2_exact"]],"Fraction a")
            for i,j in enumerate(permutation):
                require(vs[i]==[scale*x for x in exact_hex(reference["source_vertices_hex"][e][j])],"geometry/permutation")
                require(cs[i]==amp*scale**2*exact_hex(base["signed_coefficients_A_hex"][e])[j],"coefficient scale/permutation")
            if k==1:
                require(det==-determinant([exact_hex(v) for v in base["source_vertices_m_hex"][e]]),"odd determinant sign")
        binding=bindings["cases"][k]
        record={"id":c["id"],"vertices_m_hex":c["source_vertices_m_hex"],"coefficients_A_hex":c["signed_coefficients_A_hex"],"target_m_hex":c["target_m_hex"],"permutation":permutation}
        require(binding["id"]==c["id"] and binding["canonical_record"]==record,"binding record")
        require(hashlib.sha256(json.dumps(record,sort_keys=True,separators=(",",":")).encode()).hexdigest()==binding["synthetic_caller_digest_hex"],"caller digest")
    # Pointwise algebra prerequisite only; never evaluate a field integral here.
    require([F(x)+F(4)*v for x,v in zip(base["required_affine_a_Apm2_exact"],exact_hex(base["target_m_hex"]))]==[F(4),F(0),F(0)],"a+b*x0 equals retained J0")

def check_inputs(record,c,k,binding):
    require(record["case_index"]==k and record["case_id"]==c["id"],"input case order")
    require(record["source_count"]==6 and record["target_count"]==1,"input call shape")
    require(record["synthetic_caller_digest_hex"]==binding["synthetic_caller_digest_hex"],"caller binding")
    require(record["source_authentication"]=="synthetic caller binding; NOT accepted-source authentication","source auth claim")
    require(record["inspection_only"] is True and record["qualification"]=="NOT VERIFIED" and record["error_certificate_available"] is False,"inspection status")
    require(record["permutation"]==binding["canonical_record"]["permutation"],"permutation")
    volume=F(0)
    for e,s in enumerate(vector(record["sources"],6,"sources")):
        require(s["element"]==e,"source order")
        vh=vector(s["vertices_m_hex"],4,"vertices")
        vd=vector(s["vertices_m"],4,"vertices decimals")
        vs=[binary(h,v,3,"vertex") for h,v in zip(vh,vd)]
        require(all(bits_equal(a,b) for a,b in zip(vh,c["source_vertices_m_hex"][e])),"ordered vertex bits")
        cs=binary(s["signed_coefficients_a_hex"],s["signed_coefficients_a"],4,"coefficients")
        require(bits_equal(s["signed_coefficients_a_hex"],c["signed_coefficients_A_hex"][e]),"ordered coefficient bits")
        det=determinant(vs);require(det!=0 and det==F(s["signed_determinant_m3_exact"]),"determinant")
        require(abs(det)/6==F(s["volume_m3_exact"]),"element volume")
        volume+=abs(det)/6
        a=[-sum(cs[i]*vs[i][axis] for i in range(4))/abs(det) for axis in range(3)];b=sum(cs)/abs(det)
        require(a==[F(x) for x in c["required_affine_a_Apm2_exact"]] and b==F(c["required_affine_b_Apm3_exact"]),"independent Fraction affine readback")
        require(a==[F(x) for x in vector(s["affine_a_apm2_exact"],3,"reported a")] and b==F(s["affine_b_apm3_exact"]),"reported affine")
    require(volume==F(c["geometry_scale_exact"])**3 and volume==F(record["volume_m3_exact"]),"whole volume")
    binary(record["target_m_hex"],record["target_m"],3,"target")
    require(bits_equal(record["target_m_hex"],c["target_m_hex"]),"target bits")
    return {"id":c["id"],"status":"PASS: exact synthetic input/readback only","volume_m3_exact":str(volume)}

def counts(value,label):
    vector(value,14,label)
    require(all(type(v) is int and v>=0 for v in value),label+": nonnegative integer")
    return value

def elapsed(value,limit,label):
    require(type(value) in (int,float) and math.isfinite(value) and 0<value<=limit,label)

def check_call(record,c,k,inputs,binding):
    require(record["case_index"]==k and record["case_id"]==c["id"] and record["attempted_calls"]==k+1,"one ordered call per case")
    require(record["synthetic_caller_digest_hex"]==binding["synthetic_caller_digest_hex"],"call/source binding")
    require(record["operator_version"]==inputs["operator_version"],"operator version")
    require(record["status"]=="RETURNED" and record["refusal_reason"]=="","native refusal")
    result=vector(record["targets"],1,"returned target")[0]
    work=record["work_report"];phase=record["phase_report"];limits=inputs["policy_unchanged"]["limits"]
    require(phase["started"] is True and phase["accounting_issue"] is False,"phase accounting")
    phases=vector(phase["wall_time_ns"],9,"phases")
    require(all(type(x) is int and x>=0 for x in phases) and sum(phases)==phase["total_wall_time_ns"] and sum(phases)>0,"phase sum")
    total=counts(work["total"],"total work");current=counts(work["current_target"],"current work")
    require(total[0]==6 and work["current_target_index"]==0,"six pairs and one target")
    require(all(a<=b for a,b in zip(total,limits["total"])) and all(a<=b for a,b in zip(current,limits["per_target"])) ,"reported work limit")
    for p in vector(work["by_precision"],3,"precision work"):
        require(all(a<=b for a,b in zip(counts(p,"precision work"),total)),"precision work bounded by total")
    for key in ("maximum_raw_integer_bits","maximum_reduced_fraction_bits"):
        require(type(work[key]) is int and 0<work[key]<=limits[key],"integer bit limits")
    elapsed(record["external_elapsed_seconds"],limits["maximum_target_seconds"],"external target time")
    elapsed(work["elapsed_seconds"],limits["maximum_target_seconds"],"native target time")
    for rss in [record["lifetime_peak_rss_bytes"],work["last_sampled_lifetime_peak_rss_bytes"]]:
        require(type(rss) is int and 0<rss<=limits["maximum_lifetime_peak_rss_bytes"],"real lifetime RSS/limit")
    target_work=counts(result["work"],"target work")
    require(target_work[0]==6 and all(a<=b for a,b in zip(target_work,limits["per_target"])) ,"target source count/work limit")
    raw=binary(result["h_xyz_apm_hex"],result["h_xyz_apm"],3,"raw H")
    reference=exact_hex(c["expected_H_Apm_hex"])
    require(gate(raw,reference),"final H/reference")
    precision_checks=[]
    for p,precision in enumerate(vector(result["precisions"],3,"precision reports")):
        require(type(precision["evaluated"]) is bool and type(precision["refusal_reason"]) is str,"precision report state")
        if p>0: require(precision["evaluated"] and precision["refusal_reason"]=="","required MPFR pass")
        if precision["evaluated"]:
            require(precision["refusal_reason"]=="","evaluated precision refusal")
            h=[F(x) for x in vector(precision["h_xyz_apm"],3,"precision H")]
            [F(x) for x in vector(precision["whole_h_xyz_apm"],3,"whole precision H")]
            for key in ("sum_local_norm_apm","cancellation","maximum_face_cancellation"): F(precision[key])
            if p>0: require(gate(h,reference),"MPFR/reference")
            precision_checks.append({"index":p,"evaluated":True,"reference_gate":gate(h,reference),"refusal_reason":""})
        else:
            require(p==0 and result["binary64_requires_highprecision"] is True and precision["refusal_reason"]!="","binary refusal requires native MPFR fallback")
            precision_checks.append({"index":p,"evaluated":False,"refusal_reason":precision["refusal_reason"]})
    for key in ("precision_budget_apm","local_precision_delta_apm","local_formula_delta_apm","local_formula_delta_80_apm"): F(result[key])
    if result["precisions"][0]["evaluated"] or result["binary64_roundoff_indicator_apm"]: F(result["binary64_roundoff_indicator_apm"])
    return {"id":c["id"],"final_reference_gate":True,"precision_checks":precision_checks}

def assess(log,inputs,reference,bindings):
    prefixes=["NATIVE_INVARIANT_INPUT=","NATIVE_INVARIANT_CALL=","NATIVE_INVARIANT_CAMPAIGN=","NATIVE_INVARIANT_SETUP_REFUSED="]
    # JSON lexical -0 must survive as negative binary64 zero, including final H.
    records={prefix:[json.loads(line[len(prefix):],parse_int=lambda token: -0.0 if token=="-0" else int(token)) for line in log.splitlines() if line.startswith(prefix)] for prefix in prefixes}
    report={"schema":"private.native-rt0-invariants-ci-result.v1","status":"FAIL: incomplete native/source/reference evidence","inspection_only":True,"qualification":"NOT VERIFIED","error_certificate_available":False,"source_authentication":"NOT PROVIDED; synthetic caller binding only","production_gate":PRODUCTION,"records":records,"checks":[],"errors":[]}
    try:
        preregistered_inputs(inputs,reference,bindings)
        report["after_run_source_pins"]=source_guard()
        require(not records[prefixes[3]],"setup refused")
        require(len(records[prefixes[0]])==3 and len(records[prefixes[1]])==3 and len(records[prefixes[2]])==1,"three complete ordered calls/inputs and one campaign required")
        positions=[i for i,line in enumerate(log.splitlines()) if line.startswith(tuple(prefixes))]
        require([log.splitlines()[i].split('=',1)[0]+'=' for i in positions]==[prefixes[0]]*3+[prefixes[1]]*3+[prefixes[2]],"all input preflight before first call; exact record sequence")
        report["source_checks"]=[check_inputs(record,c,k,bindings["cases"][k]) for k,(record,c) in enumerate(zip(records[prefixes[0]],inputs["cases"]))]
        report["checks"]=[check_call(record,c,k,inputs,bindings["cases"][k]) for k,(record,c) in enumerate(zip(records[prefixes[1]],inputs["cases"]))]
        campaign=records[prefixes[2]][0];limits=inputs["policy_unchanged"]["limits"]
        require(campaign["complete"] is True and campaign["attempted_calls"]==3 and campaign["returned_calls"]==3,"no missing or retried calls")
        total=[sum(record["work_report"]["total"][i] for record in records[prefixes[1]]) for i in range(14)]
        require(total==counts(campaign["total_work"],"campaign work") and total[0]==18,"campaign work sum")
        require(all(a<=b for a,b in zip(total,limits["total"])),"original total campaign work limits")
        elapsed(campaign["external_elapsed_seconds"],limits["maximum_total_seconds"],"original campaign wall limit")
        require(sum(record["external_elapsed_seconds"] for record in records[prefixes[1]])<=campaign["external_elapsed_seconds"],"campaign covers all calls")
        require(type(campaign["lifetime_peak_rss_bytes"]) is int and 0<campaign["lifetime_peak_rss_bytes"]<=limits["maximum_lifetime_peak_rss_bytes"],"campaign lifetime RSS limit")
        require(campaign["lifetime_peak_rss_bytes"]>=max(r["lifetime_peak_rss_bytes"] for r in records[prefixes[1]]),"lifetime RSS monotonic")
        oet0={name:[line for line in log.splitlines() if re.search(r"\b"+re.escape(name)+r"\s+\.+\s+(Passed|\*\*\*Failed)",line)] for name in OET0}
        report["oet0_results"]=oet0
        require(all(len(lines)==1 and "Passed" in lines[0] for lines in oet0.values()),"unchanged four OE-T0 CTest outcomes required")
        report["status"]=MARKER
    except Exception as error: report["errors"].append(str(error))
    return report

def main():
    OUT.mkdir(exist_ok=True)
    try:
        require(os.environ.get("NATIVE_OUTCOME")=="success","managed native recipe did not complete successfully")
        for name,pin in json.loads((BASE/"payload-pins.json").read_text()).items():
            data=(BASE/name).read_bytes()
            require(len(data)==pin["bytes"] and hashlib.sha256(data).hexdigest()==pin["sha256"],"payload pin: "+name)
        require(hashlib.sha256((BASE/"inputs.json").read_bytes()).hexdigest()=="b48b542e56dd0da9564b027f688671f1534771fe527947ca589aac86d366fb8e","proposal pin")
        inputs=json.loads((BASE/"inputs.json").read_text())
        raw=(BASE/"reference-inputs.json").read_bytes()
        require(hashlib.sha256(raw).hexdigest()==inputs["reference_source"]["sha256"],"reference pin")
        reference=json.loads(raw);bindings=json.loads((BASE/"caller-bindings.json").read_text())
        path=OUT/"native.log"
        require(path.is_file() and path.stat().st_size<=16777216,"missing or oversized native log")
        report=assess(path.read_text(errors="strict"),inputs,reference,bindings)
    except Exception as error:
        report={"schema":"private.native-rt0-invariants-ci-result.v1","status":"FAIL: output/readback failure","error":str(error),"inspection_only":True,"qualification":"NOT VERIFIED","error_certificate_available":False,"production_gate":PRODUCTION}
    (OUT/"native-result.json").write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps(report))
    return 0 if report["status"]==MARKER else 1

if __name__=="__main__":
    sys.exit(main())
