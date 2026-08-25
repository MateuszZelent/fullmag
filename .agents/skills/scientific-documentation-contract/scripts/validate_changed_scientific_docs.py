#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ast
import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path, PurePosixPath
from types import ModuleType

from validate_scientific_docs import (
    _safe_path,
    _source_symbol_declarations,
    validate_page,
)


SCIENTIFIC_ROOTS = (
    "docs/physics",
    "public_docs/site/physics",
    "public_docs/site/numerical-methods",
)
NUMERICAL_METHODS_ROOT = "public_docs/site/numerical-methods"
NUMERICAL_METHOD_REQUIRED_MARKERS = (
    "## Scope and purpose",
    "## Scientific and numerical model",
    "## Parameters",
    "## Python API",
    "## Control Room workflow",
    "## Diagnostics and failure semantics",
    "## Where this is implemented",
)
NUMERICAL_PYTHON_BLOCK_RE = re.compile(r"```python\s*\n(.*?)```", re.DOTALL)
NUMERICAL_EXPECTED_LANES = {
    (solver, device)
    for solver in ("FEM", "FDM")
    for device in ("CPU", "GPU")
}
EXEMPT_NAMES = {"README.md", "index.md"}
EXEMPT_PATHS = {
    # Governance for authoring physics notes, not a physical/numerical model note.
    "docs/physics/0000-physics-documentation-standard.md",
}


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        check=False,
    )


def _exists(repo: Path, revision: str, path: str) -> bool:
    return _git(repo, "cat-file", "-e", f"{revision}:{path}").returncode == 0


def _read(repo: Path, revision: str, path: str) -> bytes | None:
    result = _git(repo, "show", f"{revision}:{path}")
    return result.stdout if result.returncode == 0 else None


def _is_scientific_page(path: str) -> bool:
    candidate = PurePosixPath(path)
    return (
        candidate.suffix == ".md"
        and candidate.name not in EXEMPT_NAMES
        and any(candidate.is_relative_to(root) for root in SCIENTIFIC_ROOTS)
    )


def _manifest_for(page: str) -> str:
    return str(PurePosixPath(page).with_suffix(".source-map.json"))


def _page_for(manifest: str) -> str:
    return manifest.removesuffix(".source-map.json") + ".md"


def _is_numerical_method_page(path: str) -> bool:
    candidate = PurePosixPath(path)
    return candidate.suffix == ".md" and candidate.is_relative_to(NUMERICAL_METHODS_ROOT)


def _validate_numerical_method_manifest(
    repo: Path, head: str, manifest_path: str, manifest: object
) -> list[str]:
    """Validate the reference-page contract used by numerical-method pages.

    These pages use a smaller sidecar than publication-style physics notes, but the page
    itself still has to carry the scientific model, lane matrix, executable example,
    parameter/IR table, verification semantics and source index.
    """
    errors: list[str] = []
    if not isinstance(manifest, dict):
        return ["manifest must be an object"]
    document = manifest.get("document")
    if not isinstance(document, dict):
        return ["document must be an object"]
    expected_page = _page_for(manifest_path)
    if document.get("path") != expected_page:
        errors.append(f"document.path must equal adjacent page {expected_page}")
    reviewed_revision = document.get("reviewed_revision")
    if not isinstance(reviewed_revision, str) or len(reviewed_revision) != 40:
        errors.append("document.reviewed_revision must be a full 40-character commit")
    else:
        revision_type = _git(repo, "cat-file", "-t", reviewed_revision)
        if revision_type.returncode != 0 or revision_type.stdout.strip() != b"commit":
            errors.append(
                "document.reviewed_revision must name a commit in the repository: "
                f"{reviewed_revision}"
            )
        elif _git(repo, "merge-base", "--is-ancestor", reviewed_revision, head).returncode != 0:
            errors.append(
                "document.reviewed_revision must be an ancestor of the validated head: "
                f"{reviewed_revision}"
            )

    page_bytes = _read(repo, head, expected_page)
    page = page_bytes.decode("utf-8", errors="replace") if page_bytes is not None else ""
    if page_bytes is None:
        errors.append(f"document page does not exist at {head}: {expected_page}")
    else:
        for marker in NUMERICAL_METHOD_REQUIRED_MARKERS:
            if marker not in page:
                errors.append(f"page missing required numerical-method section: {marker}")
        if "```{math}" not in page or ":label:" not in page:
            errors.append("page requires at least one labelled MyST math equation")
        if not re.search(r"(?i)\\mathrm|\bSI\b|\bunit", page):
            errors.append("page requires explicit symbol/unit evidence")
        if "Python / IR" not in page and "ProblemIR" not in page:
            errors.append("page requires a Python-to-ProblemIR mapping table")
        python_blocks = NUMERICAL_PYTHON_BLOCK_RE.findall(page)
        if not python_blocks:
            errors.append("page requires an executable Python example")
        for index, block in enumerate(python_blocks):
            try:
                ast.parse(block)
            except SyntaxError as exc:
                errors.append(
                    f"python block {index + 1} does not parse: {exc.msg} at line {exc.lineno}"
                )
            if "fm.Problem(" in block:
                errors.append(
                    f"python block {index + 1} uses fm.Problem(); use the stage-first study API"
                )

    sources = manifest.get("sources")
    if not isinstance(sources, list) or not sources:
        errors.append("sources must be a non-empty list")
        return errors
    source_ids: set[str] = set()
    source_index_seen = False
    for index, source in enumerate(sources):
        label = f"sources[{index}]"
        if not isinstance(source, dict):
            errors.append(f"{label} must be an object")
            continue
        for field in ("id", "path", "symbol", "responsibility"):
            if not isinstance(source.get(field), str) or not source[field].strip():
                errors.append(f"{label}.{field} is required")
        source_id = source.get("id")
        if isinstance(source_id, str):
            if source_id in source_ids:
                errors.append(f"duplicate source id: {source_id}")
            source_ids.add(source_id)
        path = _safe_path(source.get("path"), f"{label}.path", errors)
        symbol = source.get("symbol")
        if path is None or not isinstance(symbol, str) or not symbol.strip():
            continue
        source_bytes = _read(repo, reviewed_revision, path) if isinstance(reviewed_revision, str) else None
        if source_bytes is None:
            errors.append(f"{label} source path does not exist at {reviewed_revision}: {path}")
            continue
        source_text = source_bytes.decode("utf-8", errors="replace")
        declarations = _source_symbol_declarations(path, source_text, symbol)
        if not declarations:
            errors.append(f"{label} declaration not found in {path}: {symbol}")
        elif len(declarations) != 1:
            errors.append(f"{label} declaration is not unique in {path}: {symbol}")
        page_symbol = symbol.removeprefix("class ").removeprefix("DOC-ANCHOR:")
        if page and (path in page or page_symbol in page):
            source_index_seen = True

    if page and not source_index_seen:
        errors.append("source index must name at least one mapped path and symbol")

    lanes = manifest.get("backend_matrix")
    if not isinstance(lanes, list):
        errors.append("backend_matrix must cover all four backend lanes: FEM/FDM CPU/GPU")
    else:
        actual_lanes: set[tuple[str, str]] = set()
        for lane in lanes:
            if not isinstance(lane, dict):
                errors.append("backend_matrix entries must be objects")
                continue
            solver = lane.get("solver")
            device = lane.get("device")
            if not isinstance(solver, str) or not isinstance(device, str):
                errors.append("backend_matrix lane solver/device must be strings")
                continue
            actual_lanes.add((solver, device))
        if actual_lanes != NUMERICAL_EXPECTED_LANES:
            errors.append("backend_matrix must cover all four backend lanes: FEM/FDM CPU/GPU")
        for lane in lanes:
            if isinstance(lane, dict) and lane.get("status") in {"unsupported", "not-applicable"} and not lane.get("reason"):
                errors.append("unsupported backend lane requires an evidence-based reason")
    return errors


def _load_architecture_manifest(repo_root: Path) -> ModuleType | None:
    manifest_path = repo_root / "scripts" / "public_docs_information_architecture.py"
    if not manifest_path.is_file():
        return None
    module_name = "_fullmag_public_docs_information_architecture"
    spec = importlib.util.spec_from_file_location(module_name, manifest_path)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        return None
    finally:
        sys.modules.pop(module_name, None)
    return module


def _independent_scaffold_text(page_spec: object) -> str | None:
    """Render the only source-map-free shape without trusting repo generator code."""
    title = getattr(page_spec, "title", None)
    label = getattr(page_spec, "label", None)
    scope = getattr(page_spec, "scope", None)
    children = getattr(page_spec, "children", ())
    path = getattr(page_spec, "path", None)
    if not all(isinstance(value, str) and value for value in (title, label, scope, path)):
        return None
    if any(token in scope for token in ("=", "\\", "`", "$", "{", "}", "[", "]", "\n")):
        return None
    if not isinstance(children, tuple) or not all(isinstance(child, str) for child in children):
        return None
    rendered = (
        "---\n"
        f"title: {title}\n"
        "status: planned\n"
        "doc_kind: scaffold\n"
        "audience: user\n"
        "owner: fullmag-public-docs\n"
        "---\n\n"
        f"({label})=\n"
        f"# {title}\n\n"
        f"This page reserves the public documentation location for {scope}.\n"
    )
    if children:
        parent = PurePosixPath(path).parent
        entries = "\n".join(
            str(PurePosixPath(child).relative_to(parent).with_suffix(""))
            for child in children
        )
        rendered += f"\n```{{toctree}}\n:maxdepth: 1\n\n{entries}\n```\n"
    if path in {
        "physics/solvers/fdm/cpu/interactions/exchange.md",
        "physics/solvers/fdm/gpu/interactions/exchange.md",
        "physics/solvers/fem/cpu/interactions/exchange.md",
        "physics/solvers/fem/gpu/interactions/exchange.md",
    }:
        rendered += (
            "\n## Related pages\n\n"
            "- {doc}`../../../../exchange`\n"
            "- {doc}`../../../../../python-api/interactions/exchange`\n"
        )
    return rendered


def is_registered_scaffold(path: Path, repo_root: Path) -> bool:
    try:
        relative = path.resolve().relative_to(repo_root.resolve())
    except ValueError:
        return False
    public_root = PurePosixPath("public_docs/site")
    relative_posix = PurePosixPath(relative.as_posix())
    try:
        manifest_path = str(relative_posix.relative_to(public_root))
    except ValueError:
        return False

    module = _load_architecture_manifest(repo_root)
    if module is None:
        return False
    page_specs = getattr(module, "PAGE_SPECS", ())
    matching = [spec for spec in page_specs if getattr(spec, "path", None) == manifest_path]
    if len(matching) != 1:
        return False
    page_spec = matching[0]
    if getattr(page_spec, "status", None) != "planned":
        return False
    if getattr(page_spec, "doc_kind", None) != "scaffold":
        return False
    try:
        expected = _independent_scaffold_text(page_spec)
        actual = path.read_bytes().replace(b"\r\n", b"\n")
        return expected is not None and actual == expected.encode("utf-8")
    except (OSError, UnicodeError, ValueError, TypeError):
        return False


def validate_changed(repo: Path, base: str, head: str) -> list[str]:
    diff = _git(
        repo,
        "diff",
        "--name-only",
        "-z",
        f"{base}...{head}",
        "--",
        *SCIENTIFIC_ROOTS,
    )
    if diff.returncode != 0:
        detail = diff.stderr.decode(errors="replace").strip()
        return [f"cannot compare {base}...{head}: {detail}"]
    changed = {item.decode("utf-8") for item in diff.stdout.split(b"\0") if item}
    manifests: set[str] = set()
    errors: list[str] = []

    for path in changed:
        if path in EXEMPT_PATHS:
            continue
        if _is_scientific_page(path):
            manifest = _manifest_for(path)
            if _exists(repo, head, path):
                if _exists(repo, head, manifest):
                    manifests.add(manifest)
                elif not is_registered_scaffold(repo / path, repo):
                    errors.append(f"changed scientific page requires sidecar manifest: {manifest}")
            elif _exists(repo, head, manifest):
                errors.append(f"deleted scientific page left an orphan sidecar manifest: {manifest}")
        elif path.endswith(".source-map.json"):
            page = _page_for(path)
            if _exists(repo, head, path):
                if not _exists(repo, head, page):
                    errors.append(f"sidecar manifest has no matching page: {path}")
                else:
                    manifests.add(path)
            elif _exists(repo, head, page):
                errors.append(f"scientific page cannot retain a deleted sidecar manifest: {path}")

    for manifest_path in sorted(manifests):
        raw = _read(repo, head, manifest_path)
        try:
            manifest = json.loads((raw or b"").decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            errors.append(f"{manifest_path}: invalid JSON: {exc}")
            continue
        expected_page = _page_for(manifest_path)
        document = manifest.get("document") if isinstance(manifest, dict) else None
        if not isinstance(document, dict) or document.get("path") != expected_page:
            errors.append(
                f"{manifest_path}: document.path must equal adjacent page {expected_page}"
            )
        errors.extend(
            f"{manifest_path}: {error}"
            for error in (
                _validate_numerical_method_manifest(repo, head, manifest_path, manifest)
                if _is_numerical_method_page(expected_page)
                else validate_page(repo, manifest)
            )
        )
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Require source maps for changed FullMag scientific pages."
    )
    parser.add_argument("--base", required=True)
    parser.add_argument("--head", default="HEAD")
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    args = parser.parse_args()
    errors = validate_changed(args.repo_root.resolve(), args.base, args.head)
    for error in errors:
        print(f"ERROR: {error}")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
