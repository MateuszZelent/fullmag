"""Disposable FDM CPU browser fixture for the Frozen Spins quantity gate."""

import fullmag as fm


study = fm.study("frozen_spins_fdm_cpu_browser_smoke")
study.engine("fdm")
study.device("cpu", precision="double")
study.interactive(True)
study.wait_for_solve(True)
study.universe(
    mode="manual",
    size=(80e-9, 160e-9, 10e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.cell(5e-9, 5e-9, 5e-9)

film = study.geometry(
    fm.Box(size=(40e-9, 120e-9, 10e-9), name="frozen_smoke_box"),
    name="frozen_smoke_box",
    object_id="frozen_smoke_box",
)
film.Ms = 752000.0
film.Aex = 1.55e-11
film.alpha = 0.1
film.m = fm.texture.uniform(0.0, 1.0, 0.0)

pinned_edge = film.add_region(
    "Pinned edge",
    fm.Box(size=(10e-9, 120e-9, 10e-9)).translate((-15e-9, 0.0, 0.0)),
    region_id="pinned_edge",
)
pinned_edge.freeze_spins(
    id="pinned_edge_frozen",
    name="Pinned edge",
)

study.exchange()
study.b_ext(0.0, 0.0, 1e-3)
study.solver(fix_dt=1e-13, g=2.115)
study.stages.add_relax(
    algorithm="llg_overdamped",
    dt=1e-13,
    tolA=1e-4,
    max_steps=4,
).tableautosave(
    every_steps=1,
    quantities=["step", "t", "dt", "mx", "my", "mz", "E_total"],
)
