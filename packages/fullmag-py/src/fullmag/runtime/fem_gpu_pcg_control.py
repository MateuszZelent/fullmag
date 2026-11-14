"""Validation for the optional FEM GPU PCG status batching experiment."""

from __future__ import annotations

from collections.abc import Mapping


_METADATA_KEY = "fem_gpu_pcg_control_experiment"
_SCHEMA_VERSION = "fullmag.fem.gpu.pcg_control_experiment.v1"
_FIELDS = frozenset({"schema_version", "status_batch_stride"})


def validate_fem_gpu_pcg_control_experiment(
    value: object,
    *,
    context: str,
) -> dict[str, object] | None:
    """Validate and copy the closed experiment metadata object."""

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
    stride = value["status_batch_stride"]
    if type(stride) is not int or stride not in (4, 8):
        raise ValueError(f"{context}.status_batch_stride must be 4 or 8")

    return {
        "schema_version": schema_version,
        "status_batch_stride": stride,
    }


def validate_authored_fem_gpu_pcg_control_experiment(
    runtime_metadata: Mapping[str, object],
    *,
    context: str,
) -> dict[str, object] | None:
    """Validate an authored entry, distinguishing absence from authored null."""

    if _METADATA_KEY not in runtime_metadata:
        return None
    value = runtime_metadata[_METADATA_KEY]
    if value is None:
        raise ValueError(f"{context} must be an object when authored")
    return validate_fem_gpu_pcg_control_experiment(value, context=context)
