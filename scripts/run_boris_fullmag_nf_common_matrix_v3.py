"""Typed runtime-v4/common-case-v3 consumer; raw comparisons never qualify physics."""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import json
import math
from pathlib import Path
import sys

import boris_nf_common_case_v3 as common
import fullmag_storage as storage
from compare_boris_fullmag_she_nf import _concat_qia, _metric, load_fullmag_m2_artifact
from run_managed_boris_nf import identifier, read_json, runtime_root
from run_managed_boris_nf_v3 import observe, verify_runtime_identity
import run_fullmag_m2_nf_common_case_v3 as reference
import run_managed_fullmag_nf_common_v2 as managed
from verify_boris_nf_interface import MUB_E_V_PER_T, map_boris_spin_to_fullmag_mu_s

SCHEMA = "fullmag.boris_fullmag_nf_common_matrix.v3"
TOLERANCES = (1e-8, 1e-10)


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


_LOADED_SOURCE_SHA256 = sha(Path(__file__))


def write(path, value):
    Path(path).write_text(json.dumps(value, indent=2, sort_keys=True, allow_nan=False)+"\n", encoding="utf-8")


@dataclass(frozen=True)
class CommonArtifact:
    case_key: str
    potential_v: tuple[float, ...]
    mu_s_v: tuple[tuple[float, ...], ...]
    charge_current_apm2: tuple[tuple[float, ...], ...]
    spin_current_qia_apm2: tuple[tuple[float, ...], ...]
    residuals: dict
    observations: dict


def runtime_reference(repo, case_key, runtime_id):
    runtime_id = identifier(runtime_id)
    root = runtime_root(storage.resolve_layout(repo, "windows-native"), runtime_id)
    if read_json(root / "receipt.json").get("schema") != "fullmag.boris.managed_run.v3":
        raise ValueError("common matrix rejects legacy managed-run v1/v2 without fallback")
    observed = observe(repo, runtime_id)
    if isinstance(observed, dict):
        raise ValueError("common BORIS reference has not reached terminal success")
    summary_path = Path(observed)
    payload = read_json(summary_path)
    identity = payload["runtime"]
    if identity.get("schema_version") != "fullmag.boris.runtime.v4" or identity.get("runtime_id") != runtime_id or identity.get("case_key") != case_key:
        raise ValueError("common matrix requires the exact runtime-v4 identity")
    verify_runtime_identity(identity, repo, summary_path.parent)
    descriptor = common.case_descriptor(case_key)
    if payload.get("schema_version") != common.SUMMARY_SCHEMA or payload.get("scenario") != descriptor or payload.get("case_sha256") != common.canonical_hash(descriptor):
        raise ValueError("common BORIS case/summary differs from the preregistered descriptor")
    paths = [summary_path, summary_path.parent / "runtime.json", root / "receipt.json", root / "input/scenario.json"]
    pin = {str(p): sha(p) for p in paths}
    return summary_path, payload, pin


def require_reference(repo, path, payload, pin):
    if any(sha(Path(p)) != digest for p, digest in pin.items()):
        raise ValueError("common BORIS admitted reference bytes changed")
    verify_runtime_identity(payload["runtime"], repo, path.parent)


def normalize_common_boris(root, payload, case_key):
    descriptor = common.case_descriptor(case_key)
    observed = common.raw_observations(root, descriptor)
    if payload.get("observables") != observed or payload.get("residuals") != observed["residuals"]:
        raise ValueError("common BORIS observations differ from independent raw readback")
    fields = common.read_fields(root, descriptor)
    common.check_affine_x_invariance(fields, voltage_v=descriptor["boundary"]["voltage_v"],
        length_x_m=descriptor["physical_geometry"]["length_x_m"], origin_x_m=0.0,
        voltage_at_xmin_v=descriptor["boundary"]["boris_xmin_potential_v"])
    currents = common.section_currents(fields)
    planes = currents["total_section_current_a"]
    threshold = descriptor["observation_gate"]["relative_tolerance"]
    if len(planes) != 4 or any(v >= 0.0 for v in planes) or max(planes)-min(planes) > threshold*max(abs(v) for v in planes):
        raise ValueError("common BORIS full reciprocal Jc signed cross-sections fail")
    n, f = fields["normal"], fields["ferromagnet"]
    residuals = payload.get("residuals")
    if not isinstance(residuals, dict) or residuals.get("status") not in ("available", "unavailable"):
        raise ValueError("common BORIS bulk residual availability missing")
    if case_key == "r0":
        if residuals.get("status") != "unavailable" or any(residuals.get(k) is not None for k in ("charge_scaled_l2", "spin_scaled_l2")):
            raise ValueError("r0 zero-interior residual must be unavailable, never numeric zero/PASS")
    elif residuals.get("status") != "available" or any(type(residuals.get(k)) not in (int,float)
            or not math.isfinite(residuals[k]) or residuals[k] < 0 for k in ("charge_scaled_l2", "spin_scaled_l2")):
        raise ValueError("refined common bulk residual evidence missing")
    spin = tuple(tuple(row) for row in (*n["S"].values, *f["S"].values))
    mu = map_boris_spin_to_fullmag_mu_s(spin, 0.01, 5.8e7)
    q = tuple(tuple(v/MUB_E_V_PER_T for v in row) for row in _concat_qia(n,f))
    return CommonArtifact(case_key,
        tuple(row[0] for row in (*n["V"].values,*f["V"].values)), tuple(mu),
        tuple(tuple(row) for row in (*n["Jc"].values,*f["Jc"].values)), q,
        residuals, {"current": currents, "native": payload.get("observables")})


def compare_common(boris, fullmag, fullmag_case):
    descriptor = common.case_descriptor(boris.case_key)
    offset = descriptor["boundary"]["fullmag_minus_boris_potential_offset_v"]
    nx,ny,nzn = descriptor["geometry"]["normal_shape"]
    def adjacent(q):
        return [[math.fsum(q[ix+nx*(iy+ny*iz)][6+axis] for iy in range(ny) for ix in range(nx))/(nx*ny)
                 for axis in range(3)] for iz in (nzn-1,nzn)]
    metrics = {
        "potential_v": _metric(tuple(v+offset for v in boris.potential_v), fullmag.potential_v),
        "mu_s": _metric(boris.mu_s_v, fullmag.mu_s_v),
        "charge_current": _metric(boris.charge_current_apm2, fullmag.charge_current_apm2),
        "spin_current_qia": _metric(boris.spin_current_qia_apm2, fullmag.spin_current_qia_apm2),
        "interface_adjacent_cell_Qz": _metric(adjacent(boris.spin_current_qia_apm2), adjacent(fullmag.spin_current_qia_apm2)),
        "full_Jc_cross_sections_a": _metric(boris.observations["current"]["total_section_current_a"],
            fullmag_case["field_gates"]["full_Jc_cell_quadrature"]["xplane_current_a"]),
    }
    if any(type(v) not in (int,float) or not math.isfinite(v) or v < 0
           for metric in metrics.values() for v in metric.values()):
        raise ValueError("common comparison produced invalid metrics")
    return {"status": "raw_comparison_complete_unqualified", "metrics": metrics,
        "gauge_offset_fullmag_minus_boris_v": offset, "fitted_parameters": False,
        "interface_scope": "same adjacent cell-center Qz samples; distinct BORIS traces/FV face laws remain diagnostics",
        "residuals": {"boris_independent_bulk": boris.residuals,
            "fullmag_solver": dict(fullmag.residuals), "comparison": "different residual definitions; no parity PASS"},
        "torque": "incomparable", "physics_qualified": False,
        "r0_scope": "capacity/raw completion only; zero-interior bulk unavailable" if boris.case_key == "r0" else "refinement evidence; qualification separate"}


def run(repo, runtime_ids, binding, report_id):
    if sys.platform != "win32":
        raise ValueError("common managed matrix is Windows-only")
    if set(runtime_ids) != set(common.CASE_KEYS) or len(set(runtime_ids.values())) != 3:
        raise ValueError("three distinct source-bound r0/r1/r2 runtime-v4 IDs required")
    refs = {key: runtime_reference(repo,key,runtime_ids[key]) for key in common.CASE_KEYS}
    identities = [payload["runtime"] for _,payload,_ in refs.values()]
    for name in ("build_job_id", "binary_sha256", "source_manifest_sha256", "image_digest",
                 "tools_manifest_sha256", "native_source_digest", "family_binding_sha256"):
        if len({v[name] for v in identities}) != 1:
            raise ValueError("common references use different native BORIS builds")
    for previous_key,key in zip(common.CASE_KEYS,common.CASE_KEYS[1:]):
        prior=refs[key][1]["runtime"].get("previous_capacity")
        if not isinstance(prior,dict) or prior.get("runtime_id")!=runtime_ids[previous_key]:
            raise ValueError("common matrix references a different serial capacity family chain")
    layout = storage.resolve_layout(repo,"windows-native")
    target = storage.validate_path(Path(layout["build_root"])/"nf-common-matrix-reports"/identifier(report_id), Path(layout["storage_root"]))
    target.mkdir(parents=True,exist_ok=False)
    try:
        result = managed.run(repo,binding)
        managed.require_pin(result,result["pin"])
    except BaseException as error:
        write(target/"failure.json",{"status":"not_run","reason":str(error),"binding":binding,"physics_qualified":False})
        raise
    rows=[]
    summary={"schema_version":SCHEMA,"physics_qualified":False,"torque_qualification":"incomparable",
        "execution_status":"not_run","runs":rows,"fullmag_receipt":result["receipt"]}
    try:
        for key in common.CASE_KEYS:
            path,payload,pin=refs[key]
            for tolerance in TOLERANCES:
                require_reference(repo,path,payload,pin)
                managed.require_pin(result,result["pin"])
                run_key=f"{key}__tol-{tolerance:.0e}"
                case=next(v for v in result["receipt"]["cases"] if v["key"]==run_key)
                artifact=Path(result["run_root"])/"export/result"/run_key/"transport/fullmag_m2_nf_reference.json"
                b=normalize_common_boris(path.parent,payload,key)
                f=load_fullmag_m2_artifact(artifact)
                resolution=reference.common_resolutions()[key]
                if f.shape != resolution.shape or f.step_m != resolution.cell_m or case.get("common_case") != common.case_descriptor(key):
                    raise ValueError("common Fullmag/BORIS actual carrier/case differs")
                expected_origin=reference.mesh_registration(resolution)["fullmag_origin_m"]
                if any(not math.isclose(a,v,rel_tol=1e-12,abs_tol=1e-18) for a,v in zip(f.origin_m,expected_origin)):
                    raise ValueError("common actual Fullmag origin differs from fixed translation")
                comparison=compare_common(b,f,case)
                require_reference(repo,path,payload,pin)
                managed.require_pin(result,result["pin"])
                rows.append({"key":run_key,"case":common.case_descriptor(key),"tolerance":tolerance,
                    "runtime":payload["runtime"],"boris_pin":pin,"fullmag_case":case,"comparison":comparison})
        for path,payload,pin in refs.values():
            require_reference(repo,path,payload,pin)
        managed.require_pin(result,result["pin"])
        if managed.host_policy(Path(repo).resolve()) != result["host_policy_sha256"]:
            raise ValueError("common matrix loaded host policy changed during comparison")
        summary["execution_status"]="raw_matrix_complete_unqualified"
    except BaseException as error:
        summary["failure"]=str(error)
        raise
    finally:
        write(target/"matrix.json",summary)
    validate_summary(summary)
    return target/"matrix.json"


def validate_summary(summary):
    if summary.get("schema_version") != SCHEMA or summary.get("execution_status") != "raw_matrix_complete_unqualified" or summary.get("physics_qualified") is not False:
        raise ValueError("common matrix lacks all actual cases; source/structure is not a benchmark")
    expected={f"{key}__tol-{tol:.0e}":(key,tol) for key in common.CASE_KEYS for tol in TOLERANCES}
    rows=summary.get("runs")
    if not isinstance(rows,list) or len(rows)!=6 or any(not isinstance(r,dict) for r in rows) or {r.get("key") for r in rows}!=set(expected):
        raise ValueError("common matrix case inventory differs")
    receipt=summary.get("fullmag_receipt",{})
    if receipt.get("schema")!=managed.SCHEMA or receipt.get("state")!="solver_succeeded_identity_verified" or receipt.get("physics_qualified") is not False or receipt.get("solver_capsule_attribution") is not False:
        raise ValueError("common matrix has no terminal source-bound Fullmag receipt")
    names={"potential_v","mu_s","charge_current","spin_current_qia","interface_adjacent_cell_Qz","full_Jc_cross_sections_a"}
    fields={"max_absolute_error","max_relative_error","normalized_l2_error","endpoint_error"}
    for row in rows:
        key,tolerance=expected[row["key"]]
        runtime=row.get("runtime",{})
        comparison=row.get("comparison",{})
        if (runtime.get("schema_version")!="fullmag.boris.runtime.v4" or runtime.get("managed_run_schema")!="fullmag.boris.managed_run.v3"
                or runtime.get("identity_complete") is not True or runtime.get("solver_capsule_attribution") is not False
                or runtime.get("case_key")!=key or runtime.get("case_sha256")!=common.canonical_hash(common.case_descriptor(key))
                or row.get("case")!=common.case_descriptor(key) or row.get("tolerance")!=tolerance
                or row.get("fullmag_case",{}).get("key")!=row["key"]
                or row.get("fullmag_case",{}).get("common_case")!=common.case_descriptor(key)
                or row.get("fullmag_case",{}).get("tolerance")!=tolerance
                or row.get("fullmag_case") not in receipt.get("cases",[])
                or comparison.get("status")!="raw_comparison_complete_unqualified"):
            raise ValueError("common matrix runtime/case binding differs")
        if comparison.get("physics_qualified") is not False or comparison.get("torque")!="incomparable":
            raise ValueError("common matrix cannot promote physics/torque")
        metrics=comparison.get("metrics",{})
        if set(metrics)!=names or any(not isinstance(metric,dict) or set(metric)!=fields or any(
                type(v) not in (int,float) or not math.isfinite(v) or v<0 for v in metric.values()) for metric in metrics.values()):
            raise ValueError("common matrix contains incomplete/nonfinite comparison metrics")
        if key=="r0":
            residual=comparison.get("residuals",{}).get("boris_independent_bulk",{})
            if residual.get("status")!="unavailable" or any(residual.get(k) is not None for k in ("charge_scaled_l2","spin_scaled_l2")):
                raise ValueError("r0 bulk residual cannot be numeric or PASS")


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root",type=Path,required=True)
    for key in common.CASE_KEYS: parser.add_argument("--boris-runtime-"+key,required=True)
    for key in ("job-id","commit","source-digest","native-snapshot-sha256"): parser.add_argument("--fullmag-managed-"+key,required=True)
    parser.add_argument("--managed-report-id",required=True)
    args=parser.parse_args()
    binding={key:getattr(args,"fullmag_managed_"+key) for key in ("job_id","commit","source_digest","native_snapshot_sha256")}
    print(json.dumps({"status":"raw_matrix_complete_unqualified","matrix":str(run(args.repo_root,
        {k:getattr(args,"boris_runtime_"+k) for k in common.CASE_KEYS},binding,args.managed_report_id))},sort_keys=True))
    return 0


if __name__=="__main__":
    raise SystemExit(main())
