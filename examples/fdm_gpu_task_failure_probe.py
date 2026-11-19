"""Diagnostic task-failure fixture; not a physics qualification example.

The controller starts this case only for an explicit worker-exit check and
signals its exact run-bound worker. The tiny dt keeps it away from convergence
until that controlled termination. If no signal arrives, the independent
10,000-step cap still terminates the diagnostic run. Never substitute this for the ten-step
visualization example or automatically restart it after failure.
"""

# %% Study and execution intent
import fullmag as fm

study = fm.study("fdm_gpu_task_failure_probe")
study.engine("fdm")
study.device("gpu", precision="double")
study.mode("strict")
study.interactive(True)
study.wait_for_solve(True)

# %% Grid, geometry and material in SI
study.universe(
    mode="manual",
    size=(80e-9, 160e-9, 10e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.cell(5e-9, 5e-9, 5e-9)
film = study.geometry(fm.Box(size=(40e-9, 120e-9, 10e-9)), name="smoke_box")
film.Ms = 752000.0
film.Aex = 1.55e-11
film.alpha = 0.1
film.m = fm.texture.uniform(0.0, 1.0, 0.0)

# %% Interactions, bounded stage and display
study.demag()
study.b_ext(0.0, 0.0, 1e-3)
study.solver(fix_dt=1e-13, integrator="heun", g=2.115)
study.stages.add_relax(
    algorithm="llg_overdamped", dt=1e-18, tolA=1e-300, max_steps=10000,
).tableautosave(
    every_steps=1000,
    quantities=["step", "t", "dt", "mx", "my", "mz", "E_total"],
)
study.airbox.visualization(
    show=True, mode="vectors", active_quantity_id="H_demag", wireframe=False,
)
