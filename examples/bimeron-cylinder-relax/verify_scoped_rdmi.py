"""Bounded public runtime probe: selected lower magnet, excluded upper magnet.

One accepted relaxation step with native field output. This is a qualification
workload, not the full bimeron/cylinder experiment or equilibrium evidence.
"""
import os
from pathlib import Path
import fullmag as fm

OUTPUT_ROOT = Path(os.environ.get("FULLMAG_PROJECT_STORAGE_ROOT", str(Path(__file__).resolve().parent))) / "bimeron-cylinder-relax-results"

study = fm.study("verify_scoped_rdmi")
study.engine("fdm")
study.storage(output_dir=str(OUTPUT_ROOT), data_format="zarr")
study.device("gpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(20e-9, 20e-9, 15e-9), center=(0, 0, 5e-9), padding=(0, 0, 0))
study.cell(2.5e-9, 2.5e-9, 2.5e-9)
film = study.geometry(fm.Box(size=(20e-9, 20e-9, 5e-9)), name="selected", object_id="selected")
upper = study.geometry(fm.Box(size=(20e-9, 20e-9, 5e-9)).translate((0, 0, 10e-9)), name="excluded", object_id="excluded")
for body in (film, upper):
    body.Ms = 580000.0
    body.Aex = 15e-12
    body.alpha = 1.0
    body.m = fm.texture.bimeron(radius=5e-9, wall_width=3e-9, vorticity=-1, plane="xy")
    body.mesh(cell_size=(2.5e-9, 2.5e-9, 2.5e-9))
study.terms.add(fm.RotatedInterfacialDMI(D=float(os.environ.get("FULLMAG_RDMI_PROBE_D", "0.004")), object_ids=[film.object_id]))
# Both 20x20x5 nm boxes have native grids of 8x8x2 at 2.5 nm. The 5 nm
# separation is represented by their distinct z origins; it does not add cells
# to either native layer grid. This explicit common scratch shape matches each
# native descriptor while preserving both separate geometries.
study.fdm(
    default_cell=(2.5e-9, 2.5e-9, 2.5e-9),
    demag=fm.FDMDemag(
        strategy="multilayer_convolution",
        mode="three_d",
        common_cells=(8, 8, 2),
        fft_backend="cufft",
    ),
)
study.demag()
study.solver(fix_dt=1e-15, integrator="heun")
relax = study.stages.add_relax(stage_id="probe", algorithm="llg_overdamped", solver="heun", dt=1e-15, relax_alpha=1.0, max_steps=1, tolT=1e-12)
# The runner force-emits terminal m; this is an observation, not a
# checkpoint/resume artifact.
relax.autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(
            every_steps=1,
            quantities=["step", "e_total", "e_rotated_dmi", "max_torque_T"],
        ),
        fields=[
            fm.FieldAutosave("m", every_steps=2),
            fm.FieldAutosave("H_rotated_dmi", every_steps=1),
        ],
    )
)
