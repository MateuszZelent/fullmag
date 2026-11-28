"""Inject paired Light/Dark diagram image nodes and color-scheme metadata for HTML builds."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from docutils import nodes

if TYPE_CHECKING:
    from sphinx.application import Sphinx


DIAGRAMS_PREFIX = "_static/diagrams/"
LIGHT_CLASS = "fm-diagram-light"
DARK_CLASS = "fm-diagram-dark"
THEMED_FIGURE_CLASS = "fm-themed-figure"
COLOR_SCHEME_META = '<meta name="color-scheme" content="light dark" />'


def _normalize_diagram_uri(uri: str) -> tuple[str, bool] | None:
    """Return ``(srcdir_relative_uri, had_leading_slash)`` for a light SVG under ``_static/diagrams/``."""
    stripped = uri.strip()
    if not stripped or "://" in stripped or stripped.startswith("data:"):
        return None
    had_leading_slash = stripped.startswith("/")
    rel = stripped.lstrip("/")
    if not rel.startswith(DIAGRAMS_PREFIX):
        return None
    if not rel.lower().endswith(".svg") or rel.lower().endswith("-dark.svg"):
        return None
    return rel, had_leading_slash


def _find_enclosing_figure(node: nodes.Node) -> nodes.figure | None:
    current = node.parent
    while current is not None:
        if isinstance(current, nodes.figure):
            return current
        current = current.parent
    return None


def _inject_themed_diagrams(app: Sphinx, doctree: nodes.document, docname: str) -> None:
    """Pair every ``_static/diagrams/<slug>.svg`` image with its sibling ``-dark.svg`` in HTML."""
    builder = getattr(app, "builder", None)
    if builder is None or getattr(builder, "format", None) != "html":
        return
    if getattr(builder, "name", "") == "changes":
        return

    srcdir = Path(app.srcdir)
    env = getattr(app, "env", None)

    for image in list(doctree.findall(nodes.image)):
        classes = image.get("classes", [])
        if LIGHT_CLASS in classes or DARK_CLASS in classes:
            continue

        normalized = _normalize_diagram_uri(str(image.get("uri", "")))
        if normalized is None:
            continue
        rel_uri, had_leading_slash = normalized
        dark_rel_uri = f"{rel_uri[:-4]}-dark.svg"
        if not (srcdir / dark_rel_uri).is_file():
            continue

        image["classes"].append(LIGHT_CLASS)

        dark_image = image.deepcopy()
        dark_image["ids"] = []
        dark_image["names"] = []
        dark_image["classes"] = [
            cls for cls in dark_image.get("classes", []) if cls != LIGHT_CLASS
        ]
        if DARK_CLASS not in dark_image["classes"]:
            dark_image["classes"].append(DARK_CLASS)

        dark_uri = f"/{dark_rel_uri}" if had_leading_slash else dark_rel_uri
        dark_image["uri"] = dark_uri
        dark_image["candidates"] = {"*": dark_rel_uri}
        if "original_uri" in dark_image:
            orig = str(dark_image["original_uri"])
            if orig.lower().endswith(".svg") and not orig.lower().endswith("-dark.svg"):
                dark_image["original_uri"] = f"{orig[:-4]}-dark.svg"

        # Register the dark sibling in Sphinx's image map & dependency tracker so
        # StandaloneHTMLBuilder copies it into ``_images/`` and rewrites its URI.
        if env is not None:
            dependencies = getattr(env, "dependencies", None)
            if dependencies is not None:
                dependencies[docname].add(dark_rel_uri)
            images = getattr(env, "images", None)
            if images is not None and dark_rel_uri not in images:
                images.add_file(docname, dark_rel_uri)

        parent = image.parent
        if parent is None:
            continue

        # If already wrapped inside a single-image reference, clone the reference too.
        if (
            isinstance(parent, nodes.reference)
            and len(parent.children) == 1
            and parent.parent is not None
        ):
            dark_ref = parent.deepcopy()
            dark_ref["ids"] = []
            dark_ref["names"] = []
            dark_ref.clear()
            dark_ref += dark_image
            refuri = str(dark_ref.get("refuri", ""))
            if refuri.lower().endswith(".svg") and not refuri.lower().endswith("-dark.svg"):
                dark_ref["refuri"] = f"{refuri[:-4]}-dark.svg"
            grandparent = parent.parent
            insert_idx = grandparent.index(parent) + 1
            grandparent.insert(insert_idx, dark_ref)
        else:
            insert_idx = parent.index(image) + 1
            parent.insert(insert_idx, dark_image)

        enclosing_figure = _find_enclosing_figure(image)
        if enclosing_figure is not None and THEMED_FIGURE_CLASS not in enclosing_figure["classes"]:
            enclosing_figure["classes"].append(THEMED_FIGURE_CLASS)


def _inject_color_scheme_meta(
    app: Sphinx,
    pagename: str,
    templatename: str,
    context: dict[str, object],
    doctree: nodes.document | None,
) -> None:
    """Emit ``<meta name="color-scheme" content="light dark" />`` in ``<head>``."""
    builder = getattr(app, "builder", None)
    if builder is None or getattr(builder, "format", None) != "html":
        return
    existing = str(context.get("metatags", "") or "")
    lowered = existing.lower()
    if 'name="color-scheme"' in lowered or "name='color-scheme'" in lowered:
        return
    context["metatags"] = f"{COLOR_SCHEME_META}\n{existing}" if existing else COLOR_SCHEME_META


def setup(app: Sphinx) -> dict[str, object]:
    app.connect("doctree-resolved", _inject_themed_diagrams)
    app.connect("html-page-context", _inject_color_scheme_meta)
    return {
        "version": "1",
        "parallel_read_safe": True,
        "parallel_write_safe": True,
    }
