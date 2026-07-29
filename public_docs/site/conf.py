"""Sphinx configuration for the public FullMag documentation portal."""

from __future__ import annotations

import os

project = "FullMag"
copyright = "FullMag contributors"
author = "FullMag contributors"
release = os.environ.get("FULLMAG_DOCS_VERSION", "latest")
version = release

extensions = ["myst_parser"]
templates_path = ["_templates"]
exclude_patterns = ["_build", "internal", "generated", "README.md"]
source_suffix = {".md": "markdown", ".rst": "restructuredtext"}

myst_enable_extensions = [
    "colon_fence",
    "dollarmath",
    "fieldlist",
    "linkify",
    "substitution",
]
myst_heading_anchors = 3

html_theme = "sphinx_clarity_theme"
html_title = "FullMag public documentation"
html_static_path = ["_static"]
html_extra_path = ["CNAME"]

nitpicky = True
