#!/usr/bin/env python3
"""Compare normalized BORIS and Fullmag FDM M2 SHE transport artifacts.

The module deliberately separates field normalization from numerical comparison.
It is a diagnostic adapter: a matching report never promotes either solver to a
validated or production-qualified transport implementation.
"""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

from verify_boris_nf_interface import (
    map_boris_spin_to_fullmag_mu_s,
    read_text_ovf,
    validate_boris_artifact,
)


Vector3 = tuple[float, float, float]
Tensor9 = tuple[float, float, float, float, float, float, float, float, float]
_MATCH_TOLERANCE = 1.0e-6
_MESH_REL_TOLERANCE = 1.0e-12
_MESH_ABS_TOLERANCE = 1.0e-18


def _finite(value: object, *, label: str) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise ValueError(f"{label} must be a finite number")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{label} must be a finite number")
    return result


def _vector(value: object, *, label: str) -> Vector3:
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        raise ValueError(f"{label} must have exactly three components")
    result = tuple(_finite(component, label=f"{label}[{index}]") for index, component in enumerate(value))
    return (result[0], result[1], result[2])


def _tensor(value: object, *, label: str) -> Tensor9:
    if not isinstance(value, (list, tuple)):
        raise ValueError(f"{label} must be a nine-component Q_ia tensor")
    if len(value) != 9:
        raise ValueError(f"{label} must be a nine-component Q_ia tensor")
    result = tuple(_finite(component, label=f"{label}[{index}]") for index, component in enumerate(value))
    return (
        result[0],
        result[1],
        result[2],
        result[3],
        result[4],
        result[5],
        result[6],
        result[7],
        result[8],
    )


def _positive_triplet(value: object, *, label: str) -> tuple[float, float, float]:
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        raise ValueError(f"{label} must have three components")
    result = tuple(_finite(component, label=f"{label}[{index}]") for index, component in enumerate(value))
    if any(component <= 0.0 for component in result):
        raise ValueError(f"{label} must be positive")
    return (result[0], result[1], result[2])


def _shape(value: object, *, label: str) -> tuple[int, int, int]:
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        raise ValueError(f"{label} must have three dimensions")
    result: list[int] = []
    for index, component in enumerate(value):
        if not isinstance(component, int) or isinstance(component, bool) or component < 1:
            raise ValueError(f"{label}[{index}] must be a positive integer")
        result.append(component)
    return (result[0], result[1], result[2])


def _count(shape: tuple[int, int, int]) -> int:
    return shape[0] * shape[1] * shape[2]


def _scalar_field(value: object, *, label: str, count: int) -> tuple[float, ...]:
    if not isinstance(value, list) or len(value) != count:
        raise ValueError(f"{label} must contain {count} scalar cells")
    return tuple(_finite(item, label=f"{label}[{index}]") for index, item in enumerate(value))


def _vector_field(value: object, *, label: str, count: int) -> tuple[Vector3, ...]:
    if not isinstance(value, list) or len(value) != count:
        raise ValueError(f"{label} must contain {count} vector cells")
    return tuple(_vector(item, label=f"{label}[{index}]") for index, item in enumerate(value))


def _tensor_field(value: object, *, label: str, count: int) -> tuple[Tensor9, ...]:
    if not isinstance(value, list) or len(value) != count:
        raise ValueError(f"{label} must contain {count} nine-component tensors")
    return tuple(_tensor(item, label=f"{label}[{index}]") for index, item in enumerate(value))


def _json_object(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise ValueError(f"artifact does not exist: {path}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"artifact is not valid JSON: {error}") from error
    if not isinstance(value, dict):
        raise ValueError("artifact root must be a JSON object")
    return value


def _field(payload: Mapping[str, Any], module: Mapping[str, Any], name: str) -> object:
    if name in payload:
        return payload[name]
    if name in module:
        return module[name]
    raise ValueError(f"Fullmag artifact is missing {name}")


def _mesh_metadata(payload: Mapping[str, Any]) -> tuple[tuple[int, int, int], Vector3, tuple[float, float, float]]:
    mesh = payload.get("mesh")
    if not isinstance(mesh, dict):
        raise ValueError("Fullmag artifact must declare mesh metadata")
    shape = _shape(mesh.get("shape"), label="mesh.shape")
    origin_raw = mesh.get("origin_m", [0.0, 0.0, 0.0])
    if not isinstance(origin_raw, (list, tuple)) or len(origin_raw) != 3:
        raise ValueError("mesh.origin_m must have three components")
    origin_values = tuple(_finite(item, label=f"mesh.origin_m[{index}]") for index, item in enumerate(origin_raw))
    step = _positive_triplet(mesh.get("step_m"), label="mesh.step_m")
    return shape, (origin_values[0], origin_values[1], origin_values[2]), step


def _residuals(payload: Mapping[str, Any], module: Mapping[str, Any]) -> dict[str, float]:
    raw = payload.get("residuals")
    if raw is None:
        raw = module.get("residuals")
    if not isinstance(raw, dict):
        raise ValueError("Fullmag artifact must declare residuals")
    charge = raw.get("charge", raw.get("charge_scaled_l2"))
    spin = raw.get("spin", raw.get("spin_scaled_l2"))
    return {"charge": _finite(charge, label="residuals.charge"), "spin": _finite(spin, label="residuals.spin")}


def _interface_balances(payload: Mapping[str, Any], module: Mapping[str, Any]) -> dict[str, object]:
    raw = payload.get("interface_balances")
    if raw is None:
        raw = module.get("interface_balances")
    if not isinstance(raw, dict):
        raise ValueError("Fullmag artifact must declare interface_balances")
    absorbed = raw.get("absorbed_spin_flux", raw.get("absorbed_transverse_apm2"))
    if absorbed is None:
        raise ValueError("Fullmag interface_balances is missing absorbed_spin_flux")
    torque = raw.get("torque")
    if torque is None:
        raise ValueError("Fullmag interface_balances is missing torque")
    result: dict[str, object] = {
        "absorbed_spin_flux": list(_vector(absorbed, label="interface_balances.absorbed_spin_flux")),
        "torque": list(_vector(torque, label="interface_balances.torque")),
        "charge_closure": _finite(
            raw.get("charge_closure", 0.0), label="interface_balances.charge_closure"
        ),
    }
    for key in ("normal_spin_flux", "ferromagnet_spin_flux", "spin_torque_closure"):
        if key in raw:
            value = raw[key]
            result[key] = (
                list(_vector(value, label=f"interface_balances.{key}"))
                if key.endswith("flux")
                else _finite(value, label=f"interface_balances.{key}")
            )
    return result


@dataclass(frozen=True)
class NormalizedTransportArtifact:
    source: str
    shape: tuple[int, int, int]
    origin_m: Vector3
    step_m: Vector3
    potential_v: tuple[float, ...]
    mu_s_v: tuple[Vector3, ...]
    charge_current_apm2: tuple[Vector3, ...]
    spin_current_qia_apm2: tuple[Tensor9, ...]
    torque_per_s: tuple[Vector3, ...]
    residuals: Mapping[str, float]
    interface_balances: Mapping[str, object]
    formula_version: str
    normal_axis: str
    normal_sign: int
    conventions: Mapping[str, object]

    def __post_init__(self) -> None:
        if len(self.shape) != 3 or any(size < 1 for size in self.shape):
            raise ValueError("normalized artifact shape must be positive")
        count = _count(self.shape)
        if len(self.potential_v) != count:
            raise ValueError("normalized potential field has the wrong cell count")
        for name, field in (
            ("mu_s_v", self.mu_s_v),
            ("charge_current_apm2", self.charge_current_apm2),
            ("spin_current_qia_apm2", self.spin_current_qia_apm2),
            ("torque_per_s", self.torque_per_s),
        ):
            if len(field) != count:
                raise ValueError(f"normalized {name} field has the wrong cell count")
        if self.normal_axis not in {"x", "y", "z"}:
            raise ValueError("normalized artifact normal_axis must be x, y, or z")
        if self.normal_sign not in {-1, 1}:
            raise ValueError("normalized artifact normal_sign must be +1 or -1")
        if not self.formula_version.strip():
            raise ValueError("normalized artifact formula_version is required")
        for name, value in (("origin_m", self.origin_m), ("step_m", self.step_m)):
            if len(value) != 3 or not all(math.isfinite(float(item)) for item in value):
                raise ValueError(f"normalized {name} must be finite and three-dimensional")
        if any(float(item) <= 0.0 for item in self.step_m):
            raise ValueError("normalized step_m must be positive")
        for value in self.potential_v:
            _finite(value, label="normalized potential_v")
        for field_name, field in (
            ("mu_s_v", self.mu_s_v),
            ("charge_current_apm2", self.charge_current_apm2),
            ("torque_per_s", self.torque_per_s),
        ):
            for index, vector in enumerate(field):
                _vector(vector, label=f"normalized {field_name}[{index}]")
        for index, tensor in enumerate(self.spin_current_qia_apm2):
            _tensor(tensor, label=f"normalized spin_current_qia_apm2[{index}]")
        for key in ("charge", "spin"):
            _finite(self.residuals.get(key), label=f"normalized residuals.{key}")
        if self.conventions.get("component_order") != "row_major_Q_ia":
            raise ValueError("normalized artifact must declare component_order=row_major_Q_ia")


def _fullmag_module(payload: Mapping[str, Any]) -> Mapping[str, Any]:
    evaluation = payload.get("evaluation")
    if isinstance(evaluation, dict):
        modules = evaluation.get("modules")
        if isinstance(modules, list) and len(modules) == 1 and isinstance(modules[0], dict):
            return modules[0]
    return payload


def load_fullmag_m2_artifact(path: Path) -> NormalizedTransportArtifact:
    """Load the explicit, cell-wise FDM M2 transport artifact contract."""

    payload = _json_object(path)
    if payload.get("schema") != "fullmag.fdm.spin_transport.accepted.v1":
        raise ValueError("Fullmag artifact schema is unsupported")
    shape, origin, step = _mesh_metadata(payload)
    component_order = payload.get("component_order")
    if component_order != "row_major_Q_ia":
        raise ValueError("Fullmag artifact component_order must be row_major_Q_ia")
    module = _fullmag_module(payload)
    formula_version = payload.get("formula_version")
    if not isinstance(formula_version, str) or not formula_version.strip():
        formula_version = module.get("torque_formula_version")
    if not isinstance(formula_version, str) or not formula_version.strip():
        raise ValueError("Fullmag artifact formula_version is required")
    normal_axis = payload.get("normal_axis", "z")
    normal_sign = payload.get("normal_sign", 1)
    if not isinstance(normal_axis, str) or not isinstance(normal_sign, int) or isinstance(normal_sign, bool):
        raise ValueError("Fullmag artifact normal orientation is invalid")
    count = _count(shape)
    potential = _scalar_field(_field(payload, module, "potential_volts"), label="potential_volts", count=count)
    mu_s = _vector_field(_field(payload, module, "spin_potential_volts"), label="spin_potential_volts", count=count)
    charge = _vector_field(_field(payload, module, "current_density_apm2"), label="current_density_apm2", count=count)
    tensor = _tensor_field(
        _field(payload, module, "spin_current_tensor_apm2"),
        label="spin_current_tensor_apm2",
        count=count,
    )
    torque = _vector_field(
        _field(payload, module, "transport_torque_per_s"), label="transport_torque_per_s", count=count
    )
    conventions = payload.get("conventions", {})
    if not isinstance(conventions, dict):
        raise ValueError("Fullmag artifact conventions must be an object")
    conventions = dict(conventions)
    conventions.setdefault("component_order", component_order)
    conventions.setdefault("mu_s_convention", "full_spin_splitting_voltage")
    conventions.setdefault("torque_unit", "gilbert_source_per_s")
    return NormalizedTransportArtifact(
        source=str(path),
        shape=shape,
        origin_m=origin,
        step_m=step,
        potential_v=potential,
        mu_s_v=mu_s,
        charge_current_apm2=charge,
        spin_current_qia_apm2=tensor,
        torque_per_s=torque,
        residuals=_residuals(payload, module),
        interface_balances=_interface_balances(payload, module),
        formula_version=formula_version,
        normal_axis=normal_axis,
        normal_sign=normal_sign,
        conventions=conventions,
    )


def _boris_field_path(root: Path, entry: object) -> Path:
    if isinstance(entry, str):
        path = root / entry
    elif isinstance(entry, dict) and isinstance(entry.get("path"), str):
        path = root / str(entry["path"])
    else:
        raise ValueError("BORIS field entry must be a relative path")
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError as error:
        raise ValueError("BORIS field path escapes the artifact root") from error
    return path


def _boris_mesh(root: Path, entries: Mapping[str, object], names: Sequence[str]) -> dict[str, Any]:
    result = {name: read_text_ovf(_boris_field_path(root, entries[name])) for name in names}
    if not result:
        raise ValueError("BORIS mesh has no fields")
    first = next(iter(result.values()))
    for name, field in result.items():
        if field.shape != first.shape or field.step_m != first.step_m or field.origin_m != first.origin_m:
            raise ValueError(f"BORIS mesh field {name} has mismatched grid metadata")
    return result


def _concat_scalar(normal: Any, ferromagnet: Any) -> tuple[float, ...]:
    return tuple(row[0] for row in (*normal.values, *ferromagnet.values))


def _concat_vectors(normal: Any, ferromagnet: Any) -> tuple[Vector3, ...]:
    return tuple(tuple(row) for row in (*normal.values, *ferromagnet.values))


def _concat_qia(normal: Mapping[str, Any], ferromagnet: Mapping[str, Any]) -> tuple[Tensor9, ...]:
    result: list[Tensor9] = []
    for index in range(len(normal["Jc"].values) + len(ferromagnet["Jc"].values)):
        mesh = normal if index < len(normal["Jc"].values) else ferromagnet
        local = index if mesh is normal else index - len(normal["Jc"].values)
        components = []
        for flow_axis in range(3):
            components.extend(
                mesh[field].values[local][flow_axis] for field in ("Jsx", "Jsy", "Jsz")
            )
        result.append(_tensor(components, label=f"BORIS Q_ia[{index}]"))
    return tuple(result)


def normalize_boris_artifact(path: Path) -> NormalizedTransportArtifact:
    """Map BORIS N/F OVFs to one contiguous shared-domain representation."""

    root = path if path.is_dir() else path.parent
    payload = validate_boris_artifact(root)
    scenario = payload["scenario"]
    parameters = scenario["parameters"]
    fields = payload["fields"]
    normal_entries = fields["normal"]
    ferromagnet_entries = fields["ferromagnet"]
    if not isinstance(normal_entries, dict) or not isinstance(ferromagnet_entries, dict):
        raise ValueError("BORIS fields.normal and fields.ferromagnet must be objects")
    names = ("V", "S", "Jc", "Jsx", "Jsy", "Jsz")
    normal = _boris_mesh(root, normal_entries, names)
    ferromagnet = _boris_mesh(root, ferromagnet_entries, (*names, "Ts", "Tsi"))
    n_shape = normal["V"].shape
    f_shape = ferromagnet["V"].shape
    if n_shape[:2] != f_shape[:2] or n_shape[2] < 1 or f_shape[2] < 1:
        raise ValueError("BORIS N/F meshes must share in-plane dimensions")
    if normal["V"].step_m != ferromagnet["V"].step_m:
        raise ValueError("BORIS N/F meshes must share cell steps")
    n_top = normal["V"].origin_m[2] + n_shape[2] * normal["V"].step_m[2]
    if not math.isclose(n_top, ferromagnet["V"].origin_m[2], rel_tol=_MESH_REL_TOLERANCE, abs_tol=_MESH_ABS_TOLERANCE):
        raise ValueError("BORIS N/F meshes are not contiguous along the interface normal")
    if any(field.valuedim != (1 if name == "V" else 3) for name, field in normal.items()):
        raise ValueError("BORIS normal fields have unexpected valuedim")
    if any(field.valuedim != (1 if name == "V" else 3) for name, field in ferromagnet.items()):
        raise ValueError("BORIS ferromagnet fields have unexpected valuedim")
    de = _finite(parameters.get("De_m2_per_s"), label="scenario.parameters.De_m2_per_s")
    conductivity = _finite(parameters.get("elC_Spm"), label="scenario.parameters.elC_Spm")
    mapped_spin = map_boris_spin_to_fullmag_mu_s(
        tuple(tuple(row) for row in (*normal["S"].values, *ferromagnet["S"].values)),
        de,
        conductivity,
    )
    torque = tuple((0.0, 0.0, 0.0) for _ in normal["Jc"].values) + tuple(
        tuple(row) for row in ferromagnet["Tsi"].values
    )
    balance = dict(payload["interface_balances"])
    balance["torque_unit"] = "boris_tsi_A_per_m_s"
    balance["torque_comparison_status"] = "not_comparable_without_tsi_eff_gamma_mapping"
    conventions = {
        "component_order": "row_major_Q_ia",
        "mu_s_convention": "full_spin_splitting_voltage",
        "spin_mapping": "mu_s=2*De*S/(elC*MUB_E)",
        "potential_unit": "V",
        "charge_current_unit": "A_per_m2",
        "spin_current_unit": "A_per_m2",
        "torque_unit": "boris_tsi_A_per_m_s",
        "source_spin_quantity": "BORIS_native_S",
    }
    axis = str(balance.get("normal_axis", "z"))
    sign = balance.get("normal_sign", 1)
    if not isinstance(sign, int) or isinstance(sign, bool):
        raise ValueError("BORIS interface normal_sign must be an integer")
    shape = (n_shape[0], n_shape[1], n_shape[2] + f_shape[2])
    return NormalizedTransportArtifact(
        source=str(path),
        shape=shape,
        origin_m=normal["V"].origin_m,
        step_m=normal["V"].step_m,
        potential_v=_concat_scalar(normal["V"], ferromagnet["V"]),
        mu_s_v=tuple(mapped_spin),
        charge_current_apm2=_concat_vectors(normal["Jc"], ferromagnet["Jc"]),
        spin_current_qia_apm2=_concat_qia(normal, ferromagnet),
        torque_per_s=torque,
        residuals={
            "charge": _finite(payload["residuals"]["charge_scaled_l2"], label="BORIS charge residual"),
            "spin": _finite(payload["residuals"]["spin_scaled_l2"], label="BORIS spin residual"),
        },
        interface_balances=balance,
        formula_version="boris.she.transport.v4",
        normal_axis=axis,
        normal_sign=sign,
        conventions=conventions,
    )


def _flatten(value: object) -> tuple[float, ...]:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return (_finite(value, label="metric value"),)
    if isinstance(value, (list, tuple)):
        result: list[float] = []
        for item in value:
            result.extend(_flatten(item))
        return tuple(result)
    raise ValueError("observable values must be numeric or nested numeric sequences")


def _metric(left: object, right: object) -> dict[str, float]:
    a = _flatten(left)
    b = _flatten(right)
    if len(a) != len(b):
        raise ValueError("incomparable: observable lengths differ")
    if not a:
        raise ValueError("incomparable: observable is empty")
    deltas = [abs(x - y) for x, y in zip(a, b)]
    relatives = [delta / max(abs(x), abs(y), 1.0e-300) for delta, x, y in zip(deltas, a, b)]
    denominator = max(
        math.sqrt(sum(max(abs(x), abs(y), 1.0e-300) ** 2 for x, y in zip(a, b))),
        1.0e-300,
    )
    normalized_l2 = math.sqrt(sum(delta * delta for delta in deltas)) / denominator
    endpoints = (0, len(a) - 1) if len(a) > 1 else (0,)
    return {
        "max_absolute_error": max(deltas),
        "max_relative_error": max(relatives),
        "normalized_l2_error": normalized_l2,
        "endpoint_error": max(relatives[index] for index in endpoints),
    }


def _interface_value(artifact: NormalizedTransportArtifact, key: str) -> object:
    if key not in artifact.interface_balances:
        raise ValueError(f"incomparable: interface balance is missing {key}")
    return artifact.interface_balances[key]


def _gauge_aligned_potential(
    boris: NormalizedTransportArtifact, fullmag: NormalizedTransportArtifact
) -> tuple[dict[str, float], float]:
    offset = sum(
        boris_value - fullmag_value
        for boris_value, fullmag_value in zip(boris.potential_v, fullmag.potential_v)
    ) / len(boris.potential_v)
    aligned_fullmag = tuple(value + offset for value in fullmag.potential_v)
    return _metric(boris.potential_v, aligned_fullmag), offset


def _compatible_conventions(
    boris: NormalizedTransportArtifact, fullmag: NormalizedTransportArtifact
) -> str | None:
    if boris.conventions.get("component_order") != fullmag.conventions.get("component_order"):
        raise ValueError("incomparable: spin-current component order differs")
    for key in ("potential_unit", "charge_current_unit", "spin_current_unit", "mu_s_convention"):
        left = boris.conventions.get(key)
        right = fullmag.conventions.get(key)
        if left is not None and right is not None and left != right:
            raise ValueError(f"incomparable: convention {key} differs")
    left_torque = boris.conventions.get("torque_unit")
    right_torque = fullmag.conventions.get("torque_unit")
    if left_torque != right_torque:
        return (
            "torque units differ; reconcile BORIS Tsi/tsi_eff/gamma "
            "before comparing torque observables"
        )
    return None


def compare_transport_artifacts(
    boris: NormalizedTransportArtifact, fullmag: NormalizedTransportArtifact
) -> dict[str, object]:
    """Compare two normalized artifacts without making a qualification claim."""

    if boris.shape != fullmag.shape:
        raise ValueError("incomparable: mesh shape differs")
    if boris.normal_axis != fullmag.normal_axis or boris.normal_sign != fullmag.normal_sign:
        raise ValueError("incomparable: interface normal orientation differs")
    for label, left, right in (("step", boris.step_m, fullmag.step_m),):
        if any(
            not math.isclose(a, b, rel_tol=_MESH_REL_TOLERANCE, abs_tol=_MESH_ABS_TOLERANCE)
            for a, b in zip(left, right)
        ):
            raise ValueError(f"incomparable: mesh {label} differs")
    translation = [
        fullmag.origin_m[index] - boris.origin_m[index] for index in range(3)
    ]
    torque_issue = _compatible_conventions(boris, fullmag)
    potential_metric, potential_offset = _gauge_aligned_potential(boris, fullmag)
    observables = {
        "potential_v": potential_metric,
        "mu_s": _metric(boris.mu_s_v, fullmag.mu_s_v),
        "charge_current": _metric(boris.charge_current_apm2, fullmag.charge_current_apm2),
        "spin_current_qia": _metric(boris.spin_current_qia_apm2, fullmag.spin_current_qia_apm2),
        "interface_absorbed_spin_flux": _metric(
            _interface_value(boris, "absorbed_spin_flux"),
            _interface_value(fullmag, "absorbed_spin_flux"),
        ),
        "charge_residual": _metric(boris.residuals["charge"], fullmag.residuals["charge"]),
        "spin_residual": _metric(boris.residuals["spin"], fullmag.residuals["spin"]),
    }
    incomparable_observables: dict[str, object] = {}
    if torque_issue is None:
        observables["torque_per_s"] = _metric(boris.torque_per_s, fullmag.torque_per_s)
        observables["interface_torque"] = _metric(
            _interface_value(boris, "torque"), _interface_value(fullmag, "torque")
        )
    else:
        for name in ("torque_per_s", "interface_torque"):
            incomparable_observables[name] = {"status": "incomparable", "reason": torque_issue}
    status = (
        "incomparable"
        if incomparable_observables
        else (
            "diagnostic_match"
            if all(metric["max_relative_error"] <= _MATCH_TOLERANCE for metric in observables.values())
            else "diagnostic_mismatch"
        )
    )
    return {
        "schema_version": "fullmag.boris_fullmag_she_nf_comparison.v1",
        "status": status,
        "qualification": {
            "status": "diagnostic",
            "reason": "normalized field comparison; no production or solver-equivalence claim",
        },
        "mesh": {
            "shape": list(boris.shape),
            "origin_m": list(boris.origin_m),
            "fullmag_origin_m": list(fullmag.origin_m),
            "translation_fullmag_minus_boris_m": translation,
            "step_m": list(boris.step_m),
        },
        "normal_orientation": {"axis": boris.normal_axis, "sign": boris.normal_sign},
        "gauge_alignment": {
            "mode": "constant_offset_mean",
            "fullmag_added_offset_V": potential_offset,
            "meaning": "charge potential is compared modulo its arbitrary additive gauge",
        },
        "formula_versions": {"boris": boris.formula_version, "fullmag": fullmag.formula_version},
        "conventions": {"boris": dict(boris.conventions), "fullmag": dict(fullmag.conventions)},
        "observables": observables,
        "incomparable_observables": incomparable_observables,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--boris", type=Path, required=True, help="BORIS summary.json or artifact directory")
    parser.add_argument("--fullmag", type=Path, required=True, help="Fullmag FDM M2 JSON artifact")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    boris = normalize_boris_artifact(args.boris)
    fullmag = load_fullmag_m2_artifact(args.fullmag)
    report = compare_transport_artifacts(boris, fullmag)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"status": report["status"], "output": str(args.output)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
