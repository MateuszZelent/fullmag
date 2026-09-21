"""Versioned, SI-normalized authoring parameters.

The parameter AST is intentionally independent of solver execution.  It keeps
authored expressions and presentation metadata separate so a future
Model/Component bridge can lower the same values from Python and the browser
without making display units part of numerical identity.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
import math
import re
from typing import Any

from .canonical import canonical_json_sha256

_PARAMETER_AST_SCHEMA = "parameter_ast.v1"
_PARAMETER_LIBRARY_SCHEMA = "parameter_library.v1"
_NAME_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_.:-]*$")

# The first slice deliberately covers the SI units already used by the public
# DSL.  Compound dimensions produced by arithmetic remain symbolic and are
# validated for compatibility at evaluation time.
_UNIT_TABLE: dict[str, tuple[float, str]] = {
    "1": (1.0, "dimensionless"),
    "dimensionless": (1.0, "dimensionless"),
    "m": (1.0, "length"),
    "cm": (1.0e-2, "length"),
    "mm": (1.0e-3, "length"),
    "um": (1.0e-6, "length"),
    "µm": (1.0e-6, "length"),
    "μm": (1.0e-6, "length"),
    "nm": (1.0e-9, "length"),
    "pm": (1.0e-12, "length"),
    "s": (1.0, "time"),
    "ms": (1.0e-3, "time"),
    "us": (1.0e-6, "time"),
    "ns": (1.0e-9, "time"),
    "A": (1.0, "current"),
    "A/m": (1.0, "magnetization"),
    "T": (1.0, "tesla"),
    "J/m": (1.0, "exchange_density"),
    "J/m^2": (1.0, "surface_energy_density"),
    "J/m^3": (1.0, "energy_density"),
}


def _require_name(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty identifier")
    value = value.strip()
    if _NAME_PATTERN.fullmatch(value) is None:
        raise ValueError(f"{field} must match {_NAME_PATTERN.pattern!r}")
    return value


def _require_dimension(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty dimension")
    value = value.strip()
    if re.fullmatch(r"[A-Za-z0-9_.^*/-]+", value) is None:
        raise ValueError(f"{field} contains unsupported dimension characters")
    return value


def _finite(value: object, field: str) -> float:
    if isinstance(value, bool):
        raise TypeError(f"{field} must be a finite real number")
    try:
        normalized = float(value)
    except (TypeError, ValueError) as exc:
        raise TypeError(f"{field} must be a finite real number") from exc
    if not math.isfinite(normalized):
        raise ValueError(f"{field} must be finite")
    return normalized


def _unit_spec(unit: object, field: str = "unit") -> tuple[str, float, str]:
    if not isinstance(unit, str) or not unit.strip():
        raise ValueError(f"{field} must be a non-empty supported SI unit")
    authored = unit.strip()
    try:
        scale, dimension = _UNIT_TABLE[authored]
    except KeyError as exc:
        supported = ", ".join(sorted(_UNIT_TABLE))
        raise ValueError(f"{field} must be one of: {supported}") from exc
    return authored, scale, dimension


def _combine_dimension(left: str | None, right: str | None, operator: str) -> str | None:
    if left is None or right is None:
        return None
    if operator in {"add", "sub"}:
        if left != right:
            raise ValueError(
                f"parameter_dimension_mismatch: cannot {operator} {left!r} and {right!r}"
            )
        return left
    if left == "dimensionless":
        return right
    if right == "dimensionless":
        return left
    return f"{left}{'*' if operator == 'mul' else '/'}{right}"


@dataclass(frozen=True, slots=True)
class ParameterValue:
    """Resolved scalar represented in SI units with a semantic dimension."""

    value_si: float
    dimension: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "value_si", _finite(self.value_si, "value_si"))
        object.__setattr__(self, "dimension", _require_dimension(self.dimension, "dimension"))

    def to_ir(self) -> dict[str, object]:
        """Serialize the resolved SI value without display metadata."""

        return {"value_si": self.value_si, "dimension": self.dimension}


@dataclass(frozen=True, slots=True, init=False)
class ParameterExpression:
    """Immutable ``parameter_ast.v1`` expression.

    Constants accept an authored unit and are normalized to ``value_si`` at
    construction. References are resolved by :class:`ParameterLibrary`.
    Arithmetic is dimension checked whenever both operands are known.
    """

    _kind: str
    _fields: tuple[tuple[str, object], ...]
    _dimension: str | None

    @classmethod
    def _create(
        cls,
        kind: str,
        fields: tuple[tuple[str, object], ...],
        dimension: str | None,
    ) -> "ParameterExpression":
        instance = object.__new__(cls)
        object.__setattr__(instance, "_kind", kind)
        object.__setattr__(instance, "_fields", fields)
        object.__setattr__(instance, "_dimension", dimension)
        return instance

    @classmethod
    def constant(cls, value: object, *, unit: str = "1") -> "ParameterExpression":
        """Create a finite scalar and normalize it to SI."""

        authored_unit, scale, dimension = _unit_spec(unit)
        value_si = _finite(value, "value") * scale
        if not math.isfinite(value_si):
            raise ValueError("value after SI normalization must be finite")
        return cls._create(
            "constant",
            (
                ("value_si", value_si),
                ("dimension", dimension),
                ("authored_unit", authored_unit),
            ),
            dimension,
        )

    @classmethod
    def reference(cls, name: str) -> "ParameterExpression":
        """Reference another named parameter in the same library."""

        return cls._create("reference", (("name", _require_name(name, "name")),), None)

    @classmethod
    def from_ir(cls, value: object) -> "ParameterExpression":
        """Parse and validate a ``parameter_ast.v1`` mapping."""

        if not isinstance(value, Mapping):
            raise TypeError("parameter expression must be a mapping")
        if value.get("schema_version", _PARAMETER_AST_SCHEMA) != _PARAMETER_AST_SCHEMA:
            raise ValueError("unsupported parameter expression schema_version")
        kind = value.get("kind")
        if kind == "constant":
            if "value_si" in value:
                dimension = _require_dimension(value.get("dimension"), "dimension")
                authored_unit = value.get("authored_unit", "1")
                _unit_spec(authored_unit, "authored_unit")
                return cls._create(
                    "constant",
                    (
                        ("value_si", _finite(value["value_si"], "value_si")),
                        ("dimension", dimension),
                        ("authored_unit", str(authored_unit)),
                    ),
                    dimension,
                )
            # A short-lived compatibility form makes migration fixtures
            # readable while the canonical writer always emits value_si.
            return cls.constant(value["value"], unit=value.get("unit", "1"))
        if kind == "reference":
            return cls.reference(value.get("name"))
        if kind in {"add", "sub", "mul", "div"}:
            left = cls.from_ir(value.get("left"))
            right = cls.from_ir(value.get("right"))
            return cls._binary(kind, left, right)
        raise ValueError(f"unsupported parameter expression kind {kind!r}")

    @classmethod
    def _binary(
        cls, kind: str, left: "ParameterExpression", right: "ParameterExpression"
    ) -> "ParameterExpression":
        if kind not in {"add", "sub", "mul", "div"}:
            raise ValueError(f"unsupported parameter operator {kind!r}")
        dimension = _combine_dimension(left._dimension, right._dimension, kind)
        return cls._create(kind, (("left", left), ("right", right)), dimension)

    def _coerce(self, other: object) -> "ParameterExpression":
        if isinstance(other, ParameterExpression):
            return other
        return self.constant(other)

    def __add__(self, other: object) -> "ParameterExpression":
        return self._binary("add", self, self._coerce(other))

    def __radd__(self, other: object) -> "ParameterExpression":
        return self._binary("add", self._coerce(other), self)

    def __sub__(self, other: object) -> "ParameterExpression":
        return self._binary("sub", self, self._coerce(other))

    def __rsub__(self, other: object) -> "ParameterExpression":
        return self._binary("sub", self._coerce(other), self)

    def __mul__(self, other: object) -> "ParameterExpression":
        return self._binary("mul", self, self._coerce(other))

    def __rmul__(self, other: object) -> "ParameterExpression":
        return self._binary("mul", self._coerce(other), self)

    def __truediv__(self, other: object) -> "ParameterExpression":
        return self._binary("div", self, self._coerce(other))

    def __rtruediv__(self, other: object) -> "ParameterExpression":
        return self._binary("div", self._coerce(other), self)

    @property
    def dimension(self) -> str | None:
        """Return the statically known dimension, if any."""

        return self._dimension

    def references(self) -> tuple[str, ...]:
        """Return referenced parameter names in deterministic order."""

        names: set[str] = set()
        self._collect_references(names)
        return tuple(sorted(names))

    def _collect_references(self, names: set[str]) -> None:
        if self._kind == "reference":
            names.add(str(dict(self._fields)["name"]))
            return
        for _, value in self._fields:
            if isinstance(value, ParameterExpression):
                value._collect_references(names)

    def to_ir(self, *, include_display: bool = True) -> dict[str, object]:
        """Serialize the expression; omit authored display units on request."""

        payload: dict[str, object] = {"schema_version": _PARAMETER_AST_SCHEMA, "kind": self._kind}
        fields = dict(self._fields)
        for key, value in fields.items():
            if key == "authored_unit" and not include_display:
                continue
            payload[key] = (
                value.to_ir(include_display=include_display)
                if isinstance(value, ParameterExpression)
                else value
            )
        return payload

    def evaluate(self, bindings: Mapping[str, ParameterValue]) -> ParameterValue:
        """Evaluate using already resolved parameter bindings."""

        fields = dict(self._fields)
        if self._kind == "constant":
            return ParameterValue(fields["value_si"], fields["dimension"])
        if self._kind == "reference":
            name = str(fields["name"])
            try:
                return bindings[name]
            except KeyError as exc:
                raise ValueError(f"parameter_unknown_reference: {name!r}") from exc
        left = fields["left"].evaluate(bindings)
        right = fields["right"].evaluate(bindings)
        if self._kind in {"add", "sub"}:
            if left.dimension != right.dimension:
                raise ValueError(
                    f"parameter_dimension_mismatch: {left.dimension!r} and {right.dimension!r}"
                )
            value = left.value_si + right.value_si if self._kind == "add" else left.value_si - right.value_si
            return ParameterValue(value, left.dimension)
        if self._kind == "mul":
            return ParameterValue(
                left.value_si * right.value_si,
                _combine_dimension(left.dimension, right.dimension, "mul") or "dimensionless",
            )
        if right.value_si == 0.0:
            raise ValueError("parameter_division_by_zero")
        return ParameterValue(
            left.value_si / right.value_si,
            _combine_dimension(left.dimension, right.dimension, "div") or "dimensionless",
        )


@dataclass(frozen=True, slots=True)
class ParameterDefinition:
    """Named expression plus non-numerical presentation metadata."""

    name: str
    expression: ParameterExpression
    display_unit: str | None = None
    description: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "name", _require_name(self.name, "name"))
        if not isinstance(self.expression, ParameterExpression):
            raise TypeError("expression must be a ParameterExpression")
        if self.display_unit is not None:
            _unit_spec(self.display_unit, "display_unit")
        if self.description is not None and not isinstance(self.description, str):
            raise TypeError("description must be a string or None")

    def to_ir(self, *, include_display: bool = True) -> dict[str, object]:
        payload: dict[str, object] = {
            "id": self.name,
            "expression": self.expression.to_ir(include_display=include_display),
        }
        if include_display and self.display_unit is not None:
            payload["display_unit"] = self.display_unit
        if include_display and self.description is not None:
            payload["description"] = self.description
        return payload


class ParameterLibrary:
    """Versioned collection of named parameter definitions.

    ``resolve`` performs a deterministic depth-first evaluation and rejects
    unknown references and cycles before a caller can lower the model.
    """

    def __init__(self, *, version: str = "parameter_library.v1") -> None:
        self.version = _require_name(version, "version")
        self._definitions: dict[str, ParameterDefinition] = {}

    @property
    def names(self) -> tuple[str, ...]:
        """Return definition names in canonical order."""

        return tuple(sorted(self._definitions))

    def definition(self, name: str) -> ParameterDefinition:
        """Return one immutable definition in canonical authoring form."""

        target = _require_name(name, "name")
        try:
            return self._definitions[target]
        except KeyError as exc:
            raise ValueError(f"parameter_unknown_definition: {target!r}") from exc

    def define(
        self,
        name: str,
        expression: ParameterExpression,
        *,
        display_unit: str | None = None,
        description: str | None = None,
    ) -> ParameterDefinition:
        """Add one definition, rejecting duplicate stable IDs."""

        definition = ParameterDefinition(
            name=name,
            expression=expression,
            display_unit=display_unit,
            description=description,
        )
        if definition.name in self._definitions:
            raise ValueError(f"duplicate_parameter_id: {definition.name!r}")
        if definition.display_unit is not None and expression.dimension is not None:
            _, _, display_dimension = _unit_spec(definition.display_unit, "display_unit")
            if display_dimension != expression.dimension:
                raise ValueError(
                    f"parameter_display_unit_mismatch: {display_dimension!r} and {expression.dimension!r}"
                )
        self._definitions[definition.name] = definition
        return definition

    def resolve(self, name: str) -> ParameterValue:
        """Resolve one definition, failing closed on cycles and unknown IDs."""

        target = _require_name(name, "name")
        visiting: list[str] = []
        resolved: dict[str, ParameterValue] = {}

        def visit(current: str) -> ParameterValue:
            if current in resolved:
                return resolved[current]
            if current in visiting:
                cycle = " -> ".join([*visiting, current])
                raise ValueError(f"parameter_reference_cycle: {cycle}")
            definition = self._definitions.get(current)
            if definition is None:
                raise ValueError(f"parameter_unknown_reference: {current!r}")
            visiting.append(current)
            bindings = {reference: visit(reference) for reference in definition.expression.references()}
            value = definition.expression.evaluate(bindings)
            if definition.display_unit is not None:
                _, _, display_dimension = _unit_spec(
                    definition.display_unit,
                    "display_unit",
                )
                if display_dimension != value.dimension:
                    raise ValueError(
                        "parameter_display_unit_mismatch: "
                        f"{display_dimension!r} and {value.dimension!r}"
                    )
            visiting.pop()
            resolved[current] = value
            return value

        return visit(target)

    def resolve_all(self) -> dict[str, ParameterValue]:
        """Resolve every definition in canonical name order."""

        return {name: self.resolve(name) for name in self.names}

    def to_ir(self, *, include_display: bool = True) -> dict[str, object]:
        """Serialize the versioned library in stable definition order."""

        return {
            "schema_version": _PARAMETER_LIBRARY_SCHEMA,
            "version": self.version,
            "parameters": [
                self._definitions[name].to_ir(include_display=include_display)
                for name in self.names
            ],
        }

    def numerical_ir(self) -> dict[str, object]:
        """Return the identity payload without display/provenance metadata."""

        return self.to_ir(include_display=False)

    def numerical_sha256(self) -> str:
        """Hash only normalized parameter values and references."""

        return canonical_json_sha256(self.numerical_ir())

    @classmethod
    def from_ir(cls, value: object) -> "ParameterLibrary":
        """Parse a ``parameter_library.v1`` mapping."""

        if not isinstance(value, Mapping):
            raise TypeError("parameter library must be a mapping")
        if value.get("schema_version") != _PARAMETER_LIBRARY_SCHEMA:
            raise ValueError("unsupported parameter library schema_version")
        library = cls(version=value.get("version", "parameter_library.v1"))
        parameters = value.get("parameters")
        if not isinstance(parameters, list):
            raise TypeError("parameter library parameters must be a list")
        for entry in parameters:
            if not isinstance(entry, Mapping):
                raise TypeError("parameter definition must be a mapping")
            library.define(
                entry.get("id"),
                ParameterExpression.from_ir(entry.get("expression")),
                display_unit=entry.get("display_unit"),
                description=entry.get("description"),
            )
        return library


__all__ = [
    "ParameterDefinition",
    "ParameterExpression",
    "ParameterLibrary",
    "ParameterValue",
]
