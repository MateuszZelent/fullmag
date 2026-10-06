"""Interpreted contract checks for the isolated active-run refusal route."""
from __future__ import annotations

import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))

import verify_development_backend_api as backend_gate
from windows.verify_consumer_pump import (
    ACTIVE_RUN_EXPECTED_CHECKS,
    ACTIVE_RUN_REQUEST_SCHEMA,
    ACTIVE_RUN_RESULT_SCHEMA,
    ACTIVE_RUN_RESULT_FIELDS,
    ACTIVE_RUN_REFUSAL_ATTRIBUTION,
    EXPECTED_CHECKS,
    _active_run_cli_failure_detail,
    REQUEST_SCHEMA,
    RESULT_SCHEMA,
    ACTIVE_RUN_PROGRESS_SCHEMA,
    HELPER_PROGRESS_SCHEMA,
    _active_solver_start_pid,
    _bounded_error_tail_text,
    _case_schemas,
    _retain_unknown_active_processes,
    _terminal_helper,
    validate_active_run_result,
)


OWNER_BUNDLE = "a" * 32
FROZEN_BUILD_ID = "b" * 64
REQUEST_ID = "11111111-1111-4111-8111-111111111111"
API_PID = 42100
SOLVER_PID = 42101


def valid_result() -> dict[str, object]:
    return {
        "schema": ACTIVE_RUN_RESULT_SCHEMA,
        "status": "passed",
        "request_id": REQUEST_ID,
        "old_api_instance_id": "22222222-2222-4222-8222-222222222222",
        "session_id": "session-active-run",
        "run_id": "run-active-run",
        "solver_steps_before": 4,
        "solver_steps_at_refusal": 6,
        "solver_steps_after": 7,
        "solver_state_before": "running",
        "solver_state_after": "running",
        "active_run_result_state": "failed",
        "active_run_public_reason": "restart_preparation_refused",
        "refusal_reason_attribution": ACTIVE_RUN_REFUSAL_ATTRIBUTION,
        "api_process": {"pid": API_PID, "waited": True, "exit_code": 0},
        "solver_process": {"pid": SOLVER_PID, "waited": True, "exit_code": 1},
        "helper_processes": [
            {"pid": 42102, "waited": True, "exit_code": 0},
            {"pid": 42103, "waited": True, "exit_code": 0},
        ],
        "checks": {name: True for name in ACTIVE_RUN_EXPECTED_CHECKS},
    }


def rejects(result: dict[str, object], api_pid: int = API_PID, solver_pid: int = SOLVER_PID) -> None:
    try:
        validate_active_run_result(result, api_pid=api_pid, solver_pid=solver_pid)
    except backend_gate.storage.StorageError:
        return
    raise AssertionError("invalid active-run refusal result was accepted")


assert _case_schemas("readiness") == (REQUEST_SCHEMA, RESULT_SCHEMA)
assert _case_schemas("active-run") == (ACTIVE_RUN_REQUEST_SCHEMA, ACTIVE_RUN_RESULT_SCHEMA)
assert EXPECTED_CHECKS.isdisjoint(ACTIVE_RUN_EXPECTED_CHECKS)
assert set(valid_result()) == ACTIVE_RUN_RESULT_FIELDS
validate_active_run_result(valid_result(), api_pid=API_PID, solver_pid=SOLVER_PID)

backend_gate._validate_active_run_refusal_scope(
    OWNER_BUNDLE,
    conflicting_scope=False,
    frozen_native_build_id=None,
)
backend_gate._validate_active_run_refusal_scope(
    None,
    conflicting_scope=True,
    frozen_native_build_id=FROZEN_BUILD_ID,
)
for invalid_bundle in ("A" * 32, "a" * 31, "../" + "a" * 29):
    try:
        backend_gate._validate_active_run_refusal_scope(
            invalid_bundle,
            conflicting_scope=False,
            frozen_native_build_id=None,
        )
    except backend_gate.storage.StorageError:
        pass
    else:
        raise AssertionError("invalid owner bundle was accepted")
try:
    backend_gate._validate_active_run_refusal_scope(
        OWNER_BUNDLE,
        conflicting_scope=True,
        frozen_native_build_id=None,
    )
except backend_gate.storage.StorageError:
    pass
else:
    raise AssertionError("active-run refusal was combined with another scope")
try:
    backend_gate._validate_active_run_refusal_scope(
        OWNER_BUNDLE,
        conflicting_scope=False,
        frozen_native_build_id=FROZEN_BUILD_ID,
    )
except backend_gate.storage.StorageError:
    pass
else:
    raise AssertionError("active-run refusal was combined with frozen-build-only scope")

bad_schema = valid_result()
bad_schema["schema"] = RESULT_SCHEMA
rejects(bad_schema)

bad_public_reason = valid_result()
bad_public_reason["active_run_public_reason"] = "restart_outcome_unconfirmed"
rejects(bad_public_reason)

bad_attribution = valid_result()
bad_attribution["refusal_reason_attribution"] = "active_run_busy"
rejects(bad_attribution)

bad_check_set = valid_result()
bad_check_set["checks"] = {name: True for name in EXPECTED_CHECKS}
rejects(bad_check_set)

false_check = valid_result()
false_check["checks"] = dict(false_check["checks"], no_old_api_exit=False)
rejects(false_check)

no_step_advance = valid_result()
no_step_advance["solver_steps_after"] = 6
rejects(no_step_advance)

no_post_refusal_advance = valid_result()
no_post_refusal_advance["solver_steps_after"] = no_post_refusal_advance["solver_steps_at_refusal"]
rejects(no_post_refusal_advance)

bad_refusal_baseline = valid_result()
bad_refusal_baseline["solver_steps_at_refusal"] = bad_refusal_baseline["solver_steps_before"] - 1
rejects(bad_refusal_baseline)

solver_pid, solver_frame_error = _active_solver_start_pid([], failed_or_timed_out=True)
assert solver_pid is None and solver_frame_error is None
terminal_helper = _terminal_helper(
    {"pid": 42104, "waited": True, "exit_code": 0},
    canceled_pid=None,
)
assert terminal_helper["waited"] is True and terminal_helper["exit_code"] == 0
early_api_record = {"pid": 42105, "waited": False, "outcome": "pending"}
early_api_records = {42105: early_api_record}
assert _retain_unknown_active_processes(
    api_started=True,
    api_terminal=False,
    api_records=early_api_records,
    solver_records={},
) is False
assert early_api_record["waited"] is False and early_api_record["outcome"] == "unknown"
failure_tail = _bounded_error_tail_text("progress frame\nError: failed to acquire active-run idle proof\n")
assert failure_tail == "Error: failed to acquire active-run idle proof"
primary_failure_detail = _active_run_cli_failure_detail(
    "Error: failed to acquire active-run idle proof\n",
    solver_frame_error=None,
)
assert "Error: failed to acquire active-run idle proof" in primary_failure_detail
long_failure_tail = _bounded_error_tail_text("Error: " + "x" * 4096)
assert len(long_failure_tail) <= 2048 and long_failure_tail.startswith("Error:")

duplicate_solver_pid, duplicate_solver_error = _active_solver_start_pid(
    [
        {"schema": ACTIVE_RUN_PROGRESS_SCHEMA, "event": "solver_started", "pid": SOLVER_PID},
        {"schema": ACTIVE_RUN_PROGRESS_SCHEMA, "event": "solver_started", "pid": SOLVER_PID + 1},
    ],
    failed_or_timed_out=True,
)
assert duplicate_solver_pid is None and duplicate_solver_error is not None

missing_solver_pid, missing_solver_error = _active_solver_start_pid([], failed_or_timed_out=False)
assert missing_solver_pid is None and missing_solver_error is not None
assert HELPER_PROGRESS_SCHEMA == "fullmag.development-cli-consumer-pump-helper.v1"

not_running = valid_result()
not_running["solver_state_after"] = "paused"
rejects(not_running)

wrong_api_pid = valid_result()
wrong_api_pid["api_process"] = {"pid": API_PID + 9, "waited": True, "exit_code": 0}
rejects(wrong_api_pid)

unknown_exit = valid_result()
unknown_exit["solver_process"] = {"pid": SOLVER_PID, "waited": True, "exit_code": True}
rejects(unknown_exit)

unreaped_helper = valid_result()
unreaped_helper["helper_processes"] = [{"pid": 42102, "waited": False, "exit_code": 0}]
rejects(unreaped_helper)

bad_helper_exit = valid_result()
bad_helper_exit["helper_processes"] = [{"pid": 42102, "waited": True, "exit_code": 1}]
rejects(bad_helper_exit)

missing_field = valid_result()
del missing_field["session_id"]
rejects(missing_field)

print(json.dumps({
    "schema": "fullmag.control-room.check-result.v1",
    "check": "windows-active-run-refusal-contract",
    "status": "passed",
    "cases": [
        "readiness-schema-and-checkset-unchanged",
        "active-run-route-isolated-to-frozen-owner-bundle",
        "exact-active-result-schema-and-checkset-accepted",
        "generic-refusal-reason-and-attribution-required",
        "active-run-must-advance-while-running",
        "solver-must-advance-after-confirmed-refusal",
        "exact-api-and-solver-terminal-pids-required",
        "all-owner-and-candidate-helpers-waited-successfully",
        "early-cli-failure-keeps-terminal-helper-and-bounded-error-tail",
        "unconfirmed-owner-and-solver-custody-stays-unknown",
    ],
}))
