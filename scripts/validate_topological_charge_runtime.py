#!/usr/bin/env python3
"""Fail-closed validator for planar topological-charge runtime evidence."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any, Iterable


SCHEMA_VERSION = "topological_charge_runtime.v2"
METHOD = "berg_luescher_oriented_triangles_v2"
FRAME = {"u_axis": [1, 0, 0], "v_axis": [0, 1, 0], "normal_axis": [0, 0, 1]}
TRUST_VALUES = {
    "qualified",
    "diagnostic_boundary",
    "diagnostic_resolution",
    "diagnostic_topology",
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def object_value(value: Any, label: str) -> dict[str, Any]:
    require(isinstance(value, dict), f"{label} must be an object")
    return value


def execution(value: Any, label: str, backend: str) -> None:
    value = object_value(value, label)
    actual_backend = value.get("backend")
    require(
        isinstance(actual_backend, str) and backend in actual_backend.lower(),
        f"{label}.backend must identify {backend!r}",
    )
    require(value.get("device") in {"cpu", "gpu"}, f"{label}.device must be cpu or gpu")
    require(value.get("precision") == "double", f"{label}.precision must be double")


def validate_run(run: Any, scenario: str) -> dict[str, Any]:
    run = object_value(run, "run")
    require(isinstance(run.get("object_id"), str) and run["object_id"], "run.object_id is required")
    charge = run.get("charge")
    require(isinstance(charge, (int, float)) and math.isfinite(float(charge)), "run.charge must be finite")
    require(run.get("trust") in TRUST_VALUES, "run.trust is not a scientific trust state")
    require(run.get("support_frame") == FRAME, "run.support_frame must use canonical xy orientation")
    provenance = object_value(run.get("provenance"), "run.provenance")
    backend = provenance.get("discretization")
    require(backend in {"fdm", "fem"}, "run.provenance.discretization must be fdm or fem")
    execution(provenance.get("requested_execution"), "requested_execution", backend)
    execution(provenance.get("resolved_execution"), "resolved_execution", backend)
    require(
        provenance["resolved_execution"].get("lossy_fallback_used") is False,
        "resolved_execution must record lossy_fallback_used=false; fallback is forbidden",
    )
    if scenario == "fdm":
        require(backend == "fdm", "fdm evidence must contain only FDM runs")
    if scenario == "fem_p1":
        require(backend == "fem", "fem_p1 evidence must contain only FEM runs")
        require(provenance.get("fe_order") == 1, "FEM evidence requires fe_order=1")
    return run


def validate_evidence(payload: Any) -> None:
    payload = object_value(payload, "evidence")
    require(payload.get("schema_version") == SCHEMA_VERSION, "unexpected evidence schema_version")
    require(payload.get("method") == METHOD, "unexpected topological-charge method")
    scenario = payload.get("scenario")
    require(scenario in {"fdm", "fem_p1", "cross_backend"}, "unknown runtime evidence scenario")
    runs = payload.get("runs")
    require(isinstance(runs, list) and runs, "evidence must contain at least one run")
    validated = [validate_run(run, scenario) for run in runs]
    if scenario != "cross_backend":
        return
    by_backend = {run["provenance"]["discretization"]: run for run in validated}
    require(set(by_backend) == {"fdm", "fem"}, "cross-backend evidence requires one FDM and one FEM run")
    fdm, fem = by_backend["fdm"], by_backend["fem"]
    require(fem["provenance"].get("fe_order") == 1, "cross-backend FEM run requires fe_order=1")
    require(fdm["trust"] == fem["trust"], "cross-backend trust states must agree")
    require(
        abs(float(fdm["charge"]) - float(fem["charge"])) < 0.05,
        "cross-backend charge difference must be < 0.05",
    )
    require(float(fdm["charge"]) * float(fem["charge"]) >= 0.0, "cross-backend charges must have the same sign")


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("evidence", type=Path)
    args = parser.parse_args(list(argv) if argv is not None else None)
    try:
        validate_evidence(json.loads(args.evidence.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(f"FAIL: {error}")
        return 1
    print(json.dumps({"status": "pass", "schema_version": SCHEMA_VERSION}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
