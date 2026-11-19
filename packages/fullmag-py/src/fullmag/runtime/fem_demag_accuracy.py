"""Validation for the explicitly supported FEM demagnetization accuracy contract."""

from __future__ import annotations

from collections.abc import Mapping


_SCHEMA_VERSION = "fullmag.fem.demag_accuracy.v1"
_FIELDS = frozenset(
    {
        "schema_version",
        "profile",
        "required_potential_order",
        "required_topology",
    }
)


def validate_fem_demag_accuracy_contract(
    value: object,
    *,
    context: str,
) -> dict[str, object] | None:
    """Validate and copy the supported contract, preserving its authored profile."""

    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise ValueError(f"{context} must be an object or null")

    missing = sorted(_FIELDS - set(value))
    unknown = sorted(str(key) for key in set(value) - _FIELDS)
    if missing or unknown:
        details: list[str] = []
        if missing:
            details.append(f"missing keys: {', '.join(missing)}")
        if unknown:
            details.append(f"unsupported keys: {', '.join(unknown)}")
        raise ValueError(f"{context} has invalid fields ({'; '.join(details)})")

    schema_version = value["schema_version"]
    if not isinstance(schema_version, str) or schema_version != _SCHEMA_VERSION:
        raise ValueError(f"{context}.schema_version must be '{_SCHEMA_VERSION}'")
    profile = value["profile"]
    if not isinstance(profile, str) or not profile.strip():
        raise ValueError(f"{context}.profile must be a non-empty string")
    potential_order = value["required_potential_order"]
    if type(potential_order) is not int or potential_order != 2:
        raise ValueError(
            f"{context}.required_potential_order must be 2 for schema v1"
        )
    topology = value["required_topology"]
    if not isinstance(topology, str) or topology != "all_tet":
        raise ValueError(f"{context}.required_topology must be 'all_tet' for schema v1")

    return {
        "schema_version": schema_version,
        "profile": profile,
        "required_potential_order": potential_order,
        "required_topology": topology,
    }


def validate_authored_fem_demag_accuracy_contract(
    runtime_metadata: Mapping[str, object],
    *,
    context: str,
) -> dict[str, object] | None:
    """Validate an authored entry, distinguishing absence from authored null."""

    key = "fem_demag_accuracy_contract"
    if key not in runtime_metadata:
        return None
    value = runtime_metadata[key]
    if value is None:
        raise ValueError(f"{context} must be an object when authored")
    return validate_fem_demag_accuracy_contract(value, context=context)
