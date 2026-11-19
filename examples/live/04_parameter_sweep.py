"""Sweep an applied field across one or more running Fullmag groups.

``fullmag.live.sweep.sweep`` (also ``fm.sweep``) runs one worker thread per
Docker DEV group. Every group owns one current session; a worker resets its
world before each point, so ``point()`` builds the complete model with the
ordinary DSL. Results come back in point order with the group and run ID.

One group evaluates the points one after another; more groups (each started by
its own ``just docker-dev <checkout> <port>``) evaluate them in parallel.

Usage:
    FULLMAG_URL=http://127.0.0.1:3197 python examples/live/04_parameter_sweep.py
    FULLMAG_SWEEP_GROUPS=http://127.0.0.1:3197,http://127.0.0.1:3198 \
        python examples/live/04_parameter_sweep.py
"""

import os

import fullmag as fm
from fullmag.live.sweep import SweepError, sweep

# %% Groups: a comma-separated list, defaulting to the single FULLMAG_URL group.
default_group = os.environ.get("FULLMAG_URL") or "http://127.0.0.1:3197"
groups = [url.strip() for url in os.environ.get("FULLMAG_SWEEP_GROUPS", default_group).split(",") if url.strip()]
print("groups:", groups)


# %% One sweep point: build the model, relax in the field B_y, return <m>.
def point(b_y):
    fm.engine("fdm")
    fm.device("cpu")
    fm.cell(5e-9, 5e-9, 10e-9)
    fm.solver(fix_dt=1e-13)
    layer = fm.geometry(fm.Box(200e-9, 100e-9, 10e-9), name="layer")
    layer.Ms, layer.Aex, layer.alpha = 800e3, 13e-12, 0.5
    layer.m = fm.texture.uniform(1, 0, 0)
    fm.b_ext(0.0, b_y, 0.0)
    fm.relax(dt=1e-13, tolT=1e-4, max_steps=1_000)
    return fm.m.average()


# %% Run the sweep: B_y = 0 ... 60 mT, transverse to the long axis.
fields_t = [0.0, 0.02, 0.04, 0.06]
try:
    results = sweep(point, groups=groups, b_y=fields_t)
except SweepError as error:
    results = error.results  # every point, failed ones carry .error
    print(error)

# %% Results in point order.
for result in results:
    status = "ok" if result.ok else f"failed: {result.error}"
    mean = ", ".join(f"{value:+.4f}" for value in result.value) if result.ok else "-"
    print(f"B_y = {result.point['b_y'] * 1e3:5.1f} mT  <m> = ({mean})  "
          f"group {result.group}  run {result.run_id}  {status}")
