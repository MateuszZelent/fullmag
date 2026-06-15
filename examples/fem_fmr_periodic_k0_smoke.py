"""FEM free-boundary FMR/eigenmodes smoke with demag airbox.

This example computes ordinary free-boundary modal FMR modes for a small
Permalloy film. It relaxes the equilibrium state first, then assembles the FEM
linearized-LLG eigenproblem with demag enabled through a Poisson-Robin airbox.

Usage:
    fullmag examples/fem_fmr_periodic_k0_smoke.py --headless

Expected artifacts include:
    spectrum            frequency table for the requested modes
    mode 0..N_MODES-1   complex spatial mode profiles for visualization
"""

import fullmag as fm

N_MODES = 20
APPLIED_B_T = (0.05, 0.0, 0.0)


study = fm.study("fem_fmr_free_demag_airbox_smoke")
study.engine("fem")
# Relaxation runs on the FEM GPU path; the following change-device stage
# switches the modal eigensolve back to CPU after the relaxed state is ready.
study.device("cuda:0", precision="double")
study.universe(
    mode="auto",
    size=(300e-9, 300e-9, 100e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(minimum_element_size=10e-9, maximum_element_size=120e-9)
study.airbox.visualization(show=True, mode="vectors", active_quantity_id="h_eff")

body = study.geometry(
    fm.Box(size=(120e-9, 120e-9, 10e-9), name="body")
    - fm.Cylinder(radius=(50e-9), height=10e-9, name="central_hole"),
    name="body",
)
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.02
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
body.mesh(minimum_element_size=2e-9, maximum_element_size=4e-9, order=1)

study.demag(realization="poisson_robin")
study.build_domain_mesh()
study.b_ext(*APPLIED_B_T)
# study.solver(dt=1e-13, g=2.115)
# study.tableautosave(1e-12, quantities=["time", "step", "mx", "my", "mz", "E_total"])

# study.save("m", every=10e-12)
study.save("spectrum")
study.save("mode", indices=tuple(range(N_MODES)))
study.stages.change_device("gpu")
study.stages.add_relax(
    algorithm="projected_gradient_bb",
    max_steps=200,
    tol=3e-3,
)
# Native FEM modal eigensolve is CPU-backed for this smoke path.
study.stages.change_device("cpu")
study.stages.add_eigenmodes(
    count=N_MODES,
    target="lowest",
    include_demag=True,
    equilibrium_source="relax",
    normalization="unit_l2",
    damping_policy="ignore",
    bc="free",
)
