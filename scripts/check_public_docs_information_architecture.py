"""Run the ownership-oriented public-documentation IA check.

Reference pages may be promoted monotonically from partial to implemented.
All titles, labels, paths, document kinds, and navigation edges remain strict.
"""

from __future__ import annotations

import argparse
from dataclasses import replace
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "public_docs/site/_extensions"))

from public_docs_information_architecture_v2 import (
    PAGE_SPECS,
    PUBLIC_DOCS_ROOT,
    PageSpec,
    check_pages,
)


def _front_matter_status(path: Path) -> str | None:
    if not path.is_file():
        return None
    lines = path.read_text(encoding="utf-8").splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    for line in lines[1:]:
        stripped = line.strip()
        if stripped == "---":
            break
        if stripped.startswith("status:"):
            value = stripped.partition(":")[2].strip()
            if (
                len(value) >= 2
                and value[0] == value[-1]
                and value[0] in {"'", '"'}
            ):
                value = value[1:-1]
            return value or None
    return None


def _effective_specs(root: Path) -> tuple[PageSpec, ...]:
    effective: list[PageSpec] = []
    for spec in PAGE_SPECS:
        actual_status = _front_matter_status(root / spec.path)
        if (
            spec.doc_kind == "reference"
            and spec.status == "partial"
            and actual_status == "implemented"
        ):
            effective.append(replace(spec, status="implemented"))
        else:
            effective.append(spec)
    return tuple(effective)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=PUBLIC_DOCS_ROOT)
    args = parser.parse_args(argv)

    errors = check_pages(_effective_specs(args.root), args.root)
    for error in errors:
        print(error, file=sys.stderr)
    return int(bool(errors))


if __name__ == "__main__":
    raise SystemExit(main())
