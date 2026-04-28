"""Canonical Fullmag script generated from the model builder.

Source: stno_vortex_mtj_workflow.py
Entrypoint: flat_relax
"""

import fullmag as fm

study = fm.study("stno_vortex_mtj_workflow")

# Engine
study.engine("fem")
study.device("gpu", precision="double")
study.universe(
    mode="auto",
    size=(2e-07, 2e-07, 9e-08),
    center=(0, 0, 0),
    padding=(0, 0, 0),
)
study.universe.mesh(
    maximum_element_size=5.5e-08,
    minimum_element_size=3e-09,
    growth_rate=1.18,
    grading="geometric",
)
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
body.mesh(
    maximum_element_size=8e-09,
    minimum_element_size=2.5e-09,
    order=1,
    # Surface mesher for CAD faces; Gmsh values include 1 MeshAdapt, 2 Automatic,
    # 5 Delaunay, 6 Frontal-Delaunay, 7 BAMG, and 8 Frontal-Quad.
    algorithm_2d=6,
    # Volume mesher for tetrahedralization; Gmsh values include 1 Delaunay,
    # 4 Frontal, 7 MMG3D, and 10 HXT. The STNO thin-film diagnostic preset
    # starts with Delaunay for robustness; HXT remains a fast advanced option
    # after checking Mesh -> Statistics.
    algorithm_3d=1,
    # Multiplies all size targets after calibration; must be positive.
    # 1.0 keeps requested sizes, lower refines globally, higher coarsens globally.
    size_factor=1,
    # Curvature sampling density in points per full turn; 0 disables this direct
    # Gmsh control, practical positive values are about 6-64, higher refines curves.
    size_from_curvature=24,
    # Laplacian smoothing passes after meshing; non-negative integer, commonly 0-20.
    # Higher values can improve regularity but may distort small or thin features.
    smoothing_steps=5,
    # Mesh optimizer iteration budget; non-negative integer, commonly 1-10.
    # Used only when an optimizer mode is enabled by the lower meshing layer.
    optimize="Netgen",
    optimize_iterations=5,
    # COMSOL-style curvature factor used when size_from_curvature is 0.
    # Effective range is clamped to 0.05-2.0; smaller values mean stronger refinement.
    curvature_factor=1.0,
    # Maximum growth ratio between neighboring size targets; positive float,
    # practical range is about 1.1-2.5. Closer to 1 gives smoother/finer transitions.
    maximum_element_growth_rate=1.22,
    # Minimum number of elements across narrow gaps; 0 disables explicit narrow-gap
    # refinement. Positive integers are direct counts, usually 1-12.
    narrow_regions=0,
    # Heuristic narrow-gap refinement strength used when narrow_regions is 0.
    # Positive float clamped to 0.1-2.0; higher requests more elements through gaps.
    narrow_region_resolution=0.7,
    interface_hmax=3e-09,
    interface_thickness=6e-09,
    transition_distance=24e-09,
    transition_growth=1.2,
    # Enables global mesh quality metrics in the realized mesh report.
    compute_quality=True,
    # Stores per-element quality arrays; useful for diagnostics, heavier than summary
    # quality metrics, and meaningful mainly when compute_quality is enabled.
    per_element_quality=True,
)
study.build_domain_mesh()

# Solver
study.solver(integrator="rk45", max_error=1e-06, gamma=233728.481992)

# Outputs
study.save("time", every=1e-14)
study.save("mx", every=1e-14)
study.save("E_total", every=1e-14)

# Stages
study.stages.add_relax(algorithm="llg_overdamped", tol=1e-06, max_steps=10000)
