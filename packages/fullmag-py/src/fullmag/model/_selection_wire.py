from __future__ import annotations

from dataclasses import dataclass
import math
from numbers import Real
from typing import Mapping, Sequence


_SCHEMA_VERSION = "selection_expr.v1"
_COMPONENTS = {"x", "y", "z"}
_COMPARISON_OPERATORS = {"lt", "le", "gt", "ge"}
_CLOSED_INTERVALS = {"none", "left", "right", "both"}


def _real(value: object, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, Real):
        raise TypeError(f"{field} must be a finite real number")
    normalized = float(value)
    if not math.isfinite(normalized):
        raise ValueError(f"{field} must be finite")
    return normalized


def _non_empty(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise TypeError(f"{field} must be a non-empty string")
    return value.strip()


def _vector(value: object, length: int, field: str) -> tuple[float, ...]:
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence):
        raise TypeError(f"{field} must be a sequence of {length} finite real numbers")
    if len(value) != length:
        raise ValueError(f"{field} must contain exactly {length} values")
    return tuple(
        _real(component, f"{field}[{index}]") for index, component in enumerate(value)
    )


def _unit_vector3(value: object, field: str) -> tuple[float, float, float]:
    vector = _vector(value, 3, field)
    largest = max(abs(component) for component in vector)
    if largest == 0.0:
        raise ValueError(f"{field} must be a non-zero finite vector")
    norm = math.sqrt(sum((component / largest) ** 2 for component in vector))
    return tuple(component / largest / norm for component in vector)  # type: ignore[return-value]


def _object_id(value: object) -> str:
    if isinstance(value, str):
        return _non_empty(value, "object_id")
    candidate = getattr(value, "object_id", None)
    return _non_empty(candidate, "object_id")


def _region_id(value: object) -> str:
    if isinstance(value, str):
        return _non_empty(value, "region_id")
    return _non_empty(getattr(value, "region_id", None), "region_id")


@dataclass(frozen=True, slots=True)
class _ScalarExpr:
    kind: str
    fields: tuple[tuple[str, object], ...] = ()

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": self.kind,
            **{key: _serialize(value) for key, value in self.fields},
        }


@dataclass(frozen=True, slots=True)
class _SelectionExpr:
    kind: str
    fields: tuple[tuple[str, object], ...] = ()

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": self.kind,
            **{key: _serialize(value) for key, value in self.fields},
        }


@dataclass(frozen=True, slots=True)
class _GeometryExpr:
    kind: str
    fields: tuple[tuple[str, object], ...] = ()

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": self.kind,
            **{key: _serialize(value) for key, value in self.fields},
        }


@dataclass(frozen=True, slots=True)
class _ParsedSelectionDefinition:
    selection_id: str
    name: str | None
    expression: _SelectionExpr


def _serialize(value: object) -> object:
    if isinstance(value, (_SelectionExpr, _ScalarExpr, _GeometryExpr)):
        return value.to_ir()
    if isinstance(value, tuple):
        return [_serialize(child) for child in value]
    if isinstance(value, list):
        return [_serialize(child) for child in value]
    if isinstance(value, Mapping):
        return {key: _serialize(child) for key, child in value.items()}
    return value


def _ir_mapping(value: object, field: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise TypeError(f"{field} must be a mapping")
    if any(not isinstance(key, str) for key in value):
        raise ValueError(f"{field} keys must be strings")
    return value


def _ir_fields(
    value: Mapping[str, object],
    required: set[str],
    field: str,
    *,
    optional: set[str] | None = None,
) -> None:
    optional = optional or set()
    actual = set(value)
    unknown = actual - required - optional
    missing = required - actual
    if unknown:
        raise ValueError(f"{field} has unknown fields: {', '.join(sorted(unknown))}")
    if missing:
        raise ValueError(f"{field} is missing fields: {', '.join(sorted(missing))}")


def _parse_frame(value: object, field: str) -> dict[str, object]:
    node = _ir_mapping(value, field)
    kind = node.get("kind")
    if kind == "world":
        _ir_fields(node, {"kind"}, field)
        return {"kind": "world"}
    if kind == "object":
        _ir_fields(node, {"kind", "object_id"}, field)
        return {
            "kind": "object",
            "object_id": _non_empty(node["object_id"], f"{field}.object_id"),
        }
    raise ValueError(f"{field} has unknown kind {kind!r}")


def _parse_boundary(value: object, field: str) -> dict[str, object]:
    node = _ir_mapping(value, field)
    _ir_fields(
        node,
        {"kind", "absolute_tolerance_m", "relative_tolerance"},
        field,
    )
    kind = node["kind"]
    if kind not in {"inclusive", "exclusive"}:
        raise ValueError(f"{field}.kind must be 'inclusive' or 'exclusive'")
    absolute = _real(node["absolute_tolerance_m"], f"{field}.absolute_tolerance_m")
    relative = _real(node["relative_tolerance"], f"{field}.relative_tolerance")
    if absolute < 0.0 or relative < 0.0:
        raise ValueError(f"{field} tolerances must be non-negative")
    return {
        "kind": kind,
        "absolute_tolerance_m": absolute,
        "relative_tolerance": relative,
    }


def _parse_geometry_expr(value: object, field: str) -> _GeometryExpr:
    node = _ir_mapping(value, field)
    kind = node.get("kind")
    if kind == "box":
        _ir_fields(node, {"kind", "center_m", "size_m"}, field)
        center = _vector(node["center_m"], 3, f"{field}.center_m")
        size = _vector(node["size_m"], 3, f"{field}.size_m")
        if any(component <= 0.0 for component in size):
            raise ValueError(f"{field}.size_m must contain positive values")
        return _GeometryExpr(kind, (("center_m", center), ("size_m", size)))
    if kind == "cylinder":
        _ir_fields(node, {"kind", "center_m", "axis", "radius_m", "height_m"}, field)
        radius = _real(node["radius_m"], f"{field}.radius_m")
        height = _real(node["height_m"], f"{field}.height_m")
        if radius <= 0.0 or height <= 0.0:
            raise ValueError(f"{field} radius_m and height_m must be positive")
        return _GeometryExpr(
            kind,
            (
                ("center_m", _vector(node["center_m"], 3, f"{field}.center_m")),
                ("axis", _unit_vector3(node["axis"], f"{field}.axis")),
                ("radius_m", radius),
                ("height_m", height),
            ),
        )
    if kind == "sphere":
        _ir_fields(node, {"kind", "center_m", "radius_m"}, field)
        radius = _real(node["radius_m"], f"{field}.radius_m")
        if radius <= 0.0:
            raise ValueError(f"{field}.radius_m must be positive")
        return _GeometryExpr(
            kind,
            (
                ("center_m", _vector(node["center_m"], 3, f"{field}.center_m")),
                ("radius_m", radius),
            ),
        )
    if kind == "ellipsoid":
        _ir_fields(node, {"kind", "center_m", "radii_m"}, field)
        radii = _vector(node["radii_m"], 3, f"{field}.radii_m")
        if any(radius <= 0.0 for radius in radii):
            raise ValueError(f"{field}.radii_m must contain positive values")
        return _GeometryExpr(
            kind,
            (
                ("center_m", _vector(node["center_m"], 3, f"{field}.center_m")),
                ("radii_m", radii),
            ),
        )
    if kind in {"union", "intersection", "xor"}:
        _ir_fields(node, {"kind", "a", "b"}, field)
        return _GeometryExpr(
            kind,
            (
                ("a", _parse_geometry_expr(node["a"], f"{field}.a")),
                ("b", _parse_geometry_expr(node["b"], f"{field}.b")),
            ),
        )
    if kind == "difference":
        _ir_fields(node, {"kind", "base", "tool"}, field)
        return _GeometryExpr(
            kind,
            (
                ("base", _parse_geometry_expr(node["base"], f"{field}.base")),
                ("tool", _parse_geometry_expr(node["tool"], f"{field}.tool")),
            ),
        )
    if kind == "complement":
        _ir_fields(node, {"kind", "geometry", "domain"}, field)
        return _GeometryExpr(
            kind,
            (
                (
                    "geometry",
                    _parse_geometry_expr(node["geometry"], f"{field}.geometry"),
                ),
                ("domain", _parse_geometry_expr(node["domain"], f"{field}.domain")),
            ),
        )
    if kind == "affine":
        _ir_fields(
            node,
            {"kind", "geometry", "translation_m", "rotation_xyzw", "scale", "pivot_m"},
            field,
        )
        scale = _vector(node["scale"], 3, f"{field}.scale")
        if any(component == 0.0 for component in scale):
            raise ValueError(f"{field}.scale must be invertible")
        return _GeometryExpr(
            kind,
            (
                (
                    "geometry",
                    _parse_geometry_expr(node["geometry"], f"{field}.geometry"),
                ),
                (
                    "translation_m",
                    _vector(node["translation_m"], 3, f"{field}.translation_m"),
                ),
                (
                    "rotation_xyzw",
                    _unit_vector(node["rotation_xyzw"], 4, f"{field}.rotation_xyzw"),
                ),
                ("scale", scale),
                ("pivot_m", _vector(node["pivot_m"], 3, f"{field}.pivot_m")),
            ),
        )
    if kind == "imported_solid":
        _ir_fields(node, {"kind", "asset_id"}, field)
        return _GeometryExpr(
            kind, (("asset_id", _non_empty(node["asset_id"], f"{field}.asset_id")),)
        )
    raise ValueError(f"{field} has unknown kind {kind!r}")


def _unit_vector(value: object, length: int, field: str) -> tuple[float, ...]:
    vector = _vector(value, length, field)
    largest = max(abs(component) for component in vector)
    if largest == 0.0:
        raise ValueError(f"{field} must be a non-zero finite vector")
    norm = math.sqrt(sum((component / largest) ** 2 for component in vector))
    return tuple(component / largest / norm for component in vector)


def _parse_scalar_expr(value: object, field: str) -> _ScalarExpr:
    node = _ir_mapping(value, field)
    kind = node.get("kind")
    if kind == "constant":
        _ir_fields(node, {"kind", "value"}, field)
        return _ScalarExpr(kind, (("value", _real(node["value"], f"{field}.value")),))
    if kind == "coordinate":
        _ir_fields(node, {"kind", "component", "frame"}, field)
        component = _non_empty(node["component"], f"{field}.component")
        if component not in _COMPONENTS:
            raise ValueError(f"{field}.component must be x, y, or z")
        return _ScalarExpr(
            kind,
            (
                ("component", component),
                ("frame", _parse_frame(node["frame"], f"{field}.frame")),
            ),
        )
    if kind == "magnetization_component":
        _ir_fields(node, {"kind", "component"}, field)
        component = _non_empty(node["component"], f"{field}.component")
        if component not in _COMPONENTS:
            raise ValueError(f"{field}.component must be x, y, or z")
        return _ScalarExpr(kind, (("component", component),))
    if kind == "magnetization_norm":
        _ir_fields(node, {"kind"}, field)
        return _ScalarExpr(kind)
    if kind == "magnetization_dot":
        _ir_fields(node, {"kind", "axis"}, field)
        return _ScalarExpr(
            kind, (("axis", _unit_vector3(node["axis"], f"{field}.axis")),)
        )
    if kind == "abs":
        _ir_fields(node, {"kind", "value"}, field)
        return _ScalarExpr(
            kind, (("value", _parse_scalar_expr(node["value"], f"{field}.value")),)
        )
    raise ValueError(f"{field} has unknown kind {kind!r}")


def _parse_selection_expr(value: object, field: str) -> _SelectionExpr:
    node = _ir_mapping(value, field)
    kind = node.get("kind")
    if kind == "all_magnetic":
        _ir_fields(node, {"kind"}, field)
        return _SelectionExpr(kind)
    if kind == "in_object":
        _ir_fields(node, {"kind", "object_id"}, field)
        return _SelectionExpr(
            kind, (("object_id", _non_empty(node["object_id"], f"{field}.object_id")),)
        )
    if kind == "in_region":
        _ir_fields(node, {"kind", "object_id", "region_id"}, field)
        return _SelectionExpr(
            kind,
            (
                ("object_id", _non_empty(node["object_id"], f"{field}.object_id")),
                ("region_id", _non_empty(node["region_id"], f"{field}.region_id")),
            ),
        )
    if kind == "inside_geometry":
        _ir_fields(node, {"kind", "geometry", "frame", "sampling", "boundary"}, field)
        sampling = _ir_mapping(node["sampling"], f"{field}.sampling")
        _ir_fields(sampling, {"kind"}, f"{field}.sampling")
        if sampling["kind"] != "dof_point":
            raise ValueError(f"{field}.sampling.kind must be 'dof_point'")
        return _SelectionExpr(
            kind,
            (
                (
                    "geometry",
                    _parse_geometry_expr(node["geometry"], f"{field}.geometry"),
                ),
                ("frame", _parse_frame(node["frame"], f"{field}.frame")),
                ("sampling", {"kind": "dof_point"}),
                ("boundary", _parse_boundary(node["boundary"], f"{field}.boundary")),
            ),
        )
    if kind == "compare":
        _ir_fields(node, {"kind", "lhs", "op", "rhs"}, field, optional={"tolerance"})
        op = node["op"]
        if op not in _COMPARISON_OPERATORS:
            raise ValueError(f"{field}.op must be lt, le, gt, or ge")
        fields: list[tuple[str, object]] = [
            ("lhs", _parse_scalar_expr(node["lhs"], f"{field}.lhs")),
            ("op", op),
            ("rhs", _parse_scalar_expr(node["rhs"], f"{field}.rhs")),
        ]
        if "tolerance" in node:
            tolerance = _ir_mapping(node["tolerance"], f"{field}.tolerance")
            _ir_fields(
                tolerance, set(), f"{field}.tolerance", optional={"atol", "rtol"}
            )
            atol = _real(tolerance.get("atol", 0.0), f"{field}.tolerance.atol")
            rtol = _real(tolerance.get("rtol", 0.0), f"{field}.tolerance.rtol")
            if atol < 0.0 or rtol < 0.0:
                raise ValueError(f"{field}.tolerance values must be non-negative")
            if atol != 0.0 or rtol != 0.0:
                fields.append(("tolerance", {"atol": atol, "rtol": rtol}))
        return _SelectionExpr(kind, tuple(fields))
    if kind == "approx":
        _ir_fields(node, {"kind", "value", "target", "atol", "rtol"}, field)
        atol = _real(node["atol"], f"{field}.atol")
        rtol = _real(node["rtol"], f"{field}.rtol")
        if atol < 0.0 or rtol < 0.0 or (atol == 0.0 and rtol == 0.0):
            raise ValueError(
                f"{field} requires non-negative tolerances and one positive tolerance"
            )
        return _SelectionExpr(
            kind,
            (
                ("value", _parse_scalar_expr(node["value"], f"{field}.value")),
                ("target", _parse_scalar_expr(node["target"], f"{field}.target")),
                ("atol", atol),
                ("rtol", rtol),
            ),
        )
    if kind == "between":
        _ir_fields(node, {"kind", "value", "lower", "upper", "closed"}, field)
        lower = _real(node["lower"], f"{field}.lower")
        upper = _real(node["upper"], f"{field}.upper")
        closed = node["closed"]
        if lower > upper:
            raise ValueError(f"{field}.lower must be <= upper")
        if closed not in _CLOSED_INTERVALS:
            raise ValueError(f"{field}.closed has an unknown value")
        return _SelectionExpr(
            kind,
            (
                ("value", _parse_scalar_expr(node["value"], f"{field}.value")),
                ("lower", lower),
                ("upper", upper),
                ("closed", closed),
            ),
        )
    if kind in {"and", "or", "xor"}:
        _ir_fields(node, {"kind", "expressions"}, field)
        raw = node["expressions"]
        if isinstance(raw, (str, bytes)) or not isinstance(raw, Sequence):
            raise TypeError(f"{field}.expressions must be a sequence")
        children = [
            _parse_selection_expr(child, f"{field}.expressions[{index}]")
            for index, child in enumerate(raw)
        ]
        if not children or (kind == "xor" and len(children) < 2):
            raise ValueError(f"{field}.expressions has invalid cardinality")
        flattened: list[_SelectionExpr] = []
        for child in children:
            if child.kind == kind:
                flattened.extend(dict(child.fields)["expressions"])  # type: ignore[arg-type]
            else:
                flattened.append(child)
        return _SelectionExpr(kind, (("expressions", tuple(flattened)),))
    if kind == "not":
        _ir_fields(node, {"kind", "expression"}, field)
        return _SelectionExpr(
            kind,
            (
                (
                    "expression",
                    _parse_selection_expr(node["expression"], f"{field}.expression"),
                ),
            ),
        )
    if kind == "ref":
        _ir_fields(node, {"kind", "selection_id"}, field)
        return _SelectionExpr(
            kind,
            (
                (
                    "selection_id",
                    _non_empty(node["selection_id"], f"{field}.selection_id"),
                ),
            ),
        )
    raise ValueError(f"{field} has unknown kind {kind!r}")


def _parse_definition_ir(value: object, field: str) -> _ParsedSelectionDefinition:
    node = _ir_mapping(value, field)
    _ir_fields(node, {"schema_version", "id", "expression"}, field, optional={"name"})
    selection_id = _non_empty(node["id"], f"{field}.id")
    if node["schema_version"] != _SCHEMA_VERSION:
        raise ValueError(f"{field}.schema_version must be {_SCHEMA_VERSION!r}")
    name = None if "name" not in node else _non_empty(node["name"], f"{field}.name")
    return _ParsedSelectionDefinition(
        selection_id,
        name,
        _parse_selection_expr(node["expression"], f"{field}.expression"),
    )
