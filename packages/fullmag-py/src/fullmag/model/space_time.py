"""One function of position and time, split into mask and time functions.

    def wave(x, y, z, t, B, k, f):
        return (B * sin(k * x - 2 * pi * f * t), 0.0, 0.0)

    for field, drive in fm.space_time(wave, B=1 * mT, k=2 * pi / (196 * nm), f=4.5 * GHz):
        antenna.add(field, drive)

The solver needs a field of the form ``sum_i mask_i(x, y, z) * time_i(t)``.
``space_time`` rewrites each component of the function into that form and
returns ordinary ``(mask, time)`` pairs, as a user module would. It expands
sums, products, quotients by a factor of one kind, integer powers 2 to 4,
``sin(a + b)``, ``cos(a + b)`` and ``exp(a + b)`` with ``a`` of position and
``b`` of time. Anything else (for example ``exp(-(x - v * t) ** 2)``) is
rejected with ``mask_not_separable`` and the sub-expression.
"""

from __future__ import annotations

import ast
from typing import Callable

from fullmag.model.mask_function import (
    FunctionParameter,
    MaskFunction,
    MaskFunctionError,
    TimeFunction,
    _bind,
    _transpile,
)

MAX_TERMS = 8
_SPACE = frozenset({"x", "y", "z"})
# A term of the expansion: (factor of position, factor of time); None is 1.
_Term = tuple["ast.expr | None", "ast.expr | None"]


def _parse(text: str) -> ast.expr:
    """Equations written by the transpiler are Python expressions."""
    return ast.parse(text, mode="eval").body


def _text(node: ast.expr) -> str:
    return ast.unparse(node)


def _names(node: ast.expr) -> set[str]:
    return {child.id for child in ast.walk(node) if isinstance(child, ast.Name)}


def _depends(node: ast.expr) -> tuple[bool, bool]:
    names = _names(node)
    return bool(names & _SPACE), "t" in names


class _Substitute(ast.NodeTransformer):
    """Replace the names of local equations by their expressions."""

    def __init__(self, values: dict[str, ast.expr]) -> None:
        self.values = values

    def visit_Name(self, node: ast.Name) -> ast.expr:
        replacement = self.values.get(node.id)
        return node if replacement is None else replacement


def _call(name: str, argument: ast.expr) -> ast.expr:
    return ast.Call(func=ast.Name(id=name, ctx=ast.Load()), args=[argument], keywords=[])


def _negate(node: ast.expr | None) -> ast.expr:
    return ast.UnaryOp(op=ast.USub(), operand=ast.Constant(1.0) if node is None else node)


def _strip_sign(node: ast.expr) -> tuple[bool, ast.expr]:
    """``-c`` as ``(True, c)``; any other expression as ``(False, expression)``."""
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        negative, operand = _strip_sign(node.operand)
        return not negative, operand
    return False, node


def _binary(left: ast.expr | None, operator: ast.operator, right: ast.expr | None) -> ast.expr | None:
    if left is None:
        return right
    if right is None:
        return left
    return ast.BinOp(left=left, op=operator, right=right)


def _not_separable(node: ast.expr) -> MaskFunctionError:
    return MaskFunctionError(
        f"mask_not_separable: '{_text(node)}' is not a sum of (function of x, y, z) "
        "times (function of t); write the mask and time functions by hand"
    )


def _additive_parts(node: ast.expr) -> tuple[ast.expr | None, ast.expr | None]:
    """Split ``a(x, y, z) + b(t)`` into ``(a, b)``; constants go with ``a``."""
    space, time = _depends(node)
    if not time:
        return node, None
    if not space:
        return None, node
    if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub)):
        left = _additive_parts(node.left)
        right = _additive_parts(node.right)
        if isinstance(node.op, ast.Sub):
            right = tuple(None if part is None else _negate(part) for part in right)  # type: ignore[assignment]
        return (
            _binary(left[0], ast.Add(), right[0]),
            _binary(left[1], ast.Add(), right[1]),
        )
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
        parts = _additive_parts(node.operand)
        if isinstance(node.op, ast.UAdd):
            return parts
        return tuple(None if part is None else _negate(part) for part in parts)  # type: ignore[return-value]
    raise _not_separable(node)


def _multiply(left: list[_Term], right: list[_Term]) -> list[_Term]:
    return [
        (_binary(a[0], ast.Mult(), b[0]), _binary(a[1], ast.Mult(), b[1]))
        for a in left
        for b in right
    ]


def _expand(node: ast.expr) -> list[_Term]:
    """``node`` as a list of (position factor, time factor) terms."""
    space, time = _depends(node)
    if not time:
        return [(node, None)]
    if not space:
        return [(None, node)]
    if isinstance(node, ast.BinOp):
        if isinstance(node.op, ast.Add):
            return _expand(node.left) + _expand(node.right)
        if isinstance(node.op, ast.Sub):
            return _expand(node.left) + [(_negate(s), t) for s, t in _expand(node.right)]
        if isinstance(node.op, ast.Mult):
            return _multiply(_expand(node.left), _expand(node.right))
        if isinstance(node.op, ast.Div):
            divisor_space, divisor_time = _depends(node.right)
            if divisor_space and divisor_time:
                raise _not_separable(node)
            one: ast.expr = ast.Constant(1.0)
            if divisor_time:
                return [
                    (s, ast.BinOp(left=one if t is None else t, op=ast.Div(), right=node.right))
                    for s, t in _expand(node.left)
                ]
            return [
                (ast.BinOp(left=one if s is None else s, op=ast.Div(), right=node.right), t)
                for s, t in _expand(node.left)
            ]
        if (
            isinstance(node.op, ast.Pow)
            and isinstance(node.right, ast.Constant)
            and node.right.value in (2, 3, 4)
            and not isinstance(node.right.value, bool)
        ):
            base = _expand(node.left)
            result = base
            for _ in range(int(node.right.value) - 1):
                result = _multiply(result, base)
            return result
    if isinstance(node, ast.UnaryOp):
        if isinstance(node.op, ast.UAdd):
            return _expand(node.operand)
        if isinstance(node.op, ast.USub):
            return [(_negate(s), t) for s, t in _expand(node.operand)]
    if (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id in ("sin", "cos", "exp")
        and len(node.args) == 1
    ):
        try:
            a, b = _additive_parts(node.args[0])
        except MaskFunctionError:
            raise _not_separable(node) from None  # name the whole call
        if a is None or b is None:  # not reached: the argument depends on both
            raise _not_separable(node)
        if node.func.id == "exp":
            return [(_call("exp", a), _call("exp", b))]
        # sin(-c) = -sin(c), cos(-c) = cos(c): the sign of the time part goes to
        # the position factor, so the time functions read cos(c) and sin(c).
        negative, b = _strip_sign(b)
        sin_a, cos_a = _call("sin", a), _call("cos", a)
        if node.func.id == "sin":
            return [(sin_a, _call("cos", b)), (_negate(cos_a) if negative else cos_a, _call("sin", b))]
        return [(cos_a, _call("cos", b)), (sin_a if negative else _negate(sin_a), _call("sin", b))]
    raise _not_separable(node)


def _is_zero(node: ast.expr | None) -> bool:
    return isinstance(node, ast.Constant) and node.value == 0


def space_time(
    function: Callable[..., object], /, **values: float
) -> tuple[tuple[MaskFunction, TimeFunction | None], ...]:
    """Split ``function(x, y, z, t, ...) -> (Bx, By, Bz)`` into ``(mask, time)`` pairs.

    Values of the further parameters are given here, as in ``fm.mask``. A pair
    whose time factor is 1 has ``time=None`` (a static term). Components with
    the same time factor share one pair.
    """
    bound = _bind(MaskFunction, _transpile(function, "space_time"), values)
    local_values: dict[str, ast.expr] = {}
    for name, expression in bound.locals:
        local_values[name] = _Substitute(local_values).visit(_parse(expression))
    # Time factor text -> [Sx, Sy, Sz]; insertion order is the order of the terms.
    terms: dict[str, list[ast.expr | None]] = {}
    time_nodes: dict[str, ast.expr | None] = {}
    for component, output in enumerate(bound.outputs):
        expression = _Substitute(local_values).visit(_parse(output))
        for space, time in _expand(expression):
            if _is_zero(space):
                continue
            key = "1" if time is None else _text(time)
            factors = terms.setdefault(key, [None, None, None])
            time_nodes.setdefault(key, time)
            current = factors[component]
            unit: ast.expr = ast.Constant(1.0)
            addend = unit if space is None else space
            factors[component] = addend if current is None else ast.BinOp(
                left=current, op=ast.Add(), right=addend
            )
    if not terms:
        raise MaskFunctionError(f"mask_not_separable: {bound.name} returns a zero field")
    if len(terms) > MAX_TERMS:
        raise MaskFunctionError(
            f"mask_too_many_terms: {bound.name} expands to {len(terms)} terms; an antenna "
            f"takes at most {MAX_TERMS}"
        )
    values_by_name = {parameter.name: parameter for parameter in bound.parameters}

    def parameters(nodes: list[ast.expr]) -> tuple[FunctionParameter, ...]:
        used = set().union(*(_names(node) for node in nodes))
        return tuple(
            FunctionParameter(name, parameter.value)
            for name, parameter in values_by_name.items()
            if name in used
        )

    pairs = []
    for index, (key, factors) in enumerate(terms.items(), start=1):
        components = [ast.Constant(0.0) if factor is None else factor for factor in factors]
        mask = MaskFunction(
            kind="mask",
            name=f"{bound.name}_space_{index}",
            parameters=parameters(components),
            locals=(),
            outputs=tuple(_text(component) for component in components),
        )
        time_node = time_nodes[key]
        drive = None if time_node is None else TimeFunction(
            kind="time",
            name=f"{bound.name}_time_{index}",
            parameters=parameters([time_node]),
            locals=(),
            outputs=(_text(time_node),),
        )
        pairs.append((mask, drive))
    return tuple(pairs)


__all__ = ["MAX_TERMS", "space_time"]
