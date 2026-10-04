"""Static inspection of a Python script that is never executed.

Used by ``python -m fullmag.runtime.helper inspect-script`` and, through it, by
``fullmag script inspect``. The script is only read, hashed and parsed with
:mod:`ast`; it is never imported, compiled for execution or run. Module
availability is checked with :func:`importlib.util.find_spec` for *top-level*
names only, because ``find_spec("a.b")`` imports the parent package ``a`` and
would execute third-party code.

Schema: ``fullmag.script_inspect.v1`` (docs/design/start-screen/docs/08-script-open.md
section 6.2). The ``interpreter`` member is added by the Rust CLI, which knows
which interpreter it ran.
"""

from __future__ import annotations

import ast
import hashlib
import importlib.util
import operator
import sys
from pathlib import Path
from typing import Any

SCRIPT_INSPECT_SCHEMA = "fullmag.script_inspect.v1"

_UTF8_BOM = b"\xef\xbb\xbf"
_OTHER_BOMS = (b"\xff\xfe", b"\xfe\xff", b"\xff\xfe\x00\x00", b"\x00\x00\xfe\xff")

_BINARY_OPERATORS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.Pow: operator.pow,
}


def inspect_script(path: str | Path) -> dict[str, Any]:
    """Return the static facts of ``path`` without executing it."""
    script_path = Path(path)
    raw = script_path.read_bytes()
    result: dict[str, Any] = {
        "schema": SCRIPT_INSPECT_SCHEMA,
        "sha256": hashlib.sha256(raw).hexdigest(),
        "bytes": len(raw),
    }

    encoding, text, decode_error = _decode(raw)
    result["encoding"] = encoding
    result["lines"] = len(text.splitlines()) if text is not None else raw.count(b"\n") + (
        1 if raw and not raw.endswith(b"\n") else 0
    )

    if text is None:
        result["syntax"] = {"ok": False, "line": None, "column": None, "message": decode_error}
        result.update(_empty_analysis())
        return result

    try:
        tree = ast.parse(text, filename=str(script_path))
    except SyntaxError as error:
        result["syntax"] = {
            "ok": False,
            "line": error.lineno,
            "column": error.offset,
            "message": error.msg,
        }
        result.update(_empty_analysis())
        return result
    except ValueError as error:  # for example source containing null bytes
        result["syntax"] = {"ok": False, "line": None, "column": None, "message": str(error)}
        result.update(_empty_analysis())
        return result

    result["syntax"] = {"ok": True}
    result["summary"] = _summary(tree)
    result["imports"] = _imports(tree, script_path.resolve().parent)
    result["env_reads"] = _env_reads(tree)
    result["declares"] = {
        "default_until": _declared_default_until(tree),
        "interactive": _declared_interactive(tree),
    }
    return result


def _empty_analysis() -> dict[str, Any]:
    return {
        "summary": None,
        "imports": {"fullmag": False, "unresolved": [], "local": [], "top_level": []},
        "env_reads": [],
        "declares": {"default_until": None, "interactive": None},
    }


def _decode(raw: bytes) -> tuple[str, str | None, str | None]:
    """Classify the encoding. Only UTF-8 (optionally with BOM) is accepted."""
    if raw.startswith(_UTF8_BOM):
        try:
            return "utf-8-bom", raw[len(_UTF8_BOM) :].decode("utf-8"), None
        except UnicodeDecodeError as error:
            return "other", None, f"not valid UTF-8 after the byte order mark: {error}"
    if raw.startswith(_OTHER_BOMS):
        return "other", None, "UTF-16/UTF-32 byte order mark; Fullmag scripts must be UTF-8"
    try:
        return "utf-8", raw.decode("utf-8"), None
    except UnicodeDecodeError as error:
        return "other", None, f"not valid UTF-8: {error}"


def _summary(tree: ast.Module) -> str | None:
    docstring = ast.get_docstring(tree)
    if not docstring:
        return None
    for line in docstring.splitlines():
        line = line.strip()
        if line:
            return line
    return None


def _imports(tree: ast.Module, script_dir: Path) -> dict[str, Any]:
    top_level: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                top_level.add(alias.name.split(".", 1)[0])
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            top_level.add(node.module.split(".", 1)[0])

    stdlib = set(getattr(sys, "stdlib_module_names", ())) | set(sys.builtin_module_names)
    local: list[str] = []
    unresolved: list[str] = []
    for name in sorted(top_level):
        if name in stdlib or name == "__future__":
            continue
        if (script_dir / f"{name}.py").is_file() or (script_dir / name).is_dir():
            local.append(name)
            continue
        if not _top_level_spec_exists(name):
            unresolved.append(name)
    return {
        "fullmag": "fullmag" in top_level,
        "unresolved": unresolved,
        "local": local,
        "top_level": sorted(top_level),
    }


def _top_level_spec_exists(name: str) -> bool:
    # A top-level name never imports a parent package, so no third-party code runs.
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError, AttributeError):
        return False


def _env_reads(tree: ast.Module) -> list[str]:
    os_names: set[str] = set()
    environ_names: set[str] = set()
    getenv_names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == "os":
                    os_names.add(alias.asname or "os")
        elif isinstance(node, ast.ImportFrom) and node.module == "os" and node.level == 0:
            for alias in node.names:
                if alias.name == "environ":
                    environ_names.add(alias.asname or "environ")
                elif alias.name == "getenv":
                    getenv_names.add(alias.asname or "getenv")

    def is_environ(node: ast.AST) -> bool:
        if isinstance(node, ast.Name):
            return node.id in environ_names
        return (
            isinstance(node, ast.Attribute)
            and node.attr == "environ"
            and isinstance(node.value, ast.Name)
            and node.value.id in os_names
        )

    def is_getenv(node: ast.AST) -> bool:
        if isinstance(node, ast.Name):
            return node.id in getenv_names
        return (
            isinstance(node, ast.Attribute)
            and node.attr == "getenv"
            and isinstance(node.value, ast.Name)
            and node.value.id in os_names
        )

    def literal_key(node: ast.AST | None) -> str | None:
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        return None

    keys: set[str] = set()
    for node in ast.walk(tree):
        key: str | None = None
        if isinstance(node, ast.Subscript) and is_environ(node.value):
            key = literal_key(node.slice)
        elif isinstance(node, ast.Call) and node.args:
            func = node.func
            if is_getenv(func):
                key = literal_key(node.args[0])
            elif (
                isinstance(func, ast.Attribute)
                and func.attr in {"get", "setdefault", "pop"}
                and is_environ(func.value)
            ):
                key = literal_key(node.args[0])
        elif (
            isinstance(node, ast.Compare)
            and len(node.ops) == 1
            and isinstance(node.ops[0], (ast.In, ast.NotIn))
            and is_environ(node.comparators[0])
        ):
            key = literal_key(node.left)
        if key is not None:
            keys.add(key)
    return sorted(keys)


def _literal_number(node: ast.AST) -> float | None:
    """Evaluate a numeric literal expression such as ``1e-9`` or ``2 * 1e-9``."""
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        if isinstance(node.value, bool):
            return None
        return float(node.value)
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
        value = _literal_number(node.operand)
        if value is None:
            return None
        return value if isinstance(node.op, ast.UAdd) else -value
    if isinstance(node, ast.BinOp) and type(node.op) in _BINARY_OPERATORS:
        left = _literal_number(node.left)
        right = _literal_number(node.right)
        if left is None or right is None:
            return None
        try:
            value = _BINARY_OPERATORS[type(node.op)](left, right)
        except (ArithmeticError, ValueError):
            return None
        return float(value) if isinstance(value, (int, float)) else None
    return None


def _declared_default_until(tree: ast.Module) -> float | None:
    """Last module-level ``DEFAULT_UNTIL``/``default_until`` literal, as the loader reads it."""
    found: float | None = None
    for statement in tree.body:
        targets: list[ast.expr] = []
        value: ast.expr | None = None
        if isinstance(statement, ast.Assign):
            targets, value = list(statement.targets), statement.value
        elif isinstance(statement, ast.AnnAssign) and statement.value is not None:
            targets, value = [statement.target], statement.value
        if value is None:
            continue
        for target in targets:
            if isinstance(target, ast.Name) and target.id in {"DEFAULT_UNTIL", "default_until"}:
                number = _literal_number(value)
                found = number if number is not None else found
    return found


def _declared_interactive(tree: ast.Module) -> bool | None:
    """Module-level ``interactive()`` / ``fm.interactive(<bool literal>)`` call, if any."""
    found: bool | None = None
    for statement in tree.body:
        if not (isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Call)):
            continue
        call = statement.value
        func = call.func
        name = func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else None
        if name != "interactive":
            continue
        if not call.args and not call.keywords:
            found = True
        elif len(call.args) == 1 and not call.keywords:
            arg = call.args[0]
            if isinstance(arg, ast.Constant) and isinstance(arg.value, bool):
                found = arg.value
    return found
