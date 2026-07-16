#!/usr/bin/env python3
"""Capture one versioned topological-charge v2 resource as runtime evidence."""

from __future__ import annotations

import argparse
import json
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Iterable


SCHEMA_VERSION = "topological_charge_runtime.v2"
METHOD = "berg_luescher_oriented_triangles_v2"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def load_json(url: str) -> dict[str, Any]:
    with urllib.request.urlopen(url, timeout=30) as response:  # noqa: S310 -- caller supplies local API URL
        payload = json.loads(response.read().decode("utf-8"))
    require(isinstance(payload, dict), f"{url}: expected JSON object")
    return payload


def build_evidence(scenario: str, resource: dict[str, Any]) -> dict[str, Any]:
    require(resource.get("schema_version") == "topological_charge.v2", "resource schema_version is not topological_charge.v2")
    require(resource.get("method", {}).get("id") == METHOD, "resource method is not the v2 oriented-triangle method")
    provenance = resource.get("provenance")
    require(isinstance(provenance, dict), "resource provenance is required")
    resolved = provenance.get("resolved_execution")
    require(isinstance(resolved, dict), "resource must include resolved_execution")
    requested = provenance.get("requested_execution")
    require(isinstance(requested, dict), "resource must include requested_execution")
    run = {
        "object_id": resource.get("object_id"),
        "charge": resource.get("charge"),
        "trust": resource.get("trust"),
        "support_frame": resource.get("support_frame"),
        "provenance": {
            "discretization": provenance.get("discretization"),
            "fe_order": provenance.get("fe_order"),
            "requested_execution": requested,
            "resolved_execution": resolved,
        },
    }
    return {"schema_version": SCHEMA_VERSION, "method": METHOD, "scenario": scenario, "runs": [run]}


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-base-url", required=True)
    parser.add_argument("--object-id", required=True)
    parser.add_argument("--scenario", choices=("fdm", "fem_p1", "cross_backend"), required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--plane", default="xy")
    parser.add_argument("--support", choices=("midplane", "layer_profile"), default="midplane")
    args = parser.parse_args(list(argv) if argv is not None else None)
    try:
        base = args.api_base_url.rstrip("/")
        status = load_json(f"{base}/v2/sessions/current/status")
        query = urllib.parse.urlencode({"plane": args.plane, "support": args.support})
        object_id = urllib.parse.quote(args.object_id, safe="")
        resource = load_json(f"{base}/v2/sessions/current/analysis/extensions/objects/{object_id}/topological-charge?{query}")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.with_name("topological-charge-resource.json").write_text(
            json.dumps(resource, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        evidence = build_evidence(args.scenario, resource)
        evidence["status_resource"] = status
        evidence["topological_charge_resource"] = resource
        args.output.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    except (OSError, urllib.error.URLError, json.JSONDecodeError, ValueError) as error:
        print(f"FAIL: {error}")
        return 1
    print(json.dumps({"status": "captured", "output": str(args.output)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
