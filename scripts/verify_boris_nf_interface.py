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
BORIS_UNIT_ADAPTER_VERSION = "fullmag.boris_flow_major_units.v2"
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
    l_ex_m: float | None = None
    l_ph_m: float | None = None
    magnetization: Vector3 = (1.0, 0.0, 0.0)

    def __post_init__(self) -> None:
        for name, value in (
            ("conductivity_spm", self.conductivity_spm),
            ("de_m2_per_s", self.de_m2_per_s),
            ("lambda_sf_m", self.lambda_sf_m),
        ):
            if not math.isfinite(value) or value <= 0.0:
                raise ValueError(f"{name} must be finite and positive")
        for name, value in (("l_ex_m", self.l_ex_m), ("l_ph_m", self.l_ph_m)):
            if value is not None and (not math.isfinite(value) or value <= 0.0):
                raise ValueError(f"{name} must be finite and positive when provided")
        if len(self.magnetization) != 3 or not all(
            math.isfinite(float(component)) for component in self.magnetization
        ):
            raise ValueError("magnetization must be finite and three-dimensional")
        if sum(float(component) ** 2 for component in self.magnetization) == 0.0:
            raise ValueError("magnetization must be non-zero")


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
    raw_bytes = path.read_bytes()
    raw = raw_bytes.decode("utf-8", errors="strict")
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
        sha256=hashlib.sha256(raw_bytes).hexdigest(),
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
    fields: MeshFields,
    parameters: ScenarioParameters,
    *,
    material: str = "normal",
) -> dict[str, object]:
    """Recompute finite-volume residuals in one consistent BORIS unit system.

    BORIS stores ``Js`` in ``A/s`` and ``S`` in ``A/m``.  The native residual
    therefore uses ``div(Js) + De * reaction(S)``.  A charge-equivalent
    ``Q=Js/MUB_E`` residual would be mathematically equivalent, but mixing the
    two unit systems is invalid.  The ferromagnetic branch is limited to the
    rendered N/F workload: constant magnetization, uniform material, and no
    topological-Hall or pumping source.
    """

    if material not in {"normal", "ferromagnet"}:
        raise ValueError("material must be normal or ferromagnet")
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
    h_ref = min(fields.charge_current.step_m)
    charge_magnitude = max(
        (abs(component) for row in fields.charge_current.values for component in row),
        default=0.0,
    )
    spin_magnitude = max(
        (
            abs(component)
            for field in (fields.spin_current_x, fields.spin_current_y, fields.spin_current_z)
            for row in field.values
            for component in row
        ),
        default=0.0,
    )
    accumulation_magnitude = max(
        (abs(component) for row in fields.spin_accumulation.values for component in row),
        default=0.0,
    )
    charge_scale = max(charge_magnitude / h_ref, 1.0)
    spin_reaction_lengths = [parameters.lambda_sf_m]
    if material == "ferromagnet":
        if parameters.l_ex_m is None or parameters.l_ph_m is None:
            raise ValueError("ferromagnet residual requires l_ex_m and l_ph_m")
        spin_reaction_lengths.extend((parameters.l_ex_m, parameters.l_ph_m))
    spin_scale = max(
        spin_magnitude / h_ref,
        parameters.de_m2_per_s * accumulation_magnitude / min(spin_reaction_lengths) ** 2,
        1.0,
    )
    magnetization = tuple(float(component) for component in parameters.magnetization)
    magnetization_norm = math.sqrt(sum(component * component for component in magnetization))
    m = tuple(component / magnetization_norm for component in magnetization)

    def cross(left: Vector3, right: Vector3) -> Vector3:
        return (
            left[1] * right[2] - left[2] * right[1],
            left[2] * right[0] - left[0] * right[2],
            left[0] * right[1] - left[1] * right[0],
        )

    charge_defects: list[float] = []
    spin_defects: list[float] = []
    for i, j, k in interior:
        charge_defects.append(_charge_divergence(fields.charge_current, i, j, k))
        accumulation = fields.spin_accumulation.values[_flat_index(shape, i, j, k)]
        reaction = [accumulation[index] / (parameters.lambda_sf_m**2) for index in range(3)]
        if material == "ferromagnet":
            if parameters.l_ex_m is None or parameters.l_ph_m is None:
                raise ValueError("ferromagnet residual requires l_ex_m and l_ph_m")
            transverse_exchange = cross(accumulation, m)
            transverse_dephasing = cross(m, transverse_exchange)
            for index in range(3):
                reaction[index] += (
                    transverse_exchange[index] / (parameters.l_ex_m**2)
                    + transverse_dephasing[index] / (parameters.l_ph_m**2)
                )
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
            spin_defects.append(spin_divergence + parameters.de_m2_per_s * reaction[component])
    if not interior:
        charge_defects = [0.0]
        spin_defects = [0.0]
    charge_l2 = math.sqrt(sum(value * value for value in charge_defects) / len(charge_defects))
    spin_l2 = math.sqrt(sum(value * value for value in spin_defects) / len(spin_defects))
    return {
        "charge_scaled_l2": charge_l2 / charge_scale,
        "spin_scaled_l2": spin_l2 / spin_scale,
        "interior_cell_count": len(interior),
        "material": material,
        "spin_reaction_model": (
            "De*S/lambda_sf^2 (normal, native BORIS units)"
            if material == "normal"
            else "De*(S/lambda_sf^2+(Sxm)/l_ex^2+(mx(Sxm))/l_ph^2) "
            "(exchange/dephasing, constant-magnetization F workload, native BORIS units)"
        ),
        "residual_unit": "A/(m*s) native BORIS divergence",
        "residual_scale": "max(|J|/h, |De*S|/reaction_length^2, 1)",
        "characteristic_length_m": h_ref,
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

    BORIS exports flow-major rows: Jsx = (Q_xx, Q_xy, Q_xz), and likewise
    for Jsy/Jsz. The +z interface therefore uses all three components of
    Jsz. Those display fields contain BORIS' explicit ``MUB_E`` factor;
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

    normal_flux = tuple(
        plane_average(normal.spin_current_z, n_k, polarization)
        for polarization in range(3)
    )
    ferromagnet_flux = tuple(
        plane_average(ferromagnet.spin_current_z, f_k, polarization)
        for polarization in range(3)
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


def validate_fixed_m(root: Path, scenario: dict, native: dict) -> dict[str, object]:
    """Recompute the fixed-M/l_J gate from retained raw outputs, never summary claims."""
    from boris_nf_interface_smoke import FIXED_M_EXECUTION
    import fullmag_storage as storage

    if (scenario.get("schema_version") != "fullmag.boris_she_nf.scenario.v2"
            or scenario.get("workload") != "N/F"
            or scenario.get("execution") != FIXED_M_EXECUTION
            or type(scenario.get("execution", {}).get("static_transport")) is not bool
            or native.get("schema_version") != "fullmag.boris_she_nf.native.v2"
            or native.get("scenario") != scenario or native.get("stage_complete") is not True):
        raise ValueError("BORIS fixed-M requires the exact v2 N/F execution contract")
    fixed = native.get("fixed_m")
    if not isinstance(fixed, dict) or set(fixed) != {
        "schema_version", "M_before", "M_after", "l_J_readback_m", "execution_mode"
    } or (fixed.get("schema_version") != "fullmag.boris_fixed_m.v1"
            or fixed.get("M_before") != "f_M_before.ovf"
            or fixed.get("M_after") != "f_M_after.ovf"
            or fixed.get("execution_mode") != "fixed_m_transport_only"):
        raise ValueError("BORIS fixed-M raw proof is missing or unsupported")
    parameters = scenario.get("parameters")
    geometry = scenario.get("geometry")
    if not isinstance(parameters, dict) or not isinstance(geometry, dict):
        raise ValueError("BORIS fixed-M scenario parameters/geometry are missing")
    if (parameters.get("magnetization") != [1.0, 0.0, 0.0]
            or any(type(value) not in (int, float) for value in parameters["magnetization"])):
        raise ValueError("BORIS fixed-M supports only the authored +x direction")
    def positive(value, label):
        if type(value) not in (int, float) or not math.isfinite(value) or value <= 0.0:
            raise ValueError(f"BORIS fixed-M {label} must be a finite positive scalar")
        return float(value)
    ms = positive(parameters.get("Ms_apm"), "Ms")
    requested_length = positive(parameters.get("l_ex_m"), "l_ex")
    actual_length = positive(fixed.get("l_J_readback_m"), "l_J readback")
    if not math.isclose(actual_length, requested_length,
                        rel_tol=FIXED_M_EXECUTION["l_J_relative_tolerance"], abs_tol=0.0):
        raise ValueError("BORIS fixed-M l_J readback differs from the requested l_ex")
    shape = geometry.get("ferromagnet_shape")
    step = geometry.get("cell_m")
    normal_extent = geometry.get("normal_extent_m")
    if (not isinstance(shape, list) or len(shape) != 3
            or any(type(n) is not int or n < 1 for n in shape)
            or not isinstance(step, list) or len(step) != 3
            or not isinstance(normal_extent, list) or len(normal_extent) != 3):
        raise ValueError("BORIS fixed-M geometry is malformed")
    step = tuple(positive(value, "cell step") for value in step)
    origin = (0.0, 0.0, positive(normal_extent[2], "normal thickness"))
    fields = []
    for name, dimension in (("f_M_before.ovf", 3), ("f_M_after.ovf", 3), ("f_V.ovf", 1)):
        path = storage.validate_path(root / name, root)
        if storage.is_link(path) or not path.is_file() or not 0 < path.stat().st_size <= 64 * 1024**2:
            raise ValueError("BORIS fixed-M raw field must be a bounded regular file")
        field = read_text_ovf(path)
        if (field.shape != tuple(shape) or field.valuedim != dimension
                or any(not math.isclose(a, b, rel_tol=1.0e-12, abs_tol=1.0e-18)
                       for a, b in zip((*field.origin_m, *field.step_m), (*origin, *step)))):
            raise ValueError("BORIS fixed-M carrier differs from the authored F grid")
        fields.append(field)
    before, after, _ = fields
    maximum_before = max(abs(value - (ms if axis == 0 else 0.0))
                         for row in before.values for axis, value in enumerate(row))
    maximum_after = max(abs(value - (ms if axis == 0 else 0.0))
                        for row in after.values for axis, value in enumerate(row))
    maximum_change = max(abs(a - b) for left, right in zip(before.values, after.values)
                         for a, b in zip(left, right))
    tolerance = (FIXED_M_EXECUTION["magnetization_absolute_tolerance_apm"]
                 + FIXED_M_EXECUTION["magnetization_relative_tolerance"] * ms)
    if max(maximum_before, maximum_after, maximum_change) > tolerance:
        raise ValueError("BORIS fixed-M all-cell magnetization gate failed")
    return {
        "schema_version": "fullmag.boris_fixed_m.proof.v1",
        "M_before_sha256": before.sha256,
        "M_after_sha256": after.sha256,
        "sample_count": len(before.values),
        "maximum_before_error_apm": maximum_before,
        "maximum_after_error_apm": maximum_after,
        "maximum_change_apm": maximum_change,
        "l_J_readback_m": actual_length,
    }


def validate_boris_artifact(root: Path, *, repo_root: Path | None = None) -> dict[str, object]:
    """Validate a prepared ``fullmag.boris_she_nf.v2`` artifact directory."""

    summary_path = root / "summary.json"
    if not summary_path.is_file():
        raise ValueError(f"BORIS artifact is missing {summary_path}")
    try:
        from run_managed_boris_nf import read_json
        payload = read_json(summary_path)
    except json.JSONDecodeError as error:
        raise ValueError(f"BORIS artifact summary is not JSON: {error}") from error
    if not isinstance(payload, dict):
        raise ValueError("BORIS artifact summary must be an object")
    if payload.get("schema_version") != "fullmag.boris_she_nf.v2":
        raise ValueError("BORIS artifact schema_version is unsupported")
    runtime = payload.get("runtime")
    if not isinstance(runtime, dict) or runtime.get("identity_complete") is not True:
        raise ValueError("BORIS artifact runtime identity is incomplete")
    from run_boris_nf_interface import validate_runtime_identity
    retained_outputs = validate_runtime_identity(runtime, repo_root=repo_root, artifact_root=root)
    scenario = payload.get("scenario")
    if not isinstance(scenario, dict) or scenario.get("workload") != "N/F":
        raise ValueError("BORIS artifact scenario workload must be N/F")
    from run_managed_boris_nf import read_json, require_fixed_m_members
    retained_by_path = {entry["path"]: entry["sha256"] for entry in retained_outputs}
    native = read_json(root / "boris_native_samples.json",
                       expected_sha256=retained_by_path["boris_native_samples.json"])
    fixed_m_proof = validate_fixed_m(root, scenario, native)
    require_fixed_m_members(fixed_m_proof, retained_outputs)
    if json.dumps(payload.get("fixed_m_proof"), sort_keys=True, allow_nan=False) != json.dumps(
        fixed_m_proof, sort_keys=True, allow_nan=False
    ):
        raise ValueError("BORIS summary fixed-M proof differs from retained raw outputs")
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
    parser.add_argument("--repo-root", type=Path, help="trusted managed BORIS v2 storage context")
    args = parser.parse_args()
    report = validate_boris_artifact(args.artifact, repo_root=args.repo_root)
    serialized = json.dumps(report, indent=2, sort_keys=True)
    if args.output is None:
        print(serialized)
    else:
        args.output.write_text(serialized + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
