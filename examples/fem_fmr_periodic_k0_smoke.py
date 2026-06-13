"""FEM free-boundary FMR/eigenmodes smoke with demag airbox.

This example computes ordinary free-boundary modal FMR modes for a small
Permalloy film. It relaxes the equilibrium state first, then assembles the FEM
linearized-LLG eigenproblem with demag enabled through a Poisson-Robin airbox.

Usage:
    fullmag examples/fem_fmr_periodic_k0_smoke.py --headless

Expected artifacts include:
    spectrum            frequency table for the requested modes
    mode 0, 1, 2, 3     complex spatial mode profiles for visualization
"""

import fullmag as fm

N_MODES = 8
APPLIED_B_T = (0.05, 0.0, 0.0)


study = fm.study("fem_fmr_free_demag_airbox_smoke")
study.engine("fem")
study.device("cpu", precision="double")
study.universe(
    mode="auto",
    size=(180e-9, 180e-9, 90e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(maximum_element_size=120e-9)
study.airbox.visualization(show=True, mode="vectors", active_quantity_id="h_eff")

body = study.geometry(fm.Box(size=(60e-9, 60e-9, 10e-9), name="body"), name="body")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.02
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
body.mesh(maximum_element_size=40e-9, order=1)

study.demag(realization="poisson_robin")
study.build_domain_mesh()
study.b_ext(*APPLIED_B_T)
study.solver(dt=1e-13, g=2.115)
study.tableautosave(1e-12, quantities=["time", "step", "mx", "my", "mz", "E_total"])

study.save("m", every=10e-12)
study.save("spectrum")
study.save("mode", indices=tuple(range(N_MODES)))

study.stages.add_relax(
    algorithm="projected_gradient_bb",
    max_steps=120,
    tol=3e-3,
)
study.stages.add_eigenmodes(
    count=N_MODES,
    target="lowest",
    include_demag=True,
    equilibrium_source="relax",
    normalization="unit_l2",
    damping_policy="ignore",
    bc="free",
)
