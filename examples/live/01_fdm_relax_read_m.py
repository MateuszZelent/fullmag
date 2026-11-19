"""Connect to a running Fullmag, relax an FDM layer and read ``m`` as numpy.

Live mode (ADR 0068): after ``fm.connect()`` every DSL call below is committed
to the current session of a Docker DEV group, and the Control Room shows each
change. ``fm.relax()`` becomes a runtime command that waits for its result.

Usage, with a DEV group started by ``just docker-dev <checkout> <port>``:
    FULLMAG_URL=http://127.0.0.1:3197 python examples/live/01_fdm_relax_read_m.py

The ``# %%`` cells run one by one in VS Code/Jupyter; the matching notebook is
``01_fdm_relax_read_m.ipynb``.
"""

import os

import numpy as np

import fullmag as fm

# %% Connect: reuse the group's current session (one is created when none exists).
# ``new_session=True`` starts a clean session so the example does not depend on
# whatever the Control Room or a previous script left in the group.
session = fm.connect(os.environ.get("FULLMAG_URL"), new_session=True)
print(session)

# %% Model: each assignment below is one scene revision in the session.
fm.engine("fdm")
fm.device("cpu")
fm.cell(5e-9, 5e-9, 10e-9)
fm.solver(fix_dt=1e-13)  # live LLG stages need an explicit timestep

layer = fm.geometry(fm.Box(200e-9, 100e-9, 10e-9), name="layer")
layer.Ms = 800e3  # saturation magnetisation [A/m]
layer.Aex = 13e-12  # exchange stiffness [J/m]
layer.alpha = 0.5  # strong damping: a short relaxation
layer.m = fm.texture.uniform(1, 1, 0)

# %% Relax: a runtime command; returns when the run has finished.
result = fm.relax(dt=1e-13, tolT=1e-4, max_steps=1_000)
print("relax:", result.status, result.completion_status)

# %% Read the magnetisation back as numpy.
m = fm.field("m")
values = m.to_numpy()  # (point_count, 3), unit vectors
grid = m.as_grid()  # (nz, ny, nx, 3); x varies fastest, as in the FDM engine
print("samples:", values.shape, " grid:", grid.shape)
print("<m> =", values.mean(axis=0))
norms = np.linalg.norm(values, axis=1)
print(f"|m| in [{norms.min():.6f}, {norms.max():.6f}]")

# %% A cut through the layer: the x-profile of m_x along the middle row.
nz, ny, nx, _ = grid.shape
mx_profile = grid[0, ny // 2, :, 0]
print("m_x along x (middle row):", np.round(mx_profile[:: max(1, nx // 8)], 3))

# %% Disconnect; the session and its results stay in the DEV group.
fm.disconnect()
