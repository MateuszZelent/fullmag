"""Hand-written mask and time functions for field excitation.

Contract: ``docs/specs/mask-function-v1.md``. A mask function ``(x, y, z, ...)``
returns ``(Bx, By, Bz)`` in tesla; a time function ``(t, ...)`` returns one
dimensionless number. Both are written as ordinary Python in a restricted subset
and transpiled to ``field_expr.v1`` equations. Fullmag never calls them during a
run; the Rust planner and solvers evaluate the equations.

The same syntax-tree checker validates the formula strings of an absorbing
boundary layer (``compile_formula``, section 8 of the contract): a profile of
``u`` and a distance of ``x, y, z``, evaluated here for validation and sampling.
Material parameter fields (``fm.fields.function``, section 9) use the
transpiler and the formula checker with the kind ``field``; see
``fullmag.model.field_function``.

Values of the further parameters are given where the function is used::

    field = fm.mask(antenna_mask, B01=0.2 * mT, wavelength=279 * nm)
    drive = fm.time(antenna_time, frequency=3.6 * GHz, t0=0.0)
"""

from __future__ import annotations

import ast
import bisect
import inspect
import io
import linecache
import math
import re
import textwrap
import tokenize
from dataclasses import dataclass, replace
from dataclasses import field as _dataclass_field
from functools import lru_cache
from typing import Callable, Mapping

FIELD_EXPR_VERSION = "field_expr.v1"

_FUNCTIONS_1 = frozenset(
    {
        "sin",
        "cos",
        "tan",
        "asin",
        "acos",
        "atan",
        "sinh",
        "cosh",
        "tanh",
        "exp",
        "log",
        "sqrt",
        "abs",
    }
)
_FUNCTIONS_2 = frozenset({"atan2", "min", "max"})
# Profile and distance formulas also have log1p; it has no time opcode.
_FORMULA_FUNCTIONS_1 = _FUNCTIONS_1 | {"log1p"}
# A material field has the functions of a mask in field_expr.v1, heaviside included.
_FIELD_FUNCTIONS_1 = _FUNCTIONS_1 | {"heaviside"}
_MATH_ALIASES = {"fabs": "abs"}
# "space_time": one function of position and time, split into mask and time
# functions by fullmag.model.space_time before it reaches the IR. "profile" and
# "distance": formula strings of an absorbing boundary layer (compile_formula).
_VARIABLES = {
    "mask": ("x", "y", "z"),
    "time": ("t",),
    "space_time": ("x", "y", "z", "t"),
    "profile": ("u",),
    "distance": ("x", "y", "z"),
    "field": ("x", "y", "z"),
}
_RESERVED = (
    frozenset({"x", "y", "z", "t", "pi"}) | _FORMULA_FUNCTIONS_1 | _FIELD_FUNCTIONS_1 | _FUNCTIONS_2
)
# How a function of each kind is called in a script, for error messages.
_CALLS = {"mask": "fm.mask", "time": "fm.time", "field": "fm.fields.function"}
_AUGMENTED_OPERATORS = {ast.Add: "+", ast.Sub: "-", ast.Mult: "*", ast.Div: "/", ast.Pow: "**"}


class MaskFunctionError(ValueError):
    """A mask or time function cannot be transpiled.

    Messages start with ``line N:`` when they refer to the function's source, or
    with ``parameter 'name':`` when they refer to a value given at the call.
    """


@dataclass(frozen=True, slots=True)
class FunctionParameter:
    name: str
    value: float
    source: str | None = None

    def to_ir(self) -> dict[str, object]:
        payload: dict[str, object] = {"name": self.name, "value": self.value}
        if self.source is not None:
            payload["source"] = self.source
        return payload


@dataclass(frozen=True, slots=True)
class _TranspiledFunction:
    kind: str
    name: str
    parameter_names: tuple[str, ...]
    defaults: Mapping[str, float]
    default_sources: Mapping[str, str]
    captured: tuple[tuple[str, float], ...]
    locals: tuple[tuple[str, str], ...]
    outputs: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class LibraryCall:
    """The call of a ready antenna (``fullmag.antennas``) that produced a term."""

    function: str
    arguments: tuple[tuple[str, float], ...]
    call_token: int
    output_index: int


@dataclass(frozen=True, slots=True)
class _Function:
    """Equations of one function with its parameter values."""

    kind: str
    name: str
    parameters: tuple[FunctionParameter, ...]
    locals: tuple[tuple[str, str], ...]
    outputs: tuple[str, ...]
    # Set on masks returned by a ready antenna (``fullmag.antennas``); recorded as the
    # term's ``origin``, not part of the function's IR and not part of equality.
    library_call: LibraryCall | None = _dataclass_field(default=None, compare=False)

    def with_library_call(self, call: LibraryCall | None):
        return replace(self, library_call=call)

    def with_parameter(self, name: str, value: float):
        names = [parameter.name for parameter in self.parameters]
        if name not in names:
            raise MaskFunctionError(f"parameter {name!r}: {self.name} has no such parameter")
        value = _number(name, value)
        return replace(
            self,
            parameters=tuple(
                FunctionParameter(name, value) if parameter.name == name else parameter
                for parameter in self.parameters
            ),
        )

    def to_ir(self) -> dict[str, object]:
        payload: dict[str, object] = {"expression_version": FIELD_EXPR_VERSION, "name": self.name}
        if self.parameters:
            payload["parameters"] = [parameter.to_ir() for parameter in self.parameters]
        if self.locals:
            payload["locals"] = [
                {"name": name, "expression": expression} for name, expression in self.locals
            ]
        payload["outputs"] = list(self.outputs)
        return payload

    @classmethod
    def from_ir(cls, value: Mapping[str, object], *, kind: str, name: str):
        if value.get("expression_version") != FIELD_EXPR_VERSION:
            raise MaskFunctionError(f"{name}: expression_version must be {FIELD_EXPR_VERSION!r}")
        parameters = tuple(
            FunctionParameter(
                str(item["name"]),
                float(item["value"]),
                str(item["source"]) if item.get("source") is not None else None,
            )
            for item in value.get("parameters", ())
        )
        locals_ = tuple(
            (str(item["name"]), str(item["expression"])) for item in value.get("locals", ())
        )
        outputs = tuple(str(item) for item in value["outputs"])
        name = str(value.get("name") or name)
        return cls(kind=kind, name=name, parameters=parameters, locals=locals_, outputs=outputs)


class MaskFunction(_Function):
    """A transpiled mask function ``(x, y, z, ...) -> (Bx, By, Bz)`` in tesla."""

    __slots__ = ()


class TimeFunction(_Function):
    """A transpiled time function ``(t, ...) -> number``."""

    __slots__ = ()


def mask(function: Callable[..., object], /, **values: float) -> MaskFunction:
    """Transpile a mask function and bind the values of its further parameters."""
    return _bind(MaskFunction, _transpile(function, "mask"), values)


def time(function: Callable[..., object], /, **values: float) -> TimeFunction:
    """Transpile a time function and bind the values of its further parameters."""
    return _bind(TimeFunction, _transpile(function, "time"), values)


def _number(name: str, value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise MaskFunctionError(f"parameter {name!r}: value must be a real number, got {value!r}")
    number = float(value)
    if not math.isfinite(number):
        raise MaskFunctionError(f"parameter {name!r}: value must be finite, got {number!r}")
    return number


def _bind(cls, transpiled: _TranspiledFunction, values: Mapping[str, float]):
    unknown = sorted(set(values) - set(transpiled.parameter_names))
    if unknown:
        raise MaskFunctionError(
            f"parameter {unknown[0]!r}: {transpiled.name} has no such parameter "
            f"(parameters: {', '.join(transpiled.parameter_names) or 'none'})"
        )
    parameters = []
    for name in transpiled.parameter_names:
        if name in values:
            parameters.append(FunctionParameter(name, _number(name, values[name])))
        elif name in transpiled.defaults:
            parameters.append(
                FunctionParameter(
                    name,
                    _number(name, transpiled.defaults[name]),
                    transpiled.default_sources.get(name),
                )
            )
        else:
            raise MaskFunctionError(
                f"parameter {name!r}: no value; pass it as "
                f"{_CALLS.get(transpiled.kind, 'fm.' + transpiled.kind)}"
                f"({transpiled.name}, {name}=...)"
            )
    parameters.extend(FunctionParameter(name, value) for name, value in transpiled.captured)
    return cls(
        kind=transpiled.kind,
        name=transpiled.name,
        parameters=tuple(parameters),
        locals=transpiled.locals,
        outputs=transpiled.outputs,
    )


def _function_source(function: Callable[..., object]) -> tuple[str, int]:
    """Source of the function (dedented) and the file line of its first line."""
    if not inspect.isfunction(function):
        raise MaskFunctionError(
            f"line ?: {function!r} is not a Python function written with 'def'"
        )
    if function.__name__ == "<lambda>":
        raise MaskFunctionError(
            f"line {function.__code__.co_firstlineno}: a lambda cannot be a mask, time or field "
            "function; write it with 'def'"
        )
    try:
        lines, first_line = inspect.getsourcelines(function)
    except (OSError, TypeError) as error:
        raise MaskFunctionError(
            f"line {function.__code__.co_firstlineno}: the source of "
            f"{function.__name__} is not available ({error})"
        ) from None
    return textwrap.dedent("".join(lines)), max(first_line, 1)


def _transpile(function: Callable[..., object], kind: str) -> _TranspiledFunction:
    source, first_line = _function_source(function)
    try:
        module = ast.parse(source)
    except SyntaxError as error:
        raise MaskFunctionError(
            f"line {first_line + (error.lineno or 1) - 1}: {error.msg}"
        ) from None
    definition = next(
        (
            node
            for node in module.body
            if isinstance(node, ast.FunctionDef) and node.name == function.__name__
        ),
        None,
    )
    if definition is None:
        raise MaskFunctionError(
            f"line {first_line}: {function.__name__} must be defined with 'def'"
        )
    return _Transpiler(function, kind, source, first_line, definition).run()


class _ExpressionChecker:
    """Syntax-tree checker of the expressions of one function kind.

    Shared by the function transpiler and the formula strings; a subclass gives
    ``fail`` (how a position is reported) and ``check_name`` (which free names
    are allowed).
    """

    kind: str
    # math.pi and math.<function>(...) are allowed in transpiled functions only:
    # a formula string is stored as written, and field_expr.v1 has no ``.``.
    allow_math = True
    functions_1: frozenset[str] = _FUNCTIONS_1
    functions_2: frozenset[str] = _FUNCTIONS_2

    def fail(self, node: ast.AST, message: str) -> ValueError:
        raise NotImplementedError

    def check_name(self, node: ast.Name) -> None:
        raise NotImplementedError

    def check(self, node: ast.AST) -> None:
        if isinstance(node, ast.Constant):
            value = node.value
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise self.fail(node, f"only real numbers are allowed, not {value!r}")
            try:
                finite = math.isfinite(float(value))
            except OverflowError:
                finite = False
            if not finite:
                raise self.fail(node, "numbers must be finite")
            return
        if isinstance(node, ast.Name):
            self.check_name(node)
            return
        if isinstance(node, ast.Attribute):
            if (
                self.allow_math
                and isinstance(node.value, ast.Name)
                and node.value.id == "math"
                and node.attr == "pi"
            ):
                return
            raise self.fail(
                node,
                "attribute access is allowed only as math.pi or math.<function>(...)"
                if self.allow_math
                else "attribute access is not allowed; write pi and functions without 'math.'",
            )
        if isinstance(node, ast.UnaryOp):
            if not isinstance(node.op, (ast.UAdd, ast.USub)):
                raise self.fail(node, f"operator {type(node.op).__name__} is not allowed")
            self.check(node.operand)
            return
        if isinstance(node, ast.BinOp):
            if not isinstance(node.op, (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow)):
                raise self.fail(
                    node, f"operator {type(node.op).__name__} is not allowed; use + - * / **"
                )
            self.check(node.left)
            self.check(node.right)
            return
        if isinstance(node, ast.Call):
            self.check_call(node)
            return
        raise self.fail(
            node,
            f"{type(node).__name__} is not allowed in a {self.kind} function; "
            "use an array mask for general Python code"
            if self.allow_math
            else f"{type(node).__name__} is not allowed in a {self.kind} formula",
        )

    def check_call(self, node: ast.Call) -> None:
        if node.keywords:
            raise self.fail(node, "functions take positional arguments only")
        func = node.func
        if isinstance(func, ast.Name):
            name = func.id
        elif (
            self.allow_math
            and isinstance(func, ast.Attribute)
            and isinstance(func.value, ast.Name)
            and func.value.id == "math"
        ):
            name = _MATH_ALIASES.get(func.attr, func.attr)
        else:
            raise self.fail(node, "only math functions may be called")
        # ``ast`` drops parentheses: ``(sin)(x)`` starts at the parenthesis and
        # its callee one character later. field_expr.v1 cannot read it.
        if (func.lineno, func.col_offset) != (node.lineno, node.col_offset):
            raise self.fail(node, f"write the function name {name!r} without parentheses around it")
        if name in self.functions_1:
            arity = 1
        elif name in self.functions_2:
            arity = 2
        else:
            raise self.fail(
                node,
                f"function {name!r} is not allowed; available: "
                f"{', '.join(sorted(self.functions_1 | self.functions_2))}",
            )
        if len(node.args) != arity or any(isinstance(arg, ast.Starred) for arg in node.args):
            raise self.fail(node, f"{name} takes {arity} argument(s)")
        for argument in node.args:
            self.check(argument)


class _Transpiler(_ExpressionChecker):
    def __init__(
        self,
        function: Callable[..., object],
        kind: str,
        source: str,
        first_line: int,
        definition: ast.FunctionDef,
    ) -> None:
        self.function = function
        self.kind = kind
        if kind == "field":
            self.functions_1 = _FIELD_FUNCTIONS_1
        self.source = source
        self.first_line = first_line
        self.definition = definition
        self.variables = _VARIABLES[kind]
        self.parameters: list[str] = []
        self.locals: list[tuple[str, str]] = []
        # Python name -> name of its current version in the equations. A name
        # assigned again gets a new version (g, g_2, ...), as in SSA form.
        self.current: dict[str, str] = {}
        self.captured: dict[str, float] = {}
        self.closure = _closure_values(function)
        self.assigned: set[str] = set()
        for statement in definition.body:
            if isinstance(statement, ast.Assign):
                targets = statement.targets
            elif isinstance(statement, ast.AugAssign):
                targets = [statement.target]
            else:
                continue
            self.assigned.update(target.id for target in targets if isinstance(target, ast.Name))

    def line(self, node: ast.AST) -> int:
        return self.first_line + getattr(node, "lineno", 1) - 1

    def fail(self, node: ast.AST, message: str) -> MaskFunctionError:
        return MaskFunctionError(f"line {self.line(node)}: {message}")

    def run(self) -> _TranspiledFunction:
        definition = self.definition
        if definition.decorator_list:
            raise self.fail(definition, f"{definition.name} must not be decorated")
        arguments = definition.args
        if (
            arguments.posonlyargs
            or arguments.vararg
            or arguments.kwonlyargs
            or arguments.kwarg
        ):
            raise self.fail(
                definition,
                f"{definition.name} may use only plain positional parameters "
                "(no /, *, *args or **kwargs)",
            )
        names = [argument.arg for argument in arguments.args]
        expected = list(self.variables)
        if names[: len(expected)] != expected:
            raise self.fail(
                definition,
                f"a {self.kind} function must start with the parameters "
                f"{', '.join(expected)}; got {', '.join(names) or 'none'}",
            )
        self.parameters = names[len(expected) :]
        for name in self.parameters:
            if name in _RESERVED:
                raise self.fail(definition, f"parameter name {name!r} is reserved")

        defaults: dict[str, float] = {}
        default_sources: dict[str, str] = {}
        default_nodes = arguments.defaults
        defaulted = names[len(names) - len(default_nodes) :]
        values = self.function.__defaults__ or ()
        for name, node, value in zip(defaulted, default_nodes, values):
            if name in self.variables:
                raise self.fail(node, f"{name} must not have a default")
            defaults[name] = value
            text = ast.get_source_segment(self.source, node)
            if text is not None:
                default_sources[name] = " ".join(text.split())

        body = list(definition.body)
        if (
            body
            and isinstance(body[0], ast.Expr)
            and isinstance(body[0].value, ast.Constant)
            and isinstance(body[0].value.value, str)
        ):
            body = body[1:]
        if not body or not isinstance(body[-1], ast.Return):
            raise self.fail(
                body[-1] if body else definition,
                f"{definition.name} must end with a return statement",
            )
        self.current = {name: name for name in (*self.variables, *self.parameters)}
        used = set(names) | {
            node.id for node in ast.walk(definition) if isinstance(node, ast.Name)
        }
        versions: dict[str, int] = {}
        for statement in body[:-1]:
            name, expression = self.assignment(statement)
            if name in self.current:
                version = versions.get(name, 1) + 1
                versioned = f"{name}_{version}"
                while versioned in used:
                    version += 1
                    versioned = f"{name}_{version}"
                versions[name] = version
                used.add(versioned)
            else:
                versioned = name
            self.locals.append((versioned, expression))
            self.current[name] = versioned

        returned = body[-1].value
        if returned is None:
            raise self.fail(body[-1], "return a value")
        if self.kind in ("mask", "space_time"):
            if not isinstance(returned, ast.Tuple) or len(returned.elts) != 3:
                raise self.fail(returned, "a mask function must return a tuple (Bx, By, Bz)")
            outputs = tuple(self.expression(element) for element in returned.elts)
        else:
            if isinstance(returned, ast.Tuple):
                raise self.fail(returned, f"a {self.kind} function must return one number")
            outputs = (self.expression(returned),)

        return _TranspiledFunction(
            kind=self.kind,
            name=definition.name,
            parameter_names=tuple(self.parameters),
            defaults=defaults,
            default_sources=default_sources,
            captured=tuple(self.captured.items()),
            locals=tuple(self.locals),
            outputs=outputs,
        )

    def assignment(self, statement: ast.stmt) -> tuple[str, str]:
        """Name and equation of one ``name = ...`` or ``name op= ...`` line."""
        if isinstance(statement, ast.Assign):
            if len(statement.targets) != 1 or not isinstance(statement.targets[0], ast.Name):
                raise self.fail(statement, "assign to exactly one plain name")
            name = statement.targets[0].id
            self.check_target(statement, name)
            return name, self.expression(statement.value)
        if isinstance(statement, ast.AugAssign):
            if not isinstance(statement.target, ast.Name):
                raise self.fail(statement, "assign to exactly one plain name")
            name = statement.target.id
            self.check_target(statement, name)
            operator = _AUGMENTED_OPERATORS.get(type(statement.op))
            if operator is None:
                raise self.fail(
                    statement,
                    f"operator {type(statement.op).__name__} is not allowed; "
                    "use += -= *= /= **=",
                )
            if name not in self.current:
                raise self.fail(statement, f"local {name!r} is used before it is assigned")
            return name, f"{self.current[name]} {operator} ({self.expression(statement.value)})"
        raise self.fail(
            statement,
            "only 'name = expression' lines (also += -= *= /= **=) and one final return "
            f"are allowed, not {type(statement).__name__}; use an array mask for other code",
        )

    def check_target(self, statement: ast.stmt, name: str) -> None:
        if name in _RESERVED and name not in self.variables:
            raise self.fail(statement, f"name {name!r} is reserved")

    # -- expressions -----------------------------------------------------

    def expression(self, node: ast.expr) -> str:
        self.check(node)
        text = ast.get_source_segment(self.source, node)
        if text is None:
            raise self.fail(node, "cannot read the source of this expression")
        renames = {name: version for name, version in self.current.items() if name != version}
        return _to_field_expr(text, renames)

    def check_name(self, node: ast.Name) -> None:
        name = node.id
        if name in self.current:
            return
        if name == "pi":
            return
        if name in {"x", "y", "z", "t"}:
            raise self.fail(node, f"{name!r} cannot be used in a {self.kind} function")
        if name in self.functions_1 or name in _FUNCTIONS_2:
            raise self.fail(node, f"function {name!r} must be called")
        if name in self.assigned:
            raise self.fail(node, f"local {name!r} is used before it is assigned")
        if name in self.captured:
            return
        value = self.closure.get(name, self.function.__globals__.get(name, _MISSING))
        if value is _MISSING:
            raise self.fail(node, f"name {name!r} is not a parameter, a local or a number")
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise self.fail(
                node,
                f"name {name!r} refers to {type(value).__name__}; only numbers can be captured",
            )
        number = float(value)
        if not math.isfinite(number):
            raise self.fail(node, f"captured number {name!r} must be finite")
        self.captured[name] = number


_MISSING = object()


# -- formula strings (absorbing boundary layer) ----------------------------

# Rust ``fullmag-expr``: nesting of parentheses, argument lists, unary signs and
# exponents per equation.
_MAX_FORMULA_NESTING = 128
_FORMULA_OPERATORS = frozenset({"+", "-", "*", "/", "**", "(", ")", ","})
_FORMULA_NUMBER = re.compile(r"(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")
_SKIPPED_TOKENS = frozenset(
    {tokenize.NEWLINE, tokenize.NL, tokenize.INDENT, tokenize.DEDENT, tokenize.ENDMARKER}
)


class FormulaError(ValueError):
    """A formula string is not a ``field_expr.v1`` formula of its kind.

    Messages start with ``character N:``, the zero-based position in the text.
    """


class _FormulaChecker(_ExpressionChecker):
    allow_math = False
    functions_1 = _FORMULA_FUNCTIONS_1

    def __init__(self, kind: str, offset: int) -> None:
        self.kind = kind
        self.variables = _VARIABLES[kind]
        self.offset = offset

    def fail(self, node: ast.AST, message: str) -> FormulaError:
        return FormulaError(f"character {self.offset + getattr(node, 'col_offset', 0)}: {message}")

    def check_name(self, node: ast.Name) -> None:
        name = node.id
        if name in self.variables or name == "pi":
            return
        if name in {"x", "y", "z", "t", "u"}:
            raise self.fail(
                node,
                f"a {self.kind} formula may use only {', '.join(self.variables)}, not {name!r}",
            )
        if name in self.functions_1 or name in self.functions_2:
            raise self.fail(node, f"function {name!r} must be called")
        raise self.fail(
            node, f"name {name!r} is not {', '.join(self.variables)}, pi or a function"
        )


def compile_formula(text: str, kind: str) -> Callable[..., float]:
    """Check a profile (``u``) or distance (``x, y, z``) formula and return its evaluator.

    The text is checked with the syntax-tree rules of the transpiled functions
    and with the token rules that ``ast`` does not keep (literal spellings, a
    trailing comma, nesting depth), so that exactly the texts that
    ``fullmag-expr`` reads are accepted. The evaluator follows IEEE-754 like the
    Rust one: it returns ``inf`` or ``nan`` where ``math`` raises. The value is
    not checked; ``FormulaError`` is raised for a text outside the language.
    """
    if kind not in ("profile", "distance"):
        raise ValueError(f"unknown formula kind {kind!r}")
    if not isinstance(text, str):
        raise FormulaError(f"character 0: a formula is a string, not {type(text).__name__}")
    return _compile_formula(text, kind)


@lru_cache(maxsize=256)
def _compile_formula(text: str, kind: str) -> Callable[..., float]:
    tree = _check_formula_text(text, lambda offset: _FormulaChecker(kind, offset))
    return _evaluator(tree, _VARIABLES[kind])


def _check_formula_text(
    text: str, make_checker: Callable[[int], _ExpressionChecker]
) -> ast.expr:
    """The checked syntax tree of one formula line.

    ``make_checker`` builds the checker of the formula's kind from the column
    of the first character after leading blanks.
    """
    if not text.isascii():
        position = next(index for index, character in enumerate(text) if not character.isascii())
        raise FormulaError(f"character {position}: only ASCII characters are allowed")
    for index, character in enumerate(text):
        if character in "\r\n":
            raise FormulaError(f"character {index}: a formula is one line")
    offset = len(text) - len(text.lstrip(" \t"))
    stripped = text.strip(" \t")
    if not stripped:
        raise FormulaError("character 0: the formula is empty")
    tokens = _formula_tokens(stripped, offset)
    try:
        tree = ast.parse(stripped, mode="eval").body
    except SyntaxError as error:
        column = (error.offset or 1) - 1
        raise FormulaError(f"character {offset + column}: {error.msg}") from None
    except (ValueError, RecursionError, MemoryError) as error:
        raise FormulaError(f"character {offset}: {error}") from None
    checker = make_checker(offset)
    try:
        checker.check(tree)
    except RecursionError:
        raise FormulaError(f"character {offset}: the formula is nested too deeply") from None
    _check_formula_nesting(tree, tokens, offset)
    return tree


def _formula_tokens(text: str, offset: int) -> list[tokenize.TokenInfo]:
    """Tokens of one formula line; rejects tokens ``field_expr.v1`` cannot read."""
    try:
        tokens = [
            token
            for token in tokenize.generate_tokens(io.StringIO(text).readline)
            if token.type not in _SKIPPED_TOKENS
        ]
    except (tokenize.TokenError, SyntaxError) as error:
        raise FormulaError(f"character {offset}: {error}") from None
    for index, token in enumerate(tokens):
        position = offset + token.start[1]
        if token.type == tokenize.NUMBER:
            if _FORMULA_NUMBER.fullmatch(token.string) is None:
                raise FormulaError(
                    f"character {position}: write the number {token.string!r} in decimal "
                    "or scientific notation without '_'"
                )
        elif token.type == tokenize.OP:
            if token.string not in _FORMULA_OPERATORS:
                raise FormulaError(f"character {position}: {token.string!r} is not allowed")
            following = tokens[index + 1] if index + 1 < len(tokens) else None
            if token.string == "," and following is not None and following.string == ")":
                raise FormulaError(f"character {position}: an argument list cannot end with ','")
        elif token.type != tokenize.NAME:
            raise FormulaError(f"character {position}: {token.string!r} is not allowed")
    return tokens


def _check_formula_nesting(
    tree: ast.expr, tokens: list[tokenize.TokenInfo], offset: int
) -> None:
    """The nesting limit of ``fullmag-expr``: each open parenthesis, unary sign and
    exponent around a number or a name is one level."""
    opened: list[int] = []
    depth = 0
    for token in tokens:
        if token.string == "(":
            depth += 1
        elif token.string == ")":
            depth -= 1
        opened.append(depth)
    starts = [token.start[1] for token in tokens]

    def parentheses_before(column: int) -> int:
        index = bisect.bisect_left(starts, column)
        return opened[index - 1] if index > 0 else 0

    stack: list[tuple[ast.AST, int]] = [(tree, 0)]
    while stack:
        node, levels = stack.pop()
        if isinstance(node, (ast.Constant, ast.Name)):
            if levels + parentheses_before(node.col_offset) > _MAX_FORMULA_NESTING:
                raise FormulaError(
                    f"character {offset + node.col_offset}: the formula is nested deeper "
                    f"than {_MAX_FORMULA_NESTING} levels"
                )
        elif isinstance(node, ast.UnaryOp):
            stack.append((node.operand, levels + 1))
        elif isinstance(node, ast.BinOp):
            stack.append((node.left, levels))
            stack.append((node.right, levels + 1 if isinstance(node.op, ast.Pow) else levels))
        elif isinstance(node, ast.Call):
            stack.extend((argument, levels) for argument in node.args)


def _is_odd_integer(value: float) -> bool:
    return math.isfinite(value) and value == math.floor(value) and math.fmod(value, 2.0) != 0.0


def _ieee_div(left: float, right: float) -> float:
    try:
        return left / right
    except ZeroDivisionError:
        if math.isnan(left) or left == 0.0:
            return math.nan
        return math.copysign(math.inf, left) * math.copysign(1.0, right)


def _ieee_pow(base: float, exponent: float) -> float:
    try:
        return math.pow(base, exponent)
    except OverflowError:
        negative = base < 0.0 and _is_odd_integer(exponent)
        return -math.inf if negative else math.inf
    except ValueError:
        if base == 0.0 and exponent < 0.0:
            return math.copysign(math.inf, base) if _is_odd_integer(exponent) else math.inf
        return math.nan


def _ieee_log(value: float) -> float:
    if value == 0.0:
        return -math.inf
    return math.log(value) if value > 0.0 or math.isnan(value) else math.nan


def _ieee_log1p(value: float) -> float:
    if value == -1.0:
        return -math.inf
    return math.log1p(value) if value > -1.0 or math.isnan(value) else math.nan


def _ieee(function: Callable[[float], float], overflow: Callable[[float], float]):
    """``function`` with ``math``'s exceptions replaced by IEEE-754 results."""

    def evaluate(value: float) -> float:
        try:
            return function(value)
        except OverflowError:
            return overflow(value)
        except ValueError:
            return math.nan

    return evaluate


def _ieee_min(left: float, right: float) -> float:
    """Rust ``f64::min``: a NaN operand gives the other one."""
    if math.isnan(left):
        return right
    if math.isnan(right):
        return left
    return left if left <= right else right


def _ieee_max(left: float, right: float) -> float:
    if math.isnan(left):
        return right
    if math.isnan(right):
        return left
    return left if left >= right else right


def _heaviside(value: float) -> float:
    """``fullmag-expr`` heaviside: 0, 1/2 at 0, 1; NaN for a non-finite argument."""
    if not math.isfinite(value):
        return math.nan
    if value == 0.0:
        return 0.5
    return 1.0 if value > 0.0 else 0.0


def _signed_infinity(value: float) -> float:
    return math.copysign(math.inf, value)


def _infinity(_: float) -> float:
    return math.inf


_FORMULA_EVALUATORS_1: dict[str, Callable[[float], float]] = {
    "sin": _ieee(math.sin, _infinity),
    "cos": _ieee(math.cos, _infinity),
    "tan": _ieee(math.tan, _infinity),
    "asin": _ieee(math.asin, _infinity),
    "acos": _ieee(math.acos, _infinity),
    "atan": math.atan,
    "sinh": _ieee(math.sinh, _signed_infinity),
    "cosh": _ieee(math.cosh, _infinity),
    "tanh": math.tanh,
    "exp": _ieee(math.exp, _infinity),
    "log": _ieee_log,
    "log1p": _ieee_log1p,
    "sqrt": _ieee(math.sqrt, _infinity),
    "abs": math.fabs,
    "heaviside": _heaviside,
}
_FORMULA_EVALUATORS_2: dict[str, Callable[[float, float], float]] = {
    "atan2": math.atan2,
    "min": _ieee_min,
    "max": _ieee_max,
}
_FORMULA_BINARY: dict[type, Callable[[float, float], float]] = {
    ast.Add: lambda left, right: left + right,
    ast.Sub: lambda left, right: left - right,
    ast.Mult: lambda left, right: left * right,
    ast.Div: _ieee_div,
    ast.Pow: _ieee_pow,
}


def _evaluator(node: ast.expr, variables: tuple[str, ...]) -> Callable[..., float]:
    """Evaluator of a checked formula tree; called with the variable values."""
    if isinstance(node, ast.Constant):
        number = float(node.value)
        return lambda *values: number
    if isinstance(node, ast.Name):
        if node.id == "pi":
            return lambda *values: math.pi
        index = variables.index(node.id)
        return lambda *values: float(values[index])
    if isinstance(node, ast.UnaryOp):
        operand = _evaluator(node.operand, variables)
        if isinstance(node.op, ast.USub):
            return lambda *values: -operand(*values)
        return operand
    if isinstance(node, ast.BinOp):
        left = _evaluator(node.left, variables)
        right = _evaluator(node.right, variables)
        operation = _FORMULA_BINARY[type(node.op)]
        return lambda *values: operation(left(*values), right(*values))
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
        arguments = [_evaluator(argument, variables) for argument in node.args]
        if len(arguments) == 1:
            function_1 = _FORMULA_EVALUATORS_1[node.func.id]
            argument = arguments[0]
            return lambda *values: function_1(argument(*values))
        function_2 = _FORMULA_EVALUATORS_2[node.func.id]
        first, second = arguments
        return lambda *values: function_2(first(*values), second(*values))
    raise AssertionError(f"unchecked formula node {type(node).__name__}")


def _closure_values(function: Callable[..., object]) -> dict[str, object]:
    cells = function.__closure__ or ()
    values: dict[str, object] = {}
    for name, cell in zip(function.__code__.co_freevars, cells):
        try:
            values[name] = cell.cell_contents
        except ValueError:
            continue
    return values


def _to_field_expr(text: str, renames: Mapping[str, str] | None = None) -> str:
    """Rewrite a checked Python expression as ``field_expr.v1`` text.

    Formatting, parentheses and ``**`` are kept; ``math.`` is
    dropped, ``math.fabs`` becomes ``abs``, comments and line breaks become
    spaces, numbers that ``field_expr.v1`` cannot read (``1_000``) are
    written with ``repr``, and names in ``renames`` are replaced by their
    current version.
    """
    renames = renames or {}
    # Parentheses make line breaks inside the expression plain NL tokens.
    tokens = list(tokenize.generate_tokens(io.StringIO("(" + text.strip() + ")").readline))
    parts: list[str] = []
    previous_end: tuple[int, int] | None = None
    skip_dot = False
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token.type in (tokenize.NL, tokenize.NEWLINE, tokenize.COMMENT, tokenize.ENDMARKER):
            index += 1
            previous_end = None
            if parts and not parts[-1].endswith(" "):
                parts.append(" ")
            continue
        if previous_end is not None and token.start[0] == previous_end[0]:
            gap = token.start[1] - previous_end[1]
            if gap > 0:
                parts.append(" " * gap)
        previous_end = token.end
        if token.type == tokenize.NAME and token.string == "math":
            following = tokens[index + 1] if index + 1 < len(tokens) else None
            if following is not None and following.string == ".":
                skip_dot = True
                index += 1
                continue
        if skip_dot and token.string == ".":
            skip_dot = False
            index += 1
            continue
        skip_dot = False
        if token.type == tokenize.NAME and token.string in _MATH_ALIASES and _previous_was_math(tokens, index):
            parts.append(_MATH_ALIASES[token.string])
        elif token.type == tokenize.NUMBER:
            parts.append(_number_text(token.string))
        elif (
            token.type == tokenize.NAME
            and token.string in renames
            and tokens[index - 1].string != "."
        ):
            parts.append(renames[token.string])
        else:
            parts.append(token.string)
        index += 1
    joined = " ".join("".join(parts).split())
    return joined[1:-1].strip()


def _previous_was_math(tokens: list[tokenize.TokenInfo], index: int) -> bool:
    return index >= 2 and tokens[index - 1].string == "." and tokens[index - 2].string == "math"


def _number_text(text: str) -> str:
    lowered = text.lower()
    if "_" in text or lowered.startswith(("0x", "0o", "0b")) or lowered.endswith("j"):
        value = ast.literal_eval(text)
        if isinstance(value, complex):
            raise MaskFunctionError(f"line ?: complex number {text!r} is not allowed")
        return repr(float(value)) if isinstance(value, float) else repr(value)
    return text


def register_script_source(filename: str, source: str) -> None:
    """Make ``inspect`` read functions of a script executed from captured text."""
    lines = source.splitlines(keepends=True)
    linecache.cache[filename] = (len(source), None, lines, filename)


__all__ = [
    "FIELD_EXPR_VERSION",
    "FormulaError",
    "FunctionParameter",
    "LibraryCall",
    "MaskFunction",
    "MaskFunctionError",
    "TimeFunction",
    "mask",
    "register_script_source",
    "time",
]
