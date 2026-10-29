#!/usr/bin/env python3
"""Check Universe authoring archive compatibility over HTTP without running a solver."""
from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import io
import json
import urllib.request
import zipfile
from pathlib import Path


def validate(base_url: str, archive_path: Path) -> dict:
    original = archive_path.read_bytes()
    source_sha = hashlib.sha256(original).hexdigest()
    with zipfile.ZipFile(io.BytesIO(original)) as archive:
        entries = {name: archive.read(name) for name in archive.namelist()}
    manifest = json.loads(entries["manifest/project.json"])
    scene_path, definition_path = manifest["scene"], manifest["definition"]
    scene = json.loads(entries[scene_path])
    definition = json.loads(entries[definition_path])
    if scene.get("version") != "scene.v2" or definition.get("scene") != scene:
        raise ValueError("Expected an authoring scene.v2 archive with matching definition")

    def request(path, payload=None):
        body = None if payload is None else json.dumps(payload).encode()
        req = urllib.request.Request(base_url.rstrip("/") + path, data=body,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)

    def snapshot():
        return {name: request(path) for name, path in (
            ("sessions", "/v2/sessions"),
            ("scene", "/v2/sessions/current/model/scene"),
            ("commands", "/v2/sessions/current/simulation/commands"))}

    def encode(variant):
        modified = dict(entries)
        draft = copy.deepcopy(definition)
        draft["scene"] = variant
        modified[definition_path] = json.dumps(draft).encode()
        modified[scene_path] = json.dumps(variant).encode()
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, raw in modified.items():
                archive.writestr(name, raw)
        return buffer.getvalue()

    results = []

    def check(name, variant, expected):
        raw = encode(variant)
        opened = request("/v2/persistence/projects/open", {
            "display_name": name + ".fms",
            "archive_base64": base64.b64encode(raw).decode(),
        })
        projection = opened.get("authoring_scene_document")
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(opened["archive_base64"]))) as archive:
            retained = json.loads(archive.read(scene_path))
        if ((projection is not None) != expected or retained != variant
                or (expected and projection != variant)):
            raise ValueError(f"{name}: wrong activation or lost archived scene values")
        results.append({"name": name, "activatable": expected,
                        "archive_sha256": hashlib.sha256(raw).hexdigest()})

    before = snapshot()
    for owner in ("universe", "universe_mesh"):
        def changed():
            variant = copy.deepcopy(scene)
            target = variant[owner] if owner == "universe" else variant["study"][owner]
            # This corpus needs the real Python producer's redundant aliases.
            for legacy, current in (("airbox_hmax", "maximum_element_size"),
                                    ("airbox_hmin", "minimum_element_size")):
                if not (isinstance(target.get(legacy), (int, float))
                        and target[legacy] > 0 and target[legacy] == target.get(current)):
                    raise ValueError(f"{owner}: missing equal positive Universe aliases")
            return variant, target

        for spelling in ("legacy", "current", "both"):
            variant, target = changed()
            for legacy, current in (("airbox_hmax", "maximum_element_size"),
                                    ("airbox_hmin", "minimum_element_size")):
                if spelling == "legacy":
                    target.pop(current)
                elif spelling == "current":
                    target.pop(legacy)
            check(f"{owner}-{spelling}", variant, True)
        for field in ("airbox_hmax", "airbox_hmin"):
            variant, target = changed()
            target[field] *= 1.25
            check(f"{owner}-conflict-{field}", variant, False)
        for name, value in (("null", None), ("object", {}), ("array", []),
                            ("string", ""), ("populated", {"enabled": True})):
            variant, target = changed()
            target["future_antenna_parameter"] = value
            check(f"{owner}-unknown-{name}", variant, False)
        for field in ("maximum_element_size", "airbox_hmax"):
            variant, target = changed()
            target[field] = None
            check(f"{owner}-mixed-null-{field}", variant, False)
    if before != snapshot():
        raise ValueError("Active session, scene or command collection changed during verification")
    if archive_path.read_bytes() != original:
        raise ValueError("Source archive changed during verification")
    return {"schema": "fullmag.antenna_universe_authoring_http.v1",
            "source_fms_sha256": source_sha, "passed": len(results), "total": 24,
            "results": results, "live_session_unchanged": True,
            "new_solve_requests": 0, "new_mesh_build_requests": 0,
            "numeric_field_qualification": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    args = parser.parse_args()
    if args.report.resolve() == args.archive.resolve():
        raise ValueError("Report must not overwrite the source archive")
    report = validate(args.base_url, args.archive)
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(f"Universe authoring HTTP: {report['passed']}/{report['total']} PASS; no solver commands")


if __name__ == "__main__":
    main()
