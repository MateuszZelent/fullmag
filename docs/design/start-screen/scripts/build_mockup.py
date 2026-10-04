"""Inline the generated thumbnails into the self-contained mockup.

    python scripts/build_mockup.py

Reads  mockups/start-screen.template.html
Writes mockups/start-screen.html   (single file, no external requests)
"""
from __future__ import annotations

import base64
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "mockups" / "start-screen.template.html"
OUTPUT = ROOT / "mockups" / "start-screen.html"
THUMBS = ROOT / "mockups" / "assets" / "thumbs"


def data_uri(name: str) -> str:
    """PNG on disk stays the lossless asset; the inlined copy is JPEG so the
    single-file mockup stays small enough to open instantly."""
    path = THUMBS / f"{name}.png"
    if not path.exists():
        raise SystemExit(f"missing thumbnail: {path}")
    try:
        import io

        from PIL import Image

        buf = io.BytesIO()
        Image.open(path).convert("RGB").save(buf, "JPEG", quality=82, optimize=True)
        return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
    except ImportError:  # Pillow absent — fall back to the PNG bytes
        return "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode("ascii")


def main() -> None:
    html = TEMPLATE.read_text(encoding="utf-8")
    used: list[str] = []

    def repl(match: re.Match[str]) -> str:
        name = match.group(1)
        used.append(name)
        return data_uri(name)

    html = re.sub(r"\{\{THUMB:([a-z0-9-]+)\}\}", repl, html)
    leftover = re.findall(r"\{\{[^}]+\}\}", html)
    if leftover:
        raise SystemExit(f"unresolved placeholders: {sorted(set(leftover))}")

    OUTPUT.write_text(html, encoding="utf-8")
    print(f"wrote {OUTPUT.relative_to(ROOT)}  "
          f"({OUTPUT.stat().st_size/1024:.0f} kB, {len(set(used))} thumbnails inlined)")


if __name__ == "__main__":
    main()
