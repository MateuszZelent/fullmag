#!/usr/bin/env python3
"""Verify the bounded public FDM GPU pure-Neumann fixture against its SI oracle."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def assert_close(actual: float, expected: float, tolerance: float, label: str) -> None:
    if not math.isclose(actual, expected, rel_tol=0.0, abs_tol=tolerance):
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: verify_fdm_gpu_public_charge_zero_mean_output.py OUTPUT_DIR")
    output_dir = Path(sys.argv[1])
    metadata = read_json(output_dir / "metadata.json")
    provenance = metadata["execution_provenance"]
    charge_provenance = provenance["charge_transport"]
    assert metadata["status"] == "completed"
    assert metadata["field_snapshots"] == 2
    assert provenance["execution_engine"] == "cuda_fdm_charge_only"
    assert provenance["lossy_fallback_used"] is False
    assert charge_provenance["fallbacks_triggered"] == []
    assert charge_provenance["gauge_policy"] == "zero_mean_per_free_component"

    potential = read_json(output_dir / "fields/V_electric/step_000000.json")["values"]
    current = read_json(output_dir / "fields/J_charge/step_000000.json")["values"]
    assert len(potential) == 2
    assert len(current) == 6

    # For n dot J = +2e13 A/m2 at x_min and -2e13 A/m2 at x_max,
    # Jx = -2e13 A/m2 and the zero-mean cell-centre potential is -0.025,+0.025 V.
    assert_close(sum(potential) / len(potential), 0.0, 1.0e-14, "mean(V)")
    assert_close(potential[0], -0.025, 1.0e-14, "V[0]")
    assert_close(potential[1], 0.025, 1.0e-14, "V[1]")
    for cell in range(2):
        assert_close(current[3 * cell], -2.0e13, 1.0e-1, f"Jx[{cell}]")
        assert_close(current[3 * cell + 1], 0.0, 1.0e-12, f"Jy[{cell}]")
        assert_close(current[3 * cell + 2], 0.0, 1.0e-12, f"Jz[{cell}]")

    transport = read_json(output_dir / "transport/charge/fdm_gpu_charge_v1.json")
    execution = transport["execution"]
    assert execution["resolved_engine"] == "cuda_fdm_charge_only"
    assert execution["gauge_policy"] == "zero_mean_per_free_component"
    for metric in ("physical_residual", "component_balance", "electrode_balance"):
        assert execution[metric] < 1.0e-12, f"{metric} exceeds tolerance"
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
