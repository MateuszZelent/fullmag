"""Permalloy 300 nm × 1000 nm × 10 nm box relaxation (FDM).

FDM study with uniform +y initial magnetization, no external field.
"""

import fullmag as fm


study = fm.study("permalloy_box_relax_300x1000x10nm_fdm")

# Engine
study.engine("fdm")
study.device("cpu", precision="double")

# FDM grid and simulation domain (box fits in this manual universe; keep thin-z thickness).
study.universe(
    mode="manual",
    size=(400e-9, 1100e-9, 20e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.cell(2.5e-9, 2.5e-9, 2.5e-9)

# Geometry: 300 × 1000 × 10 nm permalloy film
layer = study.geometry(
    fm.Box(size=(300e-9, 1000e-9, 10e-9), name="permalloy_box"),
    name="permalloy_box",
)
layer.Ms = 752000.0
layer.Aex = 1.55e-11
layer.alpha = 0.1
layer.m = fm.texture.uniform(0.0, 1.0, 0.0)

# Solver / run setup
study.demag(realization="poisson_robin")
study.solver(dt=1e-13, g=2.115)
study.tableautosave(1e-12, quantities=["time", "step", "mx", "my", "mz", "E_total"])
study.stages.add_relax(algorithm="llg_overdamped", tol=1e-4, max_steps=1000)
