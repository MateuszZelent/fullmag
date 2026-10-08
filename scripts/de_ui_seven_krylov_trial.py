"""Selected-only Krylov receipt for the seven-point UI diagnostic path."""
from __future__ import annotations

import math
from pathlib import Path

from de_gamma_krylov_trial import (
    _K0_ENGINE_ID,
    _K0_SOLVER_ADAPTER,
    _required_integer as _gamma_required_integer,
    _required_positive_request,
    _validate_gamma_vector,
    _validate_query,
)
from de_shifted_ksp_trial import (
    _validate_ksp_configuration,
    _validate_sample_vector,
    _validate_shifted_solve_diagnostics,
)
from validate_de_smoke_rows import (
    SAMPLING,
    UI_SEVEN_SAMPLING,
    load_solver_diagnostics,
    validate_selected_only_diagnostics,
)


_SCHEMA = "fullmag.de-smoke-ui-seven-krylov-trial.v1"
_SHIFTED_SOLVER_ADAPTER = "floquet_airbox_cpu_schur_slepc"
_REQUESTED_KSP_TYPE = "fgmres"
_REQUESTED_KSP_RTOL = "1e-9"
_REQUESTED_GMRES_RESTART = "30"
_EPS_PREFILTER_CHOICES = frozenset(("1e-8", "1e-9", "1e-10", "1e-11"))


def _validate_request(target_frequency_hz, requested_type, requested_rtol,
                      eps_prefilter, gmres_restart):
    if requested_type != _REQUESTED_KSP_TYPE:
        raise ValueError("ui-seven Krylov trial requires requested FGMRES")
    if requested_rtol != _REQUESTED_KSP_RTOL:
        raise ValueError("ui-seven Krylov trial requires requested shifted KSP rtol=1e-9")
    if gmres_restart != _REQUESTED_GMRES_RESTART:
        raise ValueError("ui-seven Krylov trial requires requested GMRES restart=30")
    if not isinstance(eps_prefilter, str) or eps_prefilter not in _EPS_PREFILTER_CHOICES:
        raise ValueError("ui-seven Krylov trial requires an explicit supported EPS prefilter")
    eps_value = _required_positive_request(eps_prefilter, "eps_prefilter")
    if eps_value is None:
        raise ValueError("ui-seven Krylov trial requires an explicit EPS prefilter")
    if isinstance(target_frequency_hz, bool) or not isinstance(target_frequency_hz, (int, float)):
        raise ValueError("ui-seven nearest target frequency must be finite and positive")
    try:
        target = float(target_frequency_hz)
    except (OverflowError, ValueError):
        raise ValueError("ui-seven nearest target frequency must be finite and positive") from None
    if not math.isfinite(target) or target <= 0.0:
        raise ValueError("ui-seven nearest target frequency must be finite and positive")
    return target, float(_REQUESTED_KSP_RTOL), eps_value, int(_REQUESTED_GMRES_RESTART)


def validate_ui_seven_krylov_trial(
    case_dir: Path,
    target_frequency_hz,
    requested_type: str,
    requested_rtol: str,
    eps_prefilter: str,
    gmres_restart: str,
):
    """Bind six nonzero shifted solves and Gamma's actual nearest EPS query.

    The report is a selected-only solver diagnostic. It does not certify a
    frequency window, spectrum completeness, branch continuity, or physics.
    """
    target_hz, rtol, eps, restart = _validate_request(
        target_frequency_hz, requested_type, requested_rtol,
        eps_prefilter, gmres_restart,
    )
    expected_vectors = [[0.0, float(k), 0.0] for k in SAMPLING[UI_SEVEN_SAMPLING]]
    diagnostics_path = Path(case_dir) / "eigen" / "diagnostics" / "solver.v1.json"
    selected = validate_selected_only_diagnostics(
        diagnostics_path,
        target_hz,
        expected_sample_count=len(expected_vectors),
        expected_vectors=expected_vectors,
    )
    diagnostics = load_solver_diagnostics(diagnostics_path)
    schema = diagnostics.get("schema_version")
    if schema not in {"solver.v1", "frequency_domain_modal_solver_diagnostics.v1"}:
        raise ValueError("ui-seven Krylov trial requires a supported native diagnostics schema")

    records = diagnostics.get("sample_solver_diagnostics")
    if not isinstance(records, list) or len(records) != len(expected_vectors):
        raise ValueError("ui-seven Krylov trial requires seven indexed native sample records")
    by_sample = {}
    for position, record in enumerate(records):
        if not isinstance(record, dict):
            raise ValueError(f"ui-seven native sample record {position} must be an object")
        sample_index = record.get("sample_index")
        if type(sample_index) is not int or sample_index not in range(len(expected_vectors)):
            raise ValueError(f"ui-seven native sample record {position} has an invalid sample index")
        if sample_index in by_sample:
            raise ValueError(f"ui-seven native diagnostics contain duplicate sample {sample_index}")
        sample = record.get("diagnostics")
        if not isinstance(sample, dict):
            raise ValueError(f"ui-seven native sample {sample_index} diagnostics must be an object")
        by_sample[sample_index] = sample
    if set(by_sample) != set(range(len(expected_vectors))):
        raise ValueError("ui-seven native diagnostics have missing sample indices")

    # The path envelope may omit common KSP fields. When it publishes them,
    # they must agree with the explicit request; every per-sample record below
    # is checked regardless.
    if "ksp_type" in diagnostics and diagnostics["ksp_type"] != _REQUESTED_KSP_TYPE:
        raise ValueError("ui-seven native ksp_type disagrees with the request")
    if "ksp_restart" in diagnostics:
        root_restart = diagnostics["ksp_restart"]
        if type(root_restart) is not int or root_restart != restart:
            raise ValueError("ui-seven native ksp_restart disagrees with the request")
    if "ksp_rtol" in diagnostics:
        root_rtol = diagnostics["ksp_rtol"]
        if (isinstance(root_rtol, bool) or not isinstance(root_rtol, (int, float)) or
                not math.isclose(float(root_rtol), rtol, rel_tol=1e-12, abs_tol=0.0)):
            raise ValueError("ui-seven native ksp_rtol disagrees with the request")

    nonzero_indices = [index for index, k in enumerate(SAMPLING[UI_SEVEN_SAMPLING]) if k != 0.0]
    accepted_by_sample = {}
    for sample_index in nonzero_indices:
        name = f"sample {sample_index}"
        sample = by_sample[sample_index]
        if sample.get("solver_adapter") != _SHIFTED_SOLVER_ADAPTER:
            raise ValueError(f"{name}.solver_adapter is not the native Floquet CPU Schur/SLEPc adapter")
        if sample.get("status") != "ok" or sample.get("solve_complete") is not True:
            raise ValueError(f"{name} nearest shifted solve is not complete")
        if "subwindows" in sample:
            raise ValueError(f"{name} nearest shifted solve cannot use frequency-window subwindows")

        vector = _validate_sample_vector(
            sample, sample_index, SAMPLING[UI_SEVEN_SAMPLING][sample_index],
            UI_SEVEN_SAMPLING,
        )
        configuration = _validate_ksp_configuration(
            sample,
            name,
            _REQUESTED_KSP_TYPE,
            rtol,
            expected_rtol=rtol,
        )
        sample_restart = sample.get("ksp_restart")
        if type(sample_restart) is not int or sample_restart != restart:
            raise ValueError(f"{name}.ksp_restart disagrees with the requested restart=30")

        if sample.get("eps_dimensions_available") is not True:
            raise ValueError(f"{name} EPS dimensions are unavailable")
        nev = _gamma_required_integer(sample.get("eps_nev"), f"{name}.eps_nev", minimum=1)
        ncv = _gamma_required_integer(sample.get("eps_ncv"), f"{name}.eps_ncv", minimum=1)
        mpd = _gamma_required_integer(sample.get("eps_mpd"), f"{name}.eps_mpd", minimum=1)
        if ncv < nev or mpd > ncv:
            raise ValueError(f"{name} EPS dimensions are inconsistent")

        solve = _validate_shifted_solve_diagnostics(sample, f"{name} nearest solve", configuration)
        accepted_by_sample[sample_index] = {
            "sample_index": sample_index,
            "k_vector_rad_m": vector,
            "ksp_restart": sample_restart,
            "eps_dimensions": {"nev": nev, "ncv": ncv, "mpd": mpd},
            "single_solve": solve,
        }

    gamma_index = SAMPLING[UI_SEVEN_SAMPLING].index(0.0)
    gamma = by_sample[gamma_index]
    if gamma.get("solver_adapter") != _K0_SOLVER_ADAPTER:
        raise ValueError(f"sample {gamma_index}.solver_adapter must identify the native K0 Schur CPU adapter")
    if gamma.get("engine_id") != _K0_ENGINE_ID:
        raise ValueError(f"sample {gamma_index} has an unexpected native K0 engine_id")
    gamma_vector = _validate_gamma_vector(gamma, gamma_index)
    q_dof_count = _gamma_required_integer(
        gamma.get("q_dof_count"), f"sample {gamma_index}.q_dof_count", minimum=1
    )
    gamma_query = _validate_query(
        gamma.get("modal_krylov_tuning"),
        f"sample {gamma_index}.modal_krylov_tuning",
        _REQUESTED_KSP_TYPE,
        rtol,
        eps,
        restart,
        2 * q_dof_count,
    )

    return {
        "schema": _SCHEMA,
        "status": "pass",
        "qualification": "NOT VERIFIED",
        "purpose": "ui_diagnostic",
        "sampling": UI_SEVEN_SAMPLING,
        "spectral_target": "nearest",
        "selection_scope": "selected_only",
        "window_complete": False,
        "target_frequency_hz": target_hz,
        "requested_type": _REQUESTED_KSP_TYPE,
        "requested_rtol": rtol,
        "requested_eps_prefilter": eps,
        "requested_gmres_restart": restart,
        "sample_count": len(expected_vectors),
        "shifted_sample_indices": nonzero_indices,
        "shifted_samples": accepted_by_sample,
        "gamma_sample": {
            "sample_index": gamma_index,
            "solver_adapter": _K0_SOLVER_ADAPTER,
            "engine_id": _K0_ENGINE_ID,
            "k_vector_rad_m": gamma_vector,
            "q_dof_count": q_dof_count,
            "modal_krylov_tuning": gamma_query,
        },
        "selected_only_diagnostics": selected,
        "pending_requirements": [
            "managed runtime and solver receipt identity",
            "frequency-window coverage, branch continuity, and scientific qualification",
        ],
    }
