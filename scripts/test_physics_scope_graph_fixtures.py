"""Contract tests for the backend-neutral physics scope graph fixtures.

The manifest and fixture payloads are intentionally validated before any
normalizer is implemented.  This keeps the publication contract executable
and prevents a later implementation from silently changing the scenarios.
"""

from __future__ import annotations

import json
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
FIXTURE_ROOT = REPO_ROOT / "crates/fullmag-authoring/tests/fixtures/physics_graph"
MANIFEST = FIXTURE_ROOT / "manifest.json"


def _load_manifest() -> list[dict]:
    with MANIFEST.open(encoding="utf-8") as handle:
        payload = json.load(handle)
    assert isinstance(payload, list)
    return payload


def test_physics_scope_graph_fixture_manifest_is_complete() -> None:
    fixtures = _load_manifest()
    required = {
        "empty",
        "no_current",
        "object_local_current_chain",
        "global_field_drive",
        "cross_object_interface",
        "unresolved_legacy",
    }
    assert {item["id"] for item in fixtures} == required

    for entry in fixtures:
        fixture_path = FIXTURE_ROOT / entry["file"]
        assert fixture_path.is_file(), entry["id"]
        with fixture_path.open(encoding="utf-8") as handle:
            fixture = json.load(handle)
        assert fixture["id"] == entry["id"]
        assert set(fixture) >= {
            "id",
            "scene",
            "expected_modules",
            "expected_edges",
            "expected_explorer_groups",
        }


def test_no_current_fixture_cannot_promote_dependent_physics() -> None:
    fixtures = _load_manifest()
    no_current_entry = next(item for item in fixtures if item["id"] == "no_current")
    with (FIXTURE_ROOT / no_current_entry["file"]).open(encoding="utf-8") as handle:
        no_current = json.load(handle)

    assert no_current["expected_modules"] == []
    assert all(edge["status"] != "active" for edge in no_current["expected_edges"])
