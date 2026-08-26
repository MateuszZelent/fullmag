"""Managed reduced periodic-antidot relax-to-run qualification fixture."""

from pathlib import Path

import fullmag as fm


ASSET = Path(__file__).with_name("assets") / "fem_periodic_antidot_llg_qualification.mesh.json"

study = fm.study("fem_periodic_antidot_llg_qualification")
study.engine("fem")
study.device("gpu", precision="double")
study.universe(
    mode="manual",
    size=(80e-9, 80e-9, 72e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.pbc(x=True, y=True, demag="periodic_airbox_k0")
film = fm.Box(size=(80e-9, 80e-9, 8e-9), name="periodic_antidot_base")
hole = fm.Cylinder(radius=10e-9, height=8e-9, name="central_hole")
body = study.geometry(film - hole, name="periodic_antidot_film")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 10.0
body.m = fm.init.UniformMagnetization((1.0, 0.02, 0.0))
hole_transition = body.add_region(
    "hole_transition_refinement",
    fm.Cylinder(radius=17.2e-9, height=8e-9, name="hole_transition_refinement"),
    priority=10,
    realization_policy="conformal",
)
hole_transition.mesh(
    minimum_element_size=6e-9,
    maximum_element_size=16e-9,
    transition_distance=64e-9,
    order=1,
)
study.domain_mesh(
    ASSET,
    region_markers={"periodic_antidot_film": 1},
    object_region_markers={"periodic_antidot_film:r1": 2},
)

study.b_ext(10e-3, 0.0, 0.0)
study.demag(realization="poisson_robin")
study.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=1e-12,
    max_iterations=500,
)
study.save("m", every=1e-15)
study.save("H_demag", every=1e-15)
study.save("demag_phi", every=1e-15)
study.stages.add_minimize(
    stage_id="relax",
    method="bb",
    max_steps=500,
    tolA=5.0e2,
)
study.solver(
    integrator="rk45",
    dt_initial=1e-15,
    dt_min=1e-16,
    dt_max=1e-14,
    max_err=1e-6,
    g=2.115,
)
study.stages.add_run(until=1e-15, stage_id="run-after-relax")
