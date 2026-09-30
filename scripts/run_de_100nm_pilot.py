#!/usr/bin/env python3
"""Execute a numerical DE pilot using a verified managed FEM build.

Execution receipts are deliberately unqualified: dispersion comparison and mesh/
airbox convergence are separate scientific gates. No analytic solver is invoked.
"""
from __future__ import annotations

import argparse
import json
import math
import re
from pathlib import Path
import sqlite3
import subprocess
import sys
import time

import run_comsol_dispersion_benchmark as managed
from validate_de_smoke_rows import validate_rows
from validate_de_physical_potential import validate_physical_potential, _extract_mesh
import de_smoke_model_input as model_input

MODEL = "examples/fem_de_film_100nm_numeric_pilot.py"
PILOTS = {
    "de100": (MODEL, None),
    "de-smoke-two": ("examples/fem_de_smoke_numeric.py", "two"),
    "de-smoke-k0": ("examples/fem_de_smoke_numeric.py", "k0"),
    "de-smoke-k2": ("examples/fem_de_smoke_numeric.py", "k2"),
    "de-smoke-k25": ("examples/fem_de_smoke_numeric.py", "k25"),
    "de-smoke-bv-k25": ("examples/fem_de_smoke_numeric.py", "bv-k25"),
    "de-smoke-positive-six": ("examples/fem_de_smoke_numeric.py", "positive-six"),
    "de-smoke-bv-positive-six": ("examples/fem_de_smoke_numeric.py", "bv-positive-six"),
    "de-smoke-five": ("examples/fem_de_smoke_numeric.py", "five"),
    "de-smoke-positive-26": ("examples/fem_de_smoke_numeric.py", "positive-26"),
    "de-smoke-bv-positive-26": ("examples/fem_de_smoke_numeric.py", "bv-positive-26"),
    "de-smoke-signed-eleven": ("examples/fem_de_smoke_numeric.py", "signed-eleven"),
}
for _geometry_prefix in ("", "bv-"):
    for _k_um in (*range(26), -25):
        _sampling = f"{_geometry_prefix}k{_k_um}"
        PILOTS.setdefault(f"de-smoke-{_sampling}", ("examples/fem_de_smoke_numeric.py", _sampling))
SOLVER_RTOL_CHOICES = ("1e-8", "1e-7", "1e-6")
EPS_PREFILTER_CHOICES = ("1e-8", "1e-9", "1e-10", "1e-11")
SHIFTED_KSP_RTOL_CHOICES = ("1e-8", "1e-9", "1e-10", "1e-11", "1e-12")
GMRES_RESTART_CHOICES = ("8", "10", "12", "16", "30")
MESH_LEVEL_CHOICES = ("L0", "L1", "L2", "L3")
THICKNESS_LAYERS_CHOICES = ("3", "6", "9")
MESH_LEVEL_ELEMENT_SIZES_M = {"L0": 10e-9, "L1": 7.5e-9, "L2": 5e-9, "L3": 3.75e-9}


def pilot_model(pilot):
    if pilot not in PILOTS:
        raise managed.BenchmarkError("unknown DE pilot")
    return PILOTS[pilot][0]


def validate_model(context, pilot="de100"):
    model = pilot_model(pilot)
    entries = [entry for entry in context.manifest["files"] if entry["path"] == model]
    if len(entries) != 1:
        raise managed.BenchmarkError("DE pilot is absent from this build capsule; build the committed pilot first")
    path = managed._contained_path(context.source_tree, model, "DE pilot")
    managed._regular_file(path, "DE pilot")
    digest = managed._sha256_file(path)
    if digest != entries[0]["sha256"]:
        raise managed.BenchmarkError("DE pilot differs from the verified build capsule")
    return digest


def compose_command(context, output, timeout_seconds=managed.DEFAULT_TIMEOUT_SECONDS, *, pilot="de100", external_model=False, dense_oracle=False, solver_rtol=None, eps_prefilter=None, shifted_ksp_rtol=None, gmres_restart=None, mesh_level=None, thickness_layers=None):
    model = pilot_model(pilot)
    if thickness_layers is not None and (
            not pilot.startswith("de-smoke-") or thickness_layers not in THICKNESS_LAYERS_CHOICES):
        raise managed.BenchmarkError("thickness layers require a supported DE-SMOKE value")
    if mesh_level is not None and (not pilot.startswith("de-smoke-") or mesh_level not in MESH_LEVEL_CHOICES):
        raise managed.BenchmarkError("mesh level requires a supported DE-SMOKE level")
    if external_model and pilot == "de100":
        raise managed.BenchmarkError("standalone input is supported only for DE-SMOKE")
    if dense_oracle and pilot != "de-smoke-k2":
        raise managed.BenchmarkError("dense oracle diagnostic is restricted to DE-SMOKE k2")
    if solver_rtol is not None and pilot != "de-smoke-k2":
        raise managed.BenchmarkError("solver rtol sweep is restricted to DE-SMOKE k2")
    if solver_rtol is not None and solver_rtol not in SOLVER_RTOL_CHOICES:
        raise managed.BenchmarkError("solver rtol sweep value is unsupported")
    if (eps_prefilter is not None or shifted_ksp_rtol is not None) and not pilot.startswith("de-smoke-"):
        raise managed.BenchmarkError("diagnostic EPS/KSP options are restricted to DE-SMOKE pilots")
    if gmres_restart is not None and not pilot.startswith("de-smoke-"):
        raise managed.BenchmarkError("diagnostic GMRES restart is restricted to DE-SMOKE pilots")
    if eps_prefilter is not None and eps_prefilter not in EPS_PREFILTER_CHOICES:
        raise managed.BenchmarkError("EPS prefilter value is unsupported")
    if shifted_ksp_rtol is not None and shifted_ksp_rtol not in SHIFTED_KSP_RTOL_CHOICES:
        raise managed.BenchmarkError("shifted KSP rtol value is unsupported")
    if gmres_restart is not None and gmres_restart not in GMRES_RESTART_CHOICES:
        raise managed.BenchmarkError("GMRES restart value is unsupported")
    command = managed._compose_command(context, output, ("c1",), timeout_seconds=timeout_seconds)
    if external_model:
        command[command.index("run")+1:command.index("run")+1] = [
            "-v", f"{output / 'model-input.py'}:/workspace/benchmark-model.py:ro"]
    command[-1] = "\n".join([
        "set -euo pipefail",
        "cd /workspace/capsule",
        "runtime_bin=/workspace/.fullmag/local/bin/fullmag-bin",
        ("source_script=/workspace/benchmark-model.py" if external_model
         else "source_script=/workspace/capsule/" + model),
        *(["export FULLMAG_GMSH_THREADS=1",
            "export FULLMAG_DE_SMOKE_SAMPLING=" + PILOTS[pilot][1]] if PILOTS[pilot][1] else []),
        *(["export FULLMAG_FLOQUET_DENSE_ORACLE=1"] if dense_oracle else []),
        *(["export FULLMAG_DE_SMOKE_SOLVER_RTOL=" + solver_rtol] if solver_rtol else []),
        *(["export FULLMAG_FLOQUET_EPS_PREFILTER_ABS=" + eps_prefilter] if eps_prefilter else []),
        *(["export FULLMAG_FLOQUET_SHIFTED_KSP_RTOL=" + shifted_ksp_rtol] if shifted_ksp_rtol else []),
        *(["export FULLMAG_FLOQUET_GMRES_RESTART=" + gmres_restart] if gmres_restart else []),
        *(["export FULLMAG_DE_SMOKE_MESH_LEVEL=" + mesh_level] if mesh_level else []),
        *(["export FULLMAG_DE_SMOKE_THICKNESS_LAYERS=" + thickness_layers] if thickness_layers else []),
        'test -x "$runtime_bin"',
        'test -f "$source_script"',
        "case_dir=/workspace/benchmark-output/" + pilot,
        'mkdir "$case_dir"',
        '"$runtime_bin" "$source_script" --backend fem --mode strict --precision double --headless --json --output-dir "$case_dir" >"$case_dir/runtime.log" 2>&1',
    ])
    return command


def validate_smoke_potential_fields(case_dir, expected_sample_count):
    """Check every published mode's potential gradient, without qualifying T4."""
    vectors = sorted(case_dir.glob("eigen/mode_fields/sample_*/mode_*/vector.bin"))
    if not vectors:
        raise managed.BenchmarkError("DE-SMOKE has no published mode fields")
    if isinstance(expected_sample_count, bool) or not isinstance(expected_sample_count, int) or expected_sample_count <= 0:
        raise managed.BenchmarkError("DE-SMOKE has no expected samples")
    samples = set()
    for vector in vectors:
        match = re.fullmatch(r"sample_([0-9]{4})", vector.parent.parent.name)
        if match is None:
            raise managed.BenchmarkError("DE-SMOKE mode field has invalid sample directory")
        samples.add(int(match.group(1)))
    if samples != set(range(expected_sample_count)):
        raise managed.BenchmarkError(
            f"DE-SMOKE mode fields cover samples {sorted(samples)}, expected {expected_sample_count}")
    metadata = case_dir / "metadata.json"
    managed._regular_file(metadata, "DE-SMOKE mesh metadata")
    reports = []
    for vector in vectors:
        manifest = vector.parent / "physical_potential.v1.json"
        managed._regular_file(manifest, "DE-SMOKE mode potential manifest")
        mode_metadata = case_dir / "eigen/modes" / vector.parent.parent.name / (vector.parent.name + ".json")
        managed._regular_file(mode_metadata, "DE-SMOKE published mode metadata")
        report = validate_physical_potential(manifest, metadata, mode_metadata_path=mode_metadata)
        if report.get("identity_binding", {}).get("status") != "consistent":
            raise managed.BenchmarkError("DE-SMOKE potential has no verified declared mode binding")
        if report.get("status") != "consistent" or report.get("reconstruction_agreement") is not True:
            raise managed.BenchmarkError(
                f"DE-SMOKE potential gradient mismatch: {manifest.relative_to(case_dir)}")
        reports.append({"manifest": manifest.relative_to(case_dir).as_posix(), **report})
    return {"qualification": "NOT VERIFIED", "scope": "stored_field_reconstruction_and_declared_mode_binding",
            "mode_count": len(reports), "modes": reports}


def validate_mesh_level_metadata(case_dir, requested):
    """Verify authoring resolution; actual mesh convergence remains separate."""
    try:
        metadata = json.loads((case_dir / "metadata.json").read_text(encoding="utf-8"))
        runtime = metadata["problem_meta"]["runtime_metadata"]
        model = runtime["de_smoke"]
        requested_size = MESH_LEVEL_ELEMENT_SIZES_M[requested]
        meshes = runtime["mesh_workflow"]["per_geometry"]
        matches = (model.get("mesh_level") == requested and
                   model.get("magnetic_element_size_m") == requested_size and
                   isinstance(meshes, list) and len(meshes) == 1 and
                   meshes[0].get("hmax") == requested_size)
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        raise managed.BenchmarkError("missing or malformed magnetic mesh metadata") from error
    if not matches:
        raise managed.BenchmarkError("model ignored or changed the requested magnetic mesh level")
    return {"requested_level": requested, "resolved_level": model["mesh_level"],
            "requested_element_size_m": requested_size,
            "scope": "requested_magnetic_interface_mesh_settings",
            "qualification": "NOT VERIFIED"}



def validate_thickness_layers_metadata(case, requested):
    """Reject a model that ignored an explicit through-thickness request."""
    if requested not in THICKNESS_LAYERS_CHOICES:
        raise managed.BenchmarkError("unsupported thickness layers")
    try:
        metadata = json.loads((case / "metadata.json").read_text(encoding="utf-8"))
        runtime = metadata["problem_meta"]["runtime_metadata"]
        declared = runtime["de_smoke"]["through_thickness_elements"]
        geometries = runtime["mesh_workflow"]["per_geometry"]
        actual = geometries[0]["through_thickness_elements"] if len(geometries) == 1 else None
        matches = (type(declared) is int and type(actual) is int
                   and declared == actual == int(requested))
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        raise managed.BenchmarkError("missing or malformed thickness mesh metadata") from error
    if not matches:
        raise managed.BenchmarkError("model ignored or changed the requested thickness layers")
    thickness = runtime["de_smoke"].get("film_thickness_m")
    if type(thickness) not in (int, float) or not math.isfinite(thickness) or thickness <= 0:
        raise managed.BenchmarkError("missing physical film thickness")
    nodes, elements = _extract_mesh(metadata)
    tolerance = thickness * 1e-6
    slab = [tuple(nodes[i][2] for i in cell) for cell in elements
            if all(abs(nodes[i][2]) <= thickness / 2 + tolerance for i in cell)]
    if not slab:
        raise managed.BenchmarkError("no realized magnetic-film tetrahedra")
    low = min(min(z) for z in slab)
    high = max(max(z) for z in slab)
    maximum_span = max(max(z) - min(z) for z in slab)
    if (abs(high - low - thickness) > tolerance or maximum_span <= 0
            or maximum_span > thickness / int(requested) + tolerance):
        raise managed.BenchmarkError(
            "realized tetra mesh does not meet requested thickness resolution: "
            f"max vertical span {maximum_span:g} m, target {thickness / int(requested):g} m")
    return {"requested_layers": int(requested), "declared_layers": actual,
            "maximum_vertical_element_span_m": maximum_span,
            "maximum_requested_vertical_span_m": thickness / int(requested),
            "thickness_resolution_verified": True,
            "scope": "uniform-film tetra vertical-span bound; not an exact extrusion layer count",
            "qualification": "NOT VERIFIED"}


def execute(context, output, command, model_sha, timeout_seconds=managed.DEFAULT_TIMEOUT_SECONDS, *, pilot="de100", model_identity=None, dense_oracle=False, solver_rtol=None, eps_prefilter=None, shifted_ksp_rtol=None, gmres_restart=None, mesh_level=None, thickness_layers=None):
    model = pilot_model(pilot)
    schema_name = "de100-pilot" if pilot == "de100" else "de-smoke"
    request = managed._run_request(context, output, (), command, timeout_seconds=timeout_seconds)
    request.update(schema=f"fullmag.{schema_name}.request.v1", operation=pilot + "-numerical-pilot",
                   public_model=model, cases=[pilot], sampling=PILOTS[pilot][1], model_sha256=model_sha,
                   orchestrator_sha256=managed._sha256_file(Path(__file__).resolve()))
    request["dense_oracle_diagnostic_requested"] = dense_oracle
    request["solver_rtol_sweep_requested"] = solver_rtol
    request["eps_prefilter_diagnostic_requested"] = eps_prefilter
    request["shifted_ksp_rtol_diagnostic_requested"] = shifted_ksp_rtol
    request["gmres_restart_diagnostic_requested"] = gmres_restart
    request["mesh_level_requested"] = mesh_level
    request["thickness_layers_requested"] = thickness_layers
    request["source"]["public_model_files"] = [*managed.PUBLIC_MODEL_FILES] if model_identity else [model, *managed.PUBLIC_MODEL_FILES]
    if model_identity:
        request["model_source"] = model_identity
    request["scientific_gate"] = {"qualification": "NOT VERIFIED", "reason": "postsolve comparison and convergence required"}
    managed._write_new_json(output / "run-request.json", request)
    result = {"schema": f"fullmag.{schema_name}.result.v1", "pilot": pilot, "status": "failed",
              "qualification": "NOT VERIFIED", "started_at_unix": time.time(),
              "job": request["job"], "source": request["source"], "runtime": request["runtime"],
              "model_sha256": model_sha, "return_code": None, "artifacts": None,
              "container_cleanup": {"status": "not_requested"}}
    try:
        if model_identity:
            model_input.verify_model(output, model_identity)
        with (output / "compose.log").open("x", encoding="utf-8") as log:
            completed = subprocess.run(command, cwd=context.layout["repo_root"],
                                       env=managed._compose_environment(
                                           context.layout, context.image_digest
                                       ),
                                       stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                       check=False, timeout=math.ceil(timeout_seconds)
                                       + managed.CONTAINER_TIMEOUT_GRACE_SECONDS
                                       + managed.HOST_COMPOSE_GRACE_SECONDS)
        result["return_code"] = completed.returncode
        if completed.returncode == 0:
            # C1 artifact requirements include complex modes and full potential.
            # This reuses the artifact contract only, not C1 scientific parameters.
            artifacts = managed._validate_case_artifacts(output / pilot, "c1")
            artifacts["case"] = pilot
            if PILOTS[pilot][1] is not None:
                artifacts["row_preflight"] = validate_rows(
                    output / pilot / "eigen/dispersion.csv",
                    PILOTS[pilot][1],
                    output / pilot / "eigen/diagnostics/solver.v1.json",
                    output / pilot / "metadata.json")
                artifacts["potential_reconstruction"] = validate_smoke_potential_fields(
                    output / pilot, artifacts["row_preflight"]["sample_count"])
            if mesh_level is not None:
                artifacts["mesh_level_resolution"] = validate_mesh_level_metadata(output / pilot, mesh_level)
            if thickness_layers is not None:
                artifacts["thickness_layers_resolution"] = validate_thickness_layers_metadata(output / pilot, thickness_layers)
            result.update(status="completed_unqualified", artifacts=artifacts)
    except subprocess.TimeoutExpired:
        result["error"] = "host Compose watchdog expired after the container deadline and grace period"
    except KeyboardInterrupt:
        result["error"] = "pilot interrupted by operator"
    except (OSError, ValueError, managed.BenchmarkError) as error:
        result["error"] = str(error)
    finally:
        if model_identity:
            result["model_source"] = model_identity
            try:
                model_input.verify_model(output, model_identity)
            except (OSError, ValueError) as error:
                result.update(status="failed", error=str(error))
        if result["return_code"] != 0:
            try:
                result["container_cleanup"] = managed._cleanup_benchmark_container(context, output)
            except (managed.BenchmarkError, OSError, ValueError, TypeError, KeyboardInterrupt) as error:
                result["container_cleanup"] = {"status": "blocked", "reason": str(error)}
        result["finished_at_unix"] = time.time()
        managed._write_new_json(output / "run-result.json", result)
    print(json.dumps({"output_dir": str(output), **result}, indent=2))
    return 0 if result["status"] == "completed_unqualified" else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--output-dir")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--pilot", choices=tuple(PILOTS), default="de100")
    parser.add_argument("--mesh-level", choices=MESH_LEVEL_CHOICES,
                        help="explicit magnetic/interface mesh level for a standalone DE-SMOKE input")
    parser.add_argument("--thickness-layers", choices=THICKNESS_LAYERS_CHOICES,
                        help="explicit number of elements through the film thickness")
    parser.add_argument("--model-ref", help="full commit of standalone DE-SMOKE input; runtime remains build-bound")
    parser.add_argument("--dense-oracle", action="store_true", help="run the bounded diagnostic dense Schur oracle for DE-SMOKE k2")
    parser.add_argument("--solver-rtol", choices=SOLVER_RTOL_CHOICES,
                        help="request a diagnostic DE-SMOKE k2 tolerance; default model uses 1e-8")
    parser.add_argument("--eps-prefilter", choices=EPS_PREFILTER_CHOICES,
                        help="diagnostic EPS absolute true-residual cutoff for DE-SMOKE pilots")
    parser.add_argument("--shifted-ksp-rtol", choices=SHIFTED_KSP_RTOL_CHOICES,
                        help="diagnostic shift-invert KSP rtol for DE-SMOKE pilots")
    parser.add_argument("--gmres-restart", choices=GMRES_RESTART_CHOICES,
                        help="diagnostic shift-invert GMRES restart for DE-SMOKE pilots")
    args = parser.parse_args(argv)
    try:
        layout = managed.fullmag_storage.resolve_layout(args.repo_root, "windows-native")
        input_data = None
        input_identity = None
        if (args.mesh_level or args.thickness_layers) and not args.model_ref:
            raise ValueError("mesh controls require a versioned standalone --model-ref")
        if args.model_ref:
            if args.pilot == "de100":
                raise ValueError("--model-ref requires a DE-SMOKE pilot")
            input_data, input_identity = model_input.load_model(Path(layout["repo_root"]), args.model_ref)
        if not args.dry_run:
            managed.fullmag_storage.initialize(layout)
        if args.dry_run:
            context = managed._validate_build_context(layout, managed._read_job(layout, args.job_id))
            model_sha = input_identity["sha256"] if input_identity else validate_model(context, args.pilot)
            output = Path(layout["storage_root"]) / "runs" / layout["worktree_id"] / args.job_id / (args.pilot + "-preview")
            print(json.dumps({"status": "dry_run", "qualification": "NOT VERIFIED",
                              "model_sha256": model_sha, "model_source": input_identity,
                              "command": compose_command(context, output, pilot=args.pilot, external_model=input_identity is not None, dense_oracle=args.dense_oracle, solver_rtol=args.solver_rtol, eps_prefilter=args.eps_prefilter, shifted_ksp_rtol=args.shifted_ksp_rtol, gmres_restart=args.gmres_restart, mesh_level=args.mesh_level, thickness_layers=args.thickness_layers)}, indent=2))
            return 0
        with managed.fullmag_storage.build_lock(layout):
            context = managed._validate_build_context(layout, managed._read_job(layout, args.job_id))
            model_sha = input_identity["sha256"] if input_identity else validate_model(context, args.pilot)
            managed._inspect_image(context.image_digest)
            output = managed._new_output_dir(context, args.output_dir)
            output.mkdir(parents=True, exist_ok=False)
            if input_data is not None:
                model_input.stage_model(output, input_data)
            return execute(context, output, compose_command(context, output, pilot=args.pilot, external_model=input_identity is not None, dense_oracle=args.dense_oracle, solver_rtol=args.solver_rtol, eps_prefilter=args.eps_prefilter, shifted_ksp_rtol=args.shifted_ksp_rtol, gmres_restart=args.gmres_restart, mesh_level=args.mesh_level, thickness_layers=args.thickness_layers), model_sha, pilot=args.pilot, model_identity=input_identity, dense_oracle=args.dense_oracle, solver_rtol=args.solver_rtol, eps_prefilter=args.eps_prefilter, shifted_ksp_rtol=args.shifted_ksp_rtol, gmres_restart=args.gmres_restart, mesh_level=args.mesh_level, thickness_layers=args.thickness_layers)
    except (managed.BenchmarkError, managed.fullmag_storage.StorageError, OSError, ValueError, sqlite3.Error, subprocess.SubprocessError, SyntaxError) as error:
        print(f"de100-pilot: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
