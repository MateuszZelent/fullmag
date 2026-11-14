"""Pure append-only phase journal validation for data-volume migration."""
from copy import deepcopy
import re


SCHEMA = "fullmag.data-volume-journal.v1"
PHASES = (
    "image-created",
    "image-attached",
    "ext4-mounted",
    "group-drained",
    "copy-verified",
    "binds-switched",
    "admission-prepared",
    "runtime-qualified",
    "zarr-qualified",
    "volume-registered",
    "originals-retired",
)

_TOP_LEVEL_KEYS = frozenset({"schema", "volume_id", "request_sha256", "events"})
_EVENT_KEYS = frozenset(
    {"sequence", "phase", "state", "inputs_sha256", "receipt_sha256"}
)
_STARTED = "started"
_TERMINAL_STATES = frozenset(
    {"succeeded", "failed-confirmed", "outcome-unknown-resources-retained"}
)
_EVENT_STATES = frozenset({_STARTED, *_TERMINAL_STATES})
_HEX32 = re.compile(r"[0-9a-f]{32}\Z", re.ASCII)
_HEX64 = re.compile(r"[0-9a-f]{64}\Z", re.ASCII)


def _fail(message: str) -> None:
    raise ValueError(message)


def _require_exact_dict(value, keys, label: str) -> dict:
    if type(value) is not dict or any(type(key) is not str for key in value):
        _fail(f"{label} must be an object with string keys")
    if frozenset(value) != keys:
        _fail(f"{label} has missing or unknown keys")
    return value


def _sha256(value, label: str) -> str:
    if type(value) is not str or _HEX64.fullmatch(value) is None:
        _fail(f"{label} must be a lowercase SHA-256 digest")
    return value


def _volume_id(value) -> str:
    if (
        type(value) is not str
        or _HEX32.fullmatch(value) is None
        or value == "0" * 32
    ):
        _fail("volume_id must be a nonzero 32-character lowercase hexadecimal token")
    return value


def validate_journal(value: dict) -> dict:
    """Validate a complete append-only journal prefix and return a deep copy."""

    value = _require_exact_dict(value, _TOP_LEVEL_KEYS, "journal")
    if value["schema"] != SCHEMA:
        _fail("journal has an unsupported schema")
    _volume_id(value["volume_id"])
    _sha256(value["request_sha256"], "request_sha256")
    events = value["events"]
    if type(events) is not list:
        _fail("journal events must be a list")

    phase_index = 0
    pending = None
    stopped = False
    for position, raw_event in enumerate(events, start=1):
        event = _require_exact_dict(raw_event, _EVENT_KEYS, f"events[{position - 1}]")
        sequence = event["sequence"]
        if type(sequence) is not int or sequence != position:
            _fail("journal event sequence must be a positive 1-based integer")
        phase = event["phase"]
        if type(phase) is not str or phase not in PHASES:
            _fail("journal event phase is unknown")
        state = event["state"]
        if type(state) is not str or state not in _EVENT_STATES:
            _fail("journal event state is unknown")
        inputs_digest = _sha256(event["inputs_sha256"], "event inputs_sha256")

        if pending is None:
            if stopped:
                _fail("journal cannot continue after a failed or unknown phase")
            if phase_index >= len(PHASES) or phase != PHASES[phase_index]:
                _fail("journal phases must start once in the declared order")
            if state != _STARTED:
                _fail("every journal phase must begin with a started event")
            if event["receipt_sha256"] is not None:
                _fail("started events must not have a receipt_sha256")
            pending = {"phase": phase, "inputs_sha256": inputs_digest}
            continue

        if phase != pending["phase"]:
            _fail("a started phase must be followed by its own terminal event")
        if state == _STARTED:
            _fail("a started phase may have only one start event")
        if state not in _TERMINAL_STATES:
            _fail("journal phase has no valid terminal state")
        if inputs_digest != pending["inputs_sha256"]:
            _fail("terminal event inputs_sha256 differs from its started event")
        _sha256(event["receipt_sha256"], "terminal receipt_sha256")

        pending = None
        if state == "succeeded":
            phase_index += 1
        else:
            stopped = True

    return deepcopy(value)


def new_journal(volume_id: str, request_sha256: str) -> dict:
    """Create an empty journal after validating its immutable request identity."""

    value = {
        "schema": SCHEMA,
        "volume_id": _volume_id(volume_id),
        "request_sha256": _sha256(request_sha256, "request_sha256"),
        "events": [],
    }
    return validate_journal(value)


def _progress(value: dict) -> tuple[int, bool, bool]:
    value = validate_journal(value)
    phase_index = 0
    pending = False
    stopped = False
    for event in value["events"]:
        if event["state"] == _STARTED:
            pending = True
        else:
            pending = False
            if event["state"] == "succeeded":
                phase_index += 1
            else:
                stopped = True
    return phase_index, pending, stopped


def next_phase(value: dict) -> str | None:
    """Return the next phase only when no started or terminal stop is pending."""

    phase_index, pending, stopped = _progress(value)
    if pending:
        _fail("a journal phase is still started and has no terminal receipt")
    if stopped:
        _fail("journal is stopped after a failed or outcome-unknown phase")
    if phase_index == len(PHASES):
        return None
    return PHASES[phase_index]


def append_started(value: dict, phase: str, inputs_sha256: str) -> dict:
    """Append the start marker for exactly the next eligible phase."""

    validated = validate_journal(value)
    expected_phase = next_phase(validated)
    if expected_phase is None:
        _fail("all journal phases are already complete")
    if type(phase) is not str or phase != expected_phase:
        _fail("started event phase is not the next eligible phase")
    inputs_sha256 = _sha256(inputs_sha256, "inputs_sha256")
    validated["events"].append(
        {
            "sequence": len(validated["events"]) + 1,
            "phase": phase,
            "state": _STARTED,
            "inputs_sha256": inputs_sha256,
            "receipt_sha256": None,
        }
    )
    return validate_journal(validated)


def append_terminal(value: dict, state: str, receipt_sha256: str) -> dict:
    """Append one terminal compare-and-set event for the pending start."""

    validated = validate_journal(value)
    if type(state) is not str or state not in _TERMINAL_STATES:
        _fail("terminal state must be succeeded, failed-confirmed, or outcome-unknown")
    if not validated["events"] or validated["events"][-1]["state"] != _STARTED:
        _fail("terminal event requires one currently pending started event")
    receipt_sha256 = _sha256(receipt_sha256, "receipt_sha256")
    started = validated["events"][-1]
    validated["events"].append(
        {
            "sequence": len(validated["events"]) + 1,
            "phase": started["phase"],
            "state": state,
            "inputs_sha256": started["inputs_sha256"],
            "receipt_sha256": receipt_sha256,
        }
    )
    return validate_journal(validated)
