"""CI readback only: exact preregistered reference and frozen-binary64 audit."""
from fractions import Fraction as F
import hashlib
import json
import math
from pathlib import Path
import re
import struct
import sys

BASE = Path(__file__).resolve().parent
ROOT = BASE.parents[2]
OUT = ROOT / "native-cube-reference-evidence"
MARKER = "NATIVE_SURFACE_WHOLE_CUBE_THREE_TARGET_REFERENCE_ONLY_PASS"
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

def check_inputs(record, inputs):
    require(record["source_count"]==6,"source count")
    sources=vector(record["sources"],6,"sources")
    require(record["synthetic_caller_digest_hex"]==inputs["synthetic_caller_digest"],"caller diagnostic binding")
    require(record["source_authentication"]=="synthetic caller binding; NOT accepted-source authentication","source auth claim")
    volume=F(0)
    for index,source in enumerate(sources):
        require(source["element"]==index,"source order")
        vh=vector(source["vertices_m_hex"],4,"vertices")
        vd=vector(source["vertices_m"],4,"vertices decimal")
        vertices=[binary(h,v,3,"source vertex") for h,v in zip(vh,vd)]
        expected=[[F.from_float(float.fromhex(x)) for x in p] for p in inputs["source_vertices_hex"][index]]
        require(vertices==expected and all(struct.pack(">d",float.fromhex(actual))==struct.pack(">d",float.fromhex(wanted)) for ah,wh in zip(vh,inputs["source_vertices_hex"][index]) for actual,wanted in zip(ah,wh)),"ordered source geometry bits")
        coeff=binary(source["signed_coefficients_a_hex"],source["signed_coefficients_a"],4,"source coefficients")
        signed_det=determinant(vertices)
        require(signed_det!=0 and signed_det==F(source["signed_determinant_m3_exact"]),"source determinant")
        det=abs(signed_det)
        volume+=det/6
        b=sum(coeff)/det
        a=[-sum(coeff[i]*vertices[i][c] for i in range(4))/det for c in range(3)]
        require(a==[F(4),F(0),F(0)] and b==0,"exported source affine current prerequisite")
        require(a==[F(x) for x in vector(source["affine_a_apm2_exact"],3,"a")] and b==F(source["affine_b_apm3_exact"]),"reported affine current")
    require(volume==1 and F(record["volume_m3_exact"])==1,"whole cube volume")
    targets=vector(record["targets_m_hex"],3,"input targets")
    td=vector(record["targets_m"],3,"input targets decimal")
    for h,v,expected in zip(targets,td,inputs["targets"]):
        actual=binary(h,v,3,"input target")
        require(actual==[F.from_float(float.fromhex(x)) for x in expected["xyz_m_hex"]] and all(struct.pack(">d",float.fromhex(a))==struct.pack(">d",float.fromhex(b)) for a,b in zip(h,expected["xyz_m_hex"])),"target order/bits")
    require(all(record[k] is True for k in ["geometry_match","current_match","targets_match"]),"source preparation guards")
    return {"status":"PASS: exported source prerequisites","source_count":6,"volume_m3_exact":"1","a_apm2_exact":["4","0","0"],"b_apm3_exact":"0"}

def counts(value,label):
    vector(value,14,label)
    require(all(type(v) is int and v>=0 for v in value),label+": nonnegative integer")
    return value

def check_call(record,inputs):
    require(record["attempted_calls"]==1,"one batch call required")
    require(record["operator_version"]==inputs["operator_version"],"operator version")
    require(record["status"]=="RETURNED" and record["refusal_reason"]=="","kernel refusal: "+record["refusal_reason"])
    results=vector(record["targets"],3,"returned targets")
    work=record["work_report"];phase=record["phase_report"];limits=inputs["policy"]["limits"]
    require(phase["started"] is True and phase["accounting_issue"] is False,"phase accounting")
    phases=vector(phase["wall_time_ns"],9,"phases")
    require(all(type(x) is int and x>=0 for x in phases) and sum(phases)==phase["total_wall_time_ns"] and sum(phases)>0,"phase sum")
    total=counts(work["total"],"total work");current=counts(work["current_target"],"current work")
    require(total[0]==18 and work["current_target_index"]==2,"six sources times three targets")
    require(all(a<=b for a,b in zip(total,limits["total"])) and all(a<=b for a,b in zip(current,limits["per_target"])) ,"reported work limit")
    for precision in vector(work["by_precision"],3,"precision work"): counts(precision,"precision work")
    require(work["maximum_raw_integer_bits"]<=limits["maximum_raw_integer_bits"] and work["maximum_reduced_fraction_bits"]<=limits["maximum_reduced_fraction_bits"],"integer bit limits")
    require(0<record["external_elapsed_seconds"] and math.isfinite(record["external_elapsed_seconds"]) and
        0<work["elapsed_seconds"]<=limits["maximum_total_seconds"],"real elapsed time/limit")
    for rss in [record["lifetime_peak_rss_bytes"],work["last_sampled_lifetime_peak_rss_bytes"]]:
        require(type(rss) is int and 0<rss<=limits["maximum_lifetime_peak_rss_bytes"],"real lifetime RSS/limit")
    checks=[]
    for index,(result,case) in enumerate(zip(results,inputs["targets"])):
        target_work=counts(result["work"],"target work")
        require(target_work[0]==6 and all(a<=b for a,b in zip(target_work,limits["per_target"])) ,"target source count/work limit")
        raw=binary(result["h_xyz_apm_hex"],result["h_xyz_apm"],3,"raw H")
        reference=[F.from_float(float.fromhex(x)) for x in case["reference_H_apm_hex"]]
        require(gate(raw,reference),"raw H/reference: "+case["id"])
        precision_checks=[]
        for p,precision in enumerate(vector(result["precisions"],3,"precision reports")):
            require(type(precision["evaluated"]) is bool and type(precision["refusal_reason"]) is str,"precision report state")
            if p>0:
                require(precision["evaluated"] and precision["refusal_reason"]=="","required MPFR pass")
            if precision["evaluated"]:
                require(precision["refusal_reason"]=="","evaluated precision refusal")
                h=[F(x) for x in vector(precision["h_xyz_apm"],3,"precision H")]
                [F(x) for x in vector(precision["whole_h_xyz_apm"],3,"whole precision H")]
                for key in ["sum_local_norm_apm","cancellation","maximum_face_cancellation"]: F(precision[key])
                if p>0: require(gate(h,reference),"MPFR/reference: "+case["id"])
                precision_checks.append({"index":p,"evaluated":True,"reference_gate":gate(h,reference),"refusal_reason":precision["refusal_reason"]})
            else:
                require(p==0 and result["binary64_requires_highprecision"] is True and precision["refusal_reason"]!="","binary refusal without native MPFR fallback")
                precision_checks.append({"index":p,"evaluated":False,"refusal_reason":precision["refusal_reason"]})
        for key in ["precision_budget_apm","local_precision_delta_apm","local_formula_delta_apm","local_formula_delta_80_apm"]: F(result[key])
        # The unchanged kernel leaves this string empty after binary64 NumericRefusal.
        if result["precisions"][0]["evaluated"] or result["binary64_roundoff_indicator_apm"]:
            F(result["binary64_roundoff_indicator_apm"])
        checks.append({"id":case["id"],"raw_reference_gate":True,"precision_checks":precision_checks})
    return checks

def assess(log,inputs):
    records={prefix:[json.loads(line[len(prefix):]) for line in log.splitlines() if line.startswith(prefix)]
        for prefix in ["NATIVE_CUBE_INPUT=","NATIVE_CUBE_CALL=","NATIVE_CUBE_SETUP_REFUSED="]}
    oet0={name:[line for line in log.splitlines() if re.search(r"\b"+re.escape(name)+r"\s+\.+\s+(Passed|\*\*\*Failed)",line)] for name in OET0}
    report={"schema":"private.native-cube-reference-ci-result.v1","status":"FAIL: incomplete native/source/reference evidence",
        "qualification":"NOT VERIFIED","production_gate":PRODUCTION,"records":records,"oet0_results":oet0,"checks":[],"errors":[]}
    try:
        report["after_run_source_pins"]=source_guard()
        require(not records["NATIVE_CUBE_SETUP_REFUSED="],"source setup refused before field call")
        require(len(records["NATIVE_CUBE_INPUT="])==1,"one complete source record required")
        report["source_check"]=check_inputs(records["NATIVE_CUBE_INPUT="][0],inputs)
        require(len(records["NATIVE_CUBE_CALL="])==1,"one complete batch field record required")
        report["checks"]=check_call(records["NATIVE_CUBE_CALL="][0],inputs)
        require(all(len(lines)==1 and "Passed" in lines[0] for lines in oet0.values()),"unchanged four OE-T0 CTest outcomes required")
        report["status"]=MARKER
    except Exception as error:
        report["errors"].append(str(error))
    return report

def main():
    OUT.mkdir(exist_ok=True)
    try:
        inputs=json.loads((BASE/"inputs.json").read_text())
        log=(OUT/"native.log").read_text(errors="replace") if (OUT/"native.log").exists() else ""
        report=assess(log,inputs)
    except Exception as error:
        report={"schema":"private.native-cube-reference-ci-result.v1","status":"REFUSED: output/readback failure","error":str(error),"qualification":"NOT VERIFIED","production_gate":PRODUCTION}
    (OUT/"native-result.json").write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps(report))
    return 0 if report["status"]==MARKER else 1

if __name__=="__main__":
    sys.exit(main())
