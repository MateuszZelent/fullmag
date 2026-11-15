"""Read native CI output and apply preregistered comparisons, without a solver."""
from fractions import Fraction as F
import json
from pathlib import Path
import sys

BASE = Path(__file__).resolve().parent
PREFIX = "NATIVE_SURFACE_CALL="
CAMPAIGN = "NATIVE_SURFACE_CAMPAIGN="
MARKER = "NATIVE_SURFACE_FOUR_CASE_REFERENCE_ONLY_PASS"
PRODUCTION = "PRODUCTION_DTQ_GATE_REMAINS_FAIL_FROM_RUN_43647488516"

def gate(h, ref):
    # Exact rational equivalent of ||h-ref|| <= 10^-12*(1+sqrt(ref.ref)).
    e2 = sum((a-b)**2 for a,b in zip(h,ref))
    r2 = sum(x*x for x in ref)
    x = e2/F(1,10**24)-1-r2
    return x <= 0 or x*x <= 4*r2

def check_record(record, case, operator):
    errors = []
    def need(ok, message):
        if not ok:
            errors.append(message)
    need(record["id"] == case["id"], "case order/id")
    need(record["operator_version"] == operator, "operator version")
    need(record["status"] == "RETURNED" and record["refusal_reason"] == "", "native refusal")
    work = record["work_report"]
    phase = record["phase_report"]
    need(phase["started"] and not phase["accounting_issue"], "phase accounting state")
    need(sum(phase["wall_time_ns"]) == phase["total_wall_time_ns"], "phase sum")
    need(record["lifetime_peak_rss_bytes"] > 0 and work["last_sampled_lifetime_peak_rss_bytes"] > 0, "real lifetime RSS")
    if record["status"] != "RETURNED":
        return {"id": case["id"], "pass": False, "errors": errors, "refusal_reason": record["refusal_reason"]}
    need(len(record["targets"]) == 1, "one returned target")
    if len(record["targets"]) != 1:
        return {"id": case["id"], "pass": False, "errors": errors}
    result = record["targets"][0]
    need(work["total"][0] == 1 and result["work"][0] == 1, "one source-target pair")
    need(len(result["precisions"]) == 3, "three precision reports")
    raw = [F.from_float(float.fromhex(x)) for x in result["h_xyz_apm_hex"]]
    need([float(x) for x in raw] == result["h_xyz_apm"], "raw H bit readback")
    reference = [F(x) for x in case["reference_H120_apm"]]
    need(gate(raw, reference), "raw H/reference gate")
    if case["analytic_H_apm_exact"] is not None:
        analytic = [F(x) for x in case["analytic_H_apm_exact"]]
        need(gate(raw, analytic), "analytic vertex gate")
    bound = F(case["bound_apm_exact"]) if case["bound_apm_exact"] else None
    if bound is not None:
        need(sum(x*x for x in raw) <= bound*bound, "raw H rigorous bound")
    precision_checks = []
    for index, precision in enumerate(result["precisions"]):
        if index > 0:
            need(precision["evaluated"] and precision["refusal_reason"] == "", "required MPFR pass " + str(index))
        if precision["evaluated"]:
            h = [F(x) for x in precision["h_xyz_apm"]]
            # The binary64 report may legitimately require unchanged MPFR fallback.
            # Its values and refusal are retained; do not replace native policy.
            if index > 0:
                need(gate(h, reference), "MPFR/reference gate " + str(index))
                if bound is not None:
                    need(sum(x*x for x in h) <= bound*bound, "MPFR rigorous bound " + str(index))
            precision_checks.append({"precision_index": index, "evaluated": True,
                "reference_gate": gate(h,reference),
                "norm_le_bound": sum(x*x for x in h) <= bound*bound if bound is not None else None})
        else:
            precision_checks.append({"precision_index": index, "evaluated": False,
                "refusal_reason": precision["refusal_reason"]})
            if index == 0:
                need(result["binary64_requires_highprecision"], "binary refusal without MPFR fallback flag")
    return {"id": case["id"], "pass": not errors, "errors": errors,
        "reference_gate": gate(raw,reference), "norm_le_bound": sum(x*x for x in raw) <= bound*bound if bound is not None else None,
        "precision_checks": precision_checks}

def assess(log, inputs):
    records, totals = [], []
    for line in log.splitlines():
        if line.startswith(PREFIX):
            records.append(json.loads(line[len(PREFIX):]))
        if line.startswith(CAMPAIGN):
            totals.append(json.loads(line[len(CAMPAIGN):]))
    report = {"schema": "private.native-surface-reference-ci-result.v1",
        "status": "NOT RUN: no complete four-call native output", "qualification": "NOT VERIFIED",
        "production_gate": PRODUCTION, "case_count": len(records),
        "records": records, "campaign_reports": totals, "checks": [], "errors": []}
    if len(records) != 4 or len(totals) != 1:
        report["errors"].append("exactly four call records and one campaign record required")
        return report
    report["status"] = "FAIL: native refusal or preregistered check"
    for record, case in zip(records, inputs["cases"]):
        report["checks"].append(check_record(record,case,inputs["operator_version"]))
    campaign = totals[0]
    if campaign["attempted_calls"] != 4 or campaign["returned_calls"] != 4:
        report["errors"].append("campaign attempted/returned count")
    for label, expected in (
        ("total_work", [sum(r["work_report"]["total"][i] for r in records) for i in range(14)]),
        ("phase_wall_time_ns", [sum(r["phase_report"]["wall_time_ns"][i] for r in records) for i in range(9)]),
        ("by_precision", [[sum(r["work_report"]["by_precision"][p][i] for r in records) for i in range(14)] for p in range(3)]),
        ("sum_phase_total_wall_time_ns", sum(r["phase_report"]["total_wall_time_ns"] for r in records))):
        if campaign[label] != expected:
            report["errors"].append("campaign sum " + label)
    policy = inputs["policy"]["limits"]
    for r in records:
        w = r["work_report"]
        if any(a>b for a,b in zip(w["total"],policy["total"])) or any(a>b for a,b in zip(w["current_target"],policy["per_target"])):
            report["errors"].append(r["id"] + ": reported work limit")
        if w["maximum_raw_integer_bits"] > policy["maximum_raw_integer_bits"] or w["maximum_reduced_fraction_bits"] > policy["maximum_reduced_fraction_bits"]:
            report["errors"].append(r["id"] + ": integer bit bound")
        if r["lifetime_peak_rss_bytes"] > policy["maximum_lifetime_peak_rss_bytes"]:
            report["errors"].append(r["id"] + ": lifetime peak RSS bound")
    if not report["errors"] and all(c["pass"] for c in report["checks"]):
        report["status"] = MARKER
    return report

def main():
    out = Path("native-surface-reference-evidence")
    out.mkdir(exist_ok=True)
    try:
        inputs = json.loads((BASE/"inputs.json").read_text())
        log = (out/"native.log").read_text(errors="replace") if (out/"native.log").exists() else ""
        report = assess(log,inputs)
    except Exception as error:
        report = {"schema": "private.native-surface-reference-ci-result.v1", "status": "REFUSED: output/readback failure",
            "error": str(error), "qualification": "NOT VERIFIED", "production_gate": PRODUCTION}
    (out/"native-result.json").write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps(report))
    return 0 if report["status"] == MARKER else 1

if __name__ == "__main__":
    sys.exit(main())
