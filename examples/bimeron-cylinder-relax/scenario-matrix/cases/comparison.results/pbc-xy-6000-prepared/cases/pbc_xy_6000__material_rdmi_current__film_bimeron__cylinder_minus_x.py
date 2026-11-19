"""Standalone Fullmag input generated for the 6000-step XY-periodic material matrix."""

import fullmag as fm

NM = 1e-9
CELL = (2.5 * NM, 2.5 * NM, 2.5 * NM)
CASE_ID = "pbc_xy_6000__material_rdmi_current__film_bimeron__cylinder_minus_x"

study = fm.study("pbc_xy_6000__material_rdmi_current__film_bimeron__cylinder_minus_x")
study.engine("fdm")
study.device("gpu", precision="double")
study.mode("strict")
study.storage(output_dir=CASE_ID + ".zarr", data_format="zarr")
study.universe(
    mode="manual",
    size=(600 * NM, 600 * NM, 65 * NM),
    center=(0.0, 0.0, 27.5 * NM),
    padding=(0.0, 0.0, 0.0),
)
study.cell(*CELL)
study.pbc(x=True, y=True, z=False, demag="truncated_images", images=(10, 10, 0))

film = study.geometry(
    fm.Box(size=(600 * NM, 600 * NM, 10 * NM)),
    name="bimeron_film",
    object_id="bimeron-film",
)
film.Ms = 580000.0
film.Aex = 1.5e-11
film.Ku1 = 663920.0
film.anisU = (1.0, 0.0, 0.0)
film.alpha = 1.0
film.mesh(cell_size=CELL)
film.m = fm.texture.bimeron(
    radius=50 * NM,
    wall_width=4.732 * NM,
    vorticity=-1,
    helicity_rad=0.0,
    background_sign=1,
    plane="xy",
)

cylinder = study.geometry(
    fm.Cylinder(radius=50 * NM, height=30 * NM).translate((0.0, 0.0, 25 * NM)),
    name="upper_cylinder",
    object_id="upper-cylinder",
)
cylinder.Ms = 1300000.0
cylinder.Aex = 1e-11
cylinder.Ku1 = 0.0
cylinder.alpha = 1.0
cylinder.mesh(cell_size=CELL)
cylinder.m = fm.texture.uniform(
    -1.0, 0.0, 0.0,
)

# Rotated interfacial DMI is scoped to the film object only.
study.terms.add(
    fm.RotatedInterfacialDMI(
        D=0.004,
        object_ids=[film.object_id],
    )
)
study.fdm(
    default_cell=CELL,
    demag=fm.FDMDemag(
        strategy="multilayer_convolution",
        mode="three_d",
        common_cell_size=CELL,
        fft_backend="cufft",
    ),
)
study.demag()

# PG-BB minimizes energy; it does not advance physical time or use a fixed time step.
relax = study.stages.add_relax(
    stage_id="joint_relax",
    algorithm="projected_gradient_bb",
    max_steps=6000,
    tolT=1e-5,
)
relax.autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(
            every_steps=100,
            quantities=["step", "mx", "my", "mz", "E_total", "max_torque_T"],
        ),
        fields=[
            fm.FieldAutosave("m", every_steps=1000),
            fm.FieldAutosave("H_demag", every_steps=1000),
        ],
    )
)
