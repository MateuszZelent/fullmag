"""Numerical FEM DE pilot: uniform 100 nm film, nine k points, dynamic demag.

Uses the native numerical solver. No analytic-reference solver is selected.
Qualification and comparison with Kalinikos n=0 remain pending execution.
"""
from __future__ import annotations

import fullmag as fm

from tests.standard_problems.mumag.comsol_nonzero_k_dispersion.config import (
    AIRBOX_GROWTH_RATE,
    AIRBOX_HMAX_M,
    A_LAT_M,
    AEX_J_PER_M,
    BIAS_FIELD_T,
    FREQUENCY_WINDOW_HZ,
    GAMMA_M_PER_A_S,
    INTERFACE_HMAX_M,
    INTERFACE_THICKNESS_M,
    INTERFACE_TRANSITION_DISTANCE_M,
    MODE_COUNT,
    MS_A_PER_M,
    RELAX_ALPHA,
    RELAX_DT_S,
    RELAX_MAX_STEPS,
    RELAX_TORQUE_TOLERANCE_A_PER_M,
    THIN_FILM_LAYERS,
    THIN_FILM_ORDER,
    UNIVERSE_SIZE_M,
    build_k_sampling,
    case_from_environment,
    guide_metadata,
    mode_field_selection,
)


# Uniform DE control: small periodic cell avoids folding within |k| <= 40e6.
from tests.standard_problems.mumag.comsol_nonzero_k_dispersion.config import available_cases
CASE = next(case for case in available_cases() if case.key == "c1")
A_LAT_M = 50e-9
UNIVERSE_SIZE_M = (A_LAT_M, A_LAT_M, 4.1e-6)
THIN_FILM_LAYERS = 20

def build_k_sampling(case):
    return fm.KPath(
        points=[fm.KPoint("-DE", (0.0, -40e6, 0.0)),
                fm.KPoint("Gamma", (0.0, 0.0, 0.0)),
                fm.KPoint("+DE", (0.0, 40e6, 0.0))],
        samples_per_segment=[4, 4],
    )


study = fm.study("de-film-100nm-numeric-pilot")
study.engine("fem")
# Floquet dynamic demagnetization is currently a strict CPU lane.
study.device("cpu", precision="double")
study.mode("strict")
study.interactive(False)
study.wait_for_solve(True)

study.universe(
    mode="manual",
    size=UNIVERSE_SIZE_M,
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    maximum_element_size=AIRBOX_HMAX_M,
    maximum_element_growth_rate=AIRBOX_GROWTH_RATE,
    grading="geometric",
)
study.pbc(
    x=True,
    y=True,
    demag="periodic_airbox_k0" if CASE.include_demag else "open",
)
# pbc() synchronizes these matching source/destination mesh pairs. Keep the
# declaration visible in the authored workflow for reviewers and exporters.
study.objects.mesh.defaults(periodic_pair_ids=["x_faces", "y_faces"])

film = fm.Box(
    size=(A_LAT_M, A_LAT_M, 100.0e-9),
    name="full_film",
)
if CASE.has_hole:
    hole = fm.Cylinder(
        radius=50.0e-9,
        height=10.0e-9,
        name="air_hole",
    )
    magnetic_shape = film - hole
    body_name = "antidot_film"
else:
    magnetic_shape = film
    body_name = "full_film"

body = study.geometry(magnetic_shape, name=body_name)
body.Ms = MS_A_PER_M
body.Aex = AEX_J_PER_M
# The relaxation stage overrides alpha with the guide value; the eigen stage
# requests damping_policy="ignore", which represents alpha_eig=0.
body.alpha = RELAX_ALPHA
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
body.mesh.thin_film(
    minimum_element_size=INTERFACE_HMAX_M,
    maximum_element_size=INTERFACE_HMAX_M,
    interface_maximum_element_size=INTERFACE_HMAX_M,
    interface_thickness=INTERFACE_THICKNESS_M,
    transition_distance=INTERFACE_TRANSITION_DISTANCE_M,
    edge_maximum_element_size=INTERFACE_HMAX_M,
    edge_thickness=INTERFACE_THICKNESS_M,
    edge_transition_distance=INTERFACE_TRANSITION_DISTANCE_M,
    layers=THIN_FILM_LAYERS,
    topology="tetrahedral",
    order=THIN_FILM_ORDER,
)

study.b_ext(*BIAS_FIELD_T)
study.exchange()
if CASE.include_demag:
    # Explicit Dirichlet top/bottom airbox semantics from the COMSOL guide.
    study.demag(model="airbox", variant="dirichlet")
else:
    study.disable_demag()
study.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=1.0e-10,
    max_iterations=1000,
)
study.solver(gamma=GAMMA_M_PER_A_S, fix_dt=RELAX_DT_S)
study.build_domain_mesh()

# Retain the spectrum and selected physical fields for comparison. The native
# shared-domain writer also reconstructs the scalar potential and its gradient.
study.save("spectrum")
study.save("dispersion", include_branch_table=True)
study.save("diagnostics")
mode_field_indices, mode_field_samples = tuple(range(8)), (0, 2, 4, 6, 8)
study.save(
    "mode",
    field="mode",
    indices=mode_field_indices,
    sample_indices=mode_field_samples,
)

study.runtime_metadata("de_100nm_numeric_pilot", {
    "film_thickness_m": 100e-9,
    "cell_period_m": 50e-9,
    "air_padding_each_side_m": 2e-6,
    "orientation": "M0=x,k=y,normal=z",
    "analytic_comparison": "postsolve_only_kalinikos_n0_approximation",
    "qualification": "NOT VERIFIED",
})

study.stages.add_relax(
    stage_id="relax",
    algorithm="llg_overdamped",
    dt=RELAX_DT_S,
    relax_alpha=RELAX_ALPHA,
    max_steps=RELAX_MAX_STEPS,
    tolA=RELAX_TORQUE_TOLERANCE_A_PER_M,
)

sampling = build_k_sampling(CASE)
if CASE.use_floquet:
    spin_bc = fm.FloquetBC(
        ["x_faces", "y_faces"],
        phase_convention="exp_minus_i_k_dot_delta_r",
    )
    dynamic_demag_bc = "floquet_airbox"
else:
    spin_bc = fm.PeriodicBC(["x_faces", "y_faces"])
    dynamic_demag_bc = "open"

study.stages.add_eigenmodes(
    count=MODE_COUNT,
    target="frequency_window",
    frequency_min=FREQUENCY_WINDOW_HZ[0],
    frequency_max=FREQUENCY_WINDOW_HZ[1],
    operator="full_2x2",
    include_demag=CASE.include_demag,
    equilibrium_source="relax",
    normalization="unit_l2",
    damping_policy="ignore",
    k_sampling=sampling,
    bc=spin_bc,
    magnetostatic_bc=dynamic_demag_bc,
)
