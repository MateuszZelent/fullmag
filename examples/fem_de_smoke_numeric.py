"""DE-SMOKE numerical FEM fixture from the 2026-09-16 validation plan.

Default: Gamma and ky=2e6 rad/m. FULLMAG_DE_SMOKE_SAMPLING=five selects
all five prescribed points. References are evaluated after the native solve;
this fixture does not select an analytic solver or claim qualification.
"""
from __future__ import annotations

import os
import fullmag as fm

SAMPLING = os.environ.get("FULLMAG_DE_SMOKE_SAMPLING", "two")
if SAMPLING not in ("two", "five", "k2"):
    raise ValueError("FULLMAG_DE_SMOKE_SAMPLING must be two, five or k2")
KY = ((2e6,) if SAMPLING == "k2" else
      (0.0, 2e6) if SAMPLING == "two" else
      (0.0, 1e6, 2e6, 3e6, 5e6))
RELAX_DT_S = 5e-15
RELAX_MAX_STEPS = 50000
RELAX_MAX_TIME_S = RELAX_DT_S * RELAX_MAX_STEPS
# The previous SLEPc default cap of 100 iterations did not converge. Give this
# diagnostic solve a bounded 500 iterations; convergence and physical residual
# acceptance criteria remain unchanged.
EIGEN_SOLVER_RTOL = 1e-8
EIGEN_SOLVER_MAX_OUTER_ITERATIONS = 500
MS_A_PER_M = 800000.0
A_J_PER_M = 13e-12
GAMMA0_M_PER_A_S = 2.211e5
B_EXT_T = 0.1
FILM_THICKNESS_M = 10e-9
CELL_PERIOD_M = 40e-9
AIR_PADDING_EACH_SIDE_M = 2e-6
DOMAIN_HEIGHT_M = FILM_THICKNESS_M + 2.0 * AIR_PADDING_EACH_SIDE_M

study = fm.study("de-smoke-10nm-numeric")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.interactive(False)
study.wait_for_solve(True)
study.universe(mode="manual", size=(CELL_PERIOD_M, CELL_PERIOD_M, DOMAIN_HEIGHT_M),
               center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
study.universe.mesh(maximum_element_size=100e-9,
                    maximum_element_growth_rate=1.3, grading="geometric")
study.pbc(x=True, y=True, demag="periodic_airbox_k0")
study.objects.mesh.defaults(periodic_pair_ids=["x_faces", "y_faces"])
body = study.geometry(fm.Box(size=(CELL_PERIOD_M, CELL_PERIOD_M, FILM_THICKNESS_M), name="film"), name="film")
body.Ms = MS_A_PER_M
body.Aex = A_J_PER_M
body.alpha = 0.5
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
body.mesh.thin_film(
    minimum_element_size=10e-9, maximum_element_size=10e-9,
    interface_maximum_element_size=10e-9, interface_thickness=20e-9,
    transition_distance=20e-9, edge_thickness=10e-9, corner_extent=10e-9,
    layers=3, topology="tetrahedral", order=1,
)
study.b_ext(B_EXT_T, 0.0, 0.0)
study.exchange()
study.demag(model="airbox", variant="dirichlet")
study.fem_demag_solver(solver="CG", preconditioner="AMG", rtol=1e-7,
                       max_iterations=1000)
study.solver(gamma=GAMMA0_M_PER_A_S, fix_dt=RELAX_DT_S)
study.build_domain_mesh()
study.save("spectrum")
study.save("dispersion", include_branch_table=True)
study.save("diagnostics")
# Capture demag seam inputs at the terminal relaxed state without writing a
# dense transient field history. The runner publishes these requested fields
# at finalization even when relaxation converges before this limit.
study.save("H_demag", every=RELAX_MAX_TIME_S)
study.save("demag_phi", every=RELAX_MAX_TIME_S)
study.save("mode", field="mode", indices=(0, 1, 2, 3),
           sample_indices=tuple(range(len(KY))))
study.runtime_metadata("de_smoke", {
    "schema": "fullmag.de-smoke.v1",
    "sampling": SAMPLING,
    "film_thickness_m": FILM_THICKNESS_M,
    "cell_period_m": CELL_PERIOD_M,
    "air_padding_each_side_m": AIR_PADDING_EACH_SIDE_M,
    "saturation_magnetization_a_per_m": MS_A_PER_M,
    "mu0_t_m_a": 1.25663706212e-6,
    "exchange_stiffness_j_per_m": A_J_PER_M,
    "gamma0_m_per_a_s": GAMMA0_M_PER_A_S,
    "external_induction_t": B_EXT_T,
    "outer_boundary_kind": "poisson_dirichlet",
    "outer_boundary_potential_a": 0.0,
    "ky_rad_per_m": list(KY),
    "orientation": "M0=x,k=y,normal=z",
    "eigen_solver_rtol": EIGEN_SOLVER_RTOL,
    "eigen_solver_max_outer_iterations": EIGEN_SOLVER_MAX_OUTER_ITERATIONS,
    "analytic_comparison": "postsolve_only",
    "qualification": "NOT VERIFIED",
})
study.stages.add_relax(stage_id="relax", algorithm="llg_overdamped",
                       dt=RELAX_DT_S, relax_alpha=0.5,
                       max_steps=RELAX_MAX_STEPS, tolA=1.0)
study.stages.add_eigenmodes(
    count=4, target="frequency_window", frequency_min=8.5e9,
    frequency_max=12e9, operator="full_2x2", include_demag=True,
    solver_rtol=EIGEN_SOLVER_RTOL,
    solver_max_outer_iterations=EIGEN_SOLVER_MAX_OUTER_ITERATIONS,
    equilibrium_source="relax", normalization="unit_l2", damping_policy="ignore",
    **({"k_vector": (0.0, 2e6, 0.0)} if SAMPLING == "k2" else
       {"k_sampling": fm.KPath(
           points=[fm.KPoint("Gamma" if ky == 0 else f"DE-{ky:g}", (0.0, ky, 0.0))
                   for ky in KY],
           samples_per_segment=[1] * (len(KY) - 1),
       )}),
    bc=fm.FloquetBC(["x_faces", "y_faces"],
                    phase_convention="exp_minus_i_k_dot_delta_r"),
    magnetostatic_bc="floquet_airbox",
)
