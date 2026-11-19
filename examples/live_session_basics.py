"""Drive a running Fullmag instance from plain Python (ADR 0068 live mode).

This is the Fullmag counterpart of a Boris Spintronics ``NetSocks.py`` script:
every line below programs the session of a running Docker DEV group, and the
Control Room shows each change immediately.

Usage (from a host shell, with a DEV group started by ``just docker-dev``):
    FULLMAG_URL=http://127.0.0.1:3197 python examples/live_session_basics.py

The same file also runs unchanged through ``fullmag examples/live_session_basics.py``
(captured into ProblemIR) when the ``fm.connect()`` line is removed; in live
mode it is cell-by-cell friendly, so it can be pasted into Jupyter.
"""

import fullmag as fm

# %% Connect (or rely on FULLMAG_URL).
fm.connect()

# %% Model: each assignment is committed to the session as it happens.
fm.engine("fdm")
fm.device("cpu")
fm.cell(5e-9, 5e-9, 10e-9)
fm.solver(fix_dt=1e-13)    # executable stages need an explicit timestep

layer = fm.geometry(fm.Box(400e-9, 100e-9, 10e-9), name="layer")
layer.Ms = 800e3       # saturation magnetisation [A/m]
layer.Aex = 13e-12     # exchange stiffness [J/m]
layer.alpha = 0.02
layer.m = fm.texture.uniform(1, 0.1, 0)

# %% Relax and read the state back as numpy.
fm.relax(dt=1e-13, tolT=1e-5, max_steps=20_000)
print("relaxed <m> =", fm.m.average())
m = fm.field("m")
if m is not None:
    print("m samples:", m.to_numpy().shape)

# %% Change the field (one transaction for both edits) and run dynamics.
with fm.transaction():
    fm.b_ext(0.02, 0.0, 0.0)
    layer.alpha = 0.01
fm.run(1e-9)
print("after run <m> =", fm.m.average(), " E_total =", float(fm.E_total))

# %% The session as a canonical, editable Fullmag script.
print(fm.export_script())
