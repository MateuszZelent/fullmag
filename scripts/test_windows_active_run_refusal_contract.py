"""Interpreted contract checks for the isolated active-run refusal route."""
from __future__ import annotations

import json
import hashlib
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
from unittest import mock

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
    _check_active_candidate_capacity,
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

with tempfile.TemporaryDirectory() as directory:
    from windows.runtime_bundle import BINARY_NAMES
    source_root, stable_root = Path(directory) / "source", Path(directory) / "stable"
    source_root.mkdir()
    stable_root.mkdir()
    expected = {}
    for name in BINARY_NAMES:
        payload = name.encode()
        (source_root / name).write_bytes(payload)
        (stable_root / name).write_bytes(payload)
        expected[name] = hashlib.sha256(payload).hexdigest()
    assert backend_gate._can_reuse_active_binaries(source_root, stable_root, expected)
    changed = stable_root / BINARY_NAMES[0]
    changed.write_bytes(b"different build")
    assert not backend_gate._can_reuse_active_binaries(source_root, stable_root, expected)
    changed.write_bytes((source_root / BINARY_NAMES[0]).read_bytes())
    (source_root / BINARY_NAMES[0]).write_bytes(b"source changed")
    try:
        backend_gate._can_reuse_active_binaries(source_root, stable_root, expected)
    except backend_gate.storage.StorageError as error:
        assert "changed before reuse" in str(error)
    else:
        raise AssertionError("mutated source executable was accepted")

capacity_paths = [Path("build"), Path("storage"), Path("runtime"), Path("manifest.json")]
with mock.patch("windows.select_development_candidate._source_inventory_bytes", return_value=100), \
        mock.patch("windows.select_development_candidate.COPY_HEADROOM_BYTES", 20):
    evidence = {}
    with mock.patch("windows.verify_consumer_pump.shutil.disk_usage", return_value=SimpleNamespace(free=119)), \
            mock.patch("windows.verify_consumer_pump.subprocess.Popen") as launch:
        try:
            _check_active_candidate_capacity(*capacity_paths, "b" * 64, evidence)
        except backend_gate.storage.StorageError as error:
            assert "required=120 available=119" in str(error)
        else:
            raise AssertionError("insufficient candidate capacity was accepted")
        launch.assert_not_called()
    assert evidence["active_run_candidate_capacity"]["required_bytes"] == 120
    with mock.patch("windows.verify_consumer_pump.shutil.disk_usage", return_value=SimpleNamespace(free=120)):
        _check_active_candidate_capacity(*capacity_paths, "b" * 64, {})
    startup_evidence = {}
    with mock.patch("windows.verify_consumer_pump.shutil.disk_usage", return_value=SimpleNamespace(free=219)):
        try:
            _check_active_candidate_capacity(
                *capacity_paths, "b" * 64, startup_evidence,
                additional_copy_bytes=100, receipt_key="active_run_startup_capacity",
            )
        except backend_gate.storage.StorageError as error:
            assert "required=220 available=219" in str(error)
        else:
            raise AssertionError("archive copy capacity was omitted")
    assert startup_evidence["active_run_startup_capacity"]["additional_copy_bytes"] == 100
    with mock.patch("windows.verify_consumer_pump.shutil.disk_usage", side_effect=OSError("unavailable")):
        try:
            _check_active_candidate_capacity(*capacity_paths, "b" * 64, {})
        except backend_gate.storage.StorageError as error:
            assert "could not be verified" in str(error)
        else:
            raise AssertionError("unverified candidate capacity was accepted")


def valid_result() -> dict[str, object]:
    return {
        "schema": ACTIVE_RUN_RESULT_SCHEMA,
        "status": "passed",
        "request_id": REQUEST_ID,
        "old_api_instance_id": "22222222-2222-4222-8222-222222222222",
        "session_id": "session-active-run",
        "api_transition_epoch_before": 1,
        "api_transition_epoch_after": 1,
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


for invalid_epoch in (0, -1, True, "1", 2**64):
    invalid = valid_result()
    invalid["api_transition_epoch_before"] = invalid_epoch
    rejects(invalid)
for invalid_epoch in (0, 2, True, "1"):
    invalid = valid_result()
    invalid["api_transition_epoch_after"] = invalid_epoch
    rejects(invalid)
legacy_result = valid_result()
legacy_result["schema"] = "fullmag.development-cli-active-run-check.v1"
rejects(legacy_result)


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
        "active-run-reuses-only-exact-verified-executables",
        "candidate-capacity-fails-before-processes-and-preserves-byte-counts",
        "active-run-route-isolated-to-frozen-owner-bundle",
        "exact-active-result-schema-and-checkset-accepted",
        "nonzero-u64-api-transition-epoch-preserved-after-refusal",
        "generic-refusal-reason-and-attribution-required",
        "active-run-must-advance-while-running",
        "solver-must-advance-after-confirmed-refusal",
        "exact-api-and-solver-terminal-pids-required",
        "all-owner-and-candidate-helpers-waited-successfully",
        "early-cli-failure-keeps-terminal-helper-and-bounded-error-tail",
        "unconfirmed-owner-and-solver-custody-stays-unknown",
    ],
}))
