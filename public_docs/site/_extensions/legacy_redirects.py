"""Write compatibility pages for retired public-documentation URLs."""

from __future__ import annotations

import html
import json
import posixpath
import sys
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from sphinx.application import Sphinx

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts"))

from public_docs_information_architecture_v2 import LEGACY_REDIRECTS


def _redirects() -> dict[str, str]:
    redirects = {
        source.removesuffix(".md") + ".html": target.removesuffix(".md") + ".html"
        for source, target in LEGACY_REDIRECTS.items()
    }
    redirects["physics/exchange.html"] = "physics/interactions/exchange/index.html"
    return redirects


def _write_redirects(app: Sphinx, exception: Exception | None) -> None:
    if exception is not None or app.builder.format != "html":
        return
    output_root = Path(app.outdir)
    for old_path, target_path in _redirects().items():
        destination = output_root / old_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        relative_target = posixpath.relpath(
            target_path,
            start=str(PurePosixPath(old_path).parent),
        )
        escaped_target = html.escape(relative_target, quote=True)
        javascript_target = json.dumps(relative_target)
        destination.write_text(
            "<!doctype html>\n"
            '<html lang="en"><head><meta charset="utf-8">\n'
            f'<meta http-equiv="refresh" content="0; url={escaped_target}">\n'
            f'<link rel="canonical" href="{escaped_target}">\n'
            '<meta name="robots" content="noindex">\n'
            '<title>Documentation moved</title></head><body>\n'
            f'<p>This documentation moved to <a href="{escaped_target}">{escaped_target}</a>.</p>\n'
            "<script>location.replace("
            f"{javascript_target} + location.search + location.hash"
            ");</script>\n"
            "</body></html>\n",
            encoding="utf-8",
        )


def setup(app: Sphinx) -> dict[str, object]:
    app.connect("build-finished", _write_redirects)
    return {"version": "2", "parallel_read_safe": True, "parallel_write_safe": True}
