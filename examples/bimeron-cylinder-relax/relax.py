"""Single joint relaxation: a bimeron film and an antiparallel cylinder.

Requires object-scoped RotatedInterfacialDMI; legacy runtimes reject the term
rather than running a different Hamiltonian. No radius sweep or frozen spins.
The 2.5 nm grid is a preliminary discretization, not a convergence claim.
"""

# %% Study
import os
from pathlib import Path

import fullmag as fm

NM = 1e-9
CELL = (2.5 * NM, 2.5 * NM, 2.5 * NM)
# Use the managed writable project root, or the script directory locally.
OUTPUT_ROOT = Path(os.environ.get("FULLMAG_PROJECT_STORAGE_ROOT", str(Path(__file__).resolve().parent))) / "bimeron-cylinder-relax-bb-gradient-results"

study = fm.study("bimeron_film_upper_cylinder_relax")
study.engine("fdm")
study.storage(output_dir=str(OUTPUT_ROOT), data_format="zarr")
study.device("gpu", precision="double")
study.mode("strict")
study.universe(
    mode="manual",
    size=(600 * NM, 600 * NM, 65 * NM),
    center=(0.0, 0.0, 27.5 * NM),
    padding=(0.0, 0.0, 0.0),
)
study.cell(*CELL)
# Adaptive time integration for LLG stages. The BB relaxation below instead
# adapts its minimization step through BB updates and Armijo line search.
study.solver(dt_initial=1e-14, max_err=1e-6, integrator="rk23")

# Film spans z=-5..+5 nm. Material comes from the historical formula-guided
# R50 experiment; the 600x600x10 nm geometry follows Julia's film dimensions.
film = study.geometry(
    fm.Box(size=(600 * NM, 600 * NM, 10 * NM)), name="bimeron_film", object_id="bimeron-film"
)
film.Ms = 580000.0
film.Aex = 15e-12
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

# Cylinder spans z=10..60 nm: a 5 nm surface-to-surface gap. Its initial
# magnetization is opposite to the film BACKGROUND, not its central core.
cylinder = study.geometry(
    fm.Cylinder(radius=50 * NM, height=50 * NM).translate((0, 0, 35 * NM)),
    name="upper_cylinder", object_id="upper-cylinder",
)
cylinder.Ms = 1000000.0
cylinder.Aex = 10e-12
cylinder.Ku1 = 0.0
cylinder.alpha = 1.0
cylinder.mesh(cell_size=CELL)
cylinder.m = fm.texture.uniform(-1.0, 0.0, 0.0)

# %% Object-scoped DMI: the upper cylinder has no DMI.
study.terms.add(fm.RotatedInterfacialDMI(D=0.004, object_ids=[film.object_id]))

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
# Finite geometry and its full demagnetizing field; no extra shape anisotropy,
# no artificial zero padding of a separately prescribed external field,
# no PBC, no frozen spins, no external drive and no inter-body exchange.
relax = study.stages.add_relax(
    stage_id="joint_relax",
    algorithm="projected_gradient_bb",
    max_steps=100000,
    tolT=1e-5,
)
# PG-BB changes both objects together and does not advance physical time.
# The runner force-emits terminal m even off cadence; this is an observation,
# not a checkpoint/resume artifact.
relax.autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(
            every_steps=100,
            quantities=["step", "t", "mx", "my", "mz", "E_total", "max_torque_T"],
        ),
        fields=[fm.FieldAutosave("m", every_steps=5000)],
    )
)
