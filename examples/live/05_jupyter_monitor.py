"""Watch a live Fullmag session from a Jupyter notebook.

``fullmag.live.jupyter.monitor()`` subscribes to the session's
``scalar.sample`` events and keeps one cell output up to date (a matplotlib
plot, or a text table without matplotlib). Outside IPython it only collects
the samples, so this file also runs as a plain script. Install the extras
with ``pip install fullmag[jupyter]`` (IPython and matplotlib).

API builds older than PR #304 did not emit ``scalar.sample`` for accepted
Docker DEV runs, so the monitor may stay empty there; the last cells therefore
also plot ``m`` read from the field route, which works on every lane.

Usage: open ``05_jupyter_monitor.ipynb`` with ``FULLMAG_URL`` set, or
    FULLMAG_URL=http://127.0.0.1:3197 python examples/live/05_jupyter_monitor.py
"""

import os

import fullmag as fm
from fullmag.live import jupyter

# %% Connect and build a small FDM model.
fm.connect(os.environ.get("FULLMAG_URL"), new_session=True)
fm.engine("fdm")
fm.device("cpu")
fm.cell(5e-9, 5e-9, 5e-9)
fm.solver(fix_dt=1e-13)
disk = fm.geometry(fm.Cylinder(radius=60e-9, height=5e-9), name="disk")
disk.Ms, disk.Aex, disk.alpha = 800e3, 13e-12, 0.5
disk.m = fm.texture.vortex()

# %% Start the monitor in this cell: it redraws as scalar samples arrive.
monitor = jupyter.monitor(("mx", "my", "mz"), x_column="time")

# %% Relax and run; the monitor output above updates while they execute.
fm.relax(dt=1e-13, tolT=1e-4, max_steps=1_000)
fm.b_ext(0.02, 0.0, 0.0)
fm.run(0.2e-9)

# %% Stop the monitor and look at what it collected.
monitor.stop()
print(f"monitor collected {len(monitor.samples)} scalar samples")

# %% The vortex state from the field route, as an in-plane m_z map.
grid = fm.field("m").as_grid()  # (nz, ny, nx, 3)
mz = grid[0, :, :, 2]
print("m_z map:", mz.shape, f"core m_z = {mz.max():+.3f}")
try:
    import matplotlib.pyplot as plt
except ImportError:
    plt = None
if plt is not None:
    figure, axis = plt.subplots(figsize=(4, 4))
    image = axis.imshow(mz, origin="lower", cmap="RdBu_r", vmin=-1, vmax=1)
    figure.colorbar(image, ax=axis, label="m_z")
    axis.set_title("vortex core")
    if os.environ.get("MPLBACKEND", "").lower() != "agg":
        plt.show()
    plt.close(figure)

# %% Disconnect.
fm.disconnect()
