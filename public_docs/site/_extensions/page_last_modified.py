"""Render page-specific Git last-change metadata below every document title."""

from __future__ import annotations

from datetime import datetime
from functools import lru_cache
from html import escape
from pathlib import Path
import re
import subprocess
from typing import TYPE_CHECKING
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from docutils import nodes
from sphinx.errors import ExtensionError
from sphinx.util import logging

if TYPE_CHECKING:
    from sphinx.application import Sphinx


LOGGER = logging.getLogger(__name__)
MARKER_CLASS = "fm-page-last-modified"
DISPLAY_TIMESTAMP_RE = re.compile(r"\b\d{2}:\d{2} \d{2}\.\d{2}\.\d{4}\b")


def _run_git(cwd: Path, *arguments: str) -> str | None:
    """Run one bounded, non-shell Git query and return its stripped stdout."""
    try:
        completed = subprocess.run(
            ["git", "-C", str(cwd), *arguments],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if completed.returncode != 0:
        return None
    output = completed.stdout.strip()
    return output or None


@lru_cache(maxsize=None)
def _repository_root(start_directory: str) -> Path | None:
    root = _run_git(Path(start_directory), "rev-parse", "--show-toplevel")
    if root is None:
        return None
    resolved = Path(root).resolve()
    return resolved if resolved.is_dir() else None


def _parse_iso_timestamp(value: str) -> datetime | None:
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = f"{normalized[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.astimezone()


@lru_cache(maxsize=None)
def _source_last_change(source_path_text: str) -> datetime | None:
    """Return the latest commit time for one source file, following renames."""
    source_path = Path(source_path_text).resolve()
    repository_root = _repository_root(str(source_path.parent))
    if repository_root is not None:
        try:
            relative_path = source_path.relative_to(repository_root).as_posix()
        except ValueError:
            relative_path = ""
        if relative_path:
            committed_at = _run_git(
                repository_root,
                "log",
                "--follow",
                "-1",
                "--format=%cI",
                "--",
                relative_path,
            )
            if committed_at is not None:
                parsed = _parse_iso_timestamp(committed_at)
                if parsed is not None:
                    return parsed

    # Source archives and non-Git builds still receive deterministic page metadata
    # for the current file snapshot rather than losing the marker entirely.
    try:
        return datetime.fromtimestamp(source_path.stat().st_mtime).astimezone()
    except OSError:
        return None


@lru_cache(maxsize=None)
def _configured_timezone(name: str):
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        LOGGER.warning(
            "Timezone database does not contain %s; falling back to UTC for page metadata.",
            name,
        )
        return ZoneInfo("UTC")


def _first_document_title(doctree: nodes.document) -> nodes.title | None:
    for child in doctree.children:
        if not isinstance(child, nodes.section):
            continue
        for section_child in child.children:
            if isinstance(section_child, nodes.title):
                return section_child
    return next(iter(doctree.findall(nodes.title)), None)


def _insert_page_last_modified(
    app: Sphinx,
    doctree: nodes.document,
    docname: str,
) -> None:
    if app.builder.format != "html":
        return

    if any(
        isinstance(node, nodes.raw) and MARKER_CLASS in node.astext()
        for node in doctree.findall(nodes.raw)
    ):
        return

    source_path = Path(app.env.doc2path(docname, base=True))
    changed_at = _source_last_change(str(source_path))
    if changed_at is None:
        changed_at = datetime.now().astimezone()
        LOGGER.warning(
            "Could not resolve source modification time for %s; using build time.",
            docname,
        )

    localized = changed_at.astimezone(
        _configured_timezone(app.config.page_last_modified_timezone)
    )
    display_value = localized.strftime(app.config.page_last_modified_format)
    machine_value = localized.isoformat(timespec="minutes")
    label = app.config.page_last_modified_label

    metadata_html = (
        f'<p class="{MARKER_CLASS}">'
        f'<span class="fm-page-last-modified__label">{escape(label)}</span> '
        f'<time datetime="{escape(machine_value, quote=True)}">'
        f"{escape(display_value)}</time></p>"
    )
    metadata_node = nodes.raw("", metadata_html, format="html")

    title = _first_document_title(doctree)
    if title is None or title.parent is None:
        doctree.insert(0, metadata_node)
        LOGGER.warning(
            "Document %s has no section title; page metadata was inserted at the top.",
            docname,
        )
        return

    title.parent.insert(title.parent.index(title) + 1, metadata_node)


def _validate_rendered_metadata(app: Sphinx, exception: BaseException | None) -> None:
    """Fail the HTML build unless every source document renders one valid marker."""
    if exception is not None or app.builder.format != "html":
        return

    failures: list[str] = []
    for docname in sorted(app.env.found_docs):
        output_path = Path(app.builder.get_outfilename(docname))
        try:
            rendered = output_path.read_text(encoding="utf-8")
        except OSError as error:
            failures.append(f"{docname}: cannot read rendered HTML ({error})")
            continue

        marker_count = rendered.count(f'class="{MARKER_CLASS}"')
        if marker_count != 1:
            failures.append(
                f"{docname}: expected exactly one last-change marker, found {marker_count}"
            )
            continue
        if not DISPLAY_TIMESTAMP_RE.search(rendered):
            failures.append(f"{docname}: last-change timestamp has an invalid display format")

    if failures:
        preview = "\n".join(f"- {failure}" for failure in failures[:20])
        remainder = len(failures) - 20
        suffix = f"\n- ... and {remainder} more" if remainder > 0 else ""
        raise ExtensionError(
            "Page last-change metadata validation failed:\n" f"{preview}{suffix}"
        )

    LOGGER.info(
        "Validated page last-change metadata for %d documentation pages.",
        len(app.env.found_docs),
    )


def setup(app: Sphinx) -> dict[str, object]:
    app.add_config_value("page_last_modified_label", "Last changes:", "html")
    app.add_config_value(
        "page_last_modified_format",
        "%H:%M %d.%m.%Y",
        "html",
    )
    app.add_config_value("page_last_modified_timezone", "Europe/Warsaw", "html")
    app.connect("doctree-resolved", _insert_page_last_modified)
    app.connect("build-finished", _validate_rendered_metadata)
    return {
        "version": "1",
        "parallel_read_safe": True,
        "parallel_write_safe": True,
    }
