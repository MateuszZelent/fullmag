#!/usr/bin/env python3
"""Validate bounded C04 measurements from a real verbose CTest log.

Complete phase coverage is diagnostic evidence only. The current native schema
binds v2 IDs within a process/attempt; legacy pairing remains NOT VERIFIED.
Scientific qualification and failure cause remain NOT VERIFIED in all cases.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import re

PREFIX = "FULLMAG_FLOQUET_FACTOR_MATRIX_SNAPSHOT "
ACTION_PREFIX = "FULLMAG_FLOQUET_FACTOR_ACTION_PROBE "
SCHEMA = "fullmag.floquet-factor-matrix-snapshot.v2"
ACTION_SCHEMA = "fullmag.floquet-factor-action-probe.v1"
ACTION_CAPTURE_SCOPE = "first_b_c_snapshot_pair"
LEGACY_SCHEMA = "fullmag.floquet-factor-matrix-snapshot.v1"
PHASES = (
    "A_shifted_pmat_before_live_setup",
    "B_live_pc_pmat_before_duplicate",
    "C_owned_copy_before_fresh_setup",
)
MAX_LINE_BYTES = 9216
MAX_RECORDS = 2048
REQUIRED_TESTS = ("fem_modal_eigen_contract", "fem_modal_eigen_mixed_dense_contract")
CONFIGURATION_FIELDS = frozenset((
    "pc_object_id_available", "pc_object_id_error_available", "pc_object_id_error", "pc_object_id",
    "pc_type_error_available", "pc_type_error", "pc_is_lu_available", "pc_is_lu",
    "zero_pivot_attempted", "zero_pivot_error_available", "zero_pivot_error",
    "zero_pivot_available", "zero_pivot", "inode_metadata_scope", "inode_query_attempted",
    "inode_error_available", "inode_error", "inode_metadata_available", "inode_count",
    "inode_limit", "inode_csr_offsets_available", "inode_csr_offsets",
))
INODE_METADATA_SCOPE = "pinned_3_24_6_input_matrix_size_csr_not_factor_or_use_flag"
PC_CONFIGURATION_SCOPE = "public_pc_getter_observations_only; no factor perturbation or causal explanation"
INODE_COMPARISON_SCOPE = "input_matrix_inode_size_and_csr_metadata_only; never MAT_USE_INODES or factor-internal cache"
ZERO_PIVOT_COMPARISON_SCOPE = "separate public zero-pivot getter readings for confirmed LU PCs; equality does not establish the same PC object, factor, or configuration; no factor perturbation or causal inference"
ACTION_PROBE_SCOPE = "already-computed live/fresh action measurements bound to first B/C callback; no solver-cause or factor-perturbation claim"
ACTION_VALUE_FIELDS = (
    "live_pmat_residual_l2_norm", "live_pmat_relative_residual",
    "live_shifted_operator_residual_l2_norm", "live_shifted_operator_relative_residual",
    "live_actual_shift_amount", "fresh_configured_shift_amount",
    "same_private_rhs_l2_norm", "fresh_pmat_residual_l2_norm",
    "fresh_pmat_relative_residual", "fresh_shifted_operator_residual_l2_norm",
    "fresh_shifted_operator_relative_residual",
)


def validate_action_probe(record: object) -> list[str]:
    """Validate a separately bound action observation without changing matrix evidence."""
    if not isinstance(record, dict):
        return ["action probe root is not an object"]
    errors = []
    if record.get("schema") != ACTION_SCHEMA or record.get("status") != "captured" \
            or record.get("truncated") is not False:
        errors.append("action probe schema/status/truncation declaration is invalid")
    if record.get("attempt_scope_semantics") != "process_local_eps_setup_sequence" \
            or record.get("capture_scope") != ACTION_CAPTURE_SCOPE:
        errors.append("action probe attempt/capture scope is invalid")
    if record.get("live_shift_measurement_scope") != \
            "queried_live_PCLU_configuration_not_actual_factor_perturbation" \
            or record.get("fresh_shift_measurement_scope") != "fresh_copy_configuration_inputs_only" \
            or record.get("same_private_rhs_source") != "live_pc_rhs_snapshot":
        errors.append("action probe shift/RHS measurement scope is invalid")
    for key in ("attempt_scope_id", "callback_ordinal"):
        if type(record.get(key)) is not int or record[key] <= 0:
            errors.append(f"action probe {key} is unavailable or invalid")

    def boolean(name: str) -> bool | None:
        value = record.get(name)
        if type(value) is not bool:
            errors.append(f"action probe {name} is not a boolean")
            return None
        return value

    def available_value(name: str, *, nonnegative: bool = False) -> bool | None:
        available = boolean(name + "_available")
        value = record.get(name)
        if available is True:
            if type(value) not in (int, float):
                errors.append(f"action probe {name} is marked available without a number")
            else:
                try:
                    finite = math.isfinite(float(value))
                except (OverflowError, ValueError):
                    finite = False
                if not finite or (nonnegative and value < 0):
                    errors.append(f"action probe {name} is nonfinite or outside its range")
        elif value is not None:
            errors.append(f"unavailable action probe {name} must be null")
        return available

    for name in ACTION_VALUE_FIELDS:
        available_value(name, nonnegative=name != "live_actual_shift_amount")

    live_type_available = boolean("live_actual_shift_type_available")
    live_type = record.get("live_actual_shift_type")
    known_shift_types = {
        "MAT_SHIFT_NONE", "MAT_SHIFT_NONZERO", "MAT_SHIFT_POSITIVE_DEFINITE", "MAT_SHIFT_INBLOCKS",
    }
    if live_type_available is True:
        if not isinstance(live_type, str) or live_type not in known_shift_types:
            errors.append("available live shift type is not a recognized PETSc shift type")
    elif live_type is not None:
        errors.append("unavailable live shift type must be null")

    live_enum_available = boolean("live_actual_shift_type_enum_available")
    live_enum = record.get("live_actual_shift_type_enum")
    if live_enum_available is True:
        if type(live_enum) is not int:
            errors.append("available live shift type enum is not an integer")
    elif live_enum is not None:
        errors.append("unavailable live shift type enum must be null")
    if live_type_available is True and live_enum_available is not True:
        errors.append("available live shift type lacks its getter enum")

    fresh_type_available = boolean("fresh_configured_shift_type_available")
    fresh_type = record.get("fresh_configured_shift_type")
    if fresh_type_available is True:
        if fresh_type != "MAT_SHIFT_NONZERO":
            errors.append("available fresh shift type contradicts configured policy")
    elif fresh_type is not None:
        errors.append("unavailable fresh shift type must be null")
    fresh_amount_available = record.get("fresh_configured_shift_amount_available")
    if fresh_amount_available is True and fresh_type_available is not True:
        errors.append("fresh shift amount is available without configured shift type")

    entry_available = boolean("entry_comparison_available")
    equal_available = boolean("values_equal_available")
    values_equal = record.get("values_equal")
    if equal_available is True:
        if type(values_equal) is not bool:
            errors.append("available entry equality has no boolean value")
        if entry_available is not True:
            errors.append("entry equality is available without a full entry comparison")
    elif values_equal is not None:
        errors.append("unavailable entry equality must be null")
    if entry_available is True and equal_available is not True:
        errors.append("full entry comparison lacks an equality result")
    return errors


def _action_probe_pair_report(
    items: list[dict], action_records: list[dict],
) -> tuple[dict, list[dict]]:
    """Bind an action marker to exact CTest invocation, attempt, and B/C ordinal."""
    b = items[1]["snapshot"]
    c = items[2]["snapshot"]
    invocation = items[1].get("ctest_invocation")
    attempt_id = b.get("attempt_scope_id")
    callback = b.get("callback_ordinal")
    candidates = [item for item in action_records
                  if item.get("ctest_invocation") == invocation
                  and isinstance(item.get("probe"), dict)
                  and item["probe"].get("attempt_scope_id") == attempt_id]
    exact = [item for item in candidates if item["probe"].get("callback_ordinal") == callback]
    rejected = []
    for item in candidates:
        problems = validate_action_probe(item.get("probe"))
        if item not in exact:
            problems.append("action probe callback ordinal does not match B/C snapshots")
        if item in exact and item.get("line", 0) <= items[2].get("line", 0):
            problems.append("action probe was not emitted after the C snapshot")
        if problems:
            rejected.append({"line": item.get("line"), "reasons": problems})
    if len(exact) != 1:
        reason = "no exact invocation/attempt/callback action marker" if not exact \
            else "multiple action markers match one B/C callback"
        return ({
            "binding_status": "NOT VERIFIED", "measurement_status": "NOT VERIFIED",
            "reason": reason, "scope": ACTION_PROBE_SCOPE, "record": None,
            "rejected_markers": rejected,
        }, rejected)
    if len(candidates) != 1:
        return ({
            "binding_status": "NOT VERIFIED", "measurement_status": "NOT VERIFIED",
            "reason": "attempt has more than one action marker",
            "scope": ACTION_PROBE_SCOPE, "record": None,
            "rejected_markers": rejected,
        }, rejected)
    item = exact[0]
    problems = validate_action_probe(item.get("probe"))
    if item.get("line", 0) <= items[2].get("line", 0):
        problems.append("action probe was not emitted after the C snapshot")
    if problems:
        if not rejected:
            rejected.append({"line": item.get("line"), "reasons": problems})
        return ({
            "binding_status": "NOT VERIFIED", "measurement_status": "NOT VERIFIED",
            "reason": "matching action marker failed schema/value validation",
            "scope": ACTION_PROBE_SCOPE, "record": None,
            "rejected_markers": rejected,
        }, rejected)
    probe = item["probe"]
    all_values_available = all(probe.get(name + "_available") is True for name in ACTION_VALUE_FIELDS) \
        and probe.get("live_actual_shift_type_available") is True \
        and probe.get("live_actual_shift_type_enum_available") is True \
        and probe.get("fresh_configured_shift_type_available") is True \
        and probe.get("entry_comparison_available") is True \
        and probe.get("values_equal_available") is True
    return ({
        "binding_status": "VERIFIED",
        "measurement_status": "VERIFIED" if all_values_available else "NOT VERIFIED",
        "reason": None if all_values_available else "one or more source measurements are truthfully unavailable",
        "scope": ACTION_PROBE_SCOPE,
        "record": probe,
        "rejected_markers": rejected,
    }, rejected)


def _configuration_measurements(record: dict) -> tuple[dict | None, list[str]]:
    """Read optional v2 PC/inode evidence without treating absence as a value."""
    present = CONFIGURATION_FIELDS.intersection(record)
    if not present:
        return None, []
    if present != CONFIGURATION_FIELDS:
        return None, ["configuration evidence is partial"]

    errors = []

    def boolean(name: str) -> bool | None:
        value = record[name]
        if type(value) is not bool:
            errors.append(f"{name} is not a boolean")
            return None
        return value

    def integer(name: str) -> int | None:
        value = record[name]
        if type(value) is not int:
            errors.append(f"{name} is not an integer")
            return None
        return value

    pc_id_available = boolean("pc_object_id_available")
    pc_id_error_available = boolean("pc_object_id_error_available")
    pc_id_error = integer("pc_object_id_error")
    pc_id = record["pc_object_id"]
    if pc_id_available is True:
        if pc_id_error_available is not True or pc_id_error != 0 or type(pc_id) is not int or pc_id <= 0:
            errors.append("available PC object ID lacks a successful getter and positive integer ID")
    elif pc_id is not None:
        errors.append("unavailable PC object ID must be null")
    if pc_id_error_available is False and pc_id_error == 0:
        errors.append("unattempted PC object ID getter reports success")
    if pc_id_error_available is True and pc_id_error not in (None, 0) and pc_id_available is True:
        errors.append("failed PC object ID getter is marked available")

    pc_type_error_available = boolean("pc_type_error_available")
    pc_type_error = integer("pc_type_error")
    pc_is_lu_available = boolean("pc_is_lu_available")
    pc_is_lu = record["pc_is_lu"]
    if pc_is_lu_available is True:
        if pc_type_error_available is not True or pc_type_error != 0 or type(pc_is_lu) is not bool:
            errors.append("available PC type lacks a successful getter or boolean value")
    elif pc_is_lu is not None:
        errors.append("unavailable PC type must be null")
    if pc_type_error_available is False and pc_type_error == 0:
        errors.append("unattempted PC type getter reports success")
    if pc_type_error_available is True and pc_type_error not in (None, 0) and pc_is_lu_available is True:
        errors.append("failed PC type getter is marked available")

    zero_pivot_attempted = boolean("zero_pivot_attempted")
    zero_pivot_error_available = boolean("zero_pivot_error_available")
    zero_pivot_error = record["zero_pivot_error"]
    zero_pivot_available = boolean("zero_pivot_available")
    zero_pivot = record["zero_pivot"]
    if zero_pivot_attempted is True:
        if zero_pivot_error_available is not True or type(zero_pivot_error) is not int:
            errors.append("attempted zero-pivot getter lacks an error result")
        if pc_is_lu_available is not True or pc_is_lu is not True:
            errors.append("zero-pivot getter was attempted without a confirmed LU PC")
    elif zero_pivot_error_available is not False or zero_pivot_error is not None:
        errors.append("unattempted zero-pivot getter must have no error result")
    if zero_pivot_attempted is not None and zero_pivot_error_available is not None \
            and zero_pivot_attempted != zero_pivot_error_available:
        errors.append("zero-pivot attempt and error availability disagree")
    if pc_is_lu_available is True and pc_is_lu is True and zero_pivot_attempted is False:
        errors.append("confirmed LU PC has no zero-pivot getter attempt")
    if zero_pivot_available is True:
        if zero_pivot_attempted is not True or zero_pivot_error_available is not True \
                or zero_pivot_error != 0 or type(zero_pivot) not in (int, float):
            errors.append("available zero-pivot value lacks a successful getter")
        else:
            try:
                if not math.isfinite(float(zero_pivot)) or zero_pivot < 0:
                    errors.append("available zero-pivot value is not finite and nonnegative")
            except (OverflowError, ValueError):
                errors.append("available zero-pivot value cannot be represented")
    elif zero_pivot is not None:
        errors.append("unavailable zero-pivot value must be null")
    if zero_pivot_attempted is True and zero_pivot_error_available is True \
            and zero_pivot_error not in (None, 0) and zero_pivot_available is True:
        errors.append("failed zero-pivot getter is marked available")

    if record["inode_metadata_scope"] != INODE_METADATA_SCOPE:
        errors.append("inode metadata scope is not the pinned input-matrix scope")
    inode_query_attempted = boolean("inode_query_attempted")
    inode_error_available = boolean("inode_error_available")
    inode_error = record["inode_error"]
    inode_metadata_available = boolean("inode_metadata_available")
    inode_count = record["inode_count"]
    inode_count_is_int = type(inode_count) is int
    inode_limit = record["inode_limit"]
    inode_offsets_available = boolean("inode_csr_offsets_available")
    inode_offsets = record["inode_csr_offsets"]
    if inode_query_attempted is True:
        if inode_error_available is not True or type(inode_error) is not int:
            errors.append("attempted inode query lacks an error result")
    elif inode_error_available is not False or inode_error is not None:
        errors.append("unattempted inode query must have no error result")
    if inode_query_attempted is not None and inode_error_available is not None \
            and inode_query_attempted != inode_error_available:
        errors.append("inode query attempt and error availability disagree")
    if inode_metadata_available is True:
        if inode_query_attempted is not True or inode_error_available is not True or inode_error != 0:
            errors.append("available inode metadata lacks a successful query")
        if not inode_count_is_int or not 0 <= inode_count <= 4:
            errors.append("available inode count is outside the bounded integer range")
        if type(inode_limit) is not int or inode_limit <= 0:
            errors.append("available inode limit is not a positive integer")
    elif inode_count is not None or inode_limit is not None:
        errors.append("unavailable inode metadata values must be null")
    if inode_offsets_available is True:
        if inode_metadata_available is not True or not inode_count_is_int or inode_count <= 0:
            errors.append("available inode CSR offsets require positive-count metadata")
        if not isinstance(inode_offsets, list):
            errors.append("available inode CSR offsets are not a list")
        elif not inode_count_is_int:
            pass  # The count error above is sufficient; do not use malformed count in arithmetic.
        elif len(inode_offsets) != inode_count + 1:
            errors.append("inode CSR offsets do not match count plus one")
        elif any(type(offset) is not int for offset in inode_offsets):
            errors.append("inode CSR offsets contain a non-integer value")
        elif inode_offsets[0] != 0 or inode_offsets[-1] != 4 \
                or any(right <= left for left, right in zip(inode_offsets, inode_offsets[1:])):
            errors.append("inode CSR offsets must start at zero, end at four, and strictly increase")
    elif inode_offsets is not None:
        errors.append("unavailable inode CSR offsets must be null")

    if errors:
        return None, errors

    pc_status = "VERIFIED" if pc_id_available and pc_is_lu_available \
        and (pc_is_lu is False or zero_pivot_available) else "NOT VERIFIED"
    inode_status = "VERIFIED" if inode_metadata_available and (inode_count == 0 or inode_offsets_available) else "NOT VERIFIED"
    offset_status = "VERIFIED" if inode_offsets_available else (
        "NOT APPLICABLE" if inode_metadata_available and inode_count == 0 else "NOT VERIFIED")
    return {
        "pc": {
            "scope": PC_CONFIGURATION_SCOPE,
            "measurement_status": pc_status,
            "object_id_available": pc_id_available,
            "object_id_error_available": pc_id_error_available,
            "object_id_error": pc_id_error,
            "object_id": pc_id if pc_id_available else None,
            "type_error_available": pc_type_error_available,
            "type_error": pc_type_error,
            "is_lu_available": pc_is_lu_available,
            "is_lu": pc_is_lu if pc_is_lu_available else None,
            "zero_pivot_attempted": zero_pivot_attempted,
            "zero_pivot_error_available": zero_pivot_error_available,
            "zero_pivot_error": zero_pivot_error,
            "zero_pivot_available": zero_pivot_available,
            "zero_pivot": zero_pivot if zero_pivot_available else None,
        },
        "inode": {
            "scope": INODE_METADATA_SCOPE,
            "measurement_status": inode_status,
            "query_attempted": inode_query_attempted,
            "error_available": inode_error_available,
            "error": inode_error,
            "metadata_available": inode_metadata_available,
            "count": inode_count if inode_metadata_available else None,
            "limit": inode_limit if inode_metadata_available else None,
            "csr_offsets_available": inode_offsets_available,
            "csr_offsets_measurement_status": offset_status,
            "csr_offsets": inode_offsets if inode_offsets_available else None,
        },
    }, []


def _inode_metadata_comparison(left: dict | None, right: dict | None) -> dict:
    left_inode = left["inode"] if left is not None else None
    right_inode = right["inode"] if right is not None else None
    metadata_available = left_inode is not None and right_inode is not None \
        and left_inode["metadata_available"] and right_inode["metadata_available"]
    offsets_available = metadata_available and left_inode["csr_offsets_available"] \
        and right_inode["csr_offsets_available"]
    return {
        "measurement_status": "VERIFIED" if metadata_available else "NOT VERIFIED",
        "count_equal": left_inode["count"] == right_inode["count"] if metadata_available else None,
        "limit_equal": left_inode["limit"] == right_inode["limit"] if metadata_available else None,
        "csr_offsets_measurement_status": "VERIFIED" if offsets_available else "NOT VERIFIED",
        "csr_offsets_equal": left_inode["csr_offsets"] == right_inode["csr_offsets"] if offsets_available else None,
        "scope": INODE_COMPARISON_SCOPE,
    }


def _configuration_pair_report(a: dict | None, b: dict | None, c: dict | None) -> dict:
    configurations = (a, b, c)
    pcs = tuple(item["pc"] if item is not None else None for item in configurations)
    inodes = tuple(item["inode"] if item is not None else None for item in configurations)
    pc_status = "VERIFIED" if all(item is not None and item["measurement_status"] == "VERIFIED" for item in pcs) else "NOT VERIFIED"
    inode_status = "VERIFIED" if all(item is not None and item["measurement_status"] == "VERIFIED" for item in inodes) else "NOT VERIFIED"
    config_status = "VERIFIED" if pc_status == inode_status == "VERIFIED" else "NOT VERIFIED"

    def pc_identity_relation(left: dict | None, right: dict | None) -> str | None:
        if left is None or right is None or not left["object_id_available"] or not right["object_id_available"]:
            return None
        return "same_object" if left["object_id"] == right["object_id"] else "different_objects"

    a_b_pc_relation = pc_identity_relation(pcs[0], pcs[1])
    b_c_pc_relation = pc_identity_relation(pcs[1], pcs[2])

    zero_comparison = {
        "measurement_status": "NOT VERIFIED",
        "reason": "B/C PC IDs, confirmed LU type, or successful finite pivot readings are unavailable",
        "b_zero_pivot": pcs[1]["zero_pivot"] if pcs[1] is not None and pcs[1]["zero_pivot_available"] else None,
        "c_zero_pivot": pcs[2]["zero_pivot"] if pcs[2] is not None and pcs[2]["zero_pivot_available"] else None,
        "b_pc_object_id": pcs[1]["object_id"] if pcs[1] is not None and pcs[1]["object_id_available"] else None,
        "c_pc_object_id": pcs[2]["object_id"] if pcs[2] is not None and pcs[2]["object_id_available"] else None,
        "values_equal": None,
        "scope": ZERO_PIVOT_COMPARISON_SCOPE,
    }
    if pcs[1] is not None and pcs[2] is not None \
            and pcs[1]["object_id_available"] and pcs[2]["object_id_available"] \
            and pcs[1]["is_lu_available"] and pcs[1]["is_lu"] is True \
            and pcs[2]["is_lu_available"] and pcs[2]["is_lu"] is True \
            and pcs[1]["zero_pivot_available"] and pcs[2]["zero_pivot_available"]:
        zero_comparison.update({
            "measurement_status": "VERIFIED",
            "reason": None,
            "values_equal": pcs[1]["zero_pivot"] == pcs[2]["zero_pivot"],
        })

    configuration = None if all(item is None for item in configurations) else {
        "measurement_status": config_status,
        "pc_configuration_measurement_status": pc_status,
        "inode_metadata_measurement_status": inode_status,
        "pc_configuration_scope": PC_CONFIGURATION_SCOPE,
        "pc_configuration": {
            "a": pcs[0], "b": pcs[1], "c": pcs[2],
            "a_to_b_object_identity_relation": a_b_pc_relation,
            "a_to_b_object_identity_status": "VERIFIED" if a_b_pc_relation is not None else "NOT VERIFIED",
            "b_to_c_object_identity_relation": b_c_pc_relation,
            "b_to_c_object_identity_status": "VERIFIED" if b_c_pc_relation is not None else "NOT VERIFIED",
            "b_to_c_zero_pivot_comparison": zero_comparison,
        },
        "inode_metadata_scope": INODE_METADATA_SCOPE if any(item is not None for item in inodes) else None,
        "inode_metadata": {"a": inodes[0], "b": inodes[1], "c": inodes[2]},
        "inode_metadata_comparisons": {
            "a_to_b": _inode_metadata_comparison(configurations[0], configurations[1]),
            "b_to_c": _inode_metadata_comparison(configurations[1], configurations[2]),
        },
    }
    return {"configuration_measurement_status": config_status, "configuration": configuration}


def validate_snapshot(record: object) -> list[str]:
    """Require actual measured values, not unavailable/not-applicable markers."""
    if not isinstance(record, dict):
        return ["snapshot root is not an object"]
    errors = []
    if record.get("schema") not in (SCHEMA, LEGACY_SCHEMA) or record.get("phase") not in PHASES:
        errors.append("unsupported snapshot schema or phase")
    if record.get("status") != "measured" or record.get("applicable_n4") is not True:
        errors.append("snapshot is not a measured applicable 4x4 matrix")
    if record.get("truncated") is not False:
        errors.append("snapshot is truncated or has no truncation declaration")
    for key in ("size_available", "type_available", "getters_attempted", "values_attempted",
                "values_available", "missing_diagonal_available", "nonzero_state_available"):
        if record.get(key) is not True:
            errors.append(f"{key} is not true")
    for key in ("size", "type", "ownership", "values", "diagonal", "nonzero_state"):
        if record.get(key + "_error_available") is not True or type(record.get(key + "_error")) is not int \
                or record[key + "_error"] != 0:
            errors.append(f"{key} getter has missing/error evidence")
    for key in ("rows", "columns"):
        if type(record.get(key)) is not int or record[key] != 4:
            errors.append(f"{key} is not four")
    if not isinstance(record.get("type"), str) or not record["type"]:
        errors.append("matrix type is missing")
    if type(record.get("nonzero_state")) is not int or record["nonzero_state"] < 0 \
            or record.get("nonzero_state_scope") != "same_matrix_only":
        errors.append("nonzero state or its comparison scope is invalid")
    missing = record.get("missing_diagonal")
    first = record.get("first_missing_diagonal")
    if type(missing) is not bool or (missing and (type(first) is not int or not 0 <= first < 4)) \
            or (missing is False and first is not None):
        errors.append("missing-diagonal evidence is invalid")
    byte_count = record.get("real_byte_count")
    if type(byte_count) is not int or byte_count not in (4, 8, 16) \
            or record.get("raw_encoding") != "native_memory_order_hex":
        errors.append("raw scalar representation is invalid")
    entries = record.get("entries")
    if not isinstance(entries, list) or len(entries) != 16:
        return errors + ["snapshot requires exactly sixteen entries"]
    positions = set()
    for entry in entries:
        if not isinstance(entry, dict):
            errors.append("entry is not an object")
            continue
        row, column = entry.get("row"), entry.get("column")
        if type(row) is not int or type(column) is not int or not 0 <= row < 4 or not 0 <= column < 4:
            errors.append("entry coordinates are invalid")
            continue
        if (row, column) in positions:
            errors.append("duplicate entry coordinates")
        positions.add((row, column))
        if entry.get("diagonal") is not (row == column):
            errors.append("entry diagonal flag contradicts coordinates")
        for part in ("real", "imaginary"):
            value = entry.get(part)
            if entry.get(part + "_finite") is not True or type(value) not in (int, float):
                errors.append(f"entry {part} is unavailable/nonfinite")
            else:
                try:
                    if not math.isfinite(float(value)):
                        errors.append(f"entry {part} is nonfinite")
                except (OverflowError, ValueError):
                    errors.append(f"entry {part} cannot be represented")
            raw = entry.get(part + "_raw_hex")
            if type(byte_count) is not int or not isinstance(raw, str) \
                    or len(raw) != 2 * byte_count or re.fullmatch("[0-9a-f]+", raw) is None:
                errors.append(f"entry {part} raw bytes are invalid")
    if positions != {(row, column) for row in range(4) for column in range(4)}:
        errors.append("entry coverage is incomplete")
    if record.get("schema") == SCHEMA:
        for key in ("attempt_scope_id", "object_id"):
            if type(record.get(key)) is not int or record[key] <= 0:
                errors.append(f"{key} is unavailable or invalid")
        if record.get("attempt_scope_semantics") != "process_local_eps_setup_sequence" or record.get("object_id_available") is not True or record.get("object_id_error_available") is not True or type(record.get("object_id_error")) is not int or record["object_id_error"] != 0:
            errors.append("object getter or process-local attempt evidence is invalid")
        setup = record.get("phase") == PHASES[0]
        if setup:
            if record.get("capture_scope") != "before_eps_setup" or record.get("callback_ordinal_available") is not False or record.get("callback_ordinal") is not None:
                errors.append("setup snapshot must not impersonate a callback")
        elif record.get("capture_scope") != "first_live_pc_capture" or record.get("callback_ordinal_available") is not True or type(record.get("callback_ordinal")) is not int or record["callback_ordinal"] <= 0:
            errors.append("capture snapshot lacks a positive callback ordinal")
        if record.get("phase") == PHASES[2]:
            if record.get("copy_origin_id_available") is not True or record.get("copy_origin_error_available") is not True or type(record.get("copy_origin_error")) is not int or record["copy_origin_error"] != 0 or type(record.get("copy_origin_id")) is not int or record["copy_origin_id"] <= 0:
                errors.append("owned copy has no successful source-object binding")
        elif record.get("copy_origin_id_available") is not False or record.get("copy_origin_id") is not None:
            errors.append("non-copy phase must not declare copy origin")
    _, configuration_errors = _configuration_measurements(record)
    errors.extend(configuration_errors)
    return errors


def pair_snapshots(
    selected: list[dict], action_records: list[dict] | None = None,
) -> tuple[list[dict], list[str]]:
    """Bind IDs within one CTest process/attempt; never numerical acceptance."""
    action_records = action_records or []
    attempts = {}
    issues = []
    for item in selected:
        record = item["snapshot"]
        if validate_snapshot(record):
            continue
        if record.get("schema") != SCHEMA:
            issues.append("legacy snapshot lacks object/copy-origin and attempt binding")
            continue
        invocation = item.get("ctest_invocation")
        if type(invocation) is not int or invocation <= 0:
            issues.append("snapshot has no explicit CTest process invocation context")
            continue
        phases = attempts.setdefault((invocation, record["attempt_scope_id"]), {})
        unique = phases.setdefault(record["phase"], {})
        unique[json.dumps(record, sort_keys=True, allow_nan=False)] = item
    paired = []
    for attempt, phases in sorted(attempts.items()):
        if any(len(phases.get(phase, {})) != 1 for phase in PHASES):
            issues.append(f"attempt {attempt}: missing or ambiguous phase snapshots")
            continue
        items = [next(iter(phases[phase].values())) for phase in PHASES]
        a, b, c = (item["snapshot"] for item in items)
        if not items[0]["line"] < items[1]["line"] < items[2]["line"]:
            issues.append(f"attempt {attempt}: phase observation order is not A-before-B-before-C")
            continue
        if b["callback_ordinal"] != c["callback_ordinal"] or c["copy_origin_id"] != b["object_id"] or c["object_id"] == b["object_id"]:
            issues.append(f"attempt {attempt}: B-to-C callback/origin/distinct-copy binding failed")
            continue
        def raw_values(snapshot):
            return (snapshot["real_byte_count"], snapshot["raw_encoding"], tuple((entry["real_raw_hex"], entry["imaginary_raw_hex"]) for entry in sorted(snapshot["entries"], key=lambda entry: (entry["row"], entry["column"]))))
        same_ab = a["object_id"] == b["object_id"]
        configuration_a, _ = _configuration_measurements(a)
        configuration_b, _ = _configuration_measurements(b)
        configuration_c, _ = _configuration_measurements(c)
        action_probe, _ = _action_probe_pair_report(items, action_records)
        paired.append({
            "ctest_invocation": attempt[0], "attempt_scope_id": attempt[1], "lines": [item["line"] for item in items],
            "a_object_id": a["object_id"], "b_object_id": b["object_id"], "c_object_id": c["object_id"],
            "b_c_callback_ordinal": b["callback_ordinal"],
            "a_to_b_identity_relation": "same_object" if same_ab else "different_objects",
            "a_to_b_raw_values_equal": raw_values(a) == raw_values(b),
            "a_to_b_nonzero_state_changed": a["nonzero_state"] != b["nonzero_state"] if same_ab else None,
            "b_to_c_copy_origin_verified": True, "b_to_c_raw_values_equal": raw_values(b) == raw_values(c),
            "last_true_probe_binding": "NOT VERIFIED: first-capture ordinal is explicit; last probe is not bound by this schema",
            **_configuration_pair_report(configuration_a, configuration_b, configuration_c),
            "action_probe": action_probe,
        })
    if not paired:
        issues.append("no complete ID-bound attempts")
    return paired, issues


def _finite_json_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed):
        raise ValueError("nonfinite JSON number")
    return parsed


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"nonstandard JSON constant {value}")

def parse_log(path: Path, required_tests: tuple[str, ...] = REQUIRED_TESTS) -> dict:
    names = {}
    invocations = {}
    records = []
    action_records = []
    unscoped_markers = 0
    other_test_markers = 0
    unscoped_action_markers = 0
    other_test_action_markers = 0
    action_marker_errors = []
    errors = []
    digest = hashlib.sha256()
    try:
        with path.open("rb") as stream:
            for line_number, raw in enumerate(stream, 1):
                digest.update(raw)
                line = raw.decode("utf-8", errors="replace")
                start = re.search(r"Start\s+(\d+):\s+(\S+)", line)
                if start:
                    names[int(start[1])] = start[2]
                    invocations[int(start[1])] = invocations.get(int(start[1]), 0) + 1
                for marker_prefix, destination, marker_kind in (
                    (PREFIX, records, "snapshot"),
                    (ACTION_PREFIX, action_records, "action"),
                ):
                    offset = line.find(marker_prefix)
                    if offset < 0:
                        continue
                    context = re.search(r"(?:^|\s)(\d+):\s*$", line[:offset])
                    if context is None:
                        # CTest may repeat failed-test stderr without the verbose
                        # test-ID prefix. Never assign those repeats to an attempt.
                        if marker_kind == "snapshot":
                            unscoped_markers += 1
                        else:
                            unscoped_action_markers += 1
                        continue
                    if names.get(int(context[1])) not in required_tests:
                        if marker_kind == "snapshot":
                            other_test_markers += 1
                        else:
                            other_test_action_markers += 1
                        continue
                    if len(raw) > MAX_LINE_BYTES or len(records) + len(action_records) >= MAX_RECORDS:
                        message = f"line {line_number}: diagnostic bound exceeded"
                        if marker_kind == "snapshot":
                            errors.append(message)
                        else:
                            action_marker_errors.append(message)
                        continue
                    try:
                        record = json.loads(
                            line[offset + len(marker_prefix):], parse_float=_finite_json_float,
                            parse_constant=_reject_json_constant)
                    except (ValueError, TypeError) as error:
                        message = f"line {line_number}: invalid {marker_kind} JSON: {error}"
                        if marker_kind == "snapshot":
                            errors.append(message)
                        else:
                            action_marker_errors.append(message)
                        continue
                    item = {"line": line_number, "ctest_id": int(context[1]),
                            "ctest_invocation": invocations.get(int(context[1]))}
                    if marker_kind == "snapshot":
                        item["snapshot"] = record
                    else:
                        item["probe"] = record
                    destination.append(item)
        log_hash = digest.hexdigest()
    except OSError as error:
        errors.append(f"cannot read native log: {error}")
        log_hash = None
    coverage = {}
    pairing = {}
    pairing_reasons = []
    for name in required_tests:
        selected = [item for item in records if names.get(item["ctest_id"]) == name]
        measured = {phase: [] for phase in PHASES}
        rejected = []
        for item in selected:
            problems = validate_snapshot(item["snapshot"])
            if problems:
                rejected.append({"line": item["line"], "reasons": problems})
            else:
                measured[item["snapshot"]["phase"]].append(item)
        missing = [phase for phase, items in measured.items() if not items]
        if missing:
            errors.append(f"{name}: no valid measurement for {','.join(missing)}")
        if rejected:
            errors.append(f"{name}: {len(rejected)} invalid/unavailable snapshots")
        selected_actions = [item for item in action_records if names.get(item["ctest_id"]) == name]
        bound, binding_issues = pair_snapshots(selected, selected_actions)
        pairing[name] = bound
        pairing_reasons.extend(f"{name}: {issue}" for issue in binding_issues)
        coverage[name] = {"measurement_status": "complete" if not missing and not rejected else "incomplete",
                          "valid_counts_by_phase": {phase: len(items) for phase, items in measured.items()},
                          "rejected": rejected}
    all_pairs = [item for test_pairs in pairing.values() for item in test_pairs]
    configuration_status = "VERIFIED" if all_pairs and not errors and not pairing_reasons \
        and all(item["configuration_measurement_status"] == "VERIFIED" for item in all_pairs) else "NOT VERIFIED"
    action_pairs = [item["action_probe"] for item in all_pairs]
    action_binding_status = "VERIFIED" if action_pairs and all(
        item["binding_status"] == "VERIFIED" for item in action_pairs) else "NOT VERIFIED"
    action_measurement_status = "VERIFIED" if action_binding_status == "VERIFIED" and all(
        item["measurement_status"] == "VERIFIED" for item in action_pairs) else "NOT VERIFIED"
    action_rejections = list(action_marker_errors)
    for item in action_records:
        problems = validate_action_probe(item.get("probe"))
        if problems:
            action_rejections.append({"line": item.get("line"), "reasons": problems})
    for action_pair in action_pairs:
        action_rejections.extend(action_pair["rejected_markers"])
    action_rejections = list({json.dumps(item, sort_keys=True, allow_nan=False): item
                              for item in action_rejections}.values())
    return {
        "schema": "fullmag.ci.floquet-factor-matrix-snapshot-report.v1",
        "status": "failed" if errors else ("measured_bound" if not pairing_reasons else "measured_unpaired"),
        "measurement_status": "incomplete" if errors else "complete",
        "pairing_status": "VERIFIED" if not errors and not pairing_reasons else "NOT VERIFIED",
        "configuration_measurement_status": configuration_status,
        "action_probe_binding_status": action_binding_status,
        "action_probe_measurement_status": action_measurement_status,
        "action_probe_scope": ACTION_PROBE_SCOPE,
        "action_probe_rejections": action_rejections,
        "pairing": pairing, "pairing_reasons": pairing_reasons,
        "pairing_scope": "phase/attempt/object/copy binding only; no solver correctness or last-probe binding",
        "solver_failure_cause": "NOT VERIFIED",
        "scientific_qualification": "NOT VERIFIED",
        "ctest_result_modified": False,
        "log_path": str(path), "log_sha256": log_hash,
        "required_tests": list(required_tests), "coverage": coverage,
        "records": records, "action_probe_records": action_records, "reasons": errors,
        "unscoped_markers_not_used_for_coverage": unscoped_markers,
        "other_test_markers_not_used_for_coverage": other_test_markers,
        "unscoped_action_markers_not_used_for_coverage": unscoped_action_markers,
        "other_test_action_markers_not_used_for_coverage": other_test_action_markers,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--log", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    report = parse_log(args.log)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
    print(f"C04 measurements: {report['measurement_status']}; pairing: {report['pairing_status']}; {args.output}")
    return 0 if report["measurement_status"] == "complete" and report["pairing_status"] == "VERIFIED" else 1


if __name__ == "__main__":
    raise SystemExit(main())
