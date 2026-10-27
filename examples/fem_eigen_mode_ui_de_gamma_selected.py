"""Selected Gamma mode for the same DE film, complementary to signed nonzero k.

Reproduces the historical nearest-frequency Gamma selection at 10 GHz,
with periodic-airbox demag. This requests one selected mode, not a complete
frequency window. It does not resolve the separately recorded window crash.
"""

# %% Study and physical model (SI)
import fullmag as fm

study = fm.study("eigen-mode-ui-de-gamma-selected")
study.engine("fem")
study.device("cpu", precision="double")
study.parallel_execution(fm.ParallelExecutionPolicy(mode="serial", threads_per_worker=1))
study.mode("strict")
study.interactive(False)
study.wait_for_solve(False)
study.universe(mode="manual", size=(40e-9, 40e-9, 4010e-9),
               center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
study.universe.mesh(maximum_element_size=100e-9,
                    maximum_element_growth_rate=1.3, grading="geometric")
study.pbc(x=True, y=True, demag="periodic_airbox_k0")
study.objects.mesh.defaults(periodic_pair_ids=["x_faces", "y_faces"])
body = study.geometry(fm.Box(size=(40e-9, 40e-9, 10e-9), name="film"), name="film")
body.Ms = 800000.0
body.Aex = 13e-12
body.alpha = 0.5
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
body.mesh.thin_film(
    minimum_element_size=5e-9, maximum_element_size=5e-9,
    interface_maximum_element_size=5e-9, interface_thickness=20e-9,
    transition_distance=20e-9, edge_thickness=10e-9, corner_extent=10e-9,
    layers=3, topology="tetrahedral", order=1,
)
study.b_ext(0.1, 0.0, 0.0)
study.exchange()
study.demag(model="airbox", variant="dirichlet")
study.fem_demag_solver(solver="CG", preconditioner="AMG", rtol=1e-7,
                       max_iterations=1000)
study.solver(gamma=2.211e5, fix_dt=5e-15)
study.build_domain_mesh()

# %% Accepted equilibrium, followed by one selected Gamma mode
study.stages.add_relax(stage_id="relax", algorithm="llg_overdamped",
                       dt=5e-15, relax_alpha=0.5, max_steps=50000, tolA=1.0)
# Output selection is captured when the eigen stage is added.
study.save("spectrum")
study.save("dispersion", include_branch_table=True)
study.save("diagnostics")
study.save("mode", field="mode", indices=(0,), sample_indices=(0,))

study.stages.add_eigenmodes(
    stage_id="eigenmodes", count=1, target="nearest",
    target_frequency=10e9,
    operator="full_2x2", include_demag=True,
    solver_completeness="best_effort", solver_rtol=1e-8, solver_max_outer_iterations=2000,
    equilibrium_source="relax", normalization="unit_l2", damping_policy="ignore",
    k_vector=(0.0, 0.0, 0.0),
    bc=fm.PeriodicBC(["x_faces", "y_faces"]),
    magnetostatic_bc="periodic_airbox_k0",
)

# %% Persist the actual complex field and numerical diagnostics
study.runtime_metadata("mode_ui_verification", {
    "purpose": "real complex field for UI integration",
    "reference_configuration": "examples/fem_de_smoke_numeric.py",
    "selection_scope": "selected_only",
    "historical_report": "docs/raports/2026-10-04-de-signed15-runtime.md",
    "mesh_level": "L2",
    "through_thickness_elements": 3,
    "requested_completeness": "best_effort",
    "claims_complete_spectrum": False,
    "native_krylov_tuning": "managed_backend_record; verify executed solver diagnostics",
    "historical_krylov_overrides": {
        "shifted_ksp_type": "fgmres", "gmres_restart": 8,
        "shifted_ksp_rtol": 1e-9, "eps_prefilter_abs": 1e-9,
    },
    "window_complete": False,
    "qualification": "NOT VERIFIED",
})
