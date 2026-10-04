"""Validated run-level output and temporary-storage policy."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass

_DATA_FORMATS = frozenset({"zarr", "hdf5"})
_CLEANUP_POLICIES = frozenset({"on_success", "always", "never"})
_EXISTING_OUTPUT_POLICIES = frozenset({"timestamp", "error"})
_WIRE_FIELDS = frozenset(
    {"output_dir", "temp_dir", "data_format", "cleanup", "existing_output"}
)


def _normalize_path(value: str | os.PathLike[str] | None, field: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, (str, os.PathLike)):
        raise TypeError(f"{field} must be a string or path-like value")
    normalized = os.fspath(value)
    if not isinstance(normalized, str):
        raise TypeError(f"{field} must resolve to a string path")
    if not normalized.strip():
        raise ValueError(f"{field} must not be empty")
    if "\x00" in normalized:
        raise ValueError(f"{field} must not contain a null character")
    if ".." in normalized.replace("\\", "/").split("/"):
        raise ValueError(f"{field} must not contain '..' path components")
    return normalized


@dataclass(frozen=True, slots=True)
class OutputStorage:
    """Policy for run results and private temporary data.

    Relative output and temporary paths are resolved against the authored
    script directory by managed runtimes. temp_dir names a parent directory;
    only a private, run-owned child may be removed.
    """

    output_dir: str | None = None
    temp_dir: str | None = None
    data_format: str = "zarr"
    cleanup: str = "on_success"
    existing_output: str = "timestamp"

    def __post_init__(self) -> None:
        output_dir = _normalize_path(self.output_dir, "output_dir")
        temp_dir = _normalize_path(self.temp_dir, "temp_dir")
        if not isinstance(self.data_format, str):
            raise TypeError("data_format must be a string")
        data_format = self.data_format.strip().lower()
        if data_format == "h5":
            data_format = "hdf5"
        if data_format not in _DATA_FORMATS:
            raise ValueError("data_format must be 'zarr' or 'hdf5'")
        if not isinstance(self.cleanup, str) or self.cleanup not in _CLEANUP_POLICIES:
            raise ValueError("cleanup must be 'on_success', 'always', or 'never'")
        if (
            not isinstance(self.existing_output, str)
            or self.existing_output not in _EXISTING_OUTPUT_POLICIES
        ):
            raise ValueError("existing_output must be 'timestamp' or 'error'")
        object.__setattr__(self, "output_dir", output_dir)
        object.__setattr__(self, "temp_dir", temp_dir)
        object.__setattr__(self, "data_format", data_format)

    def to_ir(self) -> dict[str, object]:
        return {
            "output_dir": self.output_dir,
            "temp_dir": self.temp_dir,
            "data_format": self.data_format,
            "cleanup": self.cleanup,
            "existing_output": self.existing_output,
        }

    @classmethod
    def from_ir(cls, ir: Mapping[str, object]) -> OutputStorage:
        if not isinstance(ir, Mapping):
            raise TypeError("output_storage must be an object")
        unknown_fields = set(ir) - _WIRE_FIELDS
        if unknown_fields:
            fields = ", ".join(sorted(str(field) for field in unknown_fields))
            raise ValueError(f"output_storage has unsupported fields: {fields}")
        return cls(
            output_dir=ir.get("output_dir"),  # type: ignore[arg-type]
            temp_dir=ir.get("temp_dir"),  # type: ignore[arg-type]
            data_format=ir.get("data_format", "zarr"),  # type: ignore[arg-type]
            cleanup=ir.get("cleanup", "on_success"),  # type: ignore[arg-type]
            existing_output=ir.get("existing_output", "timestamp"),  # type: ignore[arg-type]
        )
