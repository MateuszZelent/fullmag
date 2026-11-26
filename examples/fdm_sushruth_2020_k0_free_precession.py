"""Uniform k=0 LLG control using Table I gamma, field and damping.

No antenna, demag or exchange. This is not the experimental Co/Ni sample
or a reproduction of the transmission figures. See physics note 0951.
"""

# %% Explicit execution intent
import math
import fullmag as fm

MU0 = 4e-7 * math.pi
study = fm.study("fdm_sushruth_2020_k0_free_precession")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")

# %% One uniform degree of freedom in SI
study.universe(
    mode="manual", size=(20e-9, 20e-9, 20e-9),
    center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0),
)
study.cell(20e-9, 20e-9, 20e-9)
body = study.geometry(fm.Box(size=(20e-9, 20e-9, 20e-9)), name="k0_control")
body.Ms = 0.89 / MU0
# Required positive material value; exchange is explicitly disabled below.
body.Aex = 13e-12
body.alpha = 0.01
body.m = fm.texture.uniform(0.001, 0.0, math.sqrt(1.0 - 1e-6))

# %% Constant effective field and bounded time-domain control
study.exchange(enabled=False)
study.demag(enabled=False)
study.b_ext(0.0, 0.0, 0.25)
study.solver(fix_dt=1e-13, integrator="rk4", gamma=MU0 * 2 * math.pi * 30e9)
study.tableautosave(1e-12, quantities=["step", "time", "dt", "mx", "my", "mz"])
study.stages.add_run(until=2e-9, stage_id="k0_precession")
