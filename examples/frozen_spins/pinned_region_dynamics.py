#!/usr/bin/env python3
"""Example: Time-domain magnetization dynamics with frozen spin boundaries.

Simulates precessional switching under an external field pulse with hard-pinned
edges acting as fixed boundary conditions.
"""
from __future__ import annotations

import fullmag as fm

# 1. Geometry and Mesh
world = fm.World(box=fm.Box((0.0, 0.0, 0.0), (100e-9, 50e-9, 5e-9)))
mesh = fm.Mesh.from_fdm_grid(
    nx=20,
    ny=10,
    nz=1,
    dx=5e-9,
    dy=5e-9,
    dz=5e-9,
)

# 2. Material
mat = fm.Material.permalloy()

# 3. Pinned left and right ends
pinned_edges = fm.FrozenSpins(
    region=fm.Box((0.0, 0.0, 0.0), (10e-9, 50e-9, 5e-9)),
    reference=fm.InitialState(),
    name="pinned_boundary",
)

# 4. Time-domain dynamics study
study = fm.Study.dynamics(
    integrator="heun",
    total_time=1.0e-9,
    time_step=1.0e-13,
)

problem = fm.Problem(
    world=world,
    mesh=mesh,
    materials={"permalloy": mat},
    constraints=[pinned_edges],
    study=study,
)

sim = fm.Simulation(problem, backend="fdm", mode="strict")
# result = sim.run()
