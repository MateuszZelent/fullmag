"""Bounded strict GPU/double multilayer field-visualization case.

Two separated boxes use the material and bias of fdm_cpu_relax_smoke.py.
Equal 5 nm cells and explicit three_d convolution select the supported native
CUDA multilayer contract rather than the legacy two_d_stack example.
At most ten fixed-step Heun relaxation steps are requested explicitly. This is a runtime
and field-indexing case, not a convergence or scientific qualification claim.
"""

# %% Study and execution intent
import fullmag as fm

study = fm.study("fdm_gpu_multilayer_field_visualization_10_steps")
study.engine("fdm")
study.device("gpu", precision="double")
study.mode("strict")
study.interactive(True)
study.wait_for_solve(True)

# %% Shared convolution grid and independent magnetic bodies in SI
study.universe(
    mode="manual",
    size=(80e-9, 160e-9, 30e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.cell(5e-9, 5e-9, 5e-9)
lower = study.geometry(
    fm.Box(size=(40e-9, 120e-9, 10e-9)).translate((0.0, 0.0, -10e-9)),
    name="lower_layer",
)
upper = study.geometry(
    fm.Box(size=(40e-9, 120e-9, 10e-9)).translate((0.0, 0.0, 10e-9)),
    name="upper_layer",
)
for body in (lower, upper):
    body.Ms = 752000.0
    body.Aex = 1.55e-11
    body.alpha = 0.1
    body.mesh(cell_size=(5e-9, 5e-9, 5e-9))
lower.m = fm.texture.uniform(0.0, 1.0, 0.0)
upper.m = fm.texture.uniform(0.0, -1.0, 0.0)
study.fdm(
    default_cell=(5e-9, 5e-9, 5e-9),
    demag=fm.FDMDemag(
        strategy="multilayer_convolution", mode="three_d",
        common_cell_size=(5e-9, 5e-9, 5e-9), fft_backend="cufft",
    ),
)

# %% Interactions, bounded stage and display
study.demag()
study.b_ext(0.0, 0.0, 1e-3)
study.solver(fix_dt=1e-13, integrator="heun", g=2.115)
study.stages.add_relax(
    algorithm="llg_overdamped", solver="heun", dt=1e-13, tolA=1e-4, max_steps=10,
).tableautosave(
    every_steps=1,
    quantities=["step", "t", "dt", "mx", "my", "mz", "E_total"],
)
study.airbox.visualization(
    show=True, mode="vectors", active_quantity_id="H_demag", wireframe=False,
)
