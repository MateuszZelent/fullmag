"""Safe scalar expression evaluation for authored absorbing-boundary ramps."""

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


def _evaluator(node: ast.AST) -> _ScalarFunction:
    if isinstance(node, ast.Constant) and type(node.value) in (int, float):
        number = float(node.value)
        if math.isfinite(number):
            return lambda _: number
    elif isinstance(node, ast.Name) and node.id == "u":
        return lambda u: u
    elif isinstance(node, ast.BinOp) and type(node.op) in _BINARY:
        left = _evaluator(node.left)
        right = _evaluator(node.right)
        operation = _BINARY[type(node.op)]
        return lambda u: _finite(operation(left(u), right(u)))
    elif isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
        operand = _evaluator(node.operand)
        sign = -1.0 if isinstance(node.op, ast.USub) else 1.0
        return lambda u: sign * operand(u)
    elif (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id in _FUNCTIONS
        and len(node.args) == 1
        and not node.keywords
    ):
        operand = _evaluator(node.args[0])
        function = _FUNCTIONS[node.func.id]
        return lambda u: _finite(function(operand(u)))
    raise ValueError("expression must use u, decimal numbers, or supported math operators and functions")


@lru_cache(maxsize=128)
def compile_expression(expression: str) -> _ScalarFunction:
    if len(expression) > 256 or re.fullmatch(r"[a-zA-Z0-9.+*/() \t-]+", expression) is None:
        raise ValueError("expression must contain 1 to 256 ASCII math characters")
    if re.search(r"\b0[xob]", expression, flags=re.IGNORECASE):
        raise ValueError("expression numeric literals must be decimal")
    try:
        evaluate = _evaluator(ast.parse(expression.strip(), mode="eval").body)
    except (SyntaxError, OverflowError) as error:
        raise ValueError("invalid absorbing boundary expression") from error

    def checked(u: float) -> float:
        try:
            value = evaluate(u)
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
