"""Regenerate the live-session notebooks from their ``# %%`` scripts.

Each ``NN_*.py`` script in this folder is the source of truth; its notebook
``NN_*.ipynb`` holds the same code: the module docstring becomes a Markdown
cell and every ``# %% Title`` cell a code cell headed by ``# Title``. Outputs
are left empty.

    python examples/live/sync_notebooks.py          # rewrite the notebooks
    python examples/live/sync_notebooks.py --check  # fail when one is stale
"""

from __future__ import annotations

import ast
import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CELL_MARKER = "# %%"


def notebook_for(script: Path) -> dict:
    source = script.read_text(encoding="utf-8")
    module = ast.parse(source)
    docstring = ast.get_docstring(module, clean=True) or ""
    body_start = module.body[1].lineno - 1 if docstring and len(module.body) > 1 else 0
    lines = source.splitlines()[body_start:]

    cells = [_markdown(_docstring_markdown(script, docstring))] if docstring else []
    current: list[str] = []
    for line in lines:
        if line.startswith(CELL_MARKER):
            _flush(cells, current)
            title = line[len(CELL_MARKER):].strip()
            current = [f"# {title}"] if title else []
        else:
            current.append(line)
    _flush(cells, current)
    return {
        "cells": cells,
        "metadata": {
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python"},
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }


def _docstring_markdown(script: Path, docstring: str) -> str:
    title, _, rest = docstring.partition("\n")
    # Indented usage lines stay literal in Markdown as a code block.
    return f"# {title.strip()}\n{rest}\n\nGenerated from `{script.name}` by `sync_notebooks.py`."


def _flush(cells: list[dict], lines: list[str]) -> None:
    while lines and not lines[-1].strip():
        lines.pop()
    while lines and not lines[0].strip():
        lines.pop(0)
    if lines:
        cells.append(_code("\n".join(lines)))
    lines.clear()


def _source(text: str) -> list[str]:
    parts = text.split("\n")
    return [line + "\n" for line in parts[:-1]] + [parts[-1]]


def _markdown(text: str) -> dict:
    return {"cell_type": "markdown", "id": f"md{_cell_id(text)}", "metadata": {}, "source": _source(text)}


def _code(text: str) -> dict:
    return {
        "cell_type": "code",
        "execution_count": None,
        "id": f"code{_cell_id(text)}",
        "metadata": {},
        "outputs": [],
        "source": _source(text),
    }


def _cell_id(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:8]


def main(argv: list[str]) -> int:
    check = "--check" in argv
    stale = []
    for script in sorted(HERE.glob("[0-9][0-9]_*.py")):
        target = script.with_suffix(".ipynb")
        rendered = json.dumps(notebook_for(script), indent=1, ensure_ascii=False) + "\n"
        current = target.read_text(encoding="utf-8") if target.exists() else None
        if current == rendered:
            continue
        if check:
            stale.append(target.name)
        else:
            target.write_text(rendered, encoding="utf-8", newline="\n")
            print(f"wrote {target.relative_to(HERE.parent.parent)}")
    if stale:
        print("stale notebooks (run sync_notebooks.py):", ", ".join(stale), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
