"""Small GPU field-visualization case, based on fdm_cpu_relax_smoke.py.

The geometry, material, initial state and bias field match that CPU example.
This variant explicitly requests strict GPU/double execution and at most ten
accepted steps. It checks the runtime/data path, not scientific convergence.
The model waits for an explicit Compute command in the interactive workspace.
"""

# %% Study and execution intent
import fullmag as fm

study = fm.study("fdm_gpu_field_visualization_10_steps")
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
    algorithm="llg_overdamped", dt=1e-13, tolA=1e-4, max_steps=10,
).tableautosave(
    every_steps=1,
    quantities=["step", "t", "dt", "mx", "my", "mz", "E_total"],
)
study.airbox.visualization(
    show=True, mode="vectors", active_quantity_id="H_demag", wireframe=False,
)
