"""Real API regression for numeric scene stages and legacy draft readers."""
from __future__ import annotations

import copy
import hashlib
from pathlib import Path
import urllib.error


def exercise(get, checks, receipt, run_root):
    source_path = Path(__file__).resolve()
    observer = source_path.read_bytes()
    observer_sha256 = hashlib.sha256(observer).hexdigest()
    snapshot = Path(run_root) / "scene-stage-authoring-observer.py"
    snapshot.write_bytes(observer)
    receipt["scene_stage_authoring_observer"] = {
        "source_path": str(source_path), "snapshot_path": str(snapshot),
        "source_sha256": observer_sha256,
    }
    code, _, session = get("/v2/sessions", method="POST", payload={
        "name": "Numeric stage authoring regression", "backend": "fdm",
        "device": "cpu", "precision": "double",
    })
    assert code == 201 and session["session_id"]
    _, _, initial = get("/v2/sessions/current/model/scene")
    stages = [
        {"kind": "run", "entrypoint_kind": "flat_run", "stage_id": "numeric-run",
         "until_seconds": 2e-12, "future_metadata": {"retained": [1, "two"]}},
        {"kind": "relax", "entrypoint_kind": "flat_relax", "stage_id": "numeric-relax",
         "algorithm": "llg_overdamped", "max_steps": 7, "fixed_timestep": 1e-13,
         "torque_tolerance_apm": 100, "energy_tolerance_j": 1e-20,
         "torque_tolerance": 1e-4, "energy_tolerance": 1e-20},
        {"kind": "relax", "entrypoint_kind": "flat_relax", "stage_id": "numeric-adaptive",
         "algorithm": "llg_overdamped", "integrator": "rk45", "max_steps": 7,
         "torque_tolerance_apm": 100,
         "adaptive_timestep": {"tolerance_mode": "max_error", "atol": 1e-6,
                               "rtol": 0, "dt_initial": 1e-13,
                               "dt_min": 1e-15, "dt_max": 1e-12}},
    ]

    def submit(value, revision):
        return get("/v2/sessions/current/model/transactions", method="POST", payload={
            "kind": "merge_patch", "base_revision": revision,
            "merge_patch": {"study": {"stages": value}},
        }, timeout=15)

    code, _, _ = submit(stages, initial["revision"])
    assert code == 200
    _, _, numeric = get("/v2/sessions/current/model/scene")
    assert numeric["revision"] == initial["revision"] + 1
    written = numeric["study"]["stages"]
    assert type(written[0]["until_seconds"]) is float and written[0]["until_seconds"] == 2e-12
    assert type(written[1]["max_steps"]) is int and written[1]["max_steps"] == 7
    assert type(written[1]["fixed_timestep"]) is float and written[1]["fixed_timestep"] == 1e-13
    assert written[0]["future_metadata"] == stages[0]["future_metadata"]
    assert written[1]["torque_tolerance_apm"] == 100
    assert type(written[1]["torque_tolerance"]) is float
    assert written[1]["torque_tolerance"] == 1e-4
    assert type(written[1]["energy_tolerance"]) is float
    assert written[1]["energy_tolerance"] == 1e-20
    for field, value in stages[2]["adaptive_timestep"].items():
        assert written[2]["adaptive_timestep"][field] == value
        if field != "tolerance_mode":
            assert isinstance(written[2]["adaptive_timestep"][field], (int, float))
    checks.append("scene-stage-numeric-run-relax-roundtrip-and-extra-preservation")

    legacy = copy.deepcopy(stages)
    legacy[0]["until_seconds"] = "2e-12"
    legacy[1]["max_steps"] = "7"
    legacy[1]["fixed_timestep"] = "1e-13"
    legacy[1]["torque_tolerance"] = "1e-4"
    legacy[1]["energy_tolerance"] = "1e-20"
    legacy[2]["max_steps"] = "7"
    for field in ("atol", "rtol", "dt_initial", "dt_min", "dt_max"):
        legacy[2]["adaptive_timestep"][field] = str(legacy[2]["adaptive_timestep"][field])
    code, _, _ = submit(legacy, numeric["revision"])
    assert code == 200
    _, _, normalized = get("/v2/sessions/current/model/scene")
    assert normalized["study"]["stages"] == written
    checks.append("scene-stage-legacy-text-reader-canonical-numeric-writer")

    for field, value in (("until_seconds", True), ("until_seconds", {}),
                         ("until_seconds", []), ("until_seconds", None),
                         ("max_steps", 1.5), ("max_steps", -1),
                         ("max_steps", 2 ** 64)):
        invalid = copy.deepcopy(stages)
        invalid[0 if field == "until_seconds" else 1][field] = value
        try:
            submit(invalid, normalized["revision"])
        except urllib.error.HTTPError as error:
            assert error.code == 400, (field, value, error.code, error.read(4096))
        else:
            raise AssertionError(f"Invalid scene stage scalar was accepted: {field}={value!r}")
        _, _, unchanged = get("/v2/sessions/current/model/scene")
        assert unchanged == normalized
    checks.append("scene-stage-invalid-scalar-types-and-step-budgets-rejected-without-mutation")
    receipt["scene_stage_authoring_observation"] = {
        "session_id": session["session_id"], "revision": normalized["revision"],
        "stages": normalized["study"]["stages"],
        "scope": "actual authoring transaction and scene read; no solver execution",
    }
    assert hashlib.sha256(source_path.read_bytes()).hexdigest() == observer_sha256
    checks.append("scene-stage-observer-source-unchanged")
