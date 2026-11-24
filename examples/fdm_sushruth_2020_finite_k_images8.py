"""Single finite-k standing-wave LLG control; no antenna or PMA sample.

Uniform-thickness film, truncated XY images and open Z.
Physics and qualification scope: docs/physics/0951, finite-k control.
"""
# %% Explicit execution intent and SI parameters
import math
import fullmag as fm

MU0 = 4e-7 * math.pi
LX = LY = 1.28e-6
THICKNESS = 20e-9
NX, NY, NZ = 128, 1, 1
IMAGES = 8

study = fm.study("fdm_sushruth_2020_finite_k_images8")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")

# %% Uniform film: ky=0 and uniform magnetization through thickness
study.universe(
    mode="manual", size=(LX, LY, THICKNESS),
    center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0),
)
study.cell(LX / NX, LY / NY, THICKNESS / NZ)
study.pbc(
    x=True, y=True, z=False, demag="truncated_images",
    images=(IMAGES, IMAGES, 0),
)
study.boundary_correction("none")
body = study.geometry(fm.Box(size=(LX, LY, THICKNESS)), name="uniform_film")
body.Ms = 0.89 / MU0
body.Aex = 13e-12  # Required positive material value; exchange disabled below.
body.alpha = 0.01
# Explicit sampled input: epsilon=1e-4, one cosine period, x-major order.
body.m.loadfile("fdm_sushruth_2020_finite_k_initial_m.json")

# %% Effective 0.25 T only in the infinite no-PMA film limit
study.exchange(enabled=False)
study.demag(enabled=True)
study.b_ext(0.0, 0.0, 1.14)
study.solver(fix_dt=0.5e-12, integrator="rk4", gamma=MU0 * math.tau * 30e9)
study.tableautosave(2e-12, quantities=["step", "time", "dt", "mx", "my", "mz"])
study.save("m", every=2e-12)
study.save("H_demag", every=2e-12)
study.stages.add_run(until=3e-9, stage_id="finite_k_precession").autosave(
    fm.StageAutosave(
        target="state", layout="continuous", format="zarr",
        table=fm.TableAutosave(
            t_sampl=2e-12, quantities=["step", "t", "dt", "mx", "my", "mz"],
        ),
        fields=[
            fm.FieldAutosave("m", every=2e-12),
            fm.FieldAutosave("H_demag", every=2e-12),
        ],
    ),
)
