#!/usr/bin/env python3
"""Generate all 28 dual-theme (Light + Dark) physics SVG diagrams for FullMag docs.

Usage:
    python3 scripts/generate_physics_diagrams.py
    python3 scripts/generate_physics_diagrams.py --group foundations --group spintronics
    python3 scripts/generate_physics_diagrams.py --out-dir /tmp/diagrams-preview
"""

from __future__ import annotations

import argparse
import importlib
from pathlib import Path
import sys
from typing import Sequence

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from physics_diagrams.primitives import DEFAULT_DIAGRAMS_DIR  # noqa: E402

DIAGRAM_GROUPS: tuple[str, ...] = (
    "foundations",
    "demag_exchange",
    "dmi_local",
    "spintronics",
)


def generate_groups(
    groups: Sequence[str] = DIAGRAM_GROUPS,
    *,
    out_dir: Path | str = DEFAULT_DIAGRAMS_DIR,
) -> list[tuple[Path, Path]]:
    """Run ``generate_all(out_dir)`` for each requested physics diagram module."""
    out_path = Path(out_dir)
    out_path.mkdir(parents=True, exist_ok=True)
    generated: list[tuple[Path, Path]] = []
    for group in groups:
        if group not in DIAGRAM_GROUPS:
            raise ValueError(f"Unknown diagram group {group!r}; expected one of {DIAGRAM_GROUPS}")
        module = importlib.import_module(f"physics_diagrams.{group}")
        result = module.generate_all(out_path)
        if result:
            generated.extend(result)
    return generated


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Regenerate FullMag dual-theme (Light & Dark) physics SVG diagrams."
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=DEFAULT_DIAGRAMS_DIR,
        help="Destination directory for <slug>.svg and <slug>-dark.svg files.",
    )
    parser.add_argument(
        "--group",
        dest="groups",
        action="append",
        choices=DIAGRAM_GROUPS,
        help="Generate only the specified diagram group(s). Defaults to all groups.",
    )
    args = parser.parse_args(argv)
    selected = tuple(args.groups) if args.groups else DIAGRAM_GROUPS
    pairs = generate_groups(selected, out_dir=args.out_dir)
    print(
        f"Generated {len(pairs)} themed diagram pair(s) ({len(pairs) * 2} SVGs) "
        f"into {args.out_dir} across groups: {', '.join(selected)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
