#!/usr/bin/env python3
"""Verification script for Fullmag Frozen Spins ProblemIR serialization and schema.

Validates that FrozenSpins conforms to canonical schema version 2026.03.frozen-spins.v1.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages" / "fullmag-py" / "src"))

import fullmag as fm


def verify_frozen_spins_ir_serialization() -> None:
    print("Testing Frozen Spins ProblemIR serialization...")

    region = fm.ObjectRegion(
        owner_object="free_layer",
        name="Pinned edge",
        region_id="pinned_edge",
        shape=fm.Box(size=(10e-9, 50e-9, 3e-9)),
    )
    region.freeze_spins(
        id="pinned_edge_frozen",
        name="Pinned edge",
        stage_ids=["relax"],
    )

    magnet = fm.Ferromagnet(
        name="User-facing free layer",
        object_id="free_layer",
        geometry=fm.Box(size=(100e-9, 50e-9, 3e-9), name="free_layer_geometry"),
        material=fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.01),
        object_regions=(region,),
    )

    problem = fm.Problem(
        name="frozen-spins-contract",
        magnets=[magnet],
        energy=[fm.Exchange()],
        study=fm.Relaxation(outputs=[], max_steps=1),
        runtime_metadata={
            "study_pipeline": {
                "version": "study_pipeline.v1",
                "nodes": [
                    {
                        "id": "relax",
                        "stage_kind": "relax",
                        "enabled": True,
                        "payload": {},
                    }
                ],
            }
        },
    )

    ir = problem.to_ir(include_geometry_assets=False)
    assert "magnetization_constraints" in ir, "ProblemIR must contain magnetization_constraints"
    assert len(ir["magnetization_constraints"]) == 1, "Expected exactly 1 constraint in IR"

    c_ir = ir["magnetization_constraints"][0]
    assert c_ir["kind"] == "frozen_spins", f"Constraint kind mismatch: {c_ir['kind']}"
    assert c_ir["schema_version"] == "frozen_spins.v1", f"Schema mismatch: {c_ir['schema_version']}"
    assert c_ir["id"] == "pinned_edge_frozen"
    assert c_ir["selector"] == {
        "kind": "in_region",
        "object_id": "free_layer",
        "region_id": "pinned_edge",
    }
    assert c_ir["reference"] == {"kind": "capture_current_at_activation"}
    assert c_ir["activation"] == {"kind": "stage_ids", "stage_ids": ["relax"]}

    print("PASS: verify_frozen_spins_ir_serialization")


if __name__ == "__main__":
    verify_frozen_spins_ir_serialization()
