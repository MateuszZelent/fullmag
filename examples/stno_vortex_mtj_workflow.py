"""Canonical Fullmag script generated from the model builder.

Source: stno_vortex_mtj_workflow.py
Entrypoint: flat_relax
"""

import fullmag as fm

study = fm.study("stno_vortex_mtj_workflow")

# Engine
study.engine("fem")
study.device("cpu", precision="double")
study.universe(mode="auto", size=(1e-07, 1e-07, 3e-08), center=(0, 0, 0), padding=(0, 0, 0), maximum_element_size=5e-08)
study.interactive(True)
study.wait_for_solve(True)

# Geometry & Material
body = study.geometry(fm.Cylinder(radius=5e-08, height=9e-09, name="free"), name="free")
body.Ms = 700000
body.Aex = 1.2e-11
body.alpha = 0.01
body.m = fm.random(seed=2)

# External field
study.b_ext(0, 0, 1.02)

# Outer boundary / demag
study.demag(realization="poisson_robin")

# Mesh
study.object_mesh_defaults(algorithm_2d=6, algorithm_3d=10, size_factor=1, size_from_curvature=0, smoothing_steps=1, optimize_iterations=1, curvature_factor=0.3, maximum_element_growth_rate=1.3, narrow_regions=0, narrow_region_resolution=0.5, compute_quality=True, per_element_quality=True)
body.mesh(maximum_element_size=2e-08, minimum_element_size=5e-09, order=1, compute_quality=True)
study.build_domain_mesh()

# Solver
study.solver(integrator="rk45", max_error=1e-06, gamma=233728.481992)

# Outputs
study.save("time", every=1e-14)
study.save("mx", every=1e-14)
study.save("E_total", every=1e-14)

# Stages
study.stages.add_relax(algorithm="llg_overdamped", tol=1e-06, max_steps=10000)
