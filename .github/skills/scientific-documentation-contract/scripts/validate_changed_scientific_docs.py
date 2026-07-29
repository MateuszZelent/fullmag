#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path, PurePosixPath

from validate_scientific_docs import validate_page


SCIENTIFIC_ROOTS = ("docs/physics", "public_docs/site/physics")
EXEMPT_NAMES = {"README.md", "index.md"}


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
        if _is_scientific_page(path):
            manifest = _manifest_for(path)
            if _exists(repo, head, path):
                if not _exists(repo, head, manifest):
                    errors.append(f"changed scientific page requires sidecar manifest: {manifest}")
                else:
                    manifests.add(manifest)
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
            for error in validate_page(repo, manifest)
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
