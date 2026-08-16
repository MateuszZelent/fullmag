#!/usr/bin/env python3
"""Build a fail-closed MuMax common-limit manifest from real output files.

The parser intentionally accepts only MuMax3 text OVF files and a tabular
``table.txt`` with the observables required by the v2 comparator.  It does not
interpolate the MuMax sampling times: a scheduler overshoot is evidence that
the run is not synchronized with the declared common-limit cadence.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "mumax_racetrack_common_limit_input.v2"
_OVF_COMPONENTS = 3


class MuMaxManifestError(ValueError):
    """MuMax output cannot prove the common-limit input contract."""


def _finite(value: str, label: str) -> float:
    try:
        result = float(value)
    except ValueError as error:
        raise MuMaxManifestError(f"{label} is not numeric") from error
    if not math.isfinite(result):
        raise MuMaxManifestError(f"{label} is not finite")
    return result


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1 << 20), b""):
                digest.update(block)
    except OSError as error:
        raise MuMaxManifestError(f"cannot read {path}: {error}") from error
    return digest.hexdigest()


def _header_and_values(path: Path) -> tuple[dict[str, str], list[list[float]]]:
    try:
        raw = path.read_bytes()
    except OSError as error:
        raise MuMaxManifestError(f"cannot read {path}: {error}") from error
    text_marker = b"# Begin: Data Text"
    binary_marker = b"# Begin: Data Binary 4"
    marker = text_marker if text_marker in raw else binary_marker
    if marker not in raw:
        raise MuMaxManifestError(f"{path} is neither an OVF text nor binary-4 payload")
    marker_index = raw.index(marker)
    try:
        header_lines = raw[:marker_index].decode("ascii").splitlines()
    except UnicodeDecodeError as error:
        raise MuMaxManifestError(f"{path} has a non-ASCII OVF header") from error
    header: dict[str, str] = {}
    for line in header_lines:
        match = re.match(r"^#\s*([^:]+):\s*(.*?)\s*$", line)
        if match:
            header[match.group(1).lower()] = match.group(2)
    try:
        nodes = tuple(int(header[key]) for key in ("xnodes", "ynodes", "znodes"))
    except (KeyError, ValueError) as error:
        raise MuMaxManifestError(f"{path} lacks integer OVF node counts") from error
    if any(node <= 0 for node in nodes):
        raise MuMaxManifestError(f"{path} has non-positive OVF node count")
    expected = math.prod(nodes)
    values: list[list[float]] = []
    if marker == binary_marker:
        payload = raw[marker_index + len(marker) :]
        if not payload.startswith(b"\n"):
            raise MuMaxManifestError(f"{path} has malformed binary OVF marker")
        payload = payload[1:]
        import struct

        required_bytes = 4 + expected * _OVF_COMPONENTS * 4
        if len(payload) < required_bytes:
            raise MuMaxManifestError(f"{path} binary payload is truncated")
        check = struct.unpack("<f", payload[:4])[0]
        if not math.isclose(check, 1234567.0, rel_tol=0.0, abs_tol=0.5):
            raise MuMaxManifestError(f"{path} binary endian marker is invalid")
        flat = struct.unpack(f"<{expected * _OVF_COMPONENTS}f", payload[4:required_bytes])
        values = [list(flat[offset : offset + _OVF_COMPONENTS]) for offset in range(0, len(flat), _OVF_COMPONENTS)]
    else:
        lines = raw[marker_index + len(marker) :].decode("ascii").splitlines()
        for line in lines:
            if line.startswith("# End:"):
                break
            fields = line.split()
            if len(fields) != _OVF_COMPONENTS:
                raise MuMaxManifestError(f"{path} contains a non-vector data row")
            values.append([_finite(field, f"{path} data") for field in fields])
    if len(values) != expected:
        raise MuMaxManifestError(f"{path} has {len(values)} vectors, expected {expected}")
    return header, values


def _table(path: Path) -> list[dict[str, float]]:
    try:
        lines = [line for line in path.read_text(encoding="ascii").splitlines() if line]
    except (OSError, UnicodeDecodeError) as error:
        raise MuMaxManifestError(f"cannot read MuMax table {path}: {error}") from error
    if not lines or not lines[0].startswith("# "):
        raise MuMaxManifestError("MuMax table must start with a # header")
    columns = lines[0][2:].split("\t")
    required = (
        "t (s)",
        "E_total (J)",
        "ext_topologicalcharge ()",
        "ext_bubbleposx (m)",
        "ext_bubbleposy (m)",
    )
    missing = [column for column in required if column not in columns]
    if missing:
        raise MuMaxManifestError(f"MuMax table misses columns: {', '.join(missing)}")
    rows: list[dict[str, float]] = []
    for row_index, line in enumerate(lines[1:]):
        values = line.split("\t")
        if len(values) != len(columns):
            raise MuMaxManifestError(f"MuMax table row {row_index} has the wrong column count")
        parsed = {column: _finite(value, f"MuMax table row {row_index} {column}") for column, value in zip(columns, values)}
        rows.append(parsed)
    if len(rows) < 2:
        raise MuMaxManifestError("MuMax table needs at least two samples")
    return rows


def _grid_from_ovf(header: dict[str, str]) -> dict[str, object]:
    def number(key: str) -> float:
        if key not in header:
            raise MuMaxManifestError(f"OVF header misses {key}")
        return _finite(header[key], f"OVF {key}")

    shape = [int(header[key]) for key in ("xnodes", "ynodes", "znodes")]
    cell = [number(key) for key in ("xstepsize", "ystepsize", "zstepsize")]
    # MuMax writes OOMMF ``base`` at the first cell centre, whereas Fullmag's
    # grid certificate and torque exporter use the lower cell corner.
    origin = [
        number(key) - 0.5 * step
        for key, step in zip(("xbase", "ybase", "zbase"), cell)
    ]
    if any(value <= 0.0 for value in cell):
        raise MuMaxManifestError("OVF cell sizes must be positive")
    grid = {
        "shape": shape,
        "cell_size_m": cell,
        "origin_m": origin,
        "cell_order": "x_fastest_then_y_then_z",
    }
    encoded = json.dumps(grid, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    grid["digest_sha256"] = hashlib.sha256(encoded).hexdigest()
    return grid


def _bubble_position_in_grid_frame(row: dict[str, float], grid: dict[str, object]) -> list[float]:
    """Convert MuMax ``ext_bubblepos`` from its centered mesh frame."""
    shape = grid["shape"]
    cell = grid["cell_size_m"]
    origin = grid["origin_m"]
    if not isinstance(shape, list) or not isinstance(cell, list) or not isinstance(origin, list):
        raise MuMaxManifestError("MuMax grid certificate is malformed")
    return [
        row["ext_bubbleposx (m)"] + float(origin[0]) + 0.5 * int(shape[0]) * float(cell[0]),
        row["ext_bubbleposy (m)"] + float(origin[1]) + 0.5 * int(shape[1]) * float(cell[1]),
    ]


def build_manifest(
    output_dir: Path,
    *,
    torque_export: Path,
    binary_digest_sha256: str,
    input_script: Path,
    fixed_timestep_s: float,
    sample_interval_s: float,
    duration_s: float,
    alpha: float,
    gamma_rad_s_T: float,
    demag_policy: str,
    sampling_mode: str,
) -> dict[str, object]:
    ovfs = sorted(output_dir.glob("m[0-9][0-9][0-9][0-9][0-9][0-9].ovf"))
    if not ovfs:
        raise MuMaxManifestError(f"no six-digit MuMax magnetization OVF files in {output_dir}")
    table_path = output_dir / "table.txt"
    rows = _table(table_path)
    if len(ovfs) != len(rows):
        raise MuMaxManifestError(f"MuMax OVF/table sample count mismatch: {len(ovfs)} != {len(rows)}")
    header, _ = _header_and_values(ovfs[0])
    grid = _grid_from_ovf(header)
    expected_times = [index * sample_interval_s for index in range(len(rows))]
    for index, (row, expected) in enumerate(zip(rows, expected_times)):
        actual = row["t (s)"]
        if not math.isclose(actual, expected, rel_tol=1e-12, abs_tol=0.0):
            raise MuMaxManifestError(
                f"MuMax sample {index} time {actual:.17g} is not the declared cadence {expected:.17g}"
            )
    if not math.isclose(rows[-1]["t (s)"], duration_s, rel_tol=1e-12, abs_tol=0.0):
        raise MuMaxManifestError("MuMax table final time does not match common-limit duration")
    trajectories: list[dict[str, object]] = []
    for index, (ovf, row, expected_time) in enumerate(zip(ovfs, rows, expected_times)):
        ovf_header, values = _header_and_values(ovf)
        if _grid_from_ovf(ovf_header) != grid:
            raise MuMaxManifestError(f"MuMax OVF grid changed at sample {index}")
        centre_m = _bubble_position_in_grid_frame(row, grid)
        trajectories.append(
            {
                # Store the declared common-limit cadence, not MuMax's
                # accumulated floating-point representation.
                "time_s": expected_time,
                "m": values,
                "energy_J": row["E_total (J)"],
                "topological_charge": row["ext_topologicalcharge ()"],
                "centre_m": centre_m,
            }
        )
    try:
        export = json.loads(torque_export.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise MuMaxManifestError(f"cannot read torque export {torque_export}: {error}") from error
    if not isinstance(export, dict) or export.get("schema_version") != "fullmag_transport_torque_mumax_export.v1":
        raise MuMaxManifestError("torque export has an unexpected schema")
    source = export.get("source_torque")
    field = export.get("equivalent_field")
    if not isinstance(source, dict) or not isinstance(field, dict):
        raise MuMaxManifestError("torque export misses source/equivalent field")
    source_digest = source.get("field_digest_sha256")
    field_digest = field.get("field_digest_sha256")
    if not isinstance(source_digest, str) or not isinstance(field_digest, str):
        raise MuMaxManifestError("torque export misses source/equivalent digest")
    if sampling_mode == "autosave":
        trajectory_source: dict[str, object] = {
            "kind": "mumax_table_autosave_v1",
            "table_autosave_interval_s": sample_interval_s,
            "field_autosave_interval_s": sample_interval_s,
        }
    elif sampling_mode == "explicit_steps":
        steps_per_sample = round(sample_interval_s / fixed_timestep_s)
        if steps_per_sample < 1 or not math.isclose(
            steps_per_sample * fixed_timestep_s, sample_interval_s, rel_tol=1e-12, abs_tol=0.0
        ):
            raise MuMaxManifestError("explicit_steps requires an integral sample/fixed-step ratio")
        trajectory_source = {
            "kind": "mumax_table_save_steps_v1",
            "table_save_interval_s": sample_interval_s,
            "field_save_interval_s": sample_interval_s,
            "steps_per_sample": steps_per_sample,
        }
    else:
        raise MuMaxManifestError("sampling_mode must be 'autosave' or 'explicit_steps'")
    trajectory_source.update(
        {
            "initial_sample_recorded": True,
            "centre_coordinate_frame": "fullmag_grid_origin_v1",
            "centre_source_transform": "mumax_ext_bubblepos_centered_mesh_to_ovf_origin_v1",
        }
    )
    manifest: dict[str, object] = {
        "schema_version": SCHEMA_VERSION,
        "mumax": {
            "version": "3.12",
            "binary_digest_sha256": binary_digest_sha256,
            "input_script_digest_sha256": _sha256(input_script),
            "output_ovf_digest_sha256": hashlib.sha256(b"".join(_sha256(path).encode() for path in ovfs)).hexdigest(),
            "table_digest_sha256": _sha256(table_path),
        },
        "grid": grid,
        "injected_torque": {
            "quantity": "B_eq",
            "units": "T",
            "identity_confirmed": True,
            "formula_version": "B_eq_equals_m_cross_T_tr_G_over_gamma_e.v1",
            "source_torque_digest_sha256": source_digest,
            "field_digest_sha256": field_digest,
            "frozen_torque": {
                "enabled": True,
                "update_policy": "frozen_from_accepted_fullmag_snapshot",
                "dynamic_transport_recomputation": False,
            },
        },
        "common_limit": {
            "integrator": "heun_fixed",
            "fixed_timestep_s": fixed_timestep_s,
            "sample_interval_s": sample_interval_s,
            "duration_s": duration_s,
            "alpha": alpha,
            "gamma_rad_s_T": gamma_rad_s_T,
            "demag_policy": demag_policy,
        },
        "trajectory_source": {**trajectory_source, "table_digest_sha256": _sha256(table_path)},
        "trajectory": trajectories,
    }
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--torque-export", type=Path, required=True)
    parser.add_argument("--binary-digest", required=True)
    parser.add_argument("--input-script", type=Path, required=True)
    parser.add_argument("--fixed-timestep-s", type=float, default=1e-13)
    parser.add_argument("--sample-interval-s", type=float, default=1e-12)
    parser.add_argument("--duration-s", type=float, default=1e-11)
    parser.add_argument("--alpha", type=float, default=0.3)
    parser.add_argument("--gamma-rad-s-t", type=float, default=1.76085963023e11)
    parser.add_argument("--demag-policy", default="literal")
    parser.add_argument("--sampling-mode", choices=("autosave", "explicit_steps"), default="autosave")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        manifest = build_manifest(
            args.output_dir,
            torque_export=args.torque_export,
            binary_digest_sha256=args.binary_digest,
            input_script=args.input_script,
            fixed_timestep_s=args.fixed_timestep_s,
            sample_interval_s=args.sample_interval_s,
            duration_s=args.duration_s,
            alpha=args.alpha,
            gamma_rad_s_T=args.gamma_rad_s_t,
            demag_policy=args.demag_policy,
            sampling_mode=args.sampling_mode,
        )
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    except MuMaxManifestError as error:
        print(f"MuMax common-limit manifest rejected: {error}")
        return 2
    print(json.dumps(manifest, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
