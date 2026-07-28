#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


MESH_CAPABILITIES = {
    "mesh.topology.mixed_p1",
    "mesh.swept.prism",
    "mesh.transition.pyramid_tet",
    "mesh.exact_layer_count",
}
CPU_OPERATOR_CAPABILITY = "fem.cpu.exchange_demag.mixed_p1"
GPU_OPERATOR_CAPABILITY = "fem.gpu.exchange_demag.mixed_p1"
ALL_CAPABILITIES = MESH_CAPABILITIES | {
    CPU_OPERATOR_CAPABILITY,
    GPU_OPERATOR_CAPABILITY,
}
LANES = {
    "fdm_cpu_reference",
    "fdm_gpu_production",
    "fem_cpu_public",
    "fem_gpu_public",
}
MARKDOWN_STATUS = {
    "mesh.topology.mixed_p1": (
        "CPU `production_executable`; GPU `semantic_only`; FDM `unsupported`",
        "production_executable",
    ),
    "mesh.swept.prism": (
        "CPU `production_executable`; GPU `semantic_only`; FDM `unsupported`",
        "production_executable",
    ),
    "mesh.transition.pyramid_tet": (
        "CPU `production_executable`; GPU `semantic_only`; FDM `unsupported`",
        "production_executable",
    ),
    "mesh.exact_layer_count": (
        "CPU `production_executable`; GPU `semantic_only`; FDM `unsupported`",
        "production_executable",
    ),
    "fem.cpu.exchange_demag.mixed_p1": (
        "`production_executable`",
        "production_executable",
    ),
    "fem.gpu.exchange_demag.mixed_p1": ("`unsupported`", "source_visible"),
}
STATUS_VOCABULARY = {
    "unsupported",
    "source_visible",
    "semantic_only",
    "reference_executable",
    "development_executable",
    "partial_production_executable",
    "implemented",
    "production_executable",
    "validated",
}


def expected_lanes(capability_id: str) -> dict[str, str]:
    lanes = {lane: "unsupported" for lane in LANES}
    if capability_id in MESH_CAPABILITIES:
        lanes["fem_cpu_public"] = "production_executable"
        lanes["fem_gpu_public"] = "semantic_only"
    elif capability_id == CPU_OPERATOR_CAPABILITY:
        lanes["fem_cpu_public"] = "production_executable"
    return lanes


def validate(root: Path) -> list[str]:
    errors: list[str] = []
    specs = root / "docs/specs"
    markdown_path = specs / "capability-matrix-v0.md"
    json_path = specs / "capability-matrix-v0.json"
    runner_path = root / "crates/fullmag-runner/src/capabilities.rs"
    try:
        markdown = markdown_path.read_text(encoding="utf-8")
        matrix = json.loads(json_path.read_text(encoding="utf-8"))
        runner = runner_path.read_text(encoding="utf-8")
    except (OSError, json.JSONDecodeError) as error:
        return [str(error)]

    features = matrix.get("features")
    if not isinstance(features, list):
        return ["capability matrix JSON must contain features[]"]
    feature_ids = [
        feature.get("id")
        for feature in features
        if isinstance(feature, dict) and isinstance(feature.get("id"), str)
    ]
    if len(feature_ids) != len(set(feature_ids)):
        errors.append("capability matrix JSON contains duplicate feature IDs")
    by_id = {feature.get("id"): feature for feature in features if isinstance(feature, dict)}
    mixed_ids = {feature_id for feature_id in feature_ids if "mixed_p1" in feature_id} | {
        feature_id for feature_id in feature_ids if feature_id in MESH_CAPABILITIES
    }
    if mixed_ids != ALL_CAPABILITIES:
        errors.append(
            "capability matrix JSON mixed-P1 IDs must be exactly: "
            + ", ".join(sorted(ALL_CAPABILITIES))
        )
    json_vocabulary = matrix.get("status_vocabulary")
    if not isinstance(json_vocabulary, dict) or set(json_vocabulary) != STATUS_VOCABULARY:
        errors.append("JSON status vocabulary must match the canonical product vocabulary")
    markdown_vocabulary = set(
        re.findall(r"^\| \*\*`([^`]+)`\*\* \|", markdown, re.MULTILINE)
    )
    if markdown_vocabulary != STATUS_VOCABULARY:
        errors.append("Markdown status vocabulary must match the canonical product vocabulary")

    runner_match = re.search(
        r"MIXED_P1_FEATURE_CAPABILITY_IDS:\s*\[&str;\s*6\]\s*=\s*\[(.*?)\];",
        runner,
        re.DOTALL,
    )
    runner_ids = set(re.findall(r'"([^"]+)"', runner_match.group(1))) if runner_match else set()
    if runner_ids != ALL_CAPABILITIES:
        errors.append("runner mixed-P1 capability IDs do not match the canonical six-ID set")
    runner_mesh_match = re.search(
        r"MIXED_P1_MESH_FEATURE_CAPABILITY_IDS:\s*\[&str;\s*4\]\s*=\s*\[(.*?)\];",
        runner,
        re.DOTALL,
    )
    runner_mesh_ids = (
        set(re.findall(r'"([^"]+)"', runner_mesh_match.group(1)))
        if runner_mesh_match
        else set()
    )
    if runner_mesh_ids != MESH_CAPABILITIES:
        errors.append(
            "runner mixed-P1 mesh capability IDs do not match the canonical four-ID set"
        )

    mixed_rows = re.findall(
        r"^\| `([^`]+)` \| ([^|]+) \| ([^|]+) \|",
        markdown,
        re.MULTILINE,
    )
    canonical_rows = [row for row in mixed_rows if row[0] in ALL_CAPABILITIES]
    row_counts = {
        capability_id: sum(row[0] == capability_id for row in canonical_rows)
        for capability_id in ALL_CAPABILITIES
    }
    unexpected_mixed_rows = {
        row[0]
        for row in mixed_rows
        if ("mixed_p1" in row[0] or row[0].startswith("mesh.swept.")
            or row[0].startswith("mesh.transition.")
            or row[0].startswith("mesh.exact_layer_"))
        and row[0] not in ALL_CAPABILITIES
    }
    if unexpected_mixed_rows:
        errors.append("Markdown contains unexpected mixed-P1 capability rows")

    for capability_id in sorted(ALL_CAPABILITIES):
        matching_rows = [row for row in canonical_rows if row[0] == capability_id]
        if row_counts[capability_id] != 1:
            errors.append(
                f"Markdown must contain exactly one status row for {capability_id}"
            )
        else:
            actual_markdown_status = (
                matching_rows[0][1].strip(),
                matching_rows[0][2].strip(),
            )
            if actual_markdown_status != MARKDOWN_STATUS[capability_id]:
                errors.append(
                    f"Markdown status for {capability_id} must be {MARKDOWN_STATUS[capability_id]}, "
                    f"got {actual_markdown_status}"
                )
        feature = by_id.get(capability_id)
        if not isinstance(feature, dict):
            errors.append(f"JSON is missing {capability_id}")
            continue
        actual_lanes = feature.get("lanes")
        for lane, expected_status in expected_lanes(capability_id).items():
            actual_status = (
                actual_lanes.get(lane) if isinstance(actual_lanes, dict) else None
            )
            if actual_status != expected_status:
                errors.append(
                    f"{capability_id}.{lane} must be {expected_status}, got {actual_status}"
                )
        if not isinstance(actual_lanes, dict) or set(actual_lanes) != LANES:
            errors.append(f"{capability_id}.lanes must contain exactly the canonical lanes")
        if feature.get("validated_workloads") != []:
            errors.append(f"{capability_id}.validated_workloads must be empty")
        if feature.get("validation_state") != "unvalidated":
            errors.append(f"{capability_id}.validation_state must be unvalidated")

    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args()
    errors = validate(args.root)
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1
    print("mixed-P1 capability contract is consistent")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
