#!/usr/bin/env python3
"""Export an accepted Fullmag Gilbert torque as a frozen MuMax3 ``B_ext`` field.

The source quantity is the accepted Fullmag ``T_tr_G`` Gilbert-source torque in
``s^-1``.  Fullmag's documented explicit Gilbert equation is

    (1 + alpha^2) dm/dt = -gamma_e [m x B + alpha m x (m x B)]
                                + T_tr_G + alpha m x T_tr_G.

For a tangent torque (``m . T_tr_G = 0``), the unique tangent field producing
the same RHS is ``B_eq = (m x T_tr_G) / gamma_e`` in tesla.  The factor is
independent of alpha, but alpha remains recorded because it fixes the Gilbert
convention being matched.  A non-tangent source is rejected rather than
silently projected: it cannot be represented by a magnetic field in LLG.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import struct
from typing import Any, Mapping, Sequence


INPUT_SCHEMA = "fullmag_transport_torque_snapshot.v1"
EXPORT_SCHEMA = "fullmag_transport_torque_mumax_export.v1"
TORQUE_FORMULA = "transport_torque_angular_momentum.fullmag.v1"
GILBERT_CONVENTION = "gilbert_explicit_fullmag.v1"
FIELD_CONVENTION = "B_eq_equals_m_cross_T_tr_G_over_gamma_e.v1"
CELL_ORDER = "x_fastest_then_y_then_z"
_TANGENCY_REL_TOLERANCE = 1.0e-12
_UNIT_NORM_TOLERANCE = 1.0e-10


class ExportError(ValueError):
    """The accepted-snapshot contract cannot produce a safe MuMax field."""


Vector = tuple[float, float, float]


def _mapping(value: object, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ExportError(f"{label} must be an object")
    return value


def _text(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ExportError(f"{label} must be a nonempty string")
    return value


def _number(value: object, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ExportError(f"{label} must be a finite number")
    result = float(value)
    if not math.isfinite(result):
        raise ExportError(f"{label} must be a finite number")
    return result


def _vector(value: object, label: str) -> Vector:
    if not isinstance(value, list) or len(value) != 3:
        raise ExportError(f"{label} must contain three components")
    return tuple(_number(component, f"{label}[{axis}]") for axis, component in enumerate(value))  # type: ignore[return-value]


def _vectors(value: object, label: str) -> list[Vector]:
    if not isinstance(value, list) or not value:
        raise ExportError(f"{label} must be a nonempty vector field")
    return [_vector(item, f"{label}[{index}]") for index, item in enumerate(value)]


def _cross(left: Vector, right: Vector) -> Vector:
    return (
        left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0],
    )


def _dot(left: Vector, right: Vector) -> float:
    return sum(a * b for a, b in zip(left, right))


def vector_field_digest(values: Sequence[Vector]) -> str:
    """Digest the canonical little-endian f64 vector sequence, never text JSON."""
    digest = hashlib.sha256(b"fullmag-vector-field-f64le.v1\\0")
    digest.update(struct.pack("<Q", len(values)))
    for value in values:
        digest.update(struct.pack("<3d", *value))
    return digest.hexdigest()


def canonical_json_digest(value: Mapping[str, Any]) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def equivalent_field(magnetization: Sequence[Vector], torque_per_s: Sequence[Vector], gamma_rad_s_t: float) -> list[Vector]:
    """Return the tangent ``B_eq`` field and reject a nonphysical source torque."""
    if not math.isfinite(gamma_rad_s_t) or gamma_rad_s_t <= 0.0:
        raise ExportError("gamma_rad_s_T must be finite and positive")
    if len(magnetization) != len(torque_per_s):
        raise ExportError("magnetization and T_tr_G cell counts differ")
    output: list[Vector] = []
    for index, (m, torque) in enumerate(zip(magnetization, torque_per_s)):
        m_norm = math.sqrt(_dot(m, m))
        if not math.isclose(m_norm, 1.0, rel_tol=0.0, abs_tol=_UNIT_NORM_TOLERANCE):
            raise ExportError(f"magnetization[{index}] is not a unit vector")
        tangency_error = abs(_dot(m, torque))
        torque_norm = math.sqrt(_dot(torque, torque))
        if tangency_error > _TANGENCY_REL_TOLERANCE * max(1.0, torque_norm):
            raise ExportError(f"T_tr_G[{index}] is not tangent to magnetization")
        output.append(tuple(component / gamma_rad_s_t for component in _cross(m, torque)))  # type: ignore[arg-type]
    return output


def _grid(snapshot: Mapping[str, Any]) -> dict[str, object]:
    raw = _mapping(snapshot.get("grid"), "grid")
    shape_value = raw.get("shape")
    if not isinstance(shape_value, list) or len(shape_value) != 3:
        raise ExportError("grid.shape must contain three positive integers")
    shape: list[int] = []
    for axis, value in enumerate(shape_value):
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise ExportError(f"grid.shape[{axis}] must be a positive integer")
        shape.append(value)
    for key in ("cell_size_m", "origin_m"):
        vector = _vector(raw.get(key), f"grid.{key}")
        if key == "cell_size_m" and any(component <= 0.0 for component in vector):
            raise ExportError("grid.cell_size_m must be strictly positive")
    if raw.get("cell_order") != CELL_ORDER:
        raise ExportError(f"grid.cell_order must be {CELL_ORDER!r}")
    return {
        "shape": shape,
        "cell_size_m": list(_vector(raw.get("cell_size_m"), "grid.cell_size_m")),
        "origin_m": list(_vector(raw.get("origin_m"), "grid.origin_m")),
        "cell_order": CELL_ORDER,
    }


def export_snapshot(snapshot: Mapping[str, Any]) -> tuple[list[Vector], dict[str, object]]:
    """Validate one accepted source snapshot and produce its immutable manifest."""
    if snapshot.get("schema_version") != INPUT_SCHEMA:
        raise ExportError(f"schema_version must be {INPUT_SCHEMA!r}")
    if snapshot.get("status") != "accepted" or snapshot.get("accepted") is not True:
        raise ExportError("source snapshot must be accepted")
    grid = _grid(snapshot)
    expected_count = math.prod(grid["shape"])
    magnetization = _mapping(snapshot.get("magnetization"), "magnetization")
    if magnetization.get("quantity") != "m" or magnetization.get("units") != "1":
        raise ExportError("magnetization must be quantity m in units 1")
    m_values = _vectors(magnetization.get("values"), "magnetization.values")
    torque = _mapping(snapshot.get("torque"), "torque")
    if torque.get("quantity") != "T_tr_G" or torque.get("units") != "s^-1":
        raise ExportError("torque must be quantity T_tr_G in units s^-1")
    if torque.get("formula_version") != TORQUE_FORMULA:
        raise ExportError("torque formula is not the solved Fullmag transport torque")
    torque_values = _vectors(torque.get("values"), "torque.values")
    if len(m_values) != expected_count or len(torque_values) != expected_count:
        raise ExportError("field cell count does not match grid.shape")
    llg = _mapping(snapshot.get("llg"), "llg")
    if llg.get("convention") != GILBERT_CONVENTION:
        raise ExportError("LLG convention must be canonical explicit Gilbert")
    alpha = _number(llg.get("alpha"), "llg.alpha")
    if alpha < 0.0:
        raise ExportError("llg.alpha must be nonnegative")
    gamma = _number(llg.get("gamma_rad_s_T"), "llg.gamma_rad_s_T")
    b_values = equivalent_field(m_values, torque_values, gamma)
    source_torque_digest = vector_field_digest(torque_values)
    b_digest = vector_field_digest(b_values)
    manifest: dict[str, object] = {
        "schema_version": EXPORT_SCHEMA,
        "status": "accepted",
        "grid": {**grid, "digest_sha256": canonical_json_digest(grid)},
        "source_magnetization": {
            "quantity": "m",
            "units": "1",
            "field_digest_sha256": vector_field_digest(m_values),
        },
        "source_torque": {
            "quantity": "T_tr_G",
            "units": "s^-1",
            "formula_version": TORQUE_FORMULA,
            "field_digest_sha256": source_torque_digest,
        },
        "equivalent_field": {
            "quantity": "B_eq",
            "units": "T",
            "formula_version": FIELD_CONVENTION,
            "field_digest_sha256": b_digest,
            "source_torque_digest_sha256": source_torque_digest,
        },
        "llg": {
            "convention": GILBERT_CONVENTION,
            "alpha": alpha,
            "gamma_rad_s_T": gamma,
        },
        "frozen_torque": {
            "enabled": True,
            "source_snapshot_is_accepted": True,
            "update_policy": "frozen_from_accepted_fullmag_snapshot",
            "dynamic_transport_recomputation": False,
        },
    }
    return b_values, manifest


def write_ovf_text(path: Path, grid: Mapping[str, object], values: Sequence[Vector]) -> None:
    """Write an OOMMF OVF2 text vector field interpreted by MuMax as tesla."""
    shape = grid["shape"]
    cell = grid["cell_size_m"]
    origin = grid["origin_m"]
    if not isinstance(shape, list) or not isinstance(cell, list) or not isinstance(origin, list):
        raise ExportError("internal grid serialization error")
    lines = [
        "# OOMMF OVF 2.0",
        "# Segment count: 1",
        "# Begin: Segment",
        "# Begin: Header",
        "# Title: Fullmag frozen transport torque equivalent field B_eq",
        f"# Desc: {FIELD_CONVENTION}; units T; source is accepted T_tr_G",
        "# meshtype: rectangular",
        "# meshunit: m",
        f"# xbase: {origin[0]}",
        f"# ybase: {origin[1]}",
        f"# zbase: {origin[2]}",
        f"# xstepsize: {cell[0]}",
        f"# ystepsize: {cell[1]}",
        f"# zstepsize: {cell[2]}",
        f"# xnodes: {shape[0]}",
        f"# ynodes: {shape[1]}",
        f"# znodes: {shape[2]}",
        "# valuedim: 3",
        "# valuelabels: B_eq_x B_eq_y B_eq_z",
        "# valueunits: T T T",
        "# End: Header",
        "# Begin: Data Text",
    ]
    lines.extend(f"{value[0]:.17g} {value[1]:.17g} {value[2]:.17g}" for value in values)
    lines.extend(("# End: Data Text", "# End: Segment", ""))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="ascii")


def _load(path: Path) -> Mapping[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise ExportError(f"cannot read {path}: {error}") from error
    except json.JSONDecodeError as error:
        raise ExportError(f"cannot parse {path}: {error}") from error
    return _mapping(value, str(path))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True, help="accepted Fullmag T_tr_G and m snapshot JSON")
    parser.add_argument("--output-ovf", type=Path, required=True, help="frozen B_eq OVF2 text output")
    parser.add_argument("--output-manifest", type=Path, required=True, help="versioned B_eq provenance manifest")
    args = parser.parse_args()
    try:
        b_values, manifest = export_snapshot(_load(args.input))
        write_ovf_text(args.output_ovf, _mapping(manifest["grid"], "export grid"), b_values)
        ovf_digest = hashlib.sha256(args.output_ovf.read_bytes()).hexdigest()
        manifest["equivalent_field"]["ovf_sha256"] = ovf_digest  # type: ignore[index]
        manifest["equivalent_field"]["ovf_format"] = "oommf_ovf_2_text"  # type: ignore[index]
        args.output_manifest.parent.mkdir(parents=True, exist_ok=True)
        args.output_manifest.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    except ExportError as error:
        print(f"Fullmag transport torque export failed: {error}")
        return 2
    print(json.dumps(manifest, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
