"""Small FEM relaxation smoke case for the managed MFEM runtime.

Select the relaxation method with FULLMAG_RELAX_ALGORITHM and the device with
FULLMAG_RELAX_DEVICE. Intended for container-backed checks via:

    just fem-gpu-headless examples/fem_relax_gpu_smoke.py
"""

import os

import fullmag as fm


ALGORITHM = os.environ.get("FULLMAG_RELAX_ALGORITHM") or "projected_gradient_bb"
DEVICE = os.environ.get("FULLMAG_RELAX_DEVICE") or "gpu"
MAX_STEPS = int(os.environ.get("FULLMAG_RELAX_MAX_STEPS", "4"))

study = fm.study(f"fem_relax_gpu_smoke_{ALGORITHM}")
study.engine("fem")
study.device(DEVICE, precision="double")
study.universe(
    mode="auto",
    size=(160e-9, 120e-9, 80e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(maximum_element_size=80e-9)

body = study.geometry(fm.Box(120e-9, 80e-9, 20e-9), name="body")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.5
body.m = fm.texture.random(seed=7)
body.mesh(maximum_element_size=40e-9, order=1)

study.build_domain_mesh()
study.b_ext(0.0, 0.0, 0.02)
study.solver(dt=1e-13)

study.relax(
    algorithm=ALGORITHM,
    max_steps=MAX_STEPS,
    tol=1e-30,
    relax_alpha=None,
)
