"""Execution-control metadata shared by capture and typed authoring boundaries."""
from __future__ import annotations

import copy
from collections.abc import Mapping

EXECUTION_INTENT_KEYS = ("interactive_session_requested", "wait_for_solve")


def validate_execution_intent_fields(values: Mapping[str, object], *, context: str) -> dict[str, bool]:
    result: dict[str, bool] = {}
    for key in EXECUTION_INTENT_KEYS:
        if key in values:
            value = values[key]
            if type(value) is not bool:
                raise ValueError(f"{context}.{key} must be a boolean when present")
            result[key] = value
    return result


def copy_execution_intent(metadata: Mapping[str, object]) -> dict[str, object]:
    # Drafts also carry raw legacy metadata. Validation belongs to typed consumers.
    return {key: copy.deepcopy(metadata.get(key, False)) for key in EXECUTION_INTENT_KEYS}
