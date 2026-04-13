"""Canonical Fullmag script generated from the model builder.

Source: stno_vortex_mtj_workflow.py
Entrypoint: flat_workspace
"""

import fullmag as fm

study = fm.study("stno_vortex_mtj_workflow")

# Engine
study.engine("fem")
study.device("cpu", precision="double")
study.universe(mode="auto", size=(2.5e-07, 2.5e-07, 6e-08), center=(0, 0, 0), padding=(0, 0, 0), airbox_hmax=50e-09)
study.interactive(True)

# Geometry & Material
body = study.geometry(fm.Cylinder(radius=5e-08, height=9e-09, name="free"), name="free")
body.Ms = 700000
body.Aex = 1.2e-11
body.alpha = 0.01
body.m = fm.uniform(1, 0, 0)

# External field
study.b_ext(0, 0, 0.02)

# Outer boundary / demag
study.demag(realization="poisson_robin")

# Mesh
study.object_mesh_defaults(algorithm_2d=8, algorithm_3d=1, size_factor=1, size_from_curvature=3, smoothing_steps=1, optimize_iterations=1, narrow_regions=1, compute_quality=True, per_element_quality=True)
body.mesh(hmax=4e-09, order=1, algorithm_2d=8, algorithm_3d=1, size_from_curvature=1, narrow_regions=1, compute_quality=True, per_element_quality=True)
study.build_domain_mesh()

# Solver
study.solver(integrator="rk45", max_error=1e-06, gamma=233728.481992)

# Outputs
study.tableautosave(1e-14, quantities=("time", "mx", "E_total"))
# study.save("time", every=1e-11)
# study.save("step", every=1e-11)
# study.save("solver_dt", every=1e-11)
# study.save("mx", every=1e-11)
# study.save("my", every=1e-11)
# study.save("mz", every=1e-11)
# study.save("E_total", every=1e-11)
# study.save("max_dm_dt", every=1e-11)
# study.save("max_h_eff", every=1e-11)

# Stages
study.stages.add_relax(max_steps=8_000, tol=1e-6, algorithm="llg_overdamped")
study.stages.add_eigenmodes(
    count=20,
    target="lowest",
    include_demag=True,
    equilibrium_source="relax",
)
