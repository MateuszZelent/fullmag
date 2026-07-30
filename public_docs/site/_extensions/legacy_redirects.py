"""Write compatibility pages for retired public-documentation URLs."""

from __future__ import annotations

import html
import json
import posixpath
from pathlib import Path, PurePosixPath

from sphinx.application import Sphinx


INTERACTION_TARGETS = {
    "exchange": "physics/interactions/exchange/index.html",
    "demagnetization": "physics/interactions/demagnetization/index.html",
    "zeeman": "physics/interactions/zeeman/index.html",
    "uniaxial-anisotropy": "physics/interactions/anisotropy/uniaxial.html",
    "cubic-anisotropy": "physics/interactions/anisotropy/cubic.html",
    "interfacial-dmi": "physics/interactions/dmi/interfacial.html",
    "bulk-dmi": "physics/interactions/dmi/bulk.html",
    "thermal-noise": "physics/interactions/thermal-noise/index.html",
    "magnetoelastic": "physics/interactions/magnetoelastic/index.html",
    "oersted-field": "physics/interactions/oersted-field/index.html",
    "spin-transfer-torque": "physics/interactions/spin-transfer-torque/index.html",
    "spin-orbit-torque": "physics/interactions/spin-orbit-torque/index.html",
    "drift-diffusion-spin-torque": "physics/interactions/drift-diffusion-spin-torque/index.html",
    "inter-region-couplings": "physics/interactions/inter-region-couplings/index.html",
}


def _redirects() -> dict[str, str]:
    redirects = {"physics/exchange.html": INTERACTION_TARGETS["exchange"]}
    for solver in ("fdm", "fem"):
        for device in ("cpu", "gpu"):
            prefix = f"physics/solvers/{solver}/{device}/interactions"
            for slug, target in INTERACTION_TARGETS.items():
                redirects[f"{prefix}/{slug}.html"] = target
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
    return {"version": "1", "parallel_read_safe": True, "parallel_write_safe": True}
