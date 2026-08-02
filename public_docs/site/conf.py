"""Sphinx configuration for the public FullMag documentation portal."""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent / "_extensions"))

project = "FullMag"
copyright = "FullMag contributors"
author = "FullMag contributors"
release = os.environ.get("FULLMAG_DOCS_VERSION", "latest")
version = release

extensions = [
    "myst_parser",
    "sphinx_design",
    "sphinx_copybutton",
    "legacy_redirects",
    "responsive_tables",
    "status_navigation",
]
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

copybutton_prompt_text = r">>> |\.\.\. |\$ "
copybutton_prompt_is_regexp = True

html_theme = "sphinx_clarity_theme"
html_title = "FullMag public documentation"
html_static_path = ["_static"]
html_extra_path = ["CNAME"]
html_css_files = ["fullmag-docs.css"]
html_js_files = ["status-navigation.js"]

nitpicky = True
