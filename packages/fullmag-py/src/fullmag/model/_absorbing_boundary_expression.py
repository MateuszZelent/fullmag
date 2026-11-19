"""Safe scalar expression evaluation for absorbing-boundary ramps and distance coordinates."""

from __future__ import annotations

import ast
from functools import lru_cache
import math
import operator
import re
from typing import Callable

_ScalarFunction = Callable[[float], float]
_TOLERANCE = 1e-12
_BINARY = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.Pow: math.pow,
}
_FUNCTIONS = {
    "abs": abs,
    "sqrt": math.sqrt,
    "exp": math.exp,
    "log": math.log,
    "log1p": math.log1p,
    "tanh": math.tanh,
    "sin": math.sin,
    "cos": math.cos,
}


def _finite(value: float) -> float:
    if not math.isfinite(value):
        raise ValueError("non-finite intermediate value")
    return value


def _evaluator(node: ast.AST, variables: tuple[str, ...]) -> Callable[[tuple[float, ...]], float]:
    if isinstance(node, ast.Constant) and type(node.value) in (int, float):
        number = float(node.value)
        if math.isfinite(number):
            return lambda _: number
    elif isinstance(node, ast.Name) and node.id in variables:
        index = variables.index(node.id)
        return lambda values: values[index]
    elif isinstance(node, ast.BinOp) and type(node.op) in _BINARY:
        left = _evaluator(node.left, variables)
        right = _evaluator(node.right, variables)
        operation = _BINARY[type(node.op)]
        return lambda values: _finite(operation(left(values), right(values)))
    elif isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
        operand = _evaluator(node.operand, variables)
        sign = -1.0 if isinstance(node.op, ast.USub) else 1.0
        return lambda values: sign * operand(values)
    elif (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        # Python's AST drops parentheses around a callee. The expression grammar
        # accepts a function name followed directly by its argument list.
        and node.col_offset == node.func.col_offset
        and not node.keywords
    ):
        if node.func.id in _FUNCTIONS and len(node.args) == 1:
            operand = _evaluator(node.args[0], variables)
            function = _FUNCTIONS[node.func.id]
            return lambda values: _finite(function(operand(values)))
        if variables == ("x", "y", "z") and node.func.id in ("min", "max") and len(node.args) == 2:
            left, right = (_evaluator(arg, variables) for arg in node.args)
            select = min if node.func.id == "min" else max
            return lambda values: select(left(values), right(values))
    raise ValueError(f"expression must use {', '.join(variables)}, decimal numbers, or supported math operators and functions")


def _parse(expression: str, variables: tuple[str, ...]) -> Callable[[tuple[float, ...]], float]:
    alphabet = r"[a-zA-Z0-9.+*/() \t-]+" if variables == ("u",) else r"[a-zA-Z0-9.+*/(), \t-]+"
    if not isinstance(expression, str) or len(expression) > 256 or re.fullmatch(alphabet, expression) is None:
        raise ValueError("expression must contain 1 to 256 ASCII math characters")
    if re.search(r"\b0[xob]", expression, flags=re.IGNORECASE):
        raise ValueError("expression numeric literals must be decimal")
    if re.search(r",\s*\)", expression):
        raise ValueError("expression argument lists cannot end with a comma")
    try:
        return _evaluator(ast.parse(expression.strip(), mode="eval").body, variables)
    except (SyntaxError, OverflowError) as error:
        raise ValueError("invalid absorbing boundary expression") from error


@lru_cache(maxsize=128)
def compile_distance_expression(expression: str) -> Callable[[float, float, float], float]:
    evaluate = _parse(expression, ("x", "y", "z"))

    def distance(x: float, y: float, z: float) -> float:
        try:
            return _finite(evaluate((x, y, z)))
        except (ValueError, ArithmeticError) as error:
            raise ValueError(f"distance expression is undefined at {(x, y, z)}") from error

    return distance


@lru_cache(maxsize=128)
def compile_expression(expression: str) -> _ScalarFunction:
    evaluate = _parse(expression, ("u",))

    def checked(u: float) -> float:
        try:
            value = evaluate((u,))
        except (ArithmeticError, ValueError) as error:
            raise ValueError(f"expression is undefined at u={u:g}") from error
        if not math.isfinite(value) or not -_TOLERANCE <= value <= 1 + _TOLERANCE:
            raise ValueError(f"expression must return a finite value in [0, 1] at u={u:g}")
        if u in (0.0, 1.0):
            if abs(value - u) > _TOLERANCE:
                raise ValueError("expression must equal 0 at u=0 and 1 at u=1")
            return u
        return max(0.0, min(1.0, value))

    for step in range(257):
        checked(step / 256)
    return checked
