"""Five-step GPU smoke test for a periodic film with a smaller centered dot."""

import os
from pathlib import Path

import fullmag as fm

study = fm.study("verify_multilayer_bb_periodic_xy_gpu")
study.engine("fdm")
study.device("gpu", precision="double")
study.mode("strict")
storage = Path(os.environ.get("FULLMAG_PROJECT_STORAGE_ROOT", Path(__file__).parent))
study.storage(output_dir=str(storage / "bb-periodic-xy-qualification"), data_format="zarr")

cell = (2.5e-9,) * 3
study.cell(*cell)
study.universe(mode="manual", size=(20e-9, 20e-9, 20e-9), center=(0, 0, 7.5e-9))
study.pbc(x=True, y=True, z=False, demag="truncated_images", images=(2, 2, 0))

film = study.geometry(fm.Box(size=(20e-9, 20e-9, 5e-9)), name="film", object_id="film")
dot = study.geometry(
    fm.Cylinder(radius=5e-9, height=10e-9).translate((0, 0, 12.5e-9)),
    name="dot",
    object_id="dot",
)
for obj in (film, dot):
    obj.mesh(cell_size=cell)
    obj.alpha = 1.0
film.Ms = 580_000.0
film.Aex = 15e-12
film.Ku1 = 663_920.0
film.anisU = (1.0, 0.0, 0.0)
film.m = fm.texture.bimeron(radius=5e-9, wall_width=3e-9, vorticity=-1, plane="xy")
dot.Ms = 1_000_000.0
dot.Aex = 10e-12
dot.m = fm.texture.uniform(-1.0, 0.0, 0.0)
study.terms.add(fm.RotatedInterfacialDMI(D=0.004, object_ids=[film.object_id]))
study.fdm(
    default_cell=cell,
    demag=fm.FDMDemag(
        strategy="multilayer_convolution",
        mode="three_d",
        common_cell_size=cell,
        fft_backend="cufft",
    ),
)
study.demag()
relax = study.stages.add_relax(
    stage_id="bb_periodic_xy", algorithm="projected_gradient_bb", max_steps=5, tolT=1e-12
)
relax.autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(every_steps=1, quantities=["step", "E_total", "max_torque_T"]),
        fields=[
            fm.FieldAutosave(quantity, every_steps=1)
            for quantity in ("m", "H_demag", "H_ex", "H_rotated_dmi")
        ],
    )
)
