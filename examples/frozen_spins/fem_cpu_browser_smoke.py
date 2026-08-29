"""Disposable FEM CPU browser fixture for the Frozen Spins quantity gate."""

import fullmag as fm


NM = 1e-9

study = fm.study("frozen_spins_fem_cpu_browser_smoke")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.interactive(True)
study.wait_for_solve(True)
study.universe(
    mode="auto",
    size=(100 * NM, 80 * NM, 60 * NM),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=10 * NM,
    maximum_element_size=30 * NM,
)

film = study.geometry(
    fm.Box(size=(60 * NM, 40 * NM, 20 * NM), name="frozen_fem_smoke_box"),
    name="frozen_fem_smoke_box",
    object_id="frozen_fem_smoke_box",
)
film.Ms = 752000.0
film.Aex = 1.55e-11
film.alpha = 0.1
film.m = fm.texture.uniform(0.0, 1.0, 0.0)
film.mesh(
    minimum_element_size=10 * NM,
    maximum_element_size=20 * NM,
    order=1,
)

pinned_edge = film.add_region(
    "Pinned edge",
    fm.Box(size=(20 * NM, 40 * NM, 20 * NM)).translate((-20 * NM, 0.0, 0.0)),
    region_id="pinned_edge",
)
pinned_edge.freeze_spins(
    id="pinned_edge_frozen",
    name="Pinned edge",
)

study.exchange()
study.demag(enabled=False)
study.b_ext(0.0, 0.0, 1e-3)
study.build_domain_mesh()
study.solver(dt=1e-13, integrator="heun", g=2.115)
study.stages.add_relax(
    algorithm="llg_overdamped",
    dt=1e-13,
    tolA=1e-30,
    max_steps=2,
).tableautosave(
    every_steps=1,
    quantities=["step", "t", "dt", "mx", "my", "mz", "E_total"],
)
