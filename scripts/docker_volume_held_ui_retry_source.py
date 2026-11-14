"""Read-only source pins for one managed held-UI start retry."""
from __future__ import annotations

import re
from collections.abc import Mapping
from pathlib import Path

from docker_backend_inputs import _compact_live_source_manifest
from local_runner.build_source import bind_identity, native_identity


COMMIT_RE = re.compile(r"[0-9a-f]{40}\Z")
SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
PIN_FIELDS = {"commit", "source_digest", "source_snapshot_sha256"}
SOURCE_COMMIT_ENV = "FULLMAG_HELD_UI_RETRY_SOURCE_COMMIT"
SOURCE_DIGEST_ENV = "FULLMAG_HELD_UI_RETRY_SOURCE_SHA256"
SOURCE_SNAPSHOT_ENV = "FULLMAG_HELD_UI_RETRY_SOURCE_SNAPSHOT_SHA256"


class HeldUiRetrySourceError(ValueError):
    """Selected source changed or does not have a complete retry identity."""


def _pin(value: object) -> dict[str, str]:
    if not isinstance(value, Mapping) or set(value) != PIN_FIELDS:
        raise HeldUiRetrySourceError("held UI retry source pin has missing or unexpected fields")
    commit = value.get("commit")
    source_digest = value.get("source_digest")
    snapshot = value.get("source_snapshot_sha256")
    if not isinstance(commit, str) or COMMIT_RE.fullmatch(commit) is None:
        raise HeldUiRetrySourceError("held UI retry source commit is malformed")
    if not isinstance(source_digest, str) or SHA256_RE.fullmatch(source_digest) is None:
        raise HeldUiRetrySourceError("held UI retry capsule digest is malformed")
    if not isinstance(snapshot, str) or SHA256_RE.fullmatch(snapshot) is None:
        raise HeldUiRetrySourceError("held UI retry native source snapshot is malformed")
    return {"commit": commit, "source_digest": source_digest,
            "source_snapshot_sha256": snapshot}


def capture(selected: str | Path) -> dict[str, str]:
    """Capture compact source and native identities without creating staging files."""
    try:
        root = Path(selected).resolve(strict=True)
        if not root.is_dir():
            raise HeldUiRetrySourceError("selected retry source is not a directory")
        before = native_identity(root, "snapshot")
        manifest, _git_object_ids, _common = _compact_live_source_manifest(
            root, include_untracked=(),
        )
        after = native_identity(root, "snapshot")
        if before != after:
            raise HeldUiRetrySourceError("selected source changed during retry source capture")
        bound = bind_identity(after, manifest)
    except HeldUiRetrySourceError:
        raise
    except Exception as error:
        raise HeldUiRetrySourceError("cannot capture selected retry source identity") from error

    value = {
        "commit": manifest.get("resolved_commit"),
        "source_digest": manifest.get("source_digest"),
        "source_snapshot_sha256": bound.get("source_snapshot_sha256"),
    }
    return _pin(value)


def validate(selected: str | Path, expected: object) -> dict[str, str]:
    """Recapture and require exact commit, source-capsule, and native snapshot pins."""
    pin = _pin(expected)
    current = capture(selected)
    if current != pin:
        raise HeldUiRetrySourceError("selected source identity changed after retry preview")
    return current


def environment(value: object) -> dict[str, str]:
    """Build the three private, role-specific PID 1 source pin variables."""
    pin = _pin(value)
    return {
        SOURCE_COMMIT_ENV: pin["commit"],
        SOURCE_DIGEST_ENV: pin["source_digest"],
        SOURCE_SNAPSHOT_ENV: pin["source_snapshot_sha256"],
    }
