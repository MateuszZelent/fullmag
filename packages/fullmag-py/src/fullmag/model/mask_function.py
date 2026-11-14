"""Hand-written mask and time functions for field excitation.

Contract: ``docs/specs/mask-function-v1.md``. A mask function ``(x, y, z, ...)``
returns ``(Bx, By, Bz)`` in tesla; a time function ``(t, ...)`` returns one
dimensionless number. Both are written as ordinary Python in a restricted subset
and transpiled to ``field_expr.v1`` equations. Fullmag never calls them during a
run; the Rust planner and solvers evaluate the equations.

Values of the further parameters are given where the function is used::

    field = fm.mask(antenna_mask, B01=0.2 * mT, wavelength=279 * nm)
    drive = fm.time(antenna_time, frequency=3.6 * GHz, t0=0.0)
"""

from __future__ import annotations

import ast
import inspect
import io
import linecache
import math
import textwrap
import tokenize
from dataclasses import dataclass, replace
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
_MATH_ALIASES = {"fabs": "abs"}
_VARIABLES = {"mask": ("x", "y", "z"), "time": ("t",)}
_RESERVED = frozenset({"x", "y", "z", "t", "pi"}) | _FUNCTIONS_1 | _FUNCTIONS_2
_AUGMENTED_OPERATORS = {ast.Add: "+", ast.Sub: "-", ast.Mult: "*", ast.Div: "/", ast.Pow: "^"}


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
class _Function:
    """Equations of one function with its parameter values."""

    kind: str
    name: str
    parameters: tuple[FunctionParameter, ...]
    locals: tuple[tuple[str, str], ...]
    outputs: tuple[str, ...]

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
        payload: dict[str, object] = {"expression_version": FIELD_EXPR_VERSION}
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
                f"fm.{transpiled.kind}({transpiled.name}, {name}=...)"
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
            f"line {function.__code__.co_firstlineno}: a lambda cannot be a mask or "
            "time function; write it with 'def'"
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


class _Transpiler:
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
        if self.kind == "mask":
            if not isinstance(returned, ast.Tuple) or len(returned.elts) != 3:
                raise self.fail(returned, "a mask function must return a tuple (Bx, By, Bz)")
            outputs = tuple(self.expression(element) for element in returned.elts)
        else:
            if isinstance(returned, ast.Tuple):
                raise self.fail(returned, "a time function must return one number")
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

    def check(self, node: ast.AST) -> None:
        if isinstance(node, ast.Constant):
            value = node.value
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise self.fail(node, f"only real numbers are allowed, not {value!r}")
            if not math.isfinite(float(value)):
                raise self.fail(node, "numbers must be finite")
            return
        if isinstance(node, ast.Name):
            self.check_name(node)
            return
        if isinstance(node, ast.Attribute):
            if isinstance(node.value, ast.Name) and node.value.id == "math" and node.attr == "pi":
                return
            raise self.fail(node, "attribute access is allowed only as math.pi or math.<function>(...)")
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
            "use an array mask for general Python code",
        )

    def check_call(self, node: ast.Call) -> None:
        if node.keywords:
            raise self.fail(node, "functions take positional arguments only")
        func = node.func
        if isinstance(func, ast.Name):
            name = func.id
        elif (
            isinstance(func, ast.Attribute)
            and isinstance(func.value, ast.Name)
            and func.value.id == "math"
        ):
            name = _MATH_ALIASES.get(func.attr, func.attr)
        else:
            raise self.fail(node, "only math functions may be called")
        if name in _FUNCTIONS_1:
            arity = 1
        elif name in _FUNCTIONS_2:
            arity = 2
        else:
            raise self.fail(
                node,
                f"function {name!r} is not allowed; available: "
                f"{', '.join(sorted(_FUNCTIONS_1 | _FUNCTIONS_2))}",
            )
        if len(node.args) != arity or any(isinstance(arg, ast.Starred) for arg in node.args):
            raise self.fail(node, f"{name} takes {arity} argument(s)")
        for argument in node.args:
            self.check(argument)

    def check_name(self, node: ast.Name) -> None:
        name = node.id
        if name in self.current:
            return
        if name == "pi":
            return
        if name in {"x", "y", "z", "t"}:
            raise self.fail(node, f"{name!r} cannot be used in a {self.kind} function")
        if name in _FUNCTIONS_1 or name in _FUNCTIONS_2:
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

    Formatting and parentheses are kept; ``**`` becomes ``^``, ``math.`` is
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
        if token.type == tokenize.OP and token.string == "**":
            parts.append("^")
        elif token.type == tokenize.NAME and token.string in _MATH_ALIASES and _previous_was_math(tokens, index):
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
    "FunctionParameter",
    "MaskFunction",
    "MaskFunctionError",
    "TimeFunction",
    "mask",
    "register_script_source",
    "time",
]
