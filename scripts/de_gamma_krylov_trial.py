"""Fail-closed consumer for the standalone and mixed-sweep K0 Krylov query."""
from __future__ import annotations

import math
from pathlib import Path

from validate_de_smoke_rows import SAMPLING, diagnostics_by_sample, load_solver_diagnostics


_SCHEMA = "k0_common_krylov_configuration_trial.v1"
_K0_SOLVER_ADAPTER = "k0_poisson_airbox_cpu_schur_slepc"
_K0_ENGINE_ID = "native_fem.frequency_domain.k0_poisson_airbox_cpu_schur_slepc.v1"
_KSP_TYPES = frozenset(("gmres", "fgmres"))
_QUERY_FIELDS = (
    "eps_tolerance",
    "eps_max_iterations",
    "shifted_ksp_type",
    "shifted_ksp_rtol",
    "shifted_ksp_max_iterations",
    "shifted_ksp_restart",
)
_NUMBER_TOLERANCE_REL = 1e-12
_WINDOW_CERTIFICATE_SCHEMA = "poisson_airbox_frequency_window_certificate.v1"
_WINDOW_PASSES = (("base", "base_schedule"), ("refinement", "refinement_schedule"))
_EPS_DIMENSIONS_FIELDS = ("nev", "ncv", "mpd")
_EPS_DIMENSIONS_KEYS = frozenset(("query_succeeded", *_EPS_DIMENSIONS_FIELDS))
_SIGNED_INT64_MIN = -(2 ** 63)
_SIGNED_INT64_MAX = (2 ** 63) - 1


def _required_object(value, name):
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be an object")
    return value


def _validate_eps_dimensions(value, name):
    dimensions = _required_object(value, name)
    for field in ("query_succeeded", *_EPS_DIMENSIONS_FIELDS):
        if field not in dimensions:
            raise ValueError(f"{name}.{field} is missing")
    extra_keys = [key for key in dimensions if key not in _EPS_DIMENSIONS_KEYS]
    if extra_keys:
        raise ValueError(f"{name} has unexpected key {extra_keys[0]!r}")

    query_succeeded = dimensions["query_succeeded"]
    if type(query_succeeded) is not bool:
        raise ValueError(f"{name}.query_succeeded must be a boolean")
    for field in _EPS_DIMENSIONS_FIELDS:
        dimension = dimensions[field]
        field_name = f"{name}.{field}"
        if not query_succeeded:
            if dimension is not None:
                raise ValueError(f"{field_name} must be null when query_succeeded is false")
            continue
        if type(dimension) is not int:
            raise ValueError(f"{field_name} must be an integer when query_succeeded is true")
        if not _SIGNED_INT64_MIN <= dimension <= _SIGNED_INT64_MAX:
            raise ValueError(f"{field_name} must be within signed 64-bit range")
    return dict(dimensions)


def _required_integer(value, name, *, minimum=None):
    if type(value) is not int or (minimum is not None and value < minimum):
        raise ValueError(f"{name} must be an integer")
    return value


def _required_number(value, name, *, positive=False, nonnegative=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a finite number")
    try:
        number = float(value)
    except (OverflowError, ValueError):
        raise ValueError(f"{name} must be a finite number") from None
    if not math.isfinite(number):
        raise ValueError(f"{name} must be a finite number")
    if positive and number <= 0.0:
        raise ValueError(f"{name} must be positive")
    if nonnegative and number < 0.0:
        raise ValueError(f"{name} must be nonnegative")
    return number


def _required_positive_request(value, name):
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{name} must be a positive finite string")
    try:
        number = float(value)
    except (OverflowError, ValueError):
        raise ValueError(f"{name} must be a positive finite string") from None
    if not math.isfinite(number) or number <= 0.0:
        raise ValueError(f"{name} must be a positive finite string")
    return number


def _required_restart_request(value):
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("gmres_restart must be a positive integer string")
    try:
        restart = int(value)
    except (OverflowError, ValueError):
        raise ValueError("gmres_restart must be a positive integer string") from None
    if restart <= 0:
        raise ValueError("gmres_restart must be a positive integer string")
    return restart


def _matching_number(actual, expected):
    return math.isclose(actual, expected, rel_tol=_NUMBER_TOLERANCE_REL, abs_tol=0.0)


def _validate_gamma_vector(sample, sample_index):
    name = f"sample {sample_index}"
    vector_length = _required_integer(sample.get("k_vector_len"), f"{name}.k_vector_len", minimum=0)
    vector = sample.get("k_vector_rad_m")
    if vector_length != 3 or not isinstance(vector, list) or len(vector) != 3:
        raise ValueError(f"{name} has an invalid native k vector")
    actual = [
        _required_number(component, f"{name}.k_vector_rad_m[{axis}]")
        for axis, component in enumerate(vector)
    ]
    if any(component != 0.0 for component in actual):
        raise ValueError(f"{name} is not the Gamma point")
    return actual


def _validate_query(
    value,
    name,
    requested_type,
    requested_rtol,
    requested_eps,
    requested_restart,
    split_dof_count,
):
    query = _required_object(value, name)
    eps_dimensions = None
    if "eps_dimensions" in query:
        eps_dimensions = _validate_eps_dimensions(
            query["eps_dimensions"], f"{name}.eps_dimensions"
        )
    if query.get("phase") != "queried_after_eps":
        raise ValueError(f"{name}.phase must be queried_after_eps")

    eps_tolerance = _required_number(
        query.get("eps_tolerance"), f"{name}.eps_tolerance", positive=True
    )
    if requested_eps is not None and not _matching_number(eps_tolerance, requested_eps):
        raise ValueError(f"{name}.eps_tolerance disagrees with the request")

    if "eps_max_iterations" not in query:
        raise ValueError(f"{name}.eps_max_iterations is missing")
    eps_max_iterations = query["eps_max_iterations"]
    if eps_max_iterations is not None:
        eps_max_iterations = _required_integer(
            eps_max_iterations, f"{name}.eps_max_iterations", minimum=1
        )

    ksp_type = query.get("shifted_ksp_type")
    if not isinstance(ksp_type, str) or ksp_type not in _KSP_TYPES:
        raise ValueError(f"{name}.shifted_ksp_type must be gmres or fgmres")
    if ksp_type != requested_type:
        raise ValueError(f"{name}.shifted_ksp_type disagrees with the request")

    ksp_rtol = _required_number(
        query.get("shifted_ksp_rtol"), f"{name}.shifted_ksp_rtol", positive=True
    )
    if requested_rtol is not None and not _matching_number(ksp_rtol, requested_rtol):
        raise ValueError(f"{name}.shifted_ksp_rtol disagrees with the request")

    ksp_max_iterations = _required_integer(
        query.get("shifted_ksp_max_iterations"),
        f"{name}.shifted_ksp_max_iterations",
        minimum=1,
    )
    ksp_restart = _required_integer(
        query.get("shifted_ksp_restart"), f"{name}.shifted_ksp_restart", minimum=1
    )
    if requested_restart is not None:
        expected_restart = min(split_dof_count, requested_restart)
        if ksp_restart != expected_restart:
            raise ValueError(f"{name}.shifted_ksp_restart disagrees with the clamped request")
    elif ksp_restart > split_dof_count:
        raise ValueError(f"{name}.shifted_ksp_restart exceeds the split operator dimension")

    validated_query = {
        "phase": "queried_after_eps",
        "eps_tolerance": eps_tolerance,
        "eps_max_iterations": eps_max_iterations,
        "shifted_ksp_type": ksp_type,
        "shifted_ksp_rtol": ksp_rtol,
        "shifted_ksp_max_iterations": ksp_max_iterations,
        "shifted_ksp_restart": ksp_restart,
    }
    if eps_dimensions is not None:
        validated_query["eps_dimensions"] = eps_dimensions
    return validated_query


def _require_matching_query(expected, actual, name):
    for field in _QUERY_FIELDS:
        expected_value = expected[field]
        actual_value = actual[field]
        if field in ("eps_tolerance", "shifted_ksp_rtol"):
            matches = _matching_number(expected_value, actual_value)
        else:
            matches = type(expected_value) is type(actual_value) and expected_value == actual_value
        if not matches:
            raise ValueError(f"{name}.{field} disagrees with the sample/global query")


def validate_gamma_krylov_trial(
    case_dir: Path,
    sampling: str,
    requested_type: str,
    requested_rtol: str | None,
    *,
    eps_prefilter: str | None = None,
    gmres_restart: str | None = None,
):
    """Validate actual K0 EPS/ST queries without claiming residual or physics acceptance."""
    if not isinstance(sampling, str) or sampling not in SAMPLING:
        raise ValueError("Gamma Krylov trial has an unknown sampling name")
    if not isinstance(requested_type, str) or requested_type not in _KSP_TYPES:
        raise ValueError("Gamma Krylov requested_type must be gmres or fgmres")

    requested_rtol_value = _required_positive_request(requested_rtol, "requested_rtol")
    requested_eps_value = _required_positive_request(eps_prefilter, "eps_prefilter")
    requested_restart_value = _required_restart_request(gmres_restart)

    expected_wavevectors = SAMPLING[sampling]
    gamma_indices = [index for index, wavevector in enumerate(expected_wavevectors) if wavevector == 0.0]
    if not gamma_indices:
        raise ValueError("Gamma Krylov trial requires at least one Gamma sample")
    standalone_gamma = len(expected_wavevectors) == 1 and gamma_indices == [0]

    try:
        case_path = Path(case_dir)
    except TypeError:
        raise ValueError("Gamma Krylov case_dir must be path-like") from None
    diagnostics_path = case_path / "eigen" / "diagnostics" / "solver.v1.json"
    diagnostics = load_solver_diagnostics(diagnostics_path)
    schema = diagnostics.get("schema_version")
    if schema not in {"solver.v1", "frequency_domain_modal_solver_diagnostics.v1"}:
        raise ValueError("Gamma Krylov trial requires a supported native diagnostics schema")

    if diagnostics.get("sample_solver_diagnostics") is None and not standalone_gamma:
        raise ValueError("mixed Gamma sweeps require indexed per-sample diagnostics")
    by_sample = diagnostics_by_sample(diagnostics, gamma_indices, "subwindows")
    valid_indices = set(range(len(expected_wavevectors)))
    invalid_indices = sorted(index for index in by_sample if index not in valid_indices)
    if invalid_indices:
        raise ValueError(f"native solver diagnostics contain invalid sample indices: {invalid_indices}")
    missing_indices = [index for index in gamma_indices if index not in by_sample]
    if missing_indices:
        raise ValueError(f"missing native solver diagnostics for Gamma samples {missing_indices}")

    global_query = None
    if (standalone_gamma
            and diagnostics.get("solver_adapter") == _K0_SOLVER_ADAPTER
            and diagnostics.get("modal_krylov_tuning") is not None):
        global_q_dof_count = _required_integer(
            diagnostics.get("q_dof_count"), "global.q_dof_count", minimum=1
        )
        global_query = _validate_query(
            diagnostics["modal_krylov_tuning"],
            "global.modal_krylov_tuning",
            requested_type,
            requested_rtol_value,
            requested_eps_value,
            requested_restart_value,
            global_q_dof_count * 2,
        )

    accepted_by_sample = {}
    for sample_index in gamma_indices:
        sample = _required_object(by_sample[sample_index], f"sample {sample_index}.diagnostics")
        if sample.get("solver_adapter") != _K0_SOLVER_ADAPTER:
            raise ValueError(
                f"sample {sample_index}.solver_adapter must identify the native K0 Schur CPU adapter"
            )
        if sample.get("engine_id") != _K0_ENGINE_ID:
            raise ValueError(f"sample {sample_index} has an unexpected native engine_id")
        vector = _validate_gamma_vector(sample, sample_index)
        q_dof_count = _required_integer(sample.get("q_dof_count"), f"sample {sample_index}.q_dof_count", minimum=1)
        split_dof_count = 2 * q_dof_count
        sample_query = _validate_query(
            sample.get("modal_krylov_tuning"),
            f"sample {sample_index}.modal_krylov_tuning",
            requested_type,
            requested_rtol_value,
            requested_eps_value,
            requested_restart_value,
            split_dof_count,
        )
        if global_query is not None:
            _require_matching_query(global_query, sample_query, f"sample {sample_index}.modal_krylov_tuning")

        certificate = _required_object(
            sample.get("window_certificate"), f"sample {sample_index}.window_certificate"
        )
        if certificate.get("schema_version") != _WINDOW_CERTIFICATE_SCHEMA:
            raise ValueError(f"sample {sample_index} has an unsupported window certificate")
        planned_by_pass = {}
        for pass_name, schedule_field in _WINDOW_PASSES:
            schedule = _required_object(
                certificate.get(schedule_field),
                f"sample {sample_index}.window_certificate.{schedule_field}",
            )
            planned_by_pass[pass_name] = _required_integer(
                schedule.get("planned_subwindow_count"),
                f"sample {sample_index}.window_certificate.{schedule_field}.planned_subwindow_count",
                minimum=1,
            )

        subwindows = sample.get("subwindows")
        if not isinstance(subwindows, list) or not subwindows:
            raise ValueError(f"sample {sample_index} has no executed K0 subwindows")
        accepted_windows = []
        seen_by_pass = {pass_name: set() for pass_name, _ in _WINDOW_PASSES}
        for position, window_value in enumerate(subwindows):
            name = f"sample {sample_index} subwindow {position}"
            window = _required_object(window_value, name)
            pass_name = window.get("pass")
            if pass_name not in seen_by_pass:
                raise ValueError(f"{name}.pass must be base or refinement")
            subwindow_index = _required_integer(
                window.get("subwindow_index"), f"{name}.subwindow_index", minimum=0
            )
            pass_indices = seen_by_pass[pass_name]
            if subwindow_index in pass_indices:
                raise ValueError(f"sample {sample_index} has duplicate (pass, subwindow_index) identities")
            pass_indices.add(subwindow_index)
            if window.get("status") != "ok":
                raise ValueError(f"{name} did not finish with status ok")
            window_query = _validate_query(
                window.get("modal_krylov_tuning"),
                f"{name}.modal_krylov_tuning",
                requested_type,
                requested_rtol_value,
                requested_eps_value,
                requested_restart_value,
                split_dof_count,
            )
            _require_matching_query(sample_query, window_query, f"{name}.modal_krylov_tuning")
            accepted_windows.append({"pass": pass_name, "subwindow_index": subwindow_index, **window_query})
        for pass_name, planned_count in planned_by_pass.items():
            if seen_by_pass[pass_name] != set(range(planned_count)):
                raise ValueError(
                    f"sample {sample_index} {pass_name} subwindow identities do not match the native schedule"
                )
        pass_order = {name: position for position, (name, _) in enumerate(_WINDOW_PASSES)}
        accepted_windows.sort(key=lambda item: (pass_order[item["pass"]], item["subwindow_index"]))
        accepted_sample = {
            "sample_index": sample_index,
            "solver_adapter": _K0_SOLVER_ADAPTER,
            "engine_id": _K0_ENGINE_ID,
            "k_vector_rad_m": vector,
            "q_dof_count": q_dof_count,
            "subwindow_count": len(accepted_windows),
            "subwindows": accepted_windows,
        }
        if "eps_dimensions" in sample_query:
            accepted_sample["eps_dimensions"] = sample_query["eps_dimensions"]
        accepted_by_sample[sample_index] = accepted_sample

    report = {
        "schema": _SCHEMA,
        "status": "pass",
        "qualification": "NOT VERIFIED",
        "sampling": sampling,
        "requested_type": requested_type,
        "requested_rtol": requested_rtol_value,
        "requested_eps_prefilter": requested_eps_value,
        "requested_gmres_restart": requested_restart_value,
        "sample_count": len(accepted_by_sample),
        "by_sample": accepted_by_sample,
        "pending_requirements": [
            "native managed execution and solver receipt identity",
            "frequency, physical residual, equilibrium, and convergence gates",
        ],
    }
    if global_query is not None and "eps_dimensions" in global_query:
        report["eps_dimensions"] = global_query["eps_dimensions"]
    return report
