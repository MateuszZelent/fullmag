"""Compare one verified RAM inspection export with V/H and RT0 fixture checks.

Read-only scientific support, not a solver, canonical bundle decoder, complete
input-pin reimplementation, or qualification of reusable LLG/FFT drive fields.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys

import run_managed_antenna_ram as launcher
from antenna_current_source_oracle import (
    FIXTURE_INPUT_SHA256, compare_fixture, fixture_input_digest,
)
from antenna_inspection_export import RECORD, parse, read_inspection
from antenna_rt0_fixture_check import compare_rt0_fixture, compare_bundle_observables

TOLERANCES = {"voltage_tolerance_v": 1e-8, "field_absolute_tolerance_apm": 1e-8,
              "field_relative_tolerance": 1e-6}


def reconstruct_inputs(source_tree, script):
    """Reconstruct the pinned input using the executed capsule's public DSL.

    This is a host reconstruction, not a claimed dump of the executed native IR.
    Isolated import prevents the calling worktree/site user paths from supplying
    another Fullmag module. No stages or native solvers are executed here.
    """
    code = '''
import contextlib, io, json, sys
from pathlib import Path
source = Path(sys.argv[1]).resolve()
script = Path(sys.argv[2]).resolve()
sys.path.insert(0, str(source))
import fullmag
if Path(fullmag.__file__).resolve() != source / "fullmag/__init__.py":
    raise ValueError("Fullmag did not import from the executed source capsule")
from fullmag.runtime.loader import load_problem_from_script
with contextlib.redirect_stdout(io.StringIO()):
    loaded = load_problem_from_script(script, lightweight_assets=True)
    if [n["stage_kind"] for n in loaded.study_pipeline_document()["nodes"]] != ["antenna_field_solve"]:
        raise ValueError("Expected exactly one antenna solve, without Relax or Run")
    ir = loaded.problem.to_ir(source_root=script.parent)
assets = {a["geometry_name"]: a["mesh"] for a in ir["geometry_assets"]["fem_mesh_assets"]}
if set(assets) != {"antenna", "probe_geom"} or len(ir["current_modules"]) != 1 or len(ir["antenna_port_modes"]) != 1:
    raise ValueError("Fixed-fixture input cardinality differs")
print(json.dumps({"device_mesh": assets["antenna"], "probe_mesh": assets["probe_geom"],
    "current_definition": ir["current_modules"][0], "port_mode": ir["antenna_port_modes"][0]}, allow_nan=False))
'''
    process = subprocess.run([sys.executable, "-I", "-B", "-c", code,
        str(Path(source_tree) / "packages/fullmag-py/src"), str(script)],
        capture_output=True, timeout=60)
    if process.returncode or len(process.stdout) > 1 << 20:
        raise ValueError("Failed isolated input reconstruction: " +
                         process.stderr.decode("utf-8", errors="replace"))
    return parse(process.stdout)


def compare(repo, root):
    layout = launcher.storage.resolve_layout(repo, launcher.PROFILE)
    root = launcher.storage.validate_path(root, Path(layout["build_root"]) / "runs")
    observed = launcher.observe(repo, root)
    if observed["state"] != "solver_succeeded_comparison_pending":
        raise ValueError("Comparison requires a successful terminal RAM solve")
    receipt = launcher.read_json(root / "receipt.json")
    native = receipt["native_source_identity"]
    _, _, _, _, capsule, _ = launcher.resolved_build(repo, receipt["managed_job_id"],
        native["head_commit_full"], receipt["source_digest"], native["source_snapshot_sha256"])
    inputs = reconstruct_inputs(capsule / "tree", root / "input/fem_antenna_current_source_inspection.py")
    artifact_root = root / "export/result.zarr/artifacts"
    stage = artifact_root / "antenna/external_lead_stage_outputs/stage-000" / RECORD
    values = read_inspection(artifact_root, stage)
    rt0 = compare_rt0_fixture(inputs, values["bundle_bytes"])
    association = compare_bundle_observables(inputs, values)
    measured = compare_fixture(inputs, values["device_ids"], values["potential_v"],
        values["positions_m"], values["field_apm"], **TOLERANCES)
    return {"schema": "fullmag.antenna-ram-V-H-comparison.v1", "comparison": "PASS",
        "opis": "Porównanie V/H i geometrycznych momentów RT0 jednego przypiętego modelu; wejście odtworzone z dokładnego skryptu i Python DSL kapsuły. Wagi DOF są zachowane z native, nie certyfikowane niezależnie. Nie jest to dump wykonanego IR ani pełna kwalifikacja fizyki.",
        "run_root": str(root), "managed_job_id": receipt["managed_job_id"],
        "native_source_identity": native, "source_digest": receipt["source_digest"],
        "build_receipt_sha256": receipt["build_receipt_sha256"],
        "solver_log_sha256": receipt["solver_log_sha256"],
        "input_reconstruction": "pinned_script_with_executed_capsule_DSL",
        "tolerances": dict(TOLERANCES), "oracle": measured, "rt0_fixture": rt0,
        "bundle_observable_association": association,
        **{key: values[key] for key in ("manifest_content_digest", "manifest_sha256",
            "record_sha256", "bundle_sha256", "device_ids", "potential_v", "positions_m", "field_apm")},
        "native_input_pins_recomputed": False, "native_canonical_bundle_redecoded": False,
        "physics_qualified": False, "durable_session_storage_qualified": False,
        "reuse_LLG_FFT_qualified": False, "qualification": "NOT VERIFIED"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", required=True, type=Path)
    parser.add_argument("--run-root", required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(compare(args.repo_root, args.run_root), ensure_ascii=False, allow_nan=False))
