"""Signed nonzero-k DE sweep, with Gamma qualified in a separate run.

The full signed15 run saved seven negative-k checkpoints but its worker
segfaulted upon entering the Gamma solver. This explicit diagnostic case
keeps all fourteen nonzero samples and the same physical model, window and
residual requirements. It does not claim a completed fifteen-point sweep.
"""

# %% Study and physical model (SI)
import fullmag as fm

K_RAD_PER_UM = (-25, -20, -15, -10, -7, -5, -2, 2, 5, 7, 10, 15, 20, 25)
RAD_PER_UM_TO_RAD_PER_M = 1.0e6
K_Y_RAD_PER_M = tuple(k_y * RAD_PER_UM_TO_RAD_PER_M for k_y in K_RAD_PER_UM)
K_VECTORS = tuple((0.0, k_y, 0.0) for k_y in K_Y_RAD_PER_M)
FREQUENCY_MIN_HZ = 8.5e9
FREQUENCY_MAX_HZ = 16.0e9

study = fm.study("eigen-mode-ui-de-signed14-nonzero")
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

# %% Accepted equilibrium, followed by one mode at every signed k_y sample
study.stages.add_relax(stage_id="relax", algorithm="llg_overdamped",
                       dt=5e-15, relax_alpha=0.5, max_steps=50000, tolA=1.0)
# Output selection is captured when the eigen stage is added.
study.save("spectrum")
study.save("dispersion", include_branch_table=True)
study.save("diagnostics")
study.save("mode", field="mode", indices=(0,),
           sample_indices=tuple(range(len(K_RAD_PER_UM))))

study.stages.add_eigenmodes(
    stage_id="eigenmodes", count=1, target="frequency_window",
    frequency_min=FREQUENCY_MIN_HZ, frequency_max=FREQUENCY_MAX_HZ,
    operator="full_2x2", include_demag=True,
    solver_completeness="best_effort", solver_rtol=1e-8, solver_max_outer_iterations=2000,
    equilibrium_source="relax", normalization="unit_l2", damping_policy="ignore",
    k_sampling=fm.KPath(
        points=[
            fm.KPoint(
                "Gamma" if k_y == 0 else f"DE{k_y:+g}",
                vector,
            )
            for k_y, vector in zip(K_RAD_PER_UM, K_VECTORS)
        ],
        samples_per_segment=[1] * (len(K_RAD_PER_UM) - 1),
    ),
    bc=fm.FloquetBC(["x_faces", "y_faces"],
                    phase_convention="exp_minus_i_k_dot_delta_r"),
    magnetostatic_bc="floquet_airbox",
)

# %% Persist mode 0 for every sample and numerical diagnostics
study.runtime_metadata("mode_ui_verification", {
    "purpose": "real complex fields for signed DE UI sweep",
    "reference_configuration": "examples/fem_eigen_mode_ui_de_k10.py",
    "sampling": "signed-fourteen-nonzero",
    "gamma_qualification": "separate run required; not included",
    "mesh_level": "L2",
    "through_thickness_elements": 3,
    "requested_completeness": "best_effort",
    "claims_complete_spectrum": False,
    "native_krylov_tuning": "managed_backend_record; verify executed solver diagnostics",
    "k_sampling_kind": "path",
    "k_y_signed_rad_per_um": list(K_RAD_PER_UM),
    "k_y_rad_per_m": list(K_Y_RAD_PER_M),
    "k_vectors_rad_per_m": [list(vector) for vector in K_VECTORS],
    "frequency_window_hz": [FREQUENCY_MIN_HZ, FREQUENCY_MAX_HZ],
    "requested_mode_count": 1,
    "saved_mode_indices": [0],
    "saved_sample_indices": list(range(len(K_RAD_PER_UM))),
    "window_complete": False,
    "qualification": "NOT VERIFIED",
})
