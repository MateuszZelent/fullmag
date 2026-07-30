"""Wrap generated documentation tables in a local horizontal scrollport."""

from __future__ import annotations

from typing import TYPE_CHECKING

from docutils import nodes

if TYPE_CHECKING:
    from sphinx.application import Sphinx


def _wrap_tables(app: Sphinx, doctree: nodes.document, docname: str) -> None:
    if app.builder.format != "html":
        return

    for table in list(doctree.findall(nodes.table)):
        parent = table.parent
        if parent is None:
            continue
        if isinstance(parent, nodes.container) and "table-wrapper" in parent["classes"]:
            continue

        wrapper = nodes.container(classes=["table-wrapper"])
        parent.replace(table, wrapper)
        wrapper += table


def setup(app: Sphinx) -> dict[str, object]:
    app.connect("doctree-resolved", _wrap_tables)
    return {
        "version": "1",
        "parallel_read_safe": True,
        "parallel_write_safe": True,
    }
