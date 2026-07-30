"""Lightweight FEM fixture for the viewport-3d mixed-target smoke proof.

This is intentionally small and box-based.  It exercises the production
viewport data path with three magnetic targets plus an airbox without depending
on the heavier CoFeB ring meshing case.

Run with:
    fullmag --dev -i examples/viewport_3d_mixed_targets_smoke.py
"""

from __future__ import annotations

import os

import fullmag as fm


NM = 1e-9
MAX_STEPS = int(os.environ.get("FULLMAG_VIEWPORT3D_MIXED_TARGET_MAX_STEPS", "50"))

TARGET_SIZE = (80 * NM, 40 * NM, 20 * NM)
TARGET_SPACING = 140 * NM
AIRBOX_SIZE = (520 * NM, 260 * NM, 180 * NM)


study = fm.study("viewport_3d_mixed_targets_smoke")

study.engine("fem")
study.device("gpu", precision="double")
study.interactive(True)
study.wait_for_solve(True)

study.universe(
    mode="auto",
    size=AIRBOX_SIZE,
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    maximum_element_size=80 * NM,
    minimum_element_size=20 * NM,
    maximum_element_growth_rate=1.5,
    grading="geometric",
)
study.airbox.visualization(show=True, mode="vectors", active_quantity_id="h_eff", wireframe=False)

study.objects.mesh.defaults(
    algorithm_2d=6,
    algorithm_3d=10,
    maximum_element_growth_rate=1.4,
    smoothing_steps=1,
    compute_quality=False,
    per_element_quality=False,
)


def add_target(name: str, x_center: float, magnetization: tuple[float, float, float]) -> object:
    target = study.geometry(
        fm.Box(size=TARGET_SIZE, name=name).translate((x_center, 0.0, 0.0)),
        name=name,
    )
    target.Ms = 800e3
    target.Aex = 13e-12
    target.alpha = 0.1
    target.Ku1 = 0.0
    target.m = fm.texture.uniform(*magnetization)
    target.mesh(maximum_element_size=25 * NM, minimum_element_size=10 * NM, order=1)
    target.visualization(show=True, mode="surface", active_quantity_id="m")
    return target


add_target("permalloy_layer", -TARGET_SPACING, (1.0, 0.0, 0.0))
add_target("cofeb_top_ring", 0.0, (0.0, 1.0, 0.0))
add_target("cofeb_bottom_ring", TARGET_SPACING, (0.0, 0.0, 1.0))

study.exchange()
study.demag(realization="poisson_robin")
study.build_domain_mesh()

study.solver(dt=1e-15, integrator="heun", g=2.115)
study.save("m", every=1e-12)
study.tableautosave(1e-12, quantities=["t", "step", "mx", "my", "mz", "E_total"])

study.stages.add_relax(
    algorithm="llg_overdamped",
    solver="rk45",
    max_error=1e-4,
    dt_min=1e-15,
    dt_max=1e-13,
    max_steps=MAX_STEPS,
    tolA=1e-4,
)
