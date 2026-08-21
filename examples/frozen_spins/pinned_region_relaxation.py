#!/usr/bin/env python3
"""Example: Energy relaxation with pinned boundary spins (Frozen Spins constraint).

Simulates a Permalloy thin strip where the left boundary is pinned in the +z
direction while the rest of the strip relaxes under exchange and demagnetization.
"""
from __future__ import annotations

import fullmag as fm

# 1. Define geometry and world
world = fm.World(box=fm.Box((0.0, 0.0, 0.0), (200e-9, 50e-9, 10e-9)))
mesh = fm.Mesh.from_fdm_grid(
    nx=40,
    ny=10,
    nz=2,
    dx=5e-9,
    dy=5e-9,
    dz=5e-9,
)

# 2. Material definition
mat = fm.Material.permalloy()

# 3. Author Frozen Spins constraint on the left boundary region (x <= 20 nm)
pinned_left = fm.FrozenSpins(
    region=fm.Box((0.0, 0.0, 0.0), (20e-9, 50e-9, 10e-9)),
    reference=fm.FixedDirection((0.0, 0.0, 1.0)),
    name="pinned_left_contact",
)

# 4. Assemble Problem and Study
study = fm.Study.relaxation(
    algorithm="projected_gradient_bb",
    stopping_criterion={"max_torque": 1.0e-4},
)

problem = fm.Problem(
    world=world,
    mesh=mesh,
    materials={"permalloy": mat},
    constraints=[pinned_left],
    study=study,
)

# 5. Run simulation
sim = fm.Simulation(problem, backend="fem", mode="strict")
# result = sim.run()
