#!/usr/bin/env python3
"""Capture the release-grade source identity used by Frozen Spins receipts."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import capture_source_snapshot_identity as canonical_source


SCHEMA = "fullmag.frozen_spins.source-identity.v1"
SUBMODULE_LINE = re.compile(r"^(.)([0-9a-f]{40}) (.*?)(?: \(.*\))?$")


class FrozenSpinsSourceIdentityError(RuntimeError):
    pass


def _git(repo: Path, *arguments: str) -> bytes:
    try:
        return subprocess.check_output(
            (
                "git",
                "-c",
                "core.filemode=false",
                "-c",
                "core.autocrlf=true",
                *arguments,
            ),
            cwd=repo,
            stderr=subprocess.PIPE,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        raise FrozenSpinsSourceIdentityError(
            f"git {' '.join(arguments)} failed in {repo}"
        ) from error


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _canonical(document: object) -> bytes:
    return json.dumps(
        document, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def _submodule_identities(repo: Path) -> dict[str, Any]:
    output = _git(repo, "submodule", "status", "--recursive").decode("utf-8")
    identities: dict[str, Any] = {}
    for line in output.splitlines():
        match = SUBMODULE_LINE.match(line)
        if match is None:
            raise FrozenSpinsSourceIdentityError(
                f"cannot parse recursive submodule status line: {line!r}"
            )
        status, recorded_status_sha, relative = match.groups()
        path = repo / relative
        identity: dict[str, Any] = {
            "status_prefix": status,
            "status_sha": recorded_status_sha,
            "initialized": status != "-",
        }
        tree_entry = _git(repo, "ls-files", "--stage", "--", relative).decode("ascii").strip()
        if tree_entry:
            identity["index_gitlink_sha"] = tree_entry.split()[1]
        if status != "-":
            try:
                nested = canonical_source.capture(path)
            except (OSError, canonical_source.SourceIdentityError) as error:
                raise FrozenSpinsSourceIdentityError(
                    f"cannot capture submodule identity for {relative}: {error}"
                ) from error
            identity.update(
                {
                    "head_commit_full": nested["head_commit_full"],
                    "head_tree_sha256": nested["head_tree_sha256"],
                    "source_snapshot_dirty": nested["source_snapshot_dirty"],
                    "dirty_content_sha256": nested["dirty_content_sha256"],
                    "source_snapshot_sha256": nested["source_snapshot_sha256"],
                }
            )
        identities[relative.replace("\\", "/")] = identity
    return identities


def capture(repo: Path) -> dict[str, Any]:
    repo = repo.resolve()
    try:
        base = canonical_source.capture(repo)
    except (OSError, canonical_source.SourceIdentityError) as error:
        raise FrozenSpinsSourceIdentityError(str(error)) from error
    submodules = _submodule_identities(repo)
    tracked_diff = _git(repo, "diff", "--binary", "--no-ext-diff", "--")
    staged_diff = _git(repo, "diff", "--cached", "--binary", "--no-ext-diff", "--")
    untracked_paths = {
        path
        for record in base["git_status_porcelain_v1"]
        if record["status"] == "??"
        for path in record["paths"]
    }
    untracked_entries = [
        entry for entry in base["dirty_path_content"] if entry["path"] in untracked_paths
    ]
    untracked_manifest_sha256 = _sha256(_canonical(untracked_entries))
    # An uninitialized gitlink (status prefix ``-``) is still a clean,
    # reproducible source reference: the superproject pins the exact commit
    # and the identity records that the nested worktree is intentionally not
    # materialized.  Only a moved gitlink, merge-conflicted gitlink, or dirty
    # initialized submodule invalidates a clean-tree qualification snapshot.
    submodule_dirty = any(
        identity["status_prefix"] not in {" ", "-"}
        or identity.get("source_snapshot_dirty", False)
        for identity in submodules.values()
    )
    source = {
        "git_sha": _git(repo, "rev-parse", "HEAD").decode("ascii").strip(),
        "tree_sha": _git(repo, "rev-parse", "HEAD^{tree}").decode("ascii").strip(),
        "tracked_diff_sha256": _sha256(tracked_diff),
        "staged_diff_sha256": _sha256(staged_diff),
        "untracked_manifest_sha256": untracked_manifest_sha256,
        "git_dirty": bool(base["source_snapshot_dirty"] or submodule_dirty),
        "submodule_identities": submodules,
    }
    identity_payload = {
        "schema": SCHEMA,
        "canonical_source_snapshot_sha256": base["source_snapshot_sha256"],
        "source": source,
    }
    return {
        **identity_payload,
        "source_snapshot_id": "sha256:" + _sha256(_canonical(identity_payload)),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    parser.add_argument("--output", type=Path)
    parser.add_argument("--require-clean", action="store_true")
    args = parser.parse_args()
    try:
        identity = capture(args.repo_root)
    except FrozenSpinsSourceIdentityError as error:
        print(f"SOURCE_IDENTITY_ERROR={error}", file=sys.stderr)
        return 2
    encoded = json.dumps(identity, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    else:
        print(encoded, end="")
    if args.require_clean and identity["source"]["git_dirty"]:
        print("SOURCE_IDENTITY_ERROR=qualification source tree is dirty", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
