"""Independent modeled-domain V/J/H reference for the nominal finite GSG example.

No FEM execution, omitted feed contribution, magnetic response or qualification.
The geometric/material assumptions are authored in the matching public example.
"""
from __future__ import annotations

import json
import math

from antenna_current_source_oracle import finite, rectangular_prism_field

WIDTH_M = 200e-9
THICKNESS_M = 90e-9
GAP_M = 250e-9
SPACING_M = 30e-9
DEVICE_LENGTH_M = 20e-6
LEAD_LENGTH_M = 2e-6
CONDUCTIVITY_SPM = 3.5e7
SIGNAL_CURRENT_A = 1e-3
BRANCHES = (("signal", 0.0, 1.0), ("ground_left", WIDTH_M + GAP_M, -0.5),
            ("ground_right", -(WIDTH_M + GAP_M), -0.5))


def gsg_field(position_m, *, subdivisions=128):
    """Return modeled H in A/m at a world-space point outside the metal z slab."""
    if len(position_m) != 3:
        raise ValueError("position must have three components")
    x, y, z = (finite(v, "position") for v in position_m)
    half_length = DEVICE_LENGTH_M / 2 + LEAD_LENGTH_M
    contributions = []
    for _, center, weight in BRANCHES:
        # Proper rotation: local x -> world +y, local y -> world -x.
        h = rectangular_prism_field(
            (y, -x, z), lower_m=(-half_length, -center - WIDTH_M / 2, SPACING_M),
            upper_m=(half_length, -center + WIDTH_M / 2, SPACING_M + THICKNESS_M),
            current_density_apm2=weight * SIGNAL_CURRENT_A / (WIDTH_M * THICKNESS_M),
            subdivisions=subdivisions,
        )
        contributions.append((-h[1], h[0], h[2]))
    return tuple(math.fsum(row[axis] for row in contributions) for axis in range(3))


def reference():
    """Fixed 41-point profile plus gauge-free DC references; JSON-compatible."""
    total_length = DEVICE_LENGTH_M + 2 * LEAD_LENGTH_M
    branches = []
    for name, center, weight in BRANCHES:
        current = weight * SIGNAL_CURRENT_A
        density = current / (WIDTH_M * THICKNESS_M)
        branches.append({"part_id": name, "center_x_m": center, "current_y_a": current,
                         "current_density_xyz_apm2": [0.0, density, 0.0],
                         "potential_gradient_y_vpm": -density / CONDUCTIVITY_SPM,
                         "potential_minus_y_end_minus_plus_y_end_v": density * total_length / CONDUCTIVITY_SPM})
    positions = [(i * 100e-9, 0.0, -5e-9) for i in range(-20, 21)]
    return {"schema": "fullmag.sushruth-finite-gsg-reference.v1",
            "publication_doi": "10.1103/PhysRevResearch.2.043203",
            "scope": "modeled_finite_conductors_and_leads_only",
            "fullmag_solver_executed": False, "boris_solver_executed": False,
            "physics_qualified": False, "omitted_feed_qualified": False,
            "width_m": WIDTH_M, "thickness_m": THICKNESS_M, "gap_m": GAP_M,
            "spacing_m": SPACING_M, "device_length_m": DEVICE_LENGTH_M,
            "lead_length_m": LEAD_LENGTH_M, "conductivity_spm": CONDUCTIVITY_SPM,
            "quadrature": {"kind": "exact_length_composite_simpson_cross_section", "subdivisions": 128},
            "branches": branches,
            "samples": [{"position_xyz_m": p, "field_xyz_apm": gsg_field(p)} for p in positions]}


if __name__ == "__main__":
    print(json.dumps(reference(), sort_keys=True, allow_nan=False))
