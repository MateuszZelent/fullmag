#!/usr/bin/env python3
"""Enforce the public Fullmag Python authoring boundary.

Executable documentation follows the stage-first study builder.  Direct
``fm.Problem(...)`` examples are forbidden in published documentation,
including structural or ProblemIR inspection blocks.
"""

from __future__ import annotations

import argparse
import ast
import re
import sys
from pathlib import Path


PYTHON_BLOCK_RE = re.compile(r"```python\s*\n(.*?)```", re.DOTALL)
DIRECT_PROBLEM_RE = re.compile(r"\bfm\.Problem\s*\(")
SIMULATION_RE = re.compile(
    r"fm\.(?:Ferromagnet|TimeEvolution|Simulation)\s*\(|\bmagnets\s*=|\benergy\s*="
)
STUDY_RE = re.compile(r"fm\.study\s*\(")
STAGE_RE = re.compile(r"study\.stages\.add_")


def check_public_examples(root: Path) -> list[str]:
    errors: list[str] = []
    for page in sorted(root.rglob("*.md")):
        text = page.read_text(encoding="utf-8")
        for block_index, block in enumerate(PYTHON_BLOCK_RE.findall(text), 1):
            line = text.find(block)
            line_number = text[:line].count("\n") + 1
            label = f"{page}:{line_number} (python block {block_index})"
            try:
                ast.parse(block)
            except SyntaxError as exc:
                errors.append(f"{label}: Python does not parse: {exc.msg}")
                continue

            if DIRECT_PROBLEM_RE.search(block):
                errors.append(
                    f"{label}: public documentation must not contain fm.Problem(...); "
                    "use the complete stage-first study scenario"
                )
            elif ("import fullmag" in block or SIMULATION_RE.search(block)) and not (
                STUDY_RE.search(block) and STAGE_RE.search(block)
            ):
                errors.append(
                    f"{label}: every public Fullmag Python example must be a complete "
                    "stage-first scenario with fm.study(...) and study.stages.add_*"
                )
    return errors


def execute_public_examples(root: Path) -> list[str]:
    """Execute every public Python block against the repository Python DSL.

    This validates authoring/capture semantics only. It does not launch native
    solver binaries or claim CPU/GPU runtime qualification.
    """

    package_src = Path(__file__).resolve().parents[1] / "packages" / "fullmag-py" / "src"
    if str(package_src) not in sys.path:
        sys.path.insert(0, str(package_src))
    import fullmag as fm

    errors: list[str] = []
    for page in sorted(root.rglob("*.md")):
        text = page.read_text(encoding="utf-8")
        for block_index, block in enumerate(PYTHON_BLOCK_RE.findall(text), 1):
            line = text.find(block)
            line_number = text[:line].count("\n") + 1
            label = f"{page}:{line_number} (python block {block_index})"
            try:
                fm.reset()
                exec(compile(block, str(page), "exec"), {"__name__": "__fullmag_doc_example__"})
            except Exception as exc:  # pragma: no cover - exercised by CLI integration
                errors.append(f"{label}: example execution failed: {type(exc).__name__}: {exc}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("public_docs/site"))
    parser.add_argument(
        "--execute",
        action="store_true",
        help="also execute each Python block through the repository Python DSL",
    )
    args = parser.parse_args()
    errors = check_public_examples(args.root.resolve())
    if args.execute:
        errors.extend(execute_public_examples(args.root.resolve()))
    for error in errors:
        print(f"ERROR: {error}")
    if errors:
        return 1
    print(f"Public documentation Python examples passed: {args.root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
