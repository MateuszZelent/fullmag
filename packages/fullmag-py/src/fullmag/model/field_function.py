"""Material parameter fields written as a function of position.

Contract: ``docs/specs/material-assignment-and-spatial-fields-v0.md`` (the
``function`` kind) and ``docs/specs/mask-function-v1.md``, section 9. Physics
note: ``docs/physics/0104-material-regions-parameter-fields-and-interface-couplings.md``.

``fm.fields.function`` takes either an equation string (the main form) or a
``def`` (the mumax3-style alternative), with the values of the named parameters::

    film.alpha = fm.fields.function(
        "a0 + a_max*max(0.0, (x - x_edge)/L)**3",
        a0=0.01, a_max=0.5, x_edge=2e-6, L=600e-9,
    )

    def alpha(x, y, z, a0, a_max, x_edge, L):
        return a0 + a_max * max(0.0, (x - x_edge) / L) ** 3

    film.alpha = fm.fields.function(alpha, a0=0.01, a_max=0.5, x_edge=2e-6, L=600e-9)

Both become the same ``FunctionIR`` of the kind ``field`` (variables ``x, y, z``
in metres, one output in the SI unit of the parameter). ``FunctionIR.name`` is
set for a ``def`` and absent for a string, so an exported script writes the
field back in the form its author used. Fullmag never calls the function and
never ``eval``s the string: the planner evaluates the equation once per FDM cell
or FEM node.
"""

from __future__ import annotations

import ast
import keyword
import math
import numbers
from typing import Callable, Mapping

from fullmag._validation import require_non_empty
from fullmag.model.mask_function import (
    FIELD_EXPR_VERSION,
    FormulaError,
    MaskFunctionError,
    _FIELD_FUNCTIONS_1,
    _FormulaChecker,
    _RESERVED,
    _Function,
    _bind,
    _check_formula_text,
    _evaluator,
    _transpile,
)
from fullmag.model.structure import (
    MaterialParameterField,
    _REGION_FRAMES,
    _normalize_choice,
)

_VARIABLES = ("x", "y", "z")
# Keyword arguments of fm.fields.function: a parameter may not use them.
_CALL_KEYWORDS = frozenset({"frame", "unit"})


class FieldFunctionError(ValueError):
    """``fm.fields.function`` cannot build a field.

    Messages start with ``character N:`` (zero-based, in an equation string),
    ``line N:`` (a line of a ``def``) or ``parameter 'name':`` (a value given
    at the call).
    """


class _FieldFormulaChecker(_FormulaChecker):
    """Formula checker of the field kind: ``x, y, z``, ``pi``, the mask
    functions and ``heaviside``, and the names in ``names``."""

    functions_1 = _FIELD_FUNCTIONS_1

    def __init__(self, names: frozenset[str], offset: int) -> None:
        super().__init__("field", offset)
        self.names = names
        self.used: set[str] = set()

    def check_name(self, node: ast.Name) -> None:
        name = node.id
        if name in self.variables or name == "pi":
            return
        if name in self.names:
            self.used.add(name)
            return
        if name == "t":
            raise self.fail(node, "a field function may use only x, y, z, not 't'")
        if name in self.functions_1 or name in self.functions_2:
            raise self.fail(node, f"function {name!r} must be called")
        raise self.fail(
            node,
            f"name {name!r} is not x, y, z, pi, a function or a parameter; "
            f"pass its value as {name}=...",
        )


def function(
    source: str | Callable[..., object],
    /,
    *,
    frame: str = "object",
    unit: str | None = None,
    **values: float,
) -> MaterialParameterField:
    """A scalar material parameter field given as an equation of position.

    ``source`` is an equation string in Python syntax or a ``def`` whose first
    three parameters are ``x, y, z``. ``x, y, z`` are in metres, in the object
    frame (default) or the world frame. ``values`` gives the named parameters
    (SI numbers); a ``def`` may also take them from defaults. The value of the
    field is in the SI unit of the parameter it is assigned to (``1`` for
    ``alpha``); ``unit`` only declares it. The planner checks the sampled values
    against the parameter's range (for example ``alpha >= 0``).
    """
    normalized_frame = _normalize_choice(frame, _REGION_FRAMES, "frame")
    numbers_ = {name: _real(name, value) for name, value in values.items()}
    if isinstance(source, str):
        function_ir = _from_text(source, numbers_)
    elif callable(source):
        function_ir = _from_def(source, numbers_)
    else:
        raise FieldFunctionError(
            "character 0: fm.fields.function takes an equation string or a def, "
            f"not {type(source).__name__}"
        )
    payload: dict[str, object] = {
        "kind": "function",
        "function": function_ir,
        "frame": normalized_frame,
    }
    if unit is not None:
        payload["unit"] = require_non_empty(unit, "unit")
    return MaterialParameterField(payload)


def _real(name: str, value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, numbers.Real):
        raise FieldFunctionError(f"parameter {name!r}: value must be a real number, got {value!r}")
    number = float(value)
    if not math.isfinite(number):
        raise FieldFunctionError(f"parameter {name!r}: value must be finite, got {number!r}")
    return number


def _check_parameter_name(name: str) -> None:
    if not name.isidentifier() or not name.isascii():
        raise FieldFunctionError(f"parameter {name!r}: not a valid name")
    if keyword.iskeyword(name):
        raise FieldFunctionError(f"parameter {name!r}: a Python keyword cannot be a parameter")
    if name in _RESERVED:
        raise FieldFunctionError(f"parameter {name!r}: the name is reserved")
    if name in _CALL_KEYWORDS:
        raise FieldFunctionError(
            f"parameter {name!r}: {name} is a keyword of fm.fields.function; rename the parameter"
        )


def _from_text(text: str, values: Mapping[str, float]) -> dict[str, object]:
    for name in values:
        _check_parameter_name(name)
    if not isinstance(text, str):  # pragma: no cover - guarded by the caller
        raise FieldFunctionError("character 0: an equation is a string")
    names = frozenset(values)
    checkers: list[_FieldFormulaChecker] = []

    def make_checker(offset: int) -> _FieldFormulaChecker:
        checker = _FieldFormulaChecker(names, offset)
        checkers.append(checker)
        return checker

    try:
        _check_formula_text(text, make_checker)
    except FormulaError as error:
        raise FieldFunctionError(str(error)) from None
    unused = [name for name in values if name not in checkers[-1].used]
    if unused:
        raise FieldFunctionError(
            f"parameter {unused[0]!r}: the equation does not use it; remove it or use it"
        )
    payload: dict[str, object] = {"expression_version": FIELD_EXPR_VERSION}
    if values:
        payload["parameters"] = [{"name": name, "value": value} for name, value in values.items()]
    payload["outputs"] = [text.strip(" \t")]
    return payload


def _from_def(source: Callable[..., object], values: Mapping[str, float]) -> dict[str, object]:
    try:
        bound = _bind(_Function, _transpile(source, "field"), values)
    except MaskFunctionError as error:
        raise FieldFunctionError(str(error)) from None
    for parameter in bound.parameters:
        if parameter.name in _CALL_KEYWORDS:
            raise FieldFunctionError(
                f"parameter {parameter.name!r}: {parameter.name} is a keyword of "
                "fm.fields.function; rename the parameter"
            )
    payload = bound.to_ir()
    # A field function stores numbers only: the exported call passes every value,
    # so the text of a default (``FunctionParameterIR.source``) would not survive
    # the round trip.
    if "parameters" in payload:
        payload["parameters"] = [
            {"name": parameter.name, "value": parameter.value} for parameter in bound.parameters
        ]
    return payload


def compile_field_function(function_ir: Mapping[str, object]) -> Callable[[float, float, float], float]:
    """Evaluator of a stored field function ``(x, y, z) -> value``.

    Checks the parameters, locals and the output with the formula checker of
    the field kind and evaluates them with IEEE-754 results, as the planner
    does; used for previews and tests. Raises ``FieldFunctionError``.
    """
    if function_ir.get("expression_version") != FIELD_EXPR_VERSION:
        raise FieldFunctionError(f"character 0: expression_version must be {FIELD_EXPR_VERSION!r}")
    outputs = list(function_ir.get("outputs") or ())
    if len(outputs) != 1:
        raise FieldFunctionError(f"character 0: a field function has one output, got {len(outputs)}")
    parameters = [
        (str(item["name"]), float(item["value"])) for item in function_ir.get("parameters") or ()
    ]
    names = [name for name, _ in parameters]
    steps: list[Callable[..., float]] = []
    for item in [*(function_ir.get("locals") or ()), {"name": None, "expression": outputs[0]}]:
        known = frozenset(names)
        try:
            tree = _check_formula_text(
                str(item["expression"]), lambda offset: _FieldFormulaChecker(known, offset)
            )
        except FormulaError as error:
            raise FieldFunctionError(str(error)) from None
        steps.append(_evaluator(tree, (*_VARIABLES, *names)))
        if item["name"] is not None:
            names.append(str(item["name"]))
    parameter_values = tuple(value for _, value in parameters)

    def evaluate(x: float, y: float, z: float) -> float:
        arguments = [float(x), float(y), float(z), *parameter_values]
        for step in steps[:-1]:
            arguments.append(step(*arguments))
        return steps[-1](*arguments)

    return evaluate


__all__ = ["FieldFunctionError", "compile_field_function", "function"]
