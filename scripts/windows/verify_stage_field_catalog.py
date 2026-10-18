"""Real HTTP regression for explicit retained-stage catalog selection; no solver."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import urllib.error
import urllib.parse


def exercise(get, checks, receipt, run_root):
    source_path = Path(__file__).resolve()
    observer = source_path.read_bytes()
    observer_sha256 = hashlib.sha256(observer).hexdigest()
    snapshot = Path(run_root) / "stage-field-catalog-observer.py"
    snapshot.write_bytes(observer)
    receipt["stage_field_catalog_observer"] = {
        "source_path": str(source_path), "snapshot_path": str(snapshot),
        "source_sha256": observer_sha256,
    }
    code, _, session = get("/v2/sessions", method="POST", payload={
        "name": "Retained-stage catalog regression", "backend": "fdm",
        "device": "cpu", "precision": "double",
    })
    assert code == 201 and session["session_id"], session
    _, _, initial_scene = get("/v2/sessions/current/model/scene")
    paths = ["/v2/sessions/current/data/fields", "/v2/sessions/current/data/quantities"]
    initial_catalogs = {}
    for path in paths:
        code, _, catalog = get(path)
        assert code == 200 and isinstance(catalog["quantities"], list), (path, catalog)
        initial_catalogs[path] = catalog
    # The ordinary quantity registry must exist, so an ignored selector cannot
    # accidentally pass as an empty-catalog success.
    assert initial_catalogs[paths[1]]["quantities"]
    checks.append("stage-field-catalog-ordinary-live-catalogs-readable")

    observations = []
    for label, selector, expected_status in (
        ("missing", "verifier-unregistered-runtime-stage", 404),
        ("empty", "", 400),
        ("whitespace", " ", 400),
        ("nul", "invalid\0stage", 400),
        ("oversized", "x" * 4097, 400),
    ):
        for path in paths:
            query = urllib.parse.urlencode({"stage_id": selector})
            try:
                code, _, body = get(path + "?" + query)
            except urllib.error.HTTPError as error:
                body = error.read(16384).decode("utf-8", errors="replace")
                assert error.code == expected_status, (path, label, error.code, body)
                observations.append({"resource": path, "case": label,
                                     "status": error.code, "error_body": body})
            else:
                raise AssertionError(("Explicit stage selector was silently accepted", path, label, code, body))
        checks.append("stage-field-catalog-" + label + "-selector-fails-closed")

    for path in paths:
        code, _, catalog = get(path)
        assert code == 200 and catalog == initial_catalogs[path], (path, catalog)
    _, _, final_scene = get("/v2/sessions/current/model/scene")
    assert final_scene == initial_scene
    checks.append("stage-field-catalog-reads-preserve-scene-and-live-catalogs")

    def digest(value):
        return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

    receipt["stage_field_catalog_observation"] = {
        "session_id": session["session_id"], "revision": initial_scene["revision"],
        "scene_before_sha256": digest(initial_scene), "scene_after_sha256": digest(final_scene),
        "ordinary_catalogs_sha256": {path: digest(value) for path, value in initial_catalogs.items()},
        "selector_observations": observations,
        "scope": "actual HTTP in a verifier-owned fresh session; no solver or retained positive payload",
    }
    assert hashlib.sha256(source_path.read_bytes()).hexdigest() == observer_sha256
    checks.append("stage-field-catalog-observer-source-unchanged")
