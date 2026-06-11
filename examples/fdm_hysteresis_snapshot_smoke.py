"""Small FDM CPU hysteresis smoke test with saved replay snapshots."""

import fullmag as fm


study = fm.study("fdm_hysteresis_snapshot_smoke")

study.engine("fdm")
study.device("cpu", precision="double")
study.universe(
    mode="manual",
    size=(60e-9, 100e-9, 10e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.cell(10e-9, 10e-9, 10e-9)

film = study.geometry(
    fm.Box(size=(40e-9, 80e-9, 10e-9), name="smoke_film"),
    name="smoke_film",
)
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.5
film.m = fm.texture.uniform(0.0, 1.0, 0.0)

study.solver(dt=1e-13)
study.tableautosave(1e-13, quantities=["time", "step", "mx", "my", "mz", "E_total"])
study.stages.add_hysteresis_sweep(
    field_values_mT=[50.0, 0.0, -50.0],
    orientation=fm.FieldOrientation.preset("in_plane_y"),
    measurement_axis="field_axis",
    initial_protocol="as_authored",
    branch_mode="major_loop",
    settle_pipeline=fm.SettlePipeline([
        fm.RelaxStep(
            method="llg_overdamped",
            alpha=1.0,
            torque_tolerance=1e-3,
            max_steps=4,
            on_non_convergence="continue_with_warning",
        )
    ]),
    storage=fm.HysteresisStorage(
        scalar_history=True,
        magnetization="every_n",
        every_n=1,
        key_events=False,
    ),
)
