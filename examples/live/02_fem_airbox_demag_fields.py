"""FEM with an Airbox: relax a magnetic box, then read H_demag and H_eff in the air.

The study universe is the Airbox: the shared-domain mesh covers the magnet and
the surrounding air, and the Poisson-Robin demag potential is solved on both.
After the run the session publishes the fields on that mesh, so the stray
field outside the magnet can be read with ``scope_kind="airbox"``.

The universe (Airbox) is configured through ``fm.study(...)``; the study
builder drives the same live session as the flat ``fm.*`` calls.

Usage, with a DEV group started by ``just docker-dev <checkout> <port>``:
    FULLMAG_URL=http://127.0.0.1:3197 python examples/live/02_fem_airbox_demag_fields.py
"""

import os

import numpy as np

import fullmag as fm

# %% Connect with a fresh FEM session.
session = fm.connect(os.environ.get("FULLMAG_URL"), new_session=True, backend="fem")
print(session)

# %% Model: a 120 x 80 x 20 nm box inside a 240 x 200 x 120 nm Airbox.
study = fm.study("live_fem_airbox")
study.engine("fem")
study.device("cpu", precision="double")
study.universe(
    mode="manual",
    size=(240e-9, 200e-9, 120e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(maximum_element_size=60e-9)  # coarse air mesh

body = study.geometry(fm.Box(120e-9, 80e-9, 20e-9), name="body")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.5
body.m = fm.texture.uniform(1, 0.2, 0)
body.mesh(maximum_element_size=20e-9, order=1)

study.demag(realization="poisson_robin")  # demag through the Airbox
study.b_ext(0.0, 0.0, 0.0)
study.solver(dt=1e-13)

# %% Relax: the server meshes the domain, prepares the FEM spaces and runs.
result = study.relax(algorithm="projected_gradient_bb", tolA=1e-3, max_steps=200)
print("relax:", result.status, result.completion_status)

# %% Magnetisation on the magnet nodes.
m = fm.field("m")
print("m:", m.to_numpy().shape, " <m> =", m.to_numpy().mean(axis=0))

# %% H_demag and H_eff restricted to the Airbox nodes (SI: A/m).
h_demag_air = fm.field("H_demag", scope_kind="airbox")
h_eff_air = fm.field("H_eff", scope_kind="airbox")
for name, vector in (("H_demag", h_demag_air), ("H_eff", h_eff_air)):
    values = vector.to_numpy()
    magnitude = np.linalg.norm(values, axis=1)
    print(
        f"{name} in the Airbox: {vector.point_count} nodes ({vector.indexing}), "
        f"|H| max {magnitude.max():.4g} A/m, mean {magnitude.mean():.4g} A/m"
    )

# %% The same field over the whole domain, for comparison.
h_demag = fm.field("H_demag")
print("H_demag full domain:", h_demag.point_count, "points;",
      "max |H| =", f"{np.linalg.norm(h_demag.to_numpy(), axis=1).max():.4g} A/m")

# %% Disconnect.
fm.disconnect()
