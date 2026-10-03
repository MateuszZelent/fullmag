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
    native = windows[-1].get("floquet_schur_action_diagnostic")
    if not isinstance(native, dict):
        raise ValueError("failed subwindow has no Schur observation")
    return {"floquet_schur_action_diagnostic": native}, {
        "source": "runtime.log", "source_sha256": hashlib.sha256(raw).hexdigest(),
        "source_bytes": len(raw), "source_kind": "terminal_failure_log",
        "native_failure_reason": failure_reason,
        "native_subwindow_observations": [
            {"index": window.get("index"), "stop_reason": window.get("stop_reason"),
             "schur_action": window.get("floquet_schur_action_diagnostic")}
            for window in windows],
    }
