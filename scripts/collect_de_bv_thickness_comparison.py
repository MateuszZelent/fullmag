"""Collect six certified DE/BV thickness pilots; never qualify from a plot."""
from __future__ import annotations
import argparse
import csv
import hashlib
import json
import math
import re
from pathlib import Path
import numpy as np
from compare_de_bv_mode_profiles import load_record, sha256
from run_de_100nm_pilot import validate_thickness_layers_metadata, validate_smoke_potential_fields
from validate_de_smoke_rows import validate_rows, SAMPLING
from verify_fem_frequency_domain_eigen_artifacts import kalinikos_slab_n0_frequency_hz


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def positive(value):
    if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
        raise ValueError("invalid positive SI model parameter")
    return float(value)


def collect_record(run, layers, expected_job, *, sampling=None):
    run = Path(run).resolve()
    request, result = read_json(run/"run-request.json"), read_json(run/"run-result.json")
    if (request.get("schema") != "fullmag.de-smoke.request.v1" or
            result.get("schema") != "fullmag.de-smoke.result.v1" or
            result.get("status") != "completed_unqualified" or
            type(result.get("return_code")) is not int or result["return_code"] != 0):
        raise ValueError("expected a completed numerical DE/BV pilot")
    if layers not in (3,6,9) or type(layers) is not int:
        raise ValueError("unsupported comparison layers")
    if request.get("thickness_layers_requested") != str(layers):
        raise ValueError("request layers differ from comparison")
    if "thickness_layers_requested" in result and result["thickness_layers_requested"] != str(layers):
        raise ValueError("result layers differ from comparison")
    for receipt in (request,result):
        if receipt.get("job") != expected_job:
            raise ValueError("receipt job identity differs from requested build")
    for key in ("source","model_source","model_sha256"):
        if not request.get(key) or request[key] != result.get(key):
            raise ValueError("receipt identity mismatch: "+key)
    pilot=result.get("pilot")
    orientations={"de-smoke-k25":("damon_eshbach","M0=x,k=y,normal=z"),
                  "de-smoke-bv-k25":("backward_volume","M0=x,k=x,normal=z")}
    if sampling is not None:
        if (not isinstance(sampling, str) or re.fullmatch(r"(?:bv-)?k-?\d+", sampling) is None
                or sampling not in SAMPLING or len(SAMPLING[sampling]) != 1
                or pilot != "de-smoke-" + sampling):
            raise ValueError("expected explicitly requested single-point DE/BV pilot")
        orientations = {pilot: (("backward_volume", "M0=x,k=x,normal=z")
                                if sampling.startswith("bv-") else
                                ("damon_eshbach", "M0=x,k=y,normal=z"))}
    if pilot not in orientations:
        raise ValueError("expected DE/BV k25 pilot")
    geometry,orientation=orientations[pilot]
    case=run/pilot
    model=read_json(case/"metadata.json")["problem_meta"]["runtime_metadata"]["de_smoke"]
    if model.get("orientation") != orientation:
        raise ValueError("actual orientation differs from pilot")
    parameters={"geometry":geometry,
        "bias_field_a_per_m":positive(model["external_induction_t"])/positive(model["mu0_t_m_a"]),
        "film_thickness_m":positive(model["film_thickness_m"]),
        "exchange_stiffness_j_per_m":positive(model["exchange_stiffness_j_per_m"]),
        "saturation_magnetisation_a_per_m":positive(model["saturation_magnetization_a_per_m"]),
        "gamma0_rad_s_per_a_m":positive(model["gamma0_m_per_a_s"])}
    resolution=validate_thickness_layers_metadata(case,str(layers))
    validate_rows(case/"eigen/dispersion.csv",pilot.removeprefix("de-smoke-"),
                  case/"eigen/diagnostics/solver.v1.json",case/"metadata.json")
    with (case/"eigen/dispersion.csv").open(encoding="utf-8-sig",newline="") as stream:
        rows=list(csv.DictReader(stream))
    if len(rows)!=1 or rows[0]["sample_index"]!="0" or rows[0]["raw_mode_index"]!="0":
        raise ValueError("comparison requires exactly one sample and mode")
    row=rows[0]
    k=float(row["ky_rad_per_m"] if geometry=="damon_eshbach" else row["kx_rad_per_m"])
    if sampling is not None and not math.isclose(k, SAMPLING[sampling][0], rel_tol=1e-12, abs_tol=1e-12):
        raise ValueError("actual signed wavevector differs from requested sample")
    frequency=positive(float(row["frequency_hz"]))
    mode_path=case/"eigen/modes/sample_0000/mode_0000.json"
    mode=read_json(mode_path)
    residual=mode["block_residuals"]["eps_full"]
    if type(residual) not in (int,float) or not math.isfinite(residual) or not 0 <= residual <= 1e-8:
        raise ValueError("invalid original full residual")
    analytic=kalinikos_slab_n0_frequency_hz(k_norm=abs(k),**parameters)
    files=["run-request.json","run-result.json",pilot+"/metadata.json",
           pilot+"/eigen/dispersion.csv",pilot+"/eigen/spectrum.v3.json",
           pilot+"/eigen/modes/sample_0000/mode_0000.json"]
    record={"geometry":geometry,"k_rad_per_m":k,"frequency_hz":frequency,
        "analytic_frequency_hz":analytic,"difference_percent":100*(frequency-analytic)/analytic,
        "full_residual":residual,"parameters":parameters,
        "pilot":pilot,"run_path":str(run),"job":expected_job,"model_source":result["model_source"],
        "mesh_level":request.get("mesh_level_requested"),"thickness_layers":layers,
        "air_padding_each_side_m":positive(model["air_padding_each_side_m"]),
        "thickness_resolution":resolution,"artifact_sha256":{f:sha256(run/f) for f in files}}
    mesh,_,tetra,_,hashes,uniform=load_record(record)
    xy=np.unique(np.round(mesh.nodes[np.unique(tetra),:2],17),axis=0)
    record.update(uniform_projection_squared_consistent_mass=uniform,
                  profile_input_sha256=hashes,
                  magnetic_xy_sha256=hashlib.sha256(xy.astype("<f8").tobytes()).hexdigest())
    return record


def collect_batch(records):
    if {(r["geometry"],r["thickness_layers"]) for r in records} != {
            (g,n) for g in ("damon_eshbach","backward_volume") for n in (3,6,9)} or len(records)!=6:
        raise ValueError("expected six distinct DE/BV layers 3/6/9 records")
    baseline=records[0]
    for record in records:
        for key in ("job","model_source","mesh_level","air_padding_each_side_m","k_rad_per_m","magnetic_xy_sha256"):
            if record[key]!=baseline[key]:
                raise ValueError("thickness comparison changes controlled input: "+key)
        if {k:v for k,v in record["parameters"].items() if k!="geometry"} != {
                k:v for k,v in baseline["parameters"].items() if k!="geometry"}:
            raise ValueError("thickness comparison changes material or geometry")
    return {"schema":"fullmag.de-bv.thickness-comparison.v1","qualification":"NOT VERIFIED",
            "analytic_model":"Kalinikos-Slavin uniform n=0 open-film approximation",
            "scope":"fixed-k thickness convergence; airbox and full spectral qualification remain separate",
            "records":records}


def normalize_controller_report(path, control):
    """Adapt the pinned seven-case controller without treating partial runs as terminal."""
    if "results" not in control:
        return control
    root = Path(path).resolve().parent
    config = read_json(root / "controller-config.json")
    for key, length in (("job_id", 32), ("source_digest", 64)):
        value = control.get(key)
        if (not isinstance(value, str) or re.fullmatch(r"[a-f0-9]{%d}" % length, value) is None
                or value != config.get(key)):
            raise ValueError("controller/config identity mismatch: " + key)
    model_ref = config.get("model_ref")
    if not isinstance(model_ref, str) or re.fullmatch(r"[a-f0-9]{40}", model_ref) is None:
        raise ValueError("controller model ref must be a full commit")
    expected = ["gamma-t3", "de-t3", "bv-t3", "de-t6", "bv-t6", "de-t9", "bv-t9"]
    results = control.get("results")
    if not isinstance(results, list) or len(results) != len(expected):
        raise ValueError("seven-case controller is incomplete")
    cases = []
    for row, name in zip(results, expected):
        if (not isinstance(row, dict) or row.get("case") != name
                or type(row.get("wrapper_exit")) is not int or row["wrapper_exit"] != 0):
            raise ValueError("controller has an unsuccessful or duplicate case")
        output = row.get("output")
        if (not isinstance(output, str) or not Path(output).is_absolute()
                or Path(output).resolve() != root / name):
            raise ValueError("controller case output is outside its declared batch")
        cases.append({"output_dir": output, "wrapper_exit_code": 0,
                      "layers": int(name[-1])})
    return {"status": "wrappers_terminal_requires_scientific_review",
            "job_id": control["job_id"], "expected_source_digest": control["source_digest"],
            "model_ref": model_ref, "cases": cases[1:], "gamma_control": cases[0],
            "controller_config_sha256": sha256(root / "controller-config.json")}


def validate_gamma_control(run, job, model_source):
    """Bind Gamma to the same successful managed build and versioned model."""
    run = Path(run)
    request, result = read_json(run / "run-request.json"), read_json(run / "run-result.json")
    if (request.get("schema") != "fullmag.de-smoke.request.v1"
            or result.get("schema") != "fullmag.de-smoke.result.v1"
            or result.get("pilot") != "de-smoke-k0" or result.get("status") != "completed_unqualified"
            or type(result.get("return_code")) is not int or result["return_code"] != 0
            or request.get("job") != job or result.get("job") != job
            or request.get("model_source") != model_source):
        raise ValueError("Gamma control receipt or source identity mismatch")
    for key in ("source", "model_source", "model_sha256"):
        if not request.get(key) or request[key] != result.get(key):
            raise ValueError("Gamma receipt identity mismatch: " + key)
    case = run / "de-smoke-k0"
    rows = validate_rows(case / "eigen/dispersion.csv", "k0",
                         case / "eigen/diagnostics/solver.v1.json", case / "metadata.json")
    fields = validate_smoke_potential_fields(case, rows["sample_count"])
    return {"row_preflight": rows, "potential_reconstruction": fields,
            "artifact_sha256": {name: sha256(run / name) for name in (
                "run-request.json", "run-result.json", "de-smoke-k0/metadata.json",
                "de-smoke-k0/eigen/dispersion.csv", "de-smoke-k0/eigen/diagnostics/solver.v1.json")}}


def collect_control(control_path):
    """Independently bind all six controls and Gamma before returning evidence."""
    control_path = Path(control_path)
    control=normalize_controller_report(control_path, read_json(control_path))
    if control.get("status")!="wrappers_terminal_requires_scientific_review":
        raise ValueError("batch is not terminal")
    cases=control["cases"]
    if len(cases)!=6 or any(c.get("wrapper_exit_code")!=0 for c in cases):
        raise ValueError("not all six numerical pilots completed successfully")
    job=read_json(Path(cases[0]["output_dir"])/"run-request.json")["job"]
    if job["job_id"]!=control["job_id"] or job["source_digest"]!=control["expected_source_digest"]:
        raise ValueError("batch/build identity mismatch")
    records=[collect_record(c["output_dir"],c["layers"],job) for c in cases]
    if any(r["model_source"].get("commit")!=control["model_ref"] for r in records):
        raise ValueError("batch model identity mismatch")
    output=collect_batch(records)
    output.update(control_sha256=sha256(control_path),producer_sha256=sha256(Path(__file__)))
    if "controller_config_sha256" in control:
        output["controller_config_sha256"] = control["controller_config_sha256"]
    if "gamma_control" in control:
        output["gamma_control"] = {**control["gamma_control"], **validate_gamma_control(
            control["gamma_control"]["output_dir"], job, records[0]["model_source"])}
    return output


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("control",type=Path)
    parser.add_argument("output",type=Path)
    args=parser.parse_args()
    output=collect_control(args.control)
    with args.output.open("x",encoding="utf-8") as stream:
        json.dump(output,stream,indent=2);stream.write("\n")
    print(json.dumps({"records":len(output["records"]),"qualification":output["qualification"]}))


if __name__=="__main__":
    main()
