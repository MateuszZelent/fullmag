#!/usr/bin/env python3
"""Write strict-M5 FEM static PBC supercell central-cell extraction artifacts."""

from __future__ import annotations

import argparse
import csv
import json
import math
import struct
import sys
from pathlib import Path
from typing import Any


def fail(message: str) -> None:
    raise ValueError(message)


def require(condition: bool, message: str) -> None:
    if not condition:
        fail(message)


def require_object(value: Any, name: str) -> dict[str, Any]:
    require(isinstance(value, dict), f"{name} must be a JSON object")
    return value


def require_list(value: Any, name: str) -> list[Any]:
    require(isinstance(value, list), f"{name} must be a JSON list")
    return value


def finite_number(value: Any, name: str) -> float:
    require(isinstance(value, (int, float)), f"{name} must be numeric")
    number = float(value)
    require(math.isfinite(number), f"{name} must be finite")
    return number


def parse_index_tokens(raw: str) -> list[str]:
    return [token.strip() for token in raw.strip().replace("\n", ",").split(",")]


def parse_indices_payload(raw: str, name: str) -> list[int]:
    require(raw.strip() != "", f"{name} must contain at least one index")
    stripped = raw.strip()
    if stripped.startswith("[") or stripped.startswith("{"):
        try:
            payload = json.loads(stripped)
        except json.JSONDecodeError as exc:
            fail(f"{name} contains invalid JSON: {exc}")
        if isinstance(payload, dict):
            payload = payload.get("indices")
        require(isinstance(payload, list), f"{name} JSON payload must be a list or object with indices")
        tokens = [str(value) for value in payload]
    else:
        tokens = parse_index_tokens(raw)
    indices: list[int] = []
    seen: set[int] = set()
    for position, token in enumerate(tokens):
        require(token != "", f"{name} contains an empty index at position {position}")
        try:
            index = int(token)
        except ValueError:
            fail(f"{name} contains non-integer index {token!r}")
        require(index >= 0, f"{name} contains negative index {index}")
        require(index not in seen, f"{name} contains duplicate index {index}")
        seen.add(index)
        indices.append(index)
    return indices


def parse_indices(raw: str, name: str) -> list[int]:
    candidate_path = Path(raw.strip())
    if candidate_path.is_file():
        return parse_indices_payload(candidate_path.read_text(encoding="utf-8"), f"{name} file {candidate_path}")
    return parse_indices_payload(raw, name)


def load_json(path: Path) -> dict[str, Any]:
    require(path.is_file(), f"missing JSON file: {path}")
    return require_object(json.loads(path.read_text(encoding="utf-8")), str(path))


def qualification(root: Path) -> dict[str, Any]:
    metadata = load_json(root / "metadata.json")
    for key in ("fem_cpu_relaxation_qualification", "fem_gpu_relaxation_qualification"):
        value = metadata.get(key)
        if isinstance(value, dict):
            return value
    fail("metadata must contain fem_cpu_relaxation_qualification or fem_gpu_relaxation_qualification")


def final_supercell_scalars(root: Path) -> tuple[float, float]:
    qual = qualification(root)
    energy_terms = require_object(qual.get("final_energy_terms_j"), "metadata final_energy_terms_j")
    e_demag = finite_number(energy_terms.get("E_demag"), "metadata final E_demag")
    torque = finite_number(qual.get("final_torque_apm"), "metadata final_torque_apm")
    require(e_demag >= 0.0, "metadata final E_demag must be non-negative")
    require(torque >= 0.0, "metadata final_torque_apm must be non-negative")
    return e_demag, torque


def magnetic_node_count(root: Path) -> int:
    data = load_json(root / "m_final.json")
    values = require_list(data.get("values"), "m_final.values")
    require(values, "m_final.values must be non-empty")
    for index, raw_vector in enumerate(values):
        vector = require_list(raw_vector, f"m_final.values[{index}]")
        require(len(vector) == 3, f"m_final.values[{index}] must be a 3-vector")
        for component_index, component in enumerate(vector):
            finite_number(component, f"m_final.values[{index}][{component_index}]")
    return len(values)


def zarr_cell_count(root: Path, observable: str, expected_components: list[str]) -> int:
    field_dir = root / "fields" / f"{observable}.zarr"
    require(field_dir.is_dir(), f"missing {observable} zarr directory: {field_dir}")
    attrs = load_json(field_dir / ".zattrs")
    array = load_json(field_dir / ".zarray")
    component_order = [str(value) for value in require_list(attrs.get("component_order"), f"{observable}.component_order")]
    require(
        component_order == expected_components,
        f"{observable}.component_order must be {expected_components!r}, got {component_order!r}",
    )
    require(array.get("dtype") == "<f8", f"{observable} zarr dtype must be <f8")
    require(array.get("order") == "C", f"{observable} zarr order must be C")
    shape = require_list(array.get("shape"), f"{observable}.shape")
    require(
        len(shape) == 3 and shape[0] == 1 and shape[1] == len(expected_components),
        f"{observable}.shape must be [1, {len(expected_components)}, cells]",
    )
    cell_count = int(shape[2])
    require(cell_count > 0, f"{observable} zarr cell count must be positive")
    samples_path = field_dir / "samples.csv"
    require(samples_path.is_file(), f"missing {observable} samples.csv: {samples_path}")
    with samples_path.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    require(rows, f"{observable} samples.csv must not be empty")
    chunk_key = rows[-1].get("chunk_key")
    require(isinstance(chunk_key, str) and chunk_key, f"{observable} chunk_key must be present")
    raw = (field_dir / chunk_key).read_bytes()
    expected_value_count = cell_count * len(expected_components)
    require(
        len(raw) == expected_value_count * 8,
        f"{observable} zarr chunk byte length mismatch",
    )
    values = struct.unpack(f"<{expected_value_count}d", raw)
    require(all(math.isfinite(value) for value in values), f"{observable} zarr values must be finite")
    return cell_count


def require_indices_in_range(indices: list[int], *, upper_bound: int, name: str) -> None:
    for index in indices:
        require(index < upper_bound, f"{name} contains index {index} outside [0, {upper_bound})")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact_root", type=Path)
    parser.add_argument("--repeat-x", type=int, required=True)
    parser.add_argument("--repeat-y", type=int, required=True)
    parser.add_argument("--central-cell-index", default=None, help="Optional i,j index; defaults to floor(repeat/2).")
    parser.add_argument("--magnetic-node-indices", required=True)
    parser.add_argument("--field-cell-indices", required=True)
    parser.add_argument("--central-cell-demag-energy-j", type=float, required=True)
    parser.add_argument("--central-cell-torque-apm", type=float, required=True)
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Defaults to artifact_root/diagnostics/fem_static_pbc_supercell_central_cell.v1.json.",
    )
    args = parser.parse_args()
    require(args.artifact_root.is_dir(), f"artifact_root must be a directory: {args.artifact_root}")
    require(args.repeat_x > 0 and args.repeat_y > 0, "--repeat-x and --repeat-y must be positive")
    require(args.repeat_x * args.repeat_y > 1, "supercell extraction requires repeat_x * repeat_y > 1")
    require(
        math.isfinite(args.central_cell_demag_energy_j) and args.central_cell_demag_energy_j >= 0.0,
        "--central-cell-demag-energy-j must be finite and non-negative",
    )
    require(
        math.isfinite(args.central_cell_torque_apm) and args.central_cell_torque_apm >= 0.0,
        "--central-cell-torque-apm must be finite and non-negative",
    )
    return args


def central_cell_index(args: argparse.Namespace) -> list[int]:
    if args.central_cell_index is None:
        return [args.repeat_x // 2, args.repeat_y // 2]
    parts = [part.strip() for part in args.central_cell_index.split(",")]
    require(len(parts) == 2, "--central-cell-index must have form i,j")
    try:
        value = [int(parts[0]), int(parts[1])]
    except ValueError:
        fail("--central-cell-index must contain integer indices")
    require(0 <= value[0] < args.repeat_x, "--central-cell-index i is outside repeat_x")
    require(0 <= value[1] < args.repeat_y, "--central-cell-index j is outside repeat_y")
    return value


def write_artifact(args: argparse.Namespace) -> Path:
    magnetic_indices = parse_indices(args.magnetic_node_indices, "--magnetic-node-indices")
    field_indices = parse_indices(args.field_cell_indices, "--field-cell-indices")
    require_indices_in_range(
        magnetic_indices,
        upper_bound=magnetic_node_count(args.artifact_root),
        name="--magnetic-node-indices",
    )
    h_count = zarr_cell_count(args.artifact_root, "H_demag", ["x", "y", "z"])
    phi_count = zarr_cell_count(args.artifact_root, "demag_phi", ["scalar"])
    require_indices_in_range(
        field_indices,
        upper_bound=min(h_count, phi_count),
        name="--field-cell-indices",
    )
    total_e_demag, total_torque = final_supercell_scalars(args.artifact_root)
    require(
        args.central_cell_demag_energy_j <= total_e_demag,
        "--central-cell-demag-energy-j exceeds metadata final E_demag",
    )
    require(
        args.central_cell_torque_apm <= total_torque,
        "--central-cell-torque-apm exceeds metadata final_torque_apm",
    )
    output = args.output or (
        args.artifact_root
        / "diagnostics"
        / "fem_static_pbc_supercell_central_cell.v1.json"
    )
    payload = {
        "schema_version": "fem_static_pbc_supercell_central_cell.v1",
        "artifact_path": str(output.relative_to(args.artifact_root)) if output.is_relative_to(args.artifact_root) else str(output),
        "repeat_x": args.repeat_x,
        "repeat_y": args.repeat_y,
        "cell_count": args.repeat_x * args.repeat_y,
        "central_cell_index": central_cell_index(args),
        "magnetic_node_indices": magnetic_indices,
        "field_cell_indices": field_indices,
        "central_cell_demag_energy_j": args.central_cell_demag_energy_j,
        "central_cell_torque_apm": args.central_cell_torque_apm,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return output


def main() -> int:
    try:
        output = write_artifact(parse_args())
    except Exception as exc:
        print(f"invalid FEM static PBC supercell central-cell extraction: {exc}", file=sys.stderr)
        return 1
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
