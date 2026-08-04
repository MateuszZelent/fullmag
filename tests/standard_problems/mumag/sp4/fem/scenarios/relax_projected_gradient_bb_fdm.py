"""Zero-field FDM relaxation qualification for NIST µMAG SP4.

This is the FDM counterpart of ``relax_projected_gradient_bb.py`` in this
directory.  It keeps the physical problem and the relaxation observables
identical so the two backends can be tested side by side.

Run headlessly on CPU with::

    just fullmag build=True fdm cpu tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb_fdm.py
"""

import fullmag as fm


study = fm.study("mumag_sp4_fdm_relax_projected_gradient_bb")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.interactive(True)
study.wait_for_solve(True)



study.universe(
    mode="manual",
    size=(500e-9, 125e-9, 3e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.cell(500e-9 / 128.0, 125e-9 / 32.0, 3e-9)

film = study.geometry(
    fm.Box(size=(500e-9, 125e-9, 3e-9), name="film"),
    name="film",
)
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.1, 0.0))

study.demag()
study.stages.add_relax(
    stage_id="relax",
    algorithm="projected_gradient_bb",
    max_steps=100_000,
    tolT=1e-6,
).autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(
            every_steps=10,
            quantities=[
                "step",
                "mx",
                "my",
                "mz",
                "e_ex",
                "e_demag",
                "e_total",
                "max_torque_T",
            ],
        ),
        fields=[],
    )
)
study.stages.add_save_state(
    artifact_name="relaxed_m.zarr",
    format="zarr",
    dataset="m",
)
