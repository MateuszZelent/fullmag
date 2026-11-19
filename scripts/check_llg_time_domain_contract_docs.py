#!/usr/bin/env python3
"""Check stable cross-document identifiers for the canonical LLG time contract."""

import contextlib
import io
import json
import math
from pathlib import Path
import re
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]
POLICY = "LLG-TD-POLICY-V1"
ATTEMPT = "LLG-TD-ATTEMPT-V1"
STIFF = "LLG-TD-STIFF-V1"
FIRST_DT = "LLG-TD-FIRST-DT-V1"
MAX_ERR = "LLG-TD-MAX-ERR-V1"
ATOMIC = "LLG-TD-ATOMIC-V1"

REQUIRED = {
    "docs/physics/0960-canonical-llg-time-domain-solver-and-qualification-contract.md": (
        POLICY,
        ATTEMPT,
        STIFF,
        FIRST_DT,
        MAX_ERR,
        ATOMIC,
        "fix_dt",
        "dt_min_exhausted",
        "solver_attempts.csv",
    ),
    "docs/physics/0480-fdm-higher-order-and-adaptive-time-integrators.md": (
        POLICY,
        ATTEMPT,
        FIRST_DT,
        MAX_ERR,
        ATOMIC,
    ),
    "docs/physics/0490-fem-higher-order-and-adaptive-time-integrators-mfem-gpu.md": (
        POLICY,
        ATTEMPT,
        STIFF,
        FIRST_DT,
        MAX_ERR,
        ATOMIC,
    ),
    "docs/physics/llg_conventions.md": (
        POLICY,
        ATTEMPT,
        STIFF,
        FIRST_DT,
        MAX_ERR,
        ATOMIC,
    ),
    "docs/physics/0910-table-autosave-observables.md": (ATTEMPT,),
    "docs/architecture/backend-golden-masterplan.md": (
        POLICY,
        ATTEMPT,
        STIFF,
        ATOMIC,
        "fullmag.fem_gpu_execution_receipt.native_projection.v1",
        "FemGpuExecutionReceipt.v1",
        "accounting_valid",
    ),
    "docs/specs/capability-matrix-v0.md": (
        POLICY,
        ATTEMPT,
        STIFF,
        FIRST_DT,
        MAX_ERR,
        ATOMIC,
        "LLG explicit fixed",
        "LLG explicit adaptive",
        "LLG stiff time-domain",
        "fullmag.fem_gpu_execution_receipt.native_projection.v1",
        "FemGpuExecutionReceipt.v1",
        "accounting_valid",
    ),
}

NATIVE_FEM_PAGE = ROOT / "docs/physics/0900-native-fem-operator-contracts-and-validation.md"
NATIVE_FEM_SOURCE_MAP = NATIVE_FEM_PAGE.with_suffix(".source-map.json")
CAPABILITY_MATRIX = ROOT / "docs/specs/capability-matrix-v0.json"
TERMINAL_LABELS = {
    "problem-statement",
    "governing-equations",
    "symbols-and-si-units",
    "assumptions-and-validity",
    "python-api",
    "problem-ir",
    "round-trip-and-failure-semantics",
    "discrete-realization",
    "implementation-mapping",
    "validation",
    "limitations",
    "scientific-bibliography",
    "source-code-index",
}
EXAMPLE_PARAMETERS = {
    "fm.study.problem_name",
    "StudyBuilder.engine.backend",
    "StudyBuilder.device.spec",
    "StudyBuilder.device.precision",
    "StudyBuilder.mode.execution_mode",
    "StudyUniverseHandle.mode",
    "StudyUniverseHandle.size",
    "StudyUniverseHandle.mesh.maximum_element_size",
    "Box.size",
    "Box.name",
    "StudyBuilder.geometry.shape",
    "StudyBuilder.geometry.name",
    "MagnetHandle.Ms",
    "MagnetHandle.Aex",
    "MagnetHandle.alpha",
    "MagnetHandle.m",
    "UniformMagnetization.value",
    "GeometryMeshHandle.maximum_element_size",
    "GeometryMeshHandle.order",
    "StudyBuilder.exchange.enabled",
    "StudyBuilder.demag.realization",
    "StudyBuilder.fem_demag_solver.solver",
    "StudyBuilder.fem_demag_solver.preconditioner",
    "StudyBuilder.fem_demag_solver.rtol",
    "StudyBuilder.fem_demag_solver.max_iterations",
    "StudyBuilder.solver.integrator",
    "StudyBuilder.solver.dt_initial",
    "StudyBuilder.solver.dt_min",
    "StudyBuilder.solver.dt_max",
    "StudyBuilder.solver.max_err",
    "StudyBuilder.solver.g",
    "StudyStagesBuilder.add_run.until",
}
PARAMETER_FIELDS = {
    "python",
    "type",
    "default",
    "si_unit",
    "validation",
    "meaning",
    "backend_support",
    "problem_ir",
}

LOWERING_CONTRACT = {
    "fm.study.problem_name": (
        "problem_meta.name",
        "fem_gpu_receipt_contract",
    ),
    "StudyBuilder.engine.backend": (
        "backend_policy.requested_backend",
        "fem",
    ),
    "StudyBuilder.device.spec": (
        "problem_meta.runtime_metadata.runtime_selection.device (normalized requested runtime metadata)",
        "cuda",
    ),
    "StudyBuilder.device.precision": (
        "backend_policy.execution_precision",
        "double",
    ),
    "StudyBuilder.mode.execution_mode": (
        "validation_profile.execution_mode",
        "strict",
    ),
    "StudyUniverseHandle.mode": (
        "problem_meta.runtime_metadata.study_universe.mode (authoring metadata)",
        "manual",
    ),
    "StudyUniverseHandle.size": (
        "problem_meta.runtime_metadata.study_universe.size (authoring metadata)",
        [160e-9, 120e-9, 120e-9],
    ),
    "StudyUniverseHandle.mesh.maximum_element_size": (
        "problem_meta.runtime_metadata.study_universe.airbox_hmax (authoring metadata)",
        20e-9,
    ),
    "Box.size": ("geometry.entries[0].size", [80e-9, 40e-9, 8e-9]),
    "Box.name": (
        "geometry.entries[0].name (normalized to film_geom; Box.name is not preserved independently)",
        "film_geom",
    ),
    "StudyBuilder.geometry.shape": (
        "geometry.entries[0]",
        {"name": "film_geom", "kind": "box", "size": [80e-9, 40e-9, 8e-9]},
    ),
    "StudyBuilder.geometry.name": ("magnets[0].name", "film"),
    "MagnetHandle.Ms": ("materials[0].saturation_magnetisation", 8.0e5),
    "MagnetHandle.Aex": ("materials[0].exchange_stiffness", 1.3e-11),
    "MagnetHandle.alpha": ("materials[0].damping", 0.02),
    "MagnetHandle.m": (
        "magnets[0].initial_magnetization",
        {"kind": "uniform", "value": [1.0, 0.1, 0.0]},
    ),
    "UniformMagnetization.value": (
        "magnets[0].initial_magnetization.value",
        [1.0, 0.1, 0.0],
    ),
    "GeometryMeshHandle.maximum_element_size": (
        "problem_meta.runtime_metadata.mesh_workflow.per_geometry[0].maximum_element_size (authoring metadata)",
        8e-9,
    ),
    "GeometryMeshHandle.order": (
        "problem_meta.runtime_metadata.mesh_workflow.per_geometry[0].order (authoring metadata)",
        1,
    ),
    "StudyBuilder.exchange.enabled": (
        "energy_terms[kind=exchange] presence/absence (no enabled field)",
        True,
    ),
    "StudyBuilder.demag.realization": (
        "energy_terms[kind=demag].realization",
        "poisson_robin",
    ),
    "StudyBuilder.fem_demag_solver.solver": (
        "backend_policy.discretization_hints.fem.demag_solver_policy.solver",
        "CG",
    ),
    "StudyBuilder.fem_demag_solver.preconditioner": (
        "backend_policy.discretization_hints.fem.demag_solver_policy.preconditioner",
        "AMG",
    ),
    "StudyBuilder.fem_demag_solver.rtol": (
        "backend_policy.discretization_hints.fem.demag_solver_policy.rtol",
        1e-12,
    ),
    "StudyBuilder.fem_demag_solver.max_iterations": (
        "backend_policy.discretization_hints.fem.demag_solver_policy.max_iterations",
        500,
    ),
    "StudyBuilder.solver.integrator": ("study.dynamics.integrator", "rk45"),
    "StudyBuilder.solver.dt_initial": (
        "study.dynamics.adaptive_timestep.dt_initial",
        1e-15,
    ),
    "StudyBuilder.solver.dt_min": (
        "study.dynamics.adaptive_timestep.dt_min",
        1e-16,
    ),
    "StudyBuilder.solver.dt_max": (
        "study.dynamics.adaptive_timestep.dt_max",
        1e-14,
    ),
    "StudyBuilder.solver.max_err": (
        "study.dynamics.adaptive_timestep.atol",
        1e-6,
    ),
    "StudyBuilder.solver.g": (
        "study.dynamics.gyromagnetic_ratio (normalized from g; g is not stored)",
        233728.4819918909,
    ),
    "StudyStagesBuilder.add_run.until": (
        "canonical stage exporter stages[0].default_until_seconds; ProblemIR metadata problem_meta.runtime_metadata.study_pipeline.nodes[0].payload.until_seconds",
        [1e-12, "1e-12"],
    ),
}


def _example_source(page: str) -> str:
    matches = [
        block
        for block in re.findall(r"```python\s*\n(.*?)```", page, flags=re.DOTALL)
        if 'fm.study("fem_gpu_receipt_contract")' in block
    ]
    if len(matches) != 1:
        raise RuntimeError("0900 page must contain exactly one receipt-contract Python example")
    return matches[0]


def _export_example(example_source: str) -> dict[str, object]:
    fullmag_src = ROOT / "packages/fullmag-py/src"
    sys.path.insert(0, str(fullmag_src))
    try:
        from fullmag.runtime import helper as runtime_helper

        with tempfile.TemporaryDirectory(prefix="fullmag-0900-lowering-") as directory:
            script = Path(directory) / "example.py"
            script.write_text(example_source, encoding="utf-8")
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                exit_code = runtime_helper.main(
                    [
                        "export-run-config",
                        "--script",
                        str(script),
                        "--skip-geometry-assets",
                    ]
                )
            if exit_code != 0:
                raise RuntimeError(f"0900 example exporter exited {exit_code}")
            return json.loads(stdout.getvalue())
    finally:
        sys.path.remove(str(fullmag_src))


def _find_energy(ir: dict[str, object], kind: str) -> dict[str, object]:
    matches = [term for term in ir["energy_terms"] if term.get("kind") == kind]
    if len(matches) != 1:
        raise RuntimeError(f"0900 lowering must contain exactly one {kind} energy term")
    return matches[0]


def _lowered_example_values(payload: dict[str, object]) -> dict[str, object]:
    stages = payload.get("stages")
    if not isinstance(stages, list) or len(stages) != 1:
        raise RuntimeError("0900 example must export exactly one stage")
    stage = stages[0]
    if not isinstance(stage, dict) or stage.get("entrypoint_kind") != "flat_run":
        raise RuntimeError("0900 example must export one flat_run stage")
    ir = stage["ir"]
    runtime_metadata = ir["problem_meta"]["runtime_metadata"]
    runtime_selection = runtime_metadata["runtime_selection"]
    universe = runtime_metadata["study_universe"]
    mesh = runtime_metadata["mesh_workflow"]["per_geometry"][0]
    geometry = ir["geometry"]["entries"][0]
    material = ir["materials"][0]
    magnet = ir["magnets"][0]
    exchange = _find_energy(ir, "exchange")
    demag = _find_energy(ir, "demag")
    fem_policy = ir["backend_policy"]["discretization_hints"]["fem"]
    demag_policy = fem_policy["demag_solver_policy"]
    dynamics = ir["study"]["dynamics"]
    adaptive = dynamics["adaptive_timestep"]
    pipeline_until = runtime_metadata["study_pipeline"]["nodes"][0]["payload"][
        "until_seconds"
    ]
    return {
        "fm.study.problem_name": ir["problem_meta"]["name"],
        "StudyBuilder.engine.backend": ir["backend_policy"]["requested_backend"],
        "StudyBuilder.device.spec": runtime_selection["device"],
        "StudyBuilder.device.precision": ir["backend_policy"]["execution_precision"],
        "StudyBuilder.mode.execution_mode": ir["validation_profile"]["execution_mode"],
        "StudyUniverseHandle.mode": universe["mode"],
        "StudyUniverseHandle.size": universe["size"],
        "StudyUniverseHandle.mesh.maximum_element_size": universe["airbox_hmax"],
        "Box.size": geometry["size"],
        "Box.name": geometry["name"],
        "StudyBuilder.geometry.shape": geometry,
        "StudyBuilder.geometry.name": magnet["name"],
        "MagnetHandle.Ms": material["saturation_magnetisation"],
        "MagnetHandle.Aex": material["exchange_stiffness"],
        "MagnetHandle.alpha": material["damping"],
        "MagnetHandle.m": magnet["initial_magnetization"],
        "UniformMagnetization.value": magnet["initial_magnetization"]["value"],
        "GeometryMeshHandle.maximum_element_size": mesh["maximum_element_size"],
        "GeometryMeshHandle.order": mesh["order"],
        "StudyBuilder.exchange.enabled": exchange == {"kind": "exchange"},
        "StudyBuilder.demag.realization": demag["realization"],
        "StudyBuilder.fem_demag_solver.solver": demag_policy["solver"],
        "StudyBuilder.fem_demag_solver.preconditioner": demag_policy["preconditioner"],
        "StudyBuilder.fem_demag_solver.rtol": demag_policy["rtol"],
        "StudyBuilder.fem_demag_solver.max_iterations": demag_policy["max_iterations"],
        "StudyBuilder.solver.integrator": dynamics["integrator"],
        "StudyBuilder.solver.dt_initial": adaptive["dt_initial"],
        "StudyBuilder.solver.dt_min": adaptive["dt_min"],
        "StudyBuilder.solver.dt_max": adaptive["dt_max"],
        "StudyBuilder.solver.max_err": adaptive["atol"],
        "StudyBuilder.solver.g": dynamics["gyromagnetic_ratio"],
        "StudyStagesBuilder.add_run.until": [
            stage["default_until_seconds"],
            pipeline_until,
        ],
    }


def _values_equal(actual: object, expected: object) -> bool:
    if isinstance(actual, bool) or isinstance(expected, bool):
        return actual is expected
    if isinstance(actual, (int, float)) and isinstance(expected, (int, float)):
        return math.isclose(float(actual), float(expected), rel_tol=1e-14, abs_tol=0.0)
    if isinstance(actual, list) and isinstance(expected, list):
        return len(actual) == len(expected) and all(
            _values_equal(left, right) for left, right in zip(actual, expected, strict=True)
        )
    if isinstance(actual, dict) and isinstance(expected, dict):
        return set(actual) == set(expected) and all(
            _values_equal(actual[key], expected[key]) for key in actual
        )
    return actual == expected


def main() -> int:
    failures: list[str] = []
    for relative, markers in REQUIRED.items():
        path = ROOT / relative
        if not path.is_file():
            failures.append(f"missing document: {relative}")
            continue
        text = path.read_text(encoding="utf-8")
        for marker in markers:
            if marker not in text:
                failures.append(f"{relative}: missing {marker}")
    page = NATIVE_FEM_PAGE.read_text(encoding="utf-8")
    for label in sorted(TERMINAL_LABELS):
        if page.count(f"({label})=") != 1:
            failures.append(f"0900 page requires exactly one unprefixed ({label})= label")
    for lane in ("FDM CPU", "FDM GPU", "FEM CPU", "FEM GPU"):
        if not any(line.startswith("|") and lane in line for line in page.splitlines()):
            failures.append(f"0900 page support/qualification matrix missing {lane}")
    try:
        manifest = json.loads(NATIVE_FEM_SOURCE_MAP.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        failures.append(f"0900 source map cannot be read: {error}")
    else:
        parameters = manifest.get("public_api", {}).get("parameters", [])
        parameters_by_name = {
            parameter.get("python"): parameter
            for parameter in parameters
            if isinstance(parameter, dict)
        }
        actual_parameters = {
            parameter.get("python")
            for parameter in parameters
            if isinstance(parameter, dict)
        }
        if actual_parameters != EXAMPLE_PARAMETERS:
            failures.append(
                "0900 source map must exhaustively map the example parameters: "
                f"missing={sorted(EXAMPLE_PARAMETERS - actual_parameters)} "
                f"extra={sorted(actual_parameters - EXAMPLE_PARAMETERS)}"
            )
        for parameter in parameters:
            if isinstance(parameter, dict) and set(parameter) != PARAMETER_FIELDS:
                failures.append(
                    "0900 source-map parameter fields must be exact for "
                    f"{parameter.get('python')}: {sorted(set(parameter))}"
                )
        for python_name, (destination, _) in LOWERING_CONTRACT.items():
            parameter = parameters_by_name.get(python_name)
            if not isinstance(parameter, dict):
                continue
            if parameter.get("problem_ir") != destination:
                failures.append(
                    f"0900 source-map destination for {python_name} must equal {destination!r}"
                )
            table_rows = [
                line
                for line in page.splitlines()
                if line.startswith(f"| `{python_name}` |")
            ]
            if len(table_rows) != 1 or not table_rows[0].endswith(
                f"| `{destination}` |"
            ):
                failures.append(
                    f"0900 page destination for {python_name} must match the source map"
                )
    try:
        exported = _export_example(_example_source(page))
        lowered_values = _lowered_example_values(exported)
    except (ImportError, OSError, RuntimeError, TypeError, ValueError, KeyError) as error:
        failures.append(f"0900 semantic lowering check failed: {error}")
    else:
        if set(lowered_values) != set(LOWERING_CONTRACT):
            failures.append("0900 semantic lowering result does not cover all 32 parameters")
        for python_name, (_, expected) in LOWERING_CONTRACT.items():
            actual = lowered_values.get(python_name)
            if not _values_equal(actual, expected):
                failures.append(
                    f"0900 semantic lowering mismatch for {python_name}: "
                    f"expected={expected!r} actual={actual!r}"
                )
    try:
        capability_matrix = json.loads(CAPABILITY_MATRIX.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        failures.append(f"capability matrix cannot be read: {error}")
    else:
        qualification = next(
            (
                entry.get("qualification_binding")
                for entry in capability_matrix.get("features", [])
                if entry.get("id") == "llg_timestep_qualification_registry"
            ),
            None,
        )
        required_binding = {
            "artifact_schema": "fullmag.fem_gpu_execution_receipt.native_projection.v1",
            "rust_projection": "FemGpuExecutionReceipt.v1",
            "native_abi_version": 1,
            "native_struct_size": 136,
            "require_exact_fields": True,
            "require_requested_resolved_executed": True,
            "require_attempt_counts": True,
            "require_accounting_valid": True,
        }
        if not isinstance(qualification, dict):
            failures.append("capability matrix is missing the LLG receipt binding")
        else:
            for field, expected in required_binding.items():
                if qualification.get(field) != expected:
                    failures.append(
                        f"capability receipt binding {field} must equal {expected!r}"
                    )
    if failures:
        print("LLG time-domain documentation contract violations:")
        for failure in failures:
            print(f"- {failure}")
        return 1
    print("LLG time-domain documentation contract is canonical.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
