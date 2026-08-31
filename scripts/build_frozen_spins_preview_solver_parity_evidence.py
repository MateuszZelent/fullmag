#!/usr/bin/env python3
"""Build fail-closed Frozen Spins Preview/Solver parity evidence from browser receipts."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


EXPECTED_LANES = {"fdm_cpu_reference", "fem_cpu_native"}
EXPECTED_RENDER_PATHS = {
    "fdm_cpu_reference": "fdm-cuboid-instance-colors",
    "fem_cpu_native": "fem-surface-vertex-colors",
}
BROWSER_RECEIPT_SCHEMA = "fullmag.frozen_spins.browser.quantity.evidence.v1"
SOLVER_CERTIFICATE_SCHEMA = "fullmag.frozen_spins.runtime-status.v1"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def _canonical_sha256(value: Any, label: str) -> str:
    _require(isinstance(value, str), f"{label} must be a string")
    canonical = value.removeprefix("sha256:").lower()
    _require(bool(SHA256_RE.fullmatch(canonical)), f"{label} must be a SHA-256 identity")
    return canonical


def _object(value: Any, label: str) -> dict[str, Any]:
    _require(isinstance(value, dict), f"{label} must be an object")
    return value


def _array(value: Any, label: str) -> list[Any]:
    _require(isinstance(value, list), f"{label} must be an array")
    return value


def _nonempty_string(value: Any, label: str) -> str:
    _require(isinstance(value, str) and bool(value.strip()), f"{label} must be a non-empty string")
    return value


def _positive_integer(value: Any, label: str) -> int:
    _require(isinstance(value, int) and not isinstance(value, bool) and value > 0,
             f"{label} must be a positive integer")
    return value


def _nonnegative_integer(value: Any, label: str) -> int:
    _require(isinstance(value, int) and not isinstance(value, bool) and value >= 0,
             f"{label} must be a non-negative integer")
    return value


def _load_receipt(raw: bytes, path: Path) -> dict[str, Any]:
    value = json.loads(raw.decode("utf-8"))
    _require(isinstance(value, dict), f"{path}: receipt root must be an object")
    return value


def _receipt_evidence(path: Path) -> dict[str, Any]:
    raw = path.read_bytes()
    receipt = _load_receipt(raw, path)
    _require(
        receipt.get("schema_version") == BROWSER_RECEIPT_SCHEMA,
        f"{path}: browser receipt schema must be {BROWSER_RECEIPT_SCHEMA}",
    )
    _require(receipt.get("status") == "PASS", f"{path}: browser receipt status must be PASS")
    run_id = _nonempty_string(receipt.get("run_id"), f"{path}: run_id")
    _require(path.stem == run_id, f"{path}: run_id must match the receipt filename")
    quantity = _object(receipt.get("quantity"), f"{path}: quantity")
    _require(
        quantity.get("id") == "frozen_spins"
        and quantity.get("shape") == "spatial_scalar"
        and quantity.get("unit") == "1"
        and quantity.get("location") == "node",
        f"{path}: receipt must prove the standard node-located frozen_spins spatial_scalar quantity",
    )

    field_meta = _object(receipt.get("field_meta"), f"{path}: field_meta")
    _require(
        field_meta.get("quantity_id") == "frozen_spins"
        and field_meta.get("kind") == "spatial_scalar"
        and field_meta.get("components") == 1
        and field_meta.get("location") == "magnetic_only"
        and field_meta.get("unit") == "1"
        and field_meta.get("state") == "complete",
        f"{path}: field metadata is not a complete one-component frozen_spins scalar",
    )
    _positive_integer(field_meta.get("field_revision"), f"{path}: field_meta.field_revision")
    capability = _object(field_meta.get("resolved_capability"), f"{path}: resolved_capability")
    lane = capability.get("lane")
    _require(lane in EXPECTED_LANES, f"{path}: unexpected runtime lane {lane!r}")
    _require(
        capability.get("quantity_id") == "frozen_spins"
        and capability.get("provider") == "available"
        and capability.get("request") == "field_vector"
        and capability.get("materialization") == "materialized"
        and capability.get("render") == "renderable"
        and capability.get("publication") == "interactive"
        and capability.get("scope") == "full"
        and capability.get("precision") == "double",
        f"{path}: resolved quantity capability is incomplete or degraded",
    )
    carriers = _array(capability.get("carriers"), f"{path}: resolved_capability.carriers")
    _require(len(carriers) == 1, f"{path}: exactly one full-domain scalar carrier is required")
    carrier = _object(carriers[0], f"{path}: resolved_capability.carriers[0]")
    _require(
        carrier.get("scope") == "full"
        and carrier.get("scope_kind") == "full"
        and carrier.get("components") == 1
        and carrier.get("indexing") == "node"
        and carrier.get("view") == "magnitude"
        and carrier.get("payload_state") == "current",
        f"{path}: scalar carrier is not the complete current node carrier",
    )

    workflow = _object(receipt.get("authoring_workflow"), f"{path}: authoring_workflow")
    constraint_id = _nonempty_string(workflow.get("constraint_id"), f"{path}: constraint_id")
    preview = _object(workflow.get("preview"), f"{path}: preview")
    solver = _object(workflow.get("solver_certificate"), f"{path}: solver_certificate")
    viewport = _object(workflow.get("viewport"), f"{path}: viewport")
    _require(
        preview.get("authority") == "speculative_authoring_preview"
        and preview.get("solver_binding") == "unbound",
        f"{path}: preview authority/binding contract is invalid",
    )
    _nonempty_string(preview.get("preview_id"), f"{path}: preview.preview_id")
    solve_command = _object(workflow.get("solve_command"), f"{path}: solve_command")
    _require(
        solve_command.get("kind") == "solve" and solve_command.get("status") == "dispatched",
        f"{path}: solve command was not dispatched",
    )
    _nonempty_string(solve_command.get("command_id"), f"{path}: solve_command.command_id")
    _positive_integer(solve_command.get("scene_revision"), f"{path}: solve_command.scene_revision")
    _require(
        solver.get("schema") == SOLVER_CERTIFICATE_SCHEMA,
        f"{path}: solver certificate schema must be {SOLVER_CERTIFICATE_SCHEMA}",
    )

    preview_revision = _positive_integer(
        preview.get("source_state_revision"), f"{path}: preview.source_state_revision"
    )
    solver_revision = _positive_integer(
        solver.get("source_state_revision"), f"{path}: solver.source_state_revision"
    )
    _require(
        preview_revision == solver_revision,
        f"{path}: source_state_revision mismatch: preview={preview_revision} solver={solver_revision}",
    )

    identities: dict[str, str] = {}
    for name, preview_key, solver_key in (
        ("mask_sha256", "mask_sha256", "mask_sha256"),
        ("reference_sha256", "reference_sha256", "reference_sha256"),
        ("topology_fingerprint", "topology_fingerprint", "topology_fingerprint"),
    ):
        preview_identity = _canonical_sha256(preview.get(preview_key), f"{path}: preview.{preview_key}")
        solver_identity = _canonical_sha256(solver.get(solver_key), f"{path}: solver.{solver_key}")
        _require(
            preview_identity == solver_identity,
            f"{path}: {name} mismatch: preview={preview_identity} solver={solver_identity}",
        )
        identities[name] = preview_identity

    carrier_fingerprint = _canonical_sha256(
        carrier.get("carrier_fingerprint"), f"{path}: carrier_fingerprint"
    )
    _require(
        carrier_fingerprint == identities["topology_fingerprint"],
        f"{path}: scalar carrier topology identity does not match the solver certificate",
    )

    preview_frozen = _nonnegative_integer(
        preview.get("frozen_site_count"), f"{path}: preview.frozen_site_count"
    )
    preview_free = _nonnegative_integer(
        preview.get("free_site_count"), f"{path}: preview.free_site_count"
    )
    active_site_count = preview_frozen + preview_free
    _require(active_site_count > 0, f"{path}: active site count must be positive")
    _require(
        solver.get("frozen_site_count") == preview_frozen
        and solver.get("free_site_count") == preview_free
        and solver.get("active_site_count") == active_site_count,
        f"{path}: Preview/Solver site counts do not match",
    )
    active_constraint_ids = _array(
        solver.get("active_constraint_ids"), f"{path}: solver.active_constraint_ids"
    )
    _require(
        all(isinstance(value, str) for value in active_constraint_ids)
        and constraint_id in active_constraint_ids,
        f"{path}: solver certificate does not own the committed constraint",
    )
    activation_epochs = _object(
        solver.get("constraint_activation_epochs"),
        f"{path}: solver.constraint_activation_epochs",
    )
    activation_epoch = _positive_integer(
        activation_epochs.get(constraint_id),
        f"{path}: solver.constraint_activation_epochs[{constraint_id!r}]",
    )
    resolved_set_revision = _positive_integer(
        solver.get("resolved_constraint_set_revision"),
        f"{path}: solver.resolved_constraint_set_revision",
    )
    _require(
        solver.get("vector_dimension") == 3
        and solver.get("scalar_component_dof_count") == active_site_count * 3,
        f"{path}: solver vector dimension or scalar DOF count is inconsistent",
    )

    rendered_ack = _object(workflow.get("rendered_ack"), f"{path}: workflow.rendered_ack")
    top_level_ack = _object(receipt.get("rendered_ack"), f"{path}: rendered_ack")
    _require(rendered_ack == top_level_ack, f"{path}: rendered ACK copies are inconsistent")
    _require(
        rendered_ack.get("status") == "rendered"
        and rendered_ack.get("viewport_id") == "viewport-main"
        and rendered_ack.get("effective_render_mode") == "surface",
        f"{path}: viewport did not acknowledge the frozen_spins surface render",
    )
    ack_revision = _positive_integer(
        rendered_ack.get("revision"), f"{path}: rendered_ack.revision"
    )
    visualization = _object(
        workflow.get("visualization_state"), f"{path}: visualization_state"
    )
    visualization_quantity = _object(
        visualization.get("quantity"), f"{path}: visualization_state.quantity"
    )
    _require(
        visualization.get("revision") == ack_revision
        and visualization.get("active_quantity_id") == "frozen_spins"
        and visualization_quantity.get("active_quantity_id") == "frozen_spins"
        and visualization_quantity.get("field_component") == "magnitude",
        f"{path}: visualization state is not bound to the acknowledged frozen_spins quantity",
    )
    visualization_diagnostics = _object(
        visualization.get("diagnostics"), f"{path}: visualization_state.diagnostics"
    )
    _require(
        visualization_diagnostics.get("warnings") == []
        and visualization_diagnostics.get("degraded_reasons") == [],
        f"{path}: visualization diagnostics contain warnings or degradation",
    )
    expected_render_path = EXPECTED_RENDER_PATHS[lane]
    _require(
        viewport.get("quantity_selected") is True
        and viewport.get("scalar_complete") is True
        and viewport.get("scalar_carrier_adopted") is True
        and viewport.get("surface_ready") is True
        and viewport.get("degradation_none") is True
        and viewport.get("render_path") == expected_render_path,
        f"{path}: viewport did not adopt a complete, non-degraded frozen_spins carrier",
    )
    webgl = _object(receipt.get("webgl"), f"{path}: webgl")
    _require(
        webgl.get("found") is True
        and webgl.get("hasContext") is True
        and webgl.get("isContextLost") is False,
        f"{path}: WebGL proof is incomplete or context was lost",
    )
    width = _positive_integer(webgl.get("width"), f"{path}: webgl.width")
    height = _positive_integer(webgl.get("height"), f"{path}: webgl.height")
    console_errors = _array(receipt.get("console_errors"), f"{path}: console_errors")
    _require(console_errors == [], f"{path}: browser console errors are present")

    return {
        "lane": lane,
        "run_id": run_id,
        "receipt": {
            "path": path.as_posix(),
            "bytes": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest(),
        },
        "source_state_revision": preview_revision,
        "activation_epoch": activation_epoch,
        "resolved_constraint_set_revision": resolved_set_revision,
        **identities,
        "active_site_count": active_site_count,
        "frozen_site_count": preview_frozen,
        "free_site_count": preview_free,
        "render_path": expected_render_path,
        "rendered_ack_revision": ack_revision,
        "webgl": {
            "width": width,
            "height": height,
            "context_lost": False,
        },
    }


def build_evidence(receipt_paths: list[Path]) -> dict[str, Any]:
    _require(len(receipt_paths) == 2, "exactly two browser receipts are required")
    lanes = [_receipt_evidence(path) for path in receipt_paths]
    lane_ids = {lane["lane"] for lane in lanes}
    _require(lane_ids == EXPECTED_LANES, f"required lanes are {sorted(EXPECTED_LANES)}, got {sorted(lane_ids)}")
    lanes.sort(key=lambda lane: lane["lane"])
    binding_material = "\n".join(
        f"{lane['lane']}:{lane['receipt']['sha256']}" for lane in lanes
    ).encode("ascii")
    evidence_digest = hashlib.sha256(binding_material).hexdigest()
    return {
        "schema_version": "fullmag.frozen_spins.preview_solver_parity.evidence.v1",
        "evidence_id": f"frozen-spins-preview-solver-parity-{evidence_digest}",
        "status": "PASS",
        "implementation_status": "RUNTIME_CONFIRMED",
        "qualification_status": "UNQUALIFIED",
        "qualification_blocker": "clean_source_identity_and_remaining_p15_matrix_not_bound",
        "test_case_ids": ["FS-P15-PREVIEW-SOLVER-PARITY"],
        "contracts": {
            "browser_receipt_schema": "PASS",
            "positive_source_state_revision": "PASS",
            "source_state_revision_parity": "PASS",
            "mask_identity_parity": "PASS",
            "reference_identity_parity": "PASS",
            "topology_identity_parity": "PASS",
            "site_count_parity": "PASS",
            "standard_quantity_rendered": "PASS",
            "solver_owned_certificate": "PASS",
            "rendered_ack": "PASS",
            "webgl_context": "PASS",
        },
        "lanes": lanes,
        "timestamp_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--receipt", action="append", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    evidence = build_evidence(args.receipt)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_name(f"{args.output.name}.tmp.{os.getpid()}")
    with temporary.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(args.output)
    print(json.dumps({"output": args.output.as_posix(), "status": "PASS", "lanes": sorted(EXPECTED_LANES)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
