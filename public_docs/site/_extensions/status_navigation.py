"""Annotate sidebar/toctree links with the publication status of their target."""

from __future__ import annotations

import html
import json
from urllib.parse import urldefrag

from docutils import nodes


def _target_docname(app: object, current_docname: str, refuri: str) -> str | None:
    builder = getattr(app, "builder", None)
    env = getattr(app, "env", None)
    if builder is None or env is None or not refuri or "://" in refuri:
        return None
    uri, _ = urldefrag(refuri)
    if not uri:
        return current_docname
    for candidate in env.found_docs:
        if builder.get_relative_uri(current_docname, candidate) == uri:
            return candidate
    return None


def _annotate_links(app: object, doctree: nodes.document, docname: str) -> None:
    env = getattr(app, "env", None)
    if env is None:
        return
    for reference in doctree.findall(nodes.reference):
        refuri = reference.get("refuri")
        target = _target_docname(app, docname, refuri)
        if target is None:
            continue
        metadata = env.metadata.get(target, {})
        status = metadata.get("status")
        doc_kind = metadata.get("doc_kind")
        state_class = (
            "fm-doc-status-planned"
            if status == "planned" or doc_kind == "scaffold"
            else "fm-doc-status-active"
        )
        reference["classes"].append(state_class)
        parent = reference.parent
        if isinstance(parent, nodes.Element):
            parent["classes"].append(state_class)


def _inject_status_map(app: object, pagename: str, templatename: str, context: dict[str, object], doctree: nodes.document) -> None:
    del pagename, templatename, doctree
    env = getattr(app, "env", None)
    builder = getattr(app, "builder", None)
    if env is None or builder is None:
        return
    status_map: dict[str, str] = {}
    for docname in env.found_docs:
        metadata = env.metadata.get(docname, {})
        target = builder.get_target_uri(docname).split("#", 1)[0]
        status_map[target] = "planned" if (
            metadata.get("status") == "planned" or metadata.get("doc_kind") == "scaffold"
        ) else "active"
    encoded = html.escape(json.dumps(status_map, separators=(",", ":")), quote=True)
    context["metatags"] = context.get("metatags", "") + (
        f'<meta name="fullmag-doc-status-map" content="{encoded}">'
    )


def setup(app: object) -> dict[str, object]:
    app.connect("doctree-resolved", _annotate_links)
    app.connect("html-page-context", _inject_status_map)
    return {
        "version": "1",
        "parallel_read_safe": True,
        "parallel_write_safe": True,
    }
