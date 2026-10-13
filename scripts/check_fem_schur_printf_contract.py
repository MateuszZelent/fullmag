"""Check variadic diagnostic arity without compiling native targets."""
from __future__ import annotations

import ast
from pathlib import Path
import re

REPO_ROOT = Path(__file__).resolve().parents[1]
SOURCE = REPO_ROOT / "backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp"
TOKEN = re.compile(r"""//[^\n]*|/\*.*?\*/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|.""", re.S)
SPECIFIER = re.compile(r"%[-+ #0]*(?:[0-9]+|\*)?(?:\.(?:[0-9]+|\*))?(?:hh|ll|[hljztL])?[diuoxXfFeEgGaAcspn%]")


def arguments(source: str, start: int) -> list[str]:
    depth = 1
    values: list[str] = []
    current: list[str] = []
    for token in TOKEN.findall(source[start:]):
        if token.startswith(("//", "/*")):
            continue
        if token in ("(", "[", "{"):
            depth += 1
        elif token in (")", "]", "}"):
            depth -= 1
            if depth == 0:
                values.append("".join(current).strip())
                return values
        if token == "," and depth == 1:
            values.append("".join(current).strip())
            current = []
        else:
            current.append(token)
    raise ValueError("Unclosed diagnostic call")


def expected_arity(format_string: str) -> int:
    total = 0
    index = 0
    while index < len(format_string):
        if format_string[index] != "%":
            index += 1
            continue
        match = SPECIFIER.match(format_string, index)
        if match is None:
            raise ValueError(f"Unsupported printf specifier at {index}")
        directive = match.group()
        if directive != "%%":
            total += 1 + directive.count("*")
        index = match.end()
    return total


def check_source(source: str) -> int:
    checked = 0
    for call in re.finditer(r"(?:std::snprintf|append_subwindow_json)\s*\(", source):
        args = arguments(source, call.end())
        format_index = 2 if call.group().startswith("std::snprintf") else 0
        format_tokens = TOKEN.findall(args[format_index])
        if not format_tokens or any(token.strip() and not token.startswith('"') for token in format_tokens):
            # Dynamic messages are copied by the common helper, not literal printf contracts.
            continue
        format_string = "".join(ast.literal_eval(token) for token in format_tokens if token.strip())
        expected = expected_arity(format_string)
        actual = len(args) - format_index - 1
        line = source.count("\n", 0, call.start()) + 1
        if expected != actual:
            raise ValueError(f"line {line}: printf expects {expected} arguments, got {actual}")
        checked += 1
    if checked == 0:
        raise ValueError("No literal diagnostic calls checked")
    return checked


if __name__ == "__main__":
    print(f"PASS: {check_source(SOURCE.read_text(encoding='utf-8'))} literal diagnostic calls")
