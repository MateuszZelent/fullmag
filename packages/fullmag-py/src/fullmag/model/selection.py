from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
import json
import math
from typing import Mapping, Sequence

from ._selection_validation import (
    _canonical_selection_sha256,
    _validate_definition_graph as _validate_definition_graph,
)
from ._selection_wire import (
    _CLOSED_INTERVALS,
    _COMPARISON_OPERATORS,
    _COMPONENTS,
    _GeometryExpr,
    _ScalarExpr,
    _SCHEMA_VERSION,
    _SelectionExpr,
    _non_empty,
    _object_id,
    _parse_definition_ir,
    _parse_geometry_expr,
    _parse_scalar_expr,
    _parse_selection_expr,
    _real,
    _region_id,
    _unit_vector3,
    _vector,
)
from .geometry import (
    AuthoredSelectionAffine,
    Box,
    Cylinder,
    Difference,
    Ellipsoid,
    Intersection,
    SelectionAffine,
    SelectionCylinder,
    SelectionThroughObjectDisk,
    Translate,
    Union,
)


def _selection_expr(kind: str, **fields: object) -> _SelectionExpr:
    return _SelectionExpr(kind, tuple(fields.items()))


def _scalar_expr(kind: str, **fields: object) -> _ScalarExpr:
    return _ScalarExpr(kind, tuple(fields.items()))


class SelectionGeometry:
    """Typed canonical ``geometry_predicate.v1`` node."""

    __slots__ = ("_expression",)

    def __init__(self, expression: object) -> None:
        if type(expression) is not _GeometryExpr:
            raise TypeError("expression must be a typed selection geometry expression")
        self._expression = expression

    @classmethod
    def from_ir(cls, value: object) -> "SelectionGeometry":
        return cls(_parse_geometry_expr(value, "selection geometry"))

    def to_ir(self) -> dict[str, object]:
        return self._expression.to_ir()


class SelectionScalar:
    """Typed scalar expression used only inside a selection predicate."""

    __slots__ = ("_expression",)

    def __init__(self, expression: object) -> None:
        if type(expression) is not _ScalarExpr:
            raise TypeError("expression must be a typed selection scalar expression")
        self._expression = expression

    def _compare(self, op: str, other: object) -> "Selection":
        if op not in _COMPARISON_OPERATORS:
            raise ValueError(f"unsupported comparison operator {op!r}")
        rhs = (
            other
            if isinstance(other, SelectionScalar)
            else SelectionScalar.constant(other)
        )
        return Selection._from_expr(
            _selection_expr(
                "compare",
                lhs=self._expression,
                op=op,
                rhs=rhs._expression,
            )
        )

    @classmethod
    def constant(cls, value: object) -> "SelectionScalar":
        return cls(_scalar_expr("constant", value=_real(value, "selection constant")))

    @classmethod
    def from_ir(cls, value: object) -> "SelectionScalar":
        return cls(_parse_scalar_expr(value, "selection scalar"))

    def to_ir(self) -> dict[str, object]:
        return self._expression.to_ir()

    def __lt__(self, other: object) -> "Selection":
        return self._compare("lt", other)

    def __le__(self, other: object) -> "Selection":
        return self._compare("le", other)

    def __gt__(self, other: object) -> "Selection":
        return self._compare("gt", other)

    def __ge__(self, other: object) -> "Selection":
        return self._compare("ge", other)

    def __eq__(self, other: object) -> bool:
        raise TypeError(
            "selection scalar equality is not supported; use approx(atol=..., rtol=...)"
        )

    def __ne__(self, other: object) -> bool:
        raise TypeError("selection scalar inequality is not supported")

    def __abs__(self) -> "SelectionScalar":
        return SelectionScalar(_scalar_expr("abs", value=self._expression))

    def approx(
        self, target: object, *, atol: float = 0.0, rtol: float = 0.0
    ) -> "Selection":
        absolute = _real(atol, "atol")
        relative = _real(rtol, "rtol")
        if absolute < 0.0 or relative < 0.0 or (absolute == 0.0 and relative == 0.0):
            raise ValueError(
                "approx requires non-negative tolerances and at least one positive tolerance"
            )
        target_scalar = (
            target
            if isinstance(target, SelectionScalar)
            else SelectionScalar.constant(target)
        )
        return Selection._from_expr(
            _selection_expr(
                "approx",
                value=self._expression,
                target=target_scalar._expression,
                atol=absolute,
                rtol=relative,
            )
        )


class Selection:
    """Immutable, closed selection-expression AST."""

    __slots__ = ("_expression",)

    def __init__(self, expression: object) -> None:
        if type(expression) is not _SelectionExpr:
            raise TypeError("expression must be a typed selection expression")
        self._expression = expression

    @classmethod
    def _from_expr(cls, expression: _SelectionExpr) -> "Selection":
        return cls(expression)

    @classmethod
    def from_ir(cls, value: object) -> "Selection":
        return cls(_parse_selection_expr(value, "selection expression"))

    def to_ir(self) -> dict[str, object]:
        return self._expression.to_ir()

    def sha256(self) -> str:
        payload = json.dumps(
            self.to_ir(), sort_keys=True, separators=(",", ":"), allow_nan=False
        )
        return sha256(payload.encode("utf-8")).hexdigest()

    @property
    def selection_id(self) -> str:
        return f"selection_{self.sha256()[:16]}"

    def definition(
        self,
        *,
        selection_id: str | None = None,
        name: str | None = None,
    ) -> dict[str, object]:
        payload: dict[str, object] = {
            "schema_version": _SCHEMA_VERSION,
            "id": self.selection_id
            if selection_id is None
            else _non_empty(selection_id, "selection_id"),
        }
        if name is not None:
            payload["name"] = _non_empty(name, "name")
        payload["expression"] = self.to_ir()
        return payload

    def typed_definition(
        self,
        *,
        selection_id: str | None = None,
        name: str | None = None,
    ) -> "SelectionDefinition":
        return SelectionDefinition(
            selection_id=self.selection_id if selection_id is None else selection_id,
            expression=self,
            name=name,
        )

    def ref(self, selection_id: str | None = None) -> "Selection":
        resolved = (
            self.selection_id
            if selection_id is None
            else _non_empty(selection_id, "selection_id")
        )
        return Selection._from_expr(_selection_expr("ref", selection_id=resolved))

    def _combine(self, kind: str, other: object) -> "Selection":
        if not isinstance(other, Selection):
            raise TypeError("boolean selection operators require another Selection")
        expressions: list[_SelectionExpr] = []
        for expression in (self._expression, other._expression):
            fields = dict(expression.fields)
            if expression.kind == kind:
                expressions.extend(fields["expressions"])  # type: ignore[arg-type]
            else:
                expressions.append(expression)
        return Selection._from_expr(
            _selection_expr(kind, expressions=tuple(expressions))
        )

    def __and__(self, other: object) -> "Selection":
        return self._combine("and", other)

    def __or__(self, other: object) -> "Selection":
        return self._combine("or", other)

    def __xor__(self, other: object) -> "Selection":
        return self._combine("xor", other)

    def __invert__(self) -> "Selection":
        return Selection._from_expr(_selection_expr("not", expression=self._expression))


@dataclass(frozen=True, slots=True)
class SelectionDefinition:
    """Typed named selection with canonical ``selection_expr.v1`` serialization."""

    selection_id: str
    expression: Selection
    name: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "selection_id", _non_empty(self.selection_id, "selection_id")
        )
        if type(self.expression) is not Selection:
            raise TypeError("expression must be a Selection")
        if self.name is not None:
            object.__setattr__(self, "name", _non_empty(self.name, "name"))

    @classmethod
    def from_ir(cls, value: object) -> "SelectionDefinition":
        parsed = _parse_definition_ir(value, "selection definition")
        return cls(
            selection_id=parsed.selection_id,
            expression=Selection(parsed.expression),
            name=parsed.name,
        )

    def to_ir(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "schema_version": _SCHEMA_VERSION,
            "id": self.selection_id,
        }
        if self.name is not None:
            payload["name"] = self.name
        payload["expression"] = self.expression.to_ir()
        return payload


class MagnetizationSelectionScalars:
    __slots__ = ()

    @property
    def x(self) -> SelectionScalar:
        return _magnetization_component("x")

    @property
    def y(self) -> SelectionScalar:
        return _magnetization_component("y")

    @property
    def z(self) -> SelectionScalar:
        return _magnetization_component("z")

    @property
    def norm(self) -> SelectionScalar:
        return SelectionScalar(_scalar_expr("magnetization_norm"))

    def dot(self, axis: object) -> SelectionScalar:
        return SelectionScalar(
            _scalar_expr("magnetization_dot", axis=_unit_vector3(axis, "axis"))
        )


def _magnetization_component(component: str) -> SelectionScalar:
    return SelectionScalar(_scalar_expr("magnetization_component", component=component))


def all_magnetic_selection() -> Selection:
    return Selection._from_expr(_selection_expr("all_magnetic"))


def in_object_selection(value: object) -> Selection:
    return Selection._from_expr(
        _selection_expr("in_object", object_id=_object_id(value))
    )


def in_region_selection(owner: object, region: object) -> Selection:
    owner_id = _object_id(owner)
    region_owner = getattr(region, "owner_object", None)
    if region_owner is not None and _object_id(region_owner) != owner_id:
        raise ValueError("region owner_object does not match the requested object")
    return Selection._from_expr(
        _selection_expr("in_region", object_id=owner_id, region_id=_region_id(region))
    )


def coordinate_selection(component: str, frame: object = "world") -> SelectionScalar:
    normalized = _non_empty(component, "component").lower()
    if normalized not in _COMPONENTS:
        raise ValueError("component must be 'x', 'y', or 'z'")
    return SelectionScalar(
        _scalar_expr("coordinate", component=normalized, frame=_frame_ir(frame))
    )


def between_selection(
    value: SelectionScalar,
    lower: object,
    upper: object,
    *,
    closed: str = "both",
) -> Selection:
    if not isinstance(value, SelectionScalar):
        raise TypeError("value must be a SelectionScalar")
    lower_value = _real(lower, "lower")
    upper_value = _real(upper, "upper")
    if lower_value > upper_value:
        raise ValueError("lower must be <= upper")
    normalized_closed = _non_empty(closed, "closed").lower()
    if normalized_closed not in _CLOSED_INTERVALS:
        raise ValueError("closed must be one of: none, left, right, both")
    return Selection._from_expr(
        _selection_expr(
            "between",
            value=value._expression,
            lower=lower_value,
            upper=upper_value,
            closed=normalized_closed,
        )
    )


def _frame_ir(frame: object) -> dict[str, object]:
    if frame is None or frame == "world":
        return {"kind": "world"}
    return {"kind": "object", "object_id": _object_id(frame)}


def _boundary_ir(
    boundary: str,
    absolute_tolerance_m: object,
    relative_tolerance: object,
) -> dict[str, object]:
    normalized = _non_empty(boundary, "boundary").lower()
    if normalized not in {"inclusive", "exclusive"}:
        raise ValueError("boundary must be 'inclusive' or 'exclusive'")
    absolute = _real(absolute_tolerance_m, "absolute_tolerance_m")
    relative = _real(relative_tolerance, "relative_tolerance")
    if absolute < 0.0 or relative < 0.0:
        raise ValueError("boundary tolerance values must be non-negative")
    return {
        "kind": normalized,
        "absolute_tolerance_m": absolute,
        "relative_tolerance": relative,
    }


def _geometry_payload(geometry: object) -> Mapping[str, object]:
    if type(geometry) not in (
        AuthoredSelectionAffine,
        Box,
        Cylinder,
        Difference,
        Ellipsoid,
        Intersection,
        SelectionAffine,
        SelectionCylinder,
        SelectionGeometry,
        SelectionThroughObjectDisk,
        Translate,
        Union,
    ):
        raise TypeError("geometry must be a typed Fullmag geometry")
    if hasattr(geometry, "to_authored_ir"):
        payload = geometry.to_authored_ir()
    else:
        payload = geometry.to_ir()
    if not isinstance(payload, Mapping):
        raise TypeError("geometry serialization must produce a mapping")
    return payload


def _canonical_geometry(
    node: Mapping[str, object],
    object_bounds_m: object,
) -> tuple[dict[str, object], str | None]:
    kind = node.get("kind")
    if kind == "box":
        size = _vector(node.get("size_m", node.get("size")), 3, "box size")
        if any(component <= 0.0 for component in size):
            raise ValueError("box size must be positive")
        center = _vector(node.get("center_m", (0.0, 0.0, 0.0)), 3, "box center")
        return {"kind": "box", "center_m": list(center), "size_m": list(size)}, None
    if kind == "cylinder":
        radius = _real(node.get("radius_m", node.get("radius")), "cylinder radius")
        height = _real(node.get("height_m", node.get("height")), "cylinder height")
        if radius <= 0.0 or height <= 0.0:
            raise ValueError("cylinder radius and height must be positive")
        center = _vector(node.get("center_m", (0.0, 0.0, 0.0)), 3, "cylinder center")
        axis = _unit_vector3(node.get("axis", (0.0, 0.0, 1.0)), "cylinder axis")
        return {
            "kind": "cylinder",
            "center_m": list(center),
            "axis": list(axis),
            "radius_m": radius,
            "height_m": height,
        }, None
    if kind == "ellipsoid":
        is_canonical = "radii_m" in node
        radii = _vector(node.get("radii_m", node.get("radii")), 3, "ellipsoid radii")
        if any(radius <= 0.0 for radius in radii):
            raise ValueError("ellipsoid radii must be positive")
        if not is_canonical and radii[0] == radii[1] == radii[2]:
            return {
                "kind": "sphere",
                "center_m": list(
                    _vector(node.get("center_m", (0.0, 0.0, 0.0)), 3, "sphere center")
                ),
                "radius_m": radii[0],
            }, None
        return {
            "kind": "ellipsoid",
            "center_m": list(
                _vector(node.get("center_m", (0.0, 0.0, 0.0)), 3, "ellipsoid center")
            ),
            "radii_m": list(radii),
        }, None
    if kind == "sphere":
        radius = _real(node.get("radius_m"), "sphere radius")
        if radius <= 0.0:
            raise ValueError("sphere radius must be positive")
        return {
            "kind": "sphere",
            "center_m": list(_vector(node.get("center_m"), 3, "sphere center")),
            "radius_m": radius,
        }, None
    if kind in {"union", "intersection", "xor"}:
        a, a_owner = _canonical_geometry(
            _require_mapping(node.get("a"), f"{kind}.a"), object_bounds_m
        )
        b, b_owner = _canonical_geometry(
            _require_mapping(node.get("b"), f"{kind}.b"), object_bounds_m
        )
        return {"kind": kind, "a": a, "b": b}, _merge_through_owner(a_owner, b_owner)
    if kind == "difference":
        base, base_owner = _canonical_geometry(
            _require_mapping(node.get("base"), "difference.base"), object_bounds_m
        )
        tool, tool_owner = _canonical_geometry(
            _require_mapping(node.get("tool"), "difference.tool"), object_bounds_m
        )
        return {
            "kind": "difference",
            "base": base,
            "tool": tool,
        }, _merge_through_owner(base_owner, tool_owner)
    if kind == "complement":
        geometry_ir, geometry_owner = _canonical_geometry(
            _require_mapping(node.get("geometry"), "complement.geometry"),
            object_bounds_m,
        )
        domain_ir, domain_owner = _canonical_geometry(
            _require_mapping(node.get("domain"), "complement.domain"), object_bounds_m
        )
        return {
            "kind": "complement",
            "geometry": geometry_ir,
            "domain": domain_ir,
        }, _merge_through_owner(geometry_owner, domain_owner)
    if kind == "imported_solid":
        return {
            "kind": "imported_solid",
            "asset_id": _non_empty(node.get("asset_id"), "imported_solid.asset_id"),
        }, None
    if kind == "translate":
        geometry_ir, owner = _canonical_geometry(
            _require_mapping(node.get("base"), "translate.base"), object_bounds_m
        )
        return _affine_ir(geometry_ir, translation=node.get("by")), owner
    if kind == "affine":
        geometry_ir, owner = _canonical_geometry(
            _require_mapping(node.get("geometry"), "affine.geometry"), object_bounds_m
        )
        return _affine_ir(
            geometry_ir,
            translation=node.get("translation_m"),
            rotation=node.get("rotation_xyzw"),
            scale=node.get("scale"),
            pivot=node.get("pivot_m"),
        ), owner
    if kind == "disk":
        extrusion = _require_mapping(node.get("extrusion"), "disk.extrusion")
        if extrusion.get("kind") != "through_object":
            raise ValueError("disk extrusion must be 'through_object'")
        owner = _object_id(extrusion.get("object_id"))
        bounds = _resolve_bounds(object_bounds_m, owner)
        center = _vector(node.get("center_m"), 3, "disk center")
        axis = _unit_vector3(node.get("normal"), "disk axis")
        radius = _real(node.get("radius_m"), "disk radius")
        if radius <= 0.0:
            raise ValueError("disk radius must be positive")
        projections = [
            sum(axis[index] * (corner[index] - center[index]) for index in range(3))
            for corner in _bounds_corners(bounds)
        ]
        lower = min(projections)
        upper = max(projections)
        height = upper - lower
        if height <= 0.0:
            raise ValueError(
                "object bounds must have positive extent along the disk normal"
            )
        midpoint = (lower + upper) * 0.5
        cylinder_center = [center[index] + midpoint * axis[index] for index in range(3)]
        return {
            "kind": "cylinder",
            "center_m": cylinder_center,
            "axis": list(axis),
            "radius_m": radius,
            "height_m": height,
        }, owner
    raise ValueError(f"unsupported selection geometry kind {kind!r}")


def _affine_ir(
    geometry: dict[str, object],
    *,
    translation: object = (0.0, 0.0, 0.0),
    rotation: object = (0.0, 0.0, 0.0, 1.0),
    scale: object = (1.0, 1.0, 1.0),
    pivot: object = (0.0, 0.0, 0.0),
) -> dict[str, object]:
    translation_value = _vector(translation, 3, "affine translation")
    rotation_value = _vector(rotation, 4, "affine rotation")
    rotation_largest = max(abs(component) for component in rotation_value)
    if rotation_largest == 0.0:
        raise ValueError("affine rotation must be non-zero")
    rotation_norm = math.sqrt(
        sum((component / rotation_largest) ** 2 for component in rotation_value)
    )
    rotation_unit = tuple(
        component / rotation_largest / rotation_norm for component in rotation_value
    )
    scale_value = _vector(scale, 3, "affine scale")
    if any(component == 0.0 for component in scale_value):
        raise ValueError("affine scale must be invertible")
    return {
        "kind": "affine",
        "geometry": geometry,
        "translation_m": list(translation_value),
        "rotation_xyzw": list(rotation_unit),
        "scale": list(scale_value),
        "pivot_m": list(_vector(pivot, 3, "affine pivot")),
    }


def _require_mapping(value: object, field: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise TypeError(f"{field} must be a mapping")
    return value


def _merge_through_owner(left: str | None, right: str | None) -> str | None:
    if left is not None and right is not None and left != right:
        raise ValueError(
            "one selection geometry cannot use through_object for different objects"
        )
    return left if left is not None else right


def _resolve_bounds(
    object_bounds_m: object, object_id: str
) -> tuple[tuple[float, ...], tuple[float, ...]]:
    if object_bounds_m is None:
        raise ValueError("object_bounds_m is required to lower through_object geometry")
    raw = (
        object_bounds_m.get(object_id)
        if isinstance(object_bounds_m, Mapping)
        else object_bounds_m
    )
    if (
        raw is None
        or isinstance(raw, (str, bytes))
        or not isinstance(raw, Sequence)
        or len(raw) != 2
    ):
        raise ValueError(f"object_bounds_m has no bounds for object {object_id!r}")
    lower = _vector(raw[0], 3, "object bounds lower")
    upper = _vector(raw[1], 3, "object bounds upper")
    if any(lower[index] > upper[index] for index in range(3)):
        raise ValueError("object bounds lower values must not exceed upper values")
    return lower, upper


def _bounds_corners(
    bounds: tuple[tuple[float, ...], tuple[float, ...]],
) -> tuple[tuple[float, float, float], ...]:
    lower, upper = bounds
    return tuple(
        (x, y, z)
        for x in (lower[0], upper[0])
        for y in (lower[1], upper[1])
        for z in (lower[2], upper[2])
    )


def inside_selection(
    geometry: object,
    *,
    frame: object = "world",
    boundary: str = "inclusive",
    absolute_tolerance_m: object = 0.0,
    relative_tolerance: object = 1.0e-12,
    object_bounds_m: object = None,
) -> Selection:
    geometry_ir, through_owner = _canonical_geometry(
        _geometry_payload(geometry), object_bounds_m
    )
    resolved_frame = through_owner if through_owner is not None else frame
    if through_owner is not None and frame not in (None, "world"):
        if _object_id(frame) != through_owner:
            raise ValueError("through_object geometry frame must match its object_id")
    inside = Selection._from_expr(
        _selection_expr(
            "inside_geometry",
            geometry=geometry_ir,
            frame=_frame_ir(resolved_frame),
            sampling={"kind": "dof_point"},
            boundary=_boundary_ir(boundary, absolute_tolerance_m, relative_tolerance),
        )
    )
    if through_owner is None:
        return inside
    return in_object_selection(through_owner) & inside


def canonical_selection_sha256(
    definition: SelectionDefinition | Mapping[str, object],
    *,
    dependencies: Sequence[SelectionDefinition | Mapping[str, object]] = (),
) -> str:
    """Hash one named selection and every reachable named dependency."""

    root = (
        definition.to_ir()
        if isinstance(definition, SelectionDefinition)
        else definition
    )
    dependency_payloads = tuple(
        candidate.to_ir() if isinstance(candidate, SelectionDefinition) else candidate
        for candidate in dependencies
    )
    return _canonical_selection_sha256(root, dependencies=dependency_payloads)


__all__ = [
    "MagnetizationSelectionScalars",
    "Selection",
    "SelectionDefinition",
    "SelectionGeometry",
    "SelectionScalar",
    "canonical_selection_sha256",
]
