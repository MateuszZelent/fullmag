#!/usr/bin/env python3
"""Read a real accepted closed-loop inspection through public HTTP; never execute a solve."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def workspace_snapshot(request):
    health = json.loads(request("/v2/platform/health")[0])
    active = health.get("active_session")
    if health.get("status") != "ok" or type(active) is not bool:
        raise ValueError("Workspace presence is not authoritatively reported")
    snapshot = {"active_session": active,
                "sessions": json.loads(request("/v2/sessions")[0])}
    for name, path in (("scene", "/v2/sessions/current/model/scene"),
                       ("commands", "/v2/sessions/current/simulation/commands")):
        value = json.loads(request(path, 200 if active else 404)[0])
        if not active and value.get("code") != "not_found":
            raise ValueError("Empty workspace did not return explicit absence")
        snapshot[name] = value
    return snapshot


def validate(base_url: str, project_id: str, run_id: str) -> dict:
    results = []

    def request(path, expected=200, headers=None):
        req = urllib.request.Request(base_url.rstrip("/") + path, headers=headers or {})
        for attempt in range(4):
            try:
                response = urllib.request.urlopen(req, timeout=120)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                raw = response.read(128 * 1024 * 1024 + 1)
                if len(raw) > 128 * 1024 * 1024:
                    raise ValueError("HTTP response exceeded regression read budget")
                if response.code == 409 and json.loads(raw).get("code") == "antenna_store_busy":
                    if attempt == 3:
                        raise ValueError("Store remained busy after four bounded read attempts")
                    results.append({"path": path, "status": 409, "reason": "antenna_store_busy"})
                    time.sleep(0.05 * (attempt + 1))
                    continue
                if response.code != expected:
                    raise ValueError(f"{path}: expected {expected}, got {response.code}: {raw[:1500]!r}")
                if expected == 409 and json.loads(raw).get("code") != "antenna_source_conflict":
                    raise ValueError("Stale publication did not produce an exact source conflict")
                results.append({"path": path, "status": response.code, "bytes": len(raw)})
                return raw, response.headers

    def snapshot():
        return workspace_snapshot(request)

    before = snapshot()
    base = f"/v2/persistence/projects/{urllib.parse.quote(project_id, safe='')}/runs/{urllib.parse.quote(run_id, safe='')}/antenna-inspections"
    raw, headers = request(base)
    catalog = json.loads(raw)
    owners = catalog["entries"]
    if len(owners) != 1:
        raise ValueError(f"Expected one existing closed-loop output; got {len(owners)}")
    request(base, 304, {"If-None-Match": headers["ETag"]})
    owner = owners[0]
    pin = {key: owner[key] for key in ("attempt_id", "ownership_epoch", "package_object_ref")}
    resource = base + "/" + urllib.parse.quote(owner["study_step_id"], safe="")
    query = "?" + urllib.parse.urlencode(pin)
    raw, headers = request(resource + query)
    metadata = json.loads(raw)
    if metadata["owner"] != owner or metadata["schema_version"] != "accepted_antenna_inspection.closed_loop.v1":
        raise ValueError("Wrong accepted publication owner or family")
    for key in ("session_id", "session_epoch", "runtime_stage_id"):
        if key in metadata:
            raise ValueError("Accepted result invented live-session ownership")
    display = metadata["closed_loop_display"]
    if display["validation_scope"] != "full_cold_bundle" or display["qualification"] != "NOT VERIFIED":
        raise ValueError("Wrong cold verification scope or scientific qualification")
    if metadata["capabilities"]["llg_drive"] or metadata["capabilities"]["per_ampere_basis"]:
        raise ValueError("Inspection was promoted to a qualified drive basis")
    request(resource + query, 304, {"If-None-Match": headers["ETag"]})
    for key, value in (("attempt_id", "stale-attempt"), ("ownership_epoch", int(pin["ownership_epoch"]) + 1),
                       ("package_object_ref", "0" * 64)):
        stale = {**pin, key: value}
        request(resource + "?" + urllib.parse.urlencode(stale), 409, {"If-None-Match": headers["ETag"]})
        request(resource + "/payloads/h_raw?" + urllib.parse.urlencode(stale), 409)
    summaries = {}
    for kind, unit in (("v_raw", "V"), ("j_local_raw", "A/m^2"), ("h_raw", "A/m")):
        path = resource + "/payloads/" + kind + query
        raw, headers = request(path)
        descriptor = display["payloads"][kind]
        digest = hashlib.sha256(raw).hexdigest()
        if digest != descriptor["sha256"] or len(raw) != descriptor["byte_length"] or not raw:
            raise ValueError(f"{kind}: HTTP bytes differ from verified manifest")
        if descriptor["unit"] != unit:
            raise ValueError(f"{kind}: unexpected SI unit {descriptor['unit']}")
        if len(raw) % 8:
            raise ValueError(f"{kind}: invalid f64 payload length")
        values = [value[0] for value in struct.iter_unpack("<d", raw)]
        if not all(math.isfinite(value) for value in values) or not any(value != 0 for value in values):
            raise ValueError(f"{kind}: invalid or all-zero field")
        summaries[kind] = {"bytes": len(raw), "sha256": digest, "unit": unit,
                           "count": len(values), "min": min(values), "max": max(values)}
        request(path, 304, {"If-None-Match": headers["ETag"]})
        partial, partial_headers = request(path, 206, {"Range": "bytes=0-7"})
        if partial != raw[:8] or partial_headers.get("Content-Range") != f"bytes 0-7/{len(raw)}":
            raise ValueError(f"{kind}: wrong byte range")
        request(path, 416, {"Range": f"bytes={len(raw)}-"})
    request(resource + "/payloads/unknown" + query, 400)
    request(resource + "/payloads/device_potential" + query, 400)
    request(resource, 400)
    after = snapshot()
    if after != before:
        raise ValueError("Read-only inspection changed authoring session, scene or commands")
    return {"status": "pass", "scope": "public_http_cold_inspection_only", "project_id": project_id,
            "run_id": run_id, "owner": owner, "checks": results, "payloads": summaries,
            "authoring_unchanged": True, "new_solve": False, "qualification": "NOT VERIFIED"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    if args.report.resolve() == Path(__file__).resolve():
        parser.error("report must not overwrite regression source")
    result = validate(args.base_url, args.project_id, args.run_id)
    args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"status": result["status"], "checks": len(result["checks"]), "payloads": result["payloads"]}))


if __name__ == "__main__":
    main()
