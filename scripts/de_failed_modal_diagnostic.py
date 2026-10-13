"""Read terminal native diagnostics from a failed modal runtime log.

This preserves observations when the solver aborts before publishing its JSON
artifact. It never changes solve status or manufactures a spectrum/certificate.
"""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
import stat

MAX_LOG_BYTES = 8 * 1024**2
MAX_SUBWINDOWS = 256


def _strict_pairs(pairs):
    values = {}
    for key, value in pairs:
        if key in values:
            raise ValueError("duplicate native diagnostic field")
        values[key] = value
    return values


def _reject_constant(value):
    raise ValueError("nonfinite native diagnostic value: " + value)


def _require_finite(value):
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("nonfinite native diagnostic number")
    if isinstance(value, dict):
        for child in value.values():
            _require_finite(child)
    elif isinstance(value, list):
        for child in value:
            _require_finite(child)


def _validate_ksp_monitor_progress(window):
    """Validate cached monitor progress without promoting it to a solve result."""
    if "ksp_monitor_progress" not in window:
        return None
    progress = window.get("ksp_monitor_progress")
    if not isinstance(progress, dict):
        raise ValueError("failed subwindow KSP monitor progress is not an object")
    if (progress.get("schema_version") != "floquet_shifted_ksp_monitor_progress.v1" or
            progress.get("phase") != "during_eps_solve" or
            progress.get("source") != "petsc_ksp_monitor" or
            progress.get("observation_count_scope") !=
            "all_shifted_ksp_monitor_callbacks_during_one_epsolve" or
            progress.get("recursive_residual_semantics") !=
            "petsc_monitor_recursive_norm_not_true_residual"):
        raise ValueError("failed subwindow KSP monitor progress identity is invalid")

    for name in ("monitor_registered", "available", "last_iteration_available",
                 "recursive_residual_available", "last_observed_reason_available"):
        if type(progress.get(name)) is not bool:
            raise ValueError("failed subwindow KSP monitor availability is invalid")
    count = progress.get("observation_count")
    if isinstance(count, bool) or not isinstance(count, int) or count < 0:
        raise ValueError("failed subwindow KSP monitor observation count is invalid")
    if progress["available"] is not (count > 0):
        raise ValueError("failed subwindow KSP monitor count availability disagrees")
    if count > 0 and not progress["monitor_registered"]:
        raise ValueError("KSP monitor observations lack successful registration")
    if progress.get("last_observed_reason_is_final") is not False:
        raise ValueError("monitor reason cannot be asserted as the final KSP reason")

    iteration = progress.get("last_iteration")
    if progress["last_iteration_available"]:
        if isinstance(iteration, bool) or not isinstance(iteration, int) or iteration < 0:
            raise ValueError("failed subwindow KSP monitor iteration is invalid")
    elif iteration is not None:
        raise ValueError("unavailable KSP monitor iteration must be null")

    recursive_residual = progress.get("recursive_residual_norm")
    if progress["recursive_residual_available"]:
        if (isinstance(recursive_residual, bool) or
                not isinstance(recursive_residual, (int, float)) or
                not math.isfinite(recursive_residual) or recursive_residual < 0.0):
            raise ValueError("failed subwindow recursive residual is invalid")
    elif recursive_residual is not None:
        raise ValueError("unavailable recursive residual must be null")

    observed_reason = progress.get("last_observed_reason")
    if progress["last_observed_reason_available"]:
        if isinstance(observed_reason, bool) or not isinstance(observed_reason, int):
            raise ValueError("failed subwindow observed KSP reason is invalid")
    elif observed_reason is not None:
        raise ValueError("unavailable observed KSP reason must be null")
    if (not progress["available"] and
            (progress["last_iteration_available"] or
             progress["recursive_residual_available"] or
             progress["last_observed_reason_available"])):
        raise ValueError("zero monitor observations cannot have sampled values")

    # These fields describe post-solve/final queries and stay unavailable after
    # EPSSolve unwinds. In particular, observed reason 0 is monitor progress only.
    if (window.get("ksp_diagnostics_available") is not False or
            window.get("ksp_converged_reason") is not None or
            window.get("eps_converged_reason") is not None or
            window.get("ksp_final_residual") is not None):
        raise ValueError("failed subwindow exposes unavailable final KSP diagnostics")
    return progress


def read_failed_schur_action(case_dir):
    """Return a file-hash-bound failed-window observation, or raise ValueError.

    Only one terminal RunError record is accepted. Malformed/ambiguous records
    are not usable evidence. Earlier subwindow observations are retained too.
    """
    path = Path(case_dir) / "runtime.log"
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or
            bool(getattr(info, "st_file_attributes", 0) & 0x400) or
            info.st_size > MAX_LOG_BYTES):
        raise ValueError("runtime diagnostic log is not a bounded regular file")
    with path.open("rb") as stream:
        raw = stream.read(MAX_LOG_BYTES + 1)
    if len(raw) > MAX_LOG_BYTES:
        raise ValueError("runtime diagnostic log exceeds byte budget")
    records = [line for line in raw.decode("utf-8").splitlines()
               if line.startswith("Error: RunError:") and "diagnostics_json=" in line]
    if len(records) != 1 or records[0].count("diagnostics_json=") != 1:
        raise ValueError("missing or ambiguous terminal native diagnostic")
    fragment = records[0].split("diagnostics_json=", 1)[1]
    decoder = json.JSONDecoder(object_pairs_hook=_strict_pairs,
                               parse_constant=_reject_constant)
    payload, end = decoder.raw_decode(fragment)
    if fragment[end:].strip() != ")":
        raise ValueError("unexpected terminal diagnostic suffix")
    _require_finite(payload)
    if (not isinstance(payload, dict) or
            payload.get("schema_version") != "frequency_domain_modal_diagnostics.v1" or
            payload.get("status") != "solve_error" or
            payload.get("complete") is not False or
            payload.get("accepted_mode_count_after_dedup") != 0):
        raise ValueError("log does not describe a failed modal solve")
    windows = payload.get("subwindows")
    if (not isinstance(windows, list) or not windows or
            len(windows) > MAX_SUBWINDOWS or
            any(not isinstance(window, dict) for window in windows)):
        raise ValueError("failed modal subwindows are missing or invalid")
    failure_reason = payload.get("failure_reason")
    if failure_reason not in {"floquet_slepc_solve_failed", "floquet_matshell_action_failed"}:
        raise ValueError("unsupported native terminal failure")
    if windows[-1].get("stop_reason") != failure_reason:
        raise ValueError("terminal subwindow does not match the native failure")
    terminal_window = windows[-1]
    monitor_progress = _validate_ksp_monitor_progress(terminal_window)
    native = terminal_window.get("floquet_schur_action_diagnostic")
    if not isinstance(native, dict):
        raise ValueError("failed subwindow has no Schur observation")
    terminal_observations = [
        {"index": window.get("index"), "stop_reason": window.get("stop_reason"),
         "schur_action": window.get("floquet_schur_action_diagnostic")}
        for window in windows]
    if monitor_progress is not None:
        terminal_observations[-1]["ksp_monitor_progress"] = monitor_progress
    payload = {"floquet_schur_action_diagnostic": native}
    if monitor_progress is not None:
        payload["ksp_monitor_progress"] = monitor_progress
    evidence = {
        "source": "runtime.log", "source_sha256": hashlib.sha256(raw).hexdigest(),
        "source_bytes": len(raw), "source_kind": "terminal_failure_log",
        "native_failure_reason": failure_reason,
        "native_subwindow_observations": terminal_observations,
    }
    if monitor_progress is not None:
        evidence["ksp_monitor_progress"] = monitor_progress
    return payload, evidence
