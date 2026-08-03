#!/usr/bin/env python3
"""Independently validate and normalize BORIS N/F SHE artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence


MUB_E_V_PER_T = 5.788381608e-05
Vector3 = tuple[float, float, float]


@dataclass(frozen=True)
class OvfField:
    path: Path
    shape: tuple[int, int, int]
    origin_m: Vector3
    step_m: Vector3
    valuedim: int
    values: tuple[tuple[float, ...], ...]
    sha256: str


@dataclass(frozen=True)
class ScenarioParameters:
    conductivity_spm: float
    de_m2_per_s: float
    lambda_sf_m: float

    def __post_init__(self) -> None:
        for name, value in (
            ("conductivity_spm", self.conductivity_spm),
            ("de_m2_per_s", self.de_m2_per_s),
            ("lambda_sf_m", self.lambda_sf_m),
        ):
            if not math.isfinite(value) or value <= 0.0:
                raise ValueError(f"{name} must be finite and positive")


@dataclass(frozen=True)
class MeshFields:
    charge_current: OvfField
    spin_current_x: OvfField
    spin_current_y: OvfField
    spin_current_z: OvfField
    spin_accumulation: OvfField


@dataclass(frozen=True)
class InterfaceSlice:
    normal_axis: str
    normal_sign: int
    normal_flux: Vector3
    ferromagnet_flux: Vector3
    torque: Vector3
    charge_flux: float = 0.0
    ferromagnet_charge_flux: float = 0.0


def _finite_float(value: str, *, label: str) -> float:
    try:
        parsed = float(value)
    except ValueError as error:
        raise ValueError(f"OVF {label} is not numeric: {value!r}") from error
    if not math.isfinite(parsed):
        raise ValueError(f"OVF {label} must be finite")
    return parsed


def _header_value(header: dict[str, str], key: str) -> str:
    try:
        return header[key]
    except KeyError as error:
        raise ValueError(f"OVF header is missing {key}") from error


def read_text_ovf(path: Path) -> OvfField:
    """Read exactly one rectangular text OVF 2.0 segment."""

    if not path.is_file():
        raise ValueError(f"OVF file does not exist: {path}")
    raw = path.read_text(encoding="utf-8", errors="strict")
    lines = raw.splitlines()
    segment_count = sum(line.strip().lower() == "# begin: segment" for line in lines)
    if segment_count != 1:
        raise ValueError(f"OVF must contain exactly one segment, found {segment_count}")
    header: dict[str, str] = {}
    in_header = False
    in_data = False
    data_seen = False
    data_rows: list[tuple[float, ...]] = []
    for line in lines:
        stripped = line.strip()
        lowered = stripped.lower()
        if lowered == "# begin: header":
            if in_header:
                raise ValueError("OVF contains nested headers")
            in_header = True
            continue
        if lowered == "# end: header":
            if not in_header:
                raise ValueError("OVF closes a header that was not opened")
            in_header = False
            continue
        if lowered in {"# begin: data text", "# begin: data: text"}:
            if in_data or in_header:
                raise ValueError("OVF has an invalid data-section transition")
            in_data = True
            data_seen = True
            continue
        if lowered in {"# end: data text", "# end: data: text"}:
            if not in_data:
                raise ValueError("OVF closes a data section that was not opened")
            in_data = False
            continue
        if in_header:
            if not stripped.startswith("#") or ":" not in stripped:
                continue
            key, value = stripped[1:].split(":", 1)
            header[key.strip().lower()] = value.strip()
            continue
        if in_data:
            if not stripped or stripped.startswith("#"):
                continue
            tokens = stripped.split()
            valuedim = int(_header_value(header, "valuedim"))
            if len(tokens) != valuedim:
                raise ValueError(
                    f"OVF row has {len(tokens)} values, expected {valuedim}"
                )
            data_rows.append(
                tuple(_finite_float(token, label="data value") for token in tokens)
            )
    if in_header or in_data or not data_seen:
        raise ValueError("OVF has no complete text data section")
    meshtype = _header_value(header, "meshtype").lower()
    if meshtype != "rectangular":
        raise ValueError(f"OVF meshtype must be rectangular, got {meshtype!r}")
    try:
        shape = tuple(int(_header_value(header, key)) for key in ("xnodes", "ynodes", "znodes"))
        valuedim = int(_header_value(header, "valuedim"))
    except ValueError as error:
        raise ValueError("OVF dimensions and valuedim must be integers") from error
    if any(size < 1 for size in shape) or valuedim < 1:
        raise ValueError("OVF dimensions and valuedim must be positive")
    expected = shape[0] * shape[1] * shape[2]
    if len(data_rows) != expected:
        raise ValueError(f"OVF contains {len(data_rows)} rows, expected {expected}")
    origin = tuple(
        _finite_float(_header_value(header, key), label=key)
        for key in ("xmin", "ymin", "zmin")
    )
    step = tuple(
        _finite_float(_header_value(header, key), label=key)
        for key in ("xstepsize", "ystepsize", "zstepsize")
    )
    if any(value <= 0.0 for value in step):
        raise ValueError("OVF step sizes must be positive")
    return OvfField(
        path=path,
        shape=(shape[0], shape[1], shape[2]),
        origin_m=(origin[0], origin[1], origin[2]),
        step_m=(step[0], step[1], step[2]),
        valuedim=valuedim,
        values=tuple(data_rows),
        sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
    )


def map_boris_spin_to_fullmag_mu_s(
    spin: Sequence[Sequence[float]],
    de_m2_per_s: float,
    conductivity_spm: float,
) -> list[Vector3]:
    """Map BORIS native ``S`` to Fullmag's full spin splitting in volts."""

    if not math.isfinite(de_m2_per_s) or de_m2_per_s <= 0.0:
        raise ValueError("De must be finite and positive")
    if not math.isfinite(conductivity_spm) or conductivity_spm <= 0.0:
        raise ValueError("conductivity must be finite and positive")
    factor = 2.0 * de_m2_per_s / (conductivity_spm * MUB_E_V_PER_T)
    mapped: list[Vector3] = []
    for index, value in enumerate(spin):
        if len(value) != 3:
            raise ValueError(f"spin value {index} must have three components")
        components = tuple(float(component) * factor for component in value)
        if not all(math.isfinite(component) for component in components):
            raise ValueError(f"spin value {index} is not finite")
        mapped.append((components[0], components[1], components[2]))
    return mapped


def _flat_index(shape: tuple[int, int, int], i: int, j: int, k: int) -> int:
    return i + shape[0] * (j + shape[1] * k)


def _component(field: OvfField, i: int, j: int, k: int, component: int) -> float:
    return field.values[_flat_index(field.shape, i, j, k)][component]


def _divergence(field_x: OvfField, field_y: OvfField, field_z: OvfField, i: int, j: int, k: int, component: int) -> float:
    shape = field_x.shape
    dx, dy, dz = field_x.step_m
    return (
        (_component(field_x, i + 1, j, k, component) - _component(field_x, i - 1, j, k, component)) / (2.0 * dx)
        + (_component(field_y, i, j + 1, k, component) - _component(field_y, i, j - 1, k, component)) / (2.0 * dy)
        + (_component(field_z, i, j, k + 1, component) - _component(field_z, i, j, k - 1, component)) / (2.0 * dz)
    )


def _charge_divergence(field: OvfField, i: int, j: int, k: int) -> float:
    dx, dy, dz = field.step_m
    return (
        (_component(field, i + 1, j, k, 0) - _component(field, i - 1, j, k, 0)) / (2.0 * dx)
        + (_component(field, i, j + 1, k, 1) - _component(field, i, j - 1, k, 1)) / (2.0 * dy)
        + (_component(field, i, j, k + 1, 2) - _component(field, i, j, k - 1, 2)) / (2.0 * dz)
    )


def compute_field_residuals(
    fields: MeshFields, parameters: ScenarioParameters
) -> dict[str, object]:
    """Recompute finite-volume charge and mapped spin residuals."""

    all_fields = (
        fields.charge_current,
        fields.spin_current_x,
        fields.spin_current_y,
        fields.spin_current_z,
        fields.spin_accumulation,
    )
    shape = fields.charge_current.shape
    if any(field.shape != shape for field in all_fields):
        raise ValueError("all residual fields must use one grid")
    if any(field.valuedim != 3 for field in all_fields):
        raise ValueError("residual fields must be vector-valued")
    interior = [
        (i, j, k)
        for k in range(1, shape[2] - 1)
        for j in range(1, shape[1] - 1)
        for i in range(1, shape[0] - 1)
    ]
    charge_scale = max(
        max(abs(component) for row in fields.charge_current.values for component in row),
        1.0,
    )
    spin_scale = max(
        max(
            abs(component)
            for field in (fields.spin_current_x, fields.spin_current_y, fields.spin_current_z)
            for row in field.values
            for component in row
        ),
        1.0,
    )
    charge_defects: list[float] = []
    spin_defects: list[float] = []
    reaction_coefficient = parameters.conductivity_spm / (2.0 * parameters.lambda_sf_m**2)
    mapped_accumulation = map_boris_spin_to_fullmag_mu_s(
        fields.spin_accumulation.values,
        parameters.de_m2_per_s,
        parameters.conductivity_spm,
    )
    for i, j, k in interior:
        charge_defects.append(_charge_divergence(fields.charge_current, i, j, k))
        for component in range(3):
            spin_divergence = _divergence(
                fields.spin_current_x,
                fields.spin_current_y,
                fields.spin_current_z,
                i,
                j,
                k,
                component,
            )
            spin_defects.append(
                spin_divergence + reaction_coefficient * mapped_accumulation[_flat_index(shape, i, j, k)][component]
            )
    if not interior:
        charge_defects = [0.0]
        spin_defects = [0.0]
    charge_l2 = math.sqrt(sum(value * value for value in charge_defects) / len(charge_defects))
    spin_l2 = math.sqrt(sum(value * value for value in spin_defects) / len(spin_defects))
    return {
        "charge_scaled_l2": charge_l2 / charge_scale,
        "spin_scaled_l2": spin_l2 / spin_scale,
        "interior_cell_count": len(interior),
        "spin_reaction_model": "sigma_s_mu_s/(2*lambda_sf^2), mu_s=2*De*S/(elC*MUB_E)",
    }


def _vector(value: Sequence[float], *, label: str) -> Vector3:
    if len(value) != 3:
        raise ValueError(f"{label} must have three components")
    result = tuple(float(component) for component in value)
    if not all(math.isfinite(component) for component in result):
        raise ValueError(f"{label} must be finite")
    return (result[0], result[1], result[2])


def compute_interface_balance(interface: InterfaceSlice) -> dict[str, object]:
    if interface.normal_axis not in {"x", "y", "z"}:
        raise ValueError("interface normal axis must be x, y, or z")
    if interface.normal_sign not in {-1, 1}:
        raise ValueError("interface normal sign must be +1 or -1")
    normal_flux = _vector(interface.normal_flux, label="normal spin flux")
    ferromagnet_flux = _vector(interface.ferromagnet_flux, label="ferromagnet spin flux")
    torque = _vector(interface.torque, label="interface torque")
    charge_closure = interface.normal_sign * (
        float(interface.charge_flux) - float(interface.ferromagnet_charge_flux)
    )
    if not math.isfinite(charge_closure):
        raise ValueError("interface charge flux must be finite")
    absorbed = tuple(
        interface.normal_sign * (normal_flux[index] - ferromagnet_flux[index])
        for index in range(3)
    )
    torque_closure_vector = tuple(absorbed[index] - torque[index] for index in range(3))
    return {
        "normal_axis": interface.normal_axis,
        "normal_sign": interface.normal_sign,
        "charge_closure": charge_closure,
        "normal_charge_flux": float(interface.charge_flux),
        "ferromagnet_charge_flux": float(interface.ferromagnet_charge_flux),
        "normal_spin_flux": list(normal_flux),
        "ferromagnet_spin_flux": list(ferromagnet_flux),
        "spin_flux_jump": list(absorbed),
        "absorbed_spin_flux": list(absorbed),
        "torque": list(torque),
        "spin_torque_closure_vector": list(torque_closure_vector),
        "spin_torque_closure": math.sqrt(sum(value * value for value in torque_closure_vector)),
    }


def compute_interface_slice(
    normal: MeshFields,
    ferromagnet: MeshFields,
    interfacial_torque: OvfField,
    *,
    normal_axis: str = "z",
    normal_sign: int = 1,
) -> InterfaceSlice:
    """Extract a signed N/F interface slice from exported BORIS fields.

    BORIS stores each spin-polarization current as a vector-valued field.  The
    ``+z`` interface therefore uses component ``z`` from ``Jsx``, ``Jsy`` and
    ``Jsz``.  Those display fields contain BORIS' explicit ``MUB_E`` factor;
    the comparison adapter maps them to Fullmag's charge-equivalent
    ``Q_ia`` by dividing by ``MUB_E``.  BORIS reports ``Tsi`` in A/(m s)
    through its effective-field normalization.  We retain a documented
    cell-thickness conversion as a diagnostic torque observable, but do not
    assert that it is already the same areal spin-flux convention as ``Js``.
    The result is intentionally a raw balance and is not a qualification
    decision.
    """

    if normal_axis != "z":
        raise ValueError("BORIS N/F interface extraction currently requires z normal")
    if normal_sign not in {-1, 1}:
        raise ValueError("normal sign must be +1 or -1")
    normal_fields = (
        normal.charge_current,
        normal.spin_current_x,
        normal.spin_current_y,
        normal.spin_current_z,
    )
    ferromagnet_fields = (
        ferromagnet.charge_current,
        ferromagnet.spin_current_x,
        ferromagnet.spin_current_y,
        ferromagnet.spin_current_z,
    )
    if any(field.valuedim != 3 for field in (*normal_fields, *ferromagnet_fields)):
        raise ValueError("interface fields must be vector-valued")
    for left, right in zip(normal_fields, ferromagnet_fields):
        if left.shape[:2] != right.shape[:2]:
            raise ValueError("N/F interface fields have incompatible in-plane grids")
    if interfacial_torque.valuedim != 3:
        raise ValueError("interfacial torque must be vector-valued")
    if interfacial_torque.shape[:2] != ferromagnet.charge_current.shape[:2]:
        raise ValueError("interfacial torque and ferromagnet grid are incompatible")

    nx, ny = normal.charge_current.shape[:2]
    n_k = normal.charge_current.shape[2] - 1
    f_k = 0

    def plane_average(field: OvfField, k: int, component: int) -> float:
        values = [
            _component(field, i, j, k, component)
            for j in range(ny)
            for i in range(nx)
        ]
        return sum(values) / len(values)

    normal_flux = (
        plane_average(normal.spin_current_x, n_k, 2),
        plane_average(normal.spin_current_y, n_k, 2),
        plane_average(normal.spin_current_z, n_k, 2),
    )
    ferromagnet_flux = (
        plane_average(ferromagnet.spin_current_x, f_k, 2),
        plane_average(ferromagnet.spin_current_y, f_k, 2),
        plane_average(ferromagnet.spin_current_z, f_k, 2),
    )
    torque = tuple(
        sum(
            _component(interfacial_torque, i, j, min(f_k, interfacial_torque.shape[2] - 1), component)
            for j in range(ny)
            for i in range(nx)
        )
        / (nx * ny)
        * interfacial_torque.step_m[2]
        for component in range(3)
    )
    return InterfaceSlice(
        normal_axis=normal_axis,
        normal_sign=normal_sign,
        normal_flux=normal_flux,
        ferromagnet_flux=ferromagnet_flux,
        torque=(torque[0], torque[1], torque[2]),
        charge_flux=plane_average(normal.charge_current, n_k, 2),
        ferromagnet_charge_flux=plane_average(ferromagnet.charge_current, f_k, 2),
    )


def _field_path(root: Path, entry: object) -> Path:
    if isinstance(entry, str):
        path = root / entry
    elif isinstance(entry, dict) and isinstance(entry.get("path"), str):
        path = root / str(entry["path"])
    else:
        raise ValueError("field entry must be a relative OVF path")
    if path.is_absolute() and root not in path.parents:
        raise ValueError("field path escapes artifact root")
    return path


def _require_finite_number(value: object, *, label: str) -> float:
    if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise ValueError(f"{label} must be finite")
    return float(value)


def validate_boris_artifact(root: Path) -> dict[str, object]:
    """Validate a prepared ``fullmag.boris_she_nf.v1`` artifact directory."""

    summary_path = root / "summary.json"
    if not summary_path.is_file():
        raise ValueError(f"BORIS artifact is missing {summary_path}")
    try:
        payload = json.loads(summary_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"BORIS artifact summary is not JSON: {error}") from error
    if not isinstance(payload, dict):
        raise ValueError("BORIS artifact summary must be an object")
    if payload.get("schema_version") != "fullmag.boris_she_nf.v1":
        raise ValueError("BORIS artifact schema_version is unsupported")
    runtime = payload.get("runtime")
    if not isinstance(runtime, dict) or runtime.get("identity_complete") is not True:
        raise ValueError("BORIS artifact runtime identity is incomplete")
    scenario = payload.get("scenario")
    if not isinstance(scenario, dict) or scenario.get("workload") != "N/F":
        raise ValueError("BORIS artifact scenario workload must be N/F")
    parameters = scenario.get("parameters")
    if not isinstance(parameters, dict):
        raise ValueError("BORIS artifact scenario parameters are missing")
    sha = _require_finite_number(parameters.get("SHA"), label="SHA")
    isha = _require_finite_number(parameters.get("iSHA"), label="iSHA")
    if sha != isha:
        raise ValueError("BORIS artifact requires SHA=iSHA")
    if _require_finite_number(parameters.get("Gi_Spm2"), label="Gi") == 0.0:
        raise ValueError("BORIS artifact requires non-zero Gi")
    gmix = parameters.get("Gmix_Spm2")
    if not isinstance(gmix, list) or len(gmix) != 2 or _require_finite_number(gmix[0], label="Gmix.real") == 0.0:
        raise ValueError("BORIS artifact requires non-zero Gmix.real")
    fields = payload.get("fields")
    if not isinstance(fields, dict):
        raise ValueError("BORIS artifact fields are missing")
    required_normal = {"V", "S", "Jc", "Jsx", "Jsy", "Jsz"}
    required_ferromagnet = required_normal | {"Ts", "Tsi"}
    parsed_fields: dict[str, dict[str, OvfField]] = {}
    for mesh, required in (("normal", required_normal), ("ferromagnet", required_ferromagnet)):
        entries = fields.get(mesh)
        if not isinstance(entries, dict) or not required.issubset(entries):
            raise ValueError(f"BORIS artifact fields.{mesh} is incomplete")
        parsed_fields[mesh] = {}
        for name in sorted(required):
            parsed_fields[mesh][name] = read_text_ovf(_field_path(root, entries[name]))
    residuals = payload.get("residuals")
    if not isinstance(residuals, dict):
        raise ValueError("BORIS artifact residuals are missing")
    for key in ("charge_scaled_l2", "spin_scaled_l2"):
        _require_finite_number(residuals.get(key), label=f"residuals.{key}")
    balances = payload.get("interface_balances")
    if not isinstance(balances, dict):
        raise ValueError("BORIS artifact interface_balances are missing")
    for key in ("charge_closure", "spin_torque_closure"):
        _require_finite_number(balances.get(key), label=f"interface_balances.{key}")
    qualification = payload.get("qualification")
    if not isinstance(qualification, dict):
        raise ValueError("BORIS artifact qualification is missing")
    if qualification.get("status") != "diagnostic":
        raise ValueError("BORIS artifact qualification status must remain diagnostic")
    validated = dict(payload)
    validated["parsed_field_metadata"] = {
        mesh: {
            name: {
                "shape": list(field.shape),
                "step_m": list(field.step_m),
                "sha256": field.sha256,
            }
            for name, field in entries.items()
        }
        for mesh, entries in parsed_fields.items()
    }
    return validated


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = validate_boris_artifact(args.artifact)
    serialized = json.dumps(report, indent=2, sort_keys=True)
    if args.output is None:
        print(serialized)
    else:
        args.output.write_text(serialized + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
