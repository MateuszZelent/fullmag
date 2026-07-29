#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

REQUIRED_SECTIONS = {
    "problem-statement", "governing-equations", "symbols-and-si-units",
    "assumptions-and-validity", "discrete-realization", "implementation-mapping",
    "validation", "limitations", "scientific-bibliography", "source-code-index",
}
PLACEHOLDER_RE = re.compile(r"\b(?:TODO|TBD)\b|to be documented", re.IGNORECASE)
SHA_RE = re.compile(r"^[0-9a-f]{40}$")


@dataclass(frozen=True)
class ResolvedSource:
    path: str
    identity: str
    start_line: int
    end_line: int
    github_url: str


@dataclass
class ValidationResult:
    errors: list[str] = field(default_factory=list)
    resolved_sources: dict[str, ResolvedSource] = field(default_factory=dict)


def _all_strings(value: Any):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for nested in value.values():
            yield from _all_strings(nested)
    elif isinstance(value, list):
        for nested in value:
            yield from _all_strings(nested)


def _resolve_source(
    source: dict[str, Any], repo_root: Path, repository_url: str, result: ValidationResult
) -> None:
    source_id = source.get("id", "<missing-id>")
    rel_path = source.get("path")
    if not rel_path:
        result.errors.append(f"source {source_id}: path is required")
        return
    path = repo_root / rel_path
    if not path.is_file():
        result.errors.append(f"source {source_id}: file does not exist: {rel_path}")
        return
    symbol = source.get("symbol")
    anchor = source.get("anchor")
    identity = symbol or (f"DOC-ANCHOR: {anchor}" if anchor else None)
    if not identity:
        result.errors.append(f"source {source_id}: symbol or DOC-ANCHOR is required")
        return
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    matches = [index for index, line in enumerate(lines, start=1) if identity in line]
    if not matches:
        result.errors.append(f"source {source_id}: symbol or DOC-ANCHOR not found: {identity}")
        return
    if len(matches) > 1:
        result.errors.append(f"source {source_id}: symbol or DOC-ANCHOR is not unique: {identity}")
        return
    start = matches[0]
    end_identity = source.get("end_symbol")
    end = start
    if end_identity:
        end_matches = [i for i, line in enumerate(lines[start - 1 :], start=start) if end_identity in line]
        if not end_matches:
            result.errors.append(f"source {source_id}: end_symbol not found: {end_identity}")
            return
        end = end_matches[0]
    revision = str(source.get("revision", ""))
    github_url = (
        f"{repository_url.rstrip('/')}/blob/{revision}/{rel_path}#L{start}-L{end}"
        if repository_url
        else ""
    )
    result.resolved_sources[source_id] = ResolvedSource(
        rel_path, identity, start, end, github_url
    )


def validate_manifest(manifest: dict[str, Any], repo_root: Path) -> ValidationResult:
    result = ValidationResult()
    if manifest.get("schema_version") != 1:
        result.errors.append("schema_version must equal 1")
    repository_url = str(manifest.get("repository_url", ""))
    if not repository_url.startswith("https://github.com/"):
        result.errors.append("repository_url must be an HTTPS GitHub repository URL")

    document = manifest.get("document") or {}
    hierarchy = document.get("hierarchy") or {}
    for key in ("domain", "solver", "lane", "topic"):
        if not hierarchy.get(key):
            result.errors.append(f"document.hierarchy.{key} is required")
    if hierarchy.get("solver") not in {None, "FEM", "FDM"}:
        result.errors.append("document.hierarchy.solver must be FEM or FDM")
    if hierarchy.get("lane") not in {None, "CPU", "GPU"}:
        result.errors.append("document.hierarchy.lane must be CPU or GPU")

    path = str(document.get("path", ""))
    scope = document.get("publication_scope")
    if scope == "public" and not path.startswith("public_docs/site/"):
        result.errors.append("public document must live under public_docs/site/")
    if scope == "internal" and path.startswith("public_docs/site/"):
        result.errors.append("internal document must not live under public_docs/site/")

    missing_sections = REQUIRED_SECTIONS - set(document.get("sections") or [])
    if document.get("kind") == "terminal" and missing_sections:
        result.errors.append("terminal page missing sections: " + ", ".join(sorted(missing_sections)))
    if not document.get("bibliography"):
        result.errors.append("terminal page requires a scientific bibliography")
    if not document.get("source_index"):
        result.errors.append("terminal page requires a source-code index")

    if any(PLACEHOLDER_RE.search(text) for text in _all_strings(manifest)):
        result.errors.append("manifest contains a forbidden placeholder")

    sources = manifest.get("sources") or []
    source_ids = {source.get("id") for source in sources if source.get("id")}
    for source in sources:
        for key in ("id", "responsibility", "solver", "lane", "revision", "tests"):
            if not source.get(key):
                result.errors.append(f"source {source.get('id', '<missing-id>')}: {key} is required")
        if source.get("solver") not in {"FEM", "FDM"}:
            result.errors.append(f"source {source.get('id')}: solver must be FEM or FDM")
        if source.get("lane") not in {"CPU", "GPU"}:
            result.errors.append(f"source {source.get('id')}: lane must be CPU or GPU")
        if not SHA_RE.fullmatch(str(source.get("revision", ""))):
            result.errors.append(f"source {source.get('id')}: revision must be a full 40-character Git SHA")
        _resolve_source(source, repo_root, repository_url, result)

    equations = manifest.get("equations") or []
    equation_ids = {equation.get("id") for equation in equations if equation.get("id")}
    if not equations:
        result.errors.append("at least one equation is required")
    for equation in equations:
        if not equation.get("id") or not equation.get("latex"):
            result.errors.append("every equation requires id and complete LaTeX")
        terms = equation.get("terms") or []
        if not terms:
            result.errors.append(f"equation {equation.get('id')}: at least one mapped term is required")
        for term in terms:
            mapped = term.get("sources") or []
            if not mapped:
                result.errors.append(f"equation term {term.get('id', '<missing-id>')} requires a source mapping")
            for source_id in mapped:
                if source_id not in source_ids:
                    result.errors.append(f"equation term {term.get('id')}: unknown source {source_id}")

    for entry in document.get("source_index") or []:
        if entry.get("equation") not in equation_ids or entry.get("source") not in source_ids:
            result.errors.append("source-code index references an unknown equation or source")

    for difference in manifest.get("backend_differences") or []:
        if difference.get("different") and len(difference.get("chapters") or {}) < 2:
            result.errors.append(f"{difference.get('dimension', 'backend difference')}: separate chapters are required")

    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate FullMag scientific documentation source maps.")
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    args = parser.parse_args()
    try:
        manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"ERROR: cannot read manifest: {exc}")
        return 2
    result = validate_manifest(manifest, args.repo_root.resolve())
    for source_id, resolved in sorted(result.resolved_sources.items()):
        print(f"SOURCE {source_id}: {resolved.path}:{resolved.start_line}-{resolved.end_line} ({resolved.identity})")
        print(f"LINK {source_id}: {resolved.github_url}")
    for error in result.errors:
        print(f"ERROR: {error}")
    return 1 if result.errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
