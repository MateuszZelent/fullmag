#!/usr/bin/env python3
"""Generate the bounded P0-A inventory for the Fullmag refactor.

This is a source inventory, not a build or qualification command.  It reads
the checkout, the generated OpenAPI document, the v2 router, ABI declarations,
and source references.  With ``--write`` it writes only the two P0-A outputs:
``docs/plans/active/refactor_runtime/final/p0/inventory.json`` and
``docs/plans/active/refactor_runtime/final/p0/01-inventory.md``.

The script deliberately records ``UNRESOLVED`` instead of inferring a handler,
consumer, producer, or runtime capability from a filename or an identifier.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


HTTP_METHODS = ("get", "post", "put", "patch", "delete", "head", "options", "trace")
HTTP_METHODS_UPPER = {method.upper() for method in HTTP_METHODS}
SOURCE_SUFFIXES = {
    ".c",
    ".cc",
    ".cpp",
    ".h",
    ".hpp",
    ".js",
    ".json",
    ".mjs",
    ".mts",
    ".py",
    ".ps1",
    ".rs",
    ".sh",
    ".toml",
    ".ts",
    ".tsx",
    ".yaml",
    ".yml",
}
SOURCE_BASENAMES = {"Cargo.toml", "Makefile", "justfile", "package.json", "pyproject.toml"}
SKIP_PARTS = {
    ".git",
    ".next",
    ".next-audit-target-smoke-airbox-h-demag-variant-a",
    ".next-audit-target-smoke-cuda-observable-parity",
    ".next-audit-target-smoke-fem-mixed-prism",
    ".fullmag",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "target",
}
GENERATED_OUTPUTS = {
    "scripts/audit_refactor_p0.py",
    "docs/plans/active/refactor_runtime/final/p0/inventory.json",
    "docs/plans/active/refactor_runtime/final/p0/01-inventory.md",
}


def run_git(root: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=root,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        return ""
    return result.stdout


def rel_path(root: Path, path: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()


def sha256_file(path: Path) -> str | None:
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def line_at(text: str, offset: int) -> int:
    return text.count("\n", 0, max(0, offset)) + 1


def line_of(text: str, needle: str, start: int = 0) -> int | None:
    index = text.find(needle, start)
    return None if index < 0 else line_at(text, index)


def safe_read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except (OSError, UnicodeError):
        return ""


def is_source_path(path: Path) -> bool:
    return path.name in SOURCE_BASENAMES or path.suffix.lower() in SOURCE_SUFFIXES


def should_skip(path: Path) -> bool:
    return any(part in SKIP_PARTS for part in path.parts)


def source_files(root: Path) -> list[Path]:
    listed = run_git(root, "ls-files", "-co", "--exclude-standard", "-z")
    candidates = [Path(item) for item in listed.split("\0") if item]
    if not candidates:
        candidates = [
            path.relative_to(root)
            for path in root.rglob("*")
            if path.is_file() and not should_skip(path)
        ]
    result: list[Path] = []
    seen: set[str] = set()
    for relative in candidates:
        path = root / relative
        key = relative.as_posix()
        if key in seen or should_skip(relative) or not path.is_file() or not is_source_path(path):
            continue
        seen.add(key)
        result.append(path)
    return sorted(result, key=lambda item: rel_path(root, item))


def source_texts(root: Path) -> dict[str, str]:
    texts: dict[str, str] = {}
    for path in source_files(root):
        relative = rel_path(root, path)
        if relative in GENERATED_OUTPUTS:
            continue
        text = safe_read(path)
        if text:
            texts[relative] = text
    return texts


def normalize_path(path: str) -> str:
    return re.sub(r":([A-Za-z_][A-Za-z0-9_]*)", r"{\1}", path)


def axum_path(path: str) -> str:
    return re.sub(r"\{([A-Za-z_][A-Za-z0-9_]*)\}", r":\1", path)


def balanced_block(text: str, opening: int) -> int | None:
    """Return the matching ')' while ignoring quoted Rust/JS strings."""

    depth = 0
    quote: str | None = None
    escaped = False
    for index in range(opening, len(text)):
        char = text[index]
        if quote is not None:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char in {"\"", "'", "`"}:
            quote = char
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                return index
    return None


def extract_router_routes(root: Path) -> list[dict[str, Any]]:
    relative = "crates/fullmag-api/src/router_v2/mod.rs"
    path = root / relative
    text = safe_read(path)
    routes: list[dict[str, Any]] = []
    for match in re.finditer(r"\.route\s*\(", text):
        end = balanced_block(text, match.end() - 1)
        if end is None:
            continue
        block = text[match.end() : end]
        path_match = re.search(r"[\"']([^\"']+)[\"']", block)
        if path_match is None:
            continue
        route_path = path_match.group(1)
        for method_match in re.finditer(
            r"\b(" + "|".join(HTTP_METHODS) + r")\s*\(\s*([A-Za-z_][A-Za-z0-9_:]*)",
            block,
        ):
            handler = method_match.group(2)
            absolute = match.end() + method_match.start()
            routes.append(
                {
                    "path": route_path,
                    "normalized_path": normalize_path(route_path),
                    "method": method_match.group(1).upper(),
                    "handler": handler,
                    "source": f"{relative}:{line_at(text, absolute)}",
                    "source_path": relative,
                    "source_line": line_at(text, absolute),
                    "route_block_line": line_at(text, match.start()),
                }
            )
    return routes


def extract_openapi(root: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    relative = "apps/control-room/src/kernel/api/generated/openapi-v2.json"
    path = root / relative
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return {"error": str(error), "source": relative}, []
    operations: list[dict[str, Any]] = []
    for route_path, item in sorted(document.get("paths", {}).items()):
        if not isinstance(item, dict):
            continue
        for method, operation in sorted(item.items()):
            if method.upper() not in HTTP_METHODS_UPPER:
                continue
            operation = operation if isinstance(operation, dict) else {}
            operations.append(
                {
                    "path": route_path,
                    "normalized_path": normalize_path(route_path),
                    "method": method.upper(),
                    "operation_id": operation.get("operationId"),
                    "tags": operation.get("tags", []),
                }
            )
    return document, operations


def build_handler_index(root: Path) -> dict[str, list[dict[str, Any]]]:
    index: dict[str, list[dict[str, Any]]] = defaultdict(list)
    handler_root = root / "crates/fullmag-api/src/router_v2"
    for path in sorted(handler_root.rglob("*.rs")) if handler_root.exists() else []:
        if path.name == "tests.rs":
            continue
        text = safe_read(path)
        for match in re.finditer(r"\b(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\b", text):
            index[match.group(1)].append(
                {"source": rel_path(root, path), "line": line_at(text, match.start()), "symbol": match.group(1)}
            )
    return dict(index)


def resolve_handler(
    root: Path,
    handler: str,
    cache: dict[str, dict[str, Any]],
    handler_index: dict[str, list[dict[str, Any]]],
) -> dict[str, Any]:
    if handler in cache:
        return cache[handler]
    symbol = handler.rsplit("::", 1)[-1]
    candidates = handler_index.get(symbol, [])
    if len(candidates) == 1:
        result = {"status": "FOUND", **candidates[0]}
        cache[handler] = result
        return result
    if candidates:
        modules = handler.split("::")[1:-1]
        module_suffixes = []
        if modules:
            module_path = "/".join(modules)
            # Rust permits a nested module to be declared either as
            # ``sessions.rs``/``sessions/mod.rs`` or as a child file such as
            # ``sessions/create.rs``.  The latter is used by the v2 session
            # handlers, so include the symbol child path in the deterministic
            # source match instead of leaving a valid handler ambiguous.
            module_suffixes = [
                f"/{module_path}.rs",
                f"/{module_path}/mod.rs",
                f"/{module_path}/{symbol}.rs",
            ]
        preferred = [
            candidate
            for candidate in candidates
            if any(candidate["source"].endswith(suffix) for suffix in module_suffixes)
        ]
        if len(preferred) == 1:
            result = {"status": "FOUND", **preferred[0]}
            cache[handler] = result
            return result
        result = {
            "status": "AMBIGUOUS_SOURCE",
            "source": None,
            "line": None,
            "symbol": symbol,
            "candidates": candidates,
        }
        cache[handler] = result
        return result
    result = {"status": "UNRESOLVED", "source": None, "line": None, "symbol": symbol}
    cache[handler] = result
    return result


def parse_utoipa_annotations(root: Path) -> list[dict[str, Any]]:
    annotations: list[dict[str, Any]] = []
    handler_root = root / "crates/fullmag-api/src/router_v2/handlers"
    if not handler_root.exists():
        return annotations
    for path in sorted(handler_root.rglob("*.rs")):
        text = safe_read(path)
        for match in re.finditer(r"#\s*\[\s*utoipa::path\s*\(", text):
            end = balanced_block(text, match.end() - 1)
            if end is None:
                continue
            block = text[match.end() : end]
            path_match = re.search(r"\bpath\s*=\s*[\"']([^\"']+)", block)
            method_match = re.search(r"\bmethod\s*=\s*([A-Za-z]+)", block)
            if path_match is None:
                continue
            annotations.append(
                {
                    "path": path_match.group(1),
                    "normalized_path": normalize_path(path_match.group(1)),
                    "method": method_match.group(1).upper() if method_match else None,
                    "source": rel_path(root, path),
                    "line": line_at(text, match.start()),
                }
            )
    return annotations


def parse_api_path_constants(texts: dict[str, str]) -> dict[str, list[dict[str, Any]]]:
    constants: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for relative, text in texts.items():
        if not relative.endswith("/src/kernel/api/apiPaths.ts"):
            continue
        for match in re.finditer(
            r"export\s+const\s+([A-Z][A-Z0-9_]*)\s*=\s*openApiV2Path\s*\(\s*[\"']([^\"']+)",
            text,
            re.S,
        ):
            constants[match.group(2)].append(
                {
                    "name": match.group(1),
                    "source": relative,
                    "line": line_at(text, match.start()),
                }
            )
    return dict(constants)


def quoted_path_occurrences(text: str, path: str) -> list[int]:
    """Find exact path strings without treating /v2/ as every path prefix."""

    escaped = re.escape(path)
    pattern = re.compile(r"[\"'`]" + escaped + r"[\"'`]")
    return [match.start() for match in pattern.finditer(text)]


def classify_source_role(relative: str) -> str:
    normalized = relative.replace("\\", "/")
    if normalized.endswith("openapi-v2.json"):
        return "generated_schema"
    if "/router_v2/" in normalized or normalized.endswith("router_v2/mod.rs"):
        return "backend_router_or_handler"
    if normalized.endswith("/src/kernel/api/apiPaths.ts"):
        return "frontend_api_path_constants"
    if "/src/kernel/api/generated/" in normalized:
        return "generated_frontend_transport"
    if "/src/kernel/resources/" in normalized or normalized.endswith("ControlRoomApi.ts"):
        return "frontend_resource_or_facade"
    if normalized.startswith("apps/control-room/"):
        return "frontend"
    if normalized.startswith("apps/desktop/"):
        return "desktop"
    if normalized.startswith("crates/fullmag-cli/"):
        return "cli"
    if normalized.startswith("packages/fullmag-py/"):
        return "python"
    if normalized.startswith("crates/fullmag-runner/"):
        return "headless_runner"
    if normalized.startswith("scripts/"):
        return "script"
    if normalized.startswith("crates/fullmag-api/"):
        return "backend_api"
    return "source"


def endpoint_consumers(
    operations: list[dict[str, Any]],
    texts: dict[str, str],
    constants: dict[str, list[dict[str, Any]]],
) -> list[dict[str, Any]]:
    path_index: dict[str, list[dict[str, Any]]] = defaultdict(list)
    literal_pattern = re.compile(r"[\"'`]([^\"'`]*\/v2[^\"'`]*)[\"'`]")
    for relative, text in texts.items():
        role = classify_source_role(relative)
        for match in literal_pattern.finditer(text):
            path_index[match.group(1)].append(
                {
                    "source": relative,
                    "line": line_at(text, match.start()),
                    "role": role,
                    "variant": match.group(1),
                }
            )
    result: list[dict[str, Any]] = []
    for operation in operations:
        path = operation["path"]
        variants = [path]
        colon_variant = axum_path(path)
        if colon_variant != path:
            variants.append(colon_variant)
        evidence: list[dict[str, Any]] = [row for variant in variants for row in path_index.get(variant, [])]
        constant_rows = constants.get(path, [])
        for constant in constant_rows:
            evidence.append(
                {
                    "source": constant["source"],
                    "line": constant["line"],
                    "role": "frontend_api_path_constants",
                    "variant": path,
                    "constant": constant["name"],
                }
            )
        deduped: list[dict[str, Any]] = []
        seen: set[tuple[Any, ...]] = set()
        for row in evidence:
            key = (row.get("source"), row.get("line"), row.get("role"), row.get("variant"), row.get("constant"))
            if key not in seen:
                seen.add(key)
                deduped.append(row)
        roles = {row["role"] for row in deduped}
        if not deduped:
            status = "UNRESOLVED"
        elif roles & {"frontend_resource_or_facade", "frontend"}:
            status = "FRONTEND_LITERAL_EVIDENCE"
        elif roles & {"frontend_api_path_constants", "generated_frontend_transport"}:
            status = "PATH_CONSTANT_OR_GENERATED_ONLY"
        elif roles & {"backend_router_or_handler", "backend_api", "generated_schema"}:
            status = "SCHEMA_OR_BACKEND_ONLY"
        else:
            status = "SOURCE_EVIDENCE_ONLY"
        operation_copy = dict(operation)
        operation_copy.update(
            {
                "consumer_status": status,
                "api_path_constants": constant_rows,
                "consumer_evidence_count": len(deduped),
                "consumer_evidence": deduped[:20],
            }
        )
        result.append(operation_copy)
    return result


def parse_input_hashes(root: Path) -> list[dict[str, Any]]:
    manifest_relative = "docs/plans/active/refactor_runtime/final/05-dowody-i-adr.md"
    manifest_path = root / manifest_relative
    text = safe_read(manifest_path)
    rows: list[dict[str, Any]] = []
    pattern = re.compile(r"^\|\s*\[[^\]]+\]\(([^)]+)\)\s*\|\s*`([0-9a-fA-F]{64})`\s*\|\s*$", re.M)
    for match in pattern.finditer(text):
        linked = match.group(1)
        source_path = (manifest_path.parent / linked).resolve()
        observed = sha256_file(source_path)
        rows.append(
            {
                "declared_path": linked,
                "path": rel_path(root, source_path) if source_path.exists() else linked,
                "declared_sha256": match.group(2).lower(),
                "observed_sha256": observed,
                "status": "MATCH" if observed == match.group(2).lower() else ("MISSING" if observed is None else "MISMATCH"),
                "source": f"{manifest_relative}:{line_at(text, match.start())}",
            }
        )
    return rows


def parse_status(root: Path) -> dict[str, Any]:
    status_text = run_git(root, "status", "--porcelain=v1")
    rows: list[dict[str, Any]] = []
    for line in status_text.splitlines():
        if not line:
            continue
        code = line[:2]
        path = line[3:] if len(line) >= 4 else ""
        if " -> " in path:
            path = path.split(" -> ", 1)[-1]
        rows.append(
            {
                "code": code,
                "path": path,
                "generated_by_this_script": path.replace("\\", "/") in GENERATED_OUTPUTS,
            }
        )
    preexisting = [row for row in rows if not row["generated_by_this_script"]]
    return {
        "dirty": bool(rows),
        "status_entries": rows,
        "preexisting_dirty": bool(preexisting),
        "preexisting_entries": preexisting,
    }


def symbol_evidence(root: Path, relative: str, symbols: Iterable[str]) -> list[dict[str, Any]]:
    path = root / relative
    text = safe_read(path)
    evidence: list[dict[str, Any]] = []
    for symbol in symbols:
        if symbol == "default":
            pattern = re.compile(r"\bexport\s+default\b")
        elif symbol == "main":
            pattern = re.compile(r"\b(?:fn|def)\s+main\b|\bmain\s*\(|\bexport\s+default\b")
        elif symbol.lower() == "fullmag":
            pattern = re.compile(r"\bfullmag\b", re.I)
        else:
            pattern = re.compile(r"\b" + re.escape(symbol) + r"\b")
        match = pattern.search(text)
        if match:
            evidence.append({"symbol": symbol, "source": relative, "line": line_at(text, match.start())})
    return evidence


def entrypoint_catalog(root: Path) -> list[dict[str, Any]]:
    definitions = [
        ("web-control-room", "web", "apps/control-room", "apps/control-room/app/page.tsx", ["default"], "Next page entrypoint"),
        ("web-workspace", "web", "apps/control-room", "apps/control-room/app/workspace/page.tsx", ["default"], "workspace page"),
        ("desktop-tauri", "desktop", "apps/desktop", "apps/desktop/src-tauri/src/main.rs", ["main"], "Tauri native entrypoint"),
        ("cli", "CLI", "crates/fullmag-cli", "crates/fullmag-cli/src/main.rs", ["main", "Cli", "Command"], "Rust launcher and clap command surface"),
        ("python-package", "Python", "packages/fullmag-py", "packages/fullmag-py/src/fullmag/__main__.py", ["main"], "Python package entrypoint"),
        ("headless-cli", "headless", "crates/fullmag-cli", "crates/fullmag-cli/src/orchestrator.rs", ["run_script_mode", "headless"], "script/headless orchestration"),
        ("headless-bench", "headless", "crates/fullmag-bench", "crates/fullmag-bench/src/main.rs", ["main"], "benchmark harness entrypoint"),
        ("scratch-spawn-run", "scratch", "crates/fullmag-cli", "crates/fullmag-cli/src/scratch_runtime.rs", ["spawn", "run"], "scratch runtime supervisor"),
        ("scratch-attach", "attach", "crates/fullmag-cli", "crates/fullmag-cli/src/scratch_runtime.rs", ["spawn_attached_runtime", "attached_session"], "attached scratch runtime"),
        ("session-import", "import", "crates/fullmag-session", "crates/fullmag-session/src/fms.rs", ["unpack_fms", "preflight_fms"], "FMS import/restore"),
        ("python-import-bridge", "import", "crates/fullmag-cli", "crates/fullmag-cli/src/python_bridge.rs", ["import", "load"], "Python/geometry import bridge"),
        ("resume-command", "resume", "crates/fullmag-cli", "crates/fullmag-cli/src/step_utils.rs", ["resume", "checkpoint"], "interactive command resume"),
        ("resume-autosave", "resume", "crates/fullmag-runner", "crates/fullmag-runner/src/autosave_storage.rs", ["resume"], "autosave state resume"),
        ("attached-session-orchestrator", "attach", "crates/fullmag-cli", "crates/fullmag-cli/src/orchestrator.rs", ["attached_session_id_or", "attach"], "session-owned runtime attachment"),
        ("script-launcher", "script", "scripts", "scripts/run_fullmag.sh", ["fullmag"], "repository launcher script"),
    ]
    rows: list[dict[str, Any]] = []
    for entry_id, category, owner, relative, symbols, note in definitions:
        path = root / relative
        evidence = symbol_evidence(root, relative, symbols)
        rows.append(
            {
                "id": entry_id,
                "category": category,
                "owner": owner,
                "entrypoint": relative,
                "note": note,
                "exists": path.is_file(),
                "status": "FOUND" if path.is_file() and evidence else ("MISSING" if not path.is_file() else "UNRESOLVED_SYMBOL"),
                "evidence": evidence,
            }
        )
    return rows


MANIFEST_PATTERNS = {
    "manifest-token": re.compile(r"manifest", re.I),
    "run-manifest": re.compile(r"run_manifest\.json", re.I),
    "stage-manifest": re.compile(r"stage_manifest|StageManifest", re.I),
    "resource-key": re.compile(r"resource[_-]?key", re.I),
    "run-id-current": re.compile(r"run_id\s*[:=]\s*[\"']current[\"']", re.I),
    "run-current-placeholder": re.compile(r"[\"']run:current[\"']|run:current", re.I),
    "session-current-placeholder": re.compile(r"/v2/sessions/current"),
}


def manifest_role(relative: str, text: str) -> str:
    normalized = relative.replace("\\", "/")
    producer = bool(
        re.search(r"write|commit|create|emit|persist|serialize|manifest\s*=", text, re.I)
    ) and ("crates/fullmag-runner" in normalized or "crates/fullmag-session" in normalized or "backends/" in normalized)
    consumer = bool(
        re.search(r"read|load|parse|decode|fetch|from_slice|deserialize|resource", text, re.I)
    ) and (
        "apps/control-room" in normalized
        or "crates/fullmag-api" in normalized
        or "scripts/" in normalized
        or "crates/fullmag-session" in normalized
    )
    if producer and consumer:
        return "producer-and-consumer-candidate"
    if producer:
        return "producer-candidate"
    if consumer:
        return "consumer-candidate"
    return "unresolved-role"


def manifest_inventory(root: Path, texts: dict[str, str]) -> dict[str, Any]:
    files: list[dict[str, Any]] = []
    placeholders: list[dict[str, Any]] = []
    session_api_files: list[dict[str, Any]] = []
    for relative, text in texts.items():
        counts = {name: len(pattern.findall(text)) for name, pattern in MANIFEST_PATTERNS.items()}
        if counts["session-current-placeholder"]:
            session_samples: list[dict[str, Any]] = []
            for index, line in enumerate(text.splitlines(), start=1):
                if "/v2/sessions/current" in line:
                    session_samples.append({"line": index, "text": line.strip()[:240]})
                    if len(session_samples) >= 3:
                        break
            session_api_files.append(
                {
                    "source": relative,
                    "count": counts["session-current-placeholder"],
                    "sample_occurrences": session_samples,
                }
            )
        manifest_counts = [
            value for name, value in counts.items() if name != "session-current-placeholder"
        ]
        if not any(manifest_counts):
            continue
        samples: list[dict[str, Any]] = []
        for index, line in enumerate(text.splitlines(), start=1):
            if "manifest" in line.lower() or "run:current" in line or "run_id" in line:
                samples.append({"line": index, "text": line.strip()[:240]})
                if len(samples) >= 5:
                    break
        role = manifest_role(relative, text)
        files.append(
            {
                "source": relative,
                "role": role,
                "counts": counts,
                "sample_occurrences": samples,
                "role_confidence": "source-token-candidate; symbol review required",
            }
        )
        for name, pattern in MANIFEST_PATTERNS.items():
            if name not in {"run-id-current", "run-current-placeholder"}:
                continue
            for match in pattern.finditer(text):
                placeholders.append(
                    {
                        "kind": name,
                        "source": relative,
                        "line": line_at(text, match.start()),
                        "text": text.splitlines()[line_at(text, match.start()) - 1].strip()[:240],
                    }
                )
    producer_files = [row for row in files if "producer" in row["role"]]
    consumer_files = [row for row in files if "consumer" in row["role"]]
    return {
        "file_records": files,
        "producer_candidates": producer_files,
        "consumer_candidates": consumer_files,
        "placeholders": placeholders,
        "session_current_api_files": session_api_files,
        "session_current_api_total": sum(row["count"] for row in session_api_files),
        "coverage_note": "Rola producent/consumer jest kandydatem opartym o tokeny i musi być potwierdzona symbolem podczas P0/P1; run/current placeholdery są literalnymi trafieniami. /v2/sessions/current jest raportowane osobno jako namespace API, bo samo słowo current nie dowodzi placeholdera manifestu.",
    }


LANE_DEFINITIONS = {
    "fdm_cpu": {
        "authority": "Rust reference CPU / FDM production ownership described by backend instructions",
        "anchors": ["crates/fullmag-engine/src", "crates/fullmag-runner/src/solvers/fdm", "backends/fdm"],
    },
    "fdm_gpu": {
        "authority": "native CUDA FDM lane; requested GPU must remain explicit",
        "anchors": ["backends/fdm", "native/include/fullmag_fdm.h", "crates/fullmag-runner/src/solvers/fdm"],
    },
    "fem_cpu": {
        "authority": "MFEM/hypre/libCEED FEM lane under backends/fem",
        "anchors": ["backends/fem", "crates/fullmag-fem-sys/src/lib.rs", "crates/fullmag-runner/src/fem"],
    },
    "fem_gpu": {
        "authority": "MFEM/hypre/libCEED/CUDA FEM lane under backends/fem",
        "anchors": ["backends/fem", "native/include/fullmag_fem.h", "crates/fullmag-runner/src/fem"],
    },
}

FEATURE_ANCHORS = {
    "ProblemIR i planowanie": ["crates/fullmag-ir/src", "crates/fullmag-plan/src"],
    "exchange": ["crates/fullmag-engine/src", "backends/fdm", "backends/fem"],
    "demag": ["backends/fdm", "backends/fem", "crates/fullmag-runner/src/fdm", "crates/fullmag-runner/src/fem"],
    "DMI i interakcje lokalne": ["backends/fdm", "backends/fem", "crates/fullmag-plan/src"],
    "transport/SOT/Oersted": ["native/include/fullmag_fdm.h", "native/include/fullmag_fem.h", "crates/fullmag-runner/src/fem", "crates/fullmag-runner/src/fdm"],
    "mesh/geometry": ["backends/fem", "crates/fullmag-runner/src/fem", "packages/fullmag-py/src/fullmag/meshing"],
    "relax/time-domain": ["crates/fullmag-runner/src/solvers", "crates/fullmag-runner/src/fem", "backends/fdm", "backends/fem"],
    "eigen/frequency": ["crates/fullmag-runner/src/eigen", "crates/fullmag-runner/src/fem", "backends/fem"],
    "artefakty/provenance": ["crates/fullmag-runner/src/artifacts.rs", "crates/fullmag-session/src", "crates/fullmag-api/src"],
    "capability/runtime selection": ["crates/fullmag-runner/src/capabilities.rs", "crates/fullmag-runner/src/solver_runtime", "docs/specs/capability-matrix-v0.md"],
}


def path_exists_or_prefix(root: Path, anchor: str, source_paths: set[str]) -> bool:
    path = root / anchor
    return path.exists() or any(candidate.startswith(anchor.rstrip("/") + "/") for candidate in source_paths)


def lane_matrix(root: Path) -> dict[str, Any]:
    source_paths = {rel_path(root, path) for path in source_files(root)}
    rows: list[dict[str, Any]] = []
    for feature, anchors in FEATURE_ANCHORS.items():
        cells: dict[str, Any] = {}
        for lane, definition in LANE_DEFINITIONS.items():
            lane_anchors = [anchor for anchor in anchors if any(anchor == own or anchor.startswith(own.rstrip("/") + "/") or own.startswith(anchor.rstrip("/") + "/") for own in definition["anchors"])]
            existing = [anchor for anchor in lane_anchors if path_exists_or_prefix(root, anchor, source_paths)]
            cells[lane] = {
                "status": "source_visible" if existing else "UNRESOLVED",
                "qualification": "NOT_VERIFIED",
                "evidence": existing,
            }
        rows.append({"feature": feature, "lanes": cells})
    return {
        "lane_definitions": LANE_DEFINITIONS,
        "feature_rows": rows,
        "qualification_boundary": "source_visible nie oznacza executable, validated ani qualified; inventory nie wykonuje żadnego runtime.",
    }


def abi_inventory(root: Path) -> dict[str, Any]:
    files = [
        "native/include/fullmag_backend.h",
        "native/include/fullmag_fdm.h",
        "native/include/fullmag_fem.h",
        "native/include/fullmag_fdm_execution_receipt_v1_layout.def",
        "native/include/fullmag_fdm_execution_receipt_v1_values.def",
        "native/include/fullmag_fdm_execution_receipt_v2_layout.def",
        "native/include/fullmag_fdm_plan_desc_v2_layout.def",
        "crates/fullmag-fdm-sys/src/lib.rs",
        "crates/fullmag-fem-sys/src/lib.rs",
    ]
    constants: list[dict[str, Any]] = []
    anchors: list[dict[str, Any]] = []
    pattern = re.compile(r"\b(FULLMAG_[A-Z0-9_]*(?:ABI|VERSION|LAYOUT|FINGERPRINT|FIELD_COUNT|MAGIC)[A-Z0-9_]*)\b")
    for relative in files:
        path = root / relative
        text = safe_read(path)
        anchors.append({"source": relative, "exists": path.is_file(), "sha256": sha256_file(path)})
        seen: set[tuple[str, int]] = set()
        for match in pattern.finditer(text):
            line = line_at(text, match.start())
            key = (match.group(1), line)
            if key in seen:
                continue
            seen.add(key)
            line_text = text.splitlines()[line - 1].strip() if text.splitlines() else ""
            constants.append(
                {
                    "name": match.group(1),
                    "source": relative,
                    "line": line,
                    "declaration": line_text[:300],
                }
            )
    return {
        "anchors": anchors,
        "constants": constants,
        "note": "Zebrane deklaracje ABI/layout/version są źródłowym śladem kontraktu; kompatybilność binarna wymaga osobnej bramki ABI/runtime.",
    }


def operation_mapping(root: Path, texts: dict[str, str]) -> dict[str, Any]:
    openapi, operations = extract_openapi(root)
    routes = extract_router_routes(root)
    annotations = parse_utoipa_annotations(root)
    constants = parse_api_path_constants(texts)
    mapped = endpoint_consumers(operations, texts, constants)
    handler_cache: dict[str, dict[str, Any]] = {}
    handler_index = build_handler_index(root)
    route_index: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for route in routes:
        route_index[(route["normalized_path"], route["method"])].append(route)
    for operation in mapped:
        candidates = route_index.get((operation["normalized_path"], operation["method"]), [])
        operation["router_matches"] = []
        for route in candidates:
            handler = resolve_handler(root, route["handler"], handler_cache, handler_index)
            operation["router_matches"].append({**route, "handler_resolution": handler})
        if not candidates:
            operation["handler_status"] = "UNRESOLVED"
            operation["handler"] = None
            operation["handler_source"] = None
        elif len(candidates) == 1:
            match = operation["router_matches"][0]
            operation["handler_status"] = match["handler_resolution"]["status"]
            operation["handler"] = match["handler"]
            resolution = match["handler_resolution"]
            operation["handler_source"] = f"{resolution['source']}:{resolution['line']}" if resolution["source"] else None
        else:
            operation["handler_status"] = "AMBIGUOUS_ROUTER_MATCH"
            operation["handler"] = "; ".join(route["handler"] for route in candidates)
            operation["handler_source"] = "; ".join(
                f"{route['handler_resolution']['source']}:{route['handler_resolution']['line']}"
                for route in operation["router_matches"]
                if route["handler_resolution"]["source"]
            ) or None
    openapi_keys = {(item["normalized_path"], item["method"]) for item in operations}
    router_only = [route for route in routes if (route["normalized_path"], route["method"]) not in openapi_keys]
    router_keys = {(route["normalized_path"], route["method"]) for route in routes}
    openapi_only = [operation for operation in mapped if (operation["normalized_path"], operation["method"]) not in router_keys]
    current_prefix = "/v2/sessions/current"
    annotation_current = [row for row in annotations if row["path"].startswith(current_prefix)]
    return {
        "openapi_source": "apps/control-room/src/kernel/api/generated/openapi-v2.json",
        "openapi": {
            "openapi_version": openapi.get("openapi"),
            "info_version": openapi.get("info", {}).get("version") if isinstance(openapi, dict) else None,
            "path_count": len(openapi.get("paths", {})) if isinstance(openapi, dict) else 0,
            "operation_count": len(operations),
            "current_path_count": sum(1 for path in openapi.get("paths", {}) if path.startswith(current_prefix)) if isinstance(openapi, dict) else 0,
            "platform_path_count": sum(1 for path in openapi.get("paths", {}) if path.startswith("/v2/platform")) if isinstance(openapi, dict) else 0,
            "schema_count": len(openapi.get("components", {}).get("schemas", {})) if isinstance(openapi, dict) else 0,
            "sha256": sha256_file(root / "apps/control-room/src/kernel/api/generated/openapi-v2.json"),
        },
        "router": {
            "source": "crates/fullmag-api/src/router_v2/mod.rs",
            "route_block_count": len({route["route_block_line"] for route in routes}),
            "route_method_count": len(routes),
            "unique_route_path_count": len({route["path"] for route in routes}),
            "current_route_method_count": sum(1 for route in routes if route["path"].startswith(current_prefix)),
        },
        "handler_annotations": {
            "source_root": "crates/fullmag-api/src/router_v2/handlers",
            "annotation_count": len(annotations),
            "current_annotation_count": len(annotation_current),
            "unique_paths": len({row["path"] for row in annotations}),
            "current_unique_paths": len({row["path"] for row in annotation_current}),
        },
        "operations": mapped,
        "router_only": router_only,
        "openapi_only": openapi_only,
        "api_path_constants": constants,
        "mapping_note": "Operacje OpenAPI są mapowane po znormalizowanej ścieżce/metodzie do literalnych rejestracji Axum. Brak dopasowania pozostaje UNRESOLVED; consumer_evidence to literalne trafienia źródłowe i nie jest dowodem wykonania.",
    }


def build_inventory(root: Path) -> dict[str, Any]:
    texts = source_texts(root)
    status = parse_status(root)
    endpoint_data = operation_mapping(root, texts)
    source_hashes = parse_input_hashes(root)
    manifest_data = manifest_inventory(root, texts)
    entries = entrypoint_catalog(root)
    return {
        "inventory_version": "p0-a.v1",
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "scope": "Bounded P0-A source inventory for fullmag backend/frontend refactor",
        "qualification": {
            "status": "NOT_VERIFIED",
            "boundary": "Ten artefakt nie uruchamia build/test/runtime/browser/WebGL/physics/release gates.",
        },
        "git": {
            "root": run_git(root, "rev-parse", "--show-toplevel").strip(),
            "branch": run_git(root, "branch", "--show-current").strip(),
            "head": run_git(root, "rev-parse", "HEAD").strip(),
            "common_dir": run_git(root, "rev-parse", "--git-common-dir").strip(),
            "is_worktree": run_git(root, "rev-parse", "--is-inside-work-tree").strip() == "true",
            **status,
            "submodules": run_git(root, "submodule", "status").splitlines(),
        },
        "source_hashes": {
            "declared_in": "docs/plans/active/refactor_runtime/final/05-dowody-i-adr.md",
            "count": len(source_hashes),
            "rows": source_hashes,
            "all_match": bool(source_hashes) and all(row["status"] == "MATCH" for row in source_hashes),
        },
        "schema_abi": {
            "endpoint_mapping": endpoint_data,
            "abi": abi_inventory(root),
        },
        "entrypoints": entries,
        "manifests": manifest_data,
        "lane_matrix": lane_matrix(root),
        "coverage": {
            "source_file_count": len(texts),
            "openapi_operations": len(endpoint_data["operations"]),
            "endpoint_rows_with_handler": sum(1 for row in endpoint_data["operations"] if row["handler_status"] == "FOUND"),
            "endpoint_rows_unresolved_handler": sum(1 for row in endpoint_data["operations"] if row["handler_status"] == "UNRESOLVED"),
            "endpoint_rows_unresolved_consumer": sum(1 for row in endpoint_data["operations"] if row["consumer_status"] == "UNRESOLVED"),
            "router_only_rows": len(endpoint_data["router_only"]),
            "openapi_only_rows": len(endpoint_data["openapi_only"]),
            "entrypoints": len(entries),
            "manifest_file_records": len(manifest_data["file_records"]),
            "input_hash_rows": len(source_hashes),
        },
        "limitations": [
            "Mapowanie konsumentów opiera się na literalnych ścieżkach, stałych apiPaths i symbolach źródłowych; dynamiczne URL-e i runtime dispatch mogą pozostać UNRESOLVED.",
            "Rola producent/consumer manifestu jest oznaczona jako candidate na podstawie tokenów; tylko placeholdery literalne są zapisane jako bezpośrednie trafienia.",
            "Status source_visible w macierzy czterech pasów nie oznacza kompilacji, wykonania, parytetu naukowego ani kwalifikacji.",
            "Stan dirty obejmuje zmiany współdzielonego checkoutu i nie jest przypisywany temu skryptowi; wpisy wygenerowane przez ten skrypt są oznaczone osobno.",
            "OpenAPI unique path/operation counts, router registrations i utoipa annotation counts są odrębnymi metrykami i nie wolno ich utożsamiać.",
        ],
    }


def md_cell(value: Any) -> str:
    if value is None:
        return "UNRESOLVED"
    text = str(value).replace("|", "\\|").replace("\n", " ")
    return text if text else "—"


def render_markdown(inventory: dict[str, Any]) -> str:
    git = inventory["git"]
    hashes = inventory["source_hashes"]["rows"]
    endpoint_data = inventory["schema_abi"]["endpoint_mapping"]
    openapi = endpoint_data["openapi"]
    router = endpoint_data["router"]
    annotations = endpoint_data["handler_annotations"]
    coverage = inventory["coverage"]
    lines: list[str] = []
    lines.extend(
        [
            "# P0-A — inwentarz źródeł backendu i frontendu",
            "",
            "Ten plik jest wygenerowany przez `scripts/audit_refactor_p0.py`. Obejmuje aktualny checkout i służy jako wejście wykonawcze do etapów P0–P8. Nie jest dowodem działającego runtime.",
            "",
            "## Granica audytu",
            "",
            "Audyt obejmuje bazę źródłową, stan Git, schema/API, rejestr Axum, literalne konsumenty, ABI/layout/version, wejścia uruchomieniowe, manifesty oraz cztery pasy FDM/FEM. Skrypt nie buduje, nie kompiluje, nie uruchamia testów, przeglądarki, WebGL, solvera ani kwalifikacji wydania.",
            "",
            "Powtórzenie: `python scripts/audit_refactor_p0.py --write`.",
            "Maszynowy artefakt: [`inventory.json`](inventory.json).",
            "",
            "## Tożsamość źródeł",
            "",
            f"- checkout: `{md_cell(git['root'])}`",
            f"- branch: `{md_cell(git['branch'])}`",
            f"- HEAD: `{md_cell(git['head'])}`",
            f"- git common dir: `{md_cell(git['common_dir'])}`",
            f"- dirty: **{git['dirty']}**; wpisów przed odjęciem artefaktów tego skryptu: **{len(git['preexisting_entries'])}**",
            f"- submodules: **{len(git['submodules'])}** wpisów z `git submodule status`",
            "",
            "Stan dirty jest informacją o współdzielonym checkoutu; inwentarz nie przypisuje tych zmian żadnemu agentowi.",
            "",
            "## Hashy wejściowych — 18 wierszy z final/05",
            "",
            "| Źródło | SHA zadeklarowane | SHA zaobserwowane | Status |",
            "|---|---|---|---|",
        ]
    )
    for row in hashes:
        lines.append(f"| `{md_cell(row['path'])}` | `{md_cell(row['declared_sha256'])}` | `{md_cell(row['observed_sha256'])}` | **{row['status']}** |")
    lines.extend(
        [
            "",
            f"Liczba wierszy: **{len(hashes)}**; wszystkie zgodne: **{inventory['source_hashes']['all_match']}**. Mismatch/MISSING blokuje traktowanie raportów jako tej samej bazy.",
            "",
            "## Schema, router i ABI",
            "",
            f"- OpenAPI: `{openapi['openapi_version']}`; `info.version`: `{openapi['info_version']}`; **{openapi['path_count']}** unikalnych ścieżek, **{openapi['operation_count']}** operacji, **{openapi['current_path_count']}** ścieżek `/v2/sessions/current*`, **{openapi['platform_path_count']}** `/v2/platform*`; schematów **{openapi['schema_count']}**.",
            f"- wygenerowany OpenAPI SHA-256: `{openapi['sha256']}`.",
            f"- Axum router: **{router['route_block_count']}** bloków route, **{router['route_method_count']}** rejestracji metod, **{router['unique_route_path_count']}** literalnych ścieżek, **{router['current_route_method_count']}** metod current.",
            f"- adnotacje `utoipa::path`: **{annotations['annotation_count']}** wierszy, **{annotations['current_annotation_count']}** current; to metryka adnotacji, nie liczba unikalnych ścieżek OpenAPI.",
            "- ABI/layout/version z nagłówków C i bindingów Rust jest zebrane jako źródłowy ślad. Sam odczyt nie potwierdza zgodności binarnej.",
            "",
            "### ABI anchors",
            "",
            "| Źródło | Istnieje | SHA-256 |",
            "|---|---:|---|",
        ]
    )
    for row in inventory["schema_abi"]["abi"]["anchors"]:
        lines.append(f"| `{row['source']}` | {row['exists']} | `{md_cell(row['sha256'])}` |")
    lines.extend(
        [
            "",
            "## Kompletne mapowanie OpenAPI → router/handler → consumer evidence",
            "",
            "Każdy wiersz pochodzi z `paths` wygenerowanego OpenAPI. `UNRESOLVED` oznacza brak literalnego dowodu; nie jest zastępowane zgadywaniem. `consumer_evidence` jest ograniczone do 20 przykładów na operację, a pełna struktura i liczniki są w JSON.",
            "",
            "| Metoda | Ścieżka | operationId | Handler | Źródło handlera | Handler status | Consumer status | Evidence |",
            "|---|---|---|---|---|---|---|---:|",
        ]
    )
    for operation in endpoint_data["operations"]:
        lines.append(
            "| "
            + " | ".join(
                [
                    md_cell(operation["method"]),
                    f"`{md_cell(operation['path'])}`",
                    f"`{md_cell(operation.get('operation_id'))}`",
                    f"`{md_cell(operation.get('handler'))}`",
                    f"`{md_cell(operation.get('handler_source'))}`",
                    md_cell(operation["handler_status"]),
                    md_cell(operation["consumer_status"]),
                    str(operation["consumer_evidence_count"]),
                ]
            )
            + " |"
        )
    lines.extend(
        [
            "",
            f"Pokrycie: handler FOUND **{coverage['endpoint_rows_with_handler']}**, handler UNRESOLVED **{coverage['endpoint_rows_unresolved_handler']}**, consumer UNRESOLVED **{coverage['endpoint_rows_unresolved_consumer']}**, router-only **{coverage['router_only_rows']}**, OpenAPI-only **{coverage['openapi_only_rows']}**.",
            "",
            "### Rejestracje router-only",
            "",
            "| Metoda | Ścieżka | Handler | Źródło |",
            "|---|---|---|---|",
        ]
    )
    for route in endpoint_data["router_only"]:
        lines.append(f"| {route['method']} | `{route['path']}` | `{route['handler']}` | `{route['source']}` |")
    lines.extend(["", "### OpenAPI-only", "", "| Metoda | Ścieżka | operationId |", "|---|---|---|"])
    for operation in endpoint_data["openapi_only"]:
        lines.append(f"| {operation['method']} | `{operation['path']}` | `{md_cell(operation.get('operation_id'))}` |")
    lines.extend(["", "## Wejścia uruchomieniowe i właściciele", "", "| ID | Klasa | Owner | Entrypoint | Status | Evidence |", "|---|---|---|---|---|---|"])
    for row in inventory["entrypoints"]:
        evidence = ", ".join(f"`{item['source']}:{item['line']}` {item['symbol']}" for item in row["evidence"][:4]) or "UNRESOLVED"
        lines.append(f"| `{row['id']}` | {row['category']} | `{row['owner']}` | `{row['entrypoint']}` | **{row['status']}** | {evidence} |")
    lines.extend(
        [
            "",
            "Kategorie scratch/attach/import/resume są rozdzielone, nawet jeśli dziś współdzielą CLI lub session crate. Samo istnienie symbolu nie dowodzi kompletnego roundtripu ani własności durable.",
            "",
            "## Manifesty i placeholdery",
            "",
            inventory["manifests"]["coverage_note"],
            "",
            "### Candidate producers/consumers",
            "",
            "| Źródło | Rola | Manifest | run_manifest | stage | resource key | run/current placeholdery | current API namespace | Przykładowy anchor |",
            "|---|---|---:|---:|---:|---:|---:|---:|---|",
        ]
    )
    for row in inventory["manifests"]["file_records"]:
        counts = row["counts"]
        current = counts["run-id-current"] + counts["run-current-placeholder"]
        sample = row["sample_occurrences"][0] if row["sample_occurrences"] else {}
        anchor = f"`{row['source']}:{sample.get('line', '—')}` {sample.get('text', '')[:100]}"
        lines.append(f"| `{row['source']}` | {row['role']} | {counts['manifest-token']} | {counts['run-manifest']} | {counts['stage-manifest']} | {counts['resource-key']} | {current} | {counts['session-current-placeholder']} | {md_cell(anchor)} |")
    lines.extend(["", f"Literalny namespace `/v2/sessions/current`: **{inventory['manifests']['session_current_api_total']}** trafień w **{len(inventory['manifests']['session_current_api_files'])}** plikach; szczegóły próbek są w `inventory.json`.", "", "### Literal placeholders", "", "| Kind | Źródło | Linia | Tekst |", "|---|---|---:|---|"])
    for row in inventory["manifests"]["placeholders"]:
        lines.append(f"| `{row['kind']}` | `{row['source']}` | {row['line']} | {md_cell(row['text'])} |")
    lines.extend(["", "## Macierz funkcji czterech pasów", "", "Status `source_visible` oznacza wyłącznie obecność anchorów źródłowych. Każda komórka ma kwalifikację `NOT_VERIFIED` do czasu osobnych bramek runtime, nauki i release.", ""])
    for row in inventory["lane_matrix"]["feature_rows"]:
        lines.extend([f"### {row['feature']}", "", "| FDM CPU | FDM GPU | FEM CPU | FEM GPU |", "|---|---|---|---|"])
        cells = []
        for lane in ("fdm_cpu", "fdm_gpu", "fem_cpu", "fem_gpu"):
            cell = row["lanes"][lane]
            evidence = ", ".join(cell["evidence"]) or "UNRESOLVED"
            cells.append(f"**{cell['status']}** / NOT_VERIFIED<br>{md_cell(evidence)}")
        lines.append("| " + " | ".join(cells) + " |")
        lines.append("")
    lines.extend(
        [
            "## Ograniczenia i bramki następcze",
            "",
            "- `UNRESOLVED` pozostaje jawne dla nieznanego handlera, dynamicznego konsumenta, producenta/consumera i właściciela.",
            "- Unique OpenAPI path/operation counts, Axum registrations i utoipa annotations są różnymi metrykami. Nie należy ich sumować ani używać zamiennie.",
            "- P0-A dostarcza inwentarz do P0 safety, potem P1 shell/persistence, P2 authoring, P3 runs, P3a explicit identity, P4 prep, P5 isolation, P6 results, P7 studies i P8 cutover. Nie zamyka żadnej bramki wykonawczej.",
            "- Dalsze etapy muszą ponownie przypiąć HEAD, status, schema hash, wygenerowany transport, ABI, browser/WebGL, managed runtime i fizykę; ten artefakt nie zastępuje tych dowodów.",
            "",
            f"Wygenerowano UTC: `{inventory['generated_at_utc']}`.",
        ]
    )
    return "\n".join(lines) + "\n"


def write_outputs(root: Path, inventory: dict[str, Any]) -> tuple[Path, Path]:
    output_dir = root / "docs/plans/active/refactor_runtime/final/p0"
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / "inventory.json"
    markdown_path = output_dir / "01-inventory.md"
    json_path.write_text(json.dumps(inventory, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(render_markdown(inventory), encoding="utf-8")
    return json_path, markdown_path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--write", action="store_true", help="write the two P0-A output files")
    parser.add_argument("--check", action="store_true", help="print compact coverage without writing")
    args = parser.parse_args(argv)
    root = args.repo_root.resolve()
    inventory = build_inventory(root)
    if args.write:
        json_path, markdown_path = write_outputs(root, inventory)
        print(f"wrote {rel_path(root, json_path)}")
        print(f"wrote {rel_path(root, markdown_path)}")
    if args.check or not args.write:
        print(
            json.dumps(
                {
                    "head": inventory["git"]["head"],
                    "dirty": inventory["git"]["dirty"],
                    "openapi_operations": inventory["coverage"]["openapi_operations"],
                    "handlers_found": inventory["coverage"]["endpoint_rows_with_handler"],
                    "handlers_unresolved": inventory["coverage"]["endpoint_rows_unresolved_handler"],
                    "consumers_unresolved": inventory["coverage"]["endpoint_rows_unresolved_consumer"],
                    "router_only": inventory["coverage"]["router_only_rows"],
                    "openapi_only": inventory["coverage"]["openapi_only_rows"],
                    "input_hash_rows": inventory["coverage"]["input_hash_rows"],
                },
                ensure_ascii=False,
            )
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
