"""Small interactive FDM fixture for Control Room runtime-control smoke tests."""

import fullmag as fm


study = fm.study("runtime_control_smoke")
study.engine("fdm")
study.device("cpu", precision="double")
study.interactive(True)
study.wait_for_solve(True)
study.cell(4e-9, 4e-9, 5e-9)
study.universe(
    mode="manual",
    size=(80e-9, 32e-9, 5e-9),
    center=(0.0, 0.0, 0.0),
)

strip = study.geometry(
    fm.Box(size=(80e-9, 32e-9, 5e-9), name="strip"),
    name="strip",
)
strip.Ms = 800e3
strip.Aex = 13e-12
strip.alpha = 0.5
strip.m = fm.texture.random(seed=42)

study.solver(dt=1e-13)
study.stages.add_relax(
    algorithm="llg_overdamped",
    max_steps=100_000,
    tol=1e-12,
)
