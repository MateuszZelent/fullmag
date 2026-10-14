"""Bounded identity/phase ledger for a future two-cycle browser proof.

This prerequisite stores evidence already verified by the native/browser
bridge. It does not perform runtime, API, scene, solver, filesystem, network,
or process checks, and it does not promote restart availability or qualify a
runtime. The bridge remains responsible for semantic proof and terminal
custody; this ledger prevents identity drift and evidence replacement across
one or two consecutive handoffs. Call every mutating method serially while
holding the bridge's existing lock; this ledger does not add synchronization.
"""

from __future__ import annotations

import copy
import json
import math
import re
import uuid
from typing import Any


MAX_CYCLES = 2
LEDGER_SCHEMA = "fullmag.development-browser-chain-ledger.v1"
_SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
_GENERATION_RE = re.compile(r"[0-9a-f]{32}\Z")


class DevelopmentBrowserChainError(ValueError):
    """Raised when chain identity, phase order, or immutable evidence fails."""


class DevelopmentBrowserChainLedger:
    """Store verified handoff evidence for exactly one or two cycles.

    The caller supplies normalized proof records only after its existing
    bridge has verified each browser/API observation. A cycle follows
    ``before -> restored -> after``; cycle 2 can start only from cycle 1's
    confirmed restored owner and target build. ``finish`` succeeds only when
    the configured cycle count is complete. The bridge must serialize calls
    under its existing lock, including ``record_before``; this class is not a
    thread-safety or runtime-qualification mechanism.
    """

    def __init__(self, nonce: str, generation_id: str, expected_cycles: int = 1):
        _canonical_uuid(nonce, "nonce")
        _canonical_generation(generation_id)
        if type(expected_cycles) is not int or expected_cycles not in (1, MAX_CYCLES):
            raise DevelopmentBrowserChainError("Expected cycle count must be the integer 1 or 2")
        self._nonce = nonce
        self._generation_id = generation_id
        self._expected_cycles = expected_cycles
        self._cycles: list[dict[str, Any]] = []
        self._finished = False
        self._request_ids: set[str] = set()
        self._api_pins: list[str] = []
        self._builds: list[dict[str, str]] = []

    def record_before(self, evidence: dict[str, Any]) -> None:
        """Record an immutable source snapshot and reserve the cycle request."""
        self._require_open()
        value = _json_object(evidence, "before evidence")
        _require_keys(value, {
            "cycle", "nonce", "generation_id", "request_id", "source_build",
            "target_build", "source_owner", "snapshot",
        }, "before evidence")
        cycle = self._validate_cycle_scope(value)
        if cycle != len(self._cycles) + 1 or cycle > self._expected_cycles:
            raise DevelopmentBrowserChainError("Before evidence is out of cycle order")
        if cycle > 1:
            previous = self._cycles[-1]
            if previous["after"] is None:
                raise DevelopmentBrowserChainError("The previous cycle has not completed its after phase")

        request_id = _canonical_uuid(value["request_id"], "request_id")
        if request_id in self._request_ids:
            raise DevelopmentBrowserChainError("Restart request ID was reused")
        source_build = _build(value["source_build"], "source_build")
        target_build = _build(value["target_build"], "target_build")
        source_owner = _owner(value["source_owner"], "source_owner")

        if cycle == 1:
            if source_owner["api_instance_id"] in self._api_pins:
                raise DevelopmentBrowserChainError("Source API pin was already used")
        else:
            previous = self._cycles[-1]
            restored = previous["restored"]
            if restored is None:
                raise DevelopmentBrowserChainError("Cycle 2 is not bound to a confirmed cycle 1 restore")
            if source_owner != restored["owner"]:
                raise DevelopmentBrowserChainError("Cycle 2 source is not the confirmed cycle 1 owner")
            if source_build != previous["target_build"]:
                raise DevelopmentBrowserChainError("Cycle 2 source build is not the confirmed cycle 1 target")

        source_pin = source_owner["api_instance_id"]
        if cycle > 1 and source_pin != self._api_pins[-1]:
            raise DevelopmentBrowserChainError("Source API pin does not continue the owner chain")
        if any(target_build[key] in {build[key] for build in self._builds}
               for key in ("build_id", "source_sha256")):
            raise DevelopmentBrowserChainError("Target build identity was already used in this chain")
        if any(target_build[key] == source_build[key] for key in ("build_id", "source_sha256")):
            raise DevelopmentBrowserChainError("Source and target build identities must differ")

        before_snapshot = _snapshot(value["snapshot"], "before snapshot")
        cycle_record = {
            "cycle": cycle,
            "request_id": request_id,
            "source_build": source_build,
            "target_build": target_build,
            "before": {"owner": source_owner, "snapshot": before_snapshot},
            "restored": None,
            "after": None,
        }
        self._cycles.append(cycle_record)
        self._request_ids.add(request_id)
        if cycle == 1:
            self._api_pins.append(source_owner["api_instance_id"])
            self._builds.append(source_build)

    def record_restored(self, evidence: dict[str, Any]) -> None:
        """Bind the hydrate snapshot to the exact requested target owner."""
        self._require_open()
        value = _json_object(evidence, "restored evidence")
        _require_keys(value, {
            "cycle", "nonce", "generation_id", "request_id", "api_response_pin",
            "target_build", "owner", "snapshot",
        }, "restored evidence")
        cycle = self._validate_cycle_scope(value)
        record = self._current(cycle, expected_phase="before")
        if _canonical_uuid(value["request_id"], "request_id") != record["request_id"]:
            raise DevelopmentBrowserChainError("Restored evidence belongs to another request")
        target_build = _build(value["target_build"], "target_build")
        if target_build != record["target_build"]:
            raise DevelopmentBrowserChainError("Restored evidence changed the requested target build")
        owner = _owner(value["owner"], "restored owner")
        target_pin = owner["api_instance_id"]
        response_pin = _canonical_uuid(value["api_response_pin"], "api_response_pin")
        if response_pin != target_pin:
            raise DevelopmentBrowserChainError("Restored API response pin differs from its owner")
        if target_pin == record["before"]["owner"]["api_instance_id"] or target_pin in self._api_pins:
            raise DevelopmentBrowserChainError("API instance pin was reused")
        source_owner = record["before"]["owner"]
        if (owner["session_id"] == source_owner["session_id"]
                or owner["session_resource_epoch"] == source_owner["session_resource_epoch"]
                or owner["request_scope_epoch"] == source_owner["request_scope_epoch"]):
            raise DevelopmentBrowserChainError("Restored owner reused its previous session/request scope")
        record["restored"] = {
            "owner": owner,
            "api_response_pin": response_pin,
            "target_build": target_build,
            "snapshot": _snapshot(value["snapshot"], "restored snapshot"),
        }
        self._api_pins.append(target_pin)
        self._builds.append(target_build)

    def record_after(self, evidence: dict[str, Any]) -> None:
        """Record after-state plus terminal custody of this cycle's source API.

        The restored owner remains live for a possible next cycle. The source
        API must have a terminal wait, but its exit code is evidence and need
        not be zero.
        """
        self._require_open()
        value = _json_object(evidence, "after evidence")
        _require_keys(value, {
            "cycle", "nonce", "generation_id", "request_id", "owner", "snapshot",
            "source_api_instance_id", "source_api_waited", "source_api_exit_code",
        }, "after evidence")
        cycle = self._validate_cycle_scope(value)
        record = self._current(cycle, expected_phase="restored")
        if _canonical_uuid(value["request_id"], "request_id") != record["request_id"]:
            raise DevelopmentBrowserChainError("After evidence belongs to another request")
        owner = _owner(value["owner"], "after owner")
        if owner != record["restored"]["owner"]:
            raise DevelopmentBrowserChainError("After evidence changed the confirmed restored owner")
        source_api_instance_id = _canonical_uuid(value["source_api_instance_id"], "source_api_instance_id")
        if source_api_instance_id != record["before"]["owner"]["api_instance_id"]:
            raise DevelopmentBrowserChainError("Terminal wait is not bound to this cycle's source API")
        if value["source_api_waited"] is not True or type(value["source_api_exit_code"]) is not int:
            raise DevelopmentBrowserChainError("After evidence lacks a source API terminal wait")
        record["after"] = {
            "owner": owner,
            "snapshot": _snapshot(value["snapshot"], "after snapshot"),
            "source_api_instance_id": source_api_instance_id,
            "source_api_waited": True,
            # The source API may be deliberately stopped with exit code 1;
            # the restored owner stays live for a possible next cycle.
            "source_api_exit_code": value["source_api_exit_code"],
        }

    def finish(self, nonce: str, generation_id: str) -> dict[str, Any]:
        """Close a fully evidenced chain and return a detached ledger copy."""
        self._require_open()
        self._validate_chain_scope(nonce, generation_id)
        if len(self._cycles) != self._expected_cycles or any(
            cycle["before"] is None or cycle["restored"] is None or cycle["after"] is None
            for cycle in self._cycles
        ):
            raise DevelopmentBrowserChainError("Cannot finish before every configured cycle completes")
        self._finished = True
        return self.snapshot()

    def snapshot(self) -> dict[str, Any]:
        """Return a deep copy; callers cannot mutate the ledger through it."""
        return copy.deepcopy({
            "schema": LEDGER_SCHEMA,
            "nonce": self._nonce,
            "generation_id": self._generation_id,
            "expected_cycles": self._expected_cycles,
            "cycles": self._cycles,
            "finished": self._finished,
        })

    def _validate_cycle_scope(self, value: dict[str, Any]) -> int:
        if value["nonce"] != self._nonce or value["generation_id"] != self._generation_id:
            raise DevelopmentBrowserChainError("Evidence has a different chain nonce or generation")
        cycle = value["cycle"]
        if type(cycle) is not int or cycle not in (1, MAX_CYCLES):
            raise DevelopmentBrowserChainError("Cycle must be the integer 1 or 2")
        return cycle

    def _validate_chain_scope(self, nonce: str, generation_id: str) -> None:
        _canonical_uuid(nonce, "nonce")
        _canonical_generation(generation_id)
        if nonce != self._nonce or generation_id != self._generation_id:
            raise DevelopmentBrowserChainError("Finish has a different chain nonce or generation")

    def _current(self, cycle: int, *, expected_phase: str) -> dict[str, Any]:
        if cycle != len(self._cycles) or cycle < 1:
            raise DevelopmentBrowserChainError("Evidence does not target the active cycle")
        record = self._cycles[-1]
        if record[expected_phase] is None:
            raise DevelopmentBrowserChainError(f"Cycle {expected_phase} phase is missing")
        next_phase = {"before": "restored", "restored": "after"}[expected_phase]
        if record[next_phase] is not None:
            raise DevelopmentBrowserChainError(f"Cycle {next_phase} evidence is immutable")
        return record

    def _require_open(self) -> None:
        if self._finished:
            raise DevelopmentBrowserChainError("Browser chain is already finished")


def _canonical_uuid(value: Any, name: str) -> str:
    if not isinstance(value, str):
        raise DevelopmentBrowserChainError(f"{name} must be a canonical UUID")
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError):
        raise DevelopmentBrowserChainError(f"{name} must be a canonical UUID") from None
    if parsed.int == 0 or str(parsed) != value:
        raise DevelopmentBrowserChainError(f"{name} must be a canonical UUID")
    return value


def _canonical_generation(value: Any) -> str:
    if not isinstance(value, str) or not _GENERATION_RE.fullmatch(value) or int(value, 16) == 0:
        raise DevelopmentBrowserChainError("Generation ID must be a canonical 32-digit UUID hex string")
    return value


def _build(value: Any, name: str) -> dict[str, str]:
    build = _json_object(value, name)
    _require_keys(build, {"build_id", "source_sha256"}, name)
    for key in ("build_id", "source_sha256"):
        digest = build[key]
        if not isinstance(digest, str) or not _SHA256_RE.fullmatch(digest):
            raise DevelopmentBrowserChainError(f"{name}.{key} must be a lowercase SHA-256")
    return build


def _owner(value: Any, name: str) -> dict[str, Any]:
    owner = _json_object(value, name)
    _require_keys(owner, {
        "api_instance_id", "session_id", "session_epoch",
        "session_resource_epoch", "request_scope_epoch",
    }, name)
    api_instance_id = _canonical_uuid(owner["api_instance_id"], f"{name}.api_instance_id")
    session_id = owner["session_id"]
    session_epoch = owner["session_epoch"]
    session_resource_epoch = owner["session_resource_epoch"]
    request_scope_epoch = owner["request_scope_epoch"]
    if not isinstance(session_id, str) or not session_id.strip():
        raise DevelopmentBrowserChainError(f"{name}.session_id must be a nonempty session identifier")
    if type(session_epoch) is not int or session_epoch < 0:
        raise DevelopmentBrowserChainError(f"{name}.session_epoch must be a nonnegative integer")
    if (not isinstance(session_resource_epoch, str)
            or not session_resource_epoch.startswith(session_id + "@")
            or not session_resource_epoch[len(session_id) + 1:]):
        raise DevelopmentBrowserChainError(f"{name}.session_resource_epoch is not bound to its session")
    if request_scope_epoch != f"{api_instance_id}:{session_epoch}":
        raise DevelopmentBrowserChainError(f"{name}.request_scope_epoch is not bound to its API/session epoch")
    return owner


def _json_object(value: Any, name: str) -> dict[str, Any]:
    if type(value) is not dict:
        raise DevelopmentBrowserChainError(f"{name} must be a JSON object")
    try:
        result = copy.deepcopy(value)
        _validate_json_value(result)
        json.dumps(result, allow_nan=False, separators=(",", ":"), sort_keys=True)
    except (TypeError, ValueError, OverflowError, RecursionError):
        raise DevelopmentBrowserChainError(f"{name} must contain finite JSON values") from None
    return result


def _snapshot(value: Any, name: str) -> dict[str, Any]:
    snapshot = _json_object(value, name)
    if not snapshot:
        raise DevelopmentBrowserChainError(f"{name} must contain evidence")
    return snapshot


def _validate_json_value(value: Any) -> None:
    if value is None or type(value) in (str, bool, int):
        return
    if type(value) is float:
        if not math.isfinite(value):
            raise ValueError("non-finite JSON number")
        return
    if type(value) is list:
        for item in value:
            _validate_json_value(item)
        return
    if type(value) is dict:
        for key, item in value.items():
            if type(key) is not str:
                raise ValueError("JSON object key is not a string")
            _validate_json_value(item)
        return
    raise TypeError("unsupported JSON value")


def _require_keys(value: dict[str, Any], expected: set[str], name: str) -> None:
    if set(value) != expected:
        raise DevelopmentBrowserChainError(f"{name} has an invalid field set")
