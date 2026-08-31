"""Render a deterministic public documentation changelog from Git history."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache
from html import escape
from pathlib import Path
import re
import subprocess
from typing import TYPE_CHECKING
from urllib.parse import quote
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from docutils import nodes
from docutils.parsers.rst import directives
from sphinx.errors import ExtensionError
from sphinx.util import logging
from sphinx.util.docutils import SphinxDirective

if TYPE_CHECKING:
    from sphinx.application import Sphinx


LOGGER = logging.getLogger(__name__)
ROOT_CLASS = "fm-documentation-changelog"
ENTRY_CLASS = "fm-changelog-entry"
_COMMIT_SEPARATOR = "\x1e"
_FIELD_SEPARATOR = "\x1f"
_CONVENTIONAL_SUBJECT = re.compile(
    r"^(?P<kind>[A-Za-z]+)(?:\((?P<scope>[^)]+)\))?(?P<breaking>!)?:\s*"
)


@dataclass(frozen=True, slots=True)
class DocumentationCommit:
    sha: str
    changed_at: datetime
    subject: str
    paths: tuple[str, ...]
    deleted_paths: frozenset[str]


_CATEGORY_LABELS = {
    "build": "Build",
    "chore": "Maintenance",
    "ci": "CI",
    "docs": "Documentation",
    "feat": "Added",
    "feature": "Added",
    "fix": "Fixed",
    "perf": "Performance",
    "refactor": "Changed",
    "revert": "Reverted",
    "style": "Presentation",
    "test": "Tests",
}


def _run_git(cwd: Path, *arguments: str) -> str | None:
    try:
        completed = subprocess.run(
            ["git", "-C", str(cwd), *arguments],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=20,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if completed.returncode != 0:
        return None
    output = completed.stdout
    return output if output.strip() else None


@lru_cache(maxsize=None)
def _repository_root(start_directory: str) -> Path | None:
    output = _run_git(Path(start_directory), "rev-parse", "--show-toplevel")
    if output is None:
        return None
    root = Path(output.strip()).resolve()
    return root if root.is_dir() else None


def _parse_timestamp(value: str) -> datetime | None:
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = f"{normalized[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.astimezone()


def _parse_git_log(output: str, limit: int) -> tuple[DocumentationCommit, ...]:
    commits: list[DocumentationCommit] = []
    for raw_record in output.split(_COMMIT_SEPARATOR):
        record = raw_record.strip("\n")
        if not record:
            continue
        lines = record.splitlines()
        header = lines[0].split(_FIELD_SEPARATOR, 2)
        if len(header) != 3:
            continue
        sha, timestamp_text, subject = (field.strip() for field in header)
        timestamp = _parse_timestamp(timestamp_text)
        if not sha or timestamp is None or not subject:
            continue
        changed_paths_list: list[str] = []
        deleted_paths: set[str] = set()
        for line in lines[1:]:
            if not line.strip() or line.startswith(" "):
                continue
            fields = line.split("\t")
            status = fields[0]
            if status.startswith("R") and len(fields) >= 3:
                # Show the post-rename path, but keep the old path out of a
                # blob link because it no longer exists at this revision.
                changed_paths_list.append(fields[2])
                deleted_paths.add(fields[1])
            elif len(fields) >= 2:
                path = fields[1]
                changed_paths_list.append(path)
                if status == "D":
                    deleted_paths.add(path)
            else:
                changed_paths_list.append(line.strip())
        changed_paths = tuple(dict.fromkeys(changed_paths_list))
        if not changed_paths:
            continue
        commits.append(
            DocumentationCommit(
                sha=sha,
                changed_at=timestamp,
                subject=subject,
                paths=changed_paths,
                deleted_paths=frozenset(deleted_paths),
            )
        )
        if len(commits) >= limit:
            break
    return tuple(commits)


@lru_cache(maxsize=None)
def _documentation_commits(
    repository_root_text: str,
    limit: int,
    pathspecs: tuple[str, ...],
) -> tuple[DocumentationCommit, ...]:
    repository_root = Path(repository_root_text)
    requested = max(1, min(int(limit), 250))
    scan_limit = min(max(requested * 4, requested), 1000)
    output = _run_git(
        repository_root,
        "log",
        "--first-parent",
        f"--max-count={scan_limit}",
        "--date=iso-strict",
        f"--pretty=format:{_COMMIT_SEPARATOR}%H{_FIELD_SEPARATOR}%cI{_FIELD_SEPARATOR}%s",
        "--name-status",
        "-M",
        "--",
        *pathspecs,
    )
    if output is None:
        return ()
    return _parse_git_log(output, requested)


@lru_cache(maxsize=None)
def _timezone(name: str):
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        LOGGER.warning(
            "Timezone database does not contain %s; using UTC for changelog entries.",
            name,
        )
        return ZoneInfo("UTC")


def _subject_metadata(subject: str) -> tuple[str, str, str | None, bool]:
    match = _CONVENTIONAL_SUBJECT.match(subject)
    if match is None:
        return "Change", "change", None, False
    kind = match.group("kind").lower()
    category = _CATEGORY_LABELS.get(kind, kind.capitalize())
    scope = match.group("scope")
    slug = re.sub(r"[^a-z0-9]+", "-", kind).strip("-") or "change"
    return category, slug, scope, bool(match.group("breaking"))


def _path_reference(
    repository_url: str,
    commit: DocumentationCommit,
    path: str,
) -> nodes.reference:
    if path in commit.deleted_paths:
        return nodes.reference(
            "",
            path,
            refuri=f"{repository_url}/commit/{commit.sha}",
            classes=["fm-changelog-path", "fm-changelog-path--deleted"],
        )
    encoded_path = quote(path, safe="/")
    return nodes.reference(
        "",
        path,
        refuri=f"{repository_url}/blob/{commit.sha}/{encoded_path}",
        classes=["fm-changelog-path"],
    )


def _render_history_summary(
    app: Sphinx,
    commit: DocumentationCommit,
    *,
    summary_label: str,
    history_url: str,
    repository_url: str,
    local_timezone,
) -> nodes.container:
    localized = commit.changed_at.astimezone(local_timezone)
    summary = nodes.container(classes=["fm-changelog-summary"])
    line = nodes.paragraph(classes=["fm-changelog-summary__line"])
    line += nodes.strong("", summary_label)
    line += nodes.raw(
        "",
        (
            f' <time class="fm-changelog-summary__time" '
            f'datetime="{escape(commit.changed_at.isoformat(), quote=True)}">'
            f"{escape(localized.strftime('%H:%M %d.%m.%Y %Z'))}</time>"
        ),
        format="html",
    )
    line += nodes.Text(" · ")
    line += nodes.reference(
        "",
        commit.sha[:10],
        refuri=f"{repository_url}/commit/{commit.sha}",
        classes=["fm-changelog-summary__commit"],
    )
    line += nodes.Text(" · ")
    line += nodes.reference(
        "",
        "Full history on GitHub",
        refuri=history_url,
        classes=["fm-changelog-summary__history"],
    )
    summary += line
    return summary


def _render_commit_history(
    app: Sphinx,
    commits: tuple[DocumentationCommit, ...],
    *,
    root_class: str,
    summary_label: str,
    history_url: str,
    empty_text: str,
    show_paths: bool,
) -> nodes.container:
    root = nodes.container(classes=[root_class])
    if not commits:
        root += nodes.paragraph("", empty_text, classes=["fm-changelog-unavailable"])
        return root

    repository_url = app.config.documentation_changelog_repository_url.rstrip("/")
    local_timezone = _timezone(app.config.documentation_changelog_timezone)
    root += _render_history_summary(
        app,
        commits[0],
        summary_label=summary_label,
        history_url=history_url,
        repository_url=repository_url,
        local_timezone=local_timezone,
    )

    grouped: dict[str, list[DocumentationCommit]] = defaultdict(list)
    for commit in commits:
        date_label = commit.changed_at.astimezone(local_timezone).strftime("%d.%m.%Y")
        grouped[date_label].append(commit)

    for date_label, day_commits in grouped.items():
        root += nodes.rubric("", date_label, classes=["fm-changelog-date"])
        day = nodes.container(classes=["fm-changelog-day"])
        for commit in day_commits:
            category, category_slug, scope, breaking = _subject_metadata(commit.subject)
            entry_classes = [ENTRY_CLASS, f"fm-changelog-entry--{category_slug}"]
            if breaking:
                entry_classes.append("fm-changelog-entry--breaking")
            entry = nodes.container(classes=entry_classes)

            heading = nodes.paragraph(classes=["fm-changelog-heading"])
            heading += nodes.inline(
                "",
                category,
                classes=["fm-changelog-badge", f"fm-changelog-badge--{category_slug}"],
            )
            if scope:
                heading += nodes.inline(
                    "",
                    scope,
                    classes=["fm-changelog-scope"],
                )
            heading += nodes.reference(
                "",
                commit.subject,
                refuri=f"{repository_url}/commit/{commit.sha}",
                classes=["fm-changelog-subject"],
            )
            entry += heading

            localized = commit.changed_at.astimezone(local_timezone)
            metadata = nodes.paragraph(classes=["fm-changelog-meta"])
            metadata += nodes.inline(
                "",
                localized.strftime("%H:%M %Z"),
                classes=["fm-changelog-time"],
            )
            metadata += nodes.literal("", commit.sha[:10])
            if breaking:
                metadata += nodes.strong("", "breaking change")
            entry += metadata

            if show_paths:
                visible_paths = commit.paths[:6]
                path_line = nodes.paragraph(classes=["fm-changelog-paths"])
                path_line += nodes.strong("", "Changed: ")
                for index, path in enumerate(visible_paths):
                    if index:
                        path_line += nodes.Text(" · ")
                    path_line += _path_reference(repository_url, commit, path)
                hidden_count = len(commit.paths) - len(visible_paths)
                if hidden_count > 0:
                    path_line += nodes.Text(f" · +{hidden_count} more")
                entry += path_line

            day += entry
        root += day
    return root


def _history_container(
    app: Sphinx,
    *,
    pathspecs: tuple[str, ...],
    limit: int,
    root_class: str,
    summary_label: str,
    history_url: str,
    empty_text: str,
    show_paths: bool,
) -> nodes.container:
    repository_root = _repository_root(str(Path(app.srcdir).resolve()))
    if repository_root is None:
        return _render_commit_history(
            app,
            (),
            root_class=root_class,
            summary_label=summary_label,
            history_url=history_url,
            empty_text=(
                "Git history is unavailable in this documentation build. "
                "Use the repository history for the authoritative change record."
            ),
            show_paths=show_paths,
        )
    commits = _documentation_commits(str(repository_root), limit, pathspecs)
    return _render_commit_history(
        app,
        commits,
        root_class=root_class,
        summary_label=summary_label,
        history_url=history_url,
        empty_text=empty_text,
        show_paths=show_paths,
    )


class DocumentationChangelogDirective(SphinxDirective):
    """Insert recent first-parent commits that changed public documentation."""

    has_content = False
    option_spec = {
        "limit": directives.nonnegative_int,
        "show-paths": directives.flag,
    }

    def run(self) -> list[nodes.Node]:
        app = self.env.app
        branch = str(app.config.documentation_changelog_branch)
        repository_url = app.config.documentation_changelog_repository_url.rstrip("/")
        limit = int(self.options.get("limit", app.config.documentation_changelog_limit))
        return [
            _history_container(
                app,
                pathspecs=tuple(app.config.documentation_changelog_pathspecs),
                limit=limit,
                root_class=ROOT_CLASS,
                summary_label="Latest documentation change",
                history_url=f"{repository_url}/commits/{branch}/public_docs/site",
                empty_text="No documentation commits were found for the configured paths.",
                show_paths="show-paths" in self.options,
            )
        ]


class DocumentationChangelogTabsDirective(SphinxDirective):
    """Render separate documentation and GitHub/code change histories."""

    has_content = False
    option_spec = {
        "documentation-limit": directives.nonnegative_int,
        "code-limit": directives.nonnegative_int,
        "show-paths": directives.flag,
    }

    def run(self) -> list[nodes.Node]:
        app = self.env.app
        branch = str(app.config.documentation_changelog_branch)
        repository_url = app.config.documentation_changelog_repository_url.rstrip("/")
        show_paths = "show-paths" in self.options
        root = nodes.container(classes=["fm-changelog-tabs"])
        root += nodes.raw(
            "",
            (
                '<input class="fm-changelog-tab-input" type="radio" '
                'name="fm-changelog-tab" id="fm-changelog-tab-documentation" checked="checked">'
                '<label class="fm-changelog-tab-label fm-changelog-tab-label--documentation" '
                'for="fm-changelog-tab-documentation">Documentation</label>'
                '<input class="fm-changelog-tab-input" type="radio" '
                'name="fm-changelog-tab" id="fm-changelog-tab-code">'
                '<label class="fm-changelog-tab-label fm-changelog-tab-label--code" '
                'for="fm-changelog-tab-code">GitHub / code</label>'
            ),
            format="html",
        )

        documentation_panel = nodes.container(
            classes=[
                "fm-changelog-tab-panel",
                "fm-changelog-tab-panel--documentation",
            ],
            ids=["fm-changelog-panel-documentation"],
        )
        documentation_panel += _history_container(
            app,
            pathspecs=tuple(app.config.documentation_changelog_pathspecs),
            limit=int(
                self.options.get(
                    "documentation-limit", app.config.documentation_changelog_limit
                )
            ),
            root_class=ROOT_CLASS,
            summary_label="Latest documentation change",
            history_url=f"{repository_url}/commits/{branch}/public_docs/site",
            empty_text="No documentation commits were found for the configured paths.",
            show_paths=show_paths,
        )
        root += documentation_panel

        code_panel = nodes.container(
            classes=["fm-changelog-tab-panel", "fm-changelog-tab-panel--code"],
            ids=["fm-changelog-panel-code"],
        )
        code_panel += _history_container(
            app,
            pathspecs=tuple(app.config.documentation_code_changelog_pathspecs),
            limit=int(
                self.options.get("code-limit", app.config.documentation_code_changelog_limit)
            ),
            root_class="fm-code-changelog",
            summary_label="Latest code change",
            history_url=f"{repository_url}/commits/{branch}/",
            empty_text="No code commits were found for the configured paths.",
            show_paths=show_paths,
        )
        root += code_panel
        return [root]


def _validate_rendered_changelog(app: Sphinx, exception: BaseException | None) -> None:
    if (
        exception is not None
        or app.builder.format != "html"
        or getattr(app.builder, "name", "") == "changes"
    ):
        return
    if "changelog/index" not in app.env.found_docs:
        raise ExtensionError("The documentation changelog page is missing from the Sphinx source tree.")
    output_path = Path(app.builder.get_outfilename("changelog/index"))
    try:
        rendered = output_path.read_text(encoding="utf-8")
    except OSError as error:
        raise ExtensionError(f"Cannot read rendered documentation changelog: {error}") from error
    class_pattern = re.compile(
        rf'class="[^"]*\b{re.escape(ROOT_CLASS)}\b[^"]*"'
    )
    if len(class_pattern.findall(rendered)) != 1:
        raise ExtensionError("Rendered documentation changelog must contain exactly one changelog root.")
    has_commit_link = (
        f"{app.config.documentation_changelog_repository_url.rstrip('/')}/commit/" in rendered
    )
    has_unavailable_fallback = 'fm-changelog-unavailable' in rendered
    if not has_commit_link and not has_unavailable_fallback:
        raise ExtensionError("Rendered documentation changelog contains no repository commit links.")
    LOGGER.info("Validated rendered documentation changelog: %s", output_path)


def _mark_changelog_outdated(app, env, added, changed, removed) -> list[str]:
    """Re-run the Git-backed directive when the repository history advances."""
    return ["changelog/index"] if "changelog/index" in env.found_docs else []


def setup(app: Sphinx) -> dict[str, object]:
    app.add_config_value(
        "documentation_changelog_repository_url",
        "https://github.com/MateuszZelent/fullmag",
        "html",
    )
    app.add_config_value("documentation_changelog_branch", "master", "html")
    app.add_config_value("documentation_changelog_limit", 80, "html")
    app.add_config_value("documentation_code_changelog_limit", 40, "html")
    app.add_config_value("documentation_changelog_timezone", "Europe/Warsaw", "html")
    app.add_config_value(
        "documentation_changelog_pathspecs",
        (
            "public_docs/site",
            ".github/workflows/documentation.yml",
            "scripts/public_docs_information_architecture.py",
            "scripts/check_public_docs_information_architecture.py",
            "scripts/check_public_doc_examples.py",
            ".agents/skills/scientific-documentation-contract",
            "packages/fullmag-py/tests/test_public_python_api_documentation.py",
            "packages/fullmag-py/tests/test_public_exchange_documentation.py",
            "packages/fullmag-py/tests/test_material_dmi_units.py",
        ),
        "html",
    )
    app.add_config_value(
        "documentation_code_changelog_pathspecs",
        (
            ".",
            ":(exclude)public_docs/site",
            ":(exclude)docs",
            ":(exclude)**/*.md",
            ":(exclude)**/*.rst",
            ":(exclude).github/workflows/documentation.yml",
            ":(exclude).agents/skills/scientific-documentation-contract",
            ":(exclude)packages/fullmag-py/tests/test_public_python_api_documentation.py",
            ":(exclude)packages/fullmag-py/tests/test_public_exchange_documentation.py",
            ":(exclude)packages/fullmag-py/tests/test_material_dmi_units.py",
            ":(exclude)scripts/public_docs_information_architecture.py",
            ":(exclude)scripts/check_public_docs_information_architecture.py",
            ":(exclude)scripts/check_public_doc_examples.py",
        ),
        "html",
    )
    app.add_directive("documentation-changelog", DocumentationChangelogDirective)
    app.add_directive("documentation-changelog-tabs", DocumentationChangelogTabsDirective)
    app.connect("env-get-outdated", _mark_changelog_outdated)
    app.connect("build-finished", _validate_rendered_changelog)
    return {
        "version": "1",
        "parallel_read_safe": True,
        "parallel_write_safe": True,
    }
