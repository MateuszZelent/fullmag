"""Canonical Compose identity derived from the registered Fullmag checkout."""
from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
import hashlib
import os
import re

import fullmag_storage as storage

_COMPOSE_PROJECT_RE = re.compile(r"[a-z0-9][a-z0-9_-]*")
_LABEL_VALUE_RE = re.compile(r"[a-z0-9][a-z0-9._-]*")
_MAX_DOCKER_NETWORK_NAME = 63
_NETWORK_ALIAS_PREFIX = "fullmag-net-"


def _valid(value: object, label: str, pattern: re.Pattern[str] = _COMPOSE_PROJECT_RE) -> str:
    if not isinstance(value, str) or not value or pattern.fullmatch(value) is None:
        raise ValueError(f"Invalid {label}: {value!r}")
    return value


def compose_network_name(project_name: str) -> str:
    """Return the deterministic Docker network name for a Compose project.

    Compose projects retain their complete checkout-derived name for operator
    visibility. Docker/libnetwork limits network names to 63 characters, so a
    long project gets a short, deterministic network alias derived from that
    same project identity.
    """

    project = _valid(project_name, "Compose project name")
    candidate = f"{project}_fullmag"
    if len(candidate) <= _MAX_DOCKER_NETWORK_NAME:
        return candidate
    return _NETWORK_ALIAS_PREFIX + hashlib.sha256(project.encode("utf-8")).hexdigest()[:16]


def compose_project_identity(layout: Mapping[str, object]) -> dict[str, str]:
    """Return the only Compose identity allowed for one registered checkout.

    ``worktree_id`` and ``FULLMAG_PROJECT_ID`` are produced by
    ``fullmag_storage.resolve_layout``.  The first Git worktree record is the
    canonical main checkout; no branch name or process cwd becomes an identity.
    The historical project name ``fullmag-master`` names that checkout group;
    ``checkout_kind`` deliberately says ``main-checkout`` and does not assert
    that the current Git branch is named ``master``.
    """

    repo_value = layout.get("repo_root")
    worktree_id = _valid(layout.get("worktree_id"), "registered worktree id", _LABEL_VALUE_RE)
    environment = layout.get("env")
    if not isinstance(repo_value, str) or not repo_value:
        raise ValueError("Resolved storage layout has no repository root")
    if not isinstance(environment, Mapping):
        raise ValueError("Resolved storage layout has no resolver environment")
    project_id = _valid(environment.get("FULLMAG_PROJECT_ID"), "resolver project id", _LABEL_VALUE_RE)
    repo = Path(repo_value).resolve()
    records = storage.worktree_records(repo)
    if not records or not isinstance(records[0].get("worktree"), str):
        raise ValueError("Git returned no registered main checkout")
    main = Path(records[0]["worktree"]).resolve()
    same_checkout = os.path.normcase(str(repo)) == os.path.normcase(str(main))
    if same_checkout:
        checkout_kind = "main-checkout"
        project_name = "fullmag-master"
    else:
        checkout_kind = "worktree"
        project_segment = re.sub(r"[^a-z0-9_-]+", "-", worktree_id).strip("-")
        if not project_segment:
            raise ValueError("Registered worktree id has no Compose-safe project segment")
        project_name = f"fullmag-worktree-{project_segment}"
    project_name = _valid(project_name, "Compose project name")
    return {
        "project_name": project_name,
        "network_name": compose_network_name(project_name),
        "project_id": project_id,
        "worktree_id": worktree_id,
        "checkout_kind": checkout_kind,
        "source_root": str(repo),
        "registered_name": worktree_id,
    }


def source_labels(identity: Mapping[str, object]) -> dict[str, str]:
    """Return stable, non-path source labels for Compose services/networks."""

    project = _valid(identity.get("project_name"), "Compose project name")
    labels = {
        "org.fullmag.source.project-id": _valid(identity.get("project_id"), "source project id", _LABEL_VALUE_RE),
        "org.fullmag.source.worktree-id": _valid(identity.get("worktree_id"), "source worktree id", _LABEL_VALUE_RE),
        "org.fullmag.source.checkout-kind": _valid(identity.get("checkout_kind"), "source checkout kind", _LABEL_VALUE_RE),
        "org.fullmag.compose.project": project,
    }
    return labels


def validate_source_labels(document: Mapping[str, object], identity: Mapping[str, object]) -> None:
    """Fail closed when a running service lost its source identity labels."""

    config = document.get("Config")
    labels = config.get("Labels") if isinstance(config, Mapping) else None
    expected = source_labels(identity)
    if not isinstance(labels, Mapping) or any(labels.get(key) != value for key, value in expected.items()):
        raise ValueError("Running Fullmag service source labels do not match the selected checkout")
