"""Fail-closed CLI validator for collected strict FEM SP4 artifacts."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
import sys

import numpy as np

from ..common.contract import CONTRACT
from ..common.metrics import find_first_zero_crossing, parity_metrics, reference_envelope_metrics
from ..common.references import Trajectory, load_reference_manifest, parse_albuquerque_trace, parse_oommf_odt


def load_run(path: Path) -> tuple[Trajectory, dict]:
    required = {"time", "mx", "my", "mz", "E_total", "max_torque_T"}
    with (path / "scalars.csv").open(newline="") as stream:
        reader = csv.DictReader(stream)
        if not required.issubset(reader.fieldnames or ()):
            raise ValueError(f"{path}: missing scalar columns {sorted(required-set(reader.fieldnames or ())) }")
        rows = list(reader)
    data = np.asarray([[float(row[key]) for key in ("time", "mx", "my", "mz")] for row in rows])
    if len(data) < 2 or not np.all(np.isfinite(data)):
        raise ValueError(f"{path}: incomplete or non-finite scalar trace")
    metadata = json.loads((path / "metadata.json").read_text())
    return Trajectory(data[:, 0], data[:, 1:], str(path)), metadata


def provenance_errors(metadata: dict, device: str) -> list[str]:
    errors=[]; requested=metadata.get("requested_execution",{}); provenance=metadata.get("execution_provenance",{}); demag=metadata.get("demag_runtime",{})
    expected="fem_cpu_native" if device=="cpu" else "fem_native_gpu"
    if requested != {"backend":"fem","device":device,"precision":"double","mode":"strict","fallback_policy":"forbidden"}: errors.append("requested execution is not exact strict FEM double")
    if provenance.get("execution_engine") != expected: errors.append(f"resolved engine is not {expected}")
    if provenance.get("lossy_fallback_used") is not False: errors.append("fallback was used or not proven absent")
    if device=="gpu" and provenance.get("fem_demag_operator_mode") != "device_hypre_poisson": errors.append("GPU demag is not device_hypre_poisson")
    if demag.get("actual_iterations") is None or demag.get("final_residual_norm") is None: errors.append("demag convergence diagnostics missing")
    return errors


def validate(root: Path, qualifying: bool) -> dict:
    reference_root=Path(__file__).parents[1]/"references"; load_reference_manifest(reference_root/"manifest.json")
    nist=reference_root/"nist"; refs={
      "case-a":[parse_oommf_odt(nist/"oommf/stdprob4a.odt"),parse_albuquerque_trace(nist/"albuquerque/FIELD_1_SM_DT25.TXT"),parse_albuquerque_trace(nist/"albuquerque/FIELD_1_LM_DT25.TXT")],
      "case-b":[parse_oommf_odt(nist/"oommf/stdprob4b.odt"),parse_albuquerque_trace(nist/"albuquerque/FIELD_2_SM_DT25.TXT"),parse_albuquerque_trace(nist/"albuquerque/FIELD_2_LM_DT25.TXT")]}
    failures=[]; metrics={}; loaded={}
    if qualifying:
        meshes=("coarse","medium","fine")
    else:
        meshes=tuple(sorted({path.name for device in ("cpu","gpu") for path in (root/"runs"/device).glob("*")}))
    for device in ("cpu","gpu"):
      for mesh in meshes:
       for airbox in (("baseline","expanded") if mesh=="medium" and qualifying else ("baseline",)):
        for case in ("case-a","case-b"):
         path=root/"runs"/device/mesh/airbox/case/"artifacts"
         try:
          trace,meta=load_run(path); loaded[(device,mesh,airbox,case)]=trace
          failures += [f"{device}/{mesh}/{airbox}/{case}: {e}" for e in provenance_errors(meta,device)]
          if qualifying and trace.time_s[-1] < CONTRACT.minimum_duration_s: failures.append(f"{path}: trajectory shorter than 1 ns")
          key=f"{device}/{mesh}/{airbox}/{case}"
          if qualifying:
           crossing=find_first_zero_crossing(trace); envelope=reference_envelope_metrics(trace,refs[case],grid_s=trace.time_s[trace.time_s<=1e-9])
           metrics[key]={"crossing_s":crossing,"reference":envelope}
           if max(envelope["normalized_rms"])>1 or max(envelope["normalized_p99"])>3 or max(envelope["endpoint_error"])>0.05: failures.append(f"{key}: NIST trajectory gate failed")
          else:
           metrics[key]={"samples":len(trace.time_s),"final_time_s":float(trace.time_s[-1])}
          for replay in ("replay-before","replay-after"):
           if qualifying and not (root/"runs"/device/mesh/airbox/case/replay/"m_final.json").is_file(): failures.append(f"{key}: missing {replay} field")
         except Exception as exc: failures.append(f"{device}/{mesh}/{airbox}/{case}: {exc}")
    if qualifying:
      for case in ("case-a","case-b"):
       for mesh in ("coarse","medium","fine"):
        try:
         p=parity_metrics(loaded[("cpu",mesh,"baseline",case)],loaded[("gpu",mesh,"baseline",case)]); metrics[f"parity/{mesh}/{case}"]=p
         if max(p["trajectory_rmse"])>0.02 or p["crossing_delta_s"]>10e-12 or max(p["endpoint_delta"])>0.02: failures.append(f"parity/{mesh}/{case}: CPU/GPU gate failed")
        except Exception as exc: failures.append(f"parity/{mesh}/{case}: {exc}")
      for device in ("cpu","gpu"):
       for case in ("case-a","case-b"):
        try:
         convergence=parity_metrics(loaded[(device,"medium","baseline",case)],loaded[(device,"fine","baseline",case)]); metrics[f"convergence/{device}/{case}"]=convergence
         if max(convergence["trajectory_rmse"])>0.025 or convergence["crossing_delta_s"]>20e-12 or max(convergence["endpoint_delta"])>0.025: failures.append(f"convergence/{device}/{case}: mesh gate failed")
         airbox=parity_metrics(loaded[(device,"medium","baseline",case)],loaded[(device,"medium","expanded",case)]); metrics[f"airbox/{device}/{case}"]=airbox
         if max(airbox["trajectory_rmse"])>=0.02 or airbox["crossing_delta_s"]>=20e-12 or max(airbox["endpoint_delta"])>=0.02: failures.append(f"airbox/{device}/{case}: airbox gate failed")
        except Exception as exc: failures.append(f"convergence/{device}/{case}: {exc}")
    report={"schema":"fullmag.mumag.sp4.validation.v1","status":"passed" if not failures else "physics_failure","qualifying":qualifying,"failures":failures,"metrics":metrics}
    root.mkdir(parents=True,exist_ok=True); (root/"validation.json").write_text(json.dumps(report,indent=2)); (root/"metrics.json").write_text(json.dumps(metrics,indent=2)); (root/"report.md").write_text("# Fullmag FEM µMAG SP4 validation\n\nStatus: **"+report["status"]+"**\n\n"+"\n".join(f"- {x}" for x in failures)+"\n")
    return report


def main():
    parser=argparse.ArgumentParser(); parser.add_argument("root",type=Path); mode=parser.add_mutually_exclusive_group(required=True); mode.add_argument("--qualifying",action="store_true"); mode.add_argument("--smoke",action="store_true"); args=parser.parse_args()
    report=validate(args.root,args.qualifying); print(json.dumps(report,indent=2)); return 0 if report["status"]=="passed" else 1


if __name__=="__main__": sys.exit(main())
