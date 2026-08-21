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
    "page_last_modified",
    "documentation_changelog",
]
templates_path = ["_templates"]

# Site-global publication time shown as "Zbudowano w" under the doc header.
# GitHub Actions sets FULLMAG_DOCS_BUILD_TIME; fall back to the current UTC
# time so local builds still carry a meaningful value.
from datetime import datetime, timezone
build_time = os.environ.get("FULLMAG_DOCS_BUILD_TIME")
if not build_time:
    build_time = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
html_context = {"fem_docs_build_time": build_time}
exclude_patterns = ["_build", "internal", "generated", "README.md"]
source_suffix = {".md": "markdown", ".rst": "restructuredtext"}

myst_enable_extensions = [
    "colon_fence",
    "dollarmath",
    "fieldlist",
    "linkify",
    "substitution",
]
myst_fence_as_directive = ["math"]
myst_heading_anchors = 3

copybutton_prompt_text = r">>> |\.\.\. |\$ "
copybutton_prompt_is_regexp = True

html_theme = "sphinx_clarity_theme"
html_title = "FullMag public documentation"
html_static_path = ["_static"]
html_extra_path = ["CNAME"]
html_css_files = [
    "fullmag-docs.css",
    "page-last-modified.css",
    "documentation-changelog.css",
]
html_js_files = ["status-navigation.js"]

page_last_modified_label = "Last changes:"
page_last_modified_format = "%H:%M %d.%m.%Y"
page_last_modified_timezone = "Europe/Warsaw"

documentation_changelog_repository_url = "https://github.com/MateuszZelent/fullmag"
documentation_changelog_limit = 80
documentation_changelog_timezone = "Europe/Warsaw"

nitpicky = True
