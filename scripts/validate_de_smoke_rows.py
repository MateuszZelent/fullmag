"""Strict numerical-row preflight for DE-SMOKE; not a scientific certificate.

T4, field/profile identity and convergence remain separate requirements even
when this check passes. Frequencies are never replaced by a reference model.
"""
from __future__ import annotations
import csv
import json
import math
from pathlib import Path
import re

UI_SEVEN_SAMPLING = "ui-seven"

SAMPLING = {
    "two": (0.0, 2e6),
    UI_SEVEN_SAMPLING: tuple(k * 1e6 for k in (-25, -15, -5, 0, 5, 15, 25)),
    "five": (0.0, 1e6, 2e6, 3e6, 5e6),
    "k2": (2e6,),
    "k25": (25e6,),
    "bv-k25": (25e6,),
    "positive-six": (2e6, 5e6, 10e6, 15e6, 20e6, 25e6),
    "bv-positive-six": (2e6, 5e6, 10e6, 15e6, 20e6, 25e6),
    "k0": (0.0,),
    "positive-26": tuple(k * 1e6 for k in range(26)),
    "bv-positive-26": tuple(k * 1e6 for k in range(26)),
    "signed-fifteen": tuple(k * 1e6 for k in (-25, -20, -15, -10, -7, -5, -2, 0, 2, 5, 7, 10, 15, 20, 25)),
    "signed-eleven": (-3e6, -2e6, -1.5e6, -1e6, -0.5e6, 0.0,
                      0.5e6, 1e6, 1.5e6, 2e6, 3e6),
    # Closed serial/adaptive parity probe.  The repeated -10 rad/um sample
    # is intentional: sample_index, rather than a deduplicated k value, is
    # the identity used by the execution and tracking contracts.
    "parallel-probe": (-10e6, 10e6, -10e6),
}
for _prefix in ("", "bv-"):
    for _k_um in range(-25, 26):
        SAMPLING.setdefault(f"{_prefix}k{_k_um}", (_k_um * 1e6,))
DENSE_SAMPLING = frozenset(("positive-26", "bv-positive-26"))
DENSE_CERTIFICATION_TOLERANCE = 1e-8
MAX_PROBE_RELATIVE_TOLERANCE = 1e-8
GAMMA_NZ_RELATIVE_TOLERANCE = 5e-3
GAMMA_NY_ABSOLUTE_TOLERANCE = 5e-3
GEOMETRY_RELATIVE_TOLERANCE = 1e-6
PARALLEL_PROBE_FREQUENCY_WINDOW_HZ = (10.5e9, 11.5e9)
PARALLEL_PROBE_VECTORS_RAD_PER_M = (
    (0.0, -10e6, 0.0),
    (0.0, 10e6, 0.0),
    (0.0, -10e6, 0.0),
)
PHASE_CONSTRAINT_SHA256_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")


def validate_parallel_probe_metadata(
    metadata_path: Path,
    *,
    model_sha256: str,
    parallel_mode: str,
):
    """Validate the closed probe's authoring and native execution metadata.

    This is an input/metadata guard only.  It does not qualify a dispersion
    result or replace the row, residual, mesh, or scientific gates.
    """

    if parallel_mode not in {"serial", "adaptive"}:
        raise ValueError("parallel probe mode must be serial or adaptive")
    if not isinstance(model_sha256, str) or len(model_sha256) != 64 \
            or any(character not in "0123456789abcdef" for character in model_sha256):
        raise ValueError("parallel probe model hash is invalid")
    try:
        metadata = json.loads(Path(metadata_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("missing or invalid parallel probe metadata") from error
    try:
        model = metadata["problem_meta"]["runtime_metadata"]["de_smoke"]
    except (KeyError, TypeError) as error:
        raise ValueError("parallel probe metadata is missing the DE-SMOKE descriptor") from error
    if not isinstance(model, dict) or model.get("schema") != "fullmag.de-smoke.v1":
        raise ValueError("parallel probe metadata has an unsupported DE-SMOKE descriptor")
    if model.get("sampling") != "parallel-probe":
        raise ValueError("parallel probe metadata has the wrong sampling")
    if model.get("orientation") != "M0=x,k=y,normal=z":
        raise ValueError("parallel probe requires Damon-Eshbach orientation M0=x,k=y,normal=z")
    if model.get("k_vectors_rad_per_m") != [list(vector) for vector in PARALLEL_PROBE_VECTORS_RAD_PER_M]:
        raise ValueError("parallel probe metadata has the wrong signed k path")
    if model.get("dispersion_geometry") != "damon_eshbach":
        raise ValueError("parallel probe metadata must declare Damon-Eshbach geometry")
    if model.get("modal_target") != "frequency_window" or model.get("selection_scope") != "frequency_window":
        raise ValueError("parallel probe must use a complete frequency-window target")
    if model.get("frequency_window_hz") != list(PARALLEL_PROBE_FREQUENCY_WINDOW_HZ):
        raise ValueError("parallel probe frequency window is not pinned to 10.5-11.5 GHz")
    requested_mode_count = model.get("requested_mode_count")
    if isinstance(requested_mode_count, bool) or requested_mode_count != 1:
        raise ValueError("parallel probe metadata must request one mode")
    if model.get("mesh_level") != "L2" or model.get("through_thickness_elements") != 3:
        raise ValueError("parallel probe mesh metadata is not pinned to L2/3")
    if model.get("outer_boundary_kind") != "poisson_dirichlet":
        raise ValueError("parallel probe metadata must declare the Poisson Dirichlet airbox")
    try:
        stage = metadata["problem_meta"]["runtime_metadata"]["model_builder"]["problem"]["study"]
    except (KeyError, TypeError) as error:
        raise ValueError(
            "parallel probe metadata is missing the canonical model_builder.problem.study") from error
    if not isinstance(stage, dict) or stage.get("kind") != "eigenmodes":
        raise ValueError("parallel probe canonical study is not an eigenmodes stage")
    operator = stage.get("operator")
    if not isinstance(operator, dict) or operator.get("kind") != "full_2x2" \
            or operator.get("include_demag") is not True:
        raise ValueError("parallel probe eigenmodes stage must use full_2x2 with demag")
    if stage.get("magnetostatic_bc") != "floquet_airbox":
        raise ValueError("parallel probe eigenmodes stage must use floquet_airbox")
    source = stage.get("equilibrium")
    source_kind = source.get("kind") if isinstance(source, dict) else source
    source_path = source.get("path") if isinstance(source, dict) else stage.get("equilibrium_artifact")
    if source_kind != "artifact" or source_path != "/workspace/benchmark-input/equilibrium_artifact.v7.json":
        raise ValueError("parallel probe must use the pinned equilibrium artifact")
    count = stage.get("count", stage.get("mode_count"))
    if isinstance(count, bool) or not isinstance(count, int) or count != 1:
        raise ValueError("parallel probe must request exactly one mode")
    try:
        runtime = metadata["problem_meta"]["runtime_metadata"]["model_builder"]["problem"]["runtime"]
        policy = runtime["parallel_execution"]
    except (KeyError, TypeError) as error:
        raise ValueError(
            "parallel probe metadata is missing the canonical requested execution policy") from error
    if not isinstance(policy, dict) or policy.get("mode") != parallel_mode:
        raise ValueError("parallel probe metadata has the wrong requested execution mode")
    expected_policy = {
        "max_cpu_percent": 90.0,
        "max_memory_percent": 80.0,
        "memory_reserve_bytes": 1024**3,
        "max_workers": 2,
        "threads_per_worker": 1,
    }
    for key, expected in expected_policy.items():
        value = policy.get(key)
        if isinstance(value, bool) or value != expected:
            raise ValueError(f"parallel probe policy field {key} is not pinned")
    problem_meta = metadata.get("problem_meta")
    problem_source_hash = problem_meta.get("source_hash") if isinstance(problem_meta, dict) else None
    root_source_hash = metadata.get("source_hash")
    if root_source_hash != model_sha256 or problem_source_hash != model_sha256:
        raise ValueError(
            "parallel probe metadata source_hash fields disagree with the staged input")
    return {
        "schema": "fullmag.parallel-probe-metadata.v1",
        "status": "pass",
        "qualification": "NOT VERIFIED",
        "model_sha256": model_sha256,
        "source_hash": model_sha256,
        "parallel_mode": parallel_mode,
        "sampling": "parallel-probe",
        "frequency_window_hz": list(PARALLEL_PROBE_FREQUENCY_WINDOW_HZ),
        "k_vectors_rad_per_m": [list(vector) for vector in PARALLEL_PROBE_VECTORS_RAD_PER_M],
        "operator": "full_2x2+demag+floquet_airbox",
        "pending_requirements": [
            "native receipt and immutable input manifest binding",
            "serial/adaptive frequency and residual parity",
            "mesh, airbox and mode-count convergence",
        ],
    }


def validate_parallel_probe_solver_artifacts(
    case_dir: Path,
    *,
    requested_eps_prefilter: str,
    requested_shifted_ksp_rtol: str,
    requested_gmres_restart: str,
    expected_sample_count: int | None = None,
    physical_residual_tolerance: float = DENSE_CERTIFICATION_TOLERANCE,
):
    """Validate resolved modal, KSP and Floquet evidence from native artifacts.

    The probe's command line requests EPS/KSP ``1e-9`` and GMRES restart ``8``.
    Native SLEPc may resolve the EPS true-residual cutoff more strictly (for
    example to ``1e-11`` for a physical ``1e-8`` residual policy), so the
    resolved values are checked against the requested upper bounds and their
    actual convergence evidence is required.  This remains a runtime artifact
    preflight; mesh, airbox and dispersion qualification stay separate.
    """

    if requested_eps_prefilter != "1e-9":
        raise ValueError("parallel probe EPS request is not pinned to 1e-9")
    if requested_shifted_ksp_rtol != "1e-9":
        raise ValueError("parallel probe KSP request is not pinned to 1e-9")
    if requested_gmres_restart != "8":
        raise ValueError("parallel probe GMRES restart request is not pinned to 8")
    if (isinstance(physical_residual_tolerance, bool)
            or not isinstance(physical_residual_tolerance, (int, float))
            or not math.isfinite(physical_residual_tolerance)
            or physical_residual_tolerance <= 0.0):
        raise ValueError("parallel probe physical residual tolerance is invalid")
    requested_eps = float(requested_eps_prefilter)
    requested_ksp = float(requested_shifted_ksp_rtol)
    requested_restart = int(requested_gmres_restart)
    if expected_sample_count is None:
        expected_sample_count = len(PARALLEL_PROBE_VECTORS_RAD_PER_M)
    if (isinstance(expected_sample_count, bool) or not isinstance(expected_sample_count, int)
            or expected_sample_count <= 0):
        raise ValueError("parallel probe expected sample count is invalid")
    case_dir = Path(case_dir)

    def read_json(relative, label):
        try:
            value = json.loads((case_dir / relative).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError(f"parallel probe {label} artifact is missing or invalid") from error
        if not isinstance(value, dict):
            raise ValueError(f"parallel probe {label} artifact must be an object")
        return value

    diagnostics = read_json("eigen/diagnostics/solver.v1.json", "solver diagnostics")
    summary = read_json("eigen/metadata/eigen_summary.json", "eigen summary")
    spectrum = read_json("eigen/spectrum.v3.json", "spectrum")
    if diagnostics.get("schema_version") != "frequency_domain_modal_solver_diagnostics.v1":
        raise ValueError("parallel probe native diagnostics schema is unsupported")
    if spectrum.get("schema_version") != "eigen_spectrum.v3":
        raise ValueError("parallel probe native spectrum schema is unsupported")
    if summary.get("study_kind") != "eigenmodes" or summary.get("spin_wave_bc") != "floquet":
        raise ValueError("parallel probe summary does not prove a Floquet eigenmode solve")
    boundary = summary.get("boundary_config")
    if (not isinstance(boundary, dict) or boundary.get("kind") != "floquet"
            or boundary.get("phase_convention") != "exp_minus_i_k_dot_delta_r"):
        raise ValueError("parallel probe summary has no canonical Floquet phase convention")
    if (spectrum.get("phase_convention") is not None
            and spectrum.get("phase_convention") != "exp_minus_i_k_dot_delta_r"):
        raise ValueError("parallel probe spectrum has no canonical Floquet phase convention")

    samples = spectrum.get("samples")
    if not isinstance(samples, list) or len(samples) != expected_sample_count:
        raise ValueError("parallel probe spectrum sample count disagrees with the request")
    expected_vectors = (
        PARALLEL_PROBE_VECTORS_RAD_PER_M
        if expected_sample_count == len(PARALLEL_PROBE_VECTORS_RAD_PER_M)
        else None
    )
    sample_indices = set()
    max_physical_residual = 0.0
    phase_hashes = set()
    phase_constraints_by_sample = []
    for position, sample in enumerate(samples):
        if not isinstance(sample, dict):
            raise ValueError(f"parallel probe spectrum sample {position} is invalid")
        sample_index = sample.get("sample_index")
        if (isinstance(sample_index, bool) or not isinstance(sample_index, int)
                or sample_index != position or sample_index in sample_indices):
            raise ValueError("parallel probe spectrum sample indices are not canonical")
        sample_indices.add(sample_index)
        k_vector = sample.get("k_vector")
        if (not isinstance(k_vector, list) or len(k_vector) != 3
                or any(isinstance(value, bool) or not isinstance(value, (int, float))
                       or not math.isfinite(value) for value in k_vector)):
            raise ValueError(f"parallel probe sample {sample_index} has an invalid k vector")
        if expected_vectors is not None and k_vector != list(expected_vectors[position]):
            raise ValueError("parallel probe spectrum signed k vector disagrees with the request")
        modes = sample.get("modes")
        if not isinstance(modes, list) or len(modes) != 1:
            raise ValueError(f"parallel probe spectrum sample {sample_index} must publish one mode")
        mode = modes[0]
        if not isinstance(mode, dict):
            raise ValueError(f"parallel probe spectrum sample {sample_index} mode is invalid")
        frequency = mode.get("frequency_hz")
        residual = mode.get("residual_relative_l2")
        if (isinstance(frequency, bool) or not isinstance(frequency, (int, float))
                or not math.isfinite(frequency) or frequency <= 0.0):
            raise ValueError(f"parallel probe sample {sample_index} has no finite frequency")
        if (isinstance(residual, bool) or not isinstance(residual, (int, float))
                or not math.isfinite(residual) or residual < 0.0
                or residual > physical_residual_tolerance):
            raise ValueError(f"parallel probe sample {sample_index} exceeds the physical residual gate")
        max_physical_residual = max(max_physical_residual, float(residual))
        block = mode.get("block_residuals")
        if not isinstance(block, dict) or block.get("certified") is not True:
            raise ValueError(f"parallel probe sample {sample_index} lacks a certified Floquet block")
        if block.get("certification_tolerance") != physical_residual_tolerance:
            raise ValueError(f"parallel probe sample {sample_index} has the wrong physical tolerance")
        for key in (
            "floquet_cartesian_magnetic_seam_relative_residual",
            "floquet_equilibrium_pair_relative_residual",
            "floquet_full_magnetic_relative_residual",
            "floquet_full_potential_relative_residual",
            "floquet_scalar_phase_seam_relative_residual",
            "floquet_tangent_frame_seam_relative_residual",
        ):
            value = block.get(key)
            if (isinstance(value, bool) or not isinstance(value, (int, float))
                    or not math.isfinite(value) or value < 0.0
                    or value > physical_residual_tolerance):
                raise ValueError(f"parallel probe sample {sample_index} has invalid {key}")
        for key in (
            "floquet_descriptor_certified", "floquet_full_descriptor_certified",
            "floquet_gauge_policy_satisfied", "floquet_seam_frame_certified",
        ):
            if mode.get(key) is not True:
                raise ValueError(f"parallel probe sample {sample_index} lacks {key}")
        phase_hash = mode.get("phase_constraint_sha256")
        if (not isinstance(phase_hash, str)
                or PHASE_CONSTRAINT_SHA256_RE.fullmatch(phase_hash) is None):
            raise ValueError(f"parallel probe sample {sample_index} has no valid phase constraint identity")
        phase_hashes.add(phase_hash)
        # The native phase digest includes k and must be bound per sample.
        phase_constraints_by_sample.append({
            "sample_index": sample_index,
            "k_vector_rad_per_m": k_vector,
            "phase_constraint_sha256": phase_hash,
        })

    summary_modes = summary.get("modes")
    if not isinstance(summary_modes, list) or not summary_modes:
        raise ValueError("parallel probe eigen summary has no published mode")
    summary_mode = summary_modes[0]
    if not isinstance(summary_mode, dict):
        raise ValueError("parallel probe eigen summary mode is invalid")
    if (summary_mode.get("phase_constraint_sha256")
            != phase_constraints_by_sample[0]["phase_constraint_sha256"]):
        raise ValueError("parallel probe summary phase identity is not bound to the spectrum")

    def finite_number(value, label, *, positive=False):
        if (isinstance(value, bool) or not isinstance(value, (int, float))
                or not math.isfinite(value) or (positive and value <= 0.0)):
            raise ValueError(f"parallel probe native diagnostics have invalid {label}")
        return float(value)

    records = diagnostics.get("sample_solver_diagnostics")
    if records is None:
        records = [{"sample_index": 0, "diagnostics": diagnostics}]
    if not isinstance(records, list) or len(records) != len(samples):
        raise ValueError("parallel probe native diagnostics do not cover every sample")
    seen_records = set()
    resolved_eps = []
    resolved_ksp = []
    for position, record in enumerate(records):
        if not isinstance(record, dict):
            raise ValueError(f"parallel probe native diagnostics sample {position} is invalid")
        sample_index = record.get("sample_index")
        if (isinstance(sample_index, bool) or not isinstance(sample_index, int)
                or sample_index not in sample_indices or sample_index in seen_records):
            raise ValueError("parallel probe native diagnostics sample identity is invalid")
        seen_records.add(sample_index)
        sample_diagnostics = record.get("diagnostics")
        if not isinstance(sample_diagnostics, dict):
            raise ValueError("parallel probe native diagnostics sample payload is invalid")
        policy = sample_diagnostics.get("modal_solver_policy")
        if (not isinstance(policy, dict)
                or policy.get("requested_residual_tolerance") != physical_residual_tolerance):
            raise ValueError("parallel probe native diagnostics have the wrong requested residual policy")
        accepted = sample_diagnostics.get("accepted_mode_count")
        deduped = sample_diagnostics.get("accepted_mode_count_after_dedup", accepted)
        if (isinstance(accepted, bool) or accepted != 1
                or isinstance(deduped, bool) or deduped != 1):
            raise ValueError("parallel probe native diagnostics do not prove one accepted mode")
        ksp_rtol = finite_number(sample_diagnostics.get("ksp_rtol"), "ksp_rtol", positive=True)
        if ksp_rtol > requested_ksp:
            raise ValueError("parallel probe resolved KSP rtol is looser than the pinned request")
        restart = sample_diagnostics.get("ksp_restart")
        if isinstance(restart, bool) or restart != requested_restart:
            raise ValueError("parallel probe resolved GMRES restart disagrees with the request")
        resolved_ksp.append(ksp_rtol)
        subwindows = sample_diagnostics.get("subwindows")
        if not isinstance(subwindows, list) or not subwindows:
            raise ValueError("parallel probe native diagnostics have no resolved EPS subwindow")
        has_converged_window = False
        for subwindow in subwindows:
            if not isinstance(subwindow, dict):
                raise ValueError("parallel probe native EPS subwindow is invalid")
            eps_tolerance = finite_number(
                subwindow.get("eps_normalized_absolute_tolerance"),
                "eps_normalized_absolute_tolerance", positive=True)
            if eps_tolerance > requested_eps or eps_tolerance > physical_residual_tolerance:
                raise ValueError("parallel probe resolved EPS cutoff is looser than the pinned request")
            eps_residual = finite_number(
                subwindow.get("eps_normalized_absolute_residual_max"),
                "eps_normalized_absolute_residual_max")
            if eps_residual > eps_tolerance:
                raise ValueError("parallel probe EPS true residual exceeds its resolved cutoff")
            physical = finite_number(subwindow.get("residual_max"), "residual_max")
            if physical > physical_residual_tolerance:
                raise ValueError("parallel probe native candidate residual exceeds the physical gate")
            true_residual = finite_number(
                subwindow.get("ksp_max_true_relative_residual"),
                "ksp_max_true_relative_residual")
            if true_residual > physical_residual_tolerance:
                raise ValueError("parallel probe native KSP true residual exceeds the physical gate")
            finite_number(subwindow.get("ksp_final_residual"), "ksp_final_residual")
            if (subwindow.get("ksp_diagnostics_available") is not True
                    or subwindow.get("ksp_last_true_residual_available") is not True
                    or subwindow.get("ksp_true_residual_measurement_failure_count") != 0
                    or subwindow.get("ksp_converged_reason", 0) <= 0
                    or subwindow.get("eps_converged_reason", 0) <= 0
                    or subwindow.get("eps_convergence_test") != "absolute_true_residual"):
                raise ValueError("parallel probe native EPS/KSP convergence evidence is incomplete")
            if subwindow.get("stop_reason") == "converged":
                has_converged_window = True
            resolved_eps.append(eps_tolerance)
        if not has_converged_window:
            raise ValueError("parallel probe has no converged EPS subwindow")

    return {
        "schema": "fullmag.parallel-probe-solver-artifacts.v1",
        "status": "pass",
        "qualification": "NOT VERIFIED",
        "sample_count": len(samples),
        "resolved_eps_normalized_absolute_tolerance": resolved_eps,
        "resolved_ksp_rtol": resolved_ksp,
        "resolved_gmres_restart": requested_restart,
        "max_physical_residual": max_physical_residual,
        "phase_constraint_sha256": sorted(phase_hashes),
        "phase_constraints_by_sample": phase_constraints_by_sample,
        "pending_requirements": [
            "mesh, airbox and mode-count convergence",
            "serial/adaptive frequency parity and scientific comparison",
        ],
    }


def load_solver_diagnostics(path: Path):
    try:
        diagnostics = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("missing or invalid DE-SMOKE solver diagnostics") from error
    if not isinstance(diagnostics, dict):
        raise ValueError("DE-SMOKE solver diagnostics must be an object")
    return diagnostics


def validate_selected_only_diagnostics(
    path: Path,
    expected_target_frequency_hz: float,
    *,
    expected_sample_count: int = 1,
    expected_vectors=None,
):
    """Validate nearest-mode scope and, when requested, every path sample.

    A single-k compatibility caller may use root diagnostics. Multi-sample
    selected-only validation requires exact per-sample records so root-level
    fields cannot stand in for the whole path.
    """
    if (isinstance(expected_target_frequency_hz, bool) or
            not isinstance(expected_target_frequency_hz, (int, float)) or
            not math.isfinite(expected_target_frequency_hz) or
            expected_target_frequency_hz <= 0.0):
        raise ValueError("selected-only expected target frequency must be finite and positive")
    if (isinstance(expected_sample_count, bool) or
            not isinstance(expected_sample_count, int) or expected_sample_count < 1):
        raise ValueError("selected-only expected sample count must be a positive integer")

    normalized_vectors = None
    if expected_vectors is not None:
        if (not isinstance(expected_vectors, (list, tuple)) or
                len(expected_vectors) != expected_sample_count):
            raise ValueError("selected-only expected vectors must match the sample count")
        normalized_vectors = []
        for sample_index, vector in enumerate(expected_vectors):
            if not isinstance(vector, (list, tuple)) or len(vector) != 3:
                raise ValueError(f"selected-only expected vector {sample_index} must have three components")
            normalized = []
            for axis, value in enumerate(vector):
                if (isinstance(value, bool) or not isinstance(value, (int, float)) or
                        not math.isfinite(value)):
                    raise ValueError(
                        f"selected-only expected vector {sample_index}[{axis}] must be finite")
                normalized.append(float(value))
            normalized_vectors.append(normalized)
    elif expected_sample_count > 1:
        raise ValueError("multi-sample selected-only validation requires expected k vectors")

    diagnostics = load_solver_diagnostics(path)
    records = diagnostics.get("sample_solver_diagnostics")
    sample_payloads = None
    record_vectors = None
    if records is None:
        if expected_sample_count != 1:
            raise ValueError(
                f"selected-only native diagnostics require exactly {expected_sample_count} indexed sample records")
        sample_payloads = [dict(diagnostics)]
        record_vectors = [None]
    else:
        if not isinstance(records, list) or len(records) != expected_sample_count:
            if expected_sample_count == 1:
                raise ValueError("selected-only native diagnostics require one sample record")
            raise ValueError(
                f"selected-only native diagnostics require exactly {expected_sample_count} indexed sample records")
        by_sample = {}
        vectors_by_sample = {}
        for position, record in enumerate(records):
            sample_index = record.get("sample_index") if isinstance(record, dict) else None
            if (not isinstance(record, dict) or isinstance(sample_index, bool) or
                    not isinstance(sample_index, int) or sample_index < 0 or
                    sample_index >= expected_sample_count):
                if expected_sample_count == 1:
                    raise ValueError("selected-only native diagnostics must identify sample 0")
                raise ValueError(
                    f"selected-only native diagnostics record {position} has an invalid sample index")
            if sample_index in by_sample:
                raise ValueError(
                    f"selected-only native diagnostics contain duplicate sample {sample_index}")
            sample_payload = record.get("diagnostics")
            if not isinstance(sample_payload, dict):
                raise ValueError("selected-only native sample diagnostics must be an object")
            by_sample[sample_index] = dict(sample_payload)
            if normalized_vectors is not None:
                vector = record.get("k_vector")
                if not isinstance(vector, list) or len(vector) != 3:
                    raise ValueError(
                        f"selected-only native sample {sample_index} is missing its k vector")
                parsed_vector = []
                for axis, value in enumerate(vector):
                    if (isinstance(value, bool) or not isinstance(value, (int, float)) or
                            not math.isfinite(value)):
                        raise ValueError(
                            f"selected-only native sample {sample_index} has invalid k_vector[{axis}]")
                    parsed_vector.append(float(value))
                if any(not math.isclose(actual, expected, rel_tol=1e-12, abs_tol=1e-12)
                       for actual, expected in zip(parsed_vector, normalized_vectors[sample_index])):
                    raise ValueError(
                        f"selected-only native sample {sample_index} k vector disagrees with the request")
                nested_vector = sample_payload.get("k_vector_rad_m")
                if nested_vector is not None:
                    if (not isinstance(nested_vector, list) or len(nested_vector) != 3 or
                            any(isinstance(value, bool) or not isinstance(value, (int, float)) or
                                not math.isfinite(value) for value in nested_vector) or
                            any(not math.isclose(float(actual), expected, rel_tol=1e-12, abs_tol=1e-12)
                                for actual, expected in zip(nested_vector, normalized_vectors[sample_index]))):
                        raise ValueError(
                            f"selected-only native sample {sample_index} diagnostic vector disagrees with the request")
                vectors_by_sample[sample_index] = parsed_vector
        if set(by_sample) != set(range(expected_sample_count)):
            raise ValueError("selected-only native diagnostics have missing sample indices")
        sample_payloads = [by_sample[index] for index in range(expected_sample_count)]
        record_vectors = ([vectors_by_sample[index] for index in range(expected_sample_count)]
                          if normalized_vectors is not None else [None] * expected_sample_count)

        root_sample_count = diagnostics.get("sample_count")
        if root_sample_count is not None or expected_sample_count > 1:
            if (isinstance(root_sample_count, bool) or
                    not isinstance(root_sample_count, int) or
                    root_sample_count != expected_sample_count):
                raise ValueError("selected-only native sample_count disagrees with its records")
        root_mode_count = diagnostics.get("requested_mode_count")
        if root_mode_count is not None or expected_sample_count > 1:
            if (isinstance(root_mode_count, bool) or not isinstance(root_mode_count, int) or
                    root_mode_count != 1):
                raise ValueError("selected-only native diagnostics must request one mode")

    alias_keys = (
        "target_kind", "target_frequency_hz", "target_omega_rad_s",
        "target_tau_rad_s", "spectrum_completeness", "window_complete",
        "requested_mode_count",
    )
    for key in alias_keys:
        if key not in diagnostics:
            continue
        root_value = diagnostics[key]
        for sample_payload in sample_payloads:
            if key in sample_payload:
                sample_value = sample_payload[key]
                both_numbers = (
                    isinstance(root_value, (int, float)) and not isinstance(root_value, bool) and
                    isinstance(sample_value, (int, float)) and not isinstance(sample_value, bool))
                agree = (math.isclose(float(root_value), float(sample_value),
                                      rel_tol=1e-12, abs_tol=1e-6)
                         if both_numbers else
                         type(root_value) is type(sample_value) and root_value == sample_value)
                if not agree:
                    raise ValueError(
                        f"native selected-only root and sample diagnostics disagree for {key}")
            elif expected_sample_count == 1:
                sample_payload[key] = root_value

    def finite_positive(payload, name):
        value = payload.get(name)
        if (isinstance(value, bool) or not isinstance(value, (int, float)) or
                not math.isfinite(value) or value <= 0.0):
            raise ValueError(f"native selected-only diagnostics have invalid {name}")
        return float(value)

    for key, expected_value in (
            ("target_kind", "nearest_frequency"),
            ("spectrum_completeness", "selected_only"),
            ("window_complete", False)):
        if (key in diagnostics and
                (type(diagnostics[key]) is not type(expected_value) or
                 diagnostics[key] != expected_value)):
            raise ValueError(f"native selected-only root diagnostics have invalid {key}")

    root_targets = []
    for key, divisor in (
            ("target_frequency_hz", 1.0),
            ("target_omega_rad_s", math.tau),
            ("target_tau_rad_s", math.tau)):
        if key in diagnostics:
            root_targets.append(finite_positive(diagnostics, key) / divisor)
    if root_targets:
        root_target_hz = root_targets[0]
        if any(not math.isclose(value, root_target_hz, rel_tol=1e-12, abs_tol=1e-6)
               for value in root_targets[1:]):
            raise ValueError("native selected-only root target fields disagree")
        if not math.isclose(root_target_hz, float(expected_target_frequency_hz),
                            rel_tol=1e-12, abs_tol=1e-6):
            raise ValueError("native selected-only root target frequency disagrees with the request")

    target_fields = []
    target_frequencies = []
    for sample_index, payload in enumerate(sample_payloads):
        if payload.get("target_kind") != "nearest_frequency":
            raise ValueError("native selected-only diagnostics must declare target_kind=nearest_frequency")
        if payload.get("spectrum_completeness") != "selected_only":
            raise ValueError("native selected-only diagnostics must declare spectrum_completeness=selected_only")
        if payload.get("window_complete") is not False:
            raise ValueError("native selected-only diagnostics must declare window_complete=false")
        if expected_sample_count > 1:
            mode_count = payload.get("requested_mode_count")
            if isinstance(mode_count, bool) or not isinstance(mode_count, int) or mode_count != 1:
                raise ValueError(
                    f"native selected-only sample {sample_index} must request exactly one mode")

        direct_hz = finite_positive(payload, "target_frequency_hz") if "target_frequency_hz" in payload else None
        omega_hz = finite_positive(payload, "target_omega_rad_s") / math.tau if "target_omega_rad_s" in payload else None
        tau_hz = finite_positive(payload, "target_tau_rad_s") / math.tau if "target_tau_rad_s" in payload else None
        native_targets = [value for value in (direct_hz, omega_hz, tau_hz) if value is not None]
        if not native_targets:
            raise ValueError("native selected-only diagnostics have no target frequency")
        canonical_hz = native_targets[0]
        if any(not math.isclose(value, canonical_hz, rel_tol=1e-12, abs_tol=1e-6)
               for value in native_targets[1:]):
            raise ValueError("native selected-only target fields disagree")
        if not math.isclose(canonical_hz, float(expected_target_frequency_hz),
                            rel_tol=1e-12, abs_tol=1e-6):
            raise ValueError(
                f"native selected-only sample {sample_index} target frequency disagrees with the request")
        target_frequencies.append(canonical_hz)
        target_fields.append(
            "target_frequency_hz" if direct_hz is not None else
            "target_omega_rad_s" if omega_hz is not None else "target_tau_rad_s")

    report = {
        "status": "pass",
        "source": str(Path(path)),
        "target_kind": "nearest_frequency",
        "spectrum_completeness": "selected_only",
        "window_complete": False,
        "target_frequency_hz": target_frequencies[0],
        "target_field": target_fields[0],
        "qualification": "NOT VERIFIED",
    }
    if expected_sample_count > 1:
        report.update({
            "sample_count": expected_sample_count,
            "sample_indices": list(range(expected_sample_count)),
            "requested_mode_count": 1,
            "k_vectors_rad_per_m": record_vectors,
            "per_sample_target_frequency_hz": target_frequencies,
        })
    return report

def diagnostics_by_sample(diagnostics, required_sample_indices, fallback_probe_key):
    sample_records = diagnostics.get("sample_solver_diagnostics")
    by_sample = {}
    if sample_records is None:
        if len(required_sample_indices) != 1 or fallback_probe_key not in diagnostics:
            raise ValueError(f"per-sample {fallback_probe_key} diagnostics are required")
        by_sample[required_sample_indices[0]] = diagnostics
        return by_sample
    if not isinstance(sample_records, list):
        raise ValueError("sample_solver_diagnostics must be a list")
    for position, record in enumerate(sample_records):
        if not isinstance(record, dict):
            raise ValueError(f"sample_solver_diagnostics[{position}] must be an object")
        sample_index = record.get("sample_index")
        if isinstance(sample_index, bool) or not isinstance(sample_index, int) or sample_index < 0:
            raise ValueError(f"sample_solver_diagnostics[{position}].sample_index is invalid")
        sample_diagnostics = record.get("diagnostics")
        if not isinstance(sample_diagnostics, dict):
            raise ValueError(f"sample_solver_diagnostics[{position}].diagnostics must be an object")
        if sample_index in by_sample:
            raise ValueError(f"duplicate solver diagnostics for sample {sample_index}")
        by_sample[sample_index] = sample_diagnostics
    return by_sample


def load_spectrum_v3_modes(path: Path):
    """Load per-mode relative residuals and their native block scope."""
    try:
        spectrum = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("missing or invalid native eigen_spectrum.v3 artifact") from error
    if not isinstance(spectrum, dict) or spectrum.get("schema_version") != "eigen_spectrum.v3":
        raise ValueError("native spectrum must use eigen_spectrum.v3")
    samples = spectrum.get("samples")
    if not isinstance(samples, list) or not samples:
        raise ValueError("native eigen_spectrum.v3 must contain samples")

    declared_count = spectrum.get("sample_count")
    if (isinstance(declared_count, bool) or not isinstance(declared_count, int) or
            declared_count != len(samples)):
        raise ValueError("native spectrum sample_count disagrees with its samples")
    sample_indices = set()
    result = {}
    for sample_position, sample in enumerate(samples):
        if not isinstance(sample, dict):
            raise ValueError(f"spectrum sample {sample_position} must be an object")
        sample_index = sample.get("sample_index")
        if isinstance(sample_index, bool) or not isinstance(sample_index, int) or sample_index < 0:
            raise ValueError(f"spectrum sample {sample_position} has invalid sample_index")
        if sample_index in sample_indices:
            raise ValueError(f"duplicate sample in native spectrum for sample {sample_index}")
        sample_indices.add(sample_index)
        modes = sample.get("modes")
        if not isinstance(modes, list) or not modes:
            raise ValueError(f"spectrum sample {sample_index} has no modes")
        for mode_position, mode in enumerate(modes):
            if not isinstance(mode, dict):
                raise ValueError(f"spectrum sample {sample_index} mode {mode_position} must be an object")
            mode_sample = mode.get("sample_index", sample_index)
            raw_mode_index = mode.get("raw_mode_index", mode.get("index"))
            if (isinstance(mode_sample, bool) or not isinstance(mode_sample, int) or
                    mode_sample != sample_index):
                raise ValueError(f"spectrum sample {sample_index} mode has mismatched sample_index")
            if (isinstance(raw_mode_index, bool) or not isinstance(raw_mode_index, int) or
                    raw_mode_index < 0):
                raise ValueError(f"spectrum sample {sample_index} mode has invalid raw_mode_index")
            key = (sample_index, raw_mode_index)
            if key in result:
                raise ValueError(f"duplicate mode in native spectrum for sample {sample_index}")

            residual = mode.get("residual_relative_l2")
            if (isinstance(residual, bool) or not isinstance(residual, (int, float)) or
                    not math.isfinite(residual) or residual < 0):
                raise ValueError(
                    f"spectrum sample {sample_index} mode {raw_mode_index} has invalid residual_relative_l2")
            frequency = mode.get("frequency_hz")
            if (isinstance(frequency, bool) or not isinstance(frequency, (int, float)) or
                    not math.isfinite(frequency) or frequency <= 0):
                raise ValueError(
                    f"spectrum sample {sample_index} mode {raw_mode_index} has invalid frequency_hz")

            block = mode.get("block_residuals")
            if not isinstance(block, dict):
                raise ValueError(
                    f"spectrum sample {sample_index} mode {raw_mode_index} is missing block_residuals")
            scope = block.get("scope")
            if scope not in (
                    "native_descriptor",
                    "reduced_original_blocks_only",
                    "full_projected_weak_form_and_periodic_seams"):
                raise ValueError(
                    f"spectrum sample {sample_index} mode {raw_mode_index} has unsupported residual scope")

            def residual_value(container, name, *, required=True):
                value = container.get(name)
                if value is None and not required:
                    return None
                if (isinstance(value, bool) or not isinstance(value, (int, float)) or
                        not math.isfinite(value) or value < 0):
                    raise ValueError(
                        f"spectrum sample {sample_index} mode {raw_mode_index} has invalid {name}")
                return float(value)

            eps_q = residual_value(block, "eps_q")
            eps_phi = residual_value(block, "eps_phi")
            eps_gauge = residual_value(
                block, "eps_gauge", required=(scope == "native_descriptor"))
            reduced_values = [eps_q, eps_phi]
            if eps_gauge is not None:
                reduced_values.append(eps_gauge)
            reduced_max = max(reduced_values)

            certification_tolerance = block.get("certification_tolerance")
            if (isinstance(certification_tolerance, bool) or
                    not isinstance(certification_tolerance, (int, float)) or
                    not math.isfinite(certification_tolerance) or certification_tolerance <= 0):
                raise ValueError(
                    f"spectrum sample {sample_index} mode {raw_mode_index} has invalid certification_tolerance")
            certification_tolerance = float(certification_tolerance)
            full_certified = block.get("full_descriptor_certified")
            reduced_certified = block.get("reduced_pencil_certified")
            declared_reduced = residual_value(
                block, "eps_reduced", required=(scope != "native_descriptor"))
            declared_full = residual_value(
                block, "eps_full", required=(scope in (
                    "native_descriptor", "full_projected_weak_form_and_periodic_seams")))

            if scope == "native_descriptor":
                if block.get("certified") is not True or full_certified is not True:
                    raise ValueError(
                        f"spectrum sample {sample_index} mode {raw_mode_index} has an incomplete full descriptor certificate")
                expected_residual = reduced_max
                if declared_full is None or not math.isclose(
                        declared_full, expected_residual, rel_tol=1e-12, abs_tol=1e-30):
                    raise ValueError(
                        f"spectrum sample {sample_index} mode {raw_mode_index} eps_full is inconsistent")
            elif scope == "reduced_original_blocks_only":
                if (reduced_certified is not True or full_certified is not False or
                        block.get("certified") is not False):
                    raise ValueError(
                        f"spectrum sample {sample_index} mode {raw_mode_index} has an incomplete reduced-pencil certificate")
                if (declared_full is not None or declared_reduced is None or not math.isclose(
                        declared_reduced, reduced_max, rel_tol=1e-12, abs_tol=1e-30)):
                    raise ValueError(
                        f"spectrum sample {sample_index} mode {raw_mode_index} eps_reduced is inconsistent")
                expected_residual = reduced_max
            else:
                if (block.get("certified") is not True or reduced_certified is not True or
                        full_certified is not True):
                    raise ValueError(
                        f"spectrum sample {sample_index} mode {raw_mode_index} has an incomplete Floquet full-descriptor certificate")
                if (declared_reduced is None or not math.isclose(
                        declared_reduced, reduced_max, rel_tol=1e-12, abs_tol=1e-30)):
                    raise ValueError(
                        f"spectrum sample {sample_index} mode {raw_mode_index} eps_reduced is inconsistent")
                if eps_gauge is not None:
                    raise ValueError(
                        f"spectrum sample {sample_index} mode {raw_mode_index} reports a gauge residual without a nonzero-k gauge equation")
                if (mode.get("potential_representation") != "complex_coefficients" or
                        mode.get("gauge_constraint_policy") != "nonzero_k_poisson_without_mean_constraint" or
                        mode.get("gauge_constraint_backward_error") is not None or
                        mode.get("floquet_descriptor_certified") is not True or
                        mode.get("floquet_full_descriptor_certified") is not True or
                        mode.get("floquet_seam_frame_certified") is not True or
                        mode.get("floquet_gauge_policy_satisfied") is not True or
                        not isinstance(mode.get("poisson_boundary_kind"), str) or
                        not mode["poisson_boundary_kind"] or
                        not isinstance(mode.get("poisson_gauge_policy"), str) or
                        not mode["poisson_gauge_policy"]):
                    raise ValueError(
                        f"spectrum sample {sample_index} mode {raw_mode_index} has inconsistent Floquet boundary or gauge provenance")

                full_values = [
                    residual_value(mode, "floquet_full_magnetic_relative_residual"),
                    residual_value(mode, "floquet_full_potential_relative_residual"),
                ]
                expected_full = max(full_values)
                if declared_full is None or not math.isclose(
                        declared_full, expected_full, rel_tol=1e-12, abs_tol=1e-30):
                    raise ValueError(
                        f"spectrum sample {sample_index} mode {raw_mode_index} eps_full is inconsistent")
                if not math.isclose(
                        eps_q, residual_value(mode, "magnetic_relative_residual"),
                        rel_tol=1e-12, abs_tol=1e-30):
                    raise ValueError(
                        f"spectrum sample {sample_index} mode {raw_mode_index} eps_q disagrees with magnetic residual")
                if not math.isclose(
                        eps_phi, residual_value(mode, "potential_relative_residual"),
                        rel_tol=1e-12, abs_tol=1e-30):
                    raise ValueError(
                        f"spectrum sample {sample_index} mode {raw_mode_index} eps_phi disagrees with potential residual")
                seam_values = [residual_value(mode, name) for name in (
                    "floquet_scalar_phase_seam_relative_residual",
                    "floquet_tangent_frame_seam_relative_residual",
                    "floquet_cartesian_magnetic_seam_relative_residual",
                    "floquet_equilibrium_pair_relative_residual",
                )]
                expected_residual = max(reduced_max, expected_full, *seam_values)

            if expected_residual > certification_tolerance:
                raise ValueError(
                    f"spectrum sample {sample_index} mode {raw_mode_index} exceeds its block certification tolerance")
            if not math.isclose(float(residual), expected_residual, rel_tol=1e-12, abs_tol=1e-30):
                raise ValueError(
                    f"mode {raw_mode_index} residual_relative_l2 does not match its certified residual scope")

            result[key] = {
                "frequency_hz": float(frequency),
                "residual_relative_l2": float(residual),
                "residual_scope": scope,
                "full_descriptor_certified": full_certified,
                "certification_tolerance": certification_tolerance,
                "block_residuals": block,
                "poisson_boundary_kind": mode.get("poisson_boundary_kind"),
                "poisson_gauge_policy": mode.get("poisson_gauge_policy"),
            }
    return result


def _validate_dynamic_demag_probe(sample_index, probe, *, subwindow_index=None):
    context = f"sample {sample_index}"
    if subwindow_index is not None:
        context += f" subwindow {subwindow_index}"
    if not isinstance(probe, dict):
        raise ValueError(f"{context} is missing dynamic_demag_operator_probe")
    if probe.get("schema_version") != "floquet_dynamic_demag_operator_probe.v1":
        raise ValueError(f"{context} has an unsupported dynamic demag probe schema")
    if probe.get("status") != "passed":
        raise ValueError(f"{context} dynamic demag probe did not pass")
    if probe.get("potential_equation") != "P_phi_plus_A_phiq_q_equals_zero":
        raise ValueError(f"{context} dynamic demag probe equation is invalid")
    if probe.get("potential_coefficient_unit") != "A" or probe.get("energy_unit") != "J":
        raise ValueError(f"{context} dynamic demag probe units are invalid")

    tolerance = probe.get("relative_tolerance")
    if (isinstance(tolerance, bool) or not isinstance(tolerance, (int, float)) or
            not math.isfinite(tolerance) or tolerance <= 0 or
            tolerance > MAX_PROBE_RELATIVE_TOLERANCE):
        raise ValueError(f"{context} dynamic demag probe tolerance is invalid")
    hermitian_defect = probe.get("hermitian_relative_defect")
    if (isinstance(hermitian_defect, bool) or not isinstance(hermitian_defect, (int, float)) or
            not math.isfinite(hermitian_defect) or hermitian_defect < 0 or
            hermitian_defect > tolerance):
        raise ValueError(f"{context} dynamic demag Hermitian defect exceeds tolerance")

    energy_values = []
    direction_reports = {}
    for direction in ("global_y", "global_z"):
        direction_sample = probe.get(direction)
        if (not isinstance(direction_sample, dict) or
                direction_sample.get("attempted") is not True or
                direction_sample.get("passed") is not True):
            raise ValueError(f"{context} dynamic demag {direction} probe is incomplete")
        q_norm = direction_sample.get("q_l2_norm")
        potential_residual = direction_sample.get("potential_relative_residual")
        energy_defect = direction_sample.get("energy_form_relative_defect")
        energy_self = direction_sample.get("self_energy_j")
        energy_potential = direction_sample.get("potential_energy_j")
        metrics = {
            "q_l2_norm": q_norm,
            "potential_relative_residual": potential_residual,
            "energy_form_relative_defect": energy_defect,
            "self_energy_j": energy_self,
            "potential_energy_j": energy_potential,
        }
        for name, value in metrics.items():
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError(f"{context} dynamic demag {direction}.{name} is invalid")
        if q_norm <= 0 or potential_residual < 0 or potential_residual > tolerance:
            raise ValueError(f"{context} dynamic demag {direction} residual is invalid")
        if energy_defect < 0 or energy_defect > tolerance:
            raise ValueError(f"{context} dynamic demag {direction} energy mismatch exceeds tolerance")
        energy_values.extend((energy_self, energy_potential))
        direction_reports[direction] = {
            "q_l2_norm": q_norm,
            "potential_relative_residual": potential_residual,
            "energy_form_relative_defect": energy_defect,
        }

    energy_scale = max((abs(value) for value in energy_values), default=0.0)
    energy_floor = tolerance * energy_scale
    if any(value < -energy_floor for value in energy_values):
        raise ValueError(f"{context} dynamic demag energy is negative")
    report = {
        "hermitian_relative_defect": hermitian_defect,
        "directions": direction_reports,
    }
    if subwindow_index is not None:
        report["subwindow_index"] = subwindow_index
    return report


def validate_dynamic_demag_probes(path: Path, required_sample_indices):
    diagnostics = load_solver_diagnostics(path)
    by_sample = diagnostics_by_sample(
        diagnostics,
        required_sample_indices,
        "dynamic_demag_operator_probe")

    accepted = []
    for sample_index in required_sample_indices:
        sample_diagnostics = by_sample.get(sample_index)
        if sample_diagnostics is None:
            raise ValueError(f"missing solver diagnostics for nonzero-k sample {sample_index}")
        subwindows = sample_diagnostics.get("subwindows")
        if subwindows is None:
            probe_report = _validate_dynamic_demag_probe(
                sample_index,
                sample_diagnostics.get("dynamic_demag_operator_probe"))
            accepted.append({
                "sample_index": sample_index,
                "status": "passed",
                **probe_report,
            })
            continue
        if not isinstance(subwindows, list) or not subwindows:
            raise ValueError(f"sample {sample_index} has invalid dynamic demag subwindows")

        subwindow_reports = []
        seen_subwindow_indices = set()
        for position, subwindow in enumerate(subwindows):
            if not isinstance(subwindow, dict):
                raise ValueError(f"sample {sample_index} subwindow record {position} is invalid")
            subwindow_index = subwindow.get("index")
            if (isinstance(subwindow_index, bool) or not isinstance(subwindow_index, int) or
                    subwindow_index < 0):
                raise ValueError(f"sample {sample_index} subwindow record {position} has invalid index")
            if subwindow_index in seen_subwindow_indices:
                raise ValueError(f"sample {sample_index} has duplicate subwindow index {subwindow_index}")
            seen_subwindow_indices.add(subwindow_index)
            subwindow_reports.append(_validate_dynamic_demag_probe(
                sample_index,
                subwindow.get("dynamic_demag_operator_probe"),
                subwindow_index=subwindow_index))
        accepted.append({
            "sample_index": sample_index,
            "status": "passed",
            "subwindow_count": len(subwindow_reports),
            "subwindows": subwindow_reports,
        })
    return accepted


def validate_gamma_demag_probe(
    solver_diagnostics_path: Path,
    metadata_path: Path,
    gamma_sample_index: int):
    diagnostics = load_solver_diagnostics(solver_diagnostics_path)
    by_sample = diagnostics_by_sample(
        diagnostics,
        [gamma_sample_index],
        "poisson_airbox_k0_demag_operator_probe")
    sample_diagnostics = by_sample.get(gamma_sample_index)
    if sample_diagnostics is None:
        raise ValueError(f"missing Gamma solver diagnostics for sample {gamma_sample_index}")
    probe = sample_diagnostics.get("poisson_airbox_k0_demag_operator_probe")
    if not isinstance(probe, dict):
        raise ValueError("Gamma sample is missing poisson_airbox_k0_demag_operator_probe")
    if probe.get("schema_version") != "poisson_airbox_k0_demag_operator_probe.v1":
        raise ValueError("Gamma sample has an unsupported K0 demag probe schema")
    if probe.get("status") != "passed":
        raise ValueError("Gamma K0 demag probe did not pass")
    if probe.get("potential_equation") != "P_phi_plus_A_phiq_q_equals_zero":
        raise ValueError("Gamma K0 demag probe equation is invalid")
    if (probe.get("potential_coefficient_unit") != "A" or
            probe.get("field_unit") != "A/m" or probe.get("energy_unit") != "J"):
        raise ValueError("Gamma K0 demag probe units are invalid")
    if probe.get("outer_boundary_kind") != "poisson_dirichlet":
        raise ValueError("Gamma K0 demag probe must use the declared Dirichlet airbox")
    beta = probe.get("robin_beta")
    if isinstance(beta, bool) or not isinstance(beta, (int, float)) or beta != 0.0:
        raise ValueError("Gamma K0 demag probe has unexpected Robin data")
    tolerance = probe.get("relative_tolerance")
    if (isinstance(tolerance, bool) or not isinstance(tolerance, (int, float)) or
            not math.isfinite(tolerance) or tolerance <= 0 or
            tolerance > MAX_PROBE_RELATIVE_TOLERANCE):
        raise ValueError("Gamma K0 demag probe tolerance is invalid")

    try:
        metadata = json.loads(Path(metadata_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("missing or invalid DE-SMOKE run metadata") from error
    try:
        model = metadata["problem_meta"]["runtime_metadata"]["de_smoke"]
    except (KeyError, TypeError) as error:
        raise ValueError("run metadata is missing the frozen DE-SMOKE model parameters") from error
    if not isinstance(model, dict) or model.get("schema") != "fullmag.de-smoke.v1":
        raise ValueError("run metadata has an unsupported DE-SMOKE model descriptor")
    if model.get("orientation") not in ("M0=x,k=y,normal=z", "M0=x,k=x,normal=z"):
        raise ValueError("Gamma demag reference requires M0=x and film normal z")
    if model.get("outer_boundary_kind") != "poisson_dirichlet":
        raise ValueError("DE-SMOKE metadata does not declare the tested Dirichlet boundary")

    def positive_model_value(name):
        value = model.get(name)
        if (isinstance(value, bool) or not isinstance(value, (int, float)) or
                not math.isfinite(value) or value <= 0):
            raise ValueError(f"DE-SMOKE metadata field {name} must be finite and positive")
        return float(value)

    thickness = positive_model_value("film_thickness_m")
    period = positive_model_value("cell_period_m")
    padding = positive_model_value("air_padding_each_side_m")
    expected_ms = positive_model_value("saturation_magnetization_a_per_m")
    expected_mu0 = positive_model_value("mu0_t_m_a")
    expected_volume = period * period * thickness
    expected_nz = 2.0 * padding / (2.0 * padding + thickness)
    volume = probe.get("magnetic_volume_m3")
    mu0 = probe.get("mu0_t_m_a")
    for name, value in (("magnetic_volume_m3", volume), ("mu0_t_m_a", mu0)):
        if (isinstance(value, bool) or not isinstance(value, (int, float)) or
                not math.isfinite(value) or value <= 0):
            raise ValueError(f"Gamma K0 demag probe {name} is invalid")
    if abs(volume - expected_volume) > GEOMETRY_RELATIVE_TOLERANCE * expected_volume:
        raise ValueError("Gamma K0 demag probe magnetic volume disagrees with the declared geometry")
    if abs(mu0 - expected_mu0) > 1e-12 * expected_mu0:
        raise ValueError("Gamma K0 demag probe mu0 disagrees with the declared SI convention")

    directions = {}
    for direction in ("global_y", "global_z"):
        sample = probe.get(direction)
        if (not isinstance(sample, dict) or sample.get("attempted") is not True or
                sample.get("passed") is not True):
            raise ValueError(f"Gamma K0 {direction} probe is incomplete")
        metrics = (
            "q_l2_norm", "potential_relative_residual", "gauge_constraint_abs",
            "mean_field_a_per_m", "mean_magnetization_a_per_m", "demag_factor",
            "potential_energy_j", "magnetic_energy_j", "energy_form_relative_defect")
        values = {}
        for name in metrics:
            value = sample.get(name)
            if (isinstance(value, bool) or not isinstance(value, (int, float)) or
                    not math.isfinite(value)):
                raise ValueError(f"Gamma K0 {direction}.{name} is invalid")
            values[name] = float(value)
        if values["q_l2_norm"] <= 0 or values["potential_relative_residual"] < 0 or \
                values["potential_relative_residual"] > tolerance:
            raise ValueError(f"Gamma K0 {direction} potential residual is invalid")
        if values["gauge_constraint_abs"] < 0:
            raise ValueError(f"Gamma K0 {direction} gauge residual is invalid")
        if values["energy_form_relative_defect"] < 0 or \
                values["energy_form_relative_defect"] > tolerance:
            raise ValueError(f"Gamma K0 {direction} energy identity exceeds tolerance")
        energy_scale = max(abs(values["potential_energy_j"]),
                           abs(values["magnetic_energy_j"]), 1e-300)
        if min(values["potential_energy_j"], values["magnetic_energy_j"]) < \
                -tolerance * energy_scale:
            raise ValueError(f"Gamma K0 {direction} magnetostatic energy is negative")
        if abs(values["mean_magnetization_a_per_m"] - expected_ms) > \
                GEOMETRY_RELATIVE_TOLERANCE * expected_ms:
            raise ValueError(f"Gamma K0 {direction} perturbation magnetization disagrees with Ms")
        reconstructed_factor = -values["mean_field_a_per_m"] / \
            values["mean_magnetization_a_per_m"]
        if not math.isclose(values["demag_factor"], reconstructed_factor,
                            rel_tol=1e-8, abs_tol=1e-10):
            raise ValueError(f"Gamma K0 {direction} demag factor does not match its measured field")
        directions[direction] = {
            "demag_factor": values["demag_factor"],
            "mean_field_a_per_m": values["mean_field_a_per_m"],
            "mean_magnetization_a_per_m": values["mean_magnetization_a_per_m"],
            "potential_relative_residual": values["potential_relative_residual"],
            "energy_form_relative_defect": values["energy_form_relative_defect"],
        }

    if abs(directions["global_y"]["demag_factor"]) > GAMMA_NY_ABSOLUTE_TOLERANCE:
        raise ValueError("Gamma in-plane probe has nonzero demag for the ideal film")
    measured_nz = directions["global_z"]["demag_factor"]
    if abs(measured_nz - expected_nz) / expected_nz > GAMMA_NZ_RELATIVE_TOLERANCE:
        raise ValueError("Gamma out-of-plane demag disagrees with the finite Dirichlet airbox")
    return {
        "sample_index": gamma_sample_index,
        "status": "passed",
        "expected_nz_from_geometry": expected_nz,
        "measured_nz": measured_nz,
        "relative_nz_error": abs(measured_nz - expected_nz) / expected_nz,
        "magnetic_volume_m3": volume,
        "outer_boundary_kind": probe["outer_boundary_kind"],
        "directions": directions,
    }


def validate_rows(path: Path, sampling: str, solver_diagnostics_path: Path,
                  metadata_path: Path | None = None, *,
                  selection_scope: str = "frequency_window"):
    if sampling not in SAMPLING:
        raise ValueError("unsupported DE-SMOKE sampling")
    if selection_scope not in {"frequency_window", "selected_only"}:
        raise ValueError("unsupported DE-SMOKE selection scope")
    expected = SAMPLING[sampling]
    if sampling == UI_SEVEN_SAMPLING and selection_scope != "selected_only":
        raise ValueError("ui-seven DE-SMOKE requires selected-only validation")
    if (selection_scope == "selected_only" and len(expected) != 1 and
            sampling != UI_SEVEN_SAMPLING):
        raise ValueError("selected-only DE-SMOKE validation requires one k sample")
    required_probe_samples = [index for index, wavevector in enumerate(expected) if wavevector != 0.0]
    if not required_probe_samples and sampling not in ("k0", "bv-k0"):
        raise ValueError("DE-SMOKE sampling must include a nonzero-k probe")
    probe_reports = (validate_dynamic_demag_probes(solver_diagnostics_path, required_probe_samples)
                     if required_probe_samples else [])
    gamma_indices = [index for index, wavevector in enumerate(expected) if wavevector == 0.0]
    gamma_report = None
    if gamma_indices:
        if metadata_path is None:
            raise ValueError("DE-SMOKE Gamma validation requires run metadata with geometry parameters")
        gamma_report = validate_gamma_demag_probe(
            solver_diagnostics_path, metadata_path, gamma_indices[0])
    if metadata_path is None:
        raise ValueError("DE-SMOKE residual validation requires model metadata")
    try:
        metadata = json.loads(Path(metadata_path).read_text(encoding="utf-8"))
        model = metadata["problem_meta"]["runtime_metadata"]["de_smoke"]
    except (OSError, json.JSONDecodeError, KeyError, TypeError) as error:
        raise ValueError("run metadata is missing the DE-SMOKE solver tolerance") from error
    if not isinstance(model, dict) or model.get("schema") != "fullmag.de-smoke.v1":
        raise ValueError("run metadata has an unsupported DE-SMOKE model descriptor")
    expected_orientation = "M0=x,k=x,normal=z" if sampling.startswith("bv-") else "M0=x,k=y,normal=z"
    if sampling not in ("two", "five", "k0", "k2", "signed-eleven"):
        if model.get("orientation") != expected_orientation or model.get("sampling") != sampling:
            raise ValueError("DE/BV geometry metadata disagrees with the requested sampling")
        expected_vectors = [[k, 0.0, 0.0] if sampling.startswith("bv-") else [0.0, k, 0.0] for k in expected]
        if model.get("k_vectors_rad_per_m") != expected_vectors:
            raise ValueError("DE/BV wavevector metadata disagrees with the requested sampling")
    solver_rtol = model.get("eigen_solver_rtol") if isinstance(model, dict) else None
    if (isinstance(solver_rtol, bool) or not isinstance(solver_rtol, (int, float)) or
            not math.isfinite(solver_rtol) or solver_rtol <= 0):
        raise ValueError("DE-SMOKE eigen_solver_rtol must be finite and positive")
    if sampling == UI_SEVEN_SAMPLING:
        if solver_rtol != 1e-8:
            raise ValueError("ui-seven DE-SMOKE solver tolerance must be exactly 1e-8")
        requested_mode_count = model.get("requested_mode_count")
        if (isinstance(requested_mode_count, bool) or
                not isinstance(requested_mode_count, int) or requested_mode_count != 1):
            raise ValueError("ui-seven DE-SMOKE metadata must request exactly one mode")
    native_modes = load_spectrum_v3_modes(Path(path).parent / "spectrum.v3.json")
    if sampling == UI_SEVEN_SAMPLING:
        expected_mode_keys = {(sample_index, 0) for sample_index in range(len(expected))}
        if set(native_modes) != expected_mode_keys:
            raise ValueError(
                "ui-seven selected-only spectrum requires exactly raw mode 0 for samples 0 through 6")
    if sampling == "parallel-probe":
        expected_mode_keys = {(sample_index, 0) for sample_index in range(len(expected))}
        if set(native_modes) != expected_mode_keys:
            raise ValueError(
                "parallel probe spectrum requires exactly one mode (raw_mode_index=0) per sample")
    if sampling in DENSE_SAMPLING:
        if ({sample for sample, _ in native_modes} != set(range(len(expected))) or
                len(native_modes) != len(expected)):
            raise ValueError("dense DE/BV spectrum requires exactly one mode for each requested sample")
        for (sample, _), mode in native_modes.items():
            required_scope = ("native_descriptor" if expected[sample] == 0.0 else
                              "full_projected_weak_form_and_periodic_seams")
            if mode["residual_scope"] != required_scope:
                raise ValueError("dense DE/BV full descriptor scope disagrees with Gamma/nonzero-k operator")
            if expected[sample] != 0.0 and (
                    mode["poisson_boundary_kind"] != "poisson_dirichlet" or
                    mode["poisson_gauge_policy"] != "none"):
                raise ValueError("dense DE/BV nonzero-k certificate has unexpected Poisson boundary or gauge")

    rows = []
    seen = set()
    seen_branch = set()
    with Path(path).open(encoding="utf-8-sig", newline="") as stream:
        for row in csv.DictReader(stream):
            indices = {}
            for key in ("sample_index", "raw_mode_index", "branch_id"):
                text = row.get(key, "")
                if not isinstance(text, str) or not text.isascii() or not text.isdecimal():
                    raise ValueError(f"invalid {key}")
                indices[key] = int(text)
            sample = indices["sample_index"]
            if sample >= len(expected):
                raise ValueError("sample index outside the requested path")
            values = {}
            for key in ("kx_rad_per_m", "ky_rad_per_m", "kz_rad_per_m", "frequency_hz"):
                try:
                    values[key] = float(row[key])
                except (KeyError, TypeError, ValueError) as error:
                    raise ValueError(f"missing or invalid {key}") from error
                if not math.isfinite(values[key]):
                    raise ValueError(f"nonfinite {key}")
            absolute_residual_text = row.get("residual_norm")
            if absolute_residual_text is None or absolute_residual_text.strip() == "":
                values["residual_norm"] = None
            else:
                try:
                    values["residual_norm"] = float(absolute_residual_text)
                except (TypeError, ValueError) as error:
                    raise ValueError("invalid absolute residual_norm") from error
                if not math.isfinite(values["residual_norm"]):
                    raise ValueError("nonfinite residual_norm")
                if values["residual_norm"] < 0:
                    raise ValueError("absolute residual must be nonnegative")
            transverse_key = "ky_rad_per_m" if sampling.startswith("bv-") else "kx_rad_per_m"
            propagation_key = "kx_rad_per_m" if sampling.startswith("bv-") else "ky_rad_per_m"
            if values[transverse_key] != 0 or values["kz_rad_per_m"] != 0:
                raise ValueError("wavevector is outside the requested propagation direction")
            if not math.isclose(values[propagation_key], expected[sample], rel_tol=1e-12, abs_tol=1e-12):
                raise ValueError("wavevector does not match its sample index")
            if selection_scope == "frequency_window":
                if sampling == "parallel-probe":
                    frequency_min, frequency_max = PARALLEL_PROBE_FREQUENCY_WINDOW_HZ
                else:
                    frequency_min = 12e9 if sampling in ("k25", "k-25") else 8.5e9
                    wide_de_window = (sampling in ("positive-six", "positive-26", "signed-fifteen") or
                                      (not sampling.startswith("bv-") and len(expected) == 1 and abs(expected[0]) >= 15e6))
                    frequency_max = 16e9 if wide_de_window else 12e9
                if not frequency_min <= values["frequency_hz"] <= frequency_max:
                    raise ValueError("frequency outside the frozen DE-SMOKE window")
            mode_key = (sample, indices["raw_mode_index"])
            mode = native_modes.get(mode_key)
            if sampling in DENSE_SAMPLING and mode is not None and not mode["full_descriptor_certified"]:
                raise ValueError("dense DE/BV path requires full descriptor certification for every sample")
            if mode is None:
                raise ValueError(
                    f"spectrum.v3.json is missing sample {sample} mode {indices['raw_mode_index']}")
            if not math.isclose(
                    values["frequency_hz"], mode["frequency_hz"],
                    rel_tol=1e-12, abs_tol=1e-6):
                raise ValueError("dispersion CSV frequency disagrees with native spectrum mode")
            block = mode["block_residuals"]
            effective_tolerance = min(
                float(solver_rtol), mode["certification_tolerance"])
            if sampling in DENSE_SAMPLING:
                effective_tolerance = min(effective_tolerance, DENSE_CERTIFICATION_TOLERANCE)
            if mode["residual_relative_l2"] > effective_tolerance:
                raise ValueError(
                    f"mode residual_relative_l2={mode['residual_relative_l2']:.6g} exceeds solver tolerance {effective_tolerance:.6g}")
            for name in ("eps_q", "eps_phi", "eps_gauge"):
                if block[name] is not None and block[name] > effective_tolerance:
                    raise ValueError(
                        f"mode block residual {name}={block[name]:.6g} exceeds solver tolerance {effective_tolerance:.6g}")
            key = (sample, indices["raw_mode_index"])
            branch_key = (sample, indices["branch_id"])
            if key in seen or branch_key in seen_branch:
                raise ValueError("duplicate mode or branch in a sample")
            seen.add(key)
            seen_branch.add(branch_key)
            rows.append({
                **indices,
                **values,
                "residual_relative_l2": mode["residual_relative_l2"],
                "residual_scope": mode["residual_scope"],
                "full_descriptor_certified": mode["full_descriptor_certified"],
            })
    if sampling in DENSE_SAMPLING and len(rows) != len(expected):
        raise ValueError("dense DE/BV rows require exactly one mode for each requested sample")
    if sampling == UI_SEVEN_SAMPLING and (
            len(rows) != len(expected) or
            any(row["raw_mode_index"] != 0 for row in rows)):
        raise ValueError(
            "ui-seven selected-only rows require exactly raw mode 0 for samples 0 through 6")
    if sampling == "parallel-probe" and (
            len(rows) != len(expected) or
            any(row["raw_mode_index"] != 0 for row in rows)):
        raise ValueError(
            "parallel probe rows require exactly one mode (raw_mode_index=0) per sample")
    if {r["sample_index"] for r in rows} != set(range(len(expected))):
        raise ValueError("missing DE-SMOKE samples")
    pending_requirements = [
        "numeric-source attestation",
        "complex fields, Bloch phase and mesh identity",
        "explicit n0 branch identification and analytical comparison",
        "mesh, airbox and mode-count convergence"]
    if not all(row["full_descriptor_certified"] for row in rows):
        pending_requirements.insert(1, "full descriptor and Floquet phase/frame seam certification")
    if sampling in ("k0", "bv-k0"):
        pending_requirements.insert(1, "Gamma mode profile and finite-box frequency comparison")
    elif gamma_report is None:
        pending_requirements.insert(1, "T4 Gamma operator probe and finite-box Nz comparison")
    else:
        pending_requirements.insert(1, "T4 nonzero-k field/phase and independent 1D comparison")
    residual_scopes = {row["residual_scope"] for row in rows}
    absolute_residuals = [row["residual_norm"] for row in rows
                          if row["residual_norm"] is not None]
    return {"schema": "fullmag.de-smoke-row-preflight.v2", "status": "pass",
            "qualification": "NOT VERIFIED", "sampling": sampling,
            "selection_scope": selection_scope,
            "mode_rows": len(rows), "sample_count": len(expected),
            "max_absolute_residual_norm": max(absolute_residuals) if absolute_residuals else None,
            "max_relative_residual_l2": max(r["residual_relative_l2"] for r in rows),
            "residual_scope": next(iter(residual_scopes)) if len(residual_scopes) == 1 else "mixed",
            "full_descriptor_certified": all(r["full_descriptor_certified"] for r in rows),
            "gamma_demag_operator_probe": gamma_report,
            "dynamic_demag_operator_probes": probe_reports,
            "pending_requirements": pending_requirements}
