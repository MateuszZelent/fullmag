"""Compare two ECE solver artifacts at the same geometry, port and probe."""
import argparse
import json
from pathlib import Path

import numpy as np


_SHARED_INPUTS = (
    "cpw", "frequency_hz", "phasor_convention", "boundary_model", "sha256",
    "terminal_voltages_v", "terminal_loads_ohm",
)


def _difference(left, right, scale=1.0):
    if left is None or right is None:
        return None
    return float(abs(right - left)*scale)


def compare(full, full_fields, candidate, candidate_fields):
    if full["model"] != "maxwell" or candidate["model"] != "darwin":
        raise ValueError("expected a Maxwell reference and a Darwin candidate")
    for name in _SHARED_INPUTS:
        if full[name] != candidate[name]:
            raise ValueError(f"model inputs differ in {name}")
    if not np.array_equal(full_fields["probe_xyz_m"], candidate_fields["probe_xyz_m"]):
        raise ValueError("model inputs differ in probe geometry")
    reference = full_fields["probe_H_over_I_per_m"]
    newer = candidate_fields["probe_H_over_I_per_m"]
    if (reference.shape != full_fields["probe_xyz_m"].shape
            or reference.shape != newer.shape
            or not (np.isfinite(reference).all() and np.isfinite(newer).all())):
        raise ValueError("expected matching finite vector phasors")
    norm = np.linalg.norm(reference)
    if not np.isfinite(norm) or norm == 0:
        raise ValueError("relative error needs a nonzero finite reference field")
    a = full.get("local_minimum", {})
    b = candidate.get("local_minimum", {})
    return {
        "comparison": "standalone ECE Maxwell versus Darwin",
        "evidence_status": "requires_mesh_convergence_and_an_independent_reference",
        "relative_vector_H_l2": float(np.linalg.norm(newer - reference)/norm),
        "cpw": full["cpw"],
        "frequency_hz": full["frequency_hz"],
        "ground_gap_fraction_difference_pp": _difference(
            full["cross_section"]["ground_gap_fraction"],
            candidate["cross_section"]["ground_gap_fraction"], 100),
        "minimum_position_difference_rad_per_um": _difference(
            a.get("k_rad_per_m"), b.get("k_rad_per_m"), 1e-6),
        "minimum_depth_difference_pp_of_own_peak": _difference(
            a.get("relative_to_peak"), b.get("relative_to_peak"), 100),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("maxwell_directory", type=Path)
    parser.add_argument("darwin_directory", type=Path)
    args = parser.parse_args()
    left, right = args.maxwell_directory, args.darwin_directory
    full = json.loads((left/"manifest.json").read_text())
    candidate = json.loads((right/"manifest.json").read_text())
    with np.load(left/"fields.npz", allow_pickle=False) as ref:
        with np.load(right/"fields.npz", allow_pickle=False) as darwin:
            report = compare(full, ref, candidate, darwin)
    print(json.dumps(report, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
