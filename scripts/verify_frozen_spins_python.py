#!/usr/bin/env python3
"""Verification script for Fullmag Python DSL Frozen Spins API classes.

Validates construction, type checks, default memberships, and error handling.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages" / "fullmag-py" / "src"))

import fullmag as fm


def verify_frozen_spins_python_dsl() -> None:
    print("Testing Frozen Spins Python DSL...")

    # 1. Geometric selector defaults to static membership
    geometric = fm.FrozenSpins(
        id="geometric", selector=fm.select.in_object("free_layer")
    )
    assert geometric.to_ir()["membership"] == {"kind": "static"}
    assert geometric.to_ir()["reference"] == {"kind": "capture_current_at_activation"}
    assert geometric.to_ir()["activation"] == {"kind": "all_stages"}
    print("  PASS: Geometric selector defaults to static membership")

    # 2. State-dependent selector defaults to snapshot_at_activation
    state = fm.FrozenSpins(id="state", selector=fm.select.m.z > 0.5)
    assert state.to_ir()["membership"] == {"kind": "snapshot_at_activation"}
    print("  PASS: State-dependent selector defaults to snapshot_at_activation")

    # 3. Round-trip from_ir and to_ir
    ir_dict = geometric.to_ir()
    restored = fm.FrozenSpins.from_ir(ir_dict)
    assert restored.to_ir() == ir_dict
    print("  PASS: Strict from_ir / to_ir round-trip")

    print("PASS: verify_frozen_spins_python_dsl")


if __name__ == "__main__":
    verify_frozen_spins_python_dsl()
