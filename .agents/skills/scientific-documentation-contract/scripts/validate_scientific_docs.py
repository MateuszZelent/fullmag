#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ast
import json
import re
from pathlib import Path, PurePosixPath
from typing import Any


REQUIRED_SECTIONS = (
    "problem-statement", "governing-equations", "symbols-and-si-units",
    "assumptions-and-validity", "python-api", "problem-ir",
    "round-trip-and-failure-semantics", "discrete-realization",
    "implementation-mapping", "validation", "limitations",
    "scientific-bibliography", "source-code-index",
)
EXPECTED_LANES = {(solver, device) for solver in ("FEM", "FDM") for device in ("CPU", "GPU")}
PARAMETER_FIELDS = ("python", "type", "default", "si_unit", "validation", "meaning", "backend_support", "problem_ir")
RAW_INLINE_RE = re.compile(r"\\\(|\\\)")
PYTHON_BLOCK_RE = re.compile(r"```python\s*\n(.*?)```", re.DOTALL)
MATH_LABEL_RE = re.compile(r"```\{math\}\s*\n(?::[^\n]+\n)*:label:\s*([^\s]+)", re.MULTILINE)
PLACEHOLDER_RE = re.compile(r"\b(?:TODO|TBD)\b|to be documented", re.IGNORECASE)


def _strings(value: Any):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for nested in value.values():
            yield from _strings(nested)
    elif isinstance(value, list):
        for nested in value:
            yield from _strings(nested)


def _objects(value: Any, label: str, errors: list[str]) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        errors.append(f"{label} must be a list")
        return []
    result = []
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            errors.append(f"{label}[{index}] must be an object")
        else:
            result.append(item)
    return result


def _safe_path(value: Any, label: str, errors: list[str]) -> str | None:
    if not isinstance(value, str) or not value or "\\" in value:
        errors.append(f"{label} must be a safe repository-relative path")
        return None
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or str(path) != value:
        errors.append(f"{label} must be a safe repository-relative path")
        return None
    return value


def _required_text(item: dict[str, Any], fields: tuple[str, ...], label: str, errors: list[str]) -> None:
    for field in fields:
        if not isinstance(item.get(field), str) or not item[field].strip():
            errors.append(f"{label}.{field} is required")


def _table_row(page: str, values: list[str]) -> bool:
    return any(
        line.lstrip().startswith("|")
        and all(value in line.replace(r"\|", "|") for value in values)
        for line in page.splitlines()
    )


def _source_symbol_declarations(path: str, text: str, symbol: str) -> list[str]:
    """Return declaration-like lines for a stable path + symbol identity."""
    escaped = re.escape(symbol)
    if symbol.startswith("class "):
        class_name = re.escape(symbol.removeprefix("class ").rstrip(":"))
        pattern = re.compile(rf"^\s*class\s+{class_name}\b", re.MULTILINE)
    elif path.endswith(".py"):
        pattern = re.compile(rf"^\s*(?:async\s+)?def\s+{escaped}\s*\(", re.MULTILINE)
    elif path.endswith(".rs"):
        pattern = re.compile(
            rf"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?fn\s+{escaped}\s*\(",
            re.MULTILINE,
        )
    else:
        pattern = re.compile(
            rf"^(?!\s*return\b)\s*(?:"
            rf"(?:(?:static|inline|extern|__global__|__device__|__host__)\s+)*"
            rf"[\w:<>,*&\s]+\b{escaped}(?:<[^>]+>)?\s*\("
            rf"|{escaped}\s*\()",
            re.MULTILINE,
        )
    return pattern.findall(text)


def validate_page(repo_root: Path, manifest: object, rendered_html: Path | None = None) -> list[str]:
    errors: list[str] = []
    if not isinstance(manifest, dict):
        return ["manifest must be an object"]
    if any(PLACEHOLDER_RE.search(value) for value in _strings(manifest)):
        errors.append("manifest contains a forbidden placeholder")
    document = manifest.get("document")
    if not isinstance(document, dict):
        return ["document must be an object"]
    page_name = _safe_path(document.get("path"), "document.path", errors)
    page_path = repo_root / page_name if page_name else None
    if page_path is None or not page_path.is_file():
        errors.append("document page does not exist")
        return errors
    page = page_path.read_text(encoding="utf-8")

    if PLACEHOLDER_RE.search(page):
        errors.append("page contains a forbidden placeholder")
    if RAW_INLINE_RE.search(page):
        errors.append("page contains raw inline LaTeX delimiters; use MyST $...$ MathJax syntax")
    for section in REQUIRED_SECTIONS:
        if f"({section})=" not in page:
            errors.append(f"page missing required section: {section}")

    lanes = _objects(manifest.get("backend_matrix"), "backend_matrix", errors)
    actual_lanes = {(lane.get("solver"), lane.get("device")) for lane in lanes}
    if actual_lanes != EXPECTED_LANES:
        errors.append("backend_matrix must cover all four backend lanes: FEM/FDM CPU/GPU")
    for lane in lanes:
        if lane.get("status") in {"unsupported", "not-applicable"} and not lane.get("reason"):
            errors.append("unsupported backend lane requires an evidence-based reason")

    sources = _objects(manifest.get("sources"), "sources", errors)
    source_ids: set[str] = set()
    for index, source in enumerate(sources):
        label = f"sources[{index}]"
        _required_text(source, ("id", "path", "symbol", "responsibility"), label, errors)
        source_id = source.get("id")
        if isinstance(source_id, str):
            if source_id in source_ids:
                errors.append(f"duplicate source id: {source_id}")
            source_ids.add(source_id)
        path = _safe_path(source.get("path"), f"{label}.path", errors)
        symbol = source.get("symbol")
        if not isinstance(symbol, str) or not symbol.strip():
            errors.append(f"{label} requires stable path + symbol; line ranges alone are forbidden")
        elif path:
            source_file = repo_root / path
            if not source_file.is_file():
                errors.append(f"{label} source path does not exist: {path}")
            else:
                source_text = source_file.read_text(encoding="utf-8", errors="replace")
                declarations = _source_symbol_declarations(path, source_text, symbol)
                if not declarations:
                    errors.append(f"{label} declaration not found in {path}: {symbol}")
                elif len(declarations) != 1:
                    errors.append(f"{label} declaration is not unique in {path}: {symbol}")

    symbols = _objects(manifest.get("symbols"), "symbols", errors)
    symbol_ids: set[str] = set()
    for index, symbol in enumerate(symbols):
        label = f"symbols[{index}]"
        _required_text(symbol, ("id", "latex", "meaning", "si_unit"), label, errors)
        if not symbol.get("si_unit"):
            errors.append(f"{label} SI unit is required")
        if isinstance(symbol.get("id"), str):
            symbol_ids.add(symbol["id"])
        values = [str(symbol.get(key, "")) for key in ("latex", "meaning", "si_unit")]
        if all(values) and not _table_row(page, values):
            errors.append(f"{label} must appear in one symbols-and-SI-units table row")

    equation_labels = set(MATH_LABEL_RE.findall(page))
    for index, equation in enumerate(_objects(manifest.get("equations"), "equations", errors)):
        label = f"equations[{index}]"
        _required_text(equation, ("id",), label, errors)
        if equation.get("id") not in equation_labels:
            errors.append(f"{label} must match a labelled {{math}} equation in the page")
        for symbol in equation.get("symbols", []):
            if symbol not in symbol_ids:
                errors.append(f"{label} references undefined symbol: {symbol}")
        mapped = equation.get("sources")
        if not isinstance(mapped, list) or not mapped:
            errors.append(f"{label} requires source mappings")
        elif any(source not in source_ids for source in mapped):
            errors.append(f"{label} references an unknown source")

    python_blocks = PYTHON_BLOCK_RE.findall(page)
    if not python_blocks or not any("# %%" in block for block in python_blocks):
        errors.append("page requires a copyable Python example organized with # %% cells")
    for index, block in enumerate(python_blocks):
        try:
            ast.parse(block)
        except SyntaxError as exc:
            errors.append(f"python block {index + 1} does not parse: {exc.msg} at line {exc.lineno}")

    public_api = manifest.get("public_api")
    if not isinstance(public_api, dict):
        errors.append("public_api must be an object")
        parameters = []
    else:
        parameters = _objects(public_api.get("parameters"), "public_api.parameters", errors)
    for index, parameter in enumerate(parameters):
        label = f"public_api.parameters[{index}]"
        _required_text(parameter, PARAMETER_FIELDS, label, errors)
        if not parameter.get("problem_ir"):
            errors.append(f"{label} requires a ProblemIR mapping")
        page_values = [str(parameter.get(field, "")) for field in PARAMETER_FIELDS[:-1]]
        if all(page_values) and not _table_row(page, page_values):
            errors.append(f"{label} must appear as one exhaustive parameter-table row")
        if parameter.get("python") and parameter.get("problem_ir") and not _table_row(
            page, [str(parameter["python"]), str(parameter["problem_ir"])]
        ):
            errors.append(f"{label} Python-to-ProblemIR mapping is missing from the page")

    lowered = page.lower()
    for phrase in ("requested intent", "resolved execution", "validation errors", "unsupported combinations"):
        if phrase not in lowered:
            errors.append(f"round-trip section must explain {phrase}")
    if "(source-code-index)=" in page:
        for source in sources:
            if not _table_row(page, [str(source.get("path", "")), str(source.get("symbol", ""))]):
                errors.append(f"source-code index missing {source.get('id', 'source')}")

    if rendered_html is not None:
        if not rendered_html.is_file():
            errors.append(f"rendered HTML does not exist: {rendered_html}")
        else:
            html = rendered_html.read_text(encoding="utf-8", errors="replace")
            if not re.search(r"class=[\"'][^\"']*(?:math|MathJax)", html, re.IGNORECASE):
                errors.append("rendered HTML contains no MathJax math nodes")
            if not re.search(r"copybutton|copy-button|clipboard", html, re.IGNORECASE):
                errors.append("rendered HTML contains no code-block copy control")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate a Fullmag scientific page and source map.")
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    parser.add_argument("--rendered-html", type=Path)
    args = parser.parse_args()
    try:
        manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"ERROR: cannot read manifest: {exc}")
        return 2
    errors = validate_page(args.repo_root.resolve(), manifest, args.rendered_html)
    for error in errors:
        print(f"ERROR: {error}")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
