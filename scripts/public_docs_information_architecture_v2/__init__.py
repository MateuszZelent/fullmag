"""Package shim for the owner-oriented documentation manifest.

Python's import machinery prefers this package over the adjacent compatibility module.  The shim
loads that declarative manifest and replaces the historical descendant-only relative-path helper
with a general POSIX relative-path implementation.  This allows Backend to own and navigate to the
existing Numerical Methods and Architecture families without duplicating their content.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path, PurePosixPath
import posixpath
import sys

import public_docs_information_architecture as legacy


def _relative_child(parent: str, child: str) -> str:
    parent_directory = str(PurePosixPath(parent).parent)
    relative = posixpath.relpath(child, start=parent_directory)
    return str(PurePosixPath(relative).with_suffix(""))


# The historical implementation assumed every child was a strict descendant.  The new owner tree
# intentionally nests existing top-level numerical families under Backend, so use a general
# relative-path function in all reused validation and rendering helpers.
legacy._relative_child = _relative_child  # type: ignore[attr-defined]

_manifest_path = Path(__file__).resolve().parents[1] / "public_docs_information_architecture_v2.py"
_spec = importlib.util.spec_from_file_location("_fullmag_owner_ia_declarations", _manifest_path)
if _spec is None or _spec.loader is None:
    raise ImportError(f"cannot load owner-oriented documentation manifest: {_manifest_path}")
_module = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _module
try:
    _spec.loader.exec_module(_module)
finally:
    sys.modules.pop(_spec.name, None)

INTERACTION_SLUGS = _module.INTERACTION_SLUGS
LEGACY_REDIRECTS = _module.LEGACY_REDIRECTS
PAGE_SPECS = _module.PAGE_SPECS
PUBLIC_DOCS_ROOT = _module.PUBLIC_DOCS_ROOT
PageSpec = _module.PageSpec

# Re-export the generic helpers after patching their relative-path dependency.
check_pages = legacy.check_pages
render_page = legacy.render_page
validate_tree = legacy.validate_tree
write_pages = legacy.write_pages

__all__ = [
    "INTERACTION_SLUGS",
    "LEGACY_REDIRECTS",
    "PAGE_SPECS",
    "PUBLIC_DOCS_ROOT",
    "PageSpec",
    "check_pages",
    "render_page",
    "validate_tree",
    "write_pages",
]
