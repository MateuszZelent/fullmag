"""Decoder for FMTB table-row payloads (``rows.bin``), mirroring ``tableRowsCodec.ts``."""
from __future__ import annotations

import struct
from dataclasses import dataclass
from typing import Optional, Sequence

import numpy as np

__all__ = ["TableRows", "TableRowsDecodeError", "decode_table_rows"]

HEADER_LEN = 60
SUPPORTED_VERSION = 1


class TableRowsDecodeError(ValueError):
    """The payload is not a well-formed FMTB document."""


@dataclass(frozen=True)
class TableRows:
    """Decoded table rows; ``values`` has shape ``(row_count, column_count)``."""

    revision: int
    schema_revision: int
    cursor_start: int
    cursor_end: int
    total_rows: int
    resync_required: bool
    values: np.ndarray
    columns: Optional[tuple[str, ...]] = None

    def to_numpy(self) -> np.ndarray:
        return self.values

    def column(self, name: str) -> np.ndarray:
        if self.columns is None:
            raise KeyError("column names are unknown for this table window")
        return self.values[:, self.columns.index(name)]

    def to_pandas(self):  # pragma: no cover - optional dependency
        try:
            import pandas as pd
        except ImportError as error:
            raise ImportError("TableRows.to_pandas() needs pandas; install it or use to_numpy()") from error
        return pd.DataFrame(self.values, columns=list(self.columns) if self.columns else None)


def decode_table_rows(payload: bytes, columns: Optional[Sequence[str]] = None) -> TableRows:
    data = memoryview(payload).cast("B")
    if len(data) < HEADER_LEN:
        raise TableRowsDecodeError(f"FMTB buffer too short: {len(data)} bytes, need at least {HEADER_LEN}")
    if bytes(data[0:4]) != b"FMTB":
        raise TableRowsDecodeError(f"invalid FMTB magic: {bytes(data[0:4])!r}")
    version, flags = struct.unpack_from("<HH", data, 4)
    if version != SUPPORTED_VERSION:
        raise TableRowsDecodeError(f"unsupported FMTB version {version}")
    revision, schema_revision, cursor_start, cursor_end, total_rows, row_count = struct.unpack_from("<6Q", data, 8)
    (column_count,) = struct.unpack_from("<I", data, 56)
    expected = HEADER_LEN + row_count * column_count * 8
    if len(data) != expected:
        raise TableRowsDecodeError(f"FMTB buffer size mismatch: expected {expected}, got {len(data)}")
    if columns is not None and len(columns) != column_count:
        raise TableRowsDecodeError(f"FMTB has {column_count} columns, {len(columns)} names given")
    values = np.frombuffer(data, dtype="<f8", count=row_count * column_count, offset=HEADER_LEN).astype(np.float64, copy=True)
    return TableRows(
        revision=revision,
        schema_revision=schema_revision,
        cursor_start=cursor_start,
        cursor_end=cursor_end,
        total_rows=total_rows,
        resync_required=bool(flags & 1),
        values=values.reshape(row_count, column_count),
        columns=tuple(columns) if columns is not None else None,
    )
