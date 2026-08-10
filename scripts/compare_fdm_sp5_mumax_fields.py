#!/usr/bin/env python3
"""Compare full-field SP5 trajectories between Fullmag and MuMax3."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import struct
from typing import NamedTuple, Sequence


Vector = tuple[float, float, float]
_BINARY4_MARKER = b"# Begin: Data Binary 4\n"
_CONTROL_NUMBER = 1234567.0


class OvfField(NamedTuple):
    shape: tuple[int, int, int]
    values: list[Vector]


def _header_integer(header: bytes, key: str) -> int:
    prefix = f"# {key}:".encode("ascii")
    for line in header.splitlines():
        if line.lower().startswith(prefix.lower()):
            return int(line.split(b":", 1)[1].strip())
    raise ValueError(f"OVF header is missing {key}")


def read_ovf2_binary4(path: Path) -> OvfField:
    raw = path.read_bytes()
    offset = raw.find(_BINARY4_MARKER)
    if offset < 0:
        raise ValueError(f"{path} is not OVF2 Binary4")
    header = raw[:offset]
    shape = tuple(_header_integer(header, key) for key in ("xnodes", "ynodes", "znodes"))
    count = math.prod(shape)
    payload = raw[offset + len(_BINARY4_MARKER) :]
    required = 4 * (1 + 3 * count)
    if len(payload) < required:
        raise ValueError(f"{path} has a truncated Binary4 payload")
    endian = "<"
    control = struct.unpack_from("<f", payload)[0]
    if not math.isclose(control, _CONTROL_NUMBER, rel_tol=0.0, abs_tol=0.5):
        endian = ">"
        control = struct.unpack_from(">f", payload)[0]
    if not math.isclose(control, _CONTROL_NUMBER, rel_tol=0.0, abs_tol=0.5):
        raise ValueError(f"{path} has invalid Binary4 control number {control}")
    flat = struct.unpack_from(f"{endian}{3 * count}f", payload, 4)
    values = [tuple(flat[index : index + 3]) for index in range(0, len(flat), 3)]
    return OvfField(shape=shape, values=values)


def read_fullmag_field(run_root: Path, name: str) -> list[Vector]:
    payload = json.loads((run_root / name).read_text(encoding="utf-8"))
    values = payload.get("values")
    if not isinstance(values, list):
        raise ValueError(f"{run_root / name} has no vector values")
    parsed: list[Vector] = []
    for index, value in enumerate(values):
        if not isinstance(value, list) or len(value) != 3:
            raise ValueError(f"{run_root / name} value {index} is not a vector3")
        vector = tuple(float(component) for component in value)
        if not all(math.isfinite(component) for component in vector):
            raise ValueError(f"{run_root / name} value {index} is not finite")
        parsed.append(vector)
    return parsed


def subtract_fields(left: Sequence[Vector], right: Sequence[Vector]) -> list[Vector]:
    if len(left) != len(right):
        raise ValueError(f"field length mismatch: {len(left)} != {len(right)}")
    return [
        tuple(left[index][axis] - right[index][axis] for axis in range(3))
        for index in range(len(left))
    ]


def vector_metrics(candidate: Sequence[Vector], reference: Sequence[Vector]) -> dict[str, object]:
    error = subtract_fields(candidate, reference)
    if not error:
        raise ValueError("fields must not be empty")
    component_count = 3 * len(error)
    mean_error = [sum(vector[axis] for vector in error) / len(error) for axis in range(3)]
    squared_error = sum(component * component for vector in error for component in vector)
    max_error = max(abs(component) for vector in error for component in vector)
    reference_squared = sum(
        component * component for vector in reference for component in vector
    )
    return {
        "component_mean_error": mean_error,
        "rms_component_error": math.sqrt(squared_error / component_count),
        "max_abs_component_error": max_error,
        "reference_rms_component": math.sqrt(reference_squared / component_count),
    }


def compare_fields(
    *,
    relaxed_reference: Sequence[Vector],
    fullmag_initial: Sequence[Vector],
    mumax_current: Sequence[Vector],
    mumax_zero: Sequence[Vector],
    fullmag_current: Sequence[Vector],
    fullmag_zero: Sequence[Vector],
) -> dict[str, object]:
    lengths = {
        len(relaxed_reference),
        len(fullmag_initial),
        len(mumax_current),
        len(mumax_zero),
        len(fullmag_current),
        len(fullmag_zero),
    }
    if len(lengths) != 1:
        raise ValueError(f"field length mismatch across inputs: {sorted(lengths)}")
    return {
        "schema_version": "FULLMAG-SP5-FIELD-COMPARISON-V1",
        "cell_count": len(relaxed_reference),
        "relaxed_state": vector_metrics(fullmag_initial, relaxed_reference),
        "zero_current_trajectory": vector_metrics(fullmag_zero, mumax_zero),
        "driven_trajectory": vector_metrics(fullmag_current, mumax_current),
        "current_induced_delta": vector_metrics(
            subtract_fields(fullmag_current, fullmag_zero),
            subtract_fields(mumax_current, mumax_zero),
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mumax-relaxed", type=Path, required=True)
    parser.add_argument("--mumax-current", type=Path, required=True)
    parser.add_argument("--mumax-zero", type=Path, required=True)
    parser.add_argument("--fullmag-initial-run", type=Path)
    parser.add_argument("--fullmag-current-run", type=Path, required=True)
    parser.add_argument("--fullmag-zero-run", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    relaxed = read_ovf2_binary4(args.mumax_relaxed)
    current = read_ovf2_binary4(args.mumax_current)
    zero = read_ovf2_binary4(args.mumax_zero)
    if current.shape != relaxed.shape or zero.shape != relaxed.shape:
        raise ValueError(
            f"OVF shape mismatch: relaxed={relaxed.shape}, current={current.shape}, zero={zero.shape}"
        )
    initial_run = args.fullmag_initial_run or args.fullmag_current_run
    report = compare_fields(
        relaxed_reference=relaxed.values,
        fullmag_initial=read_fullmag_field(initial_run, "m_initial.json"),
        mumax_current=current.values,
        mumax_zero=zero.values,
        fullmag_current=read_fullmag_field(args.fullmag_current_run, "m_final.json"),
        fullmag_zero=read_fullmag_field(args.fullmag_zero_run, "m_final.json"),
    )
    report["grid"] = list(relaxed.shape)
    report["inputs"] = {
        "mumax_relaxed": str(args.mumax_relaxed),
        "mumax_current": str(args.mumax_current),
        "mumax_zero": str(args.mumax_zero),
        "fullmag_initial_run": str(initial_run),
        "fullmag_current_run": str(args.fullmag_current_run),
        "fullmag_zero_run": str(args.fullmag_zero_run),
    }
    serialized = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(serialized, encoding="utf-8")
    print(serialized, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
