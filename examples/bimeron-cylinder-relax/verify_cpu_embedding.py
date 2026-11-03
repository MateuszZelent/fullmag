"""One-step unequal-grid probe for scoped rotated interfacial DMI.

This tiny two-object workload checks authored GPU intent and outputs for an
embedded cylinder with a different native grid. It is not equilibrium or
cross-backend qualification evidence by itself.
"""

# %% Study
import os
from pathlib import Path

import fullmag as fm

NM = 1e-9
CELL = (2.5 * NM, 2.5 * NM, 2.5 * NM)
# Use the managed writable project root, or the script directory locally.
OUTPUT_ROOT = Path(os.environ.get("FULLMAG_PROJECT_STORAGE_ROOT", str(Path(__file__).resolve().parent))) / "bimeron-cylinder-relax-results"
DEVICE = "cpu"

study = fm.study("verify_cpu_embedding")
study.engine("fdm")
study.storage(output_dir=str(OUTPUT_ROOT), data_format="zarr")
study.device(DEVICE, precision="double")
study.mode("strict")
study.universe(
    mode="manual",
    size=(20 * NM, 20 * NM, 17.5 * NM),
    center=(0.0, 0.0, 6.25 * NM),
    padding=(0.0, 0.0, 0.0),
)
study.cell(*CELL)
study.pbc(x=False, y=False, z=False)

# Lower box spans z=-2.5..2.5 nm. Its distinct 8x8x2 native grid is embedded
# with the upper cylinder in a shared 8x8x4 scratch descriptor.
film = study.geometry(
    fm.Box(size=(20 * NM, 20 * NM, 5 * NM)),
    name="lower_film",
    object_id="lower-film",
)
film.Ms = 580000.0
film.Aex = 15e-12
film.Ku1 = 663920.0
film.anisU = (1.0, 0.0, 0.0)
film.alpha = 1.0
film.mesh(cell_size=CELL)
film.m = fm.texture.bimeron(
    radius=5 * NM,
    wall_width=3 * NM,
    vorticity=-1,
    plane="xy",
)

# The centered R5 nm, H10 nm cylinder spans z=5..15 nm: 2.5 nm above the film.
# Its bounding grid is 4x4x4 at the same cell size, with a circular active mask.
cylinder = study.geometry(
    fm.Cylinder(radius=5 * NM, height=10 * NM).translate((0.0, 0.0, 10 * NM)),
    name="upper_cylinder",
    object_id="upper-cylinder",
)
cylinder.Ms = 1000000.0
cylinder.Aex = 10e-12
cylinder.Ku1 = 0.0
cylinder.alpha = 1.0
cylinder.mesh(cell_size=CELL)
cylinder.m = fm.texture.uniform(-1.0, 0.0, 0.0)

study.terms.add(
    fm.RotatedInterfacialDMI(D=0.004, object_ids=[film.object_id])
)
study.fdm(
    default_cell=CELL,
    demag=fm.FDMDemag(
        strategy="multilayer_convolution",
        mode="three_d",
        common_cells=(8, 8, 4),
        fft_backend="rustfft",
    ),
)
study.demag()
study.solver(fix_dt=1e-17, integrator="heun")

# Explicit OutputIR capture provides the CPU reference field samples.
for quantity in ("m", "H_demag", "H_rotated_dmi", "H_eff"):
    study.save(quantity, every=1e-17)

relax = study.stages.add_relax(
    stage_id="embedding_probe",
    algorithm="llg_overdamped",
    solver="heun",
    dt=1e-17,
    relax_alpha=1.0,
    max_steps=1,
    tolT=1e-30,
)
relax.autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(
            every_steps=1,
            quantities=["step", "e_total", "e_rotated_dmi", "max_torque_T"],
        ),
        fields=[
            fm.FieldAutosave("m", every_steps=1),
            fm.FieldAutosave("H_demag", every_steps=1),
            fm.FieldAutosave("H_rotated_dmi", every_steps=1),
            fm.FieldAutosave("H_eff", every_steps=1),
        ],
    )
)

# The runner force-emits terminal m, including when the final step is off
# cadence. This is an observation, not a checkpoint/resume artifact.
