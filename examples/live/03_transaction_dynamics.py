"""Edit a live model in one transaction and run magnetisation dynamics.

The script relaxes a Permalloy-like layer along +x, then applies a field along
-x and lowers the damping in one ``fm.transaction()`` (one scene revision for
both edits), runs LLG dynamics, and finally steps the run in chunks until the
average m_x has reversed. Each command continues from the final state of the
previous one when the discretisation is unchanged.

In Docker DEV, edit the model between commands: ``pause``/``skip`` and
``fm.paused()`` are rejected there (``UnsupportedCapabilityError``).

Usage, with a DEV group started by ``just docker-dev <checkout> <port>``:
    FULLMAG_URL=http://127.0.0.1:3197 python examples/live/03_transaction_dynamics.py
"""

import os

import fullmag as fm

# %% Connect and count realtime events while the script runs.
fm.connect(os.environ.get("FULLMAG_URL"), new_session=True)
events = []
subscription = fm.on("*", lambda event: events.append(event.type))

# %% Model: a 200 x 50 x 5 nm strip with uniform m along +x.
fm.engine("fdm")
fm.device("cpu")
fm.cell(5e-9, 5e-9, 5e-9)
fm.solver(fix_dt=1e-13)

strip = fm.geometry(fm.Box(200e-9, 50e-9, 5e-9), name="strip")
strip.Ms = 800e3
strip.Aex = 13e-12
strip.alpha = 0.5
strip.m = fm.texture.uniform(1, 0.05, 0)

# %% Relax the initial state.
fm.relax(dt=1e-13, tolT=1e-4, max_steps=1_000)
print("relaxed <m> =", fm.m.average())

# %% One transaction: reverse field and low damping become one revision.
with fm.transaction():
    fm.b_ext(-0.1, 0.0, 0.0)  # 100 mT against the magnetisation
    strip.alpha = 0.02

# %% LLG dynamics for 0.2 ns, continuing from the relaxed state.
run = fm.run(0.2e-9)
print("run:", run.status, " <m> =", fm.m.average())

# %% Keep running in 0.2 ns chunks until <m_x> < 0 (at most 2 ns in total).
fm.run_until(lambda step: step.mx < 0.0, chunk_time=0.2e-9, max_time=2e-9)
print("after run_until <m> =", fm.m.average())

# %% The executed session as a canonical, editable Fullmag script.
subscription.cancel()
print(f"received {len(events)} realtime events")
print(fm.export_script())
fm.disconnect()
