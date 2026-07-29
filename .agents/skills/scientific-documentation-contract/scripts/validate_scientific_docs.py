#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any

REQUIRED_SECTIONS = {
    "problem-statement", "governing-equations", "symbols-and-si-units",
    "assumptions-and-validity", "discrete-realization", "implementation-mapping",
    "validation", "limitations", "scientific-bibliography", "source-code-index",
}
EXPECTED_LANES = {("FEM", "CPU"), ("FEM", "GPU"), ("FDM", "CPU"), ("FDM", "GPU")}
PLACEHOLDER_RE = re.compile(
    r"\b(?:TODO|TBD)\b|to be documented|replace with|record-the-", re.IGNORECASE
)
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
MATH_RE = re.compile(
    r"```\{math\}\s*\n(?P<options>(?::[^\n]+\n)*)?(?P<body>.*?)```", re.DOTALL
)
LABEL_RE = re.compile(r"^:label:\s*(\S+)\s*$", re.MULTILINE)


@dataclass(frozen=True)
class ResolvedSource:
    path: str
    identity: str
    revision: str
    start_line: int
    end_line: int
    github_url: str


@dataclass
class ValidationResult:
    errors: list[str] = field(default_factory=list)
    resolved_sources: dict[str, ResolvedSource] = field(default_factory=dict)


def _strings(value: Any):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for nested in value.values():
            yield from _strings(nested)
    elif isinstance(value, list):
        for nested in value:
            yield from _strings(nested)


def _safe_path(value: Any, label: str, errors: list[str]) -> str | None:
    if not isinstance(value, str) or not value or "\\" in value:
        errors.append(f"{label} must be a safe repository-relative path")
        return None
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or "." in path.parts or str(path) != value:
        errors.append(f"{label} must be a safe repository-relative path")
        return None
    return value


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(repo), *args], text=True, capture_output=True, check=False
    )


def _valid_revision(repo: Path, value: Any, label: str, errors: list[str]) -> str | None:
    if value == "HEAD":
        resolved = _git(repo, "rev-parse", "HEAD^{commit}")
        if resolved.returncode != 0:
            errors.append(f"{label} cannot resolve HEAD")
            return None
        return resolved.stdout.strip()
    if not isinstance(value, str) or not SHA_RE.fullmatch(value):
        errors.append(f"{label} must be HEAD or a full 40-character Git SHA")
        return None
    if _git(repo, "cat-file", "-e", f"{value}^{{commit}}").returncode != 0:
        errors.append(f"{label} does not identify a commit in this repository")
        return None
    return value


def _git_text(repo: Path, revision: str, path: str, label: str, errors: list[str]) -> str | None:
    result = _git(repo, "show", f"{revision}:{path}")
    if result.returncode != 0:
        errors.append(f"{label} does not exist at revision {revision}: {path}")
        return None
    return result.stdout


def _objects(value: Any, label: str, errors: list[str]) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        errors.append(f"{label} must be a list")
        return []
    objects: list[dict[str, Any]] = []
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            errors.append(f"{label}[{index}] must be an object")
        else:
            objects.append(item)
    return objects


def _unique_ids(items: list[dict[str, Any]], label: str, errors: list[str]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for item in items:
        item_id = item.get("id")
        if not isinstance(item_id, str) or not item_id:
            errors.append(f"{label} id is required")
            continue
        if item_id in result:
            errors.append(f"duplicate {label} id: {item_id}")
        else:
            result[item_id] = item
    return result


def _math_blocks(page: str) -> dict[str, str]:
    blocks: dict[str, str] = {}
    for match in MATH_RE.finditer(page):
        options = match.group("options") or ""
        label = LABEL_RE.search(options)
        if label:
            blocks[label.group(1)] = match.group("body").strip()
    return blocks


def _latex(value: str) -> str:
    return re.sub(r"\s+", "", value)


def _symbol_row_present(page: str, latex: str, definition: str, si_unit: str) -> bool:
    return any(
        line.lstrip().startswith("|")
        and latex in line
        and definition in line
        and si_unit in line
        for line in page.splitlines()
    )


def _resolve_anchor(
    *, source_id: str, path: str, identity: Any, end_identity: Any, revision: str,
    repo: Path, repository_url: str, result: ValidationResult, label: str,
) -> None:
    if not isinstance(identity, str) or not identity:
        result.errors.append(f"{label} {source_id}: symbol must be a string or DOC-ANCHOR is required")
        return
    content = _git_text(repo, revision, path, label, result.errors)
    if content is None:
        return
    lines = content.splitlines()
    matches = [number for number, line in enumerate(lines, 1) if identity in line]
    if len(matches) != 1:
        suffix = "not found" if not matches else "not unique"
        result.errors.append(f"{label} {source_id}: symbol or DOC-ANCHOR {suffix}: {identity}")
        return
    start = matches[0]
    end = start
    if end_identity is not None:
        if not isinstance(end_identity, str) or not end_identity:
            result.errors.append(f"{label} {source_id}: end_symbol must be a string")
            return
        endings = [number for number, line in enumerate(lines[start - 1 :], start) if end_identity in line]
        if not endings:
            result.errors.append(f"{label} {source_id}: end_symbol not found: {end_identity}")
            return
        end = endings[0]
    url = f"{repository_url.rstrip('/')}/blob/{revision}/{path}#L{start}-L{end}"
    result.resolved_sources[source_id] = ResolvedSource(path, identity, revision, start, end, url)


def validate_manifest(manifest: object, repo_root: Path) -> ValidationResult:
    result = ValidationResult()
    if not isinstance(manifest, dict):
        result.errors.append("manifest must be an object")
        return result
    if manifest.get("schema_version") != 1:
        result.errors.append("schema_version must equal 1")
    repository_url = manifest.get("repository_url")
    if not isinstance(repository_url, str) or not repository_url.startswith("https://github.com/"):
        result.errors.append("repository_url must be an HTTPS GitHub repository URL")
        repository_url = "https://github.com/invalid/invalid"
    if any(PLACEHOLDER_RE.search(text) for text in _strings(manifest)):
        result.errors.append("manifest contains a forbidden placeholder")

    document = manifest.get("document")
    if not isinstance(document, dict):
        result.errors.append("document must be an object")
        return result
    document_path = _safe_path(document.get("path"), "document.path", result.errors)
    document_revision = _valid_revision(repo_root, document.get("revision"), "document.revision", result.errors)
    if document.get("kind") != "terminal":
        result.errors.append("document.kind must be terminal for publication validation")
    hierarchy = document.get("hierarchy")
    if not isinstance(hierarchy, dict):
        result.errors.append("document.hierarchy must be an object")
        hierarchy = {}
    for key in ("domain", "solver", "lane", "topic"):
        if not isinstance(hierarchy.get(key), str) or not hierarchy.get(key):
            result.errors.append(f"document.hierarchy.{key} is required")
    if hierarchy.get("solver") not in {None, "FEM", "FDM"}:
        result.errors.append("document.hierarchy.solver must be FEM or FDM")
    if hierarchy.get("lane") not in {None, "CPU", "GPU"}:
        result.errors.append("document.hierarchy.lane must be CPU or GPU")

    scope = document.get("publication_scope")
    if scope not in {"public", "internal"}:
        result.errors.append("document.publication_scope must be public or internal")
    if document_path and scope == "public" and not PurePosixPath(document_path).is_relative_to("public_docs/site"):
        result.errors.append("public document must live under public_docs/site/")
    if document_path and scope == "internal" and PurePosixPath(document_path).is_relative_to("public_docs/site"):
        result.errors.append("internal document must not live under public_docs/site/")

    page = None
    if document_path and document_revision:
        page = _git_text(repo_root, document_revision, document_path, "document", result.errors)
    declared_sections = document.get("sections")
    if not isinstance(declared_sections, list) or not all(isinstance(x, str) for x in declared_sections):
        result.errors.append("document.sections must be a list of strings")
        declared_sections = []
    for section in sorted(REQUIRED_SECTIONS):
        if section not in declared_sections:
            result.errors.append(f"manifest missing required section: {section}")
        if page is not None and f"({section})=" not in page:
            result.errors.append(f"actual page missing section anchor: {section}")

    bibliography = _objects(document.get("bibliography"), "document.bibliography", result.errors)
    bibliography_by_id = _unique_ids(bibliography, "bibliography", result.errors)
    if not bibliography:
        result.errors.append("terminal page requires a scientific bibliography")
    for entry_id, entry in bibliography_by_id.items():
        citation = entry.get("citation")
        if not isinstance(citation, str) or not citation:
            result.errors.append(f"bibliography {entry_id}: citation is required")
        if not entry.get("doi") and not entry.get("url"):
            result.errors.append(f"bibliography {entry_id}: DOI or stable URL is required")
        if page is not None and isinstance(citation, str) and citation not in page:
            result.errors.append(f"actual page missing bibliography citation: {entry_id}")

    symbols = _objects(manifest.get("symbols"), "symbols", result.errors)
    symbols_by_id = _unique_ids(symbols, "symbol", result.errors)
    for symbol_id, symbol in symbols_by_id.items():
        for key in ("latex", "definition", "si_unit"):
            if not isinstance(symbol.get(key), str) or not symbol.get(key):
                result.errors.append(f"symbol {symbol_id}: {key} is required")
        if (
            page is not None
            and all(isinstance(symbol.get(key), str) and symbol.get(key) for key in ("latex", "definition", "si_unit"))
            and not _symbol_row_present(page, symbol["latex"], symbol["definition"], symbol["si_unit"])
        ):
            result.errors.append(
                f"actual page missing one symbol-table row for {symbol_id} with LaTeX, definition, and SI unit"
            )

    sources = _objects(manifest.get("sources"), "sources", result.errors)
    sources_by_id = _unique_ids(sources, "source", result.errors)
    for source_id, source in sources_by_id.items():
        path = _safe_path(source.get("path"), f"source {source_id}.path", result.errors)
        revision = _valid_revision(repo_root, source.get("revision"), f"source {source_id}.revision", result.errors)
        if revision and document_revision and revision != document_revision:
            result.errors.append(f"source {source_id}: revision must match document revision")
        for key in ("responsibility", "solver", "lane"):
            if not isinstance(source.get(key), str) or not source.get(key):
                result.errors.append(f"source {source_id}: {key} is required")
        if source.get("solver") != hierarchy.get("solver") or source.get("lane") != hierarchy.get("lane"):
            result.errors.append(f"source {source_id}: solver/lane does not match document hierarchy")
        identity = source.get("symbol")
        if identity is None and isinstance(source.get("anchor"), str):
            identity = f"DOC-ANCHOR: {source['anchor']}"
        if path and revision:
            _resolve_anchor(
                source_id=source_id, path=path, identity=identity,
                end_identity=source.get("end_symbol"), revision=revision,
                repo=repo_root, repository_url=repository_url, result=result, label="source",
            )

    evidence = _objects(manifest.get("evidence"), "evidence", result.errors)
    evidence_by_id = _unique_ids(evidence, "evidence", result.errors)
    for evidence_id, item in evidence_by_id.items():
        revision = _valid_revision(repo_root, item.get("revision"), f"evidence {evidence_id}.revision", result.errors)
        if revision and document_revision and revision != document_revision:
            result.errors.append(f"evidence {evidence_id}: revision must match document revision")
        if item.get("kind") != "test":
            result.errors.append(f"evidence {evidence_id}: kind must be test")
        path = _safe_path(item.get("path"), f"evidence {evidence_id}.path", result.errors)
        symbol = item.get("symbol")
        if not isinstance(symbol, str) or not symbol:
            result.errors.append(f"evidence {evidence_id}: symbol must be a string")
        if item.get("status") not in {"runtime-executed", "validated"}:
            result.errors.append(f"evidence {evidence_id}: status must be runtime-executed or validated")
        if hierarchy.get("lane") == "GPU" and not item.get("device_identity"):
            result.errors.append(f"evidence {evidence_id}: GPU evidence requires device_identity")
        if path and revision and isinstance(symbol, str) and symbol:
            content = _git_text(repo_root, revision, path, f"evidence {evidence_id}", result.errors)
            if content is not None and symbol not in content:
                result.errors.append(f"evidence {evidence_id}: symbol not found: {symbol}")

    equations = _objects(manifest.get("equations"), "equations", result.errors)
    equations_by_id = _unique_ids(equations, "equation", result.errors)
    math_blocks = _math_blocks(page or "")
    required_index_pairs: set[tuple[str, str]] = set()
    for equation_id, equation in equations_by_id.items():
        latex = equation.get("latex")
        if not isinstance(latex, str) or not latex:
            result.errors.append(f"equation {equation_id}: complete LaTeX is required")
        elif equation_id not in math_blocks or _latex(math_blocks[equation_id]) != _latex(latex):
            result.errors.append(f"equation {equation_id}: actual page LaTeX does not match manifest")
        used_symbols = equation.get("symbols")
        if not isinstance(used_symbols, list) or not used_symbols:
            result.errors.append(f"equation {equation_id}: symbols list is required")
            used_symbols = []
        for symbol_id in used_symbols:
            if symbol_id not in symbols_by_id:
                result.errors.append(f"equation {equation_id}: undefined symbol {symbol_id}")
        review = equation.get("semantic_review")
        if not isinstance(review, dict) or review.get("status") != "approved" or not review.get("reviewer"):
            result.errors.append(f"equation {equation_id}: approved semantic review is required")
        else:
            review_revision = _valid_revision(
                repo_root, review.get("revision"),
                f"equation {equation_id}.semantic_review.revision", result.errors,
            )
            if review_revision and document_revision and review_revision != document_revision:
                result.errors.append(f"equation {equation_id}: semantic review revision must match document revision")
        terms = _objects(equation.get("terms"), f"equation {equation_id}.terms", result.errors)
        _unique_ids(terms, f"equation {equation_id} term", result.errors)
        if not terms:
            result.errors.append(f"equation {equation_id}: at least one term is required")
        for term in terms:
            term_id = term.get("id", "<missing-id>")
            mapped_sources = term.get("sources") if isinstance(term.get("sources"), list) else []
            mapped_evidence = term.get("evidence") if isinstance(term.get("evidence"), list) else []
            if not mapped_sources:
                result.errors.append(f"equation term {term_id} requires a source mapping")
            if not mapped_evidence:
                result.errors.append(f"equation term {term_id} requires numerical test evidence")
            for source_id in mapped_sources:
                if source_id not in sources_by_id:
                    result.errors.append(f"equation term {term_id}: unknown source {source_id}")
                else:
                    required_index_pairs.add((equation_id, source_id))
            for evidence_id in mapped_evidence:
                if evidence_id not in evidence_by_id:
                    result.errors.append(f"equation term {term_id}: unknown evidence {evidence_id}")

    source_index = _objects(document.get("source_index"), "document.source_index", result.errors)
    if not source_index:
        result.errors.append("terminal page requires a source-code index")
    actual_pairs = {
        (entry.get("equation"), entry.get("source")) for entry in source_index
        if isinstance(entry.get("equation"), str) and isinstance(entry.get("source"), str)
    }
    for pair in sorted(required_index_pairs - actual_pairs):
        result.errors.append(f"source-code index missing equation/source pair: {pair[0]} -> {pair[1]}")
    if page is not None:
        for equation_id, source_id in actual_pairs:
            if equation_id not in page or source_id not in page:
                result.errors.append(f"actual page missing source-code index entry: {equation_id} -> {source_id}")

    matrix = _objects(manifest.get("backend_matrix"), "backend_matrix", result.errors)
    matrix_by_lane: dict[tuple[str, str], dict[str, Any]] = {}
    for entry in matrix:
        key = (entry.get("solver"), entry.get("lane"))
        if key in matrix_by_lane:
            result.errors.append(f"duplicate backend_matrix lane: {key}")
        matrix_by_lane[key] = entry
    if set(matrix_by_lane) != EXPECTED_LANES:
        result.errors.append("backend_matrix must cover exactly FEM/CPU, FEM/GPU, FDM/CPU, and FDM/GPU")
    for key, entry in matrix_by_lane.items():
        status = entry.get("status")
        if status == "unsupported":
            if not isinstance(entry.get("reason"), str) or not entry.get("reason"):
                result.errors.append(f"backend_matrix {key}: unsupported status requires reason")
        elif status in {"different", "shared-proven"}:
            chapter = _safe_path(entry.get("chapter"), f"backend_matrix {key}.chapter", result.errors)
            if chapter and document_revision:
                _git_text(repo_root, document_revision, chapter, f"backend_matrix {key} chapter", result.errors)
            if status == "shared-proven":
                parity = entry.get("parity_evidence")
                if not isinstance(parity, list) or not parity or any(item not in evidence_by_id for item in parity):
                    result.errors.append(f"backend_matrix {key}: shared-proven requires valid parity_evidence")
        else:
            result.errors.append(f"backend_matrix {key}: invalid status")
    current_key = (hierarchy.get("solver"), hierarchy.get("lane"))
    current = matrix_by_lane.get(current_key)
    if current and current.get("chapter") != document_path:
        result.errors.append("backend_matrix current lane chapter must equal document.path")

    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate FullMag scientific documentation against Git source.")
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
