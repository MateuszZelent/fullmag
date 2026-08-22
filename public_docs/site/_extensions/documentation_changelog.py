"""Render a deterministic public documentation changelog from Git history."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache
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


class DocumentationChangelogDirective(SphinxDirective):
    """Insert recent first-parent commits that changed public documentation."""

    has_content = False
    option_spec = {
        "limit": directives.nonnegative_int,
        "show-paths": directives.flag,
    }

    def run(self) -> list[nodes.Node]:
        app = self.env.app
        repository_root = _repository_root(str(Path(app.srcdir).resolve()))
        root = nodes.container(classes=[ROOT_CLASS])
        if repository_root is None:
            root += nodes.paragraph(
                "",
                "Git history is unavailable in this documentation build. "
                "Use the repository history for the authoritative change record.",
                classes=["fm-changelog-unavailable"],
            )
            return [root]

        limit = int(self.options.get("limit", app.config.documentation_changelog_limit))
        pathspecs = tuple(app.config.documentation_changelog_pathspecs)
        commits = _documentation_commits(str(repository_root), limit, pathspecs)
        if not commits:
            root += nodes.paragraph(
                "",
                "No documentation commits were found for the configured paths.",
                classes=["fm-changelog-unavailable"],
            )
            return [root]

        repository_url = app.config.documentation_changelog_repository_url.rstrip("/")
        local_timezone = _timezone(app.config.documentation_changelog_timezone)
        grouped: dict[str, list[DocumentationCommit]] = defaultdict(list)
        for commit in commits:
            date_label = commit.changed_at.astimezone(local_timezone).strftime("%d.%m.%Y")
            grouped[date_label].append(commit)

        show_paths = "show-paths" in self.options
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
    app.add_config_value("documentation_changelog_limit", 80, "html")
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
    app.add_directive("documentation-changelog", DocumentationChangelogDirective)
    app.connect("env-get-outdated", _mark_changelog_outdated)
    app.connect("build-finished", _validate_rendered_changelog)
    return {
        "version": "1",
        "parallel_read_safe": True,
        "parallel_write_safe": True,
    }
