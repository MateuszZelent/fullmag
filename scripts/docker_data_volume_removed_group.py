"""Read-only confirmation that the exact old DEV service pair is absent.

This observer requires the retained relocated/copy scope and an active
managed migration operation. It neither removes containers nor admits startup.
"""
from __future__ import annotations

import re
from pathlib import Path

from docker_build_control import docker_capture
from docker_data_volume_relocated import require_relocated
from docker_dev_data_volume import _decode, _runtime_pins
from docker_data_volume_stopped_group import _unqualified_consumers


def require(value, message):
    if not value:
        raise ValueError(message)


def _container_ids():
    raw = docker_capture("ps", "--all", "--no-trunc", "--format", "{{.ID}}").stdout
    require(type(raw) is bytes, "Successful complete Docker container inventory required")
    try:
        ids = raw.decode("ascii", "strict").split()
    except UnicodeDecodeError as error:
        raise ValueError("Docker container inventory is not ASCII full IDs") from error
    require(ids and len(ids) == len(set(ids)) and
            all(re.fullmatch(r"[0-9a-f]{64}", value) for value in ids),
            "Complete unambiguous container inventory required")
    return set(ids)


def observe_removed_group(control, source, plan, *, fence=None, relocated):
    """Observe absence of the pinned old backend/frontend service pair."""
    operation = getattr(control, "_active_operation", None)
    require(operation is not None and operation["receipt"].get("phase") == "data-volume-migration",
            "A live migration lease is required for removed-group observation")
    helper_id = control._assert_live_operation_helper(operation)
    require(type(helper_id) is str and re.fullmatch(r"[0-9a-f]{64}", helper_id) and
            operation.get("helper_container_id") == helper_id,
            "Exact live control helper identity is required")
    pins = _runtime_pins(plan["runtime_pins"])
    require(plan.get("source_root") == str(source) and
            plan.get("compose_project") == control.project and
            pins["image_id"] == control.image and
            type(plan.get("volume_id")) is str and
            re.fullmatch(r"[0-9a-f]{32}", plan["volume_id"]) and plan["volume_id"] != "0" * 32,
            "Removed-group plan source/project/image/volume differs")

    allowed = {helper_id}
    if fence is not None:
        require(fence.control is control and fence.operation is operation and
                fence.request["volume_id"] == plan["volume_id"] and
                fence.request["token"] == operation["receipt"]["attempt"] and
                getattr(fence, "relocated", None) is relocated and
                type(fence.identifier) is str and re.fullmatch(r"[0-9a-f]{64}", fence.identifier),
                "Foreign live copy fence")
        fence.check()
        allowed.add(fence.identifier)
    old = {pins["backend"], pins["frontend"]}
    require(old.isdisjoint(allowed), "Removed service identity overlaps a live migration helper")

    view = require_relocated(relocated, source, plan)
    require(type(view) is dict and set(view) == {"old_roots", "canonical_roots", "consumer_roots"} and
            type(view["consumer_roots"]) in (tuple, list) and view["consumer_roots"] and
            all(isinstance(root, Path) for root in view["consumer_roots"]),
            "Exact live relocated consumer roots are required")

    ids = _container_ids()
    require(allowed <= ids, "Live migration helper/fence is absent from the full container inventory")
    require(old.isdisjoint(ids), "A pinned old service container is still present")
    actuals = _decode(docker_capture("inspect", *sorted(ids)).stdout)
    require(type(actuals) is list and len(actuals) == len(ids) and
            all(type(actual) is dict for actual in actuals) and
            {actual.get("Id") for actual in actuals} == ids,
            "Container inspection changed its complete inventory")
    by_id = {actual["Id"]: actual for actual in actuals}
    helper_state = by_id[helper_id].get("State", {})
    require(helper_state.get("Running") is True and helper_state.get("Status") == "running" and
            type(helper_state.get("Pid")) is int and helper_state["Pid"] > 0,
            "Pinned control helper is not live in the complete inventory")
    consumers, _windows_proofs = _unqualified_consumers(
        control, actuals, allowed, tuple(view["consumer_roots"]), relocated=relocated
    )
    require(not consumers, "Unqualified source consumers: " + str(consumers))

    control._assert_live_operation_helper(operation)
    require_relocated(relocated, source, plan)
    if fence is not None:
        fence.check()
    final_ids = _container_ids()
    require(final_ids == ids, "Docker container inventory changed during removal observation")
    require(old.isdisjoint(final_ids), "A pinned old service container appeared during observation")
    require(control._active_operation is operation and
            control._assert_live_operation_helper(operation) == helper_id,
            "Managed migration helper changed during removal observation")
    require_relocated(relocated, source, plan)
    if fence is not None:
        fence.check()

    return {
        "state": "removed-services-observed",
        "removed_containers": {"backend": pins["backend"], "frontend": pins["frontend"]},
        "observed_container_ids": sorted(final_ids),
        "consumers": [],
    }
