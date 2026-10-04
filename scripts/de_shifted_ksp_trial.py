"""Fail-closed consumer for the explicit nonzero-k shifted-KSP trial."""
from __future__ import annotations

import math
from pathlib import Path

from validate_de_smoke_rows import (
    SAMPLING,
    diagnostics_by_sample,
    load_solver_diagnostics,
)


_CRITERION_SCHEMA = "floquet_shifted_ksp_true_residual_criterion.v1"
_CRITERION_REFERENCE = "rhs_norm_zero_initial_guess"
_KSP_TYPES = frozenset(("gmres", "fgmres"))
_SAMPLE_TOLERANCE_REL = 1e-12


def _required_object(value, name):
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be an object")
    return value


def _required_string(value, name):
    if not isinstance(value, str) or not value:
        raise ValueError(f"{name} must be a non-empty string")
    return value


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


def _matching_number(actual, expected):
    return math.isclose(actual, expected, rel_tol=_SAMPLE_TOLERANCE_REL, abs_tol=0.0)


def _configured_breakdown_tolerance(payload, name, requested_type):
    if "ksp_breakdown_tolerance" not in payload:
        raise ValueError(f"{name}.ksp_breakdown_tolerance is missing")
    value = payload["ksp_breakdown_tolerance"]
    if requested_type == "fgmres":
        if value is not None:
            raise ValueError(f"{name}.ksp_breakdown_tolerance must be null for FGMRES")
        return None
    if value is None:
        raise ValueError(f"{name}.ksp_breakdown_tolerance is unavailable for GMRES")
    return _required_number(value, f"{name}.ksp_breakdown_tolerance", positive=True)


def _validate_ksp_configuration(payload, name, requested_type, rtol_limit,
                                expected_rtol=None, expected_atol=None,
                                expected_breakdown=None, check_breakdown=True):
    native_type = _required_string(payload.get("ksp_type"), f"{name}.ksp_type")
    if native_type != requested_type:
        raise ValueError(f"{name}.ksp_type disagrees with the requested KSP type")

    rtol = _required_number(payload.get("ksp_rtol"), f"{name}.ksp_rtol", positive=True)
    if rtol > rtol_limit:
        raise ValueError(f"{name}.ksp_rtol is looser than the requested/configured tolerance")
    if expected_rtol is not None and not _matching_number(rtol, expected_rtol):
        raise ValueError(f"{name}.ksp_rtol disagrees with the global native configuration")

    atol = _required_number(payload.get("ksp_atol"), f"{name}.ksp_atol", nonnegative=True)
    if expected_atol is not None and not _matching_number(atol, expected_atol):
        raise ValueError(f"{name}.ksp_atol disagrees with the global native configuration")

    breakdown = (
        _configured_breakdown_tolerance(payload, name, requested_type)
        if check_breakdown else None
    )
    if check_breakdown and expected_breakdown is not None:
        if breakdown is None or not _matching_number(breakdown, expected_breakdown):
            raise ValueError(
                f"{name}.ksp_breakdown_tolerance disagrees with the global native configuration"
            )
    return {"ksp_type": native_type, "ksp_rtol": rtol,
            "ksp_atol": atol, "ksp_breakdown_tolerance": breakdown}


def _validate_sample_vector(sample_diagnostics, sample_index, expected_k, sampling):
    context = f"sample {sample_index}"
    vector_length = _required_integer(
        sample_diagnostics.get("k_vector_len"), f"{context}.k_vector_len", minimum=0
    )
    vector = sample_diagnostics.get("k_vector_rad_m")
    if vector_length != 3 or not isinstance(vector, list) or len(vector) != 3:
        raise ValueError(f"{context} has an invalid native k vector")
    actual = [
        _required_number(component, f"{context}.k_vector_rad_m[{axis}]")
        for axis, component in enumerate(vector)
    ]
    expected = (
        (float(expected_k), 0.0, 0.0)
        if sampling.startswith("bv-")
        else (0.0, float(expected_k), 0.0)
    )
    if any(not _matching_number(got, want) for got, want in zip(actual, expected)):
        raise ValueError(f"{context} native k vector disagrees with the requested sampling")
    return actual


def _validate_shifted_solve_diagnostics(payload, name, configuration):
    """Validate cached pre-EPS and true-residual telemetry for one solve."""
    before_eps = _required_object(
        payload.get("shifted_ksp_configuration_before_eps"),
        f"{name}.shifted_ksp_configuration_before_eps",
    )
    if before_eps.get("phase") != "before_eps_solve":
        raise ValueError(f"{name} is missing pre-EPS shifted-KSP configuration")
    before_pc_side = _required_integer(before_eps.get("pc_side"), f"{name}.pre-EPS pc_side")
    before_norm_type = _required_integer(before_eps.get("norm_type"), f"{name}.pre-EPS norm_type")
    if before_pc_side != 1 or before_norm_type != 2:
        raise ValueError(f"{name} does not use PC_RIGHT and KSP_NORM_UNPRECONDITIONED")

    if payload.get("ksp_diagnostics_available") is not True:
        raise ValueError(f"{name} KSP diagnostics are unavailable")
    if payload.get("ksp_last_true_residual_available") is not True:
        raise ValueError(f"{name} last true residual is unavailable")
    converged_reason = _required_integer(
        payload.get("ksp_converged_reason"), f"{name}.ksp_converged_reason"
    )
    eps_reason = _required_integer(
        payload.get("eps_converged_reason"), f"{name}.eps_converged_reason"
    )
    if converged_reason <= 0 or eps_reason <= 0:
        raise ValueError(f"{name} EPS/KSP did not report positive convergence")

    pc_side = _required_integer(payload.get("ksp_pc_side"), f"{name}.ksp_pc_side")
    norm_type = _required_integer(payload.get("ksp_norm_type"), f"{name}.ksp_norm_type")
    if pc_side != 1 or norm_type != 2:
        raise ValueError(f"{name} did not retain PC_RIGHT and KSP_NORM_UNPRECONDITIONED")

    measurement_failures = _required_integer(
        payload.get("ksp_true_residual_measurement_failure_count"),
        f"{name}.ksp_true_residual_measurement_failure_count",
        minimum=0,
    )
    if measurement_failures != 0:
        raise ValueError(f"{name} has shifted-solve true-residual diagnostic failures")

    criterion = _required_object(
        payload.get("ksp_true_residual_criterion"),
        f"{name}.ksp_true_residual_criterion",
    )
    if criterion.get("schema_version") != _CRITERION_SCHEMA:
        raise ValueError(f"{name} has an unsupported true-residual criterion schema")
    if criterion.get("reference_norm") != _CRITERION_REFERENCE:
        raise ValueError(f"{name} true-residual criterion lacks the zero-initial-guess RHS reference")

    solve_count = _required_integer(
        criterion.get("solve_count"), f"{name}.criterion.solve_count", minimum=1
    )
    measured_count = _required_integer(
        criterion.get("measured_count"), f"{name}.criterion.measured_count", minimum=0
    )
    violation_count = _required_integer(
        criterion.get("violation_count"), f"{name}.criterion.violation_count", minimum=0
    )
    unavailable_count = _required_integer(
        criterion.get("unavailable_count"), f"{name}.criterion.unavailable_count", minimum=0
    )
    maximum_ratio = _required_number(
        criterion.get("maximum_tolerance_ratio"),
        f"{name}.criterion.maximum_tolerance_ratio",
        nonnegative=True,
    )
    if measured_count != solve_count:
        raise ValueError(f"{name} true-residual criterion has inconsistent solve counts")
    if violation_count != 0 or unavailable_count != 0:
        raise ValueError(f"{name} true-residual criterion reports a violation or unavailable solve")
    if maximum_ratio > 1.0:
        raise ValueError(f"{name} true-residual criterion exceeds its requested tolerance")

    sample_count = _required_integer(
        payload.get("ksp_true_residual_sample_count"),
        f"{name}.ksp_true_residual_sample_count",
        minimum=0,
    )
    if sample_count != measured_count:
        raise ValueError(f"{name} true-residual criterion disagrees with its measured count")

    true_residual_norm = _required_number(
        payload.get("ksp_last_true_residual_norm"),
        f"{name}.ksp_last_true_residual_norm",
        nonnegative=True,
    )
    rhs_norm = _required_number(
        payload.get("ksp_last_rhs_norm"), f"{name}.ksp_last_rhs_norm", nonnegative=True
    )
    relative_limit = configuration["ksp_rtol"] * rhs_norm
    if not math.isfinite(relative_limit):
        raise ValueError(f"{name} last shifted-solve tolerance is non-finite")
    absolute_limit = max(configuration["ksp_atol"], relative_limit)
    if true_residual_norm > absolute_limit:
        raise ValueError(f"{name} last true residual exceeds its absolute/relative KSP criterion")
    last_tolerance_ratio = (
        true_residual_norm / absolute_limit if absolute_limit > 0.0
        else (0.0 if true_residual_norm == 0.0 else math.inf)
    )
    if maximum_ratio + 1e-12 < last_tolerance_ratio:
        raise ValueError(f"{name} aggregate criterion ratio is inconsistent with its last solve")

    return {
        "ksp_type": configuration["ksp_type"],
        "ksp_rtol": configuration["ksp_rtol"],
        "ksp_atol": configuration["ksp_atol"],
        "pc_side": pc_side,
        "norm_type": norm_type,
        "eps_converged_reason": eps_reason,
        "ksp_converged_reason": converged_reason,
        "true_residual_criterion": {
            "solve_count": solve_count,
            "measured_count": measured_count,
            "violation_count": violation_count,
            "unavailable_count": unavailable_count,
            "maximum_tolerance_ratio": maximum_ratio,
        },
        "last_tolerance_ratio": last_tolerance_ratio,
    }


def _validate_window(window, sample_index, window_position, requested_type,
                     rtol_limit, global_rtol, global_atol):
    name = f"sample {sample_index} subwindow {window_position}"
    _required_object(window, name)
    index = _required_integer(window.get("index"), f"{name}.index", minimum=0)
    configuration = _validate_ksp_configuration(
        window,
        name,
        requested_type,
        rtol_limit,
        expected_rtol=global_rtol,
        expected_atol=global_atol,
        check_breakdown=False,
    )

    unsupported = window.get("unsupported_reason")
    if unsupported == "no_positive_frequency_eigenpair_in_window":
        # Mirror the native exhausted-window distinction, without treating an
        # empty band as a failed inverse or certifying spectral completeness.
        if window.get("stop_reason") != "window_exhausted":
            raise ValueError(f"{name} has an inconsistent exhausted-window status")
        for field in ("candidate_modes", "positive_frequency_candidates"):
            _required_integer(window.get(field), f"{name}.{field}", minimum=1)
        for field in (
            "frequency_window_candidates", "residual_evaluation_candidates",
            "residual_rejections", "non_real_rotated_eigenvalues",
            "eigenpair_evaluation_failures", "mode_vector_failures",
            "potential_reconstruction_failures",
        ):
            if _required_integer(window.get(field), f"{name}.{field}", minimum=0) != 0:
                raise ValueError(f"{name} exhausted window contains a candidate failure")
    elif not isinstance(unsupported, str) or unsupported:
        raise ValueError(f"{name} reports a native diagnostic failure")

    return {
        "index": index,
        **_validate_shifted_solve_diagnostics(window, name, configuration),
    }


def _validate_nearest_sample(
    diagnostics, sampling, requested_type, requested_rtol_value,
    target_frequency_hz, gmres_restart, expected_wavevectors, global_rtol,
    global_atol, global_breakdown,
):
    if len(expected_wavevectors) != 1 or expected_wavevectors[0] == 0.0:
        raise ValueError("nearest shifted KSP trial requires exactly one nonzero DE/BV sample")

    target = _required_number(
        target_frequency_hz, "target_frequency_hz", positive=True
    )
    if gmres_restart is not None:
        gmres_restart = _required_integer(
            gmres_restart, "gmres_restart", minimum=1
        )

    records = diagnostics.get("sample_solver_diagnostics")
    if not isinstance(records, list):
        raise ValueError("nearest shifted KSP trial requires indexed per-sample diagnostics")
    by_sample = diagnostics_by_sample(
        diagnostics, [0], "ksp_true_residual_criterion"
    )
    invalid_indices = sorted(index for index in by_sample if index != 0)
    if invalid_indices:
        raise ValueError(
            f"native solver diagnostics contain invalid sample indices: {invalid_indices}"
        )
    if 0 not in by_sample:
        raise ValueError("missing native solver diagnostics for nearest sample 0")

    sample = _required_object(by_sample[0], "sample 0.diagnostics")
    if "subwindows" in sample:
        raise ValueError("nearest shifted KSP trial cannot use frequency-window subwindows")
    if sample.get("stop_reason") == "window_exhausted":
        raise ValueError("nearest sample cannot report the frequency-window exhausted stop reason")
    unsupported = sample.get("unsupported_reason")
    if unsupported is not None and unsupported != "":
        raise ValueError("nearest sample reports a native diagnostic failure")

    adapter = _required_string(sample.get("solver_adapter"), "sample 0.solver_adapter")
    if adapter != "floquet_airbox_cpu_schur_slepc":
        raise ValueError("nearest sample was not produced by the Floquet CPU Schur/SLEPc adapter")
    if sample.get("status") != "ok":
        raise ValueError("nearest sample status is not ok")
    if sample.get("solve_complete") is not True:
        raise ValueError("nearest sample solve is incomplete")
    if sample.get("target_kind") != "nearest_frequency":
        raise ValueError("nearest sample target kind is not nearest_frequency")
    resolved_target = _required_number(
        sample.get("target_frequency_hz"),
        "sample 0.target_frequency_hz",
        positive=True,
    )
    if not _matching_number(resolved_target, target):
        raise ValueError("nearest sample target_frequency_hz disagrees with the request")
    if sample.get("spectrum_completeness") != "selected_only":
        raise ValueError("nearest sample must retain selected_only spectrum scope")
    if sample.get("window_complete") is not False:
        raise ValueError("nearest sample must report window_complete=false")

    vector = _validate_sample_vector(sample, 0, expected_wavevectors[0], sampling)
    configuration = _validate_ksp_configuration(
        sample,
        "sample 0",
        requested_type,
        requested_rtol_value if requested_rtol_value is not None else global_rtol,
        expected_rtol=global_rtol,
        expected_atol=global_atol,
        expected_breakdown=global_breakdown,
    )

    global_restart = _required_integer(
        diagnostics.get("ksp_restart"), "global.ksp_restart", minimum=1
    )
    sample_restart = _required_integer(
        sample.get("ksp_restart"), "sample 0.ksp_restart", minimum=1
    )
    if sample_restart != global_restart:
        raise ValueError("sample 0 KSP restart disagrees with the global native configuration")
    if gmres_restart is not None and global_restart != gmres_restart:
        raise ValueError("global native KSP restart disagrees with the requested restart")

    if sample.get("eps_dimensions_available") is not True:
        raise ValueError("sample 0 EPS dimensions are unavailable")
    nev = _required_integer(sample.get("eps_nev"), "sample 0.eps_nev", minimum=1)
    ncv = _required_integer(sample.get("eps_ncv"), "sample 0.eps_ncv", minimum=1)
    mpd = _required_integer(sample.get("eps_mpd"), "sample 0.eps_mpd", minimum=1)
    if ncv < nev or mpd > ncv:
        raise ValueError("sample 0 EPS dimensions are inconsistent")

    solve_report = _validate_shifted_solve_diagnostics(
        sample, "sample 0 nearest solve", configuration
    )
    solve_report.update({
        "solver_adapter": adapter,
        "status": "ok",
        "solve_complete": True,
        "target_kind": "nearest_frequency",
        "target_frequency_hz": resolved_target,
        "spectrum_completeness": "selected_only",
        "window_complete": False,
        "ksp_restart": sample_restart,
        "gmres_restart": sample_restart,
        "eps_dimensions_available": True,
        "eps_dimensions": {"nev": nev, "ncv": ncv, "mpd": mpd},
    })
    accepted = {
        "sample_index": 0,
        "k_vector_rad_m": vector,
        "breakdown_tolerance": configuration["ksp_breakdown_tolerance"],
        "target_frequency_hz": resolved_target,
        "gmres_restart": sample_restart,
        "single_solve": solve_report,
    }
    return {
        "status": "pass",
        "qualification": "NOT VERIFIED",
        "spectral_target": "nearest",
        "selection_scope": "selected_only",
        "window_complete": False,
        "sampling": sampling,
        "target_frequency_hz": resolved_target,
        "requested_target_frequency_hz": target,
        "resolved_target_frequency_hz": resolved_target,
        "requested_type": requested_type,
        "requested_rtol": requested_rtol_value,
        "configured_rtol": global_rtol,
        "configured_atol": global_atol,
        "requested_gmres_restart": gmres_restart,
        "sample_count": 1,
        "by_sample": {0: accepted},
    }


def validate_shifted_ksp_trial(
    case_dir: Path,
    sampling: str,
    requested_type: str,
    requested_rtol: str | None,
    *,
    spectral_target: str = "frequency_window",
    target_frequency_hz=None,
    gmres_restart=None,
):
    """Validate native shifted-KSP telemetry for a window or one nearest solve.

    This is a solver-trial receipt check only.  It does not certify eigenmodes,
    physical residuals, convergence of the dispersion, or scientific validity.
    """
    if not isinstance(spectral_target, str) or spectral_target not in {
        "frequency_window", "nearest"
    }:
        raise ValueError("shifted KSP trial spectral_target must be frequency_window or nearest")
    if spectral_target == "frequency_window" and (
        target_frequency_hz is not None or gmres_restart is not None
    ):
        raise ValueError("nearest-only target/restart values require spectral_target='nearest'")
    if not isinstance(sampling, str) or sampling not in SAMPLING:
        raise ValueError("shifted KSP trial has an unknown sampling name")
    if not isinstance(requested_type, str) or requested_type not in _KSP_TYPES:
        raise ValueError("shifted KSP trial requested_type must be gmres or fgmres")
    if requested_rtol is None:
        requested_rtol_value = None
    else:
        if not isinstance(requested_rtol, str):
            raise ValueError("shifted KSP trial requested_rtol must be a positive finite string")
        try:
            requested_rtol_value = float(requested_rtol)
        except (OverflowError, ValueError):
            raise ValueError("shifted KSP trial requested_rtol must be a positive finite string") from None
        if not math.isfinite(requested_rtol_value) or requested_rtol_value <= 0.0:
            raise ValueError("shifted KSP trial requested_rtol must be a positive finite string")

    expected_wavevectors = SAMPLING[sampling]
    required_indices = [
        index for index, wavevector in enumerate(expected_wavevectors)
        if wavevector != 0.0
    ]
    if not required_indices:
        raise ValueError("shifted KSP trial requires at least one nonzero-k sample")

    try:
        case_path = Path(case_dir)
    except TypeError:
        raise ValueError("shifted KSP trial case_dir must be path-like") from None
    diagnostics_path = case_path / "eigen" / "diagnostics" / "solver.v1.json"
    diagnostics = load_solver_diagnostics(diagnostics_path)
    schema = _required_string(diagnostics.get("schema_version"), "native.schema_version")
    if schema not in {
        "solver.v1", "frequency_domain_modal_solver_diagnostics.v1"
    }:
        raise ValueError("shifted KSP trial requires a supported native diagnostics schema")

    global_type = _required_string(diagnostics.get("ksp_type"), "global.ksp_type")
    if global_type != requested_type:
        raise ValueError("global native ksp_type disagrees with the requested KSP type")
    global_rtol = _required_number(
        diagnostics.get("ksp_rtol"), "global.ksp_rtol", positive=True
    )
    global_atol = _required_number(
        diagnostics.get("ksp_atol"), "global.ksp_atol", nonnegative=True
    )
    rtol_limit = requested_rtol_value if requested_rtol_value is not None else global_rtol
    if global_rtol > rtol_limit:
        raise ValueError("global native ksp_rtol is looser than the requested tolerance")
    global_breakdown = _configured_breakdown_tolerance(
        diagnostics, "global", requested_type
    )

    if spectral_target == "nearest":
        return _validate_nearest_sample(
            diagnostics,
            sampling,
            requested_type,
            requested_rtol_value,
            target_frequency_hz,
            gmres_restart,
            expected_wavevectors,
            global_rtol,
            global_atol,
            global_breakdown,
        )

    records = diagnostics.get("sample_solver_diagnostics")
    if not isinstance(records, list):
        raise ValueError("shifted KSP trial requires indexed per-sample diagnostics")
    by_sample = diagnostics_by_sample(diagnostics, required_indices, "subwindows")
    valid_indices = set(range(len(expected_wavevectors)))
    invalid_indices = sorted(index for index in by_sample if index not in valid_indices)
    if invalid_indices:
        raise ValueError(f"native solver diagnostics contain invalid sample indices: {invalid_indices}")
    missing_indices = [index for index in required_indices if index not in by_sample]
    if missing_indices:
        raise ValueError(f"missing native solver diagnostics for nonzero-k samples {missing_indices}")

    accepted_by_sample = {}
    for sample_index in required_indices:
        sample_diagnostics = _required_object(
            by_sample[sample_index], f"sample {sample_index}.diagnostics"
        )
        vector = _validate_sample_vector(
            sample_diagnostics,
            sample_index,
            expected_wavevectors[sample_index],
            sampling,
        )
        sample_config = _validate_ksp_configuration(
            sample_diagnostics,
            f"sample {sample_index}",
            requested_type,
            rtol_limit,
            expected_rtol=global_rtol,
            expected_atol=global_atol,
            expected_breakdown=global_breakdown,
        )
        subwindows = sample_diagnostics.get("subwindows")
        if not isinstance(subwindows, list) or not subwindows:
            raise ValueError(f"sample {sample_index} has no executed shifted-KSP subwindows")

        window_reports = []
        seen_indices = set()
        for position, window in enumerate(subwindows):
            report = _validate_window(
                window,
                sample_index,
                position,
                requested_type,
                rtol_limit,
                global_rtol,
                global_atol,
            )
            if report["index"] in seen_indices:
                raise ValueError(f"sample {sample_index} has duplicate subwindow indices")
            seen_indices.add(report["index"])
            window_reports.append(report)
        if seen_indices != set(range(len(subwindows))):
            raise ValueError(f"sample {sample_index} has missing subwindow indices")

        accepted_by_sample[sample_index] = {
            "sample_index": sample_index,
            "k_vector_rad_m": vector,
            "breakdown_tolerance": sample_config["ksp_breakdown_tolerance"],
            "subwindow_count": len(window_reports),
            "subwindows": window_reports,
        }

    return {
        "status": "pass",
        "qualification": "NOT VERIFIED",
        "sampling": sampling,
        "requested_type": requested_type,
        "requested_rtol": requested_rtol_value,
        "configured_rtol": global_rtol,
        "configured_atol": global_atol,
        "sample_count": len(accepted_by_sample),
        "by_sample": accepted_by_sample,
    }
