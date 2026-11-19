#!/usr/bin/env python3
"""Verify full frozen Universe payloads and diagnostic parity through read-only HTTP."""
from __future__ import annotations

import argparse
from hashlib import sha256
import io
import json
from pathlib import Path
from urllib.parse import urlencode
import zipfile

import numpy as np

from smoke_antenna_external_lead_inspection import SmokeError, json_body, request, require, validate_origin
from smoke_saved_antenna_fields import BINARY, META, segment
from validate_accepted_antenna_closed_loop_http import validate

SOURCE_UNITS = {
    "v_raw": "V", "j_center_raw": "A/m^2", "j_local_raw": "A/m^2",
    "vertex_xyz": "m", "stable_vertex_ids": "1", "conductivity": "S/m",
}
SAMPLE_UNITS = {"sample_xyz": "m", "sample_cells": "1", "h_raw": "A/m"}
MANIFEST_SCHEMAS = (
    "antenna_frozen_full_universe_inspection.v1",
    "antenna_frozen_geometry_diagnostic.v1",
)


def read_inputs(full_directory: Path, reference_directory: Path):
    manifests = []
    for directory, schema in zip((full_directory, reference_directory), MANIFEST_SCHEMAS):
        manifest = json.loads((directory / "input-manifest.json").read_text())
        require(manifest["schema"] == schema, "Wrong frozen input family")
        scripts = list(directory.glob("*.py"))
        require(len(scripts) == 1 and sha256(scripts[0].read_bytes()).hexdigest() == manifest["script_sha256"],
                "Frozen script differs from its manifest")
        for name, descriptor in manifest["assets"].items():
            path = (directory / name).resolve()
            require(path.is_relative_to(directory.resolve()), "Frozen asset escapes its input root")
            data = path.read_bytes()
            require(len(data) == descriptor["bytes"] and sha256(data).hexdigest() == descriptor["sha256"],
                    "Frozen asset differs from its manifest")
        manifests.append(manifest)
    full, reference = manifests
    require(full["all_global_nodes_retained"] is True and full["sampling_domain"] == "global",
            "Requested input is not full Universe")
    require(full["assets"]["assets/global.fullmag-mesh"] == reference["assets"]["assets/global.fullmag-mesh"]
            and full["assets"]["assets/antenna-raw.npz"] == reference["assets"]["assets/antenna-raw.npz"],
            "Reference has a different frozen source or Global")
    with zipfile.ZipFile(full_directory / "assets/global.fullmag-mesh") as archive:
        mesh_manifest = json.loads(archive.read("manifest.json"))
        descriptor = mesh_manifest["members"]["topology.npz"]
        require(descriptor["bytes"] <= BINARY, "Frozen topology exceeds verification budget")
        topology = archive.read("topology.npz")
        require(len(topology) == descriptor["bytes"] and sha256(topology).hexdigest() == descriptor["sha256"],
                "Frozen topology member differs from its manifest")
    with np.load(io.BytesIO(topology), allow_pickle=False) as arrays:
        nodes = arrays["nodes"].astype("<f8", copy=False)
        require(np.all(arrays["cell_types"] == "tet4")
                and np.array_equal(arrays["cell_offsets"], np.arange(len(arrays["cell_types"]) + 1) * 4),
                "Frozen Global is not the supported Tet4 carrier")
        cells = arrays["cell_nodes"].astype("<u4").reshape(-1, 4)
        require(np.all(cells < len(nodes)), "Frozen Global connectivity is invalid")
        require(nodes.shape == (full["global_nodes_cells"][0], 3)
                and len(arrays["cell_types"]) == full["global_nodes_cells"][1]
                and np.isfinite(nodes).all(), "Frozen Global cardinality or coordinates differ")
    ordinals = reference["selection"]["source_global_node_ordinals"]
    require(len(ordinals) == reference["sampling_nodes_cells"][0]
            and len(set(ordinals)) == len(ordinals)
            and all(type(node) is int and 0 <= node < len(nodes) for node in ordinals),
            "Diagnostic node mapping is invalid")
    expected_reference = np.asarray(reference["selection"]["candidate_node_coordinates_m"], dtype="<f8")
    require(nodes[ordinals].tobytes() == expected_reference.tobytes(), "Diagnostic node mapping moved coordinates")
    return full, reference, nodes, cells, ordinals


def fetch_bundle(origin, project, run):
    run_path = f"/v2/persistence/projects/{segment(project)}/runs/{segment(run)}"
    selected_run = json_body(request(origin, run_path, {}, META), 200)
    require(selected_run["project_id"] == project and selected_run["run_id"] == run
            and len(selected_run["tasks"]) == 1, "Antenna run task identity is ambiguous")
    task = selected_run["tasks"][0]
    require(task["lifecycle"] == "succeeded", "Antenna run has no successful task")
    base = run_path + "/antenna-inspections"
    catalog = json_body(request(origin, base, {}, META), 200)
    require(catalog["schema_version"] == "accepted_antenna_inspection_catalog.v1"
            and catalog["project_id"] == project and catalog["run_id"] == run,
            "Antenna catalog returned a foreign project or run")
    require(len(catalog["entries"]) == 1, "Expected exactly one accepted antenna result")
    owner = catalog["entries"][0]
    require(owner["run_id"] == run and all(owner[key] == task[key]
            for key in ("task_id", "attempt_id", "ownership_epoch")),
            "Antenna publication differs from the successful task identity")
    query = "?" + urlencode({key: owner[key] for key in ("attempt_id", "ownership_epoch", "package_object_ref")})
    resource = base + "/" + segment(owner["study_step_id"])
    metadata = json_body(request(origin, resource + query, {}, META), 200)
    require(metadata["project_id"] == project and metadata["owner"] == owner and metadata["schema_version"] == "accepted_antenna_inspection.closed_loop.v1",
            "Accepted antenna identity or family differs")
    payloads = {}
    for name, unit in {**SOURCE_UNITS, **SAMPLE_UNITS}.items():
        descriptor = metadata["closed_loop_display"]["payloads"][name]
        require(descriptor["unit"] == unit and 0 < descriptor["byte_length"] <= BINARY,
                "Payload unit or read budget differs")
        response = request(origin, resource + "/payloads/" + name + query, {}, BINARY)
        require(response.status == 200 and len(response.body) == descriptor["byte_length"]
                and sha256(response.body).hexdigest() == descriptor["sha256"],
                "Pinned payload differs from its verified descriptor")
        payloads[name] = response.body
    return owner, payloads


def compare_payloads(full, reference, global_nodes, global_cells, ordinals, reference_cells):
    require(global_nodes.ndim == 2 and global_nodes.shape[1] == 3
            and len(global_nodes) > len(ordinals), "Full carrier must exceed the diagnostic subset")
    require(full["sample_cells"] == np.asarray(global_cells, dtype="<u4").tobytes()
            and reference["sample_cells"] == np.asarray(reference_cells, dtype="<u4").tobytes(),
            "Sampling Tet4 connectivity differs from the frozen carrier")
    expected = np.asarray(global_nodes, dtype="<f8").tobytes()
    require(full["sample_xyz"] == expected, "Full samples do not preserve all Global coordinates and their order")
    selected_xyz = b"".join(expected[node * 24:(node + 1) * 24] for node in ordinals)
    require(reference["sample_xyz"] == selected_xyz, "Reference coordinates differ from the frozen mapping")
    for name, count, payload in (
        ("full H", len(global_nodes), full["h_raw"]),
        ("reference H", len(ordinals), reference["h_raw"]),
    ):
        require(len(payload) == count * 24, name + " cardinality differs")
        require(np.isfinite(np.frombuffer(payload, dtype="<f8")).all(), name + " contains nonfinite values")
    for name in SOURCE_UNITS:
        require(full[name] == reference[name], "Accepted source changed: " + name)
    selected_h = b"".join(full["h_raw"][node * 24:(node + 1) * 24] for node in ordinals)
    require(selected_h == reference["h_raw"], "Shared H samples are not bitwise reproducible")
    return {
        "full_samples": len(global_nodes), "full_Tet4": len(global_cells),
        "reference_samples": len(ordinals), "frozen_sampling_connectivity_bitwise_equal": True,
        "all_global_coordinates_bitwise_equal": True, "shared_H_bitwise_equal": True,
        "source_payloads_bitwise_equal": list(SOURCE_UNITS),
        "payload_sha256": {name: sha256(raw).hexdigest() for name, raw in full.items()},
    }


def verify(origin, project, full_run, full_directory, reference_directory):
    origin = validate_origin(origin)
    frozen, diagnostic, nodes, cells, ordinals = read_inputs(full_directory, reference_directory)
    base = f"/v2/persistence/projects/{segment(project)}/runs/{segment(full_run)}"
    run = json_body(request(origin, base, {}, META), 200)
    require(run["project_id"] == project and run["run_id"] == full_run and len(run["tasks"]) == 1, "Full run task identity is ambiguous")
    lifecycle = run["tasks"][0]["lifecycle"]
    result = {
        "schema": "fullmag.frozen_universe_parity.v1", "project_id": project, "run_id": full_run,
        "task_id": run["tasks"][0]["task_id"], "task_lifecycle": lifecycle,
        "read_only": True, "new_solve": False, "browser_qualified": False,
        "physics_qualified": False, "cold_reopen_qualified": False,
    }
    if lifecycle != "succeeded":
        result.update(status="waiting" if lifecycle in {"accepted", "queued", "preparing", "running", "stopping"} else "failed",
                      full_universe_verified=False)
        return result
    gate = validate(origin, project, full_run)
    owner, payloads = fetch_bundle(origin, project, full_run)
    reference_run = frozen["prerequisite_geometry_diagnostic_run_id"]
    reference_owner, reference_payloads = fetch_bundle(origin, project, reference_run)
    result.update(
        status="passed", full_universe_verified=True, owner=owner, reference_owner=reference_owner,
        public_http_gate=gate,
        comparison=compare_payloads(payloads, reference_payloads, nodes, cells, ordinals, diagnostic["selection"]["candidate_cells"]),
        scope="Complete frozen sampling carrier and exact subset reproducibility; not physical qualification.",
    )
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("origin", "project", "full-run"):
        parser.add_argument("--" + name, required=True)
    for name in ("full-input", "reference-input", "report"):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    require(args.report.resolve() != Path(__file__).resolve(), "Report must not overwrite verifier source")
    try:
        result = verify(args.origin, args.project, args.full_run, args.full_input, args.reference_input)
    except (SmokeError, OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile) as error:
        result = {
            "schema": "fullmag.frozen_universe_parity.v1", "status": "failed", "error": str(error),
            "project_id": args.project, "run_id": args.full_run, "full_universe_verified": False,
            "read_only": True, "new_solve": False, "browser_qualified": False,
            "physics_qualified": False, "cold_reopen_qualified": False,
        }
    args.report.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["status"] == "passed" else 2 if result["status"] == "waiting" else 1


if __name__ == "__main__":
    raise SystemExit(main())
