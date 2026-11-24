"""Parameterised FEM time-domain case for memory and CPU<->GPU transfer probes.

Run inside the Docker DEV backend container, for example::

    FEM_CASE_DEVICE=gpu FEM_CASE_HMAX=4e-9 \
        fullmag-bin scripts/benchmarks/fem_memory_transfer_case.py \
        --backend fem --headless --json --output-dir /build/perf/case

``scripts/benchmarks/run_memory_transfer_probe.py`` runs it and samples device
memory and host RSS.  Environment knobs (all optional):

FEM_CASE_DEVICE      cpu | gpu                               (default gpu)
FEM_CASE_SIZE        magnet box edge lengths in metres x,y,z (default 200e-9,200e-9,20e-9)
FEM_CASE_HMAX        magnet maximum element size in metres   (default 5e-9)
FEM_CASE_AIR_HMAX    airbox maximum element size in metres   (default 40e-9)
FEM_CASE_STEPS       fixed-dt step count                     (default 50)
FEM_CASE_DT          fixed time step in seconds              (default 2e-14)
FEM_CASE_INTEGRATOR  heun | rk4 | rk23 | rk45                (default heun)
FEM_CASE_PRECONDITIONER  AMG | JACOBI | default              (default AMG)

The time step must stay below the exchange stability limit of the finest
element (strict mode rejects larger steps; the limit scales with hmax^2,
about 4.8e-14 s at hmax = 2.5 nm). With ``default`` the script does not set a
demag solver policy; on the GPU lane the runtime then resolves a Jacobi
preconditioner, which needed more than 500 PCG iterations at 14 916 nodes.
"""

import os

import fullmag as fm


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default).strip()


DEVICE = _env("FEM_CASE_DEVICE", "gpu").lower()
SX, SY, SZ = (float(v) for v in _env("FEM_CASE_SIZE", "200e-9,200e-9,20e-9").split(","))
HMAX = float(_env("FEM_CASE_HMAX", "5e-9"))
AIR_HMAX = float(_env("FEM_CASE_AIR_HMAX", "40e-9"))
STEPS = int(_env("FEM_CASE_STEPS", "50"))
INTEGRATOR = _env("FEM_CASE_INTEGRATOR", "heun").lower()
DT = float(_env("FEM_CASE_DT", "2e-14"))
PRECONDITIONER = _env("FEM_CASE_PRECONDITIONER", "AMG").upper()

study = fm.study(f"fem_memory_transfer_{DEVICE}_h{HMAX:.1e}")
study.engine("fem")
study.device(DEVICE, precision="double")
study.mode("strict")
study.universe(mode="auto", size=(3.0 * SX, 3.0 * SY, 6.0 * SZ), center=(0.0, 0.0, 0.0))
study.universe.mesh(maximum_element_size=AIR_HMAX)
study.interactive(False)

body = study.geometry(fm.Box(size=(SX, SY, SZ)), name="magnet")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.02
body.m = fm.texture.random(seed=7)  # type: ignore[assignment]
body.mesh(maximum_element_size=HMAX, order=1)

study.demag(realization="poisson_robin")
if PRECONDITIONER != "DEFAULT":
    study.fem_demag_solver(solver="CG", preconditioner=PRECONDITIONER)
study.b_ext(0.0, 0.0, 10e-3)
study.build_domain_mesh()

study.solver(fix_dt=DT, integrator=INTEGRATOR)
study.run(STEPS * DT)
